// entry/ptc-bridge.ts —— PTC 桥接（tf-code 执行通道；0.2.0 引入，0.5.2 PTC 全契约对齐）
//
// 把宿主 PTC runtime（@deepseek-ai/dsh-ptc-runtime，ctx.ptcRuntime 服务缝）
// 收编为单流协议的一个执行通道：模型在流里写 <tf-code> 程序（默认是可擦除 TS 的 async
// 函数体；实际形态由 runtime.programFormat 决定，见 §descriptor），驱动器闭合即派发到
// runtime 沙箱执行，返回值/日志句柄化进 obs 账本——中间结果不进上下文。
//
// 宿主依赖全部 duck-type（红线：零 @deepseek-ai 静态 import），形状以宿主 .d.ts 为锚：
//   dsh-ptc-runtime/lib/types/types.d.ts（PtcRunRequest / PtcRunResult / PtcRunFailure）
//   dsh-ptc-runtime/lib/types/index.d.ts（PtcRuntime 描述符与 release）
//   dsh-tool-executor-ptc/lib/index.js（宿主 run_code 的参考实现）
//
// 0.5.2 对齐要点（逐条对应宿主契约）：
//   ① `PtcRunSandbox.denied` 是 **boolean**（不是数组）——0.5.1 及以前按数组解析，导致沙箱
//      拒绝事实恒丢失；现在布尔/数组两种形状都收，布尔为权威。
//   ② 子调用 id 必须 `<parentCallId>:ptc:<n>`（n = 提交顺序），0.5.1 用工具名作 id，
//      同一程序内两次同名调用会撞 id（UI/回放无法配对）。
//   ③ `errorClass` 恒在（`ToolCallError` / `toolName`）——宿主 SDK 明文承诺
//      `catch (e) { e.toolName }`，0.5.1 只在带 state/sandbox 时才给。
//   ④ 收束纪律：run 落定后 `abort` 自铸 controller 并**排空在飞绑定**；排队中的绑定不再派发
//      （宿主语义："每次 start 恰好一次 settle"）。
//   ⑤ 通道（lane）语义：变更类/未知工具走 exclusive（独占、形成顺序屏障），只读白名单走
//      parallel；默认并发跟宿主 `maxParallelSubCalls`（10），用户可用 limits 覆盖。
//   ⑥ 配额不再预设：默认全部 0 = 不限制，交给宿主的 output-limit/timeout；墙钟缺省跟随
//      `runtime.timeout.maxMs`（宿主口径，不是插件口径）。
//   ⑦ 失败文案带沙箱事实（mode/denied/enforcement）——沙箱拒绝与代码错误分开，模型才知道
//      该改代码还是该改权限。
//
// 安全面：程序本身不做任何 IO——唯一的绑定命名空间 tools 走驱动器同一条 executeTools 通道，
// 宿主 guard/工作区策略/凭据全部生效。
//
// fail-open（红线 5）：runtime 形状不符 → 通道关闭并告警；命令级失败 → 结构化错误注入，
// 绝不静默。

/**
 * PTC 宿主真实契约（经宿主源码核验）：
 *   - PtcRunRequest 字段只有 program / stateOwner / bindings / cwd / timeoutMs /
 *     sandboxPolicy / signal；**不含 programFormat / errorClass**。
 *   - programFormat 是 runtime 实例的只读 getter（由宿主执行形态决定），consumer 读取它来
 *     选择呈现形态；插件不能通过 resolve 改变执行形态。
 *   - errorClass 属于 bindings namespace（每个 namespace 一个），不是 resolve 顶层。
 *   - release(owner) 是 runtime 的 async 方法，返回 Promise<void>，需 await。
 */
export interface PtcRuntimeLike {
  resolve(request: {
    program: string;
    bindings?: ReadonlyArray<{
      global: string;
      functions: Record<string, (args: unknown) => Promise<unknown>>;
      errorClass?: { name: string; memberNameProperty: string };
    }>;
    timeoutMs?: number | null;
    signal?: AbortSignal;
    cwd?: string;
    stateOwner?: object;
    /** 已解析的宿主 SandboxExecutionPolicy（由注入端口提供；插件不自行构造）。 */
    sandboxPolicy?: unknown;
  }): unknown;
  run(spec: unknown): Promise<PtcRunResultLike>;
  /** 程序语言（宿主契约：小写标识符；已发布后端为 'typescript'）。信息性，不做门禁之外的推断。 */
  readonly language?: string;
  /** 执行基质描述符（worker-thread / process / container）——仅诊断。 */
  readonly isolation?: string;
  /** 源形态：'function-body' | 'repl' | 'script'（决定程序里能否顶层 return）。 */
  readonly programFormat?: string;
  readonly retainsState?: boolean;
  readonly sandboxMode?: string;
  /** 运行时提供的程序用法说明（宿主把它拼进 run_code 描述；桥通道同样要呈现给模型）。 */
  readonly executionInstructions?: string;
  readonly timeout?: { defaultMs: number; maxMs: number };
  /** 宿主 PTC 的 async 释放契约；无状态 provider 也有默认实现。 */
  release?(owner: object): Promise<void>;
}

