// kernel/modes.ts —— 0.5.0 控制面：两轴（执行通道 × 上下文档位）+ 旧四模式别名
//
// 设计约束（0.5.0 计划书 §4.2/§4.4）：
//   1. 零框架依赖：不 import 任何 @deepseek-ai/*，也不碰 fs —— 拷出 kernel/ 可单测。
//   2. 两条正交轴取代旧四档（balanced/lean/compat/power）：
//        · 执行通道（channel）：standard / code。决定工具面、协议段、命令解析、验收闸、
//          执行器来源；不影响预算、压缩、取回。
//        · 上下文档位（tier）：light / standard / deep。只改数值（maxSteps、
//          maxInputTokens、压缩强度、取回预算、保留条数）；不改工具面、不改并行度、
//          不改执行器（D2/D3 的成因正是旧预设顺手改了工具面）。
//   3. 旧四模式不删除：走 LEGACY_MODE_ALIAS 映射（保留一个 minor，0.6.0 移除）。
//      compat 不再关闭工具面（D2 修复）、lean 不再裁剪工具面（D3 修复）——
//      别名只映射 (channel, tier)，不携带任何工具面/并行度副作用。
//   4. 预算模型（§4.5）：budgetTokens 降为观测项；控制变量是 maxSteps（N 上限）与
//      maxInputTokens（C 上限）。档位只提供这两者的数值。

// ---------------------------------------------------------------------------
// 轴一：执行通道
// ---------------------------------------------------------------------------

export const CHANNELS = ['standard', 'code']         ;
                                                  
export const DEFAULT_CHANNEL            = 'standard';

export function isChannelId(value         )                     {
  return value === 'standard' || value === 'code';
}

                              
                
                
                                    
                               
                                      
                                     
                                      
                                       
                                                                     
                                             
 

export const CHANNEL_SPECS                         = [
  {
    id: 'standard',
    order: 1,
    label: { zh: '标准', en: 'Standard' },
    tagline: { zh: 'tf-* 原生工具，协议段注入，可验收。', en: 'tf-* native commands, protocol section, acceptance gate.' },
    useWhen: { zh: '日常读写与查改任务；不依赖宿主 PTC。', en: 'Everyday read/write tasks; no host PTC needed.' },
    tradeoff: { zh: '工具面 = tf-* + 宿主工具透传；命令逐条解析。', en: 'Tool surface = tf-* + host passthrough; commands parsed one by one.' },
    legacyBehavior: { zh: '等于 0.4.0 的 balanced 行为面。', en: 'Same behavior face as 0.4.0 balanced.' },
  },
  {
    id: 'code',
    order: 2,
    label: { zh: '代码', en: 'Code' },
    tagline: { zh: '单一 run_code 入口，协议段 0 字符（preset 来源）。', en: 'Single run_code entry, zero protocol chars (preset source).' },
    useWhen: { zh: '多步数据加工；宿主有 PTC 预设或 ptcRuntime。', en: 'Multi-step data work; host has PTC preset or ptcRuntime.' },
    tradeoff: { zh: '来源=preset 完全让位；来源=bridge 仅 tf-code 受限通道；两者皆无时不可用。', en: 'preset = full yield; bridge = tf-code only; neither = unavailable.' },
    legacyBehavior: { zh: '数值面等于 0.4.0 的 power（enableCode=true）。', en: 'Numeric face equals 0.4.0 power (enableCode=true).' },
  },
];

const CHANNEL_BY_ID = new Map                     (CHANNEL_SPECS.map((c) => [c.id, c]));

export function getChannel(id         )              {
  return (isChannelId(id) ? CHANNEL_BY_ID.get(id) : undefined) ?? CHANNEL_BY_ID.get(DEFAULT_CHANNEL) ;
}

// ---------------------------------------------------------------------------
// 轴二：上下文档位
// ---------------------------------------------------------------------------

export const TIERS = ['light', 'standard', 'deep']         ;
                                            
export const DEFAULT_TIER         = 'standard';

export function isTierId(value         )                  {
  return value === 'light' || value === 'standard' || value === 'deep';
}

                                                                               

/** 档位数值（§4.2 表）：只改数值，不改工具面/并行度/执行器/协议段。 */
                             
                                                
                   
                                                
                         
                              
                                               
                                               
                          
                             
                     
                   
                          
 

                           
             
                
                                    
                           
                                      
                                                    
                                       
                     
 

