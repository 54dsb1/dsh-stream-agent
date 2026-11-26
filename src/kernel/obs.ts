/**
 * kernel/obs.ts —— 观测登记与信息增益分类（M2）
 *
 * 内核层纪律：零框架依赖（不 import 任何 @deepseek-ai/*）、无 IO 副作用、
 * 全部依赖走构造注入（BlobSink 是唯一 IO 出口，默认内存实现）。
 * 本文件不 import 任何模块（连 node:crypto 都不用）——内容寻址（sha256）
 * 归 state.ts 管，这里只需要一个"内容是否变化"的判定哈希（FNV-1a 足够）。
 *
 * info_gain 三档反馈形态（0.5.1 / 2.2 对齐上游 max_content_chars=0：默认全文回灌）：
 * | info_gain | 触发条件                                       | 处理                     |
 * |-----------|-----------------------------------------------|--------------------------|
 * | full      | read/grep/glob/web/test/build 的首次或变化输出；| 放行注入（全文/骨架）     |
 * |           | 一切执行失败                                   |                          |
 * | handle    | write/append/mkdir/office/goal 的成功回执       | 句柄化，不注入            |
 * | dedup     | 重复观测、内容哈希未变、空输出                   | 只记 ledger，回灌去重字面量 |
 *
 * 命名与 request 记录的 feedbackBytes 三桶（full/dedup/handle）逐字一致——字节可外部复算。
 *
 * 计数器口径（对齐 08 号任务书 eval/METRICS.md：injected_ratio = injected / produced）：
 * - produced：observe() 收到的每一条观测（含 none）；
 * - injected：实际交给装配器进入模型上下文的观测负载条数——
 *   high 首次骨架、饥饿升级骨架、tf-peek 取回片段、以及 none 时回灌的
 *   "内容未变化"字面量（它同样占请求体积，如实计入）；
 * - peeked：peek() 调用次数（peek 的产出同时计入 injected，见上）。
 * 口径若变，只改上报层，不改本文件逻辑。
 */

import { redactSecrets } from './security.ts';

/** 工具族：分类器的输入粒度 */
export type ToolFamily =
  | 'read' | 'grep' | 'glob' | 'web' | 'test' | 'build'   // 高增益候选族
  | 'code'                                                // tf-code 程序化结果（高增益：首个/变化结果注骨架）
  | 'skill' | 'agent' | 'job' | 'ask'                     // v0.4.0 tf-call 扩族（高增益：内容型产出必须可见）
  | 'write' | 'append' | 'mkdir'                          // 低增益回执族
  | 'bash'                                                // 0.5.2：成功输出按首次/变化回灌（审计 C1）
  | 'office' | 'goal'                                     // v0.4.0 tf-call 扩族（低增益回执：产物/状态确认）
  | 'other';                                              // 未识别工具：默认按 low（默认不回灌）

export type InfoGain = 'full' | 'dedup' | 'handle';

export interface ObservationInput {
  /** 工具名，如 'tf-read' / 'tf-write' / 'tf-bash' / 'grep' */
  tool: string;
  /** 执行是否成功（false 一律 high） */
  ok: boolean;
  /** 观测对象标识（文件路径 / URL / 命令签名），同一 key 的重复观测被识别 */
  key: string;
  /** 本次产出的观测原文 */
  content: string;
  /** 调用标识（缺省自动生成），进入句柄 obs:<family>:<callId>@v<n> */
  callId?: string;
}

export interface Classification {
  info_gain: InfoGain;
  /** 机器可读的触发原因，供 ledger 审计 */
  reason: string;
}

export interface ClassificationContext {
  /** 该 key 上一次观测的内容哈希；无历史为 undefined */
  lastHash?: string;
}

// ---------------------------------------------------------------------------
// 分类器（纯函数）
// ---------------------------------------------------------------------------

const HIGH_GAIN_FAMILIES: ReadonlySet<ToolFamily> = new Set([
  'read', 'grep', 'glob', 'web', 'test', 'build', 'code',
  'skill', 'agent', 'job', 'ask',
  // 0.5.2（审计 C1）：bash 成功输出必须可见——上游 thinkflow 把 shell stdout 原样回给模型；
  // 只记回执时模型跑完 `npm test`/`git status` 看不到任何内容，只能重跑或凭空猜。
  // 走 high 族语义：首次或内容变化 → full，重复且未变 → dedup（不会重复烧 token）。
  'bash',
]);
const LOW_RECEIPT_FAMILIES: ReadonlySet<ToolFamily> = new Set([
  'write', 'append', 'mkdir', 'office', 'goal',
]);

/** 工具名 → 工具族。tf-* 命令名与其同族名一一对应；未知工具归 other。 */
export function classifyTool(tool: string): ToolFamily {
  const t = tool.toLowerCase();
  if (t === 'tf-read' || t === 'read' || t === 'read_file' || t === 'cat' || t === 'read_image') return 'read';
  if (t === 'tf-write' || t === 'write' || t === 'write_file' || t === 'edit' || t === 'tf-edit' || t === 'apply_patch') return 'write';
  if (t === 'tf-peek' || t === 'peek') return 'read';
  if (t === 'tf-bash' || t === 'bash' || t === 'shell') return 'bash';
  if (t === 'tf-code' || t === 'run_code') return 'code';
  if (t === 'tf-append' || t === 'append') return 'append';
  if (t === 'mkdir') return 'mkdir';
  if (t === 'tf-grep' || t === 'grep' || t === 'search' || t === 'grep_search') return 'grep';
  if (t === 'tf-glob' || t === 'glob' || t === 'list' || t === 'ls') return 'glob';
  if (t.startsWith('web') || t === 'fetch' || t === 'http') return 'web';
  // v0.4.0：tf-call 透传的宿主工具名归类（standard/ptc 面的对等工具）。familyHint 优先级
  // 高于前缀猜测：ask_user_question 是阻塞交互，回答必须可见（high）；skill 装载改变会话
  // 行为；subagent 的产出就是报告本体；job/schedule 的 listing/output 是内容型。
  if (t === 'ask_user_question' || t.startsWith('ask')) return 'ask';
  if (t === 'skill' || t.endsWith('_skill')) return 'skill';
  if (t === 'subagent' || t === 'subagent_fork' || t === 'workflow' || t === 'task' || t === 'agent') return 'agent';
  if (t.startsWith('job_')) return 'job';
  if (t.startsWith('schedule_')) return 'job';
  if (t.startsWith('office_') || t === 'present') return 'office';
  if (t.startsWith('goal') || t.endsWith('_goal')) return 'goal';
  if (t === 'todo_write') return 'write';
  if (t === 'exit_plan_mode') return 'ask';
  if (t === 'test' || t === 'run_tests') return 'test';
  if (t === 'build' || t === 'compile') return 'build';
  return 'other';
}

