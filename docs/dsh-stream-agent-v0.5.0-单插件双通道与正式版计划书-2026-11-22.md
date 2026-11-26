# dsh-stream-agent 0.5.0 升级计划书

| 项 | 值 |
|---|---|
| 文档性质 | 实施计划（架构决策、阶段排期、验收门禁） |
| 目标版本 | `@hugesb/dsh-stream-agent` 0.5.0，单包，不新增插件包 |
| 计划日期 | 2026-11-22 |
| 事实基准 | 仓库 tag `v0.4.0` = `7aa0e26`（工作树干净）；宿主 `@deepseek-ai/dsh` 0.2.2-rc.3；上游 `xuxiang/thinkflow` 0.10.3（PROTOCOL 1.14） |
| 基线纪律 | 所有"现状"结论以 `v0.4.0` tag 树为准；`artifacts/dsh-stream-agent-v041` 只用于观察演进，不作基线 |
| 读者 | 实现者、评审者、发布负责人 |

---

## 0. 摘要

### 0.1 目标陈述

0.5.0 只交付一个插件包。原设想拆成"标准插件 + PTC 适配插件"的两部分能力，改为同一控制栏上的两个区块：

| 原设想 | 0.5.0 形态 |
|---|---|
| A 插件：标准通道，接管 loop，无代码通道 | 区块 A「执行通道」选 `标准` |
| B 插件：PTC 适配，不接管 loop，只治理上下文 | 区块 A 选 `代码`，区块 B 选档位 |

装载形态只有一个：接管 `agents.setFactory`，不注册执行器。执行通道与上下文档位是同一 loop 内的两组正交开关，切换在下一个用户任务生效。

发布判据不是功能数量，而是三条：架构定稿、有对照数据、可逐项回退。

### 0.2 交付物

| 交付物 | 形态 | 说明 |
|---|---|---|
| `@hugesb/dsh-stream-agent` 0.5.0 | 插件 | 唯一插件包；内核仍在 `src/kernel`，不单独发包 |
| `PROTOCOL-v1.md` | 规范 | 自有协议语义、边界、错误码，不引用上游行号 |
| `docs/channel-matrix.md` | 文档 | 三通道来源 × 能力矩阵，含让位判据 |
| `docs/upstream-delta.md` | 文档 | 与 thinkflow 的逐条差异及原因 |
| `eval/` 四臂报表 | 数据 | L0 原生 / L1 PTC 预设 / L2 标准通道 / L3 代码通道 |
| `NOTICE` | 法务 | 上游归属，依赖与派生分栏 |

### 0.3 关键决策

| # | 决策 | 依据 | 影响 |
|---|---|---|---|
| K1 | 单包单装载，不拆插件 | 唯一互斥点是 `setFactory`，全局单槽、被占用即抛错（`dsh-agent/src/index.ts:377-393`）。执行器按作用域注册，不构成第二互斥点（§0.5） | 决定发布形态 |
| K2 | 用"执行通道"轴取代 `enableCode` + `toolSurface` | `compat` 使第三方工具完全不可达（D2）、`lean` 在 `nativeTools` 下把工具面砍到 7 项（D3） | 区块 A |
| K3 | 用"上下文档位"轴取代 `budgetTokens` 预设 | 旧预设把工具面与数值捆在一起，缺陷同源；档位只改数值 | 区块 B |
| K4 | 预算由"累计 token"改为"单请求上限 + 步数上限" | 累计口径含 `cacheRead` 且按 1:1 计，缓存命中越好越早降级（D1/D7） | 新增两旋钮 |
| K5 | 与 PTC 的差异建立在"状态有地址" | PTC 状态存于程序变量，删文本即删状态；本插件状态为 handle/版本号（§5.4） | 压缩前提 |
| K6 | 代码通道三来源，优先宿主 preset | PTC 是 agent preset，不是独立插件；兼容靠"不写入对方表面" | 决定 P2 |
| K7 | 分页取回成本按 `(k−1)×C` 计，优化目标是压低 k | 每次取回是一次新请求，需重发整段上下文（§7.1） | 索引化 + span 账本 |
| K8 | 前缀非单调按三类分别处置，不采用"报错/重发"二分 | 宿主提供 `surfaceOp: replace` 作为合法换基通道（§8） | 计划性换基 |
| K9 | 上游移植按"依赖 / 语义重写 / 不搬"三分 | PTC 为 TS/MIT 可直接依赖；thinkflow 为 Python，只能搬契约与测试向量（§9） | 3,176 行必搬，6,610 行不搬 |

### 0.4 版本边界

`v0.4.0` 已发布，不再接受功能性改动，也不为已发现的缺陷单发热修。D1–D7 全部在 0.5.0 内修复或由架构调整消除。理由：0.5.0 会重写相关代码路径，热修与重写并行会产生两套实现与两套回归基线。

| 事项 | 处置 |
|---|---|
| `v0.4.0` 代码 / tag / 发布 | 冻结；不打补丁版本 |
| 已发现缺陷（§2.3） | 纳入 0.5.0 阶段计划 |
| 分支起点 | `next/0.5` 从 `v0.4.0`（`7aa0e26`）切出 |
| 0.4.0 的价值 | 可回退锚点与 benchmark 对照基线 |

### 0.5 与既有判断的更正

以下四项是 0.5.0 规划阶段作出的推断，经宿主源码核对后不成立。列出的目的是防止实现者按旧结论施工。

| 既有判断 | 源码事实 | 对计划的影响 |
|---|---|---|
| 执行器是全局单槽，两方都装则后装者静默覆盖 | `setExecutor` 按作用域注册，"Only one tool executor may be registered in each scope"（`dsh-tools/src/index.ts:328`）；查找沿作用域链上溯（`:357-366`）；卸载时保留 `record.executor = undefined` 的 fail-closed 占位（`:345-348`） | 执行器不是冲突点，不需要仲裁层 |
| 本插件需安装自有执行器才能治理工具 | `v0.4.0` 全仓无 `setExecutor` 调用（`grep -rn setExecutor src/` 为空）；根作用域的执行器由 `dsh-base` 的 `tool-executor-native` 提供（`dsh-base/cordis.patch.yml:516`） | 0.5.0 同样不注册执行器 |
| 一个包同时占用两个互斥插槽，故必须拆包 | 真正的互斥只有 loop factory 一处（`setFactory` 被占用即抛错） | "一库两插件"的前提消失，改为单包 |
| PTC 由独立插件提供，与 loop 插件平级 | PTC 是 agent preset：`dsh-web-app/presets/ptc.patch.yml` 保留原生工具并追加 `tool-executor-ptc`；preset 由会话选择，修改只影响之后创建的 Agent（`dsh-agent-preset/README.zh.md`） | 代码通道的来源取决于会话 preset，不是安装态 |

第一条的连带结论：0.5.0 不设 `executorArbitration`，不写装饰层。与 PTC 的共存靠"不写入对方拥有的表面"，而非在对方表面外包一层。

---

## 1. 目标与非目标

### 1.1 目标

| 编号 | 目标 | 可验证形式 |
|---|---|---|
| G1 | 单一装载形态下提供两种执行通道，互不污染 | 通道切换后工具面、协议段、执行器来源三项同时到位 |
| G2 | 标准通道内上下文可压缩且不丢可引用状态 | 压缩后 handle 仍可取回；重复读取率不升 >20% |
| G3 | 代码通道与 PTC 预设共存时不改写对方的任何表面 | 8 项 PTC 能力逐项验证（§5.10） |
| G4 | 与第三方插件共存不隐藏其工具 | 工具可达性探针 |
| G5 | 成本可归因 | 四臂 benchmark，N 与 C 分列（§12.1） |
| G6 | 每项新能力可独立关闭并回到 0.4.0 行为 | 回退开关演练（§12.4） |

### 1.2 非目标

- 不追求"功能数量对齐上游"。上游 43.2% 的代码属于宿主已有职责（§9.4）。
- 不改 PTC 的配额、并发、沙箱策略。这些是安全边界。
- 不在 0.5.0 实现回合内中断（`need_result` 打断流）。该项推迟到 0.6.0（§11.4）。
- 不承诺在无实测数据的条件下给出省 token 百分比。
- 不接管 session 日志写入。只通过投影、具名段落与运行时上下文贡献参与。

---

## 2. 现状

### 2.1 发布状态

| 项 | 值 |
|---|---|
| `src/version.ts` | `0.4.0` |
| tag | `v0.4.0` → `7aa0e26`，提交信息 `release(v0.4.0): stable 首发` |
| 测试文件数 | 33（`test/`） |
| 0.4.0 交付范围 | 回归修复、度量口径、验收（`tf-plan` / `accepts` / `tf-final` 过早拦截） |
| 0.4.0 未交付项 | 通道：`reasoning-delta` 仅拼接落盘（`loop.ts:2163`），不参与命令解析；全仓无围栏感知（`gate.ts` 为两段式动作准入，与围栏无关）。详见 §10 |
| 0.3.3 四项真机修复 | 均在 tag 树内：`stallReentries`、`readFeedbackBudgetPerRequest`、`findBodyClose`、`malformedCloserNudge` |

### 2.2 唯一互斥点：loop factory

当前实现的两类需求在装载期无法共存于同一形态：

```text
@hugesb/dsh-stream-agent (0.4.x)   一个包，承担两类需求

  需求 A  "自成一套协议"
    接管 loop：cordis.patch.yml 停用 @deepseek-ai/dsh-agent-loop，
    注册自有 AgentFactory

  需求 B  "与 PTC 共用"
    兼容 PTC：tf-code 桥接 ctx.ptcRuntime，模型侧只暴露有限绑定
```

`setFactory` 的语义决定了形态只能有一个：

> `dsh-agent/src/index.ts:377-393`：注册时若 `this.factory !== undefined` 直接抛出 `an agent factory is already registered`。

因此"接管 loop"与"让宿主 loop 继续工作"不是可并行开关，而是装载期二选一。0.4.x 选择始终接管，并用 `enableCode` / `toolSurface` 两个运行期开关表达需求 B，由此产生三个问题面：

| 问题面 | 代码事实 | 后果 |
|---|---|---|
| 工具面过滤 | `tool-surface.ts:125` 调 `tools.schemas(agent, toolSet)` 后按 profile 裁剪 | `off` 档第三方工具完全不可达；`core` 档在 `nativeTools` 开启时只剩 7 项 |
| 协议段与工具面耦合 | 协议段文案随 `enableCode` 变化 | 开关一变即破前缀，且两者无法独立治理 |
| 预算由模式派生 | `loop.ts:4752-4766` 显式 config > 环境变量 > `control.json` > 默认 | 预算不可单独设置，只能换模式 |

执行器不在其中：0.4.x 从未注册执行器，`tf-code` 走的是 `ctx.ptcRuntime` 桥接（`src/entry/ptc-bridge.ts`），与 `tool-executor-ptc` 无调用关系。