/** 运行时可观察描述符（诊断 + 呈现形态；缺省字段不编造）。 */
export interface PtcRuntimeDescriptor {
  language?: string;
  isolation?: string;
  programFormat?: 'function-body' | 'repl' | 'script';
  retainsState?: boolean;
  sandboxMode?: string;
  executionInstructions?: string;
  timeout?: { defaultMs: number; maxMs: number };
}

/** 读取运行时描述符（防御式：形状漂移不抛错，缺省即缺省）。 */
export function describePtcRuntime(runtime: PtcRuntimeLike): PtcRuntimeDescriptor {
  const out: PtcRuntimeDescriptor = {};
  if (typeof runtime.language === 'string' && runtime.language !== '') out.language = runtime.language;
  if (typeof runtime.isolation === 'string' && runtime.isolation !== '') out.isolation = runtime.isolation;
  const format = runtime.programFormat;
  if (format === 'function-body' || format === 'repl' || format === 'script') out.programFormat = format;
  if (typeof runtime.retainsState === 'boolean') out.retainsState = runtime.retainsState;
  if (typeof runtime.sandboxMode === 'string' && runtime.sandboxMode !== '') out.sandboxMode = runtime.sandboxMode;
  if (typeof runtime.executionInstructions === 'string' && runtime.executionInstructions !== '') {
    out.executionInstructions = runtime.executionInstructions;
  }
  const timeout = runtime.timeout;
  if (timeout !== undefined && timeout !== null
    && typeof timeout.defaultMs === 'number' && typeof timeout.maxMs === 'number') {
    out.timeout = { defaultMs: timeout.defaultMs, maxMs: timeout.maxMs };
  }
  return out;
}

/**
 * b 通道 PTC 对齐点：只保留宿主 resolve 真实支持的字段。
 *  - stateOwner：对象身份保留态（resolve 顶层，宿主真实支持）；
 *  - sandboxPolicy：已解析的宿主策略对象（由注入端口提供，插件不构造字符串）；
 *  - errorClass：放进 bindings namespace（宿主真实位置），memberNameProperty 必填；
 *  - format（tf-code format 属性）：不作为 resolve 字段透传——宿主由 runtime.programFormat
 *    决定形态。插件只做本地校验与 ledger 记录，不伪装成已对齐。
 */
export interface PtcResolveExtensions {
  stateOwner?: object;
  sandboxPolicy?: unknown;
  errorClass?: { name: string; memberNameProperty: string };
}

/** 镜像 PtcRunResult：无损 JSON 值 / 逐通道日志 / 正交错误 kind / 沙箱事实。 */
export interface PtcRunResultLike {
  value?: unknown;
  /** 宿主契约是 `string[]`（必填）；防御式接受 string 以防形状漂移。 */
  logs?: unknown;
  error?: { kind: string; message?: string } | null;
  /** 宿主沙箱事实：mode / denied(boolean) / enforcement。 */
  sandbox?: { mode?: unknown; denied?: unknown; enforcement?: unknown } | null;
}

/** 宿主工具调用的最小成功结果形状（用于取 canonical value）。 */
interface BindingCallOutcome {
  isError: boolean;
  /** 模型可见文本（content 展平） */
  text: string;
  /** 工具 canonical value（存在时程序直接拿到结构化 JSON，对齐宿主 PtcJsonValue 契约） */
  value?: unknown;
  /** 结构化错误身份（宿主 ToolErrorInfo：name/code/reason） */
  errorInfo?: { name: string; code: string; reason?: string };
}

/** 沙箱记账事实（只记录宿主报告的事实，不做任何推导或包装）。 */
export interface SandboxFacts {
  /** 宿主文件策略模式（read-only / workspace-write / danger-full-access）。 */
  mode?: string;
  /** 宿主是否报告"有操作被拒"（PtcRunSandbox.denied 是布尔）。 */
  denied?: boolean;
  /** 执行面：full（完全强制）| partial（Windows 档：硬链接别名/读取不受限/AppContainer 边界）。 */
  enforcement?: 'full' | 'partial';
}

/** 把沙箱事实渲染成一行（失败文案与成功回执共用；对齐宿主 "File sandbox: …" 文案）。 */
export function sandboxLine(facts: SandboxFacts | undefined): string | undefined {
  if (facts === undefined) return undefined;
  const parts: string[] = [];
  if (facts.mode !== undefined) parts.push(facts.mode);
  if (facts.enforcement !== undefined) parts.push(`enforcement: ${facts.enforcement}`);
  if (facts.denied === true) parts.push('operation denied');
  if (parts.length === 0) return undefined;
  return `File sandbox: ${parts.join('; ')}.`;
}

/** 最小工具批形状（与 loop.ts 的 ToolBatchInputLike 结构兼容，避免模块环） */
interface ToolBatchInputMinimal {
  calls: readonly { type: 'tool-call'; id: string; name: string; arguments: string }[];
  signal: AbortSignal;
  maxParallelToolCalls?: number;
  agent?: unknown;
}

