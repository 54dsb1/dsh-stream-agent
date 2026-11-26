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

export const CHANNELS = ['standard', 'code'] as const;
export type ChannelId = (typeof CHANNELS)[number];
export const DEFAULT_CHANNEL: ChannelId = 'standard';

export function isChannelId(value: unknown): value is ChannelId {
  return value === 'standard' || value === 'code';
}

export interface ChannelSpec {
  id: ChannelId;
  order: number;
  label: { zh: string; en: string };
  /** 一句话是什么（控制栏区块 A 内的选项说明） */
  tagline: { zh: string; en: string };
  /** 执行器来源的说明（来源由探测决定，这里只写"怎么选它"） */
  useWhen: { zh: string; en: string };
  tradeoff: { zh: string; en: string };
}

export const CHANNEL_SPECS: readonly ChannelSpec[] = [
  {
    id: 'standard',
    order: 1,
    label: { zh: '标准', en: 'Standard' },
    tagline: { zh: 'tf-* 原生工具，协议段注入，可验收。', en: 'tf-* native commands, protocol section, acceptance gate.' },
    useWhen: { zh: '日常读写与查改任务；不依赖宿主 PTC。', en: 'Everyday read/write tasks; no host PTC needed.' },
    tradeoff: { zh: '工具面 = tf-* + 宿主工具透传；命令逐条解析。', en: 'Tool surface = tf-* + host passthrough; commands parsed one by one.' },
  },
  {
    id: 'code',
    order: 2,
    label: { zh: 'PTC兼容模式', en: 'PTC-compat' },
    tagline: { zh: '单一 run_code 入口，协议段 0 字符（preset 来源）。', en: 'Single run_code entry, zero protocol chars (preset source).' },
    useWhen: { zh: '多步数据加工；宿主有 PTC 预设或 ptcRuntime。', en: 'Multi-step data work; host has PTC preset or ptcRuntime.' },
    tradeoff: { zh: '来源=preset 完全让位；来源=bridge 仅 tf-code 受限通道；两者皆无时不可用。', en: 'preset = full yield; bridge = tf-code only; neither = unavailable.' },
  },
];

const CHANNEL_BY_ID = new Map<string, ChannelSpec>(CHANNEL_SPECS.map((c) => [c.id, c]));

export function getChannel(id: unknown): ChannelSpec {
  return (isChannelId(id) ? CHANNEL_BY_ID.get(id) : undefined) ?? CHANNEL_BY_ID.get(DEFAULT_CHANNEL)!;
}

// ---------------------------------------------------------------------------
// 轴二：上下文档位
// ---------------------------------------------------------------------------

export const TIERS = ['light', 'standard', 'deep'] as const;
export type TierId = (typeof TIERS)[number];
export const DEFAULT_TIER: TierId = 'standard';

export function isTierId(value: unknown): value is TierId {
  return value === 'light' || value === 'standard' || value === 'deep';
}

export type CompactAggressiveness = 'conservative' | 'balanced' | 'aggressive';

/** 档位数值（§4.2 表）：只改数值，不改工具面/并行度/执行器/协议段。
 *
 * 0.5.2 起：**档位不再预设行为上限**。未在 `limits` 里定义的项目一律为 0（不限制）——
 * 档位只是"命名 + 展示"，实际数值由用户定义（见 kernel/limits.ts）。
 * `compactAggressiveness` 不是上限而是压缩强度，缺省 balanced。 */
export interface TierValues {
  /** 单任务请求数上限（N 上限；触顶注入收束指令）。0 = 无上限（仅观测告警）。 */
  maxSteps: number;
  /** 单请求上下文上限（C 上限，token 估算；触顶触发压缩）。0 = 不压缩。 */
  maxInputTokens: number;
  /** 压缩强度（compact 模块的模式选择） */
  compactAggressiveness: CompactAggressiveness;
  /** 每回合取回字符上限（tf-peek / span 账本通道；0 = 不限制） */
  peekBudgetChars: number;
  /** 压缩保留最近条数（不压缩的最近消息条数） */
  keepRecent: number;
  /** 摘要总长上限（字符） */
  maxSummaryChars: number;
}

export interface TierSpec {
  id: TierId;
  order: number;
  label: { zh: string; en: string };
  /** 适用场景（控制栏区块 B 每档一行） */
  useWhen: { zh: string; en: string };
  /** 代价：控制栏按实际数值展示，不做定性宣传（§4.2："深"只表示余量更大、压缩更保守） */
  tradeoff: { zh: string; en: string };
  /** 生效值：0.5.2 起全部为「未设置 = 不限制」，由用户 limits 覆盖 */
  values: TierValues;
  /** 参考值（**不生效**，仅控制栏/文档示例；用户想用就把它们写进 limits） */
  reference: TierValues;
}

/** 「未设置」档位值：所有上限 0（不限制）。 */
export const UNSET_TIER_VALUES: TierValues = {
  maxSteps: 0,
  maxInputTokens: 0,
  compactAggressiveness: 'balanced',
  peekBudgetChars: 0,
  keepRecent: 0,
  maxSummaryChars: 0,
};

