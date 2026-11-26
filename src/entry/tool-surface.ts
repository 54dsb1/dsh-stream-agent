/**
 * src/entry/tool-surface.ts —— v0.5.0 工具面（ToolSurface）：reserved-only 透传 + 通道闸门
 *
 * 0.5.0 变化（计划书 §6.3，D2/D3 修复）：
 *   1. `surfacePolicy`（默认 'reserved-only'）取代裸档位过滤：
 *      · reserved-only：只管理 tf-* 前缀（本插件的保留字），其余宿主工具**原样透传**——
 *        对第三方工具零影响（G4：与第三方插件共存不隐藏其工具）。代码通道下本插件
 *        不注册任何 tf-*（§5.3 让位），工具面 = preset 原样。
 *      · profile：0.4.x 行为（core/standard/full 过滤），仅回退演练期保留（§12.4）；
 *        'off' 档删除（D2：compat 档曾把第三方工具砍到完全不可达），
 *        CORE_TOOLS 白名单删除（D3：lean 档在 nativeTools 下只剩 7 项）。
 *   2. tf- 前缀保留给本插件：发现外部工具占用该前缀时报错（结构化，不静默）。
 *   3. schema 超预算只降级 deferLoading 标记，不得删除工具（§6.3 约束 2）。
 *
 * 职责三件事（沿 0.4.0）：
 *   1. 会话首请求从宿主解析一次准入视图（ctx.tools.resolve）+ schema（ctx.tools.schemas），
 *      additions-only 冻结；解析失败沿用旧面 + degraded 注入行。
 *   2. 给 tf-call 提供工具名校验面（unknown-tool 命令级失败 + 前缀匹配建议）。
 *   3. 给原生通道提供声明面（nativeTools 开启时传 llm.stream 的 tools）。
 */

// 宿主服务面（duck-type，不 import @deepseek-ai/*）
export interface HostToolSchemaLike {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  deferLoading?: true;
}

export interface ToolsServiceLike {
  /** dsh-tools resolve：准入视图（when 门控逐工具判定）。失败/不可用 → undefined（调用方降级）。 */
  resolve?(context: { agent: unknown; signal?: AbortSignal; modelSelection?: unknown }): Promise<unknown | undefined> | unknown | undefined;
  /** dsh-tools schemas：(scope, toolSet) → 模型可见 schema 数组。 */
  schemas?(scope: unknown, toolSet?: unknown): readonly HostToolSchemaLike[];
}

/** surfacePolicy（§6.3）：reserved-only 默认；profile 仅回退演练期保留（§12.4，已弃用）。 */
export type SurfacePolicy = 'reserved-only' | 'profile';

/** profile 策略下的档位（'off' 已删除——D2）。 */
export type SurfaceProfile = 'core' | 'standard' | 'full';

/** 本插件的保留工具前缀（§6.3 约束 1）：外部插件占用时报错。 */
export const RESERVED_TOOL_PREFIX = 'tf-';

/** 面降级时注入的一行告警（每级都有一行注入 + 台账）。 */
export function degradedLine(level: 'stale' | 'core' | 'protocol-only' | 'reserved'): string {
  switch (level) {
    case 'stale':
      return '[tf-stream:degraded surface=stale] 本请求工具面沿用上一次冻结（重新解析失败，详见台账）';
    case 'core':
      return '[tf-stream:degraded surface=core] 工具面降级为 core 白名单（schema 成本超预算或部分解析失败）';
    case 'protocol-only':
      return '[tf-stream:degraded surface=protocol-only] 宿主工具面不可用：回到纯文本协议（tf-* 七工具映射 + tf-call 不可用）';
    case 'reserved':
      return '[tf-stream:degraded surface=reserved] 工具面含占用 tf- 保留前缀的外部工具（照常透传；tf-* 命令语义仍归本插件）';
  }
}

/**
 * tf- 前缀保留检查（§6.3 约束 1）：返回占用的外部工具名列表。
 * 驱动器自有工具（tf-read/tf-write/...）不算占用——它们由本插件注册。
 */
export function reservedPrefixViolations(names: readonly string[]): string[] {
  const owned = new Set([
    'tf-write', 'tf-read', 'tf-edit', 'tf-append', 'tf-grep', 'tf-glob',
    'tf-bash', 'tf-peek', 'tf-final', 'tf-code', 'tf-plan', 'tf-call', 'tf-ask', 'tf-skill',
  ]);
  return names.filter((n) => n.startsWith(RESERVED_TOOL_PREFIX) && !owned.has(n));
}