interface ToolBatchResultMinimal {
  results: readonly {
    callId: string;
    result: {
      content: unknown;
      isError: boolean;
      /** 宿主 ToolExecutionSuccess.value（canonical JSON；duck-type，缺省不推断） */
      value?: unknown;
      /** 宿主 ToolExecutionFailure.error.info（结构化错误身份） */
      error?: { message?: string; info?: { name?: string; code?: string; reason?: string } };
    };
  }[];
}

/** 子调用审计事件（payload 与宿主 tool/ptc-dispatch* 同词汇，便于宿主侧映射/复算）。 */
export interface PtcDispatchEvent {
  phase: 'start' | 'settle';
  /** 根工具调用 id（有则带上；宿主事件有同名字段） */
  rootCallId?: string;
  parentCallId: string;
  subCallId: string;
  name: string;
  /** start 与 settle 都带（与宿主一致：两次事件用同一份 JSON-normalized 参数） */
  arguments?: unknown;
  isError?: boolean;
  /** settle：模型可见内容块（宿主 tool/result 词汇；缺省 = 未采集） */
  content?: unknown;
  error?: { name: string; code: string; reason?: string };
}

/** tf-code 的执行器面（驱动器经 DriverPorts.executeCode 调用）。 */
export type CodeExecutor = (input: {
  callId: string;
  /** 宿主契约：根工具调用 id（缺省 = callId）；子调用审计事件带同一字段，便于宿主侧对账。 */
  rootCallId?: string;
  /** 程序源码（形态由 runtime.programFormat 决定；默认 async 函数体） */
  code: string;
  /** 毫秒；undefined = 宿主 provider 默认 */
  timeoutMs?: number;
  /** 回合取消 signal（K4：取消直通 resolve；绑定调用共用此 signal） */
  signal: AbortSignal;
  /** 会话工作区（与 tf-write/tf-read 同一解析语义；缺省 = 宿主默认目录） */
  cwd?: string;
  /** 透传给工具批（fs 工具的 session 解析依赖，见 loop.ts W1 教训） */
  agent?: unknown;
  /** b 通道 PTC 对齐：扩展字段（宿主支持时透传）。 */
  ptc?: PtcResolveExtensions;
}) => Promise<CodeOutcome>;

export interface CodeOutcome {
  ok: boolean;
  /** 成功：result.value 的无损 JSON 序列化 */
  valueJson?: string;
  /** 失败：人类可读诊断（kind + message + 沙箱事实，≤1200 字符） */
  error?: string;
  /** 失败：结构化 kind（K3 八类原样保留 + 插件级 ptc-runtime-misuse / quota-exceeded / invalid-output） */
  kind?: string;
  /** 失败：可重试结论与处置建议（K3；注入文案的唯一来源） */
  retryable?: boolean;
  advice?: string;
  /** 捕获输出（宿主 logs 展平；成功也回传——宿主把 logs 与 value 并列为程序输出） */
  logs?: string;
  /** 捕获输出逐行（宿主契约 string[]；需要逐行渲染时用） */
  logsLines?: readonly string[];
  /** K2 沙箱事实（成功与失败都记账；宿主未报告 = 缺省，不编造） */
  sandbox?: SandboxFacts;
  /** 本次运行实际下发的 cwd（对账用；未传 = 宿主默认目录） */
  cwd?: string;
}

/** 配额三项（全部缺省 0 = 不限制；用户用 limits.codeMax* 覆盖）。 */
export interface CodeQuota {
  /** 单次 tf-code 允许的绑定（子）调用次数上限；0 = 不限制（交给宿主 maxPendingCalls）。 */
  maxSubcalls?: number;
  /** 返回值 + 日志合计的字节上限（UTF-8）；0 = 不限制（交给宿主 output-limit）。 */
  maxOutputBytes?: number;
  /** 墙钟上限（毫秒）；0 = 跟随 runtime.timeout.maxMs，仍未定义则不限制。 */
  maxWallMs?: number;
}

/**
 * 0.5.2：默认全部不限制。理由与 limits 一致——任何默认配额都会把宿主本可跑完的程序判死
 * （0.5.1 的 64 次 / 256KiB / 300s 比宿主 128 次 / 64MiB / 600s 严一到两个数量级）。
 */
export const DEFAULT_CODE_QUOTA: Required<CodeQuota> = {
  maxSubcalls: 0,
  maxOutputBytes: 0,
  maxWallMs: 0,
};

/** 宿主 PTC 默认并发（`maxParallelSubCalls` 缺省 10）；只在用户未定义时使用。 */
export const HOST_DEFAULT_MAX_PARALLEL_BINDINGS = 10;

/**
 * K3 失败分类（八类 kind + 插件级三类）：可重试结论与处置建议的唯一来源。
 * 拒绝与代码错误分开：沙箱拒绝不是"代码写错"，不引导改代码。
 */
