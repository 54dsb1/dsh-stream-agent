// entry/ptc-bridge.ts —— PTC 桥接（tf-code 执行通道；0.2.0 引入，0.3.0 收口 K2–K5）
//
// 把宿主 PTC runtime（@deepseek-ai/dsh-ptc-runtime，ctx.ptcRuntime 服务缝）
// 收编为单流协议的一个执行通道：模型在流里写 <tf-code> 程序（可擦除 TS 的 async 函数体），
// 驱动器闭合即派发到 runtime 沙箱执行，返回值/日志句柄化进 obs 账本——中间结果不进上下文。
//
// 宿主依赖全部 duck-type（红线：零 @deepseek-ai 静态 import），形状以官方 README 为锚：
//   const spec = ctx.ptcRuntime.resolve({ program, bindings: [{ global, functions }], timeoutMs?, signal?, cwd? })
//   const result = await ctx.ptcRuntime.run(spec)   // result.value / result.logs / result.error / result.sandbox
// 程序失败 resolve 在 result.error（kind: exception/timeout/abort/worker-exit/invalid-output/
// output-limit/protocol/sandbox-unavailable——K3 八类保真，逐类给出可重试结论）；
// run() reject 只表示调用方误用。
//
// 0.3.0 收口（beta.2）：
//   K2 策略透传与沙箱记账 —— resolve 透传会话 cwd（与 tf-write/tf-read 同一解析语义）；
//       result.sandbox 的 mode/denied/enforcement 逐次记账，enforcement=partial 显式标注，
//       不宣称隔离。沙箱不可用（sandbox-unavailable）与程序失败分开记账。
//   K3 失败分类保真 —— 八类 kind 原样保留；classifyCodeFailure 给出可重试/不可重试结论；
//       拒绝（沙箱/误用）与代码错误分开，不引导模型改代码重试环境问题。
//   K4 取消链路 —— 回合 signal 直通 resolve；配额超限或回合取消时本桥自铸 controller
//       同步 abort，绑定调用不再派发；abort（用户取消）与 timeout 分账。
//   K5 配额 —— 子调用次数 / 输出字节 / 墙钟三项硬限制；超限结构化终止
//       （kind: quota-exceeded），不靠提示。
//
// 安全面：程序本身不做任何 IO——唯一的绑定命名空间 tools（write/read/pwsh/edit）走驱动器
// 同一条 executeTools 通道，宿主 guard/工作区策略/凭据全部生效。
//
// fail-open（红线 5）：runtime 形状不符 → 通道关闭并告警；命令级失败 → 结构化错误注入，
// 绝不静默。

/** 镜像 dsh-ptc-runtime 的 PtcRuntime 服务面（resolve + run 两段式；timeout 描述符可选）。 */
export interface PtcRuntimeLike {
  resolve(request: {
    program: string;
    bindings?: ReadonlyArray<{ global: string; functions: Record<string, (args: unknown) => Promise<unknown>> }>;
    timeoutMs?: number | null;
    signal?: AbortSignal;
    cwd?: string;
  }): unknown;
  run(spec: unknown): Promise<PtcRunResultLike>;
  /** 诊断描述符（官方契约：'typescript'）；仅用于日志与校验，不做语义分支 */
  language?: string;
  readonly timeout?: { defaultMs: number; maxMs: number };
}

/** 镜像 PtcRunResult：无损 JSON 值 / 逐通道日志 / 正交错误 kind / 沙箱事实（K2）。 */
export interface PtcRunResultLike {
  value?: unknown;
  logs?: unknown;
  error?: { kind: string; message?: string } | null;
  /** 宿主沙箱事实（官方契约字段；防御式读取，缺席 = 不可得，不编造）。 */
  sandbox?: { mode?: unknown; denied?: unknown; enforcement?: unknown } | null;
}

/** K2 沙箱记账事实（只记录宿主报告的事实，不做任何推导或包装）。 */
export interface SandboxFacts {
  /** 宿主文件策略模式（read-only / workspace-write / danger-full-access / partial 报告）。 */
  mode?: string;
  /** 被拒绝的路径/操作列表（宿主报告；无则省略）。 */
  denied?: string[];
  /** 执行面：full（完全强制）| partial（Windows 档：硬链接别名/读取不受限/AppContainer 边界）。 */
  enforcement?: 'full' | 'partial';
}

/** 最小工具批形状（与 loop.ts 的 ToolBatchInputLike 结构兼容，避免模块环） */
interface ToolBatchInputMinimal {
  calls: readonly { type: 'tool-call'; id: string; name: string; arguments: string }[];
  signal: AbortSignal;
  maxParallelToolCalls?: number;
  agent?: unknown;
}

