// kernel/change-store.ts —— 私有变更回执与守卫式回滚（0.6.0 正式版，对齐 thinkflow changes.py）
//
// 覆盖核验（2026-11-25 独立审计）确认的缺口：插件此前只有读版本守卫（kernel/changes.ts），
// 没有 [TF]/changes.py:157-272 的快照回执（begin/complete）与守卫回滚（revert）。
// 宿主 dsh-workspace-changes 是只读 diff 记录器（无 revert/restore），缺口无宿主落点。
//
// 语义对齐（逐条）：
//   · begin：写入前登记 before/after 快照与哈希；快照不可用（超大/二进制/敏感）时只存元数据。
//   · complete：写后复查当前哈希 == after_hash 才置 success（外部写者抢跑 → revision_conflict）。
//   · revert：expected_revision 双重校验（== 回执 after_hash 且 == 当前文件哈希）→ 恢复 before；
//     恢复本身也是一次 begin/complete（undo_of 指向原回执）。新文件不回滚删除（需显式人工流程）。
//   · 回执是意图日志不是文件系统事务：外部写者可以在最终检查后抢跑（与 TF 同一免责声明）。
//
// 内核纪律：零 IO、零框架依赖。字节读取/原子写回/持久化由 entry 承担（loop.ts 接线）；
// 快照以 base64 文本进回执（与 TF 一致），哈希口径 = sha256（entry 计算后注入）。

import { hasSensitiveContent } from './security.ts';
import { resolve as resolvePath } from 'node:path';

/**
 * 0.6.0 收口（核验 P2）：路径身份归一。resolve 吃掉 `./`、`..`、尾分隔符；
 * win32 不区分大小写（文件系统事实），其余平台区分。回执 workspace 比对、
 * tf-changes 路径过滤共用本口径——同一路径的不同写法不得分裂成两个身份。
 */
