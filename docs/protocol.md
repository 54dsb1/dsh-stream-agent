# 单流协议

## 命令语法

模型在一次流里连续输出 `tf-*` 命令。语法以 `src/kernel/parser.ts` 为唯一权威，下面只是等价描述。

| 命令 | 属性 | 语义 | 结果处理 |
|---|---|---|---|
| `tf-write` | `path`、`content`/`patch` | 写或改文件 | 成功只记 ledger，**绝不注入** |
| `tf-read` | `path`，可选 `offset`/`limit`（1 基行号） | 读文件 | 读**外部文件**完整反馈一次（≤8000 字符，超限留头尾）；读**本任务 `tf-write` 写过的路径**只注入回执（`[tf-stream:receipt]`，行数 + sha256 指纹，0.2.0 O7）；补充走 `tf-peek` |
| `tf-edit`（0.3.0 F1） | `path`，可选 `replace_all`；body = `<<<<<<< OLD` / 原文 / `=======` / 新文 / `>>>>>>> NEW` 标记块 | 精确替换（映射宿主 `edit`；不做模糊匹配，匹配失败结构化报错，绝不静默改全文） | 成功只记 ledger；失败注结构化原因 |
| `tf-append`（0.3.0 F1） | `path`，可选 `anchor`（锚点原文）；body = 追加正文 | 只追加不改既有内容：有 anchor = 锚点后插入（映射宿主 `edit`）；无 anchor = EOF 追加（映射宿主 `apply_patch` 的 `*** End of File` 锚） | 成功只记 ledger |
| `tf-grep`（0.3.0 F2） | `pattern`，可选 `path`/`include` | 内容搜索（映射宿主 fs-search `grep`），只回匹配行（自带行号、按文件分组） | 首次/变化完整注入；超限句柄化 |
| `tf-glob`（0.3.0 F2） | `pattern`，可选 `path` | 文件名搜索（映射宿主 fs-search `glob`），只回路径 | 同上 |
| `tf-bash` | `command`、`description` | 执行命令（Windows 宿主映射到 `pwsh`） | 失败注入，成功只记 ledger |
| `tf-peek` | `handle`、`from`/`to` | 从句柄取回行段 | 按需注入 |
| `tf-final` | `id`、`summary` | 声明任务完成 | 触发收束判定；同 id 携带新 summary = 覆盖最终答案（last-wins）；**有未验证验收项时判过早（F5）** |
| `tf-code` | `description`，可选 `timeout`（毫秒）；body = async TS 函数体（可擦除语法） | 程序化工具调用（PTC 桥接）：绑定 `tools.write/read/pwsh` 走宿主管线。**0.3.0 K1：默认关闭**（协议段 0 字符），显式 `enableCode: true` 或 `power` 模式才启用 | 成功：上限内值完整注入（F3，缺省 4000 字符），超限骨架+句柄；失败：结构化 `[kind retry 结论]`（K3 八类 + quota-exceeded）；运行受 K5 配额（64 子调用/256KiB/300s）与 K2 沙箱记账（mode/denied/enforcement，`partial` 显式可见）约束 |
| `tf-call`（0.4.0 G2） | `name`（本会话工具面内的宿主工具名）；body = JSON 参数对象 | 透传 `ctx.tools.execute`（同一 guard/sandbox 管线）；结果按宿主工具分族（web/skill/agent/ask/job → high 候选，office/goal/todo → 回执）；unknown-tool 注入带前缀匹配建议（不回灌全表）；bad-json-arguments 结构化失败；`toolSurface: off` 或无宿主面时协议段 0 字符（回退点） |
| `tf-ask`（0.4.0 §6.4） | `q` 必填；`header`/`options`（逗号分隔标签）可选 | 映射宿主 ask_user_question；用户回答完整注入；`id` 作为问题 id 回显 |
| `tf-skill`（0.4.0 §6.4） | `name`（技能名） | 映射宿主 skill；技能说明完整注入（会话级行为变更） |
| `tf-plan`（0.3.0 F5） | 无；body = `- [id] 验收项描述` 行 | 声明/修订任务计划与验收项（状态放驱动器=宿主侧；请求只注**差分**） | 命令成功时在命令上加 `accepts="<id>"` 声明回执 → 验收项记已验证；缺项/未验证 → tf-final 判过早。`enablePlan: false` 关闭（回退点） |