interface ToolBatchResultMinimal {
  results: readonly { callId: string; result: { content: unknown; isError: boolean } }[];
}

/** tf-code 的执行器面（驱动器经 DriverPorts.executeCode 调用）。 */
export type CodeExecutor = (input: {
  callId: string;
  /** 可擦除 TS 的 async 函数体（顶层 await / return 可用） */
  code: string;
  /** 毫秒；undefined = 宿主 provider 默认 */
  timeoutMs?: number;
  /** 回合取消 signal（K4：取消直通 resolve；绑定调用共用此 signal） */
  signal: AbortSignal;
  /** 会话工作区（K2：与 tf-write/tf-read 同一解析语义；缺省 = 宿主默认目录） */
  cwd?: string;
  /** 透传给工具批（fs 工具的 session 解析依赖，见 loop.ts W1 教训） */
  agent?: unknown;
}) => Promise<CodeOutcome>;

export interface CodeOutcome {
  ok: boolean;
  /** 成功：result.value 的无损 JSON 序列化 */
  valueJson?: string;
  /** 失败：人类可读诊断（kind + message，≤500 字符） */
  error?: string;
  /** 失败：结构化 kind（K3 八类原样保留 + 插件级 ptc-runtime-misuse / quota-exceeded） */
  kind?: string;
  /** 失败：可重试结论与处置建议（K3；注入文案的唯一来源） */
  retryable?: boolean;
  advice?: string;
  logs?: string;
  /** K2 沙箱事实（成功与失败都记账；宿主未报告 = 缺省，不编造） */
  sandbox?: SandboxFacts;
  /** K2：本次运行实际下发的 cwd（对账用；未传 = 宿主默认目录） */
  cwd?: string;
}

/** K5 配额三项硬限制（全部缺省可覆盖；0/负数 = 关闭该项并记账）。 */
export interface CodeQuota {
  /** 单次 tf-code 允许的绑定（子）调用次数上限；超限后不再派发绑定调用。 */
  maxSubcalls?: number;
  /** 返回值 + 日志合计的字节上限（UTF-8）；超限结构化终止。 */
  maxOutputBytes?: number;
  /** 墙钟上限（毫秒，插件侧硬终止；与宿主 timeoutMs 独立记账）。 */
  maxWallMs?: number;
}

export const DEFAULT_CODE_QUOTA: Required<CodeQuota> = {
  maxSubcalls: 64,
  maxOutputBytes: 256 * 1024,
  maxWallMs: 300_000,
};

/**
 * K3 失败分类（八类 kind + 插件级两类）：可重试结论与处置建议的唯一来源。
 * - exception：有明确修复信息时修改程序可重试（换新 id）；
 * - timeout：调整预算或减量后可重试；
 * - abort：用户取消——不可重试，改道或放弃；
 * - worker-exit：默认不自动重试——先判定程序是否已产生写入，再决定继续或放弃；
 * - invalid-output：原样重跑无用；
 * - output-limit：需减量（返回值太大）；
 * - protocol：需修程序（协议层错误）；
 * - sandbox-unavailable：环境问题——不得重试，不得改代码；
 * - ptc-runtime-misuse：调用方误用（插件/宿主装配层问题）；
 * - quota-exceeded：插件配额硬终止——减量后可重试。
 * 拒绝与代码错误分开：沙箱拒绝不是"代码写错"，不引导改代码。
 */