结论：互斥点在 loop，不在执行器。单包方案成立的前提是把"形态差异"下沉到 loop 内部的两组开关，而不是在包一级拆开。

### 2.3 已知缺陷与处置

| # | 缺陷 | 证据（`v0.4.0` tag 树） | 处置 |
|---|---|---|---|
| D1 | 预算基数为会话累计，其余护栏为回合级。会话累计越过 90% 阈值后，同会话后续任务每回合只允许 1 次请求，随后强制兜底交付 | `loop.ts:844`（`#usage` 仅初始化一次，无重置）；`loop.ts:1256`（`budgetLevel()` 用累计值）；`loop.ts:1417`（注释声明护栏按回合重置）；`loop.ts:1748`（`finalOnlyGate`）；`loop.ts:1854`（注入 `[tf-stream:degraded]`） | 0.5.0 修复（§4.5） |
| D2 | `compat` 档（`toolSurface: 'off'`）同时关闭 `tf-call`，第三方工具完全不可达 | `tool-surface.ts:160`（`profile === 'off' \|\| callCommand === false`）；`tool-surface.ts:187` | 删除该档（§4.3） |
| D3 | `lean` 档（`toolSurface: 'core'`）在 `nativeTools: true` 时只声明 7 项白名单工具 | `tool-surface.ts:40`（`CORE_TOOLS`）；`tool-surface.ts:187` | 删除该档（§4.3） |
| D4 | read 截断取"头部 N 字符"，答案通常不在头部，必然触发取回 | `loop.ts:2367`（`content.slice(0, limit)`） | 索引化（§7.3） |
| D5 | 取回无已投递区间账本，仅计数，重复取回同一区间会重复付费 | `obs.ts:419`（`peek(handle, fromLine, toLine)`）；`obs.ts:422`（`peekedTotal++`） | span 账本（§7.3） |
| D6 | `readFeedbackLimit` 一个参数同时承担"读取多少"与"注入多少" | 默认 8000 字符 | 拆为两旋钮（§7.5） |
| D7 | 预算把 `cacheRead` 按 1:1 计入。缓存命中率高时会更快触发降级，方向与成本相反 | `loop.ts:1261`（`billedInput = input + cacheRead + cacheWrite`） | `budgetTokens` 降为观测（§4.5） |

D1 的可观测后果举例：`lean` 档预算 60k、70%/90% 阈值，上下文 12k 时约 4 次请求即达 54k；此后同一会话第二个任务开局即处于 `final-only`，一次请求后进入兜底交付。该行为需在 P0 阶段用真机会话复现确认（§15 第 3 项）。

### 2.4 宿主提供的五条接缝

| 接缝 | 机制 | 能力 | 代价 | 证据 |
|---|---|---|---|---|
| S1 loop factory | `ctx.agents.setFactory(factory)` | 完全控制回合、消息、注入、时序 | 全局单槽，与其他 loop 插件互斥 | `dsh-agent/src/index.ts:377`；`dsh-agent-loop/src/index.ts:335` |
| S2 session surface | ①`sessionProjections.register()` 运行期注册派生视图；②自有事件类型 + `SessionMessageProjection` + `surfaceOp` | ②可改写模型可见消息，日志不动 | ②需类型级声明；无回合控制 | `dsh-session/src/surface.ts`；`dsh-session-projection/src/index.ts` |
| S3 executor | `ctx.tools.setExecutor`（按作用域） | 替换本作用域的工具执行 | 同作用域重复注册抛错；本插件不使用 | `dsh-tools/src/index.ts:325-349` |
| S4 system section | `ctx.systemPrompt.section({name, order, text})` | 追加具名段落 | 改 system 即破前缀，须走换基 | `dsh-system-prompt/src/index.ts:485` |
| S5 runtime context | `ctx.systemPrompt.context(...)` → 宿主 loop 以快照消息下发并 supersede 旧快照 | 下发会变化的状态，语义自带版本替换 | 仍属消息替换，计入换基 | `dsh-system-prompt/src/index.ts:520`；`dsh-agent-loop/src/runtime-context.ts` |

S5 是代码通道下唯一可用的注入通道：不接管 loop 时无法在流内插入消息，但 `context` 贡献由宿主 loop 自行渲染成 `runtime-context` 快照，旧快照被替换而非追加，因此不会造成前缀无限增长。

约束：`llm/stream` 是 waterfall，但契约为只读。

> `dsh-llm/src/index.ts:70-71`："(mutation throws): its content is a pure function of the session log (the reconstructability Agent Note), so **listeners read it, never rewrite it**."

会话派生请求带 mutation 标记，改写会抛错。因此上下文压缩只有两条合法路径：S1（接管 loop 自装配）或 S2 第二层（消息投影）。单包方案两条都要用：标准通道走 S1，代码通道走 S2 + S5。

S2 的两层不可混用：

| 层 | API | 能力 | 能否改写消息 |
|---|---|---|---|
| 派生视图 | `sessionProjections.register({key, init, apply, wire})` | 从事件流派生视图，支持运行期注册 | 否 |
| 消息投影 | 自有事件类型 + `@messageProjection` + `surfaceOp: replace` | 将一段历史节点替换为摘要 | 是，但需类型级声明 |

### 2.5 上游能力基线

| 项目 | 版本 | 语言 | 规模 | 许可 |
|---|---|---|---|---|
| `xuxiang/thinkflow` | 0.10.3（PROTOCOL 1.14） | Python | 47 模块 / 15,299 行 | MIT |
| `dsh-ptc-runtime` | 随宿主 0.2.2-rc.3 | TypeScript | 343 行 | MIT |
| `dsh-ptc-runtime-node` | 同上 | TypeScript | 3,274 行 | MIT |
| `dsh-tool-executor-ptc` | 同上 | TypeScript | 2,338 行 | MIT |

---

## 3. 目标架构

### 3.1 单包结构

```text
@hugesb/dsh-stream-agent 0.5.0
一个包，一个装载形态

  src/kernel/   parser obs render final modes protocol plan
                纯函数、零 IO、零 @deepseek-ai/* 依赖
  src/entry/    loop tool-surface control-bar ptc-bridge state
  ui/           桌面控制页（两个区块）

  接管：   agents.setFactory（唯一）
  不接管： tools.setExecutor（根作用域已有 tool-executor-native）
  不接管： session 日志写入（只用投影与 section/context 贡献）
```

通道差异集中在三件事：工具面、协议段、是否解析模型输出；逐项对照见 §3.2。两个通道共用一半以上代码——压缩、摘要、前缀、度量、记账是同一套实现。

### 3.2 双通道能力矩阵

| 能力 | 标准 | 代码（preset） | 代码（bridge，降级） |
|---|---|---|---|
| 模型可见工具 | `tf-*` + 宿主工具透传 | preset 决定，本插件不注册 | 仅 `tf-code` |
| 协议段字符数 | 完整 | 0 | 约 200（只写 `tf-code` 用法） |
| 命令解析 | 是（`<tf-*>`） | 否 | 有限（`tf-code` 块） |
| 验收闸（拒绝收敛） | 是 | 否，降级为状态提示 | 否 |
| 回合内注入 | 是 | 否（仅 S5 快照） | 否（仅 S5 快照） |
| 状态摘要 | 是 | 是（S5） | 是（S5） |
| 效果压缩 | 按程序/调用 | 按程序 | 按调用 |
| 原文取回 | `tf-peek` + span 账本 | 程序内读取，无 peek | 程序内读取，无 peek |
| 执行器来源 | `dsh-base` native | `dsh-tool-executor-ptc` | `ctx.ptcRuntime` 桥接 |
| 依赖 | 无 | 会话 preset 含 PTC | `ptcRuntime` 服务存在 |
| 不可用时的行为 | — | 降级到 bridge | 拒绝进入，回退标准 |

### 3.3 控制栏两个区块

```text
控制栏 ──────────────────────────── 接管生效 · 执行器 native · 工具面 透传

① 执行通道
   [ 标准 ]  tf-* 原生工具，协议段注入，可验收
   [ 代码 ]  单一 run_code 入口，协议段 0 字符
   来源：preset-ptc 完整兼容 · 内置窄桥（受限）· 不可用

② 上下文档位
   [ 轻 ]  [ 标准 ]  [ 深 ]
   maxSteps 16/24/40 · maxInputTokens 12k/20k/48k
   压缩 aggressive/balanced/conservative · 高级：取回预算 / 前缀策略 / 重复抑制

状态：本任务 N=0 · 换基 0 · 重复取回 0/0 · 摘要 0 段
```

区块 A 指 ①，区块 B 指 ②。

设计约束：

1. 区块 A 不出现"PTC 模式"字样。用户选择的是模型看到什么（原生工具 / 单一入口），"依赖 PTC"是结果不是选项。
2. 区块 B 只改数值，不改工具面、不改并行度、不改执行器。这是与旧四模式的根本区别（D2/D3 的成因正是预设顺手改了工具面）。
3. 两个区块都可回退：区块 A 回退到 `标准` 即 0.4.0 的 `balanced` 行为面；区块 B 回退到 `标准` 即 0.4.0 数值面。
4. 通道切换 = 工具面变化 = 计划性换基（§8.3），必须记账并在模型侧可见一行说明。
5. 切换在下一个用户任务生效；任务进行中提交的切换请求排队，不中断当前任务。

### 3.4 备选方案否决记录

| 方案 | 否决理由 |
|---|---|
| 拆为两个插件包（A/B） | 前提不成立：执行器不是互斥点，`setFactory` 是唯一互斥点；且两包共享内核会产生漂移 |
| 装载期双形态（一个包两份 patch，切换需重启） | 形态差异其实全部落在 loop 内部开关上，不需要第二个装载形态；引入 profile patch 编辑与重启成本，收益为零 |
| 运行期卸载内建 loop 再接管 | 依赖 loader 的内部卸载顺序；卸载期间 factory 为空，`requireFactory()` 抛错会让并发创建失败 |
| 在本插件内实例化宿主 loop | 会重复注册服务，且与 preset 的作用域隔离冲突 |
| 单通道 + 开关（0.4.x 现状） | 即 D2/D3 的来源：一个预设同时改工具面与数值，两者无法独立治理 |
| 一包一通道，另一通道留给 PTC 预设 | 用户在无 PTC 的部署上失去代码通道；且代码通道下本插件的压缩能力无处施加 |

---

## 4. 控制面

### 4.1 现状

`src/kernel/modes.ts:15`：

```ts
export const MODE_IDS = ['balanced', 'lean', 'compat', 'power'] as const;
```

四档参数：

