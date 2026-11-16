// kernel/modes.ts ： 插件运行模式目录（v0.2.1 控制栏的事实来源）
//
// 设计约束：
//   1. 零框架依赖：不 import 任何 @deepseek-ai/*，也不碰 fs ： 拷出 kernel/ 可单测。
//   2. 每个模式只映射**已存在**的驱动器/入口配置项（selfReadFeedback、enableCode、
//      persistFallback、maxParallelToolCalls、maxReentries、budgetTokens），
//      不新增运行期行为：模式是"给新人看的预设"，不是第二套开关。
//   3. 四种模式覆盖同一条权衡轴：省 token ↔ 可读/可排障。
//      balanced 与 v0.2.0 的出厂默认逐项等价（唯一的例外是显式写死，见下）。
//
// 为什么是四个：新用户只需要回答两个问题："我要不要极限省钱"、"我要不要程序化
// 数据加工"。两个问题给出四象限，正好四种模式；再多就需要读文档了，与"帮新人上手"
// 的目标相反。

export const MODE_IDS = ['balanced', 'lean', 'compat', 'power'] as const;
export type ModeId = (typeof MODE_IDS)[number];

export const DEFAULT_MODE: ModeId = 'balanced';

/** 一个模式对驱动器配置的落点（字段名与 LoopEntryConfig / StreamDriverConfig 对齐）。 */
export interface ModeConfigPatch {
  /** O7 自写回验：'receipt' = 读自己刚写过的文件只回回执；'full' = v0.1 全文回灌 */
  selfReadFeedback: 'receipt' | 'full';
  /** tf-code（PTC 桥接）：'auto' = 宿主有 ctx.ptcRuntime 就启用；false 强制关闭；true 强制声明 */
  enableCode: 'auto' | boolean;
  /** 宿主缺 storage/sessionPersistence 时的本地文件兜底 */
  persistFallback: boolean;
  /** 独立命令并行度上限 */
  maxParallelToolCalls: number;
  /** 最大重入次数（防震荡护栏） */
  maxReentries: number;
  /** 任务级 token 预算（O5 阶梯分母）；undefined = 阶梯关闭 */
  budgetTokens?: number;
}

export interface ModeSpec {
  id: ModeId;
  /** 控制栏里的序号（1-4），按键直接选模式 */
  order: number;
  label: { zh: string; en: string };
  /** 一句话是什么 */
  tagline: { zh: string; en: string };
  /** 什么时候选它（新人最需要的一列） */
  useWhen: { zh: string; en: string };
  /** 代价 / 需要注意什么 */
  tradeoff: { zh: string; en: string };
  config: ModeConfigPatch;
}

export const MODES: readonly ModeSpec[] = [
  {
    id: 'balanced',
    order: 1,
    label: { zh: '均衡', en: 'Balanced' },
    tagline: {
      zh: '出厂默认：该省的省，该看的看得见。',
      en: 'Factory default: saves where it is safe, keeps what you need to see.',
    },
    useWhen: {
      zh: '第一次用，日常读写与查改任务、不确定选哪个时：先用它。',
      en: 'First run, everyday read/write and lookup tasks, or when unsure: start here.',
    },
    tradeoff: {
      zh: '写批任务仍会出现"读自己刚写的文件只回回执"，需要全文时用 tf-peek 按行段取。',
      en: 'Write-batch tasks get a receipt instead of full echo when re-reading your own file; use tf-peek for line ranges.',
    },
    config: {
      selfReadFeedback: 'receipt',
      enableCode: 'auto',
      persistFallback: true,
      maxParallelToolCalls: 3,
      maxReentries: 8,
    },
  },
  {
    id: 'lean',
    order: 2,
    label: { zh: '精简', en: 'Lean' },
    tagline: {
      zh: '省钱优先：预算阶梯提前介入，注入更克制。',
      en: 'Cost-first: the budget ladder engages early and injections stay minimal.',
    },
    useWhen: {
      zh: '长会话、批量脚本、读查为主且答案明确的任务；token 账单敏感时。',
      en: 'Long sessions, batch scripts, read-heavy tasks with a clear answer, or when the token bill matters.',
    },
    tradeoff: {
      zh: '预算 60k 触发降级：70% 后只注高增益观测，90% 后只收 tf-final，可能牺牲细节。',
      en: 'A 60k budget triggers degradation: after 70% only high-gain observations, after 90% only tf-final. Detail may suffer.',
    },
    config: {
      selfReadFeedback: 'receipt',
      enableCode: false,
      persistFallback: true,
      maxParallelToolCalls: 2,
      maxReentries: 6,
      budgetTokens: 60_000,
    },
  },
  {
    id: 'compat',
    order: 3,
    label: { zh: '兼容', en: 'Compat' },
    tagline: {
      zh: '可读优先：最接近原生回合制的观感，命令串行执行。',
      en: 'Visibility-first: closest to the native turn-based feel, commands run serially.',
    },
    useWhen: {
      zh: '行为看着不对、要跟原生 loop 对照、第三方工具依赖完整读回时。',
      en: 'Behavior looks off, you are diffing against the native loop, or a third-party tool needs full read-back.',
    },
    tradeoff: {
      zh: 'token 最高：写后回验恢复全文注入，并行度降到 1，速度也更慢。',
      en: 'Highest token cost: self-write read-back returns full text again and parallelism drops to 1, so it is slower.',
    },
    config: {
      selfReadFeedback: 'full',
      enableCode: false,
      persistFallback: true,
      maxParallelToolCalls: 1,
      maxReentries: 12,
    },
  },
  {
    id: 'power',
    order: 4,
    label: { zh: '增强', en: 'Power' },
    tagline: {
      zh: '程序化加工：单流里直接写 tf-code 程序处理重数据。',
      en: 'Programmatic: write tf-code programs inside the single stream for heavy data.',
    },
    useWhen: {
      zh: '多步数据加工（过滤/统计/变换/聚合）、大日志分析，且宿主机有 PTC runtime。',
      en: 'Multi-step data work (filter/aggregate/transform) or large-log analysis, with a host PTC runtime available.',
    },
    tradeoff: {
      zh: '宿主没有 ctx.ptcRuntime 时 tf-code 通道自动关闭（协议不声明）；协议段更长，固定成本略高。',
      en: 'Without ctx.ptcRuntime the tf-code channel stays off and is not declared; the protocol section is longer, so fixed cost is higher.',
    },
    config: {
      selfReadFeedback: 'receipt',
      enableCode: true,
      persistFallback: true,
      maxParallelToolCalls: 3,
      maxReentries: 10,
    },
  },
];

const BY_ID = new Map<string, ModeSpec>(MODES.map((m) => [m.id, m]));

export function isModeId(value: unknown): value is ModeId {
  return typeof value === 'string' && BY_ID.has(value);
}

/** 取模式定义；未知值回落到默认模式（fail-open：控制栏永远渲染得出来）。 */
export function getMode(id: unknown): ModeSpec {
  return (isModeId(id) ? BY_ID.get(id) : undefined) ?? BY_ID.get(DEFAULT_MODE)!;
}

/** 按序号取模式（1-4；越界返回 undefined）。 */
export function modeByOrder(order: number): ModeSpec | undefined {
  return MODES.find((m) => m.order === order);
}

/**
 * 模式 → 显式配置覆盖。
 *
 * 语义是"模式提供默认值"，调用方用 `??` 让用户/装配显式写的值优先：
 * 显式配置永远压过模式，模式压过代码内置默认。
 */
export function modeConfig(id: unknown): ModeConfigPatch {
  return { ...getMode(id).config };
}