export function normalizeIdentity(path: string): string {
  const resolved = resolvePath(path).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function samePath(a: string, b: string): boolean {
  return normalizeIdentity(a) === normalizeIdentity(b);
}

export const MISSING_REVISION = 'missing';
export const MAX_SNAPSHOT_BYTES = 1024 * 1024;
export const MAX_GUARDED_FILE_BYTES = 8 * 1024 * 1024;

export type ChangeOperation = 'write' | 'edit' | 'append' | 'revert';

export interface ChangeEntry {
  version: 1;
  /** 32 位十六进制（entry 用 crypto.randomUUID 生成）。 */
  id: string;
  /** 工作区根（规范化）；加载时校验身份，防跨工作区回执混用。 */
  workspace: string;
  path: string;
  operation: ChangeOperation;
  commandId: string;
  status: 'unknown' | 'success';
  createdAt: number;
  completedAt?: number;
  beforeHash: string;
  afterHash: string;
  beforeBytes: number;
  afterBytes: number;
  unavailableReason: string;
  undoOf: string;
  /** base64 快照（unavailableReason 非空时缺席）。 */
  snapshots?: { before: string | null; after: string | null };
}

export interface ChangeMetadata {
  id: string;
  path: string;
  operation: ChangeOperation;
  commandId: string;
  status: 'unknown' | 'success';
  createdAt: number;
  completedAt?: number;
  beforeHash: string;
  afterHash: string;
  beforeBytes: number;
  afterBytes: number;
  undoOf: string;
  canDiff: boolean;
  canRevert: boolean;
  unavailableReason: string;
  expectedRevision: string;
}

const encoder = new TextEncoder();

/**
 * 快照可用性判定（对齐 [TF]/changes.py:135-155 _snapshot_reason）。
 * before/after 是 utf-8 文本（null = 文件不存在）；binary/sensitive 由 entry 探测注入。
 */
export function snapshotReason(
  before: string | null,
  after: string | null,
  opts: { maxSnapshotBytes?: number; binary?: boolean; sensitive?: boolean } = {},
): string {
  const max = Math.max(0, Math.min(opts.maxSnapshotBytes ?? MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_BYTES));
  if (opts.binary === true) return 'binary_file';
  if (opts.sensitive === true) return 'sensitive_content';
  for (const text of [before, after]) {
    if (text === null) continue;
    if (encoder.encode(text).length > max) return 'snapshot_too_large';
    if (text.includes('\u0000')) return 'binary_file';
    if (hasSensitiveContent(text)) return 'sensitive_content';
  }
  return '';
}

/** 回执元数据投影（对齐 [TF]/changes.py:198-215 _metadata；公开面永不返回快照）。 */
export function receiptMetadata(entry: ChangeEntry): ChangeMetadata {
  let reason = entry.unavailableReason;
  if (entry.status !== 'success') reason = 'unconfirmed_change';
  const canDiff = reason === '';
  if (reason === '' && entry.beforeHash === MISSING_REVISION) reason = 'new_file_requires_manual_recovery';
  const canRevert = reason === '';
  return {
    id: entry.id,
    path: entry.path,
    operation: entry.operation,
    commandId: entry.commandId,
    status: entry.status,
    createdAt: entry.createdAt,
    ...(entry.completedAt === undefined ? {} : { completedAt: entry.completedAt }),
    beforeHash: entry.beforeHash,
    afterHash: entry.afterHash,
    beforeBytes: entry.beforeBytes,
    afterBytes: entry.afterBytes,
    undoOf: entry.undoOf,
    canDiff,
    canRevert,
    unavailableReason: reason,
    expectedRevision: entry.afterHash,
  };
}

export type RevertPlan =
  | { ok: true; before: string | null; entry: ChangeEntry }
  | { ok: false; reason: string };

/**
 * 回滚判定（对齐 [TF]/changes.py:255-272 revert 的全部前置检查）。
 * currentRevision = 目标文件当前 sha256（不存在 = 'missing'）。
 * 快照哈希完整性由 entry 在加载/取用时校验（content_revision(snapshot) == *_hash）。
 */
export function planRevert(entry: ChangeEntry, expectedRevision: string, currentRevision: string): RevertPlan {
  const meta = receiptMetadata(entry);
  if (!meta.canRevert) return { ok: false, reason: meta.unavailableReason };
  if (typeof expectedRevision !== 'string' || expectedRevision !== entry.afterHash) {
    return { ok: false, reason: 'revision_conflict: expected revision does not match the change' };
  }
  if (currentRevision !== expectedRevision) {
    return { ok: false, reason: 'revision_conflict: file changed since this operation' };
  }
  if (entry.snapshots === undefined) return { ok: false, reason: 'invalid_change_receipt: snapshots missing' };
  // 快照以 base64 存储；返回解码后的文本（entry 直接写回）。
  const before = entry.snapshots.before === null ? null : Buffer.from(entry.snapshots.before, 'base64').toString('utf8');
  return { ok: true, before, entry };
}

/**
 * 行级 unified diff（快照对快照，不是对"今天的文件"断言——与 TF 同一口径）。
 * 有界实现：先掐公共前后缀，中段 ≤2000 行走 LCS DP；超过则整段替换式 diff（如实标注）。
 */
export function unifiedDiff(before: string | null, after: string | null, path: string): string {
  const a = (before ?? '').split('\n');
  const b = (after ?? '').split('\n');
  // split('\n') 对空串给 ['']；空文件按 0 行处理。
  if (before === null || before === '') a.length = 0;
  if (after === null || after === '') b.length = 0;
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tailA = a.length;
  let tailB = b.length;
  while (tailA > head && tailB > head && a[tailA - 1] === b[tailB - 1]) { tailA -= 1; tailB -= 1; }
  const midA = a.slice(head, tailA);
  const midB = b.slice(head, tailB);
  type Op = { kind: ' ' | '-' | '+'; line: string };
  const ops: Op[] = [];
  for (let i = 0; i < head; i += 1) ops.push({ kind: ' ', line: a[i]! });
  if (midA.length > 2000 || midB.length > 2000) {
    for (const line of midA) ops.push({ kind: '-', line });
    for (const line of midB) ops.push({ kind: '+', line });
  } else {
    // LCS DP（有界 2000×2000）→ 回溯编辑脚本。
    const n = midA.length;
    const m = midB.length;
    const dp = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i * (m + 1) + j] = midA[i] === midB[j]
          ? dp[(i + 1) * (m + 1) + (j + 1)] + 1
          : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + (j + 1)]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { ops.push({ kind: ' ', line: midA[i]! }); i += 1; j += 1; }
      else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + (j + 1)]) { ops.push({ kind: '-', line: midA[i]! }); i += 1; }
      else { ops.push({ kind: '+', line: midB[j]! }); j += 1; }
    }
    while (i < n) { ops.push({ kind: '-', line: midA[i]! }); i += 1; }
    while (j < m) { ops.push({ kind: '+', line: midB[j]! }); j += 1; }
  }
  for (let k = tailA; k < a.length; k += 1) ops.push({ kind: ' ', line: a[k]! });
  // 组装 hunks（上下文 3 行）。
  const changed = ops.map((op, index) => (op.kind === ' ' ? -1 : index)).filter((x) => x >= 0);
  if (changed.length === 0) return '';
  const hunks: string[] = [];
  let cursor = 0;
  while (cursor < changed.length) {
    let start = Math.max(0, changed[cursor]! - 3);
    let end = Math.min(ops.length - 1, changed[cursor]! + 3);
    let next = cursor + 1;
    while (next < changed.length && changed[next]! - 3 <= end + 1) {
      end = Math.min(ops.length - 1, changed[next]! + 3);
      next += 1;
    }
    let oldCount = 0;
    let newCount = 0;
    const body: string[] = [];
    let oldStart = 0;
    let newStart = 0;
    let oldLine = 1;
    let newLine = 1;
    for (let k = 0; k < start; k += 1) {
      if (ops[k]!.kind !== '+') oldLine += 1;
      if (ops[k]!.kind !== '-') newLine += 1;
    }
    oldStart = oldLine;
    newStart = newLine;
    for (let k = start; k <= end; k += 1) {
      const op = ops[k]!;
      body.push(`${op.kind}${op.line}`);
      if (op.kind !== '+') oldCount += 1;
      if (op.kind !== '-') newCount += 1;
    }
    hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${body.join('\n')}`);
    cursor = next;
  }
  const from = before === null ? '/dev/null' : `a/${path}`;
  const to = after === null ? '/dev/null' : `b/${path}`;
  return `--- ${from}\n+++ ${to}\n${hunks.join('\n')}\n`;
}

/**
 * 一个会话的私有回执账本（纯状态机；entry 负责持久化到 stateDir/changes/，
 * 该目录在模型输入之外——模型不能经 tf-write 覆盖授权回滚的回执）。
 */
export class ChangeStore {
  readonly #entries = new Map<string, ChangeEntry>();

  /** 登记一次变更意图（写入前）。id 由 entry 生成（32 位十六进制）。 */
  begin(input: {
    id: string;
    workspace: string;
    path: string;
    operation: ChangeOperation;
    commandId: string;
    beforeHash: string;
    afterHash: string;
    beforeBytes: number;
    afterBytes: number;
    unavailableReason: string;
    undoOf?: string;
    snapshots?: { before: string | null; after: string | null };
    createdAt?: number;
  }): ChangeEntry {
    const entry: ChangeEntry = {
      version: 1,
      id: input.id,
      workspace: input.workspace,
      path: input.path,
      operation: input.operation,
      commandId: input.commandId,
      status: 'unknown',
      createdAt: input.createdAt ?? Date.now(),
      beforeHash: input.beforeHash,
      afterHash: input.afterHash,
      beforeBytes: input.beforeBytes,
      afterBytes: input.afterBytes,
      unavailableReason: input.unavailableReason,
      undoOf: input.undoOf ?? '',
      ...(input.unavailableReason === '' && input.snapshots !== undefined ? { snapshots: input.snapshots } : {}),
    };
    this.#entries.set(entry.id, entry);
    return entry;
  }

  /** 写后结算：当前哈希必须 == after_hash（外部抢跑 → revision_conflict，回执保持 unknown）。 */
  complete(id: string, currentRevision: string): { ok: boolean; reason?: string; entry?: ChangeEntry } {
    const entry = this.#entries.get(id);
    if (entry === undefined) return { ok: false, reason: 'invalid_change_id' };
    if (entry.status !== 'unknown') return { ok: false, reason: 'change_already_settled' };
    if (currentRevision !== entry.afterHash) return { ok: false, reason: 'revision_conflict: file changed before receipt completion' };
    entry.status = 'success';
    entry.completedAt = Date.now();
    return { ok: true, entry };
  }

  get(id: string): ChangeEntry | undefined {
    return this.#entries.get(id);
  }

  /** resume / 跨进程：加载已持久化回执（身份与快照哈希由 entry 校验后调用）。 */
  load(entry: ChangeEntry): void {
    this.#entries.set(entry.id, entry);
  }

  list(): ChangeMetadata[] {
    return [...this.#entries.values()]
      .sort((x, y) => x.createdAt - y.createdAt || x.id.localeCompare(y.id))
      .map(receiptMetadata);
  }
}