| 模式 | selfReadFeedback | enableCode | 并行 | maxReentries | budgetTokens | toolSurface |
|---|---|---|---|---|---|---|
| balanced | receipt | false | 3 | 12 | — | standard |
| lean | receipt | false | 2 | 8 | **60k** | **core** |
| compat | **full** | false | 1 | 16 | — | **off** |
| power | receipt | true | 3 | 14 | — | standard |

控制状态只有两个字段（`control-bar.ts:333`：`{ mode, lang }`），预算由模式派生，不可单独设置。

### 4.2 决策：四档变两轴

| 轴 | 取值 | 影响 | 不影响的 |
|---|---|---|---|
| 执行通道 | `standard` / `code` | 工具面、协议段、命令解析、验收闸、执行器来源 | 预算、压缩、取回 |
| 上下文档位 | `light` / `standard` / `deep` | `maxSteps`、`maxInputTokens`、压缩强度、取回预算、保留条数 | 工具面、并行度、执行器、协议段 |

档位定义：

| 档位 | maxSteps | maxInputTokens | compactAggressiveness | peekBudgetChars | keepRecent | maxSummaryChars | 适用 |
|---|---|---|---|---|---|---|---|
| 轻 | 16 | 12,000 | aggressive | 12,000 | 12 | 8,000 | 单文件小改、问答 |
| 标准 | 24 | 20,000 | balanced | 24,000 | 30 | 16,000 | 默认 |
| 深 | 40 | 48,000 | conservative | 48,000 | 60 | 32,000 | 跨模块改造、需要保留更多历史 |

"深"不表示更强，只表示给上下文更多余量、压缩更保守，代价是单请求更贵。控制栏对每一档显示步数、上下文上限与压缩强度三项实际数值，不做定性宣传。

### 4.3 删除旧四档的依据

1. **D2 为硬缺陷**：`compat` 的 `toolSurface: 'off'` 同时关闭 `tf-call`（`tool-surface.ts:160`），第三方工具完全不可达。多插件宿主中属功能性破坏。
2. **D3 为条件缺陷**：`lean` 的 `core` 档在 `nativeTools: true` 时只声明 7 项白名单（`tool-surface.ts:40`、`:187`）。默认 `nativeTools` 为 false 时该档无实际作用，一旦启用即造成第三方工具不可见。
3. **收益未实测**：两档的自述均标注"未单独实测，属方向性判断"（`modes.ts` lean/compat 条目）。
4. **参数预设不构成能力**：`lean` 与 `balanced` 的差异为并行 3→2、`maxReentries` 12→8、预算 60k、工具面 standard→core。前三项已是显式配置项，第四项是缺陷。
5. **能力轴唯一**：`balanced` 与 `power` 的实质差异是 `enableCode`，该轴与"模型看到什么"一一对应。

### 4.4 迁移与别名

```ts
LEGACY_MODE_ALIAS = {
  balanced: { channel: 'standard', tier: 'standard' },
  lean:     { channel: 'standard', tier: 'light'  },
  compat:   { channel: 'standard', tier: 'deep'   },
  power:    { channel: 'code',     tier: 'standard' },
}
```

- 读到旧配置时输出一行 warn，按别名映射执行
- `compat` 不再关闭工具面（D2 修复）；`lean` 不再裁剪工具面（D3 修复）
- 别名保留一个 minor（0.5.x），0.6.0 移除
- `control.json` 首次读取时迁移为 `{ channel, tier, lang }`，保留旧字段一个版本供回滚

### 4.5 预算模型重构

#### 4.5.1 D1 修复：基数改为任务起点

现状 `budgetLevel()` 以会话累计花费对比阈值：

```ts
// loop.ts:1256（v0.4.0）
budgetLevel(): BudgetLevel {
  const budget = this.#cfg.budgetTokens;
  if (budget === undefined || budget <= 0) return 'normal';
  const billedInput = this.#usage.inputTokens + this.#usage.cacheReadTokens + this.#usage.cacheWriteTokens;
  const spent = billedInput + this.#usage.outputTokens + Math.ceil(this.#injectedChars / 4);
  if (spent >= budget * 0.9) return 'final-only';
  if (spent >= budget * 0.7) return 'high-only';
  return 'normal';
}
```

`#usage` 与 `#injectedChars` 在 `loop.ts:844-845` 初始化后无重置，而 `#reentryCount`、`#finalNudges`、`#finalOnlyRequests` 在 `loop.ts:1417` 按回合重置。计量基数因此是会话级的。

修改：

1. 在 `pushUserTask`（`loop.ts:1272`）记录任务起点快照 `#usageBase`、`#injectedCharsBase`
2. `budgetLevel()` 改用 `spent - base`
3. `final-only` 档不再直接终止：先注入一次收束指令，仍无 `tf-final` 才走兜底交付

#### 4.5.2 控制变量：由 1 个改为 2 个

累计 token 不适合作控制变量：既不能被执行方感知，又受缓存价格扭曲（D7），且与用户对"工作量"的直觉相差一个 N（`spent ≈ N × C`）。改为两个正交上限：

| 旋钮 | 语义 | 触顶行为 | 上游对应 | 现状 |
|---|---|---|---|---|
| `maxInputTokens`（C 上限） | 单请求上下文上限 | 触发压缩（压缩旧段并记录 handle） | `compaction.max_input_tokens`（`compaction.py:29`） | 无，0.5.0 新增；复用 P3 压缩模块 |
| `maxSteps`（N 上限） | 单任务请求数上限 | 停止探索，注入收束指令要求 `tf-final`；代码通道下为要求返回结果 | `max_run_turns = 40`（`agent_loop.py:143`） | 已存在为 `maxRequests`（`loop.ts:1024`，默认 `max(4, maxReentries*2)`），仅未暴露 |

`budgetTokens` 保留为观测项：超过阈值时写 warn 与报表，不改变执行行为。

上游 thinkflow 无累计 token 预算，其控制项为 `max_input_tokens`（单请求）、`max_run_turns`、`max_run_seconds`、`max_auto_continues`（`agent_loop.py:138-144`）。该分层与本节一致：C 管窗口，N 管步数。

#### 4.5.3 数值标定

| 参数 | 初值 | 标定依据 |
|---|---|---|
| `maxInputTokens` | 20,000 | 触发压缩时单请求仍可容纳一次完整读 |
| `maxSteps` | 24 | 现默认值上界 24；代码通道单步产出更高，可按实测下调 |
| `budgetTokens`（观测） | 60,000 | 沿用 `lean` 的 60k，仅作告警阈值 |

下限保护：任务级预算低于 3×前缀估算（`estimatePromptTokens`，`loop.ts:1558` 已有）时拒绝启动，并返回"至少需要 N"的明确提示，避免任务必然失败。

### 4.6 配置落点与优先级

| 层次 | 通道 | 现状 | 改动 |
|---|---|---|---|
| 任务级（文本） | 消息首行 `[tf-budget: 8steps/20k]`，`pushUserTask` 解析后从正文剥离 | 无 | 新增；无宿主依赖 |
| 任务级（结构） | `followup(message).source.tfBudget` | `source` 字段存在（`loop.ts:3910`），但 `pushUserTask(next.text)` 丢弃了 message（`loop.ts:4027`） | 透传 message |
| 会话级 | `runtime.setBudget()` / `runtime.setChannel()` / `runtime.setTier()` | 服务仅有 `setMode`/`setLang`（`loop.ts:5005`） | 新增三个方法，`setMode` 保留为别名 |
| 装配级 | `config.maxInputTokens` / `config.maxSteps` / `config.channel` | 无 | 新增；作为不可逾越上限 |

优先级：任务指令 > 会话默认 > 装配上限。

### 4.7 文件改动

| 文件 | 改动 | 类型 |
|---|---|---|
| `src/kernel/modes.ts:15` | `MODE_IDS` 拆为 `CHANNELS` + `TIERS`；删四模式；加别名表 | 改 |
| `src/kernel/control-bar.ts:333` | `ControlState` 由 `{mode,lang}` 改为 `{channel,tier,lang}`；渲染改两区块 | 改 |
| `src/entry/loop.ts:844` | 增 `#usageBase` / `#injectedCharsBase` | 改 |
| `src/entry/loop.ts:1256` | `budgetLevel()` 改用任务级差值；`final-only` 先收束后兜底 | 改 |
| `src/entry/loop.ts:1272` | `pushUserTask` 记录起点快照并解析预算指令 | 改 |
| `src/entry/loop.ts:4027` | 透传 `message.source` | 改 |
| `src/entry/loop.ts:4752` | 配置解析改为 channel + tier | 改 |
| `src/entry/loop.ts:5005` | 增 `setBudget` / `setChannel` / `setTier` | 改 |
| `src/entry/tool-surface.ts:40` | 删除 `CORE_TOOLS` 白名单路径 | 改 |
| `src/entry/tool-surface.ts:160` | 删除 `off` 档 | 改 |
| `ui/client.js` | 四卡片改为两区块；旧模式值走别名 | 改 |
| `test/control-bar.test.ts` | 断言两区块 + 别名 warn | 改 |
| `test/v050-budget.test.ts` | 新增：任务级基数、双旋钮、下限保护 | 增 |
| `test/v050-channel.test.ts` | 新增：三来源判定、让位、回退 | 增 |

---

## 5. 与 PTC 的关系

### 5.1 PTC 的实际形态

PTC 不是独立插件，是一个 agent preset：

```yaml
# dsh-web-app/presets/ptc.patch.yml（节选）
- id: preset-ptc
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: ptc
    plugins:
      - { id: tool-fs, name: '@deepseek-ai/dsh-tool-fs', config: { applyPatch: false } }
      - { id: tool-pwsh, name: '@deepseek-ai/dsh-tool-pwsh' }
      ...
      - { id: tool-executor-ptc, name: '@deepseek-ai/dsh-tool-executor-ptc' }
```

三点事实：

1. 原生工具（pwsh / fs / fs-search / jobs / web / subagent …）**全部保留**在 preset 内，不是只留 `run_code`。
2. `tool-executor-ptc` 通过 `setExecutor` 在 preset 作用域内注册，按作用域链优先于根作用域的 `tool-executor-native`（`dsh-tools/src/index.ts:357-366`）。
3. preset 由会话选择，修改只影响之后创建的 Agent（`dsh-agent-preset/README.zh.md`）。

因此"代码通道"的本质是：**在 PTC 预设的会话里，模型把工具调用写成程序**。本插件不需要、也不应该再提供一套执行器。

### 5.2 三来源与让位规则