const CODE_FAILURE_ADVICE: Readonly<Record<string, { retryable: boolean; advice: string }>> = {
  exception: { retryable: true, advice: '按诊断修复程序体（语法/绑定参数），换新 id 重发。' },
  timeout: { retryable: true, advice: '减小程序规模或提高 timeout 属性（毫秒）后换新 id 重发。' },
  abort: { retryable: false, advice: '用户取消了本回合：不要重试本程序；如需继续请等待新指令。' },
  'worker-exit': { retryable: false, advice: '工作进程异常退出：先确认程序是否已产生文件写入（tf-read/台账），再决定继续或放弃；不要直接重跑。' },
  'invalid-output': { retryable: false, advice: '程序返回了无效输出：原样重跑无用，请修改返回值结构后换新 id 重发。' },
  'output-limit': { retryable: false, advice: '返回值超过上限：减少返回数据量（只 return 摘要/样本），换新 id 重发。' },
  protocol: { retryable: false, advice: '程序违反 runtime 协议（如保留了保留成员）：修改程序体后换新 id 重发。' },
  'sandbox-unavailable': { retryable: false, advice: '沙箱环境不可用（非代码错误）：不要修改代码重试；改道 tf-bash/tf-write 或报告环境问题。' },
  'ptc-runtime-misuse': { retryable: false, advice: 'runtime 通道调用失败（装配层问题）：不要重试本程序；请报告排障信息。' },
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

/** logs 通道展平：string 原样 / 数组逐项递归拼接 / 对象 JSON（形状以官方 README 为锚，防御式）。 */
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

/** K2 沙箱事实提取：只透传宿主报告的字段；缺席字段不编造（防御式，形状漂移不炸）。 */
function extractSandboxFacts(sandbox: PtcRunResultLike['sandbox']): SandboxFacts | undefined {
  if (sandbox === undefined || sandbox === null || typeof sandbox !== 'object') return undefined;
  const s = sandbox as { mode?: unknown; denied?: unknown; enforcement?: unknown };
  const facts: SandboxFacts = {};
  if (typeof s.mode === 'string') facts.mode = s.mode;
  if (Array.isArray(s.denied)) facts.denied = s.denied.map((d) => (typeof d === 'string' ? d : JSON.stringify(d)));
  if (s.enforcement === 'full' || s.enforcement === 'partial') facts.enforcement = s.enforcement;
  return Object.keys(facts).length > 0 ? facts : undefined;
}

/** 错误诊断：kind + message（message 字段防御式提取）。 */
function describeRunError(error: NonNullable<PtcRunResultLike['error']>): string {
  const message = typeof (error as { message?: unknown }).message === 'string' ? (error as { message: string }).message : JSON.stringify(error);
  return `${error.kind}: ${message}`.slice(0, 500);
}

/** K5 配额状态（单次 tf-code 执行一个实例）。 */
class QuotaTracker {
  readonly #limits: Required<CodeQuota>;
  #subcalls = 0;
  #exceeded: string | null = null;
  constructor(limits: CodeQuota | undefined) {
    this.#limits = { ...DEFAULT_CODE_QUOTA, ...(limits ?? {}) };
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
}

/** 单条工具绑定调用：走宿主同一条 executeTools 通道；isError → 抛（对齐 PTC 的 ToolCallError 语义，
 *  程序内可 try/catch 继续或让程序失败 resolve 到 result.error）。 */
async function runOneBinding(
  deps: { executeTools(input: ToolBatchInputMinimal): Promise<ToolBatchResultMinimal> },
  name: string,
  args: unknown,
  callId: string,
  signal: AbortSignal,
  agent: unknown,
): Promise<unknown> {
  const result = await deps.executeTools({
    calls: [{ type: 'tool-call', id: `${callId}:ptc:${name}`, name, arguments: JSON.stringify(args ?? {}) }],
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
  if (first?.result?.isError === true) throw new Error(text === '' ? `${name} failed` : text);
  return text;
}

/**
 * 构造 tf-code 执行器：resolve（校验 + 默认值）→ run（沙箱执行）→ CodeOutcome。
 * 绑定命名空间固定为 tools（write/read/pwsh——与 tf-write/tf-read/tf-bash 同映射），
 * 让程序具备文件与命令能力，且全部走宿主管线。
 *
 * 0.3.0（K2/K4/K5）：
 * - cwd 透传 resolve（会话工作区，与 tf-write/tf-read 同一解析语义）；
 * - 回合 signal 直通 resolve；配额/取消通过自铸 controller 同步传导；
 * - 配额三项硬限制（子调用 / 输出字节 / 墙钟），超限结构化终止（kind: quota-exceeded）；
 * - 沙箱事实逐次记账（成功与失败都带）。
 */
export function createCodeExecutor(
  runtime: PtcRuntimeLike,
  deps: {
    executeTools(input: ToolBatchInputMinimal): Promise<ToolBatchResultMinimal>;
    /** K5 配额（缺省 DEFAULT_CODE_QUOTA；显式 0/负数 = 关闭该项）。 */
    quota?: CodeQuota;
  },
): CodeExecutor {
  return async (input) => {
    const quota = new QuotaTracker(deps.quota);
    const startedAt = Date.now();
    // K4：自铸 controller —— 回合 signal 触发时同步 abort；墙钟超限也走同一通道。
    const controller = new AbortController();
    const onOuterAbort = (): void => {
      controller.abort(input.signal.reason instanceof Error ? input.signal.reason : new Error('tf-code aborted by turn signal'));
    };
    if (input.signal.aborted) onOuterAbort();
    else input.signal.addEventListener('abort', onOuterAbort, { once: true });
    let wallTimer: ReturnType<typeof setTimeout> | undefined;
    const maxWallMs = { ...DEFAULT_CODE_QUOTA, ...(deps.quota ?? {}) }.maxWallMs;
    if (maxWallMs > 0) {
      wallTimer = setTimeout(() => {
        controller.abort(new Error(`tf-code wall clock beyond ${maxWallMs}ms (quota)`));
      }, maxWallMs);
    }

    const bindings = [
      {
        global: 'tools',
        functions: {
          write: (args: unknown) => {
            const over = quota.onSubcall();
            if (over !== null) throw new Error(`quota-exceeded: ${over}`);
            return runOneBinding(deps, 'write', args, input.callId, controller.signal, input.agent);
          },
          read: (args: unknown) => {
            const over = quota.onSubcall();
            if (over !== null) throw new Error(`quota-exceeded: ${over}`);
            return runOneBinding(deps, 'read', args, input.callId, controller.signal, input.agent);
          },
          pwsh: (args: unknown) => {
            const over = quota.onSubcall();
            if (over !== null) throw new Error(`quota-exceeded: ${over}`);
            return runOneBinding(deps, 'pwsh', args, input.callId, controller.signal, input.agent);
          },
        },
      },
    ];

    const finishFailure = (kind: string, message: string, logs?: string, sandbox?: SandboxFacts): CodeOutcome => {
      const cls = classifyCodeFailure(kind);
      return {
        ok: false,
        kind,
        error: `${kind}: ${message}`.slice(0, 500),
        retryable: cls.retryable,
        advice: cls.advice,
        ...(logs === undefined ? {} : { logs }),
        ...(sandbox === undefined ? {} : { sandbox }),
        cwd: input.cwd,
      };
    };

    try {
      const spec = runtime.resolve({
        program: input.code,
        bindings,
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        signal: controller.signal,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      });
      const result = await runtime.run(spec);
      if (wallTimer !== undefined) clearTimeout(wallTimer);
      input.signal.removeEventListener('abort', onOuterAbort);
      const logs = flattenLogs(result.logs);
      const sandbox = extractSandboxFacts(result.sandbox);
      // 回合取消（K4）：abort 与 timeout 分账——kind 取宿主报告值，没有则按 abort 归账。
      if (input.signal.aborted && (result.error === undefined || result.error === null)) {
        return { ...finishFailure('abort', '回合在 tf-code 执行期间被取消', logs), sandbox, ...(input.cwd === undefined ? {} : { cwd: input.cwd }) };
      }
      // K5 墙钟（插件侧硬终止，与宿主 timeout 独立记账）。
      const wallOver = quota.checkWall(Date.now() - startedAt);
      if (wallOver !== null) {
        return { ...finishFailure('quota-exceeded', `wall clock: ${wallOver}`, logs), sandbox };
      }
      if (result.error !== undefined && result.error !== null) {
        // K3：八类 kind 原样保留（宿主报告什么就是什么），分类结论由 classifyCodeFailure 给出。
        const kind = typeof result.error.kind === 'string' && result.error.kind !== '' ? result.error.kind : 'exception';
        const cls = classifyCodeFailure(kind);
        return {
          ok: false,
          kind,
          error: describeRunError(result.error),
          retryable: cls.retryable,
          advice: cls.advice,
          ...(logs === undefined ? {} : { logs }),
          ...(sandbox === undefined ? {} : { sandbox }),
          cwd: input.cwd,
        };
      }
      // value = 无损 JSON（seam 契约）；undefined 视为程序无返回值
      const valueJson = result.value === undefined ? 'undefined' : JSON.stringify(result.value) ?? 'undefined';
      // K5 输出字节（值 + 日志合计）。
      const bytes = Buffer.byteLength(valueJson, 'utf8') + (logs === undefined ? 0 : Buffer.byteLength(logs, 'utf8'));
      const outOver = quota.checkOutput(bytes);
      if (outOver !== null) {
        return { ...finishFailure('quota-exceeded', `output bytes: ${outOver}`), sandbox };
      }
      if (quota.exceeded !== null) {
        // 程序内部吞掉了配额错误也照样结构化终止：配额是硬终止，不是提示。
        return { ...finishFailure('quota-exceeded', `binding calls: ${quota.exceeded}`), sandbox };
      }
      return {
        ok: true,
        valueJson,
        ...(logs === undefined ? {} : { logs }),
        ...(sandbox === undefined ? {} : { sandbox }),
        cwd: input.cwd,
      };
    } catch (error) {
      if (wallTimer !== undefined) clearTimeout(wallTimer);
      input.signal.removeEventListener('abort', onOuterAbort);
      // run() reject = 调用方误用（形状不符/已 dispose 等），如实失败不静默。
      // 回合取消导致的 reject 归 abort 账（K4：取消与误用分账）。
      if (input.signal.aborted || controller.signal.aborted) {
        return finishFailure('abort', 'tf-code 被取消（回合 signal 或配额墙钟触发）');
      }
      return finishFailure('ptc-runtime-misuse', error instanceof Error ? error.message : String(error));
    }
  };
}