/**
 * 规则式分类。规则表见文件头注释，顺序即优先级：
 * 失败 > 空输出 > 族别（high 族结合"是否首次/内容是否变化"判定）。
 */
export function classify(input: ObservationInput, ctx?: ClassificationContext): Classification {
  if (!input.ok) {
    return { info_gain: 'full', reason: 'execution-failure' };
  }
  if (input.content === '') {
    return { info_gain: 'dedup', reason: 'empty-output' };
  }
  const family = classifyTool(input.tool);
  if (LOW_RECEIPT_FAMILIES.has(family)) {
    return { info_gain: 'handle', reason: 'successful-write-receipt' };
  }
  if (HIGH_GAIN_FAMILIES.has(family)) {
    const hash = hashContent(input.content);
    // 首次（无历史）或内容已变化（新版本）→ high；重复且哈希未变 → none
    if (ctx?.lastHash === undefined) {
      return { info_gain: 'full', reason: `first-observation:${family}` };
    }
    if (ctx.lastHash === hash) {
      return { info_gain: 'dedup', reason: 'duplicate-observation' };
    }
    return { info_gain: 'full', reason: `content-changed:${family}` };
  }
  // other：未知工具，保守处理为低增益回执（默认不回灌哲学）
  return { info_gain: 'handle', reason: 'unknown-tool-receipt' };
}

// ---------------------------------------------------------------------------
// 行骨架（O1：观测三档返回）
// ---------------------------------------------------------------------------

export type KeyLineTag = 'error' | 'class' | 'def' | 'import' | 'heading';

export interface KeyLine {
  line: number;
  text: string;
  tag: KeyLineTag;
}

export interface LineSkeleton {
  totalLines: number;
  /** 非空行区间，1-based 闭区间，已合并相邻行 */
  nonEmptyRanges: ReadonlyArray<readonly [number, number]>;
  keyLines: ReadonlyArray<KeyLine>;
}