```text
通道 = 代码
   │
   ├─ 当前 agent 作用域内存在 tool-executor-ptc
   │     来源 preset：完全让位
   │     · 不注册任何 tf-* 工具
   │     · 协议段文本 = ''
   │     · 不解析模型输出、不拦截 final
   │     · 只做：压缩、状态摘要、度量、记账
   │
   ├─ 无 preset，但 ctx.ptcRuntime 存在
   │     来源 bridge：受限
   │     · 注册 tf-code 一个工具（0.4.x 行为）
   │     · 协议段只写 tf-code 用法（约 200 字符）
   │     · 不传 stateOwner / programFormat / sandboxPolicy
   │
   └─ 两者皆无
         来源：不可用
         · 拒绝进入代码通道
         · 回退标准通道，控制栏显示"代码通道不可用：未检测到 PTC 预设或 ptcRuntime"
         · 不静默降级
```

探测方法：查询当前 agent 作用域的执行器是否为 PTC 实现。0.4.0 已有 `looksLikePtcRuntime`（`src/entry/ptc-bridge.ts`）可用于 bridge 判定；preset 判定需新增探针（§14 U3）。

### 5.3 让位时具体停掉什么

| 项 | 标准通道 | 代码通道（preset） | 代码依据 |
|---|---|---|---|
| `tf-*` 工具注册 | 是 | 否 | `tool-surface.ts:187` 改为 `reserved-only` 后由通道闸门控制 |
| 协议段 | 完整 | 空串 | `systemPrompt.section` 的文本由通道决定 |
| 输出解析 | 是 | 否 | `#consumeStream` 的解析分支按通道短路 |
| 验收闸 | 是 | 否 | `finalOnlyGate` / `#buildFallbackFinal` 不进入 |
| 回灌 | 是 | 否 | 无 `tf-*` 调用即无回灌 |
| 执行器 | 不碰 | 不碰 | 全包无 `setExecutor` |
| 压缩 | 是 | 是 | 独立模块 |
| 状态摘要 | 是 | 是 | S5 |

"不写入对方表面"是可验证的：代码通道下，本插件对 `ctx.tools` 的注册数为 0，对 system prompt 的贡献为 0 字符，对 session 日志的写入为 0（只有投影读取）。

### 5.4 差异来源：状态是否可寻址

PTC 省略程序文本后，下一轮无法引用程序内绑定（如 `files[0]`），因为这些名字只存在于那段文本中，宿主没有对应地址。因此 PTC 必须保留程序原文，这是架构约束而非实现选择。

本插件在标准通道下的状态均有宿主可寻址的名字：

| 状态种类 | 地址形式 | 代码位置 |
|---|---|---|
| 观测原文 | `obs:<family>:<callId>@v<n>` | `obs.ts:366` |
| 文件版本 | `path@v<n>`（写后自增） | `obs.ts` `HandleEntry` |
| 计划项 | `[a1]` `[a2]` + 验收命令 | `parser.ts` / `final.ts` |
| 效果记录 | `p<n> → path v<n>, +42/−8` | 0.5.0 新增 |

```text
PTC：   程序文本  ──持有──▶  状态（变量）
        删文本 = 删状态        ⇒ 不可压缩历史

标准：  程序文本  ──产出──▶  状态（有地址）──▶ 可被任意后续回合引用
        删文本 ≠ 删状态        ⇒ 可压缩历史
```

### 5.5 论点的适用范围

"状态有地址"在代码通道下**不成立**：程序内读取不产生模型可见的工具事件（`tool/call` 由批处理调度器写入，`dsh-tools/src/batch.ts:247`；`run_code` 的子调用在沙箱内完成，不经过该调度器）。因此：

| 能力 | 标准通道 | 代码通道 |
|---|---|---|
| handle 可取回 | 是 | 否（模型侧无 `tf-peek`） |
| span 账本 | 是 | 否（看不见子调用，无投递记录） |
| 效果记录粒度 | 每次工具调用 | 每个程序（`run_code` 一次 = 一条） |
| 重复抑制 | 按区间 | 按 `path@v` 版本戳 |

代码通道省 token 的机制因此不同：不靠"删文本保地址"，而靠"读取在沙箱内发生，只有返回值进入上下文"。两者不可互相替代，这也是保留两个通道的理由，而非一个通道加开关。

### 5.6 衍生能力

#### (1) 效果压缩

动作生效且验证通过后，将程序体与原始输出折叠为一行：

```text
[applied p7] edit src/app.ts → v3 (+42/−8) · verify a1 pass · handle=obs:edit:p7@v3
```

- 前提：效果已落账（文件版本推进、测试结果已存句柄）
- 保留：目标、版本、diffstat、验证状态、句柄
- 丢弃：程序文本、原始 stdout
- 不折叠条件：未验证、失败、或最近 `keepRecent=3` 个程序

代码通道下折叠单元是 `run_code` 整次调用，记录形如：

```text
[applied p7] run_code → 3 calls · fs.edit src/app.ts → v3 (+42/−8) · pwsh test pass
```

调用明细来自程序的返回值声明，不来自子调用事件。

#### (2) 语义状态

```text
[tf-stream:state] 目标 3 项 · 已验证 2 · 未验证 1（a3 类型检查）· 失败 0
```

约 30 token，替代模型重读测试输出并自行判断的数百至数千 token。标准通道经回灌注入，代码通道经 S5 快照注入。PTC 无此表达，因其无验收项概念。

#### (3) 跨回合工作集

```text
[unchanged] src/app.ts L1-120 @v3（与 req#12 投递内容一致，未变化）
```

标准通道可用。代码通道下退化为版本戳提示：`[seen] src/app.ts @v3`，只能提示"未变化"，不能代替内容。PTC 的 `per-call` 模式变量不跨程序存活，同一区间需重新读取。

### 5.7 成本模型

符号：`S` 固定前缀，`P` 每回合程序文本，`R` 每回合结果文本，`E` 效果记录，`k` 保留程序数，`H` 句柄目录。

```text
PTC:        C_t = S + Σ_{i<t} (P_i + R_i)     ≈ S + t·(P+R)
标准通道:   C_t = S + Σ E_i + k·P + H         ≈ S + t·E + k·P + H
代码通道:   C_t = S + Σ E_i + H               ≈ S + t·E + H
```

取保守假设（非测量值）：`P=1500`、`R=200`、`E=60`、`k=3`、`H=0.6k`。

| 回合 t | PTC | 标准通道 | 代码通道 |
|---|---|---|---|
| 3 | S + 5.1k | S + 5.3k | S + 0.8k |
| 6 | S + 10.2k | S + 5.5k | S + 1.0k |
| 15 | S + 25.5k | S + 6.0k | S + 1.5k |
| 30 | S + 51.0k | S + 6.9k | S + 2.4k |

交叉点：标准通道 `1.7t = 0.06t + 5.1` → `t ≈ 3.1`。PTC 每回合 +1.7k，标准通道每回合 +0.06k，约 1/28。代码通道的斜率更低（+0.06k/回合，`H` 只在新增文件时增长），但它的 `S` 里包含程序侧提示与绑定声明，初始成本高于标准通道。

交叉点对 `P` 高度敏感：`P=800` 时固定成本 3.0k，交叉点 ≈1.8；`P=2000` 时 6.6k，交叉点 ≈4.0。因此结论表述为"交叉点在 2–5 回合之间，取决于程序文本平均长度"，不给出单一数值。该模型仅用于判断增长阶，不能作为预算依据。

### 5.8 总量 = N × C

```text
总 token = 请求数 N × 平均上下文 C
```

代码通道与 PTC 的 N 由不同 loop 产生（本插件接管 loop，PTC 预设下仍是本插件的 loop），直接比较总量无法把差异归因到"上下文治理"或"步数"。因此判据要求成对比较时 `|ΔN| ≤ 1`，超出即视为不可比并单独列出。

标准通道与 PTC 的 N 差异是设计差异（逐轮 vs 单程序），不要求相等，只比较增长斜率与 `C_max`。

### 5.9 可证伪假设

| 编号 | 假设 | 测法 | 证伪条件 |
|---|---|---|---|
| H1 | 等 N 下代码通道的上下文显著小于 PTC | 同 preset、同任务、同模型，仅切换本插件的档位 | 10 任务中 ≥4 个不优，或总量高 >5% |
| H2 | 标准通道的上下文增长阶更低，交叉点 ≤6 回合 | 任务长度 3/6/15/30 四档 | 交叉点 >12 或不存在 |
| H3 | 效果压缩不导致重复劳动 | 统计重复读取率、重复测试率 | 重复率上升 >20% |

若 H1 被证伪，0.5.0 的主张降级为"可审计、可回滚、可验证"，不再宣称更省 token。该降级条款写入发布说明。

### 5.10 完整兼容判据

代码通道下"完整兼容"的定义是**不写入对方拥有的任何表面**，逐项可验：

| PTC 能力 | 保持方式 | 验证 |
|---|---|---|
| 原生工具集 | 本插件不注册、不裁剪 | 工具清单与无本插件时逐个相等 |
| `run_code` 唯一入口 | 协议段 0 字符 | 模型可见工具中无 `tf-*` |
| 三档 `executionMode` | 不触碰 | 逐档执行同一程序，结果一致 |
| `stateOwner` / `scriptPersistence` | 不触碰 | `vm-script` 档变量跨调用存活 |
| `sandboxPolicy` | 不触碰 | 越权调用被拒 |
| 配额 2048 次 / 64MiB / 600s | 不触碰 | 触顶报错文案一致 |
| 子调用并发 10 | 不触碰 | 并发探针 |
| `errorClass` 分类 | 不触碰 | 6 类错误映射 |

禁止项：修改 PTC 的配额、并发、沙箱策略、工具清单。

---

## 6. 多插件共存

### 6.1 冲突面

| # | 冲突面 | 代码事实 | 故障形态 | 处置 |
|---|---|---|---|---|
| C1 | loop 单槽 | `setFactory` 全局单槽，占用即抛错（`dsh-agent/src/index.ts:379`） | 后装者装载失败（非静默） | 优先级 + 降级（§6.2） |
| C2 | 工具面过滤 | `tool-surface.ts:187`；`:160` | `off` 不可达；`core` 在 `nativeTools` 下只剩 7 项 | `reserved-only`（§6.3） |
| C3 | system 段落覆盖 | 各自拼接 | 提示词丢段 | `PromptSection` 具名段（§6.4） |
| C4 | 配置键重名 | `mode` / `lang` / `toolSurface` 为全局键 | 两个插件争用同一键 | 命名空间前缀（§6.4） |

执行器不在冲突面内：按作用域注册，PTC 预设作用域优先于根作用域，本插件不注册。

### 6.2 loop 接管与让位

```ts
takeoverPriority: number                    // 默认 100，数值大者优先
takeoverOnConflict: 'degrade' | 'refuse'    // 默认 degrade
```

- 本插件尝试 `setFactory`；`setFactory` 抛错说明已有 factory：
  - `degrade`：不接管，转为 sidecar（只提供控制栏状态与诊断，上下文治理全部关闭）
  - `refuse`：抛出错误，明确冲突