tf-call 是通用调用通道（G2：命令表净增 1，上限 14）：对等矩阵见 [docs/capability-parity.md](docs/capability-parity.md)。命令可带 `depends_on` 声明依赖，`accepts` 声明验收关联（F5），驱动器据此决定派发时机与收敛判定。

## 驱动器闭环语义

光有命令集不够——单流能不能跑稳，取决于这几条边界行为。全部有单测与真连取证：

| 语义 | 规则 | 解决的问题 |
|---|---|---|
| **隐式写序** | 同流内后续命令自动等待先闭合的 `tf-write`（写族 FIFO，读批并行） | 同流 `write → read` 读到旧内容 |
| **重复 id 幂等** | 同 id 同内容 = 返回原回执不重执行；同 id 不同内容 = 拒绝并要求换新 id；被拒命令可用原 id 修正重发 | 模型 id 抖动伪造成功 |
| **乐观 peek 延迟重试** | 同流 peek 未就绪句柄 → 流末 drain 后重试一次，仍无才失败 | 同流内部依赖断链 |
| **`tf-final` last-wins** | final 无副作用，同 id 携带新 summary 视为更新答案 | 模型从不换 id 却想改答案 |
| **过早 final 检测** | final 带未满足依赖或未完成命令时，注入引导让模型重发 | 提前收工 |
| **错误取因** | 逐层解包 `ToolBatchExecutionError.cause` | 失败 detail 不可定位 |
| **tf-code 隔离执行（0.2.0；0.3.0 收口）** | 程序体闭合即派发到宿主 PTC runtime（resolve→run）；返回值无损 JSON 句柄化，中间结果不进上下文；绑定失败对齐 ToolCallError 语义。0.3.0：回合 signal 直通（K4）、cwd 透传与沙箱事实逐次记账（K2）、八类失败 kind + 可重试结论（K3）、三项配额硬限制（K5）、默认关闭显式开启（K1） | 重型数据加工只回结论不回过程；取消/超限/沙箱拒绝都有具名失败与账本记录 |
| **自写回验 receipt（O7）** | `tf-read` 命中本任务 `tf-write` 已写过的路径（分隔符规范化后比对）→ 回执注入，不回灌全文；`selfReadFeedback: 'full'` 关闭 | 写批任务"写 → 读回验"循环烧 token |
| **code 结果可见性（F3，0.3.0）** | 仅 tf-code 显式开启时：首成功/变化值 ≤4000 字符完整注入（省一次 tf-peek 往返），超限骨架 + 句柄 | 值可见 ≥95% 而 peek ≤10%；不恢复全量回灌 |
| **原生通道上限（F4，0.3.0）** | 仅声明 `nativeToolSchemas` 时：原生 tool_call 结果单块 >6000 字符 → 骨架 + 句柄（obs 登记，可 tf-peek） | 原生通道不成为全量回灌后门 |
| **计划与验收（F5，0.3.0）** | 计划状态在驱动器侧，请求只注差分（新计划全量一次，此后只注变化）；`accepts` 命令回执是唯一验证来源，模型自述不算；有未验证验收项时 tf-final 判过早 | 复合任务"声称完成但无回执"被结构性拦截 |
| **恢复意图（F6，0.3.0）** | 变更类命令派发前意图 fsync 落盘、落定即回执；resume 发现"有意图无回执"→ 停机核对（零注入，不自动重放）；`dsh-stream-agent intents` 核对/--ack 闭合 | 强杀后写入状态三态可判定；不重放、不重复写 |
| **段边界（F7，0.3.0，ADR-001）** | 追加区超 `segmentMaxChars`（默认 160k 字符）→ 新回合开始处整块丢弃旧段（原文句柄化可回取，显式记录缓存重置点；不做摘要改写） | 长会话体积有界；边界只落完整回合，前缀断言仍 fail-closed |