export interface ToolSurface {
  /** 面策略（reserved-only = 透传；profile = 0.4.x 过滤，已弃用）。 */
  readonly policy: SurfacePolicy;
  /** profile 策略下的档位（reserved-only 时恒 'full' 语义 = 全量透传）。 */
  readonly profile: SurfaceProfile;
  /** 原生通道声明（nativeTools 开启时传 llm.stream 的 tools）。reserved-only = 全量。 */
  readonly schemas: readonly HostToolSchemaLike[];
  /** 本会话冻结时点的全部可见工具名（tf-call 的校验面）。 */
  readonly names: readonly string[];
  /** 完整定义（描述 + 参数），供协议段生成与 tf-code 绑定生成。 */
  readonly definitions: ReadonlyMap<string, HostToolSchemaLike>;
  /** 冻结时点的准入视图（strictAdmission 开启时透传 execute；beta 缺省关闭）。 */
  readonly toolSet?: unknown;
  /** 降级行（undefined = 无降级）。驱动器负责注入与台账。
   *  'reserved' = 宿主面出现占用 tf- 保留前缀的外部工具（§6.3 约束 1；fail-open 注入一行）。 */
  readonly degraded?: 'stale' | 'core' | 'protocol-only' | 'reserved';
  /** 冻结序号：会话内首次请求 = 1；additions-only。 */
  readonly frozenAt: number;
}

export interface ToolSurfaceProviderOptions {
  /** 面策略（§6.3：默认 reserved-only）。 */
  policy: SurfacePolicy;
  /** profile 策略下的档位（reserved-only 时忽略）。 */
  profile: SurfaceProfile;
  /** nativeTools：原生通道开关（false 时不声明 schema，工具可达性走 tf-call）。 */
  nativeTools: boolean;
  /** tf-call 是否启用（callCommand；缺省 true）。 */
  callCommand?: boolean;
  /** tf-call 校验时是否拒绝（代码通道 preset 让位下 = true：模型侧无 tf-call 命令）。 */
  callReserved?: boolean;
}

/**
 * 会话级工具面持有者。createSurface(sessionId) 后每请求调 resolve：
 * 首次从宿主解析并冻结；后续解析失败沿用旧面（degraded=stale）；只允许新增工具名
 * （宿主面出现新工具 → 并入 names/definitions）。
 */
export class ToolSurfaceHolder {
  private current: ToolSurface | undefined;
  /** 解析失败的连续次数（台账用；≥1 即本请求降级 stale）。 */
  private failures = 0;
  private readonly tools: ToolsServiceLike | undefined;
  private readonly options: ToolSurfaceProviderOptions;

  constructor(tools: ToolsServiceLike | undefined, options: ToolSurfaceProviderOptions) {
    this.tools = tools;
    this.options = options;
  }

  get snapshot(): ToolSurface | undefined {
    return this.current;
  }

  get failureCount(): number {
    return this.failures;
  }

  /**
   * 0.5.0：运行期通道切换的让位面（§5.3）——代码通道下 tf-call 校验整体拒绝
   * （模型侧无 tf-call 命令）。通道切换在任务边界应用时调用。
   */
  setCallReserved(reserved: boolean): void {
    this.options.callReserved = reserved;
  }

  /** 是否接了宿主服务面（headless/离线 mock 没接 = 稳态 protocol-only，不注降级行）。 */
  get hasService(): boolean {
    return this.tools !== undefined && typeof this.tools.resolve === 'function' && typeof this.tools.schemas === 'function';
  }