- 控制栏显示接管结果：`接管生效` / `未接管：已被 <X> 接管`
- 现有 `takeover-registry.ts` 已具备 `markTakeover` / `clearTakeover` / `onTakeover`，扩展 `owner` 字段

注意与 §2.2 的关系：`cordis.patch.yml` 仍停用内建 `agent-loop`，否则本插件装载即抛错。`degrade` 只用于"另一个第三方 loop 插件先占位"的场景。

### 6.3 工具面

```ts
surfacePolicy: 'reserved-only' | 'profile'   // 默认 reserved-only；删除 off
```

| 值 | 语义 | 对第三方工具的影响 |
|---|---|---|
| `reserved-only`（默认） | 只管理 `tf-*` 前缀，其余原样透传；代码通道下不注册任何 `tf-*` | 无 |
| `profile` | 0.4.x 行为（core/standard/full 过滤），仅过渡期保留 | 可能被隐藏 |

约束：

1. `tf-` 前缀保留给本插件；发现外部插件占用该前缀时装载期报错。
2. schema 超预算时只降级 `deferLoading` 标记，不得删除工具。
3. `profile` 档只用于回退演练（§12.4），CHANGELOG 标明已弃用。

### 6.4 system / 配置 / 状态目录

| 项 | 做法 |
|---|---|
| system 段落 | `PromptSection` 具名注册（`dsh-system-prompt/src/index.ts:485`），名称前缀 `streamAgent.` |
| 变化状态 | `ctx.systemPrompt.context(...)`（`:520`），语义自带版本替换 |
| 配置键 | 统一收进 `streamAgent.*`；根级别名保留一个 minor |
| 状态目录 | `stateDir/<pluginId>/` |

### 6.5 兼容矩阵

| 宿主组合 | 期望 | 验收点 |
|---|---|---|
| 纯宿主（standard preset） | 接管生效，标准通道可用 | 基线 |
| 宿主 + PTC 预设 | 接管生效；代码通道来源 = preset；工具清单不变 | 8 项能力逐项验证 |
| 宿主 + PTC 预设 + 第三方工具插件 | 第三方工具不被隐藏，程序内可调用 | 工具可达性探针 |
| 宿主 + 另一 loop 插件 | 降级为 sidecar 并报冲突 | 无静默覆盖 |
| 宿主 + `ptcRuntime`（无 preset） | 代码通道来源 = bridge | 受限能力如实显示 |

---

## 7. 上下文经济

### 7.1 分页取回的成本

设上下文 `C`，文件 `F`，分 `k` 段，每段 `f = F/k`。

```text
第 i 次取回的请求成本 ≈ C + i·f
分页取完总成本 = Σ_{i=1..k} (C + i·f) = k·C + f·k(k+1)/2
一次全读成本   = C + F = C + k·f

额外成本 = (k−1)·C + f·k(k−1)/2 ≈ (k−1)·C    （当 f·k/2 ≪ C）
```

结论：分页取原文的额外成本约为 `(k−1) × C`，与每段大小无关。取 `C = 30k`：

| k | 额外成本 | 相当于多读几个完整上下文 |
|---|---|---|
| 1 | 0 | 0 |
| 2 | 30k | 1 |
| 3 | 60k | 2 |
| 5 | 120k | 4 |
| 10 | 270k | 9 |

3,000 行文件全文约 120k 字符（约 40k token）。分 10 段取，额外支付 270k，为全文的 6.75 倍。

由此排除三种做法：

| 做法 | 无效原因 |
|---|---|
| 缩小单段 | 只影响 `f·k(k−1)/2` 项，主项 `(k−1)·C` 不变 |
| 提高单次取回上限 | 减少 k 才有效，单纯放大单段不改变请求数 |
| 将取回结果缓存到磁盘 | 节省的是 IO，请求仍需重发上下文 |

适用范围：本项只适用于标准通道。代码通道下读取在沙箱内完成，不产生额外请求，成本转移到沙箱配额（2048 次 / 64MiB）。

### 7.2 现有实现的问题

| 问题 | 代码事实 | 后果 |
|---|---|---|
| 取回只支持行段 | `obs.ts:419` | 模型只能按行号猜测，无法按符号定位，k 偏大 |
| 无已投递账本 | `obs.ts:422` 仅计数 | 重复取回同一区间，重复付费 |
| read 截断取头部 | `loop.ts:2367` | 答案通常不在头部，必然触发取回 |

第三条影响最大：头部截断策略本身制造取回。文件 3,000 行、答案位于 2,400 行时，模型拿到前 8k 字符（约 200 行），必然取回，而该次取回的额外成本为 `1 × C`，高于当初省下的 32k 字符。

### 7.3 改法：目标 k → 1

#### (1) 截断改为"索引 + 请求窗 + 覆盖图"

```text
[tf-stream:read] src/app.ts 3,012 行 / 118KB · 已投递 L1-120 + L2280-2420
索引（每 200 行一个锚，含顶层符号）：
  L1    import ...                     L1200 export function buildIndex()
  L200  const CONFIG = ...             L1800 export class QueryPlanner
  L800  export async function run()    L2400 // TODO: 分页上限
未投递区间：L121-2279, L2421-3012 → 用 tf-peek handle=... from_line=.. to_line=..
```

- 索引成本约为文件体积的 1–3%
- 未投递区间显式列出，模型无需推断已读范围

#### (2) 已投递 span 账本

```ts
deliveredSpans: Map<handle, Array<{from:number, to:number, req:number, hash:string}>>
```

- 命中已投递且 hash 未变 → 返回一行 `[unchanged]`（约 20 token），不返回正文
- 部分重叠 → 仅返回新增区间并附一行说明

#### (3) 每回合取回预算

```ts
peekBudgetChars: 24_000      // 每回合取回字符上限，由档位设定
```

超预算返回：

```text
[budget] 本回合取回已达上限（24,000 字符）。请先用 tf-grep 缩小范围，或在下回合继续。
未投递区间：L121-2279（索引见上）
```

不允许静默继续。

#### (4) 协议引导

在 `kernel/protocol.ts` 写死调用范式：

```text
要找内容：先 tf-grep 取行号 → 再 tf-peek 取 ±40 行窗口
禁止：从 L1 起逐段取回
禁止：对同一文件重复取回同一区间
```

#### (5) 超大文件只投索引

阈值 `readInlineMaxChars`（默认 32k）：

- 文件 ≤ 阈值：按 (1) 投递
- 文件 > 阈值：只投索引与未投递说明，正文一律取回

### 7.4 度量

| 指标 | 定义 | 目标 |
|---|---|---|
| `peek_requests_per_task` | 由取回引起的请求数 | ≤ 0.3 × 总请求 |
| `redundant_peek_ratio` | 命中已投递区间且未变化的占比 | ≥ 0.8 |
| `deref_bytes / produced_bytes` | 取回原文 / 产出原文 | ≤ 0.5 |
| `k_mean` | 每个 handle 的平均取回次数 | ≤ 1.2 |

### 7.5 读取与注入双旋钮

原 `readFeedbackLimit`（默认 8000）同时承担"读取多少"与"注入多少"（D6），是头部截断策略的根源。拆分为：

| 旋钮 | 管什么 | 默认 |
|---|---|---|
| `maxReadChars` | 单次 read 返回多少（读取侧） | 32k，超出转索引 |
| `readFeedbackLimit` | 单次 read 注入多少（回灌侧） | 0（不截断；读取侧已控住） |

拆分后 `readFeedbackLimit = 0` 才是安全的。该项依赖 §7.3 的索引化先落地。

### 7.6 长上下文

| 路径 | 标准通道 | 代码通道 |
|---|---|---|
| 触发 | `maxInputTokens` 超限 | 同 |
| 压缩单元 | 旧段（任务边界整块） | surface 节点 |
| 压缩产物 | 确定性条目化摘要 | `surfaceOp: replace` 的摘要节点 |
| 原文去向 | OutputStore + handle | 日志保留原文（模型侧不可寻址） |
| 取回 | `tf-peek handle=...`，支持 `request:N` | 程序内重读 |
| 硬约束 | 摘要为纯函数，零 IO，不调模型 | 同 |

摘要规则（对齐上游 `_build_summary` 的确定性纪律）：

- 每条消息压成一行，`max_item_chars = 900`，超出保留头尾
- 工具消息保留 `tool + 参数摘要 + 状态 + 字节数`；失败保留 stderr 前 N 字符
- `write` / `edit` 保留 `path + 行数变化`，不保留 diff 全文
- 保留最近 `keepRecent` 条不压（由档位设定：12 / 30 / 60）
- 摘要总长 `maxSummaryChars`（8k / 16k / 32k）
- 不做语义归纳，只做提取、截断、拼接

---

## 8. 前缀策略

### 8.1 现状

已实现的三分类（`loop.ts:2468` `#assertWirePrefix`；`render.ts:204` `assertRequestPrefix`）：

| cause | 触发条件 | 当前处置 |
|---|---|---|
| `stable-drift` | 稳定段（首条）逐字节变化 | 0 重发，fail-closed |
| `append-drift` | 已发文本转正后与承诺不一致 | 每回合 1 次、每会话 3 次内放行同一份 next 并重置基线；第 4 次降级 |
| `shrink` | 承诺前缀变短 | 0 重发，fail-closed（须走 `dropAppendHead`） |

### 8.2 处置原则

"报错"与"重发"各自只适用于部分场景：

| 方案 | 适用 | 不通用原因 |
|---|---|---|
| 当场报错 | `stable-drift`、越界 `shrink` | 对 `append-drift` 过度：可自动恢复的装配抖动，每次中断等于不可用 |
| 拆新前缀重发 | 部分 `append-drift` | 重发同一份坏前缀必然再次违约，形成循环且再烧一次缓存；同时掩盖装配 bug |

两者的共同假设是"前缀必须保持或放弃"。宿主的 `surfaceOp: replace` 提供第三种：计划性换基。

### 8.3 判定规则

```text
前缀非单调
   │
   ├─ 由 surface replace / dropAppendHead / 通道切换产生
   │     处置：计划性换基（正常路径）
   │     · 重置基线
   │     · 记 cache-reset 事件
   │     · 注入 [tf-stream:context-rebased]
   │
   ├─ append-drift（转正不一致，可归因）
   │     处置：受限换基（现有逻辑）
   │     · 每回合 1 次 / 每会话 3 次
   │
   └─ stable-drift 或越界 shrink（不可归因）
         处置：fail-closed + 诊断转储
         · index / expected / actual / hash
         · 不重发
```

| cause | 可归因 | 可计划 | 处置 |
|---|---|---|---|
| planned-rebase | 是（本方压缩或通道切换） | 是 | 正常执行并记账 |
| append-drift | 是 | 是（有界） | 换基，配额内 |
| stable-drift | 否 | 否 | 报错 + 转储 |
| shrink（越界） | 否 | 否 | 报错 |

