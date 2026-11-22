/**
 * src/entry/tool-surface.ts —— v0.4.0 工具面（ToolSurface）：能力对等与 tf-call 的唯一来源
 *
 * 设计：upgrade-plan/v0.4.0-stream-mode-design.md §6/§7.1。职责三件事：
 *   1. 会话首请求从宿主解析一次准入视图（ctx.tools.resolve）+ schema（ctx.tools.schemas），
 *      按 profile 冻结；此后只允许新增（additions-only），解析失败沿用旧面 + degraded 注入行。
 *   2. 给 tf-call 提供工具名校验面（unknown-tool 命令级失败 + 前缀匹配建议，不回灌全表）。
 *   3. 给原生通道提供声明面（nativeTools 开启时传 llm.stream 的 tools；core 档只声明白名单）。
 *
 * 取证锚（宿主面，rc.3 实测）：
 *   - dsh-tools/lib/index.js `schemas(scope, toolSet)` → `definitions(scope, toolSet).map(projectToolSchema)`
 *   - dsh-tools `resolve({agent, signal})` → 冻结对象 {dispose(), view(scope)}；`when` 门控在 resolve 时逐工具判定
 *   - dsh-tools `execute(input)` → selectExecutor(input.agent).execute(input)；input.toolSet 可选（R5：beta 不透传）
 *   - dsh-llm `projectToolUpdates`：toolUpdate 路由能力由模型面决定；宿主管理的 deferLoading 投放
 *     需要 request/header + developer/message 事件（E6 红线：本插件不写）→ T2 由本模块**自管**：
 *     非 core 工具 schema 保留 deferLoading 标记（路由支持时宿主折叠），投放通道走 tf-call（不声明 schema）。
 *
 * 降级阶梯（§8.3）：L0 full 档 → L1 core（白名单）→ L2 protocol-only（无宿主面，0.3.x 行为）
 *   → L3 refuse（llm/tools 缺失，装载期已拒绝，不在本模块）。
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

export type SurfaceProfile = 'core' | 'standard' | 'full' | 'off';

/** core 档白名单（T2：首请求只声明这批；其余可达性走 tf-call）。 */
export const CORE_TOOLS: readonly string[] = [
  'read', 'write', 'edit', 'grep', 'glob', 'bash', 'pwsh',
];

/** 面降级时注入的一行告警（§8.3：每级都有一行注入 + 台账）。 */
export function degradedLine(level: 'stale' | 'core' | 'protocol-only'): string {
  switch (level) {
    case 'stale':
      return '[tf-stream:degraded surface=stale] 本请求工具面沿用上一次冻结（重新解析失败，详见台账）';
    case 'core':
      return '[tf-stream:degraded surface=core] 工具面降级为 core 白名单（schema 成本超预算或部分解析失败）';
    case 'protocol-only':
      return '[tf-stream:degraded surface=protocol-only] 宿主工具面不可用：回到纯文本协议（tf-* 七工具映射 + tf-call 不可用）';
  }
}

export interface ToolSurface {
  readonly profile: SurfaceProfile;
  /** 原生通道声明（nativeTools 开启时传 llm.stream 的 tools；core 档只含白名单；off = 空）。 */
  readonly schemas: readonly HostToolSchemaLike[];
  /** 本会话冻结时点的全部可见工具名（tf-call 的校验面；不含 core 与否的区分）。 */
  readonly names: readonly string[];
  /** 完整定义（描述 + 参数），供协议段生成与 tf-code 绑定生成（P5）。 */
  readonly definitions: ReadonlyMap<string, HostToolSchemaLike>;
  /** 冻结时点的准入视图（strictAdmission 开启时透传 execute；beta 缺省关闭）。 */
  readonly toolSet?: unknown;
  /** 降级行（undefined = L0 无降级）。驱动器负责注入与台账。 */
  readonly degraded?: 'stale' | 'core' | 'protocol-only';
  /** 冻结序号：会话内首次请求 = 1；additions-only。 */
  readonly frozenAt: number;
}

export interface ToolSurfaceProviderOptions {
  /** 面档位（§16 决议 2：缺省 standard——对等优先）。'off' = 0.3.x 行为（无宿主面）。 */
  profile: SurfaceProfile;
  /** nativeTools：原生通道开关（§15：默认文本——false 时不声明 schema，工具可达性走 tf-call）。 */
  nativeTools: boolean;
  /** tf-call 是否启用（enableCallCommand；缺省 true，'off' 档强制关）。 */
  callCommand?: boolean;
}

/**
 * 会话级工具面持有者。createSurface(sessionId) 后每请求调 resolve：
 * 首次从宿主解析并冻结；后续解析失败沿用旧面（degraded=stale）；只允许新增工具名
 * （宿主面出现新工具 → 并入 names/definitions，schema 面按档位重算）。
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

  /** 是否接了宿主服务面（headless/离线 mock 没接 = 稳态 protocol-only，不注降级行）。 */
  get hasService(): boolean {
    return this.tools !== undefined && typeof this.tools.resolve === 'function' && typeof this.tools.schemas === 'function';
  }

  /**
   * 每请求解析一次。agent/signal 透传宿主 resolve。
   * 任何异常都归一为"沿用旧面"（fail-open，红线 4）；只有从未解析成功过才返回 undefined
   * （L2 protocol-only：驱动器回 0.3.x 行为并注入 protocol-only 行）。
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
      const previous = this.current;
      const names = mergeNames(previous?.names ?? [], all.map((d) => String(d.name)));
      const definitions = new Map<string, HostToolSchemaLike>(previous ? [...previous.definitions] : []);
      for (const d of all) definitions.set(String(d.name), d);
      this.failures = 0;
      // schema 面按档位重算（additions-only 保缓存前缀）；names/definitions 允许单调扩张
      this.current = {
        profile: this.options.profile,
        schemas: this.options.nativeTools && this.options.profile !== 'off'
          ? projectNative(all, this.options.profile, previous?.schemas)
          : [],
        names,
        definitions,
        ...(this.options.profile !== 'off' ? { toolSet } : {}),
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
   */
  validateCallName(name: string): string | null {
    if (this.options.profile === 'off' || this.options.callCommand === false) {
      return 'tf-call 通道未启用（toolSurface=off 或 callCommand=false）：改用 tf-* 命令';
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

/** 白名单过滤 + 顺序保持（core 档只声明 CORE_TOOLS；standard/full 全量）。 */
function projectNative(
  all: readonly HostToolSchemaLike[],
  profile: SurfaceProfile,
  previous: readonly HostToolSchemaLike[] | undefined,
): readonly HostToolSchemaLike[] {
  const selected = profile === 'core' ? all.filter((d) => CORE_TOOLS.includes(String(d.name))) : all;
  // additions-only：新工具名追加到上次声明尾部（缓存前缀只增不动）
  if (previous === undefined || previous.length === 0) return selected;
  const known = new Set(previous.map((d) => String(d.name)));
  const additions = selected.filter((d) => !known.has(String(d.name)));
  return additions.length === 0 ? previous : [...previous, ...additions];
}

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