export const TIER_SPECS: readonly TierSpec[] = [
  {
    id: 'light',
    order: 1,
    label: { zh: '轻', en: 'Light' },
    useWhen: { zh: '单文件小改、问答。', en: 'Single-file edits, Q&A.' },
    tradeoff: { zh: '默认对齐 thinkflow 数值面；仅压缩强度 aggressive。', en: 'thinkflow-aligned numbers; aggressive compaction.' },
    values: { ...UNSET_TIER_VALUES },
    // 0.6.1：参考值对齐 thinkflow 出厂预设；maxSteps 一律 0（不限制，轮数上限已移除）。
    reference: { maxSteps: 0, maxInputTokens: 0, compactAggressiveness: 'aggressive', peekBudgetChars: 0, keepRecent: 30, maxSummaryChars: 16_000 },
  },
  {
    id: 'standard',
    order: 2,
    label: { zh: '标准', en: 'Standard' },
    useWhen: { zh: '默认档。', en: 'Default.' },
    tradeoff: { zh: '默认对齐 thinkflow 数值面；压缩强度 balanced。', en: 'thinkflow-aligned numbers; balanced compaction.' },
    values: { ...UNSET_TIER_VALUES },
    reference: { maxSteps: 0, maxInputTokens: 0, compactAggressiveness: 'balanced', peekBudgetChars: 0, keepRecent: 30, maxSummaryChars: 16_000 },
  },
  {
    id: 'deep',
    order: 3,
    label: { zh: '深', en: 'Deep' },
    useWhen: { zh: '跨模块改造、需要保留更多历史。', en: 'Cross-module changes; keep more history.' },
    tradeoff: { zh: '默认对齐 thinkflow 数值面；压缩强度最保守。', en: 'thinkflow-aligned numbers; most conservative compaction.' },
    values: { ...UNSET_TIER_VALUES },
    reference: { maxSteps: 0, maxInputTokens: 0, compactAggressiveness: 'conservative', peekBudgetChars: 0, keepRecent: 30, maxSummaryChars: 16_000 },
  },
];

const TIER_BY_ID = new Map<string, TierSpec>(TIER_SPECS.map((t) => [t.id, t]));

export function getTier(id: unknown): TierSpec {
  return (isTierId(id) ? TIER_BY_ID.get(id) : undefined) ?? TIER_BY_ID.get(DEFAULT_TIER)!;
}

export function tierByOrder(order: number): TierSpec | undefined {
  return TIER_SPECS.find((t) => t.order === order);
}

/** 旧四模式的 budgetTokens 观测阈值（§4.5.3：沿用 lean 的 60k，仅作告警阈值）。 */
export const DEFAULT_BUDGET_TOKENS_OBSERVE = 60_000;

// ---------------------------------------------------------------------------
// 旧四模式别名（§4.4）：读旧配置时按映射执行并输出一行 warn。
// 保留一个 minor（0.5.x），0.6.0 移除。
// ---------------------------------------------------------------------------

export const LEGACY_MODE_IDS = ['balanced', 'lean', 'compat', 'power'] as const;
export type LegacyModeId = (typeof LEGACY_MODE_IDS)[number];

export const LEGACY_MODE_ALIAS: Readonly<Record<LegacyModeId, { channel: ChannelId; tier: TierId }>> = {
  balanced: { channel: 'standard', tier: 'standard' },
  lean: { channel: 'standard', tier: 'light' },
  compat: { channel: 'standard', tier: 'deep' },
  power: { channel: 'code', tier: 'standard' },
};

/** 是否旧模式 id（别名检测；新轴值返回 false）。 */
export function isLegacyModeId(value: unknown): value is LegacyModeId {
  return typeof value === 'string' && (LEGACY_MODE_IDS as readonly string[]).includes(value);
}

export interface LegacyAliasResult {
  channel: ChannelId;
  tier: TierId;
  /** true = 值是旧模式 id，已被别名映射（调用方负责输出 warn） */
  aliased: boolean;
}

/**
 * 把"模式或通道"字符串解析为 (channel, tier)：
 *  - 新轴值（standard/light/deep 等歧义值不允许直接传模式槽）——本函数只用于旧模式槽位；
 *  - 旧模式 id → LEGACY_MODE_ALIAS 映射，aliased=true（调用方 warn）；
 *  - 未知值 → 默认 (standard, standard)，aliased=false。
 */
export function resolveLegacyMode(value: unknown): LegacyAliasResult {
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
export function reverseLegacyMode(channel: ChannelId, tier: TierId): LegacyModeId | undefined {
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
  return CHANNEL_SPECS.map(({ id, order, label, tagline, useWhen, tradeoff }) => ({
    id, order, label, tagline, useWhen, tradeoff,
  }));
}

export function publicTierCatalog() {
  return TIER_SPECS.map(({ id, order, label, useWhen, tradeoff, values, reference }) => ({
    id, order, label, useWhen, tradeoff, values, reference,
    /** 0.5.2：生效值需要用户 limits 定义；本字段只说明"默认不限制" */
    unset: true,
  }));
}

/**
 * 旧模式别名目录投影：四条映射（alias 目标），供配置迁移与诊断对照。
 */
export function publicLegacyModeCatalog() {
  return (LEGACY_MODE_IDS as readonly LegacyModeId[]).map((id, index) => {
    const mapped = LEGACY_MODE_ALIAS[id];
    return {
      id,
      order: index + 1,
      aliasTarget: mapped,
    };
  });
}