通道切换属计划性换基：工具面与协议段同时变化，必然破前缀。切换在任务边界执行，换基一次，不逐请求重算。

### 8.4 换基成本判据

```text
rebase_cost  ≈ C（当前上下文 token）
fail_cost    ≈ 该步重做 + 人工介入（估算 ≥ 3×C）

规则：剩余预算 > rebase_cost × 1.5  → 允许自动换基
      否则                          → fail，保留现场
```

### 8.5 配置

```ts
prefixPolicy: 'auto' | 'rebase' | 'fail'   // 默认 auto
rebaseBudgetRatio: 1.5
maxRebasesPerTurn: 2
maxRebasesPerSession: 8
```

`stable-drift` 始终 fail，不受 `prefixPolicy` 影响。

### 8.6 实现要求

1. 模型可见：换基后注入 `[tf-stream:context-rebased] 本请求上下文已重建（原因：压缩 / 通道切换），缓存已重置，行为不变`。
2. 记账：`cache-reset` 事件写入 ledger，含 `cause`、`contextTokens`、`estimatedColdCost`。
3. 不可静默：换基须在控制栏与 eval 报表可见。

---

## 9. 上游移植

### 9.1 许可

| 项目 | 许可 | 证据 | 义务 |
|---|---|---|---|
| thinkflow | MIT | `LICENSE` 首行；`pyproject.toml:11` | 保留版权声明与许可全文 |
| `dsh-ptc-runtime` | MIT | `package.json` `license` | 同上 |
| `dsh-ptc-runtime-node` | MIT | 同上 | 同上 |
| `dsh-tool-executor-ptc` | MIT | 同上 | 同上 |

MIT 允许商用与再分发，义务为保留声明。落地形式为新增 `NOTICE`。

### 9.2 三种移植方式

| 方式 | 适用 | 动作 | 风险 |
|---|---|---|---|
| 直接依赖 | PTC 三包（TS，5,955 行） | `package.json` 依赖 + 锁版本 | 版本漂移 |
| 语义重写 | thinkflow（Python，15,299 行） | 按行为契约重写为 TS，并移植测试向量 | 非源码复制，须以原测试为判据 |
| 不移植 | thinkflow 的 UI/CLI/Provider 层 | — | 与宿主职责冲突 |

thinkflow 为 Python 项目，源码级搬运在技术上不成立。可搬运的是行为契约、协议文本、测试向量。

### 9.3 PTC 移植清单

| 包 | 行数 | 提供 | 处理 |
|---|---|---|---|
| `dsh-ptc-runtime` | 343 | 抽象契约、保留字集合、沙箱策略类型 | 直接依赖（bridge 通道） |
| `dsh-ptc-runtime-node` | 3,274 | 三种 evaluator、bindings、environment、scriptPersistence | 直接依赖（bridge 通道） |
| `dsh-tool-executor-ptc` | 2,338 | `run_code` 注册、`setExecutor`、client、错误分类 | 不依赖；preset 通道由宿主装载 |
| 合计 | **5,955** | — | 0 行复制 |

preset 通道下本插件不 import 这三包：`run_code` 由宿主 preset 装载，本插件只读其结果。

### 9.4 thinkflow 移植清单

47 个模块，总计 15,299 行，按处置分四类。

#### 第一类：必搬（15 模块 / 3,176 行 / 20.8%）

| 模块 | 行数 | 能力 | 目标 | 现状 |
|---|---|---|---|---|
| `parser.py` | 558 | `<tf-*>` 解析、fence 感知 | `kernel/parser.ts` | 有骨架，缺 fence |
| `context.py` | 574 | 观测记录、`read_spans`、注入字符串 | `kernel/obs.ts` + `render.ts` | 部分，缺 span |
| `tool_registry.py` | 399 | `TOOL_FLOW_*` 分类 | `kernel/flow.ts`（新） | 缺 |
| `compaction.py` | 330 | 确定性摘要、`keepRecent` | `kernel/compaction.ts`（新） | 缺 |
| `text_filter.py` | 211 | `MarkdownFenceCommandGate` | `kernel/gate.ts` | 有骨架 |
| `output_store.py` | 174 | 原文落盘 + tail/preview | `entry/state-handle.ts` | 部分 |
| `delivery.py` | 163 | 交付校验 | `kernel/final.ts` | 部分 |
| `task_plan.py` | 148 | acceptance / evidence | `kernel/plan.ts`（新） | 缺 |
| `file_observations.py` | 134 | 文件级观测合并 | `kernel/obs.ts` | 缺 |
| `conversation.py` | 126 | 消息单一事实源 | `kernel/render.ts` | 有（实现不同） |
| `feedback.py` | 111 | 回灌格式 | `kernel/obs.ts` | 部分 |
| `message_projection.py` | 86 | 消息投影 | `kernel/render.ts` | 有 |
| `recall.py` | 83 | `request:N` + offset/query | `obs.ts` peek 扩展 | 缺 |
| `prompts.py` | 57 | 协议与系统提示文本 | `kernel/protocol.ts` | 部分 |
| `context_budget.py` | 22 | 上下文预算 | `kernel/governor.ts`（新） | 缺 |
| 小计 | **3,176** | — | — | — |

#### 第二类：选搬（13 模块 / 2,986 行 / 19.5%）

| 模块 | 行数 | 处置 |
|---|---|---|
| `executor.py` | 811 | 只搬语义（声明序 = 执行序 = 注入序），不搬单 worker 实现 |
| `session.py` | 415 | 补 fsync/原子性，其余已有 `intent-log.ts` |
| `changes.py` | 272 | 可选，用于 effect record 的 diffstat |
| `configuration.py` | 269 | 只搬字段语义 |
| `runtime.py` | 257 | 宿主已有 |
| `streaming.py` | 243 | 宿主已有 |
| `model_registry.py` | 208 | 宿主已有 |
| `workspace.py` | 124 | 宿主已有 |
| `workspace_search.py` | 103 | 由 `tf-grep` 替代 |
| `workspace_git.py` | 103 | 可选 |
| `runtime_context.py` | 84 | 宿主有 `systemPrompt.context` |
| `events.py` | 54 | 宿主已有 |
| `session_delta.py` | 43 | 宿主已有 |
| 小计 | **2,986** | — |

#### 第三类：参考不移植（1 模块 / 2,527 行 / 16.5%）

| 模块 | 行数 | 说明 |
|---|---|---|
| `agent_loop.py` | 2,527 | 上游自有 loop 实现。本插件已有等价物且架构不同（TS/AsyncIterable vs Python/asyncio）。仅提取三处语义：`need_result` 的 break 语义、`check_completion` 的收敛判据、auto-continue 的上限纪律 |

#### 第四类：不移植（18 模块 / 6,610 行 / 43.2%）

| 模块 | 行数 | 理由 |
|---|---|---|
| `cli.py` | 1,744 | 宿主 CLI 已有 |
| `desktop_service.py` | 1,169 | 宿主桌面端已有 |
| `renderer.py` | 689 | 渲染归宿主 UI |
| `interfaces.py` | 426 | Python 类型定义 |
| `usage_tracker.py` | 385 | 宿主有计费统计 |
| `provider.py` | 296 | LLM 调用归宿主 |
| `skills.py` | 289 | 技能装载归宿主 |
| `interactive_controller.py` | 272 | 交互归宿主 |
| `baseline_agent.py` | 270 | 上游对照基线，非产品能力 |
| `security.py` | 225 | 权限归宿主 |
| `tui.py` | 198 | 终端 UI |
| `desktop_terminal.py` | 180 | 桌面终端 |
| `process_owner.py` | 174 | 进程管理 |
| `provider_diagnostics.py` | 92 | Provider 诊断 |
| `config_cli.py` | 78 | CLI 配置 |
| `output_capture.py` | 53 | 宿主已有 |
| `desktop_catalog.py` | 50 | 桌面目录 |
| `__init__.py` | 20 | 包声明 |
| 小计 | **6,610** | — |

#### 核对

| 分类 | 模块数 | 行数 | 占比 | 处置 |
|---|---|---|---|---|
| 必搬 | 15 | 3,176 | 20.8% | 重写为 TS + 移植测试向量 |
| 选搬 | 13 | 2,986 | 19.5% | 按需，部分只搬语义 |
| 参考 | 1 | 2,527 | 16.5% | 只读，提取 3 处语义 |
| 不移植 | 18 | 6,610 | 43.2% | 宿主职责 |
| 合计 | **47** | **15,299** | **100%** | — |

"能力完整"的判据为必搬的 15 个模块全部到位，而非行数占比。移植不搬项等于与宿主争夺职责。

### 9.5 NOTICE

```text
This product includes software derived from:

1. xuxiang/thinkflow (MIT)
   Copyright (c) 2026 沐雪清泽
   移植范围：协议语义、解析器、压缩与回取策略（详见 docs/porting-matrix.md）
   移植方式：Python → TypeScript 重写，非源码复制

2. @deepseek-ai/dsh-ptc-runtime, dsh-ptc-runtime-node, dsh-tool-executor-ptc (MIT)
   Copyright (c) DeepSeek
   使用方式：npm dependency，未修改（仅 bridge 通道使用）
```

原则：依赖与派生分栏记录。

### 9.6 协议自主

| 项 | 0.4.x | 0.5.0 |
|---|---|---|
| 协议来源 | 逐条对齐 thinkflow `PROTOCOL.md` 1.14 | 自有 `PROTOCOL-v1.md`，thinkflow 列为参考实现 |
| 标签命名 | 尽量同名 | 保留 `tf-*` 前缀以兼容，语义以自有规范为准 |
| 变更判据 | 上游是否变更 | 成本模型是否需要 |
| 兼容承诺 | 跟随上游 | 仅对自有规范承诺；差异记入 `docs/upstream-delta.md` |

执行三步：

1. 冻结：`PROTOCOL-v1.md` 写明每个标签的语义、边界、错误码，不引用上游行号
2. 分叉登记：`docs/upstream-delta.md` 列出与上游不一致处及原因
3. 迁移窗口：0.5.0 接受两种风格（宽松解析），0.6.0 仅保留自有语义

---

## 10. 行为对齐清单

8 个维度的归属与版本。