const CODE_FAILURE_ADVICE: Readonly<Record<string, { retryable: boolean; advice: string }>> = {
  exception: { retryable: true, advice: '按诊断修复程序体（语法/绑定参数），换新 id 重发。' },
  timeout: { retryable: true, advice: '减小程序规模或提高 timeout 属性（毫秒）后换新 id 重发。' },
  abort: { retryable: false, advice: '本回合被取消：不要重试本程序；如需继续请等待新指令。' },
  'worker-exit': { retryable: false, advice: '工作进程异常退出：先确认程序是否已产生文件写入（tf-read/台账），再决定继续或放弃；不要直接重跑。' },
  'invalid-output': { retryable: false, advice: '程序返回了无效输出：原样重跑无用，请修改返回值结构后换新 id 重发。' },
  'output-limit': { retryable: true, advice: '返回值/日志超过上限：减少返回数据量（只 return 摘要/样本），换新 id 重发。' },
  protocol: { retryable: false, advice: '程序违反 runtime 协议（如保留了保留成员）：修改程序体后换新 id 重发。' },
  'sandbox-unavailable': { retryable: false, advice: '沙箱环境不可用（非代码错误）：不要修改代码重试；改道 tf-bash/tf-write 或报告环境问题。' },
  'ptc-runtime-misuse': { retryable: false, advice: 'runtime 通道调用失败（装配层问题）：不要重试本程序；请报告排障信息。' },
  'invalid-attribute': { retryable: true, advice: '属性值不合法（如 timeout=0）：修正属性后换新 id 重发。' },
  'quota-exceeded': { retryable: false, advice: '插件配额硬终止：减少子调用/输出量后换新 id 重发（诊断里有超限项）。' },
};

/** K3：kind → 可重试结论与建议；未知 kind 保守判不可重试（不引导盲目重试）。 */
export function classifyCodeFailure(kind: string): { retryable: boolean; advice: string } {
  return CODE_FAILURE_ADVICE[kind] ?? { retryable: false, advice: '未知失败类型：请按诊断处理，不要盲目重试。' };
}

/** 形状校验：resolve + run 双函数在位才算 PtcRuntime（防止同名服务形状漂移时误接）。 */
export function looksLikePtcRuntime(candidate: unknown): candidate is PtcRuntimeLike {
  if (candidate === null || typeof candidate !== 'object') return false;
  const c = candidate as { resolve?: unknown; run?: unknown };
  return typeof c.resolve === 'function' && typeof c.run === 'function';
}

/** logs 通道展平：string 原样 / 数组逐项递归拼接 / 对象 JSON（形状防御式）。 */
function flattenLogs(logs: unknown, depth = 0): string | undefined {
  if (logs === undefined || logs === null) return undefined;
  if (typeof logs === 'string') return logs === '' ? undefined : logs;
  if (depth >= 3) return JSON.stringify(logs);
  if (Array.isArray(logs)) {
    const parts = logs.map((item) => flattenLogs(item, depth + 1)).filter((s): s is string => s !== undefined);
    return parts.length === 0 ? undefined : parts.join('\n');
  }
  return JSON.stringify(logs);
}

/** logs 逐行归一（宿主契约 string[]；非字符串项 JSON 化，保留证据）。 */
function toLogLines(logs: unknown): string[] | undefined {
  if (logs === undefined || logs === null) return undefined;
  const arr = Array.isArray(logs) ? logs : [logs];
  const lines: string[] = [];
  for (const item of arr) {
    if (typeof item === 'string') lines.push(item);
    else if (item === undefined || item === null) continue;
    else lines.push(JSON.stringify(item));
  }
  return lines.length === 0 ? undefined : lines;
}

/**
 * 沙箱事实提取：`denied` 宿主是布尔（0.5.2 修正）；同时容忍旧数组形状（逐项计入布尔）。
 * 缺席字段不编造（防御式，形状漂移不炸）。
 */
function extractSandboxFacts(sandbox: PtcRunResultLike['sandbox']): SandboxFacts | undefined {
  if (sandbox === undefined || sandbox === null || typeof sandbox !== 'object') return undefined;
  const s = sandbox as { mode?: unknown; denied?: unknown; enforcement?: unknown };
  const facts: SandboxFacts = {};
  if (typeof s.mode === 'string') facts.mode = s.mode;
  if (typeof s.denied === 'boolean') facts.denied = s.denied;
  else if (Array.isArray(s.denied)) facts.denied = s.denied.length > 0;
  if (s.enforcement === 'full' || s.enforcement === 'partial') facts.enforcement = s.enforcement;
  return Object.keys(facts).length > 0 ? facts : undefined;
}

/** 错误诊断：kind + message + 沙箱事实（沙箱拒绝与代码错误分开）。 */
function describeRunError(error: NonNullable<PtcRunResultLike['error']>, sandbox?: SandboxFacts): string {
  const message = typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message
    : JSON.stringify(error);
  const sandboxText = sandboxLine(sandbox);
  return `${error.kind}: ${message}${sandboxText === undefined ? '' : `\n${sandboxText}`}`.slice(0, 1200);
}