## 上下文装配

一次请求的 messages 分三段：**稳定前缀**（系统提示 + 任务 + 冻结的动态段）→ **观测注入**（只放高增益）→ **易变尾**（本轮新增内容）。装配规则：

- **只追加，不改写**。禁止摘要、压缩、编辑中间内容——那会直接摧毁 prefix cache。
- **O3 目录差分**：句柄目录不整段重注，只注自上次请求以来的增量（added / changed / stale 三列）。
- **O4 动态冻结**：时间戳、目录快照等逐请求变化的内容一律移到易变尾，稳定前缀里不允许出现。
- **O6 前提断言**：每次发请求前算 `renderHash`，与上一次比对必须单调，否则拒绝发送（fail-closed）。宁可任务失败，也不烧缓存。

## 预算分级（O5）

任务级 token 预算执行三档降级：

| 用量 | 行为 |
|---|---|
| < 70% | 正常：按 `info_gain` 注入 |
| 70–90% | 只注 high 与失败，low / none 一律句柄化 |
| > 90% | 停止一切注入，只收 `tf-final`，输出降级交付（已完成 / 未完成 / 已排除 / 下一步） |

预算在每步请求前的 preflight 校验，不是事后统计。

## 动作准入（gate）

四级可逆性：

| 级别 | 行为 |
|---|---|
| `read` | 直接放行 |
| `spec` | 只写暂存区 + 产 diff，不碰真实工作区；产出绑定内容 hash 的一次性凭据 |
| `commit` | 必须携带有效凭据（`already_used` / `expired` / `hash_mismatch` / `unknown` 四种结构化拒绝） |
| `fatal` | 无人工批准通道时直接拒绝 |

缺 `reversibility` 声明不会静默通过——`registry.freeze()` 在装配期就抛 `MissingReversibilityError`。把"忘记声明"变成启动期失败，而不是运行时的意外放行。

## DSML 噪声与桌面显示（0.3.1）

真机取证：模型偶尔把 DeepSeek 原生调用格式 `<｜｜DSML｜｜ …>`（U+FF5C 全角竖线）混进文本流
（`<｜｜DSML｜｜ calls>` 包装行、`<｜｜DSML｜｜ invoke name="tf-plan" id="p1">` 调用行）。
协议里没有任何合法形式以 `<｜` 开头，parser（`src/kernel/parser.ts`，唯一权威）一律不作为
prose 透传：

| 形态 | 处理 |
|---|---|
| `<｜…DSML… invoke name="tf-xxx" 属性…/>` 或配对打开 | 改写回等价 `tf-*` 头部，交 `parseHeader` 统一 schema 校验——**命令不丢** |
| 其余包装行（`calls` 等）与属性段残缺的调用行 | `malformed(dsml-wrapper)` 记账后丢弃：只进驱动器台账与 `plugin:tf-agent/fault`，不注入、不打断流 |
| 尾部未闭合的 DSML 片段（流终止） | 同上，不进 prose |

配套两条（桌面端思考过程显示修复，取证链见 CHANGELOG 0.3.1）：

- **落盘正文纯 prose 化**：assistant/message 的 text 块只含解析器 prose 事件；tf-* 标记与
  DSML 噪声留在台账（`plugin:tf-agent/*`），不进会话表面。resume 重放读台账，不受影响。
- **`agent/assistant-stream` 实时帧**：start → 逐 reasoning-delta chunk → end。契约对齐宿主
  两端 fold（服务端 `SessionAssistantStreamAccumulator.accept`：revision 逐帧 +1、chunk
  index 逐块 +1；客户端 `ClientAssistantStream.acceptFrame`）。正文不逐帧透传（协议标记不
  闪现）；工具广告前收束 attempt（abandoned）——否则广告消息滞留客户端 pending，下一步
  start 帧触发 `events.restart()` 整窗重建。思考过程以 `{type:'reasoning'}` 内容块随
  assistant/message 落盘（块序镜像内建：思考先于正文），重放/历史加载同样可见。