| # | 维度 | 0.4.0 状态 | 标准通道 | 代码通道 | 阶段 |
|---|---|---|---|---|---|
| 1 | 验收 | 已交付（`tf-plan` / `accepts`） | 完整（可拒绝收敛） | 不可做（无 final 控制权），降级为状态提示 | — |
| 2 | 通道 | **未交付**：`reasoning-delta` 仅落盘不参与解析；全仓无围栏感知 | 可做（fence gate + thinking 兜底） | 不可做（不解析流） | 0.6.0 |
| 3 | 长上下文 | 未交付 | 段丢弃 + 确定性摘要 + `maxInputTokens` 触发 | surface replace + 效果压缩 | P3 |
| 4 | 回灌 | 未交付 | 全量 + span 去重 | 不适用 | P3/P5 |
| 5 | 目标函数 | 已交付度量 | N 一等指标；`maxSteps` 暴露 | 同 | P1/P7 |
| 6 | 消息 | 未交付 | renderer 自装（阶段 1–2） | surface 投影 + S5 快照 | P3 |
| 7 | 执行顺序 | 未交付 | 声明序 + DAG | 继承 PTC（串行根 / 并发 10） | 0.6.0 |
| 8 | 回合主权 | 未交付 | `need_result` 中断 | 不可做 | 0.6.0 |

代码通道承担 3/5/6 三项，其余五项或不可做、或不适用。

---

## 11. 版本、阶段与工作量

### 11.1 版本方案

| 包 | 版本 | 理由 |
|---|---|---|
| `@hugesb/dsh-stream-agent` | 0.5.0 | 单包；配置键破坏性变更记入 CHANGELOG 的 Breaking 段 |

不新增包。内核留在 `src/kernel`，由 `test/` 直接以 `node --test` 覆盖（0.4.0 已如此），不需要为复用而拆包。

### 11.2 阶段表

| 阶段 | 内容 | 依赖 | 工作量 |
|---|---|---|---|
| P0 | 复跑 11 条探针；四项修复各补一条行为断言；`v0.3.3 → v0.4.0` 差异审阅；D1 真机复现 | 无 | 1 |
| P1 | 控制面两区块：`channel` + `tier`、别名迁移、控制栏渲染、**预算模型重构（D1 修复 + 双旋钮 + 落点）** | P0 | 5 |
| P2 | 代码通道：三来源判定、让位实现、`reserved-only`、8 项兼容判据 | P1 | 3 |
| P3 | 长上下文：摘要 + 效果压缩 + `maxInputTokens` 触发 + S5 注入 | P1 | 6 |
| P4 | 前缀策略（三分类 + 计划性换基 + 通道切换记账） | P1 | 2 |
| P5 | 取回策略（索引 + span 账本 + 预算 + 协议引导） | P3 | 3 |
| P6 | 协议 v1 冻结；`upstream-delta`；`channel-matrix`；NOTICE；移植主干 | P2/P3 | 3 |
| P7 | 四臂 benchmark；发布门禁；回退开关演练 | 全部 | 3 |
| P8（0.6.0） | 通道补交付（围栏感知 + thinking 命令解析）；回合主权中断；消息阶段 3；选搬项；协议收敛 | P7 | 8 |

合计 0.5.0：**26 单位**；0.6.0 追加 8 单位。

### 11.3 关键路径

```text
P0 ──▶ P1 ──┬──▶ P2 ──────────────┐
            │                      ├──▶ P6 ──▶ P7 ──▶ 0.5.0
            ├──▶ P3 ──▶ P5 ────────┤
            │                      │
            └──▶ P4 ───────────────┘

P0 → P1 → P3 → P5 → P6 → P7 = 21 单位（关键路径）
P2 与 P3 并行；P4 独立可并行
```

依赖理由：

- P0 → 全部：回归未清零时，效果数据不可归因
- P1 → P3：预算上限 `maxInputTokens` 是压缩的触发条件，须先有配置与落点
- P3 → P5：取回策略依赖索引与 span 账本，账本属长上下文模块
- P2 → P6：代码通道的让位清单是协议 v1 中 PTC 侧语义的依据
- P4 独立：前缀策略只涉及 `render.ts` 与 `#assertWirePrefix`

### 11.4 0.6.0 预留

0.6.0 收纳两类"改流内时序"的工作：通道补交付（围栏感知 + thinking 命令解析）与回合主权（`need_result` 中断）。

推迟理由：

1. 两者都修改 `#consumeStream` 的解析与消费时序，与 0.5.0 的上下文治理正交，混入会使效果数据无法归因
2. 回合主权是唯一需要中断流的改动，风险最高（可能丢命令、可能触发 provider 连接复用问题）
3. 通道能力依赖 provider 的 `reasoning` 内容契约，该契约尚未验证（§14 U7）
4. 两者只对标准通道生效，不影响代码通道

顺序：先完成 P3/P4/P5 三项上下文改动，再统一处理流内时序。两类改动同时进行将无法定位故障来源。

0.6.0 对 0.4.0 的补交付关系：

| 0.4.0 计划项 | 实际状态 | 承接版本 |
|---|---|---|
| 回归修复 | 已交付 | — |
| 度量口径 | 已交付 | — |
| 验收 | 已交付 | — |
| 通道 | 未交付 | 0.6.0 |

---

## 12. 验收与发布门禁

### 12.1 四臂 benchmark

| 臂 | 配置 | 作用 |
|---|---|---|
| L0 原生 | 无插件，standard preset | 基线 |
| L1 PTC | 仅 PTC preset，无本插件 | 对照：code-as-action |
| L2 标准通道 | 本插件 + standard preset，通道=标准 | 无代码通道路径 |
| L3 代码通道 | 本插件 + PTC preset，通道=代码 | 核心实验臂：同 preset，仅变治理 |

任务集：10 个既有任务 + 4 个长任务（15/30 回合量级）+ 2 个大文件任务（>2,000 行）。

判据：

- H1：L3 与 L1 在 `|ΔN| ≤ 1` 的成对样本上，总 token 低 ≥15%，且 10 个任务中 ≥7 个成立
- H2：L2 的上下文增长斜率 ≤ L1 的 1/3；交叉点 ≤6 回合

### 12.2 指标定义

| 指标 | 定义 | 用途 |
|---|---|---|
| `N` | 请求数 | 一等指标 |
| `tokens_total_strict` | `input + output`，不含 `cacheRead` | 严格口径 |
| `tokens_total_with_cache` | 含 `cacheRead` | 参考口径，不得单独用于结论 |
| `C_max` | 单请求最大上下文 | 增长阶证据 |
| `cache_hit_ratio` | `cacheRead / input` | 换基成本证据 |
| `rebase_count` | 换基次数 | 计划性与非计划性分开计 |
| `verify_pass_rate` | 验收项通过率 | 质量约束 |
| `channel_source` | `preset` / `bridge` / `none` | 归因前提 |

硬规则：任何对外结论必须同时给出两个口径。0.4.x 的 `eval/RESULTS.md` 中四分量 28.9% 与严格二分量 134.9% 的差异即源于单一口径表述。

### 12.3 正式版标准

1. 架构定稿：单包单装载；两区块可独立回退；兼容矩阵逐格实测通过
2. 有对照数据：四臂 benchmark 完成，H1/H2 有明确结论（含被证伪）
3. 可回退：每项新能力有独立开关，关闭后行为与 0.4.0 一致（`renderHash` 对比）

三条缺一不可：缺 2 为自述，缺 3 用户无法安全升级。

### 12.4 回退开关演练

| 开关 | 关闭后 | 验证 |
|---|---|---|
| `channel: 'standard'` | 代码通道不启用 | 工具面与 `balanced` 一致 |
| `tier: 'standard'` | 数值回默认 | 与 0.4.0 `balanced` 数值逐项相等 |
| `effectElision: false` | 保留程序全文 | 上下文 hash 对比 0.4.0 |
| `surfaceCompaction: false` | 不替换 surface | 消息序列逐字节一致 |
| `spanLedger: false` | 无重复抑制 | 行为等价 |
| `peekIndex: false` | 回到头部截断 | 输出一致 |
| `prefixPolicy: 'fail'` | 绝不换基 | 违约必报错 |
| `surfacePolicy: 'profile'` | 0.4.x 工具面 | 工具面一致 |
| `maxSteps` / `maxInputTokens` 取消 | 无上限（仅观测告警） | 长任务不中断 |

---

## 13. 风险登记册

| # | 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|---|
| R1 | 通道切换被误用为"逐任务随手切"，每次都触发换基 | 中 | 中 | 切换在任务边界执行并记账；控制栏显示本会话换基次数；超过 `maxRebasesPerSession` 时要求确认 |
| R2 | H1 被证伪（代码通道不比 PTC 省） | 中 | 高 | 降级条款预先写入发布说明；主张改为"可审计" |
| R3 | 效果压缩导致重复劳动 | 中 | 中 | `keepRecent=3`；保留 path/版本/失败原因；重复率进报表 |
| R4 | surface replace 与宿主 prefix 断言冲突 | 中 | 高 | P4 先做；换基走记账通道；`maxRebasesPerTurn` 限流 |
| R5 | 代码通道来源判定错误（preset 存在却判为 bridge） | 中 | 高 | 双重判定：作用域执行器类型 + `ptcRuntime` 存在性；不一致时拒绝进入并报错，不静默选一侧 |
| R6 | 协议 v1 冻结后无法跟进上游 | 中 | 低 | `upstream-delta.md` 定期评审；只吸收与成本模型相关的变更 |
| R7 | 旧模式用户升级后行为突变 | 中 | 中 | 别名映射 + warn；`control.json` 迁移保留旧字段一个 minor |
| R8 | thinkflow 移植引入 Python 语义（如 FIFO 顺序假设） | 中 | 中 | 只搬语义；以原项目测试向量为判据 |
| R9 | 大文件索引本身超预算 | 低 | 中 | 索引上限 2k 字符，超出仅给符号名 |
| R10 | NOTICE/归属漏项 | 低 | 高 | 两栏制；CI 校验 NOTICE 与依赖清单一致 |
| R11 | 预算下限保护缺失导致任务必然失败 | 中 | 中 | 低于 3×前缀估算时拒绝启动并给出最小值 |
| R12 | 宿主 preset 结构变更（如 PTC 改为独立包）导致代码通道判定失效 | 中 | 中 | 判定逻辑只依赖"当前作用域执行器是否为 PTC 实现"，不依赖 preset 的 id 或行名 |

R12 的处置是设计约束：不要按 preset id 判定，只按执行器实现判定。

---

## 14. 未确认项与探针