/** K5 配额状态（单次 tf-code 执行一个实例）。 */
class QuotaTracker {
  readonly #limits: Required<CodeQuota>;
  #subcalls = 0;
  #exceeded: string | null = null;
  constructor(limits: CodeQuota | undefined, hostMaxWallMs?: number) {
    const merged = { ...DEFAULT_CODE_QUOTA, ...(limits ?? {}) };
    if (merged.maxWallMs <= 0 && hostMaxWallMs !== undefined && hostMaxWallMs > 0) merged.maxWallMs = hostMaxWallMs;
    this.#limits = merged;
  }
  /** 绑定调用记账：超限返回结构化原因（调用方以此抛错，程序可捕获但标志已置位）。 */
  onSubcall(): string | null {
    if (this.#exceeded !== null) return this.#exceeded;
    this.#subcalls += 1;
    if (this.#limits.maxSubcalls > 0 && this.#subcalls > this.#limits.maxSubcalls) {
      this.#exceeded = `subcalls>${this.#limits.maxSubcalls}`;
      return this.#exceeded;
    }
    return null;
  }
  /** 输出字节判定：超限返回结构化原因。 */
  checkOutput(bytes: number): string | null {
    if (this.#exceeded !== null) return this.#exceeded;
    if (this.#limits.maxOutputBytes > 0 && bytes > this.#limits.maxOutputBytes) {
      this.#exceeded = `output-bytes ${bytes}>${this.#limits.maxOutputBytes}`;
      return this.#exceeded;
    }
    return null;
  }
  /** 墙钟判定：超限返回结构化原因。 */
  checkWall(elapsedMs: number): string | null {
    if (this.#exceeded !== null) return this.#exceeded;
    if (this.#limits.maxWallMs > 0 && elapsedMs > this.#limits.maxWallMs) {
      this.#exceeded = `wall-ms ${Math.round(elapsedMs)}>${this.#limits.maxWallMs}`;
      return this.#exceeded;
    }
    return null;
  }
  get exceeded(): string | null {
    return this.#exceeded;
  }
  get wallLimit(): number {
    return this.#limits.maxWallMs;
  }
}

/** 单条工具绑定调用：走宿主同一条 executeTools 通道；isError → 抛（对齐 PTC 的 ToolCallError 语义，
 *  程序内可 try/catch 继续或让程序失败 resolve 到 result.error）。 */
async function runOneBinding(
  deps: { executeTools(input: ToolBatchInputMinimal): Promise<ToolBatchResultMinimal> },
  name: string,
  args: unknown,
  subCallId: string,
  signal: AbortSignal,
  agent: unknown,
): Promise<BindingCallOutcome> {
  const result = await deps.executeTools({
    calls: [{ type: 'tool-call', id: subCallId, name, arguments: JSON.stringify(args ?? {}) }],
    signal,
    maxParallelToolCalls: 1,
    ...(agent === undefined ? {} : { agent }),
  });
  const first = result.results[0];
  const content = first?.result?.content;
  const text = content === undefined || content === null
    ? ''
    : typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((block) => (typeof block === 'object' && block !== null && 'text' in (block as { text?: unknown }) && typeof (block as { text: unknown }).text === 'string' ? (block as { text: string }).text : JSON.stringify(block))).join('\n')
        : String(content);
  const info = first?.result?.error?.info;
  const errorInfo = info !== undefined && typeof info === 'object'
    ? {
        name: typeof info.name === 'string' ? info.name : 'ToolCallError',
        code: typeof info.code === 'string' ? info.code : 'TOOL_ERROR',
        ...(typeof info.reason === 'string' ? { reason: info.reason } : {}),
      }
    : undefined;
  if (first?.result?.isError === true) {
    const error = new Error(text === '' ? `${name} failed` : text) as Error & { ptcInfo?: unknown };
    if (errorInfo !== undefined) error.ptcInfo = errorInfo;
    throw error;
  }
  return {
    isError: false,
    text,
    ...(first?.result?.value === undefined ? {} : { value: first.result.value }),
    ...(errorInfo === undefined ? {} : { errorInfo }),
  };
}

/** 绑定通道：只读工具走并行，其余（含未知）走独占——对齐宿主 fail-closed 的并发分类。 */
const PARALLEL_SAFE_BINDINGS: ReadonlySet<string> = new Set([
  'read', 'grep', 'glob', 'read_image', 'web_search', 'web_fetch', 'list_files', 'pwd',
  'job_list', 'job_output', 'recall', 'todo_write', 'skill',
]);

/** 默认分类器（宿主未提供执行器内省时的保守白名单）。 */
export function defaultBindingLane(name: string): 'parallel' | 'exclusive' {
  return PARALLEL_SAFE_BINDINGS.has(name) ? 'parallel' : 'exclusive';
}

/**
 * 构造 tf-code 执行器：resolve（校验 + 默认值）→ run（沙箱执行）→ CodeOutcome。
 * 绑定命名空间固定为 tools（固定三绑定 + 冻结工具面），让程序具备完整工具能力，
 * 且全部走宿主管线。
 */
export function createCodeExecutor(
  runtime: PtcRuntimeLike,
  deps: {
    executeTools(input: ToolBatchInputMinimal): Promise<ToolBatchResultMinimal>;
    /** K5 配额（缺省全 0 = 不限制；墙钟缺省跟随宿主 runtime.timeout.maxMs）。 */
    quota?: CodeQuota;
    /** v0.4.0（P5）：会话冻结工具面的工具名 getter——绑定按面生成（与 ptc 的
     *  "SDK 由 toolSet 生成"同构）。write/read/pwsh 恒在（§8.4：旧程序体只增不减）；
     *  缺省 = 仅固定三绑定（0.3.x 行为回退点）。 */
    surfaceToolNames?: () => readonly string[];
    /** 绑定并发上限（对齐宿主 maxParallelSubCalls；缺省 10 = 跟随宿主调度默认）。
     *  支持 getter：用户可在运行期用 limits.maxParallelBindings 调整；0 = 不限制。 */
    maxParallelBindings?: number | (() => number);
  /** 通道分类器（对齐宿主 executionMode）：缺省 = 只读白名单并行，其余独占。
   *  第二个参数是本次调用的原始参数（宿主 `isConcurrencySafe(args)` 需要它），
   *  第三个是 agent（按作用域解析工具定义需要它）。 */
    classifyBinding?: (name: string, args?: unknown, agent?: unknown) => 'parallel' | 'exclusive';
    /** 子调用审计事件出口（宿主可映射到 tool/ptc-dispatch-start / tool/ptc-dispatch）。
     *  第二参数 = 本次运行的 agent 对象——多 agent 场景由调用方按 agent 路由账本。 */
    onDispatch?: (event: PtcDispatchEvent, agent?: unknown) => void;
    /** 运行时可观察描述符的消费方（协议段呈现 / 诊断台账）；构造时读取一次。 */
    onDescriptor?: (descriptor: PtcRuntimeDescriptor) => void;
  },
): CodeExecutor {
  const descriptor = describePtcRuntime(runtime);
  deps.onDescriptor?.(descriptor);
  const hostMaxWallMs = descriptor.timeout?.maxMs;
  const classify = deps.classifyBinding ?? defaultBindingLane;
  return async (input) => {
    const quota = new QuotaTracker(deps.quota, hostMaxWallMs);
    const startedAt = Date.now();
    // K4：自铸 controller —— 回合 signal 触发时同步 abort；墙钟超限也走同一通道。
    const controller = new AbortController();
    const runOver = (): boolean => controller.signal.aborted;
    const onOuterAbort = (): void => {
      controller.abort(input.signal.reason instanceof Error ? input.signal.reason : new Error('tf-code aborted by turn signal'));
    };
    if (input.signal.aborted) onOuterAbort();
    else input.signal.addEventListener('abort', onOuterAbort, { once: true });
    let wallTimer: ReturnType<typeof setTimeout> | undefined;
    if (quota.wallLimit > 0) {
      wallTimer = setTimeout(() => {
        controller.abort(new Error(`tf-code wall clock beyond ${quota.wallLimit}ms (quota)`));
      }, quota.wallLimit);
    }
    const clearWall = (): void => {
      if (wallTimer !== undefined) clearTimeout(wallTimer);
    };

    // ---- 通道调度（宿主同构）：parallel 受并发上限约束；exclusive 需 inFlight=0 且独占期间不放行 ----
    const configuredParallel = typeof deps.maxParallelBindings === 'function'
      ? deps.maxParallelBindings()
      : (deps.maxParallelBindings ?? HOST_DEFAULT_MAX_PARALLEL_BINDINGS);
    const maxParallel = configuredParallel > 0 ? configuredParallel : Number.POSITIVE_INFINITY;
    let inFlight = 0;
    let exclusiveActive = false;
    let dispatchSeq = 0;
    const inFlightPromises = new Set<Promise<unknown>>();
    type Waiter = { lane: 'parallel' | 'exclusive'; resume: () => void; reject: (error: Error) => void };
    const waiters: Waiter[] = [];
    const pump = (): void => {
      for (let i = 0; i < waiters.length;) {
        const waiter = waiters[i]!;
        const canRun = waiter.lane === 'exclusive'
          ? !exclusiveActive && inFlight === 0
          : !exclusiveActive && inFlight < maxParallel;
        if (!canRun) { i += 1; continue; }
        waiters.splice(i, 1);
        waiter.resume();
      }
    };
    const acquire = (lane: 'parallel' | 'exclusive'): Promise<void> => {
      const canRun = lane === 'exclusive'
        ? !exclusiveActive && inFlight === 0
        : !exclusiveActive && inFlight < maxParallel;
      if (canRun) {
        if (lane === 'exclusive') exclusiveActive = true;
        inFlight += 1;
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        waiters.push({
          lane,
          resume: () => {
            if (lane === 'exclusive') exclusiveActive = true;
            inFlight += 1;
            resolve();
          },
          reject,
        });
      });
    };
    const release = (lane: 'parallel' | 'exclusive'): void => {
      inFlight -= 1;
      if (lane === 'exclusive') exclusiveActive = false;
      pump();
    };
    /** 收束期排空：abort 后让排队中的绑定失败，等在飞绑定全部结算（宿主 drainDispatches 同构）。 */
    const drain = async (): Promise<void> => {
      while (waiters.length > 0) {
        const waiter = waiters.shift()!;
        waiter.reject(new Error('tf-code run is over; binding call abandoned'));
      }
      if (inFlightPromises.size > 0) await Promise.allSettled([...inFlightPromises]);
    };

    // 绑定集 = 固定三绑定（旧程序体不破，§8.4）+ 冻结工具面（P5：与 ptc 的"SDK 由 toolSet
    // 生成"同构；面内新增工具按名挂载，面缺席 = 0.3.x 行为）。
    const surfaceNames = deps.surfaceToolNames?.() ?? [];
    const fixedNames = ['write', 'read', 'pwsh'];
    const bindingNames = [...fixedNames, ...surfaceNames.filter((n) => !fixedNames.includes(n))];
    // errorClass 的真实位置是 bindings namespace（宿主 ptc 同一位置），memberNameProperty 必填。
    // 0.5.2：恒在——宿主 SDK 承诺 `catch (e) { e.toolName }`，条件化会让裸程序失去该契约。
    const extForBindings = input.ptc ?? {};
    const errorClass = extForBindings.errorClass ?? { name: 'ToolCallError', memberNameProperty: 'toolName' };

    const runBinding = (name: string, args: unknown): Promise<unknown> => {
      const over = quota.onSubcall();
      if (over !== null) return Promise.reject(new Error(`quota-exceeded: ${over}`));
      if (runOver()) return Promise.reject(new Error('tf-code run is over; binding call not dispatched'));
      const lane = classify(name, args, input.agent);
      const subCallId = `${input.callId}:ptc:${++dispatchSeq}`;
      const payload = args === undefined ? {} : (JSON.parse(JSON.stringify(args)) as unknown);
      const flight = (async () => {
        await acquire(lane);        // 排队期间 run 可能已收束：不再派发，也不发 start（宿主"每次 start 恰好一次 settle"）。
        if (runOver()) {
          release(lane);
          throw new Error('tf-code run is over; binding call abandoned');
        }
        deps.onDispatch?.({ phase: 'start', rootCallId: input.rootCallId, parentCallId: input.callId, subCallId, name, arguments: payload }, input.agent);
        try {
          const outcome = await runOneBinding(deps, name, args, subCallId, controller.signal, input.agent);
          deps.onDispatch?.({
            phase: 'settle', rootCallId: input.rootCallId, parentCallId: input.callId, subCallId, name, arguments: payload,
            isError: false,
            content: [{ type: 'text', text: outcome.text }],
          });
          // 宿主契约：绑定解析值必须是 lossless JSON。有 canonical value 就用它，
          // 否则退回文本（旧行为：程序把工具输出当字符串处理）。
          return outcome.value !== undefined ? outcome.value : outcome.text;
        } catch (error) {
          const info = (error as { ptcInfo?: { name: string; code: string; reason?: string } }).ptcInfo;
          deps.onDispatch?.({
            phase: 'settle', rootCallId: input.rootCallId, parentCallId: input.callId, subCallId, name, arguments: payload,
            isError: true,
            content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
            ...(info === undefined ? {} : { error: info }),
          });
          throw error;
        } finally {
          release(lane);
        }
      })();
      const tracked: Promise<unknown> = flight.finally(() => { inFlightPromises.delete(tracked); });
      inFlightPromises.add(tracked);
      return tracked;
    };

    // 宿主同构：namespace 的 functions 必须是 **null-prototype** 自有属性容器。
    // 宿主 ptc.ts 明文要求：注册名 `__proto__` / `constructor` 也要成为普通自有键——
    // 普通对象字面量赋值会命中原型 setter，静默丢掉该绑定。
    const functions: Record<string, (args: unknown) => Promise<unknown>> = Object.create(null);
    for (const name of bindingNames) {
      Object.defineProperty(functions, name, {
        enumerable: true,
        configurable: true,
        writable: true,
        value: (args: unknown) => runBinding(name, args),
      });
    }
    const bindings = [
      {
        global: 'tools',
        functions,
        errorClass,
      },
    ];

    const finishFailure = (kind: string, message: string, logs?: string, sandbox?: SandboxFacts): CodeOutcome => {
      const cls = classifyCodeFailure(kind);
      const sandboxText = sandboxLine(sandbox);
      return {
        ok: false,
        kind,
        error: `${kind}: ${message}${sandboxText === undefined ? '' : `\n${sandboxText}`}`.slice(0, 1200),
        retryable: cls.retryable,
        advice: cls.advice,
        ...(logs === undefined ? {} : { logs }),
        ...(sandbox === undefined ? {} : { sandbox }),
        cwd: input.cwd,
      };
    };

    try {
      const ext = input.ptc ?? {};
      const spec = runtime.resolve({
        program: input.code,
        bindings,
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        signal: controller.signal,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(ext.stateOwner === undefined ? {} : { stateOwner: ext.stateOwner }),
        ...(ext.sandboxPolicy === undefined ? {} : { sandboxPolicy: ext.sandboxPolicy }),
        // programFormat 不在此处：宿主由 runtime.programFormat getter 决定执行形态。
        // errorClass 已在 bindings namespace 中传递，不在 resolve 顶层。
      });
      let result: PtcRunResultLike;
      try {
        result = await runtime.run(spec);
      } finally {
        // 宿主同构收束：先 abort（停止追问），再排空在飞绑定——否则 `void tools.write()` 会在
        // 回执发出之后继续落盘，破坏账本时序。
        controller.abort(new Error('tf-code settled'));
        await drain();
        clearWall();
        input.signal.removeEventListener('abort', onOuterAbort);
      }
      const logLines = toLogLines(result.logs);
      const logs = flattenLogs(result.logs);
      const sandbox = extractSandboxFacts(result.sandbox);
      // 回合取消（K4）：abort 与 timeout 分账——kind 取宿主报告值，没有则按 abort 归账。
      if (input.signal.aborted && (result.error === undefined || result.error === null)) {
        return { ...finishFailure('abort', '回合在 tf-code 执行期间被取消', logs, sandbox), logsLines: logLines ?? [] };
      }
      // K5 墙钟（插件侧硬终止，与宿主 timeout 独立记账）。
      const wallOver = quota.checkWall(Date.now() - startedAt);
      if (wallOver !== null) {
        return { ...finishFailure('quota-exceeded', `wall clock: ${wallOver}`, logs, sandbox), logsLines: logLines ?? [] };
      }
      if (result.error !== undefined && result.error !== null) {
        // K3：八类 kind 原样保留（宿主报告什么就是什么），分类结论由 classifyCodeFailure 给出。
        const kind = typeof result.error.kind === 'string' && result.error.kind !== '' ? result.error.kind : 'exception';
        const cls = classifyCodeFailure(kind);
        return {
          ok: false,
          kind,
          error: describeRunError(result.error, sandbox),
          retryable: cls.retryable,
          advice: cls.advice,
          ...(logs === undefined ? {} : { logs }),
          ...(logLines === undefined ? {} : { logsLines: logLines }),
          ...(sandbox === undefined ? {} : { sandbox }),
          cwd: input.cwd,
        };
      }
      // value = 无损 JSON（seam 契约）；undefined 视为程序无返回值（不注入 "undefined" 字符串）
      const valueJson = result.value === undefined ? undefined : JSON.stringify(result.value) ?? 'undefined';
      // K5 输出字节（值 + 日志合计）。失败分支同样计入（此前只在成功分支算，等于漏账）。
      const bytes = (valueJson === undefined ? 0 : Buffer.byteLength(valueJson, 'utf8'))
        + (logs === undefined ? 0 : Buffer.byteLength(logs, 'utf8'));
      const outOver = quota.checkOutput(bytes);
      if (outOver !== null) {
        return { ...finishFailure('quota-exceeded', `output bytes: ${outOver}`, logs, sandbox), logsLines: logLines ?? [] };
      }
      if (quota.exceeded !== null) {
        // 程序内部吞掉了配额错误也照样结构化终止：配额是硬终止，不是提示。
        return { ...finishFailure('quota-exceeded', `binding calls: ${quota.exceeded}`, logs, sandbox), logsLines: logLines ?? [] };
      }
      return {
        ok: true,
        ...(valueJson === undefined ? {} : { valueJson }),
        ...(logs === undefined ? {} : { logs }),
        ...(logLines === undefined ? {} : { logsLines: logLines }),
        ...(sandbox === undefined ? {} : { sandbox }),
        cwd: input.cwd,
      };
    } catch (error) {
      clearWall();
      input.signal.removeEventListener('abort', onOuterAbort);
      controller.abort(new Error('tf-code settled'));
      await drain();
      // run() reject = 调用方误用（形状不符/已 dispose 等），如实失败不静默。
      // 回合取消导致的 reject 归 abort 账（K4：取消与误用分账）。
      if (input.signal.aborted) {
        return finishFailure('abort', 'tf-code 被取消（回合 signal 或配额墙钟触发）');
      }
      // 参数类错误（timeout 非正 / cwd 非绝对）是模型可自修的：归 invalid-attribute，
      // 不冒充"装配层问题"（0.5.1 把 timeout="0" 误判为 ptc-runtime-misuse）。
      const message = error instanceof Error ? error.message : String(error);
      if (/timeoutMs|cwd must be|positive finite/i.test(message)) {
        return finishFailure('invalid-attribute', message);
      }
      return finishFailure('ptc-runtime-misuse', message);
    }
  };
}
