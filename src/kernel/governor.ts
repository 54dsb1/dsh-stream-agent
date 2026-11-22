// kernel/governor.ts —— 双旋钮预算治理（0.5.0 P3；计划书 §4.5）
//
// 控制变量由 1 个（累计 budgetTokens）改为 2 个正交上限（K4）：
//   · maxInputTokens（C 上限）：单请求上下文上限 → 触顶触发压缩（压缩旧段并记录 handle）；
//   · maxSteps（N 上限）：单任务请求数上限 → 触顶停止探索、注入收束指令要求 tf-final
//     （代码通道下为要求返回结果）。
// budgetTokens 降为**观测项**：超过阈值时写 warn 与报表，不改变执行行为（D7 修复：
// 缓存命中不再加速降级——缓存命中越好越早降级的方向性错误就此消除）。
// 上游 thinkflow 的分层与本节一致：C 管窗口（max_input_tokens）、N 管步数（max_run_turns）。
//
// 下限保护（§4.5.3 / R11）：任务级预算低于 3×前缀估算（estimatePromptTokens）时拒绝启动，
// 返回"至少需要 N"的明确提示——避免一个必然失败的任务烧掉整个前缀。
//
// 内核层纪律：纯函数、零 IO、无框架依赖。

import type { CompactAggressiveness } from './compaction.ts';

export interface GovernorLimits {
  /** 单请求上下文上限（token 估算；0 = 不压缩，仅观测）。 */
  maxInputTokens: number;
  /** 单任务请求数上限（0 = 无上限，仅观测）。 */
  maxSteps: number;
  /** 压缩强度：决定触发压缩的填充率阈值。 */
  aggressiveness: CompactAggressiveness;
  /** 观测预算（token；0/undefined = 不告警）。超阈值写 warn 与报表，不改行为。 */
  budgetTokens?: number;
}

/** 触发压缩的填充率阈值（按 aggressiveness 分档）。 */
const COMPACT_TRIGGER_RATIO: Record<CompactAggressiveness, number> = {
  aggressive: 0.5,
  balanced: 0.7,
  conservative: 0.9,
};

export interface CompactDecision {
  compact: boolean;
  /** 当前估算 / maxInputTokens（maxInputTokens=0 时为 0）。 */
  fillRatio: number;
  /** 本档的触发阈值。 */
  triggerRatio: number;
  /** 压缩目标：把估算压回该 token 数以下（触发阈值 × maxInputTokens × 0.8）。 */
  targetTokens: number;
  reason: string;
}

/**
 * 压缩判定（纯函数）：estimatedTokens ≥ triggerRatio × maxInputTokens 时触发。
 * maxInputTokens = 0 → 永不压缩（回退点：`maxInputTokens` 取消 = 无上限仅观测）。
 */
export function shouldCompact(estimatedTokens: number, limits: GovernorLimits): CompactDecision {
  const maxInput = Math.max(0, limits.maxInputTokens);
  const triggerRatio = COMPACT_TRIGGER_RATIO[limits.aggressiveness];
  const fillRatio = maxInput > 0 ? estimatedTokens / maxInput : 0;
  const compact = maxInput > 0 && estimatedTokens >= Math.ceil(maxInput * triggerRatio);
  return {
    compact,
    fillRatio: Math.round(fillRatio * 1000) / 1000,
    triggerRatio,
    targetTokens: Math.floor(maxInput * triggerRatio * 0.8),
    reason: compact
      ? `estimated ${estimatedTokens} tokens ≥ ${triggerRatio} × maxInputTokens ${maxInput}`
      : `estimated ${estimatedTokens} tokens below trigger ${Math.ceil(maxInput * triggerRatio)}`,
  };
}

export interface StepDecision {
  /** true = 已达步数上限（停止探索，注入收束指令）。 */
  atLimit: boolean;
  /** 剩余步数（0 = 已触顶；maxSteps=0 → Infinity）。 */
  remaining: number;
  reason: string;
}

/** 步数判定：stepsTaken ≥ maxSteps → 触顶（收束而非硬杀）。maxSteps = 0 → 无上限。 */
export function shouldStopForSteps(stepsTaken: number, limits: GovernorLimits): StepDecision {
  const maxSteps = Math.max(0, limits.maxSteps);
  if (maxSteps === 0) {
    return { atLimit: false, remaining: Number.POSITIVE_INFINITY, reason: 'maxSteps=0（无上限，仅观测）' };
  }
  const atLimit = stepsTaken >= maxSteps;
  return {
    atLimit,
    remaining: Math.max(0, maxSteps - stepsTaken),
    reason: atLimit ? `本任务请求数已达上限 ${maxSteps}（maxSteps）` : `${stepsTaken}/${maxSteps} 请求`,
  };
}

/** 观测预算判定（budgetTokens 只告警不改行为——D7 修复的落点）。 */
export function observeBudget(spentTokens: number, budgetTokens: number | undefined): { warn: boolean; ratio: number } | null {
  if (budgetTokens === undefined || budgetTokens <= 0) return null;
  const ratio = spentTokens / budgetTokens;
  return { warn: ratio >= 0.9, ratio: Math.round(ratio * 100) / 100 };
}

// ---------------------------------------------------------------------------
// 下限保护（§4.5.3 / R11）
// ---------------------------------------------------------------------------

/** 前缀估算的安全倍率：任务级预算必须 ≥ 3×前缀估算，否则任务必然失败。 */
export const TASK_BUDGET_FLOOR_RATIO = 3;

export interface TaskBudgetCheck {
  ok: boolean;
  /** 需要的最小 maxInputTokens（3×前缀估算；ok=true 时为 0）。 */
  minimumInputTokens: number;
  reason: string;
}

/**
 * 任务启动前的预算下限检查。
 * @param prefixEstimateTokens 前缀（稳定段）token 估算（estimatePromptTokens 口径）
 * @param maxInputTokens 任务级/会话级 C 上限（0 = 无上限 → 不拦截）
 */
export function checkTaskBudgetFloor(prefixEstimateTokens: number, maxInputTokens: number): TaskBudgetCheck {
  if (maxInputTokens <= 0) {
    return { ok: true, minimumInputTokens: 0, reason: 'maxInputTokens=0（无上限）' };
  }
  const minimum = Math.ceil(prefixEstimateTokens * TASK_BUDGET_FLOOR_RATIO);
  if (maxInputTokens < minimum) {
    return {
      ok: false,
      minimumInputTokens: minimum,
      reason: `预算下限保护：maxInputTokens ${maxInputTokens} 低于 3×前缀估算 ${minimum}`
        + `（前缀 ${prefixEstimateTokens} tokens）——该任务必然触顶，拒绝启动。请提高档位（tier）`
        + `或用任务指令 [tf-budget: ...k] 显式放宽。`,
    };
  }
  return { ok: true, minimumInputTokens: 0, reason: `maxInputTokens ${maxInputTokens} ≥ 3×前缀估算 ${minimum}` };
}