| # | 事项 | 不确定原因 | 确认方式 | 阻塞 |
|---|---|---|---|---|
| U1 | `llm/stream` 是否在运行期拒绝改写 | 文档声明只读，未见运行期断言 | 故意改写 messages 的探针，观察是否抛错 | P1 架构 |
| U2 | `surfaceOp: replace` 在宿主 loop 下是否生效；自有事件类型能否被日志接受 | 仅读到类型定义；`register()` 为运行期，消息投影需类型级声明 | 最小插件：声明事件类型 + 一条投影 + 一条 replace 事件，打印下一请求消息序列 | P3 压缩路径 |
| U3 | 如何在不依赖 preset id 的前提下判定"当前作用域执行器为 PTC" | 未查到公开的反射接口 | 读 `selectExecutor` 的可见性；或注入一个探针工具，观察 `run_code` 是否在工具清单中 | P2 |
| U4 | PTC 子调用是否产生 `tool/call` 会话事件 | 推测不产生（`batch.ts` 只在批处理调度器写） | 在 PTC 会话中运行含 3 次子调用的程序，检查事件流 | §5.5 结论 |
| U5 | 交叉点在 2–5 回合 | 模型推演，对程序平均长度 `P` 敏感 | 四臂 benchmark 分档 + 真实会话 `P` 统计 | H2 判据 |
| U6 | 宿主中是否已有其他 loop 插件 | 仅本机观察 | 扫描已装插件清单 | P1 |
| U7 | thinkflow `main` 与 `v0.10.3` 的差异 | 未做 diff | 拉 tag 比对 | P6 基线 |
| U8 | `deepseek` 之外 provider 的 reasoning 内容契约 | 未抓包 | 抓真实响应，统计草稿与正式声明比例 | 0.6.0 通道策略 |
| U9 | D1 在真机上是否必然复现 | 按代码路径推导，未实测 | `lean` 档连发两条独立任务，检查第二条 `turnEndReason` | 缺陷定级 |
| U10 | `systemPrompt.context` 贡献在宿主 loop 中是否按"替换旧快照"处理 | 读到 supersession 实现，未跑通 | 两次发不同 context 文本，观察请求消息序列是否只有一条快照 | 代码通道注入 |
| U11 | 控制栏两区块在桌面页与终端栏的状态是否一致 | 两套渲染共用 `ControlState`，但持久化路径不同 | 双向切换各 3 次，比对 `control.json` | P1 |

U1、U3、U10 为架构前提，须在 P1 开工前完成探针。U3 若无法解决，代码通道退化为"由用户显式声明来源"，需在控制栏增加一个不可自动判定的标记。

---

## 15. 执行清单

| # | 动作 | 产出 | 阻塞 |
|---|---|---|---|
| 1 | 写 U1 探针：改写 `llm/stream` 的 messages，观察是否抛错 | 结论 + 堆栈 | P1 架构 |
| 2 | 写 U10 探针：两次不同 `systemPrompt.context` 文本，打印请求消息序列 | 序列 diff | 代码通道注入 |
| 3 | 写 U3 探针：PTC 会话中检查执行器类型可见性 | 判定方法 | P2 |
| 4 | 写 U4 探针：PTC 会话中运行含 3 次子调用的程序，导出事件流 | 事件清单 | §5.5 |
| 5 | 复现 D1：`lean` 档同一会话连发两条任务，检查第二条 `turnEndReason` | 会话日志 | 缺陷定级与 R11 |
| 6 | 在 `next/0.5` 复跑 11 条探针，四项修复各补一条行为断言 | 全绿清单 | 全部 |
| 7 | 导出 `modes.ts` 四档参数表，统计 `lean/compat` 使用占比（如有遥测） | 删档依据 | P1 |
| 8 | 统计真实会话的"程序文本 : 结果文本"比例，校准 §5.7 的 `P/R` | 校准后交叉点 | H2 判据 |
| 9 | 拉 thinkflow `v0.10.3` tag 与本地快照 diff | 移植基线 | P6 |
| 10 | 起草 `PROTOCOL-v1.md` 目录 | 章节骨架 | P6 |

第 1、2、3、4 项决定架构前提，优先执行。

---

## 附录 A 配置项总表

全部有默认值。默认值代表本计划的取值，不等同于上游默认。

| 配置 | 默认 | 作用 | 关闭后 | 出处 |
|---|---|---|---|---|
| `channel` | `standard` | `standard` / `code`；通道切换在任务边界生效 | `standard` = 0.4.x 无代码通道行为 | §4.2 |
| `tier` | `standard` | `light` / `standard` / `deep`；只改数值 | `standard` = 0.4.x `balanced` 数值 | §4.2 |
| `surfacePolicy` | `reserved-only` | 只管路 `tf-*`，其余透传 | `profile` = 0.4.x | §6.3 |
| `takeoverPriority` | `100` | loop 接管优先级 | — | §6.2 |
| `takeoverOnConflict` | `degrade` | `degrade` / `refuse` | — | §6.2 |
| `codeChannelSource` | `auto` | `auto` / `preset` / `bridge`；`auto` 按 §5.2 判定 | 显式指定可绕过探测 | §5.2 |
| `effectElision` | `true` | 效果落账后折叠程序体 | `false` = 保留全文 | §5.6 |
| `effectElisionKeepRecent` | `3` | 最近 N 个程序不折叠 | — | §5.6 |
| `stateDigest` | `true` | 注入一行状态摘要（S5） | `false` = 不注入 | §5.6 |
| `spanLedger` | `true` | 已投递区间去重（仅标准通道） | `false` = 可重复投递 | §7.3 |
| `maxReadChars` | `32_000` | 单次 read 返回上限，超出转索引 | — | §7.5 |
| `readFeedbackLimit` | `0` | 回灌侧预算（0 = 不截断） | `8000` = 0.4.x | §7.5 |
| `peekBudgetChars` | 由档位 | 每回合取回字符上限 | `0` = 不限制 | §7.3 |
| `peekIndex` | `true` | read 输出带行锚索引 | `false` = 头部截断 | §7.3 |
| `prefixPolicy` | `auto` | `auto` / `rebase` / `fail` | `fail` = 绝不换基 | §8.5 |
| `rebaseBudgetRatio` | `1.5` | 允许换基的剩余预算倍率 | — | §8.4 |
| `maxRebasesPerTurn` | `2` | 换基限流 | — | §8.5 |
| `maxRebasesPerSession` | `8` | 换基限流 | — | §8.5 |
| `compactAggressiveness` | 由档位 | `conservative` / `balanced` / `aggressive` | — | §7.6 |
| `keepRecent` | 由档位 | 压缩保留最近条数 | — | §7.6 |
| `maxSummaryChars` | 由档位 | 摘要总长上限 | — | §7.6 |
| `surfaceCompaction` | `true` | 启用 surface replace 压缩（代码通道的主压缩路径） | `false` = 不压缩 | §7.6 |
| `maxSteps` | 由档位 | 单任务请求上限，可由任务指令覆盖 | 继承 `maxReentries*2` | §4.5 |
| `maxInputTokens` | 由档位 | 单请求上下文上限，触顶压缩 | `0` = 不压缩 | §4.5 |
| `taskBudget` | `null` | `maxSteps`/`maxInputTokens` 的任务级便捷写法 | `null` = 用会话默认 | §4.6 |
| `budgetTokens` | `60_000` | 仅观测：超阈值告警与报表 | — | §4.5 |
| `mode` | — | 已删除；旧值走别名（§4.4） | — | §4.4 |

两条纪律：

1. 每个开关关闭后必须回到 0.4.0 行为（§12.4 演练验证）
2. 默认值变更写入 CHANGELOG 的 Breaking 段，不隐藏在 minor 中

---

## 附录 B 文件级改动索引

| 文件 | 改动 | 阶段 |
|---|---|---|
| `src/kernel/modes.ts:15` | 拆为 `CHANNELS` + `TIERS`；删四模式；别名表 | P1 |
| `src/kernel/control-bar.ts:333` | `ControlState` 改 `{channel,tier,lang}`；两区块渲染 | P1 |
| `src/kernel/compaction.ts` | 新增：确定性摘要 | P3 |
| `src/kernel/governor.ts` | 新增：`maxInputTokens` 判定 | P3 |
| `src/kernel/obs.ts:366` | handle 地址扩展（`request:N`） | P3 |
| `src/kernel/obs.ts:419` | `peek` 增符号定位与 span 去重 | P5 |
| `src/kernel/render.ts:204` | `assertRequestPrefix` 增 planned-rebase 分类 | P4 |
| `src/entry/loop.ts:844` | 增任务起点快照 | P1 |
| `src/entry/loop.ts:1024` | `maxRequests` → `maxSteps`，支持任务级覆盖 | P1 |
| `src/entry/loop.ts:1256` | `budgetLevel` 改任务级差值；final-only 先收束 | P1 |
| `src/entry/loop.ts:1272` | `pushUserTask` 解析预算指令 | P1 |
| `src/entry/loop.ts:2367` | 头部截断改索引 | P5 |
| `src/entry/loop.ts:2468` | `#assertWirePrefix` 接 planned-rebase | P4 |
| `src/entry/loop.ts:4027` | 透传 `message.source` | P1 |
| `src/entry/loop.ts:4752` | 配置解析改 channel + tier | P1 |
| `src/entry/loop.ts:5005` | 增 `setBudget` / `setChannel` / `setTier` | P1 |
| `src/entry/tool-surface.ts:40` | 删除 `CORE_TOOLS` 白名单路径 | P1 |
| `src/entry/tool-surface.ts:160` | 删除 `off` 档 | P1 |
| `src/entry/ptc-bridge.ts` | 三来源判定与让位闸门 | P2 |
| `src/entry/takeover-registry.ts` | 增 `owner` 字段 | P1/P2 |
| `ui/client.js` | 四卡片改两区块 | P1 |
| `test/v050-budget.test.ts` | 新增 | P1 |
| `test/v050-channel.test.ts` | 新增 | P2 |
| `test/v050-compact.test.ts` | 新增 | P3 |
| `test/v050-prefix.test.ts` | 新增 | P4 |
| `test/v050-peek.test.ts` | 新增 | P5 |
| `NOTICE` | 新增 | P6 |
| `PROTOCOL-v1.md` | 新增 | P6 |
| `docs/channel-matrix.md` | 新增 | P6 |
| `docs/upstream-delta.md` | 新增 | P6 |
| `docs/porting-matrix.md` | 新增 | P6 |

---

## 附录 C 阶段交付判据

| 阶段 | 完成判据 |
|---|---|
| P0 | 11 条探针全绿；四项修复各有行为断言；D1 复现结论明确；U1/U3/U4/U10 有结论 |
| P1 | 两区块可独立切换；预算按任务计；旧配置走别名不报错；控制栏两端一致 |
| P2 | 三来源判定正确；代码通道下 `tf-*` 注册数为 0；8 项兼容判据通过；无静默降级 |
| P3 | 压缩后 handle 可取回；重复读取率不升 >20%；`maxInputTokens` 触发正确；S5 注入按替换生效 |
| P4 | 三类违约处置符合判定表；换基记账完整；`stable-drift` 必 fail；通道切换记账为 planned-rebase |
| P5 | `k_mean ≤ 1.2`；`redundant_peek_ratio ≥ 0.8` |
| P6 | 协议 v1 冻结；NOTICE 通过 CI 校验；移植基线确定；通道矩阵与实现一致 |
| P7 | 四臂数据齐备；H1/H2 有结论；9 个回退开关演练通过 |