// 关键行匹配规则。同一行命中多类时按 error > class > def > import > heading 取主标签。
const KEY_LINE_RULES: ReadonlyArray<readonly [KeyLineTag, RegExp]> = [
  ['error', /error|fail/i],
  ['class', /^\s*(export\s+)?(abstract\s+)?class\b|\bclass\b/],
  ['def', /^\s*(export\s+)?(async\s+)?function\b|^\s*(pub\s+|pub(?:\(crate\))?\s+)?def\s|^\s*(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s*)?\(/],
  ['import', /^\s*(import\b|from\s+\S+\s+import\b)|\brequire\s*\(|^\s*#include\b|^\s*using\s+/],
  ['heading', /^#{1,6}\s+/],
];

function matchKeyLine(line: string): KeyLineTag | null {
  for (const [tag, re] of KEY_LINE_RULES) {
    if (re.test(line)) return tag;
  }
  return null;
}

/** 行骨架渲染：信息密度优先于字符截断（O1）。 */
export function renderSkeleton(text: string): LineSkeleton {
  const lines = text.split('\n');
  // 去掉末尾因换行产生的空行（"a\n" → ['a', ''] 的最后一个空行不计入总行数）
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const nonEmptyRanges: Array<[number, number]> = [];
  let start: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      if (start === null) start = i + 1;
    } else if (start !== null) {
      nonEmptyRanges.push([start, i]);
      start = null;
    }
  }
  if (start !== null) nonEmptyRanges.push([start, lines.length]);
  const keyLines: KeyLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const tag = matchKeyLine(lines[i]);
    if (tag !== null) keyLines.push({ line: i + 1, text: lines[i], tag });
  }
  return { totalLines: lines.length, nonEmptyRanges, keyLines };
}

/** 骨架 → 确定性文本（装配器注入用；同一骨架渲染结果逐字节一致）。 */
export function skeletonToText(s: LineSkeleton): string {
  const ranges = s.nonEmptyRanges
    .map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`))
    .join(', ');
  const keys = s.keyLines
    .map((k) => `  L${k.line} [${k.tag}] ${k.text}`)
    .join('\n');
  return `[骨架] 共 ${s.totalLines} 行\n非空区间: ${ranges || '(空)'}\n关键行:\n${keys || '  (无)'}`;
}

// ---------------------------------------------------------------------------
// 句柄目录与差分（O3）
// ---------------------------------------------------------------------------

export type DirStatus = 'added' | 'changed' | 'stale';

export interface HandleEntry {
  handle: string;
  key: string;
  version: number;
  /** 目录序号：directoryDelta(sinceSeq) 以此过滤 */
  seq: number;
  status: DirStatus;
}

export interface DirectoryDelta {
  added: HandleEntry[];
  changed: HandleEntry[];
  stale: HandleEntry[];
}

/** 自 sinceSeq 以来的目录增量（O3：装配器只注入增量，不重注入整段目录）。 */
export interface ObservationRecord {
  handle: string;
  key: string;
  family: ToolFamily;
  version: number;
  seq: number;
  info_gain: InfoGain;
  reason: string;
}

export type ObservationPayload =
  | { kind: 'skeleton'; skeleton: LineSkeleton; rendered: string }
  | { kind: 'receipt'; handle: string; note: '句柄化，不注入' }
  | { kind: 'unchanged'; text: '内容未变化' };

export interface ObservationResult {
  handle: string | null;
  info_gain: InfoGain;
  reason: string;
  /** 本条观测的流水序号（装配器做 directoryDelta(sinceSeq) 的游标） */
  seq: number;
  payload: ObservationPayload;
}

export interface ObsCounters {
  injected: number;
  produced: number;
  peeked: number;
}

/** none 档回灌的字面量（README O1：返回字面量"内容未变化"） */
export const UNCHANGED_TEXT = '内容未变化' as const;

/**
 * BlobSink：唯一 IO 出口（红线）。与 state.ts 的 BlobSink 结构兼容——
 * 02 号工作包落地后由适配层（07）把它的实现注入进来；缺省用内存实现。
 */
export interface BlobSink {
  put(ref: string, content: string): void;
}

export class InMemoryBlobSink implements BlobSink {
  private map = new Map<string, string>();
  put(ref: string, content: string): void {
    this.map.set(ref, content);
  }
  get(ref: string): string | undefined {
    return this.map.get(ref);
  }
}

export interface ObsKernelOptions {
  /** 饥饿防线阈值：连续 N 步无 full 注入时升级注入最近一条 handle 观测（默认 5） */
  starvationThreshold?: number;
  /** blob 出口注入；缺省内存实现 */
  sink?: BlobSink;
  /**
   * 0.5.0（§7.3）：已投递 span 账本（默认开）。false = 关闭去重（回退点：
   * `spanLedger: false` 行为等价 0.4.0——重复取回同一区间重复付费）。
   */
  spanLedger?: boolean;
  /**
   * 0.6.0 正式版（security 缺口修复）：模型可见输出脱敏（默认开）。
   * observe() 登记前对内容做 redactSecrets（对齐 [TF]/output_capture.py:19-41：
   * 落盘/回显前先脱敏）——句柄存储、全文回灌、recall 取回全部继承脱敏后的内容。
   * false = 关闭（回退点；装配显式选择）。
   */
  redact?: boolean;
}

interface DirEntryInternal {
  handle: string;
  key: string;
  version: number;
  firstSeq: number;
  lastSeq: number;
  stale: boolean;
}

interface LowRecord {
  handle: string;
  key: string;
  content: string;
  seq: number;
}

const DEFAULT_STARVATION_THRESHOLD = 5;

/**
 * 观测账本：登记 + 分类 + 骨架 + 目录差分 + 计数器 + 饥饿防线。
 * 0.5.0 增：已投递 span 账本（§7.3(2)，D5 修复——重复取回同一区间不再重复付费）、
 * request:N 句柄别名（§7.6）、取回度量（§7.4）。
 * 每个任务一个实例（reset() 或直接 new）。
 */
/**
 * 0.6.0（PE-1）：query 未命中时的候选行段。命中率不足的主因是"只能盲试"——
 * 未命中必须给出可执行线索（行号 + 首行），且不调模型、不改参数。
 *
 * 排序：按查询词在该行的命中次数降序，行号升序兜底；零命中也给候选（文件头部若干行），
 * 绝不返回空（"未命中 100% 有候选"）。总长受 maxChars 约束（默认 2000）。
 */
export interface QueryCandidate {
  line: number;
  text: string;
  score: number;
}

export function queryCandidates(
  content: string,
  query: string,
  opts: { limit?: number; maxChars?: number } = {},
): QueryCandidate[] {
  const lines = content.split('\n');
  const maxChars = Math.max(120, opts.maxChars ?? 2000);
  const limit = Math.max(1, opts.limit ?? 3);
  // 查询词：整串 + 按非字母数字切分出的词（中文按整串，避免把"配置项"切成单字）
  const whole = query.trim();
  const terms = new Set<string>();
  if (whole !== '') terms.add(whole);
  for (const t of whole.split(/[^\p{L}\p{N}_]+/u)) {
    if (t !== '' && t !== whole) terms.add(t);
  }
  const scored: QueryCandidate[] = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;
    if (text.trim() === '') continue;
    let score = 0;
    for (const term of terms) {
      if (term === '') continue;
      let from = 0;
      while (true) {
        const hit = text.indexOf(term, from);
        if (hit < 0) break;
        score += 1;
        from = hit + Math.max(1, term.length);
      }
    }
    scored.push({ line: i + 1, text: text.trim().slice(0, 120), score });
  }
  const ranked = scored
    .filter((c) => c.score > 0)
    .sort((a, b) => (b.score - a.score) || (a.line - b.line));
  const picked: QueryCandidate[] = [];
  const seenLines = new Set<number>();
  const push = (c: QueryCandidate): void => {
    if (picked.length >= limit || seenLines.has(c.line)) return;
    picked.push(c);
    seenLines.add(c.line);
  };
  for (const c of ranked) push(c);
  // 零命中/命中不足：用文件头部行补足（候选必须有，但不冒充"命中"）
  if (picked.length < limit) {
    for (const c of scored) {
      if (picked.length >= limit) break;
      push({ ...c, score: 0 });
    }
  }
  // 总长上限：逐条裁剪（宁可少一条也不超预算）
  const out: QueryCandidate[] = [];
  let used = 0;
  for (const c of picked) {
    const cost = `L${c.line} ${c.text}`.length + 1;
    if (used + cost > maxChars) {
      // 0.6.0 复查修复（O2）：头注释承诺"绝不返回空"——此前第一条即超预算时整体
      // break 返回 []。现在至少保留一条（裁剪到剩余预算内），契约成立。
      if (out.length === 0) {
        const room = Math.max(1, maxChars - used - 1);
        out.push({ line: c.line, text: c.text.slice(0, room), score: c.score });
      }
      break;
    }
    out.push(c);
    used += cost;
  }
  return out;
}

/** 0.6.0（PE-3）：句柄的外部文件绑定——read 时登记的快照（path + mtimeMs + size）。 */
export interface FileBinding {
  path: string;
  mtimeMs: number;
  size: number;
}

/** 快照与当前 stat 是否不一致（mtime 或 size 任一变化 = 文件已变）。纯函数。 */
export function isBindingStale(binding: FileBinding, current: { mtimeMs: number; size: number }): boolean {
  return binding.mtimeMs !== current.mtimeMs || binding.size !== current.size;
}

/** 0.6.0（PE-3）：`[stale]` 一行文案（模型必须知道"内容变了"，不许静默替换旧文）。 */
export function staleLine(binding: FileBinding, current: { mtimeMs: number; size: number }): string {
  return `[stale] handle 对应的文件已变更（${binding.path}）：登记时 mtime=${Math.round(binding.mtimeMs)} size=${binding.size}，当前 mtime=${Math.round(current.mtimeMs)} size=${current.size}。旧文本不代表当前内容——请重新 tf-read 该文件后再取回。`;
}

export class ObservationLedger {
  private readonly threshold: number;
  private readonly sink: BlobSink;
  private readonly spanLedgerEnabled: boolean;
  private readonly redactEnabled: boolean;

  private seqCounter = 0;
  private readonly contentByHandle = new Map<string, string>();
  private readonly lastHashByKey = new Map<string, string>();
  private readonly versionByKey = new Map<string, number>();
  private readonly handleByKey = new Map<string, string>();
  private readonly dirByKey = new Map<string, DirEntryInternal>();
  private readonly lowRecords: LowRecord[] = [];
  private readonly ledger: ObservationRecord[] = [];

  // ---- 0.5.0：span 账本与取回度量（§7.3/§7.4）----
  /** 已投递区间账本：handle → [{from,to,req,contentHash}]。spanLedger=false 时不写入（回退点）。 */
  private readonly deliveredSpans = new Map<string, DeliveredSpan[]>();
  /** handle → 最近一次投递时的全文哈希（变化检测：正文变了就不能说 [unchanged]）。 */
  private readonly hashByHandle = new Map<string, string>();
  /** request:N → 该请求句柄化的段句柄（长上下文压缩段的取回别名）。 */
  private readonly handlesByRequest = new Map<number, string[]>();
  /** 取回请求计数（tf-peek 语义的调用数；§7.4 peek_requests_per_task 分子）。 */
  private peekRequestTotal = 0;
  /** 命中已投递且未变化的取回数（redundant_peek_ratio 分子；命中即省一次正文投递）。 */
  private redundantHits = 0;
  /** 取回原文累计字节（deref_bytes）。 */
  private derefBytes = 0;
  /** 产出原文累计字节（produced_bytes：observe() 收到的内容字节合计）。 */
  private producedBytes = 0;
  /** 每 handle 取回次数（k_mean 用）。 */
  private readonly peekCountByHandle = new Map<string, number>();

  private injectedTotal = 0;
  private producedTotal = 0;
  private peekedTotal = 0;
  private drySteps = 0;
  /** 0.6.0（PE-3）：句柄 → 外部文件绑定（read 时登记的 mtime+size 快照）。 */
  private readonly fileBindings = new Map<string, FileBinding>();

  constructor(options: ObsKernelOptions = {}) {
    const t = options.starvationThreshold ?? DEFAULT_STARVATION_THRESHOLD;
    if (!Number.isInteger(t) || t < 1) {
      throw new RangeError(`starvationThreshold must be an integer >= 1, got ${options.starvationThreshold}`);
    }
    this.threshold = t;
    this.sink = options.sink ?? new InMemoryBlobSink();
    this.spanLedgerEnabled = options.spanLedger !== false;
    this.redactEnabled = options.redact !== false;
  }

  // ------------------------------------------------------------------
  // 0.5.0 span 账本（§7.3(2)）：已投递区间去重（D5 修复）
  // ------------------------------------------------------------------

  /**
   * 登记一次"已投递"（read/peek 的正文进入模型上下文时调用）。
   * spanLedger=false（回退点）时只计数不记账（行为等价 0.4.0）。
   */
  recordDelivered(handle: string, fromLine: number, toLine: number, requestSeq: number): void {
    if (!this.spanLedgerEnabled) return;
    const content = this.contentByHandle.get(handle);
    if (content === undefined) return;
    const lines = content.split('\n');
    const from = Math.max(1, Math.floor(fromLine));
    const to = Math.min(lines.length, Math.floor(toLine));
    if (from > to) return;
    const contentHash = this.hashByHandle.get(handle) ?? hashContent(content);
    const spans = this.deliveredSpans.get(handle) ?? [];
    spans.push({ from, to, req: requestSeq, contentHash });
    this.deliveredSpans.set(handle, spans);
  }

  /** 查询某句柄的已投递区间（账本只读视图；测试/审计用）。 */
  deliveredSpanList(handle: string): readonly DeliveredSpan[] {
    return this.deliveredSpans.get(handle) ?? [];
  }

  /**
   * span 感知取回（§7.3(2)）：tf-peek 与回灌通道共用。
   *  - 命中已投递且内容哈希未变 → { kind:'unchanged', line }（一行 ~20 token，不返回正文）；
   *  - 部分重叠（同内容哈希的已投递段与请求区间相交但不覆盖）→ 只返回**新增**区间正文 + 一行说明；
   *  - 无重叠（或账本关闭）→ 正常返回正文；
   *  - 未知句柄 → null（调用方上报，内核不静默吞）。
   */
  peekWithLedger(handle: string, fromLine: number, toLine: number, requestSeq: number, options?: { countRequest?: boolean }): PeekSpanResult | null {
    const content = this.contentByHandle.get(handle);
    if (content === undefined) return null;
    this.peekedTotal++;
    // countRequest=false：自动完整反馈（非模型主动取回）不进取回度量——§7.4 的
    // peek_requests_per_task / k_mean 度量的是"由取回引起的"请求（模型 tf-peek）。
    if (options?.countRequest !== false) {
      this.peekRequestTotal++;
      this.peekCountByHandle.set(handle, (this.peekCountByHandle.get(handle) ?? 0) + 1);
    }
    const lines = content.split('\n');
    const from = Math.max(1, Math.floor(fromLine));
    const to = Math.min(lines.length, Math.floor(toLine));
    if (from > to) return { kind: 'content', handle, from, to, text: '', note: '空区间' };
    const currentHash = this.hashByHandle.get(handle) ?? hashContent(content);
    // 有效账本 = 同内容哈希的投递记录（正文已变化的历史投递不算数）
    const spans = this.spanLedgerEnabled
      ? (this.deliveredSpans.get(handle) ?? []).filter((s) => s.contentHash === currentHash)
      : [];
    const fullyCovered = spans.some((s) => s.from <= from && s.to >= to);
    if (fullyCovered) {
      this.redundantHits++;
      const lastReq = spans
        .filter((s) => s.from <= from && s.to >= to)
        .reduce((m, s) => Math.max(m, s.req), 0);
      return {
        kind: 'unchanged',
        handle,
        from,
        to,
        line: `[unchanged] ${handle} L${from}-${to}（与 req#${lastReq} 投递内容一致，未变化）`,
      };
    }
    const missing = subtractSpans(from, to, spans);
    const overlapChars = spans.reduce((n, s) => n + (Math.min(s.to, to) - Math.max(s.from, from) + 1 > 0 ? Math.min(s.to, to) - Math.max(s.from, from) + 1 : 0), 0);
    if (missing.length > 0 && overlapChars > 0) {
      // 部分重叠：仅返回新增区间并附一行说明（§7.3(2)）
      const text = missing.map(([a, b]) => lines.slice(a - 1, b).join('\n')).join('\n');
      const missingDesc = missing.map(([a, b]) => (a === b ? `L${a}` : `L${a}-${b}`)).join(', ');
      this.derefBytes += Buffer.byteLength(text, 'utf8');
      this.injectedTotal++;
      return { kind: 'partial', handle, from, to, text, note: `已投递区间不重发（${overlapChars} 字符省略）；新增区间 ${missingDesc}` };
    }
    // 无重叠：正常返回正文
    const text = lines.slice(from - 1, to).join('\n');
    this.derefBytes += Buffer.byteLength(text, 'utf8');
    this.injectedTotal++; // peek 产出进入上下文，按口径计入 injected
    return { kind: 'content', handle, from, to, text };
  }

  /**
   * request:N 句柄别名（§7.6 长上下文取回）：压缩段句柄化后按请求序号登记，
   * `resolveHandleRef('request:12')` → 该请求句柄化的段句柄列表。
   */
  registerRequestHandle(requestSeq: number, handle: string): void {
    const list = this.handlesByRequest.get(requestSeq) ?? [];
    if (!list.includes(handle)) list.push(handle);
    this.handlesByRequest.set(requestSeq, list);
  }

  /**
   * 0.6.0 正式版（conversation 缺口）：用户请求原文句柄化 + request:N 别名登记
   *（对齐 [TF]/conversation.py:25-36）。**不走 observe() 的工具观测口径**——
   * 请求原文不是工具产出，不进 produced/injected 度量（否则每个任务凭空多一条
   * "写观测"，污染 §7.4 指标）；只进句柄目录与存储，tf-peek handle="request:N" 可取回。
   */
  registerRequestText(requestSeq: number, text: string): string {
    const content = this.redactEnabled ? redactSecrets(text) : text;
    const key = `request:${requestSeq}:task`;
    const version = (this.versionByKey.get(key) ?? 0) + 1;
    const handle = `obs:request:req-t${requestSeq}@v${version}`;
    const hash = hashContent(content);
    this.contentByHandle.set(handle, content);
    this.sink.put(handle, content);
    this.hashByHandle.set(handle, hash);
    this.versionByKey.set(key, version);
    this.lastHashByKey.set(key, hash);
    this.handleByKey.set(key, handle);
    this.registerRequestHandle(requestSeq, handle);
    return handle;
  }

  /**
   * 0.5.0（Appendix B："peek 增符号定位与 span 去重"）：按符号定位取回——
   * 在句柄内容中查找**顶层符号**定义行（TOP_LEVEL_SYMBOL_RE），返回 ±window 行窗口。
   * 模型不再需要按行号猜测（§7.2 问题 1 的直接修复）；找不到返回 null（调用方按
   * unknown-symbol 结构化上报，不静默）。计数口径与 peekWithLedger 一致
   * （countRequest 由调用方决定——模型主动 tf-peek symbol 计入度量）。
   */
  peekBySymbol(handle: string, symbol: string, requestSeq: number, options?: { window?: number; countRequest?: boolean }): { from: number; to: number; text: string; line: number } | null {
    const content = this.contentByHandle.get(handle);
    if (content === undefined) return null;
    this.peekedTotal++;
    if (options?.countRequest !== false) {
      this.peekRequestTotal++;
      this.peekCountByHandle.set(handle, (this.peekCountByHandle.get(handle) ?? 0) + 1);
    }
    const lines = content.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    // 0.6.0 复查修复（O1）：JS \b 只在 ASCII 词字符（[\w]）边界成立——纯中文符号两侧
    // 无 ASCII 词字符交界，\b 恒不成立，中文符号定位 100% 失败（unknown-symbol）。
    // 改用显式 lookaround：两侧不得是 ASCII 词字符（字母/数字/下划线）。对 ASCII 符号
    // 语义与 \b 一致；对中文符号，两侧是中文/空白/标点均可命中（中文本身非词字符）。
    const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(symbol)}(?![A-Za-z0-9_])`);
    let found = -1;
    for (let i = 0; i < lines.length; i++) {
      if (TOP_LEVEL_SYMBOL_RE.test(lines[i]!) && re.test(lines[i]!)) {
        found = i;
        break;
      }
    }
    if (found < 0) return null;
    const window = Math.max(1, options?.window ?? 40);
    const from = Math.max(1, found + 1 - window);
    const to = Math.min(lines.length, found + 1 + window);
    const text = lines.slice(from - 1, to).join('\n');
    this.derefBytes += Buffer.byteLength(text, 'utf8');
    this.injectedTotal++;
    return { from, to, text, line: found + 1 };
  }

  /** 解析 handle 引用：'request:N' → 段句柄数组；普通句柄 → 原样单元素。 */
  resolveHandleRef(ref: string): string[] {
    const m = /^request:(\d+)$/.exec(ref.trim());
    if (m !== null) return [...(this.handlesByRequest.get(Number(m[1])) ?? [])];
    return [ref];
  }

  /** 取回度量（§7.4）：peek_requests_per_task / redundant_peek_ratio / deref/produced / k_mean。 */
  peekMetrics(): PeekMetrics {
    let kSum = 0;
    for (const n of this.peekCountByHandle.values()) kSum += n;
    const kHandles = this.peekCountByHandle.size;
    return {
      peekRequests: this.peekRequestTotal,
      redundantHits: this.redundantHits,
      redundantPeekRatio: this.peekRequestTotal > 0 ? this.redundantHits / this.peekRequestTotal : 0,
      derefBytes: this.derefBytes,
      producedBytes: this.producedBytes,
      derefRatio: this.producedBytes > 0 ? this.derefBytes / this.producedBytes : 0,
      kMean: kHandles > 0 ? kSum / kHandles : 0,
    };
  }

  /** 登记一条工具产出观测，返回三档结果（O1）。 */
  observe(input: ObservationInput): ObservationResult {
    // 0.6.0 正式版：脱敏先于一切登记/落盘/回灌（密钥赋值 → [REDACTED]）。
    if (this.redactEnabled) input = { ...input, content: redactSecrets(input.content) };
    this.producedTotal++;
    this.producedBytes += Buffer.byteLength(input.content, 'utf8');
    const family = classifyTool(input.tool);
    const cls = classify(input, { lastHash: this.lastHashByKey.get(input.key) });
    const seq = ++this.seqCounter;

    if (cls.info_gain === 'dedup') {
      // none：连句柄目录都不更新，只记 ledger。回灌字面量计入 injected（占请求体积）。
      this.ledger.push({
        handle: this.handleByKey.get(input.key) ?? '',
        key: input.key,
        family,
        version: this.versionByKey.get(input.key) ?? 0,
        seq,
        info_gain: 'dedup',
        reason: cls.reason,
      });
      this.injectedTotal++;
      return {
        handle: this.handleByKey.get(input.key) ?? null,
        info_gain: 'dedup',
        reason: cls.reason,
        seq,
        payload: { kind: 'unchanged', text: UNCHANGED_TEXT },
      };
    }

    // high / low：新版本入库（内容哈希变化才到这里）
    const version = (this.versionByKey.get(input.key) ?? 0) + 1;
    const callId = input.callId ?? `c${seq}`;
    const handle = `obs:${family}:${callId}@v${version}`;
    const hash = hashContent(input.content);

    this.contentByHandle.set(handle, input.content);
    this.sink.put(handle, input.content);
    this.hashByHandle.set(handle, hash);
    this.versionByKey.set(input.key, version);
    this.lastHashByKey.set(input.key, hash);
    this.handleByKey.set(input.key, handle);

    const prev = this.dirByKey.get(input.key);
    if (prev) {
      prev.handle = handle;
      prev.version = version;
      prev.lastSeq = seq;
      prev.stale = false;
    } else {
      this.dirByKey.set(input.key, {
        handle, key: input.key, version, firstSeq: seq, lastSeq: seq, stale: false,
      });
    }

    this.ledger.push({
      handle, key: input.key, family, version, seq,
      info_gain: cls.info_gain, reason: cls.reason,
    });

    if (cls.info_gain === 'full') {
      const skeleton = renderSkeleton(input.content);
      this.injectedTotal++;
      return {
        handle,
        info_gain: 'full',
        reason: cls.reason,
        seq,
        payload: { kind: 'skeleton', skeleton, rendered: skeletonToText(skeleton) },
      };
    }

    // low：句柄化，不注入；登记进 lowRecords 供饥饿防线升级
    this.lowRecords.push({ handle, key: input.key, content: input.content, seq });
    return {
      handle,
      info_gain: 'handle',
      reason: cls.reason,
      seq,
      payload: { kind: 'receipt', handle, note: '句柄化，不注入' },
    };
  }

  /**
   * tf-peek：按行段取回句柄内容（O2 内核侧支持）。1-based 闭区间，越界收敛。
   * 未知句柄返回 null（调用方决定如何上报，内核不静默吞）。
   */
  peek(handle: string, fromLine: number, toLine: number): string | null {
    const content = this.contentByHandle.get(handle);
    if (content === undefined) return null;
    this.peekedTotal++;
    this.injectedTotal++; // peek 产出进入上下文，按口径计入 injected
    const lines = content.split('\n');
    const from = Math.max(1, Math.floor(fromLine));
    const to = Math.min(lines.length, Math.floor(toLine));
    if (from > to) return '';
    return lines.slice(from - 1, to).join('\n');
  }

  /**
   * 2.3：字符级取回（对齐 thinkflow recall.py:34 recall_text）。
   * offset = 字符起点（UTF-16 索引，与 JS slice 一致）；limit = 最大字符数；
   * query = 字面续搜串——从 offset 起找首次出现，命中则从该处返回；未命中返回 null
   * （调用方上报 query-not-found，不静默）。返回 continuation 提示供模型续搜。
   */
  recallText(
    handle: string,
    opts: { offset?: number; limit?: number; query?: string },
  ): { text: string; start: number; end: number; continuation: string | null } | null {
    const content = this.contentByHandle.get(handle);
    if (content === undefined) return null;
    // 审查修正：limit<=0 明确返回空（预算耗尽时不得回退到 8000 绕过 peekBudgetChars）。
    const limit = opts.limit === undefined ? 8000 : Math.floor(opts.limit);
    if (limit <= 0) return { text: '', start: 0, end: 0, continuation: null };
    const rawOffset = Math.floor(opts.offset ?? 0);
    if (rawOffset < 0) return null; // 对齐 [TF]/recall.py:39 负 offset 拒绝
    if (rawOffset > content.length) return null; // 对齐 [TF]/recall.py:43 offset 越界拒绝
    const hasQuery = opts.query !== undefined && opts.query !== '';
    let start = rawOffset;
    let continueFrom: number | undefined;
    if (hasQuery) {
      const found = content.indexOf(opts.query!, start);
      if (found < 0) return null; // 调用方上报 query-not-found
      // 对齐 [TF]/recall.py:63-69：回退 min(200, limit//4) 字符并对齐行首。
      const back = Math.min(200, Math.floor(limit / 4));
      let queryStart = Math.max(0, found - back);
      const prefix = content.slice(queryStart, found);
      const lineBreak = Math.max(prefix.lastIndexOf('\n'), prefix.lastIndexOf('\r'));
      if (lineBreak >= 0) queryStart += lineBreak + 1;
      start = queryStart;
      // 对齐 [TF]/recall.py:78：续搜锚点 = 命中位置 + query 长度（不是窗口末尾）。
      continueFrom = found + opts.query!.length;
    }
    let end = Math.min(content.length, start + limit);
    let text = content.slice(start, end);
    if (hasQuery) {
      // 对齐 [TF]/recall.py:71-76：截到命中后的第一个行尾。
      const matchInText = content.indexOf(opts.query!, start) - start;
      const cr = text.indexOf('\r', Math.max(0, matchInText));
      const lf = text.indexOf('\n', Math.max(0, matchInText));
      const lineEnd = Math.min(...[cr, lf].filter((p) => p >= 0), text.length);
      if (lineEnd < text.length) {
        text = text.slice(0, lineEnd);
        end = start + text.length;
      }
    }
    this.peekedTotal++;
    this.injectedTotal++;
    this.derefBytes += Buffer.byteLength(text, 'utf8');
    // 审查修正：与 peekWithLedger/peekBySymbol 一致计入 peekRequests 与 kMean。
    this.peekRequestTotal++;
    this.peekCountByHandle.set(handle, (this.peekCountByHandle.get(handle) ?? 0) + 1);
    return {
      text,
      start,
      end,
      // query 命中用续搜锚点；纯 offset 用窗口末尾。
      continuation: (() => {
        const from = continueFrom ?? end;
        return from < content.length ? (hasQuery ? `query=${opts.query} next offset=${from}` : `next offset=${from}`) : null;
      })(),
    };
  }

  /** 标记句柄失效（如文件被外部删除/覆盖）。返回新 seq 供装配器推进游标；未知 key 返回 null。 */
  markStale(key: string): number | null {    const entry = this.dirByKey.get(key);
    if (!entry) return null;
    entry.stale = true;
    entry.lastSeq = ++this.seqCounter;
    return entry.lastSeq;
  }

  // ------------------------------------------------------- 0.6.0 TF-PEEK（PE-1/PE-3）

  /** PE-1：query 未命中时的候选行段（纯计算，不调模型；永不返回空）。 */
  queryCandidates(handle: string, query: string, opts: { limit?: number; maxChars?: number } = {}): QueryCandidate[] {
    const content = this.contentByHandle.get(handle);
    if (content === undefined) return [];
    return queryCandidates(content, query, opts);
  }

  /** PE-3：登记/更新句柄的文件绑定（tf-read 成功时调用；旧绑定被覆盖）。 */
  registerFileBinding(handle: string, binding: FileBinding): void {
    this.fileBindings.set(handle, binding);
  }

  /** PE-3：读取句柄的文件绑定（无绑定 = 该句柄不是文件读取产物，peek 不做 stat 校验）。 */
  fileBindingOf(handle: string): FileBinding | undefined {
    return this.fileBindings.get(handle);
  }

  /** 句柄目录差分（O3）：added / changed / stale 三列表，按 seq 升序。 */
  directoryDelta(sinceSeq: number): DirectoryDelta {
    const delta: DirectoryDelta = { added: [], changed: [], stale: [] };
    const entries = [...this.dirByKey.values()].sort((a, b) => a.lastSeq - b.lastSeq);
    for (const e of entries) {
      if (e.lastSeq <= sinceSeq) continue;
      const out: HandleEntry = {
        handle: e.handle, key: e.key, version: e.version, seq: e.lastSeq,
        status: e.stale ? 'stale' : e.version === 1 ? 'added' : 'changed',
      };
      if (e.stale) delta.stale.push(out);
      else if (e.version === 1) delta.added.push(out);
      else delta.changed.push(out);
    }
    return delta;
  }

  /**
   * 饥饿防线（M2 关键防线）：每个 step 结束时由 loop 调用。
   * 连续 threshold 步没有任何 full 注入 → 把最近一条 handle 观测的骨架
   * 升格注入，防止模型在信息真空中瞎猜。触发后计数清零（再连续 N 步可再次触发）。
   * 无 handle 观测可升级时不触发、不清零（继续等待）。
   */
  noteStep(highInjectedThisStep: boolean): ObservationResult | null {
    if (highInjectedThisStep) {
      this.drySteps = 0;
      return null;
    }
    this.drySteps++;
    if (this.drySteps < this.threshold || this.lowRecords.length === 0) return null;
    this.drySteps = 0;
    const rec = this.lowRecords[this.lowRecords.length - 1];
    const skeleton = renderSkeleton(rec.content);
    this.injectedTotal++;
    return {
      handle: rec.handle,
      info_gain: 'full',
      reason: 'starvation-promotion',
      seq: rec.seq,
      payload: { kind: 'skeleton', skeleton, rendered: skeletonToText(skeleton) },
    };
  }

  counters(): ObsCounters {
    return { injected: this.injectedTotal, produced: this.producedTotal, peeked: this.peekedTotal };
  }

  /** injected_ratio = injected / produced（08 号 METRICS.md 口径；produced=0 时为 0） */
  injectedRatio(): number {
    if (this.producedTotal === 0) return 0;
    return this.injectedTotal / this.producedTotal;
  }

  /** 追加只读的观测流水（审计用，最旧在前） */
  records(): readonly ObservationRecord[] {
    return this.ledger;
  }

  /** 任务结束/新任务开始：清空全部状态（计数器一并清零，口径为"每任务"） */
  reset(): void {
    this.seqCounter = 0;
    this.contentByHandle.clear();
    this.lastHashByKey.clear();
    this.versionByKey.clear();
    this.handleByKey.clear();
    this.dirByKey.clear();
    this.lowRecords.length = 0;
    this.ledger.length = 0;
    this.injectedTotal = 0;
    this.producedTotal = 0;
    this.peekedTotal = 0;
    this.drySteps = 0;
    // 0.5.0：span 账本与取回度量同口径清零（每任务）
    this.deliveredSpans.clear();
    this.hashByHandle.clear();
    this.handlesByRequest.clear();
    this.peekRequestTotal = 0;
    this.redundantHits = 0;
    this.derefBytes = 0;
    this.producedBytes = 0;
    this.peekCountByHandle.clear();
  }
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * FNV-1a 64bit，仅用于"内容是否变化"判定（碰撞概率对去重场景足够）。
 * 不做内容寻址——那归 state.ts 的 sha256。
 */
function hashContent(s: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

// ---------------------------------------------------------------------------
// 0.5.0 span 账本类型与区间运算（§7.3(2)，D5 修复）
// ---------------------------------------------------------------------------

/** 已投递区间（1-based 闭区间；contentHash = 投递时的全文哈希，变化检测用）。 */
export interface DeliveredSpan {
  from: number;
  to: number;
  /** 投递发生时的请求序号（request:N 取回别名与 [unchanged] 行引用它） */
  req: number;
  contentHash: string;
}

/** span 感知取回结果（peekWithLedger 的返回；kind 决定调用方注入形态）。 */
export type PeekSpanResult =
  | { kind: 'unchanged'; handle: string; from: number; to: number; line: string }
  | { kind: 'partial'; handle: string; from: number; to: number; text: string; note: string }
  | { kind: 'content'; handle: string; from: number; to: number; text: string; note?: string };

/** 取回度量（§7.4 指标表）。 */
export interface PeekMetrics {
  /** 由取回引起的请求数的分母侧：取回调用总数 */
  peekRequests: number;
  /** 命中已投递且未变化的取回数 */
  redundantHits: number;
  /** redundant_peek_ratio（目标 ≥ 0.8） */
  redundantPeekRatio: number;
  /** 取回原文累计字节 */
  derefBytes: number;
  /** 产出原文累计字节 */
  producedBytes: number;
  /** deref_bytes / produced_bytes（目标 ≤ 0.5） */
  derefRatio: number;
  /** 每个 handle 的平均取回次数（目标 ≤ 1.2） */
  kMean: number;
}

/** 从 [from,to] 中减去已覆盖区间（区间并集裁剪；结果为未覆盖子区间，升序）。 */
function subtractSpans(from: number, to: number, covered: readonly DeliveredSpan[]): Array<[number, number]> {
  const sorted = [...covered].filter((s) => s.to >= from && s.from <= to).sort((a, b) => a.from - b.from);
  const out: Array<[number, number]> = [];
  let cursor = from;
  for (const s of sorted) {
    if (s.from > cursor) out.push([cursor, Math.min(s.from - 1, to)]);
    cursor = Math.max(cursor, s.to + 1);
    if (cursor > to) break;
  }
  if (cursor <= to) out.push([cursor, to]);
  return out.filter(([a, b]) => a <= b);
}

// ---------------------------------------------------------------------------
// 0.5.0 read 索引（§7.3(1)）：截断改为"索引 + 请求窗 + 覆盖图"（D4 修复）
// ---------------------------------------------------------------------------

/** 行锚（每 anchorEvery 行一个；含顶层符号）。 */
export interface ReadAnchor {
  line: number;
  text: string;
}

/** 顶层符号判定（索引锚点的"含顶层符号"要求；规则式，不调模型）。 */
const TOP_LEVEL_SYMBOL_RE = /^\s*(?:export\s+)?(?:abstract\s+)?(?:class|function|def|const|let|var|interface|type|enum|async\s+function|public|private|protected)\b|^#{1,6}\s+/;

export interface ReadIndexOptions {
  /** 锚点间隔（行）；默认 200（§7.3(1)） */
  anchorEvery?: number;
  /** 索引总字符上限（R9：超出仅给符号名；默认 2000） */
  maxIndexChars?: number;
  /** 已投递区间（覆盖图；缺省 = 无） */
  delivered?: ReadonlyArray<{ from: number; to: number }>;
}

/**
 * 生成 read 索引（头信息 + 行锚 + 未投递区间）。索引成本约为文件体积的 1–3%；
 * 未投递区间显式列出，模型无需推断已读范围。
 */
export function renderReadIndex(content: string, opts: ReadIndexOptions = {}): string {
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const anchorEvery = Math.max(1, opts.anchorEvery ?? 200);
  const maxIndexChars = Math.max(200, opts.maxIndexChars ?? 2000);
  const bytes = Buffer.byteLength(content, 'utf8');
  const kb = bytes >= 1024 ? `${Math.round(bytes / 1024)}KB` : `${bytes}B`;
  const head = `[tf-stream:read] ${lines.length.toLocaleString('en-US')} 行 / ${kb}`;

  // 已投递覆盖图
  const delivered = opts.delivered ?? [];
  const deliveredDesc = delivered
    .map((s) => `L${s.from}-${s.to}`)
    .join(' + ');

  // 行锚：每 anchorEvery 行一个，且优先含顶层符号的行（若该窗口内有）
  const anchors: ReadAnchor[] = [];
  for (let start = 0; start < lines.length; start += anchorEvery) {
    const window = lines.slice(start, Math.min(start + anchorEvery, lines.length));
    let picked = -1;
    for (let i = 0; i < window.length; i++) {
      if (TOP_LEVEL_SYMBOL_RE.test(window[i]!)) {
        picked = start + i;
        break;
      }
    }
    if (picked === -1 && window.length > 0) picked = start;
    if (picked >= 0) anchors.push({ line: picked + 1, text: lines[picked]!.trim().slice(0, 120) });
  }

  // 未投递区间 = [1, total] − 已投递
  const undelivered = subtractSpans(1, lines.length, delivered.map((s) => ({ from: s.from, to: s.to, req: 0, contentHash: '' })));
  const undeliveredDesc = undelivered.map(([a, b]) => (a === b ? `L${a}` : `L${a}-${b}`)).join(', ');

  // R9：索引本身超预算 → 只给符号名（丢锚文本，保留行号）
  let body = anchors.map((a) => `  L${a.line} ${a.text}`).join('\n');
  if (head.length + 1 + body.length > maxIndexChars) {
    body = anchors.map((a) => `  L${a.line} ${symbolNameOf(a.text)}`).join('\n');
    // 0.6.0（PE-2）：锚点可加密（peekAnchorEvery=100）→ 降级形态仍可能超上限；
    // 此时按行截断（保留前 N 个锚 + 一行省略说明），硬保证 ≤ maxIndexChars。
    if (head.length + 1 + body.length > maxIndexChars) {
      const keptLines: string[] = [];
      let used = head.length + 1;
      for (const a of anchors) {
        const row = `  L${a.line} ${symbolNameOf(a.text)}`;
        if (used + row.length + 1 > maxIndexChars - 24) break;
        keptLines.push(row);
        used += row.length + 1;
      }
      const omitted = anchors.length - keptLines.length;
      body = [...keptLines, omitted > 0 ? `  …（其余 ${omitted} 个锚点已省略：读窗口请用 tf-grep 收窄）` : ''].join('\n');
    }
  }

  const parts = [head];
  if (deliveredDesc !== '') parts.push(`已投递 ${deliveredDesc}`);
  if (body !== '') parts.push(`索引（每 ${anchorEvery} 行一个锚，含顶层符号）：\n${body}`);
  if (undeliveredDesc !== '') {
    parts.push(`未投递区间：${undeliveredDesc} → 用 tf-peek handle=... from_line=.. to_line=.. 取回`);
  }
  const text = parts.join('\n');
  if (text.length <= maxIndexChars) return text;

  // 0.6.0（PE-2）：超上限时的**降级顺序**。导航信息优先：已投递区间是"历史账"，
  // 索引与未投递区间才是"接下来读哪里"——所以降级后把已投递放最后并截断，
  // 而不是让它在前面把索引整段挤掉（审查实测：40 个已投递区间就能挤掉索引）。
  // 默认（未超限）输出字节不变：上面已按 0.5.0 顺序返回。
  const mergedDelivered = mergeSpans(delivered);
  const deliveredShort = mergedDelivered.length === 0
    ? ''
    : `已投递 ${mergedDelivered.length} 段：${mergedDelivered.slice(-6).map((sp) => `L${sp.from}-${sp.to}`).join(' + ')}${mergedDelivered.length > 6 ? ' +…' : ''}`;
  const undeliveredLine = undeliveredDesc === ''
    ? ''
    : `未投递区间：${undeliveredDesc.length > 600 ? `${undeliveredDesc.slice(0, 600)}…` : undeliveredDesc} → 用 tf-peek 按窗口取回`;
  const anchorLines = anchors.map((a) => `  L${a.line} ${symbolNameOf(a.text)}`);
  const fixed = [head, undeliveredLine, deliveredShort].filter((x) => x !== '');
  const fixedChars = fixed.reduce((n, x) => n + x.length + 1, 0);
  const indexHeader = `索引（每 ${anchorEvery} 行一个锚；超限只给符号名）：`;
  const room = Math.max(0, maxIndexChars - fixedChars - indexHeader.length - 26);
  const kept: string[] = [];
  let used = 0;
  for (const line of anchorLines) {
    if (used + line.length + 1 > room) break;
    kept.push(line);
    used += line.length + 1;
  }
  const omitted = anchorLines.length - kept.length;
  const tailNote = omitted > 0 ? `  …（其余 ${omitted} 个锚点已省略：用 tf-grep 收窄）` : '';
  const composed = [
    head,
    kept.length > 0 ? `${indexHeader}\n${kept.join('\n')}${tailNote === '' ? '' : `\n${tailNote}`}` : '',
    undeliveredLine,
    deliveredShort,
  ].filter((x) => x !== '').join('\n');
  return composed.slice(0, maxIndexChars);
}

/** 区间归一：排序 + 合并相邻/重叠（只用于超限降级路径，默认输出字节不受影响）。 */
function mergeSpans(spans: ReadonlyArray<{ from: number; to: number }>): Array<{ from: number; to: number }> {
  const sorted = [...spans]
    .filter((sp) => sp.to >= sp.from)
    .sort((a, b) => (a.from - b.from) || (a.to - b.to));
  const out: Array<{ from: number; to: number }> = [];
  for (const sp of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && sp.from <= last.to + 1) {
      last.to = Math.max(last.to, sp.to);
    } else {
      out.push({ from: sp.from, to: sp.to });
    }
  }
  return out;
}

/** 从锚文本提取符号名（R9 降级形态：只给符号名不给行内容）。 */
function symbolNameOf(text: string): string {
  const m = /(?:class|function|def|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(text);
  return m !== null ? m[1]! : text.split(/\s+/)[0]?.slice(0, 40) ?? '(空)';
}

/**
 * §7.5 双旋钮的读取侧投影：maxReadChars 之内投正文（带覆盖图），超出只投索引。
 * maxReadChars ≤ 0 = 关闭索引化（回退点：0.4.x 头部截断行为）。
 */
export function readFeedbackPlan(
  content: string,
  maxReadChars: number,
  delivered: ReadonlyArray<{ from: number; to: number }> = [],
): { kind: 'inline'; text: string } | { kind: 'index'; text: string } {
  if (maxReadChars > 0 && content.length > maxReadChars) {
    return { kind: 'index', text: renderReadIndex(content, { delivered }) };
  }
  return { kind: 'inline', text: content };
}

/**
 * 0.5.0（Appendix B："peek 增符号定位与 span 去重"）：按符号定位取回——
 * 在句柄内容中查找顶层符号定义行（TOP_LEVEL_SYMBOL_RE），返回 ±window 行窗口。
 * 模型不再需要按行号猜测（§7.2 问题 1 的直接修复）；找不到返回 null（调用方按
 * unknown-symbol 结构化上报，不静默）。
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
