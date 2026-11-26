/**
 * kernel/changes.ts —— 文件读版本冲突与条件编辑守卫（4.1，对齐 thinkflow changes.py + executor.py）
 *
 * 内核纪律：零 IO、零框架依赖、纯函数。文件事实由调用方注入（`RevisionFacts`），
 * 本模块只维护"已读观察"账本与判定逻辑，不访问文件系统。
 *
 * 对齐依据：
 *   - [TF]/changes.py:28 content_revision：None → 'missing'，否则 sha256 十六进制。
 *   - [TF]/file_observations.py:11 ReadObservation.include/covers/after_edit：区间合并与覆盖判定。
 *   - [TF]/executor.py:469 _check_revision：
 *       full read 版本变化 / range read 版本变化 → 'revision_conflict'；
 *       未读就改（exact_edit 需覆盖区间，否则需全文）→ 'read_required'。
 *
 * 驱动器接入：tf-read 成功后登记观察；tf-edit/append 派发前用 guardEdit 检查。
 * 缺省（无事实端口 / 未登记观察）= 放行（0.4.x 行为，回退点）。
 */

export const MISSING_REVISION = 'missing';

export interface RevisionFacts {
  /** 当前文件 sha256（原文字节）；不存在返回 null。只读。 */
  revision(path: string): string | null;
}

export interface ReadRange {
  start: number;
  end: number;
}

interface ReadRecord {
  /** 全文读 = revision 已知且 ranges 为空；范围读 = ranges 非空。 */
  revision: string;
  ranges: ReadRange[];
}

export type GuardVerdict =
  | { verdict: 'allow' }
  | { verdict: 'deny'; reason: 'revision_conflict' | 'read_required'; detail: string };

/** 区间合并（对齐 ReadObservation.include）。 */
function mergeRanges(ranges: readonly ReadRange[], start: number, end: number): ReadRange[] {
  if (start === end) return [...ranges];
  const out: ReadRange[] = [];
  for (const r of [...ranges, { start, end }].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last !== undefined && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** 单个区间是否被账本覆盖（对齐 ReadObservation.covers）。 */
export function coversRange(ranges: readonly ReadRange[], start: number, end: number): boolean {
  return ranges.some((r) => r.start <= start && end <= r.end);
}

/**
 * 文件读版本守卫账本（纯状态机；调用方持有实例并按会话持久化）。
 */
export class RevisionGuard {
  private readonly reads = new Map<string, ReadRecord>();

  /** tf-read 成功后登记观察。full = 全文读；否则登记 [start,end] 行段。 */
  observeRead(path: string, revision: string, range?: ReadRange): void {
    const key = this.normalize(path);
    const prev = this.reads.get(key);
    if (range === undefined) {
      this.reads.set(key, { revision, ranges: [] });
      return;
    }
    // 审查修正：已有同版本全文读时，范围读不得把授权降级（对齐 [TF]/executor.py:313-314）。
    if (prev !== undefined && prev.ranges.length === 0 && prev.revision === revision) return;
    if (prev === undefined) {
      this.reads.set(key, { revision, ranges: [range] });
      return;
    }
    this.reads.set(key, { revision, ranges: mergeRanges(prev.ranges, range.start, range.end) });
  }

  /**
   * 变更类命令派发前检查。`exactEdit=true` 表示编辑必须落在已读区间内（范围读授权）；
   * 否则要求全文读。文件版本变化（无论全文或范围读）一律拒绝。
   */
  guardEdit(
    path: string,
    facts: RevisionFacts,
    opts: { exactEdit?: boolean; targetRange?: ReadRange; enabled?: boolean } = {},
  ): GuardVerdict {
    if (opts.enabled === false) return { verdict: 'allow' };
    const key = this.normalize(path);
    const observed = this.reads.get(key);
    const current = facts.revision(path);
    const currentRevision = current === null ? MISSING_REVISION : current;

    if (observed === undefined) {
      // 0.5.2（审计 D2）：目标当前不存在 + 无读观察 = **新建**，放行——没有可覆盖的内容，
      // 要求"先读一个不存在的文件"会让新建文件这条主路径直接死锁（上游 write_file 同样
      // 只对已存在文件要求读观察）。已存在文件仍按 read_required 拒绝。
      if (current === null) return { verdict: 'allow' };
      return {
        verdict: 'deny',
        reason: 'read_required',
        detail: `read_required: 修改 ${path} 前必须先 tf-read ${opts.exactEdit === true ? '目标行段' : '完整文件'}（未登记读观察）`,
      };
    }
    if (observed.revision !== currentRevision) {
      return {
        verdict: 'deny',
        reason: 'revision_conflict',
        detail: `revision_conflict: ${path} 自上次 tf-read 后已变化（已读 ${observed.revision.slice(0, 12)} → 当前 ${currentRevision.slice(0, 12)}）；请重新 tf-read`,
      };
    }
    if (opts.exactEdit === true) {
      // 全文读（ranges 空）覆盖任意区间；范围读必须给出 targetRange 且被覆盖。
      // 审查修正：范围读但无 targetRange → fail-closed（无法证明覆盖，对齐 TF 的
      // "range observation 需 covers(edit_start, edit_end)" 要求）。
      if (observed.ranges.length > 0) {
        if (opts.targetRange === undefined) {
          return {
            verdict: 'deny',
            reason: 'read_required',
            detail: `read_required: ${path} 只有范围读观察且未声明 offset；请用 tf-edit offset=<起始行> 或重新 tf-read 完整文件`,
          };
        }
        if (!coversRange(observed.ranges, opts.targetRange.start, opts.targetRange.end)) {
          return {
            verdict: 'deny',
            reason: 'read_required',
            detail: `read_required: 目标行段 ${opts.targetRange.start}-${opts.targetRange.end} 未被已读区间覆盖；请先 tf-read 对应行段`,
          };
        }
      }
    }
    return { verdict: 'allow' };
  }

  /**
   * 写后推进版本：只更新 revision 与平移区间，不改变授权范围。
   * 审查修正：原实现无条件写 `ranges: []` 会把范围读升级为全文读授权（提权漏洞）；
   * 对齐 [TF]/executor.py:605-612——范围读经 after_edit 平移后仍是范围读。
   */
  noteWrite(path: string, newRevision: string, edit?: { start: number; end: number; newLength?: number }): void {
    const key = this.normalize(path);
    const prev = this.reads.get(key);
    if (prev === undefined) return; // 未读不因写入产生授权
    if (prev.ranges.length === 0) {
      this.reads.set(key, { revision: newRevision, ranges: [] });
      return;
    }
    const delta = edit === undefined ? 0 : (edit.newLength ?? (edit.end - edit.start)) - (edit.end - edit.start);
    const shifted = prev.ranges.map((r) => {
      if (edit !== undefined && r.end <= edit.start) return r;
      if (edit !== undefined && r.start >= edit.end) return { start: r.start + delta, end: r.end + delta };
      return { start: r.start, end: r.end + delta };
    }).filter((r) => r.start < r.end);
    this.reads.set(key, { revision: newRevision, ranges: shifted });
  }

  /** 外部删除/替换导致的失效：清掉观察，下一次编辑走 read_required。 */
  invalidate(path: string): void {
    this.reads.delete(this.normalize(path));
  }

  private normalize(path: string): string {
    return path.replace(/\\/g, '/').replace(/^\.\//, '');
  }
}