  /**
   * 每请求解析一次。agent/signal 透传宿主 resolve。
   * 任何异常都归一为"沿用旧面"（fail-open）；只有从未解析成功过才返回 undefined
   * （L2 protocol-only：驱动器回纯协议行为并注入 protocol-only 行）。
   */
  async resolve(input: { agent: unknown; signal?: AbortSignal; modelSelection?: unknown }): Promise<ToolSurface | undefined> {
    const tools = this.tools;
    if (tools === undefined || typeof tools.resolve !== 'function' || typeof tools.schemas !== 'function') {
      this.failures += 1;
      return this.current;
    }
    try {
      const toolSet = await tools.resolve({ agent: input.agent, ...(input.signal === undefined ? {} : { signal: input.signal }), ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }) });
      if (toolSet === undefined || toolSet === null) throw new Error('tools.resolve returned null');
      const all: readonly HostToolSchemaLike[] = tools.schemas(input.agent, toolSet);
      if (!Array.isArray(all)) throw new Error('tools.schemas returned non-array');
      // §6.3 约束 1：tf- 前缀保留给本插件——外部占用在解析面直接暴露（fail-open：
      // 工具照常透传，但降级行注入让模型与用户都知道面被污染）。
      // 修复（0.6.0 复查）：此前 violations 映射成 degraded: undefined（反向），占用事实
      // 被静默丢弃——检查算完即焚，违反本文件头部"不静默"的声明。现在映射为 'reserved' 级。
      const violations = reservedPrefixViolations(all.map((d) => String(d.name)));
      const previous = this.current;
      const names = mergeNames(previous?.names ?? [], all.map((d) => String(d.name)));
      const definitions = new Map<string, HostToolSchemaLike>(previous ? [...previous.definitions] : []);
      for (const d of all) definitions.set(String(d.name), d);
      this.failures = 0;
      // schema 面按策略重算（additions-only 保缓存前缀）；names/definitions 允许单调扩张
      this.current = {
        policy: this.options.policy,
        profile: this.options.policy === 'reserved-only' ? 'full' : this.options.profile,
        schemas: this.options.nativeTools
          ? projectNative(all, this.options.policy, this.options.profile, previous?.schemas)
          : [],
        names,
        definitions,
        ...(violations.length > 0 ? { degraded: 'reserved' as const } : {}),
        toolSet,
        frozenAt: (previous?.frozenAt ?? 0) + 1,
      };
      return this.current;
    } catch {
      this.failures += 1;
      if (this.current !== undefined) {
        // 沿用旧面 + degraded=stale（本请求注入一行）；schemas/toolSet 不变
        this.current = { ...this.current, degraded: 'stale' };
        return this.current;
      }
      return undefined;
    }
  }

  /**
   * tf-call 工具名校验（§6.3）。返回 null = 通过；否则返回结构化失败的 message
   * （unknown-tool + 前缀匹配建议；不回灌全表——省 token）。
   * callReserved=true（代码通道 preset 让位）时 tf-call 通道整体未启用。
   */
  validateCallName(name: string): string | null {
    if (this.options.callReserved === true || this.options.callCommand === false) {
      return 'tf-call 通道未启用（当前通道下本插件不声明命令面）：直接调用会话内工具';
    }
    if (this.current === undefined) {
      return 'unknown-tool: 本会话未解析到宿主工具面（L2 protocol-only）——请改用 tf-* 命令';
    }
    const known = this.current.names;
    if (known.includes(name)) return null;
    // 相近建议：公共前缀 ≥3 字符或一方包含另一方（websearch ↔ web_search）；最多 3 条，不回灌全表
    const commonPrefixLen = (a: string, b: string): number => {
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
      return i;
    };
    const suggestions = known
      .filter((n) => commonPrefixLen(n, name) >= 3 || n.includes(name) || name.includes(n))
      .slice(0, 3);
    return `unknown-tool: "${name}" 不在本会话工具面内${suggestions.length > 0 ? `；相近工具：${suggestions.join(', ')}` : '（无相近工具）'}。用 tf-glob/tf-bash 等映射命令，或核对工具名后重发。`;
  }
}

/**
 * schema 声明面投影：
 *  - reserved-only：全量透传（对第三方工具零影响；G4 探针的判定面）。
 *  - profile：0.4.x 行为（core 白名单 / standard-full 全量），仅回退演练期保留。
 *  两者都保持 additions-only（缓存前缀只增不动）。
 */
function projectNative(
  all: readonly HostToolSchemaLike[],
  policy: SurfacePolicy,
  profile: SurfaceProfile,
  previous: readonly HostToolSchemaLike[] | undefined,
): readonly HostToolSchemaLike[] {
  const selected = policy === 'profile' && profile === 'core'
    ? all.filter((d) => !String(d.name).startsWith(RESERVED_TOOL_PREFIX) && CORE_PROFILE_TOOLS.includes(String(d.name)))
    : all;
  // additions-only：新工具名追加到上次声明尾部（缓存前缀只增不动）
  if (previous === undefined || previous.length === 0) return selected;
  const known = new Set(previous.map((d) => String(d.name)));
  const additions = selected.filter((d) => !known.has(String(d.name)));
  return additions.length === 0 ? previous : [...previous, ...additions];
}

/**
 * profile 档白名单（仅 surfacePolicy='profile' 的回退演练使用；0.5.0 起非默认路径）。
 * D3 修复后它不再随默认档位生效——默认 reserved-only 恒全量透传。
 */
const CORE_PROFILE_TOOLS: readonly string[] = [
  'read', 'write', 'edit', 'grep', 'glob', 'bash', 'pwsh',
];

function mergeNames(previous: readonly string[], next: readonly string[]): readonly string[] {
  const seen = new Set(previous);
  const merged = [...previous];
  for (const n of next) {
    if (!seen.has(n)) {
      seen.add(n);
      merged.push(n);
    }
  }
  return merged;
}
