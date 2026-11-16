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

export const MODE_IDS = ['balanced', 'lean', 'compat', 'power']         ;
                                               

export const DEFAULT_MODE         = 'balanced';

/**
 * 相对省 token 幅度（定性档位，不是百分比）。
 *
 * 为什么不写死百分比：只有"默认参数 vs 原生 loop"有过两臂实测（v0.1.0，十任务，
 * 约 29%），其余模式没有单独评测。把没测过的幅度写成百分比比不写更糟——用户会拿它
 * 做预算。所以这里只给方向与档位，定量证据在 note 里注明来源与"未单独实测"。
 */
                                                                

/** 可用性：默认模式 / 开箱可用 / 依赖宿主能力。 */
                                                                 

export const SAVING_TEXT                                                 = {
  most: { zh: '最高档（数据加工最省）', en: 'highest (best on data tasks)' },
  more: { zh: '较高（比默认更省）', en: 'higher (more than default)' },
  // 29% 是"用了原生 loop 的 29%"，不是"省了 29%"；行内写全，避免被反读。
  baseline: { zh: '基准（约为原生 loop 的 29%）', en: 'baseline (29% of native loop)' },
  least: { zh: '最低档（比默认略高）', en: 'lowest (above default)' },
};

export const AVAILABILITY_TEXT                                                       = {
  default: { zh: '默认模式，装好即用', en: 'Default, works out of the box' },
  ready: { zh: '开箱可用，无前置', en: 'Ready, no prerequisites' },
  'needs-ptc': { zh: '需宿主 PTC（无则回落）', en: 'Needs host PTC (falls back)' },
};

/** 一个模式对驱动器配置的落点（字段名与 LoopEntryConfig / StreamDriverConfig 对齐）。 */
                                  
                                                             
                                       
                                                                             
                               
                                                
                           
                  
                               
                      
                       
                                               
                        
 

                           
             
                             
                
                                    
               
                                      
                         
                                      
                    
                                       
                         
                     
                               
                                 
                                       
                                   
                          
 

export const MODES                      = [
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
    saving: 'baseline',
    availability: 'default',
    note: {
      zh: '不动任何配置就是它。相对原生 loop 实测约 29% token（v0.1.0 十任务两臂），本版参数与之一致。',
      en: 'This is what you get without touching any config. Measured at ~29% of the native loop tokens (v0.1.0, 10 tasks, two arms); this version keeps those defaults.',
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
    saving: 'more',
    availability: 'ready',
    note: {
      zh: '比默认更省：60k 阶梯 + 并行 2 + 不声明 tf-code，长会话差距最明显。未单独实测，属方向性判断。',
      en: 'Saves more than the default: 60k ladder, parallelism 2, no tf-code. The gap widens in long sessions. Not separately benchmarked — this is a directional call.',
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
    saving: 'least',
    availability: 'ready',
    note: {
      zh: '省得最少：恢复全文回验、并行降到 1；即使如此仍低于原生 loop，因为单流协议本身在省。未单独实测。',
      en: 'Saves least: full read-back is back and parallelism drops to 1. Even so it stays below the native loop — the single-stream protocol itself is where the saving comes from. Not separately benchmarked.',
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
    saving: 'most',
    availability: 'needs-ptc',
    note: {
      zh: '数据加工类任务省最多（结果句柄化，中间结果不进上下文）；普通读写任务反而略高于默认。宿主无 PTC 时自动回落为默认参数。未单独实测。',
      en: 'Saves most on data-processing tasks (results are handle-ized, intermediates never enter context); on plain read/write tasks it costs slightly more than the default. Falls back to default parameters without a host PTC runtime. Not separately benchmarked.',
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

const BY_ID = new Map                  (MODES.map((m) => [m.id, m]));

/**
 * 对外模式目录（终端 --json / 桌面页路由 / 页面渲染共用**同一份投影**）。
 *
 * 之前 loop 与 ui/index.js 各写一份 map，加字段时漏一处就会出现"CLI 有标注、页面没有"
 * 的错位。投影只放展示需要的字段，`config` 不进网络载荷（页面不靠它推断行为）。
 */
export function publicModeCatalog() {
  return MODES.map(({ id, order, label, tagline, useWhen, tradeoff, saving, availability, note }) => ({
    id,
    order,
    label,
    tagline,
    useWhen,
    tradeoff,
    saving,
    savingLabel: SAVING_TEXT[saving],
    availability,
    availabilityLabel: AVAILABILITY_TEXT[availability],
    note,
  }));
}

export function isModeId(value         )                  {
  return typeof value === 'string' && BY_ID.has(value);
}

/** 取模式定义；未知值回落到默认模式（fail-open：控制栏永远渲染得出来）。 */
export function getMode(id         )           {
  return (isModeId(id) ? BY_ID.get(id) : undefined) ?? BY_ID.get(DEFAULT_MODE) ;
}

/** 按序号取模式（1-4；越界返回 undefined）。 */
export function modeByOrder(order        )                       {
  return MODES.find((m) => m.order === order);
}

/**
 * 模式 → 显式配置覆盖。
 *
 * 语义是"模式提供默认值"，调用方用 `??` 让用户/装配显式写的值优先：
 * 显式配置永远压过模式，模式压过代码内置默认。
 */
export function modeConfig(id         )                  {
  return { ...getMode(id).config };
}