export const TIER_SPECS                      = [
  {
    id: 'light',
    order: 1,
    label: { zh: '轻', en: 'Light' },
    useWhen: { zh: '单文件小改、问答。', en: 'Single-file edits, Q&A.' },
    tradeoff: { zh: '步数与上下文余量最小，压缩最激进。', en: 'Smallest step/context budget, most aggressive compaction.' },
    values: {
      maxSteps: 16,
      maxInputTokens: 12_000,
      compactAggressiveness: 'aggressive',
      peekBudgetChars: 12_000,
      keepRecent: 12,
      maxSummaryChars: 8_000,
    },
  },
  {
    id: 'standard',
    order: 2,
    label: { zh: '标准', en: 'Standard' },
    useWhen: { zh: '默认档。', en: 'Default.' },
    tradeoff: { zh: '缺省数值；压缩 balanced。', en: 'Defaults; balanced compaction.' },
    values: {
      maxSteps: 24,
      maxInputTokens: 20_000,
      compactAggressiveness: 'balanced',
      peekBudgetChars: 24_000,
      keepRecent: 30,
      maxSummaryChars: 16_000,
    },
  },
  {
    id: 'deep',
    order: 3,
    label: { zh: '深', en: 'Deep' },
    useWhen: { zh: '跨模块改造、需要保留更多历史。', en: 'Cross-module changes; keep more history.' },
    tradeoff: { zh: '单请求更贵；压缩保守，不表示更强。', en: 'Costlier per request; conservative compaction — not "stronger".' },
    values: {
      maxSteps: 40,
      maxInputTokens: 48_000,
      compactAggressiveness: 'conservative',
      peekBudgetChars: 48_000,
      keepRecent: 60,
      maxSummaryChars: 32_000,
    },
  },
];

const TIER_BY_ID = new Map                  (TIER_SPECS.map((t) => [t.id, t]));

export function getTier(id         )           {
  return (isTierId(id) ? TIER_BY_ID.get(id) : undefined) ?? TIER_BY_ID.get(DEFAULT_TIER) ;
}

export function tierByOrder(order        )                       {
  return TIER_SPECS.find((t) => t.order === order);
}

/** 旧四模式的 budgetTokens 观测阈值（§4.5.3：沿用 lean 的 60k，仅作告警阈值）。 */
export const DEFAULT_BUDGET_TOKENS_OBSERVE = 60_000;

// ---------------------------------------------------------------------------
// 旧四模式别名（§4.4）：读旧配置时按映射执行并输出一行 warn。
// 保留一个 minor（0.5.x），0.6.0 移除。
// ---------------------------------------------------------------------------

export const LEGACY_MODE_IDS = ['balanced', 'lean', 'compat', 'power']         ;
                                                            

export const LEGACY_MODE_ALIAS                                                                       = {
  balanced: { channel: 'standard', tier: 'standard' },
  lean: { channel: 'standard', tier: 'light' },
  compat: { channel: 'standard', tier: 'deep' },
  power: { channel: 'code', tier: 'standard' },
};

/** 是否旧模式 id（别名检测；新轴值返回 false）。 */
export function isLegacyModeId(value         )                        {
  return typeof value === 'string' && (LEGACY_MODE_IDS                     ).includes(value);
}

                                    
                     
               
                                             
                   
 

/**
 * 把"模式或通道"字符串解析为 (channel, tier)：
 *  - 新轴值（standard/light/deep 等歧义值不允许直接传模式槽）——本函数只用于旧模式槽位；
 *  - 旧模式 id → LEGACY_MODE_ALIAS 映射，aliased=true（调用方 warn）；
 *  - 未知值 → 默认 (standard, standard)，aliased=false。
 */
export function resolveLegacyMode(value         )                    {
  if (isLegacyModeId(value)) {
    const mapped = LEGACY_MODE_ALIAS[value];
    return { channel: mapped.channel, tier: mapped.tier, aliased: true };
  }
  return { channel: DEFAULT_CHANNEL, tier: DEFAULT_TIER, aliased: false };
}

/**
 * 反向映射（control.json 迁移的回滚兼容）：把 (channel, tier) 写回旧 mode 字段一个 minor。
 * 只映射可精确表达的组合；其余组合省略 mode 字段（升级后回滚会落回 balanced，可接受）。
 */
export function reverseLegacyMode(channel           , tier        )                           {
  if (channel === 'standard' && tier === 'standard') return 'balanced';
  if (channel === 'standard' && tier === 'light') return 'lean';
  if (channel === 'standard' && tier === 'deep') return 'compat';
  if (channel === 'code' && tier === 'standard') return 'power';
  return undefined;
}

// ---------------------------------------------------------------------------
// 对外目录（终端 CLI / 桌面页 / --json 共用同一份投影）
// ---------------------------------------------------------------------------

export function publicChannelCatalog() {
  return CHANNEL_SPECS.map(({ id, order, label, tagline, useWhen, tradeoff, legacyBehavior }) => ({
    id, order, label, tagline, useWhen, tradeoff, legacyBehavior,
  }));
}

export function publicTierCatalog() {
  return TIER_SPECS.map(({ id, order, label, useWhen, tradeoff, values }) => ({
    id, order, label, useWhen, tradeoff, values,
  }));
}

/**
 * 旧模式目录投影（别名期兼容）：旧 CLI/UI 消费者拿到的还是四条目录，
 * 每条标注 alias 目标。0.6.0 移除。
 */
export function publicLegacyModeCatalog() {
  return (LEGACY_MODE_IDS                           ).map((id, index) => {
    const mapped = LEGACY_MODE_ALIAS[id];
    return {
      id,
      order: index + 1,
      aliasTarget: mapped,
      deprecated: true,
      removal: '0.6.0',
    };
  });
}
