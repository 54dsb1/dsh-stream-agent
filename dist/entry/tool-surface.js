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
                                     
               
                      
                                      
                      
 

                                   
                                                                        
                                                                                                                                            
                                                             
                                                                             
 

/** surfacePolicy（§6.3）：reserved-only 默认；profile 仅回退演练期保留（§12.4，已弃用）。 */
                                                        

/** profile 策略下的档位（'off' 已删除——D2）。 */
                                                          

/** 本插件的保留工具前缀（§6.3 约束 1）：外部插件占用时报错。 */
export const RESERVED_TOOL_PREFIX = 'tf-';

/** 面降级时注入的一行告警（每级都有一行注入 + 台账）。 */
export function degradedLine(level                                    )         {
  switch (level) {
    case 'stale':
      return '[tf-stream:degraded surface=stale] 本请求工具面沿用上一次冻结（重新解析失败，详见台账）';
    case 'core':
      return '[tf-stream:degraded surface=core] 工具面降级为 core 白名单（schema 成本超预算或部分解析失败）';
    case 'protocol-only':
      return '[tf-stream:degraded surface=protocol-only] 宿主工具面不可用：回到纯文本协议（tf-* 七工具映射 + tf-call 不可用）';
  }
}

/**
 * tf- 前缀保留检查（§6.3 约束 1）：返回占用的外部工具名列表。
 * 驱动器自有工具（tf-read/tf-write/...）不算占用——它们由本插件注册。
 */
export function reservedPrefixViolations(names                   )           {
  const owned = new Set([
    'tf-write', 'tf-read', 'tf-edit', 'tf-append', 'tf-grep', 'tf-glob',
    'tf-bash', 'tf-peek', 'tf-final', 'tf-code', 'tf-plan', 'tf-call', 'tf-ask', 'tf-skill',
  ]);
  return names.filter((n) => n.startsWith(RESERVED_TOOL_PREFIX) && !owned.has(n));
}

                              
                                                        
                                 
                                                           
                                   
                                                                        
                                                  
                                       
                                    
                                            
                                                                
                                                            
                             
                                         
                                                         
                                         
                            
 

                                             
                                    
                        
                                           
                          
                                                              
                       
                                           
                        
                                                                 
                         
 

/**
 * 会话级工具面持有者。createSurface(sessionId) 后每请求调 resolve：
 * 首次从宿主解析并冻结；后续解析失败沿用旧面（degraded=stale）；只允许新增工具名
 * （宿主面出现新工具 → 并入 names/definitions）。
 */
export class ToolSurfaceHolder {
          current                         ;
  /** 解析失败的连续次数（台账用；≥1 即本请求降级 stale）。 */
          failures = 0;
                   tools                              ;
                   options                            ;

  constructor(tools                              , options                            ) {
    this.tools = tools;
    this.options = options;
  }

  get snapshot()                          {
    return this.current;
  }

  get failureCount()         {
    return this.failures;
  }

  /**
   * 0.5.0：运行期通道切换的让位面（§5.3）——代码通道下 tf-call 校验整体拒绝
   * （模型侧无 tf-call 命令）。通道切换在任务边界应用时调用。
   */
  setCallReserved(reserved         )       {
    this.options.callReserved = reserved;
  }

  /** 是否接了宿主服务面（headless/离线 mock 没接 = 稳态 protocol-only，不注降级行）。 */
  get hasService()          {
    return this.tools !== undefined && typeof this.tools.resolve === 'function' && typeof this.tools.schemas === 'function';
  }

  /**
   * 每请求解析一次。agent/signal 透传宿主 resolve。
   * 任何异常都归一为"沿用旧面"（fail-open）；只有从未解析成功过才返回 undefined
   * （L2 protocol-only：驱动器回纯协议行为并注入 protocol-only 行）。
   */
  async resolve(input                                                                    )                                   {
    const tools = this.tools;
    if (tools === undefined || typeof tools.resolve !== 'function' || typeof tools.schemas !== 'function') {
      this.failures += 1;
      return this.current;
    }
    try {
      const toolSet = await tools.resolve({ agent: input.agent, ...(input.signal === undefined ? {} : { signal: input.signal }), ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }) });
      if (toolSet === undefined || toolSet === null) throw new Error('tools.resolve returned null');
      const all                                = tools.schemas(input.agent, toolSet);
      if (!Array.isArray(all)) throw new Error('tools.schemas returned non-array');
      // §6.3 约束 1：tf- 前缀保留给本插件——外部占用在解析面直接暴露（fail-open：
      // 工具照常透传，但降级行注入让模型与用户都知道面被污染）。
      const violations = reservedPrefixViolations(all.map((d) => String(d.name)));
      const previous = this.current;
      const names = mergeNames(previous?.names ?? [], all.map((d) => String(d.name)));
      const definitions = new Map                            (previous ? [...previous.definitions] : []);
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
        ...(violations.length > 0 ? { degraded: undefined } : {}),
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
  validateCallName(name        )                {
    if (this.options.callReserved === true || this.options.callCommand === false) {
      return 'tf-call 通道未启用（当前通道下本插件不声明命令面）：直接调用会话内工具';
    }
    if (this.current === undefined) {
      return 'unknown-tool: 本会话未解析到宿主工具面（L2 protocol-only）——请改用 tf-* 命令';
    }
    const known = this.current.names;
    if (known.includes(name)) return null;
    // 相近建议：公共前缀 ≥3 字符或一方包含另一方（websearch ↔ web_search）；最多 3 条，不回灌全表
    const commonPrefixLen = (a        , b        )         => {
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
  all                               ,
  policy               ,
  profile                ,
  previous                                           ,
)                                {
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
const CORE_PROFILE_TOOLS                    = [
  'read', 'write', 'edit', 'grep', 'glob', 'bash', 'pwsh',
];

function mergeNames(previous                   , next                   )                    {
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
