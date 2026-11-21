# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.3.3] - 2026-11-21

**畸形/通配闭合标签泄漏修复 + 缓存命中结构性修复 + 解析器容错（三批次合一发布）。**
真机取证 2026-11-20/21 桌面端 DeepSeek-V4.1 会话；批次明细见下。

### Fixed（协议残片泄漏进桌面端正文 + 纠错信号缺失）

**现象**：模型把协议通配当成闭合标签输出 `</tf-*>`——该残片原样落进 assistant 正文，
桌面端对话区出现裸的 `</tf-*>`（同一会话内出现两次）；模型全程没有收到任何纠错信号，
重复输出同一错形态，回合无有效命令、无 tf-final，无产出收场。

**根因（两层叠加）**：

- **parser**：0.3.1 的孤立闭合标签治理只覆盖「合法闭合形态」（`</tf-[a-z0-9-]*\s*>`）与
  「未终止的闭合前缀」两种，`probeTag` 对其余 `</tf…` 变体落到 `return 'prose'` 兜底——
  通配 `</tf-*>`（`*` 不在闭合标签名字符集内）与带属性的 `</tf-write path="x">`
  全数漏网，作为 prose 透传进桌面端正文。
- **loop**：malformed 一律 fail-soft 只记台账（`plugin:tf-agent/fault`）、无注入——
  即便残片被判 malformed，模型也拿不到纠错信号（真机两次出现同一错误即为证据）。

**修复**：

- `probeTag`：`</tf-` 紧跟非空白且引号感知存在 '>' 的 token 一律判 `close-tag`
  （`scanHeaderClose` 与消费侧同函数同切片，端界构造性一致——属性值含 '>' 如
  `</tf-write cmd="a>b">` 不会被截半再漏）。判别式带 `\S` 保住 0.3.1 既有语义：
  正文里提到 `</tf`（后跟空白、无 '>'）仍按 prose 透传，HTML 闭合标签不受影响。
  runaway 防线：>200 字符仍无 '>' 按 runaway 残片记账丢弃（与 DSML 同纪律），不无限缓冲。
- `closeTagName`：名字符集纳入 `*`（通配残片台账记 `stray-close-tag:tf-*`，取证更准）。
- `loop`：第一次 `stray-close-tag` 挂一条定向纠错注入（`malformedCloserNudge`，本回合
  首个非 final-only 请求携带，挂块即成为重入事由）——点名残片原文、给出配对/自闭合两种
  合法形态与 tf-final 收束方式；同会话只注入一次（token 纪律），台账逐次如实记录
  （`malformed-closer-guidance`）。

**回归基线**：既有 318 个测试语义零破坏；新增 9 个测试
（`test/v033-wildcard-closer.test.ts`：parser 事件级 6 + 驱动器端到端 2 + 文案 1）。

### Fixed（缓存命中结构性修复 + 解析器容错 —— 真机 `session-3d4caf01`/`ec100f8a`/`2079562e`，2026-11-21）

**现象**：截断修复后的真机会话缓存命中仍只有 77%（目标 ≥95%）；同一任务族有一个会话
9 步 `blocked（重入上限 8）`，任务未完成；PowerShell 命令与 tf-peek 因属性解析容错不足
整条丢失。

- **缓存命中结构性修复（77% → 95%+ 的关键）**：digest 落史时机从"下一轮循环顶部"改为
  **流结束就地落史**——易变尾的转正发生在 render 之后（转正块落位 = 上一请求尾部的**同一
  位置**），digest 必须在转正之后追加。旧时序（digest 先落、转正后至）会把转正块整体挤到
  错位：每条注入块被双倍支付（尾部一次 + 移位后一次），稳态 miss = 最近两步的全部注入与
  摘要。新时序下请求 i+1 的公共前缀覆盖请求 i 的**全部** prompt（含尾部），miss 只剩
  真新增内容（本步 digest + 本步注入）。`test/v032-truncation.test.ts` T2 的前缀单调
  断言（第 3 请求逐字节包含第 2 请求全部消息）即为结构证明。
- **未知属性降级丢弃**（旧实现拒整条命令）：模型写 `lines="1-20"`（schema 是
  from_line/to_line）被旧实现整条拒绝（`session-ec100f8a` seq 91）。现在未知属性丢弃、
  命令保留；`lines="N-M"` 识别为 from_line/to_line 归一。
- **属性值内嵌引号容忍扫描**：`cmd="... ("rc'+[guid]::NewGuid()) ..." ..."` 的内嵌 `"`
  撑破简单正则 → 整条命令丢失、参数值漏进正文（`session-ec100f8a` seq 134）。闭引号
  判定改为"`\"` 后跟下一段 `key=` 模式 / 标签结尾 / 末尾"（parseHeader 与 DSML
  parseAttrPairs 同款；valueStart 用绝对下标——相对偏移会让 lastIndex 不前进死循环）。
- **重入上限提升**（balanced 8→12、lean 6→8、compat 12→16、power 10→14）：语义是
  防打转兜底不是任务步数预算（`session-2079562e`：8 步 blocked，任务未完成）。
- **装配清单解除 `maxReentries: 8` 钉死（决定性修复）**：cordis.patch.yml / preset.yml
  显式钉死 8——按"装配压过模式"规则，modes.ts 的上限提升从不生效（真机
  `session-7fbfef8f`：11:57 的会话仍以"重入上限 8"硬杀，模型正重写到一半）。现在
  上限由模式默认值决定；驱动器直构兜底值同步 8→12。缓存命中同批真机 91%
  （`session-7fbfef8f` 26.6K tok），顺序修复生效。

**回归**：新增 `test/v032-conflict.test.ts` 6 用例（W1 线消息 source / W2 nudge 进度感知 /
W3 实体解码 / W4 DSML 内联属性混合形态 / W6 mangled name 抢救 / W7 写入尺寸如实）+
`test/v033-wildcard-closer.test.ts` 9 用例；全量 329/329 离线通过（零 API 调用）。

### Fixed（第二轮真机修复 —— 缓存 91% 后的残留截断，真机 `session-d6cd0759`/`3d4caf01`/`7fbfef8f`，2026-11-21）

- **装配清单解除 `maxReentries: 8` 钉死（决定性）**：cordis.patch.yml / preset.yml 的显式
  钉死按"装配压过模式"规则压制了上限提升——11:57 的会话仍以"重入上限 8"硬杀
  （模型正重写到一半）。现在上限由模式默认值决定；驱动器直构兜底同步 8→12。
- **写入类 digest 尺寸如实**：写入成功的摘要行显示 `written N chars`（N = 解析器捕获的
  正文大小）——旧实现显示回执包装自身的长度（≈144 字符），模型误读为"文件只有 144
  字符"→ 触发全量重写（`session-3d4caf01`，白烧 2-3 步 + 1 万思考 token）。
- **mangled DSML name 值抢救**：`name="tf-peek handle="obs:...""`（全部属性塞进
  name 值、引号数为奇数）——旧实现整条丢弃。三件套：scanHeaderClose 引号不成对时
  退化通道 v2：取**第一个**满足"前驱是属性收尾引号或自闭合斜杠"的 '>'——不能取
  最后一个（mangled 开标签后面的命令正文含 '>'，取最后一个会把正文整段吞进标签
  再丢弃，真机 seq 104：整个 selfcheck 脚本被吞）；name 值以合法命令名开头时改写为
  闭合形式；
  自闭合 invoke 进块缓冲（findDsmlInvokeEnd 自闭合分支，含端点修正）。
  `session-d6cd0759` seq 110 的整条 tf-peek 现在完整恢复（handle/from_line/to_line/id
  全部归位）。

### Fixed（截断的最后两处结构性根因：收束无兜底 + 生产性重入被硬杀；缓存对照 98% 基线，2026-11-21）

**现象（桌面端）**：13 步的真实任务（读文件 → 改文件 → 跑检查）在中途结束，对话区只
留下最后一句 prose；台账是 `blocked（重入次数达到上限 12）`，产物是半成品。会话缓存
命中 87.8% / 82.2%，而同一插件、同一模型的对照会话是 97.9% / 97.4%。

**根因（四处，叠加）**：

1. **生产性重入被当打转**：`#reentryCount >= maxReentries` 把"每步都在读/写/跑命令、
   每步都拿到新事实"的回合与"原地反复失败"的回合一视同仁——真实任务在第 12 步被砍。
2. **收束时没有兜底交付**：无 `tf-final` 收场时回合直接 blocked，没有任何 assistant
   交付消息 → 用户侧只剩最后一句 prose，看起来就是"输出截断"。
3. **饥饿升格块被当成重入事由**：只要本步产生一条升格观测 `needsReentry` 即为真——
   模型已经给出合法 `tf-final`，却被一块"补充观测"顶掉 `completed`，回合继续烧请求
   直到撞墙。
4. **易变尾里非 durable 块夹在 durable 块前面**：转正进历史的只有 durable 块，一旦
   `[tf-stream:error]`/nudge 排在 `[tf-stream:observation]` 之前，转正后的历史就在那一处
   与上一请求的 prompt 分叉——其后所有观测块（一次读注入可达上万字符）全部退化成未
   缓存输入；再叠加"一次读五个文件全量回灌"，单请求 5916 个未缓存 token。

**修复**：

- **停滞预算与请求硬上限分账**：新增 `stallReentries`（连续零产出重入上限，缺省 =
  `maxReentries`）与 `maxRequests`（回合请求硬上限，缺省 2×）。有新增 ok 命令即清零
  停滞计数——生产性工作不再被"重入次数"硬杀；绝对闸门由请求数兜住，不会无限烧 token。
- **收束期 + 兜底交付**：撞墙且**有事实可交付**时不立刻砍——先注入
  `[tf-stream:closeout]`（最多 `closeOutRequests` 次，缺省 2）要求立即 `tf-final` 交付
  结论与未验证项；用尽仍无 final → `#buildFallbackFinal` 写一条**明确标注
  `[未完成交付]`** 的 assistant 消息（已完成命令与目标、最近一次命令输出尾部、
  未完成/未验证项）。零产出回合不写（不伪造"已完成"）。
- **升格块不再是重入事由**：合法 final 优先于可选补充（`promotedBlock` 只在确定要重入
  时才真正挂块）。
- **尾块 durable 前置**：同一请求内 durable 块（observation/peek/replay/tool-result）
  排在瞬态指令（error/nudge/closeout）之前，转正后的历史前缀可覆盖到最后一个 durable
  块，模型下一请求只为"新增事实 + 一句指令"付费。
- **单请求读注入预算**（`readFeedbackBudgetPerRequest`，缺省 12000 字符）：预算内的读
  给全文，超出转"头 800 字符 + 句柄"，下一请求用 `tf-peek` 精确补全；`0` 关闭预算
  （回退点，行为等价 0.3.2）。
- **正文闭合容错**：`findBodyClose` 按命令名匹配闭合，允许尾随空白与属性
  （`</tf-write >`、`</tf-write path="x">` 都正确闭合，不再判 `truncated` 丢正文）；
  DSML 块 flush 的尾部闭合剥离同样改为正则容错。

**回归**：新增 `test/v033-closeout.test.ts` 10 用例（P1–P3 正文闭合与畸形开标签、
C1–C4 收束与兜底交付、R1–R3 读预算与尾块排序）；全量 339/339 离线通过（零 API 调用）。


## [0.3.2] - 2026-11-21

**宿主一致性补丁 + 会话中途截断修复（v0.3.2 发布版）。** 本条目合并三个批次的修复：
宿主一致性两案（2026-11-18）、会话中途截断四根因（真机 `session-e4b9a89c`）、以及
对照 GitHub 上游 `deepseek-ai/deepseek-harness` 源码后的宿主契约冲突修复
（真机 `session-8f22c7a0`，2026-11-20——"修复后截断仍发生"的最后一层根因）。

### Fixed（宿主契约冲突 —— 对照 GitHub 上游源码定位，真机 `session-8f22c7a0`）

**现象**：截断修复后的会话（23:31）仍然中断：缓存命中已到 88%，1 轮 6 步、1 分 51 秒
结束，最终答案是一句"我将重写实现文件"的意图陈述，任务没做。逐事件解码日志 + 对照
上游 `packages/llm/llm/src/index.ts`（master）后确认四个**独立**因素叠加：

- **assistant 线消息缺 `source`（崩溃主因）**：宿主 `LlmRuntime.forAdapter` 对请求里的
  每条 assistant 消息读 `message.source.replayState`（上游 master 与 rc.1 均无防护）——
  "正文落追加区"用 role:'assistant' 但不带 source，**正文首次落史后的下一请求必崩**
  （TypeError: Cannot read properties of undefined (reading 'replayState')，日志 seq 121），
  流以 error finish 收场 → 回合 blocked。现在 assistant 历史块与线消息一律携带
  `source = {kind:'model', provider, model}`（`RenderMessage.source` / `modelSource()`；
  replayState 可选，缺失按"无原生回放"处理——上游 `validateReplay` 契约）。
- **nudge 一次性预算误杀生产性回合**：nudge 在"写文件步"被消耗后，任何后续无注入的
  步骤（纯写步不产生观测注入）直接 `nudgeExhausted` → blocked——即使模型正在干活。
  现在改为**进度感知**：nudge 后有新 ok 命令即不算提示失效（继续给机会），只有零产出的
  连续 nudge（真打转）才收束；整体仍由 maxReentries / O5 预算兜底（C3 零产出语义不变）。
- **XML 实体未解码**：模型带 XML 习惯写属性——`cmd="... Write-Output &quot;EXIT=1&quot;"`
  的实体原样进 PowerShell，命令解析报错，白烧一步。属性值统一解码有界实体集
  （lt/gt/quot/apos/amp + 数字引用；单遍替换，`&amp;quot;` 不二次展开）。
- **DSML 内联属性 invoke 走 body 模式吞包装残片**：带内联属性的 invoke 此前走
  `parseDsmlHeader` 进 body 模式，非正文命令把 parameter/invoke/closes 包装残片整体
  吞到流末才以 malformed 露出（日志 seq 33-35 三条）。现在全部 invoke 统一走块缓冲
  （内联属性与 parameter 合并，parameter 覆盖同名键）；非正文命令的恢复边界纳入 DSML
  标签（残片立即露出，不再吞到流末）；块以命令自身配对闭合终止时剥掉尾部闭合标签。

### Fixed（宿主一致性 —— 历史加载失败 + 工具调用"卡住"，真机 `session-1da5f8fc`）

两案同源：插件的 duck-type 面缺了宿主侧的形状/事件契约，与 0.3.0 的"工具生命周期"案同类。

- **历史加载失败（`message must have model source`）**：assistant/message 的 source 只有
  `{kind:'model'}`，缺宿主校验器要求的非空 `provider`/`model`——日志读取时整条判 corrupt。
  现在 source 携带实时 provider/model（无路由信息时落 'unknown' 兜底）；存量损坏日志用
  `node scripts/repair-session-logs.mjs --write` 修复（写前备份）。
- **回合结束后 UI 永远转圈**：`StreamLoopAgent` 从不发 `agent/status`——桌面端收不到
  idle 转换。状态转换统一走 `#setStatus`（镜像内建 setPhase 语义），factory 从 `ctx.emit`
  接线 `emitStatus`。
- **改审批策略命令报 `agent.inject is not a function`**：新增 `inject(message)`（落盘 +
  并入下一请求装配，不唤醒空闲 agent）。

### Fixed（会话中途截断 —— v0.3.2 补丁，真机 `session-e4b9a89c`）

**现象**：任务做到一半，模型在思考区写下 "The history is truncated. I don't see the plan
content"，随后反复重读同一文件、用占位 final 收场；桌面端最终答案只剩
`I'll start by inspecting the workspace. / README.md r10 / Get-ChildItem ... b902` 这类残片。
9 步、9 次请求后回合以 `blocked（重入次数达到上限 8）` 结束，用户侧看到的就是"输出被截断、
不完整"。

**四条根因（逐条修复）**：

- **请求之间没有会话记忆（主因）**：0.3.x 的追加区只放任务与句柄目录行——模型自己的
  正文、命令、命令结果从不落历史；观测只在"易变尾"注入一次（`#reportedObservations`
  永不重放），易变尾又每请求整块重建。于是第 3 个请求的提示只剩 system + 任务 + 句柄目录
  （真机 step 3 `inputTokens=343`，对比 step 2 的 1613），模型如实报告"history is truncated"。
  现在每步结束把**正文 + 命令摘要**（id/命令/目标/状态/句柄/字符数）落进追加区，已发出的
  易变尾在下一请求装配后**转正为历史**（只允许事实类块：observation/peek/tool-result/replay；
  nudge/degraded/error 等瞬态指令不转正）。对齐内建 `dsh-agent-loop` 的
  `session.deriveMessages()` 语义：历史累积、只追加，前缀单调不变（新增回归断言逐条比对）。
- **DSML 参数式调用被当噪声（正文残片的直接来源）**：模型原生调用还有一种形态——
  `<｜｜DSML｜｜ invoke name="tf-read">` 后跟
  `<｜｜DSML｜｜ parameter name="path">README.md</｜｜DSML｜｜ parameter>`。0.3.1 只认
  "invoke 头部内联属性"，parameter 子标签逐条判 malformed，**标签之间的值作为 prose 漏进正文**
  （`README.md r10` / `Get-ChildItem ... b902` 就是 path/id/cmd 的值），命令本身却没执行。
  现在整个 invoke 块缓冲到闭合，按 parameter 归集成属性后一次性发命令；块内文本不再透传。
  块未闭合即流终止时：非正文命令（属性已齐）照常发（能救则救），正文命令按 truncated 丢弃
  （绝不写半截文件）。
- **非正文命令少写 `/` 吞掉后续输出**：`<tf-read ...>` 进入 body 模式后会一直吞到流末尾，
  0.3.1 只在流末记一条 truncated，后续命令与正文全部消失。现在遇到下一个 `<tf-` / `</tf-`
  即视为闭合（命令照发、后续照解析），流末仍未闭合也发命令并把剩余文本归还 prose。
- **截断没有任何续写事由**：`finish=max-tokens` / 命令体未闭合时，0.3.1 只记台账，回合
  "安静地"结束在半截输出上。现在强制一次续写注入（`[tf-stream:truncated]`，带已生成内容
  尾部 ≤800 字符便于从断点续写），回合级上限 `MAX_TRUNCATION_RETRIES=4`，超限如实 blocked。
- **计划门槛拒绝时不给计划内容**：模型看不到验收项就无法补 `accepts`，final 会被永久拒绝
  直到重入上限。现在拒绝注入附带计划快照（id + 原文 + 状态）。

**涉及文件**：`src/kernel/parser.ts`（DSML 参数式块 / 非正文命令恢复）、
`src/entry/loop.ts`（步骤摘要、易变尾转正、截断续写、计划快照）、
`src/entry/mock-provider.ts`（剧本选择改为"最新 marker 优先"——历史持久后旧 marker 仍在，
首匹配会让同一剧本无限重演）。
**回归**：`test/v032-truncation.test.ts` 8 例（T1/T1b/T1c 解析器 DSML 三态、T3/T3b 非正文
命令恢复、T2 三请求历史保留 + 前缀逐条不变、T4 max-tokens 续写落盘、T5 计划快照）；
全量 314/314 通过。

### Fixed

- **历史加载失败（`message must have model source`）**：0.3.1 及更早版本写
  assistant/message 时 source 只有 `{kind:'model'}`，缺宿主校验器
  （dsh-session `assertMessageEventShape` → `hasProviderModel`）要求的非空
  `provider`/`model`——日志在读取时整条被判 corrupt，桌面端报"历史加载失败"。
  现在 `makeAssistantMessage` 携带实时 provider/model（`createSessionEventWriter` 新增
  `modelInfo` 写入时回调；驱动器 `modelSource()` 随 `applySelection` 运行时换模而动，
  不缓存）；无路由信息（离线/缺省）时落 `'unknown'` 兜底，形状仍过校验，不谎报模型。
  **存量损坏日志**：`node scripts/repair-session-logs.mjs --write`（0.3.0 修复脚本扩展：
  新增 model source 补齐类目 + 本地消息形状复核，`--model-provider`/`--model` 可指定，
  缺省 deepseek-account / deepseek-flash；写前备份、写后清投影缓存的纪律不变）。
- **回合结束后 UI 永远转圈**：`StreamLoopAgent` 从不发 `agent/status`——桌面端
  dsh-api-session-controller 靠它转发 `api-session/status` 收起"运行中"指示，不发 =
  回合早已结束、UI 仍在"正在分析请求"。现在状态转换统一走 `#setStatus`（镜像内建
  dsh-agent-loop `setPhase` 语义：只在 idle↔running 真正变化时发；发射异常 fail-open
  告警不静默），factory 从宿主事件总线（`ctx.emit`）接线 `emitStatus`。
- **改审批策略命令报 `agent.inject is not a function`**：桌面端 approval/policy 命令路径
  调 `agent.inject`（dsh-user-approval `setPolicy:127`），duck-type 面缺这个方法。
  新增 `inject(message)`：落盘 user/message + 并入下一请求装配，**不唤醒空闲 agent**
  （镜像内建 `send(input,'next-step', false)`；pendingSteers 在 runTurn 每次请求前消费，
  含下一回合首请求，下一请求必然可见）。

### 测试

- 新增 `test/host-conformance.test.ts`（8 用例）：宿主同款消息形状校验（整条日志逐事件
  过 `assertMessageEventShape`/`hasProviderModel` 本地镜像）、换模实时 source、unknown
  兜底、agent/status 转换序列精确性（不重复不遗漏）、发射异常熔断、inject 三态
  （空闲/运行中/dispose 后）。
- 新增 `test/v032-conflict.test.ts`（4 用例）：W1 assistant 线消息携带 source（forAdapter
  契约，崩溃主因）、W2 nudge 后继续产出不中断（进度感知护栏）、W3 属性值 XML 实体解码
  （`&amp;quot;` 不二次展开）、W4 DSML 内联属性 + parameter 混合形态整体缓冲。
- 截断修复批次：`test/v032-truncation.test.ts`（8 用例，并行批次交付）。
- 全量 318/318 通过（0 skip；离线 mock 全链路，零 API 调用）。

## [0.3.1] - 2026-11-18

**桌面端思考过程显示修复 + 任务半途截断修复 + 第三方评审反馈修复合集。** 三部分内容并入
同一补丁版本：评审反馈修复（只动评测产物与文档，不改运行时行为）、思考过程显示修复与
截断修复（改运行时行为，见下）。

### Fixed（任务半途截断 —— 占位 final / 过期 final / 重复命令）

**现象**：任务做到一半就"收尾"，用户侧看到的最终答案是一句 `placeholder`；桌面端过程区
里还能看到裸的 `</tf-bash>` 之类协议残片。取证实录：模型第 4 步写下
`<tf-final id="f1" summary="placeholder"/>`，之后又继续跑了 3 步，而那条过期 final 仍是
"最后一个 ok 的 final"，回合结束时被当作交付答案落盘。

四个根因，逐一修复：

- **占位 final 被照单全收**：`tf-final` 只要有 `id` 就算收敛，summary 是空串/占位词也照样
  交付。新增 `kernel/final.ts`（纯函数、零 IO）做 summary 质量闸：空 → `empty`，
  占位形态（`placeholder` / `占位` / `TODO` / `TBD` / `N/A` / `待补` / 纯标点 …）→
  `placeholder`；判据刻意保守，`done`、`已完成` 这类短答案一律放行（不猜"答案够不够详细"）。
  被拒 → 注入 `[tf-stream:error]` 结构化原因（要求写最终答案原文），同类拒绝只注入一次；
  模型屡教不改 → 回合以 `blocked` 如实收场，绝不再把占位当交付。
- **过期 final 仍被当答案**：新增回合级命令序（`#cmdOrder` / `#lastFinalOrder` /
  `#lastNonFinalOrder`）——一条 final 之后又发出过任何非 final 命令，这条 final 即判
  `stale`（答案已过期），必须在本流末尾重新声明；`tf-final` 候选同时按**回合归属**过滤，
  上一回合的 final（含 resume 回放 `turn=0`）不得充当本回合答案。同 id 覆盖式重发会刷新
  final 序，不再被误判过期。
- **重复命令空手而归**：观测内容只在"易变尾"注入一次，跨请求即消失（历史里只剩句柄目录行）；
  模型丢上下文后最自然的动作就是把同一条 read/glob 再发一次，而旧实现只回
  `duplicate-idempotent（handle=…）`——内容拿不到，于是原地打转直到用占位 final 收场。
  新增 `#queueReplay` / `#materializeReplays`：幂等语义不变（**不重复执行**），但把原结果
  按既有上限回灌一次（`[tf-stream:replay]`，带 handle 与 `tf-peek` 指引），每回合上限 4 次，
  超限记 `replay-capped` 不静默。回灌**延迟物化**——只有真正要发下一次请求时才 `peek`，
  收敛/阻断路径直接丢弃，不占 `injected` 计数（口径仍是"确实进入模型上下文的观测负载"）。
- **孤立闭合标签落进正文**：模型给自闭合命令又补一次闭合（或手写残片）时，`</tf-xxx>` 在
  ground 态没有配对打开，旧 parser 判 prose 透传 → 以纯文本落进 assistant/message。
  现在按 `malformed(stray-close-tag:<name>)` 记账后丢弃，跨 chunk 与流末尾半截同样处理；
  `</div>` 这类普通 HTML 闭合不受影响。

回归：298 用例全绿，新增 8 条——`K1` 占位 final 被拒后重发真答案、`K2` final 后又发命令判
过期、`K3` 重复命令回灌原结果、`K4` 屡教不改不交付占位答案；解析器侧 4 条（孤立标签 / 跨
chunk / 流末半截 / HTML 闭合不误伤）。

### Fixed（思考过程显示 —— 桌面端"乱码"bug）

**现象**：electron 桌面端跑 stream 模式时，模型的思考过程显示错误，输出内容大多是乱码。
取证（本机会话日志 `~/.dsh/sessions/` 真机样本 + 宿主渲染面源码）定位到三个根因，逐一修复：

- **思考过程被丢弃**：驱动器对 `reasoning-delta` 只计体积（`reasoningChars`）不落盘，
  而桌面端思考区只认 assistant 消息里的 `{type:'reasoning'}` 内容块（取证：
  `dsh-client-ui-chat/src/client/conversation-nodes/event-projection.ts:117`）。本版把
  reasoning delta 按块捕获，随 assistant/message 落成首个内容块（块序镜像内建
  BlockAssembler：思考先于正文；中断路径的部分思考同样落盘）。
- **协议标记与 DSML 噪声进正文**：0.3.0 把整段流原文（含 `<tf-*>` 标记）落成消息文本；
  模型偶尔混入的原生调用格式 `<｜｜DSML｜｜ …>`（全角竖线）在桌面端渲染成乱码，协议
  标记则被 Markdown 渲染器吞掉或显示破碎。两处修复：
  - **落盘正文纯 prose 化**：assistant/message 只落解析器的 prose 事件（命令事实仍完整
    记在 `plugin:tf-agent/*` 台账，会话事实层不丢、resume 重放不受影响）；
  - **parser DSML 归一化**：`<｜…DSML…>` 形态一律不作为 prose 透传——
    `<｜｜DSML｜｜ invoke name="tf-xxx" …>` 改写回等价 tf-* 头部（命令不丢），
    其余包装行按 `malformed(dsml-wrapper)` 记账后丢弃（只进台账，不注入、不打断流）。
  - 协议文本补第 7 条规则：禁止输出 DSML/原生调用格式（省输出 token，治本）。
- **无实时流**：驱动器从不发 `agent/assistant-stream` 帧，桌面端在整个流期间没有 live
  内容（内建 loop 的思考区 live 数据源就是这套帧）。本版补发：start → 逐 reasoning-delta
  chunk → end。契约对齐宿主两端 fold（`SessionAssistantStreamAccumulator.accept` 要求
  revision 逐帧 +1、chunk index 逐块 +1；客户端 `ClientAssistantStream.acceptFrame`）。
  两条自保语义：**正文不逐帧透传**（流文本是协议标记，实时显示会闪现乱码）；**工具广告
  前收束 attempt**（广告是流中落盘的 assistant/message，落在活跃 attempt 内会被客户端
  fold 暂存进 pending 且 end 帧只消费一条结算 → 滞留到下一步触发 `events.restart()` 整窗
  重建）。发射异常熔断（本会话不再发），无端口/无监听器是 no-op——headless/离线零影响。

### Fixed（评审反馈）

- **评测产物 GBK 乱码**：`eval/tools/runner.cjs` 有 7 处输出文案、`eval/RESULTS.md` 有 10 行
  「cached 字段」取证行是早期 GBK 编码残留的替换字符（U+FFFD），grep 不到、无法检索。
  已还原为中文；并把 46 个 `metrics.json` 与 5 个 `summary.json` 里的同类 `note` 字段一并迁移
  （**只改文案，数字与口径未动**）。`runner.cjs` 的**代码注释**仍有历史乱码（不可逆，不影响执行），
  后续重写该文件时清理。
- **`gen-results.cjs` 覆盖证据文档**：它默认写 `eval/RESULTS.md`，而 §6（0.3.0 复算）是人工追加段，
  重跑新批次会整段丢失。新增 `--out <路径>`，并对「目标含 §6」直接拒写（需 `--force` 才覆盖）。
- **RESULTS.md 两处误读点**：`replay` 列改为 `metrics.json` 回填后的复算值（对照臂 10/10 PASS），
  并加注记说明与历史 FAIL 快照的区别；`stream/W1`、`stream/C2` 的 `exit=1` 行链到
  [docs/limitations.md](docs/limitations.md) 第 2 条（重入预算护栏耗尽，产物 checks 判 PASS，不是任务失败）。
- **`eval/GATE-0.3.0.md` 自相矛盾**：模板写「回退演练：已执行」但复选框是 `[ ]`，等于假记录。
  改为「未执行（待真机）」，与 G6 判定一致。
- **§6.1 的 `summary.json` 没写路径**：补成 `eval/runs/2026-11-15-v02/summary.json`（该文件本已入库）。

### Added

- **`eval/tools/machine-test.cjs`**：单项目实机对照——默认配置下「插件关 / 插件开」两臂各跑 1 次，
  自动 `summarize` + `gen-results --out`（不碰 `eval/RESULTS.md`），产出
  `eval/runs/<stamp>/machine-test-report.md`。支持 `--plan`（不读 key）/ `--report-only` / `--runs`；
  key 只进子进程环境变量，日志只印后 4 位。
- **`eval/machine-test-2026-11-17.md`**：本轮实机测试手册（两臂定义、命令、判读顺序、红线、故障排查）。

### Changed

- **CI 覆盖面**：`.github/workflows/ci.yml` 新增 `npm run check` 与 `npm run gate -- --offline`；
  `gate.mjs` 增加 `--offline`（只判 G1–G3：装配一致性 / 单 loop 权威 / 卸载原子）。
  G4（tag=package）只在发布提交上成立、G5/G6 需真机数据，故不进 CI，仍由发布流程与真机复测守。

## [0.3.0] - 2026-11-17

**独立模式 + 全量升级条目。** 交付形态固定为 A-1（专用 profile）；按
`upgrade-plan/`（alpha.1 → alpha.2 → beta.1 → beta.2 → 0.3.0）完成 M/S/K/F/R 五组全部条目，
并把 **0.4.0 规划的 F5/F6/F7 一并实施**（合并产出，最终版本号标记 0.3.0，
实施对照见 `docs/v0.4.0-plan.md`）。

另含**会话日志格式修复（发布前并入，不单独发版）**：0.3.0 开发期写出的会话日志在宿主
v4 校验下被判 corrupt（`tool/call <id> has no advertised tool lifecycle`），桌面端点开历史
对话报"加载失败"；本版修正写入路径，并附存量日志修复脚本。

### Added

- **独立装配（S 组）**
  - **专用 profile 模板（S1）**：`profiles/stream`（web 入口）与 `profiles/stream-headless`；
    组合顺序 `dsh-base → 主 bundle → preset bundle → 入口`；`agent-loop` 停用只在主 bundle
    patch（C4 卸载原子），profile patch 只承载 registry 默认值覆盖。
  - **安装前置校验（S2）**：`scripts/install-check.mjs` —— 允许列表只有 `stream` /
    `stream-headless`；误装 `web`/`desktop` 100% 被拒（含原因与允许列表）；dry-run 打印
    目标 profile、组合包、patch 与受影响 entry；只读不写，无"强制安装"开关。
  - **`preset-stream` 独立 bundle（S4）**：`preset/stream/` —— 只声明映射工具面
    （tool-fs（applyPatch 开）+ tool-fs-search + pwsh/bash 平台二选一）；preset 行不进主
    bundle patch（B 形态不污染既有 profile）；registry 默认值由 profile patch 覆盖指向
    `stream`；headless 不引入 preset。
  - **装卸与回退（S6）**：`scripts/install-cycle.mjs` —— 10 轮 add → 启动自证 → remove →
    恢复验证；回退路径 = 回退 0.2.x 产物或删 profile，不手工修 profile。
  - **双 loop 具名诊断（S3）**：`setFactory` 冲突转 `E_DOUBLE_LOOP`（Error.name），
    携带 profile 标识（宿主 profileContext / env DSH_PROFILE）、冲突来源与处置建议；
    不 catch 后继续、不自动重试。
  - **禁用行审计（S5）**：`docs/disabled-lines-audit.md` —— 逐行记录依赖与结论；审计后
    放弃 0.2.x 计划的全部"候选停用行"（宿主提示行不进请求，停用无 token 收益）；
    PTC 四行 / compaction 四行同族同进同退。
- **能力面（F1–F4）**
  - **`tf-edit` / `tf-append`（F1）**：精确替换（OLD/NEW 标记块，映射宿主 `edit`）与
    只追加（anchor 锚点插入或 EOF 追加，映射宿主 `edit` / `apply_patch` `*** End of File`
    锚）；匹配失败结构化报错，不做模糊匹配、不静默改全文；编辑成功只回回执。
  - **`tf-grep` / `tf-glob`（F2）**：映射宿主 fs-search，只回匹配行（带行号）/ 路径，
    不回全文；协议文本明写"不要用 tf-bash 做搜索"。
  - **code 结果可见性（F3）**：仅 tf-code 显式开启时，首成功/变化值 ≤4000 字符
    （`codeValueInjectLimit` 可配）完整注入，省一次 tf-peek 往返；超限转骨架 + 句柄。
  - **原生通道上限（F4）**：声明 `nativeToolSchemas` 时，原生 tool_call 单块结果
    > 6000 字符（`nativeResultLimit` 可配）→ obs 句柄化 + 骨架，杜绝全量回灌后门。
- **中性能力（0.4.0 规划条目，随本版实施）**
  - **计划与验收（F5）**：`tf-plan` 命令（body = `- [id] 验收项` 行）+ 公共属性
    `accepts`（任意命令可声明验收关联）；计划状态放驱动器侧，请求**只注差分**
    （新计划全量一次，此后只注新增/已验证/已移除；无变化不产生块）；验收项只能被
    **命令成功回执**验证（模型自述不算证据）；有未验证验收项时 `tf-final` 判过早；
    `enablePlan: false` 回退点。
  - **恢复意图（F6）**：新增 `entry/intent-log.ts` —— 变更类命令（tf-write/tf-edit/tf-append）
    派发**前**意图 fsync 落盘（`<stateRoot>/intents/<session>.jsonl`：op/path/内容指纹），
    落定即回执；resume 发现"有意图无回执" → **停机核对**（`runTurn` 直接 blocked，
    不发请求、零注入、不自动重放）；CLI `dsh-stream-agent intents`（三态判定列出）/
    `intents --ack <session>` 人工确认闭合；三态 = 未发生 / 已发生 / 不确定（强杀三时点
    可区分）；`enableIntents: false`、`resumeIntentPolicy: 'ignore'` 回退点；
    强杀演练 `eval/tools/f6-kill-drill.cjs`（10 轮 SIGKILL × before/mid/after-write 三时点，
    离线零 API 已跑：0 重放、0 重复写）。
  - **长会话段边界（F7）**：先出 **ADR-001**（`docs/adr-001-segment-boundary.md`，
    采纳"整块丢弃"、拒绝宿主压缩与摘要改写）；`render.ts` 新增 `dropAppendHead()`
    （整块 + policyLog 记录 + 前缀基线重置——唯一合法的前缀重置入口，未记录的漂移仍
    fail-closed）；驱动器 `segmentMaxChars`（默认 160k 字符 ≈ 40k tokens，0 = 关闭）在
    新回合开始处整块丢弃旧段；被丢弃原文 obs 句柄化（`obs:read:seg-*`）可
    `tf-peek` / `peekHandle()` 回取；`appendBlockCount` / `appendChars` 只读投影；
    测试：50 回合 × 2 请求 = **100 请求 0 前缀违规**，末/首请求 ≤1.5×。
- **计量与治理（M 组 / R 组）**
  - **M1 四分量计量**：`eval/tools/summarize.cjs` —— 逐请求 usage 原文求和
    （输入/缓存读/缓存写/输出），标题旁路剔除，缺失分量标"不可得"不按 0 计；
    产出 `summary.json` + Markdown 表；`eval/RESULTS.md` §6 以 2026-11-15-v02 批次复算
    （基线 446,410 → 插件 129,178 = 28.9%，与历史 22.3% 批次的不可比性如实说明）。
  - **M3 replay 修复**：对照臂提取器两个根因——①属性序敏感（path 必须在 id 前）；
    ②`text-delta` 增量字段读错（`textDelta` → 实际 `text`）——修复后对照臂回放一致性
    **10/10**（树哈希 == 实跑，含 64 次写入回放）；支持 tf-edit/tf-append 回放；
    提取器错误如实记"提取失败"；零写入任务种子树 == 结果树即通过。
  - **M2 T3 三格采集**：`eval/tools/t3-cells.cjs`（首请求拆分 system/协议段/工具 schema/
    任务四部分 + A-1a==B 逐字节判定 + 差值 == code 段长度判定）；三臂 patch：
    `patches/eval-stream-code-on.yml`（A-1a）/ `eval-stream-code-off.yml`（A-1b）；
    B 格用 v0.2.1 tag 产物；tf-code 协议段实测 1,175 字符。
  - **R2 一致性检查**：`scripts/check-consistency.mjs`（`npm run check`）—— entry 集 /
    inject / 装载顺序 / README 命令表四项，一条命令复跑；当前 4/4 全绿。
  - **R4 发布门禁**：`scripts/gate.mjs`（`npm run gate`）—— 装配一致性 / C2 单 loop /
    C8 卸载原子 / C9 tag=package / C1 token 门槛 / 回退演练六项；离线项就地判定，
    真机项（G5/G6）如实标"待人工复测"，未过不发布。
  - **K6 真机五场景**：`eval/tools/manual-code-scenarios.md`（成功/失败/取消/拒绝/partial，
    每场景记录 kind/账本/最终状态）。
  - **测试命题**：`docs/TEST-PROPOSITIONS.md` —— A 组回归 + B 组新能力（B1 编辑、B3 搜索、
    B4 计划、B5 幻觉检查、B6 五场景、B7 强杀、B8 段边界、B9 双 loop、B10 校验）+
    C 组成本对照；≈2 元/命题，供人工复测。
- **会话日志修复工具（发布前并入）**
  - **`scripts/repair-session-logs.mjs`：存量日志修复**。默认 dry-run，`--write` 落盘；
    为缺失广告的 `tool/call` 补入同 turn/step 的 `assistant/message`（tool-call 块），
    把误写在 `step/end` 之后的 final 答案移回 step 内，重排 seq 与全部 seq 引用
    （`sourceEventSeqs` / `messageSeqs` / `throughSeq` / `headerSeq` / 压缩范围），
    写前备份 `.bak-<时间戳>`、写后清除投影缓存；设 `DSH_HOST_MODULES` 时用宿主自己的
    v4 校验器复核（`restoreReleasedV4Artifact` + `assertReleasedV4Relationships`）。
    实测：本机 10 条历史会话全部修复为可读，27/27 会话通过宿主校验。
  - **`test/session-format.test.ts`**：S1 正常回合的广告顺序、S2 派发前异常的
    `TOOL_NOT_STARTED` 闭合、S3 final 答案早于 `step/end`；用"宿主同款"假工具管线
    （start → tool/call，commit → tool/result）复核生命周期。

### Changed

- **K1：`tf-code` 默认关闭**。`balanced` 模式的 `enableCode` 从 `'auto'` 改为 `false`
  （`'auto'` 保留为兼容值、等价 false）；驱动器语义改为"仅显式 `enableCode: true` 且
  `executeCode` 端口在位才启用"；`cordis.patch.yml` / `preset.yml` / `patches/eval-stream.yml`
  显式写 `enableCode: false`（装配断言）。默认装配协议段 0 字符，模型不会幻觉调用；
  关闭 ≠ 删除通道：`ptc-runtime` 等四行保留，`no-code-channel` 命令级失败引导改道。
- **K2 策略透传与沙箱记账**：`ptc-bridge` resolve 透传会话 cwd（session header.cwd →
  workingDirectory 服务默认目录，不复制宿主优先级规则）；`result.sandbox` 的
  `mode`/`denied`/`enforcement` 逐次记账（新增 `sandbox` 台账记录与 DriverRecord 类型），
  `enforcement=partial` 显式可见。
- **K3 失败分类保真**：`CodeOutcome` 结构化（`kind`/`retryable`/`advice`）；
  `classifyCodeFailure()` 逐类给出可重试结论（八类 kind 原样保留 + `ptc-runtime-misuse` /
  `quota-exceeded`）；注入文案 `[kind=... retry=yes|no]` + 日志尾 200 字符；
  沙箱拒绝与代码错误分开引导。
- **K4 取消链路**：驱动器新增回合级 `#turnController`（runTurn 创建、cancel abort、
  finally drain 等待在途清理再释放）；tf-code 与 executeTools 派发共用回合 signal，
  替换原"独立且永不触发的 AbortController"；取消类错误识别（`isAbortError`）与超时分账。
- **K5 配额**：`codeQuota`（maxSubcalls/maxOutputBytes/maxWallMs，缺省 64 / 256KiB / 300s）；
  配额在绑定调用与结果两侧硬终止（程序内吞掉配额错误也照样结构化终止），
  墙钟经自铸 controller abort 传导，与宿主 timeout 独立记账。
- **协议文本**：命令表新增 tf-edit/tf-append/tf-grep/tf-glob/tf-plan 与"计划与验收"节；
  修正 v0.1 遗留的过时描述（"tf-read 成功不回灌"→ 实际首版/变化完整注入）；
  tf-code 段补配额与沙箱事实说明。
- **护栏按回合重置（F7 测试实抓的真 bug）**：`#reentryCount` / `#finalNudges` /
  `#finalOnlyRequests` 在 `#turnLoop` 入口清零——此前跨回合累计，多任务长会话会在
  第 N 个回合被历史计数误杀（blocked 重入上限）。
- **版本**：`package.json` / `src/version.ts` → 0.3.0；`files` 增加 `profiles/` 与 `preset/`；
  `scripts` 增加 `check` / `gate`（另有并入的 `repair-session-logs.mjs` 存量日志修复）；
  engines 维持 `dsh >= 0.2.2-rc.1`。
- `preset.yml` 与 `cordis.patch.yml` 对齐（stream-agent inject 补 `sessionProjections`，
  与 0.2.1 真机验证过的装配形态一致）。
- **兼容性（会话日志）**：装配、协议、配置项全部不变（`enableCode` 仍默认关闭）。0.3.0 起
  写出的日志可被 0.2.x 读取（新增的只是合法的 `assistant/message` 事件）；0.2.x 及 0.3.0
  发布前的开发期产物写出的旧日志仍需跑一次 `repair-session-logs.mjs` 才能加载。

### Fixed

- **M3 对照臂 replay 0/10 → 10/10**（详见 Added/M3）。
- **多回合护栏误杀**（详见 Changed/护栏按回合重置）。
- **F6 演练脚本与 t3-cells 的 Windows 路径 / 事件循环问题**（file:// URL 导入、
  Atomics.wait 阻塞 stdout 事件）。
- **会话日志 v4 工具生命周期（致命，桌面端"历史加载失败"的直接原因）**
  - **工具调用生命周期缺失**：驱动器把 tf-* 命令映射成宿主工具后直接调
    `ctx.tools.execute`，由宿主管线写 `tool/call` + `tool/result`，却从未写 v4 格式要求的
    `assistant/message`（content 带 `tool-call` 块）。`dsh-session-format-v3-to-v4` 的
    `tool()` 在读取时抛 `tool/call <id> has no advertised tool lifecycle` → 整条日志被判
    corrupt；表现是会话列表能列出、点开却"历史加载失败"。现在每次派发**前**先广告同名
    同参的 tool-call 块（`advertiseToolCalls`）；派发异常 / 批次缺项时用 `repairToolCall`
    闭合生命周期——未开始 = 宿主唯一接受的 `TOOL_NOT_STARTED` 修复形状
    （`message.id = interrupted-tool-result-<callId>-<n>`、`isError:true`、
    `error.code = TOOL_NOT_STARTED`），已开始 = 普通错误结果，已有 result 不重复写。
    原生 `tool_call` 通道的调用块随同一条 assistant 消息一起广告。
  - **final 答案写在 step/end 之后（同类 corrupt）**：`finalAnswer` 原在 `step/end` 之后写
    `assistant/message`；v4 要求该事件落在打开的 turn+step 内（否则读取时抛
    `assistant/message does not match an open turn and step`）。收束判定前移到
    `step/end` 之前写出。
  - **不可重试流错误的 step/end 早于在途工具**：fail-fast 分支先写 `step/end` 再结束，
    流中途已派发的 `tool/call` 会在 `step/end` 之后才落 `tool/result`（同一类 corrupt）。
    现在先 `drain()` 等在途工具落定，再写 `step/end`。

### Security

- 安全声明收口为"文件效果边界 + 事实记账"（C5）：`docs/limitations.md` §5b-1 明确
  ①只覆盖文件效果（网络/进程不在范围）；②Windows 档 `enforcement=partial`；
  ③`danger-full-access` 无约束；④preset/profile 不是安全边界；⑤`partial` 与
  `danger-full-access` 在账本与文档中显式可见；全文无"隔离/等权"表述。

### 测试

- 275/275 全绿（+5 F5 计划验收、+5 F6 意图、+4 F7 段边界、+3 会话格式回归）。
- 离线演练：F6 强杀 10 轮通过；M3 对照臂 replay 10/10；M1 复算一致。
- 真机复测项（不阻塞本版提交，阻塞正式发布）：R3 评测矩阵重跑、M2 三格、K6 五场景、
  S6 十轮装卸、回退演练 —— 全部命令与命题见 `docs/TEST-PROPOSITIONS.md` 与
  `eval/GATE-0.3.0.md`。

## [0.2.1] - 2026-11-16

**装载期热修 + 控制栏。** 0.2.0 在 dsh 桌面 profile 里"装了但完全不能用"
（`1 entry did not activate stream-agent`），根因是两个独立的 Cordis 4.x 契约违约；
本版把两者都修掉，并补上给新用户看的控制栏（四模式 + 中英切换 + 桌面控制页）。

> 注：本节末尾的"模式标注（saving/availability）"与 `wrapText()` 重写两节在 v0.2.1 tag
> 之后完成，随 0.3.0 一并发布（R1 纪律：不追溯移动已发布 tag）。

### Fixed

- **可选服务裸读（致命，桌面端装载失败的直接原因）**：`apply()` 里写的是
  `(ctx as { ptcRuntime?: unknown }).ptcRuntime ?? ctx.get?.('ptcRuntime')`——
  `??` 左侧先求值，而 Cordis 4.x 的 context 是 Proxy，对未 inject 的属性读取直接抛
  `cannot get property "ptcRuntime" without inject`（`cordis/lib/index.js:1251-1280` 的 get trap），
  右侧兜底永远到不了。`ptcRuntime` 是可选服务（宿主不挂 PTC 时不存在），于是 entry 装载期抛错。
  新增 `entry/cordis-compat.ts` 的 `getService()`：只走 `ctx.get(name)`（reflect.get 无 inject 要求），
  属性回退包在 try/catch 里兼容测试桩；loop / state-handle / action-gate 的
  `ptcRuntime` / `loader` / `sessionProjections` / `agentDefaultModel` / `storage` / `logger`
  全部改走它。
- **函数式插件返回值违约（致命，被第一个缺陷掩盖）**：五个 entry 结尾都 `return { ...句柄 }`。
  Cordis 把函数式插件的返回值当 **effect** 收集（`cordis/lib/index.js:431-459`），
  只接受 function / null / thenable / iterator，普通对象直接
  `TypeError: Invalid effect`（:460）。新增 `asPluginEffect()`：把句柄包成一个可调用 disposer，
  句柄属性原样挂在函数上——测试与调用方读取方式不变，Cordis 侧拿到合法 effect。
- **后果链（如实记录）**：entry 抛错 → fiber 进 failed 态 → `setFactory` 注册被回滚 →
  bundle 里内建 `agent-loop` 已被停用 → 该 profile 一个 agent 都创建不出来。
  两个缺陷任一存在都会导致同一现象，日志只显示先抛出的那一个。

### Added

- **控制栏（`entry/control-bar.ts` + `dsh-stream-agent` 命令）**：装载时在 stderr 打印
  引导面板（接管状态 / 当前模式 / 上手四步 / 打开方式），并提供交互栏
  `dsh-stream-agent bar`——1-4 切模式、Up/Down 移动、Enter 应用、`l` 中英切换、
  `?` 全模式指南、`r` 重置、`q` 退出；另有 `status` / `mode <id>` / `lang <zh|en>` / `--json`。
- **四个运行模式**（`kernel/modes.ts`，只映射既有配置项）：`balanced` 均衡（默认）、
  `lean` 精简（60k 预算阶梯）、`compat` 兼容（全文回验 + 串行）、`power` 增强（显式开 tf-code）。
  模式只提供默认值，装配里显式写的配置永远压过模式。
- **每个模式标注「省多少 token / 能不能用」**：`saving`（most / more / baseline / least，四档）
  + `availability`（默认模式 / 开箱可用 / 需宿主 PTC）+ 一段 `note` 说明口径。四处渲染同源
  （`modeBadges()`）：装载引导面板一行、交互面板展开当前模式全文、`?` 帮助页逐模式一行、
  桌面模式卡两行 + 标注块。**口径如实**：只有「默认参数 vs 原生 loop」有十任务两臂实测
  （约 29%），其余三档是方向性判断并明写"未单独实测"——不把没测过的数字写成百分比。
- **模式目录单一投影**（`publicModeCatalog()`）：此前 loop 与 `ui/index.js` 各写一份 map，
  加字段必漏一处；现在 CLI `--json`、控制路由、桌面页共用同一份字段（`config` 不进网络载荷）。
- **中英双语**（`kernel/control-bar.ts`）：面板、引导、帮助、状态条、`--json` 全量双语；
  `l` 键或 `dsh-stream-agent lang en` 即时切换，落盘到 `control.json`，三个面（装载横幅 /
  CLI / 桌面控制页）共用同一份状态与文案表——不存在"横幅中文、命令英文"的错位。
- **桌面客户端控制页（`ui/` 子包）**：左侧栏新增「控制栏 / Control bar」滑杆图标，点开是整页：
  接管状态、当前模式与来源、六个生效参数、状态文件路径、更新时间、四张模式卡（含"什么时候选 /
  代价"）、中文/English 切换、刷新与 CLI 等价命令。页面走 dsh 自己的客户端插件机制
  （`dsh.client` + `ctx.slots` 的 `main` / `sidebar.panellist`），**不修改 Electron 壳、不重打包
  客户端**。写路径经 `streamAgentRuntime` 服务回到 loop（内存 + `control.json` 单一事实源），
  支持 `updatedAt` 并发栅栏（多窗口 409 刷新；文件尚未写入时以 `null` 作为期望值，
  语义是"首次写入"，别人先写过就判过期）、装配/环境变量锁定置灰、loop 未接管时的只读降级。
  **已在真实桌面窗口完成人工验收**（左侧栏图标 / 整页 / 四张模式卡 / 中英切换 /
  明暗主题 / 重启后保留）。可行性评估与边界见 `docs/desktop-ui-feasibility.md`。
- **状态落盘**：`<stateDir>/control.json`（`{ mode, lang, schema, updatedAt }`），
  优先级 `装配 config > STREAM_AGENT_MODE/LANG > control.json > 内置默认`；坏文件告警后回默认，
  绝不让"配置文件坏了"阻断装载。
- **接管事实登记**（`entry/takeover-registry.ts`）：控制栏横幅的"接管生效 / 未接管"读实时事实，
  不靠时序猜测；`onTakeover` 订阅保证控制栏排在 loop 前后挂载都能正确显示。
- 测试 +47 例（`test/activation.test.ts` 10 例 + `test/control-bar.test.ts` 26 例 +
  `test/desktop-ui.test.ts` 11 例），含"严格 inject 守卫 ctx"的装载回归与
  "主包不得声明 dsh.client / UI bundle 语法 / 路由鉴权与 409 / 首次写入语义 / 中英文案键集对齐 /
  模式标注与投影一致 / 折行不切英文单词且行首无标点"的桌面页回归。
  全量 255/255。

### Changed

- `package.json`：版本 0.2.1；新增 `bin: { "dsh-stream-agent": "./dist/entry/control-bar-cli.js" }`；
  `files` 增加 `ui/`。
- `cordis.patch.yml` / `preset.yml` / `patches/takeover.yml`：新增 `stream-agent-control-bar` 与
  `stream-agent-ui` 两个 entry（共 7 个），control-bar 排在 loop 之前装载；UI 必须独立成子包，
  因为 `dsh-client-modules` 以包为单位扫描，同包多 entry + `dsh.client` 会抛多源错误。
  `preset.yml` 的行序同步调回 `sidecar → control-bar → ui → loop`（原文件把 loop 排在 sidecar
  之前，与文件自己的装载顺序注释相矛盾）。
- `loop` 配置新增 `mode` / `lang`；`maxParallelToolCalls` / `maxReentries` / `budgetTokens` /
  `selfReadFeedback` / `enableCode` / `persistFallback` 的取值改为
  `显式配置 ?? 模式预设 ?? 内置默认`；`resolveEffective()` 改为每次创建 driver 时重算，
  桌面页切模式后新会话立即生效。
- `control-state.ts`：新增 `langSource` 与 `updatedAt`（并发栅栏）；来源联合类型增加
  `runtime`，表示"本进程内已生效但落盘失败"。
- `scripts/build.mjs`：增加桌面页构建闸门（主包禁止 `dsh.client`、UI 包声明、
  `ui/index.js` 可导入、`ui/client.js` 语法与模块 id）。
- 接管横幅追加 `mode=<id> (<来源>)`，排障时一眼看出模式从哪来。
- `wrapText()` 重写为"先切单位再贪心填充"：宽字符逐字可断、ASCII 单词/路径不切开、
  闭合标点粘住前一个字（行首不出现标点）、末行不留孤字；`labeled()` 支持统一标签宽度，
  同一块里"当前/适合/省 token/可用性/标注"的值列左对齐。旧实现遇空格回退，中文里夹
  `ctx.ptcRuntime` 这类 token 时行尾会留十几列空白，一屏里好几行右端参差。

## [0.2.0] - 2026-11-16

四个已知限制的定向修复（README「已知限制」1–4 ↔ `docs/limitations.md` 1/3/5/7），
外加 `tf-code` 程序化执行通道（PTC 桥接）。

### Added

- **自写回验 receipt（O7，修「写批任务 token 偏重」）**：`tf-read` 命中本任务 `tf-write`
  已写过的路径时，不再回灌全文——全文本来就在模型上下文里，改为注入回执
  （`[tf-stream:receipt]`，行数 + sha256 指纹），掐断"写 → 读回验 → 再改"循环；
  协议文本新增"回验纪律"。读外部文件的完整反馈保持不变；`selfReadFeedback: 'full'`
  可恢复 v0.1 行为。默认开启。
- **steer 语义对齐内建（修"插队队首、回合边界生效"）**：回合运行中收到 steer → 注入
  运行中回合的**下一请求**（追加区 `[tf-stream:steer]` 用户块，前缀单调不破；带未消费
  steer 时不允许收敛）；单流"流内不打断"（不掐当前流）前提不变。空闲时保持原语义
  （插队队首、当新回合任务）。`inbox.nextStep` 如实暴露未消费 steer。
- **本地持久化兜底（修"持久化依赖宿主 storage"）**：新增 `entry/json-persistence.ts`
  （零依赖）——宿主缺 storage backend 时 state-handle 降级本地 JSON 文件 KvUnit
  （durable，跨会话 resume 可用）；宿主缺 `sessionPersistence` 时 AgentFactory 用本地
  JSONL 会话日志（create 落盘、resume 冷读，事件经 `withEventCapture` 镜像），headless
  跨会话 resume 真正可用。状态根目录：`STREAM_AGENT_STATE_DIR` env → `~/.dsh-stream-agent`；
  `persistFallback: false` / `localFallback: false` 可关闭（回 v0.1 内存降级）。
- **本地文件台账（修"bundle 形态 plugin record 降级内存"）**：`attachSessionLedger` 改走
  宿主 loader 三级同源解析（`loader.import` → `loader.internal.import` → 动态 import，
  与 dsh-scope 同款）；仍不可达时降级**本地 JSONL 文件台账**（可重放，不再是易失内存），
  resume 时 `rehydrateRecords` 把 final 答案回灌新驱动器（同 id 新 summary 覆盖，
  last-wins 语义与运行中一致）。
- **`tf-code` 程序化工具调用（PTC 桥接）**：把宿主 PTC runtime（`ctx.ptcRuntime` 服务缝，
  `@deepseek-ai/dsh-ptc-runtime`）收编为单流协议的执行通道——模型在流里写
  `<tf-code id="c1" description="...">（async TS 函数体）</tf-code>`，闭合即派发到 runtime
  沙箱执行，返回值（无损 JSON）句柄化进 obs 账本（新 `code` 族：首个/变化结果注骨架，
  失败一律 high），中间结果不进上下文。
- 绑定命名空间 `tools`（write/read/pwsh）走驱动器同一条 `executeTools` 通道——宿主
  guard/工作区策略/凭据全部生效（安全面与 PTC 模式等权：程序自身不做任何直接 IO）。
- 协议文本按通道可用性声明：`executeCode` 端口在位才追加 tf-code 段（稳定前缀构造期
  冻结，通道不存在就不会被模型幻觉调用）；`enableCode: false` 强制关闭。
- 通道缺失/形状不符时 tf-code 命令级失败（`no-code-channel`）并引导改道 tf-bash，
  告警不静默（fail-open，红线 5）。
- 测试 208 用例（新增 `test/fix-limits.test.ts` 11 例 + `test/ptc-bridge.test.ts` 10 例 +
  A2/A4 更新为修复后语义）。

### Changed

- `apply` 配置新增 `selfReadFeedback` / `persistFallback` / `stateDir`；
  `state-handle` 配置新增 `localFallback` / `stateDir`。
- 本地兜底默认开启：首次使用会在状态目录创建 `sessions/`、`ledger/`、`storage/` 子目录。

### Design

- 与官方 PTC 模式（`run_code` 工具，`dsh-tool-executor-ptc`）正交互补：PTC 改"工具调用
  介质"，tf-code 改"循环层"——单流协议负责编排（depends_on / 隐式写序 / 前缀单调），
  重型数据加工下沉到 PTC runtime，两层优势叠加而非二选一。

## [0.1.1] - 2026-11-15

首次发布到 npm（`@hugesb/dsh-stream-agent`）。

### Fixed

- **桌面端 preset 层工具解析失败**：agent 作用域改用宿主同源 `dsh-scope` 铸造，key 取 agent
  实例本身（镜像内建 `createScope(loopCtx, this)`）。此前作用域 key 不是 agent 实例，
  宿主工具执行器 `selectExecutor(input.agent)` 与守卫 `chainLayers(exec.agent)` 走
  `scopeChainOf(agent)` 时永远落到根层，而 desktop/web 组合的根层不含 `write`/`edit`/`pwsh`
  （这些在 `standard.patch.yml` 的 preset 层），表现为「工具已注册但不可达」。作用域在
  `dispose` 时一并释放；铸造失败回退 ownerCtx 并留痕告警，不影响 headless/fake host。
  Electron 桌面客户端真连实测通过。

### Added

- `README.en.md`：英文 README，与中文版同结构。
- 仓库发布脚本（一条命令完成构建 → 测试 → 版本校验 → GitHub 推送 + tag + Release → npm 发布）。

### Changed

- npm 包名从 `@54dsb1/dsh-stream-agent` 改为 `@hugesb/dsh-stream-agent`（`54dsb1` 是 GitHub
  账号，npm 侧对应账号为 `hugesb`，scope 必须与 npm 账号一致）。README、`preset.yml` 注释与
  架构图中的包名同步更新；GitHub 链接保持 `54dsb1` 不变。

## [0.1.0] - 2026-11-15

首个可安装版本。上游锚点 `@deepseek-ai/dsh@0.2.2-rc.1`（类型）/ rc.3（运行时实测）。

### Added

- **内核层**（`src/kernel/`，零框架依赖，可单独摘出单测）
  - `state.ts` 内容寻址状态树与句柄
  - `obs.ts` `info_gain` 分类与观测账本
  - `parser.ts` `tf-*` 单流协议解析器（协议语法的唯一权威）
  - `gate.ts` 可逆性判定（read/spec/commit/fatal）与一次性凭据
  - `render.ts` 三段式装配与 prefix 单调校验器
- **适配层**（`src/entry/`，薄壳只做翻译）：`loop.ts` AgentFactory + 单流驱动器、`obs-broker.ts`
  泄漏扫描与结果登记、`action-gate.ts` ToolsService guard、`state-handle.ts` `ctx.state` 服务、
  `context-render.ts` O6 第二见证与 O4 动态冻结、`mock-provider.ts` 离线假模型、`eval-probe.ts`
  评测取证。
- **`tf-*` 命令集**：`tf-write` / `tf-read`（支持 `offset`/`limit`）/ `tf-bash` / `tf-peek` / `tf-final`。
- **O1–O6 token 优化**：观测三档返回与行骨架、`tf-peek` 按需取回、句柄目录差分注入、
  动态上下文冻结、预算分级降级、preflight 前缀断言（fail-closed）。
- **上游语义对齐**：隐式写序、重复 id 幂等、乐观 peek 延迟重试、`tf-final` 同 id 覆盖、
  过早 final 检测、错误取因。
- **官方 bundle 形态**：`dsh.manifestVersion: 1` + `dsh.bundle.patch: ./cordis.patch.yml` +
  `engines.dsh`，卸载即回原生行为。
- **桌面端/web 组合适配**：agent 作用域铸造（key = agent 实例本身，镜像内建
  `createScope(loopCtx, this)`——宿主工具执行器与守卫按 `scopeChainOf(agent)` 选层，
  preset 层的 write/edit/pwsh 由此可达）、`modelSelection` 会话投影注册（客户端模型选择器的
  数据面）、resume 序号对账（seed 占位事件立即落盘，根除 "append seq mismatch"）、
  create 冲突回退 resume（桌面端草稿重试不再报 "already exists"）、`steer`/`inbox`/
  `runMaintenance` prompt 面补齐、默认模型三级回退与无路由 fail-fast。桌面客户端
  Electron 真连实测通过。
- 测试 187 用例（`node:test`，零 API 调用），`eval/` 指标口径与 10 任务集两臂 runner。

### Changed

- 仓库结构整理：开发/评测用的组合补丁统一收进 `patches/`，根目录只留 bundle 入口
  `cordis.patch.yml` 与生产装配清单 `preset.yml`。
- 文档拆分为 [`docs/architecture.md`](docs/architecture.md)、[`docs/protocol.md`](docs/protocol.md)、
  [`docs/limitations.md`](docs/limitations.md)，README 只保留结论与入口。
- `engines.node` 从 `>=24` 放宽到 `>=22.18`（构建与 187 用例在 Node 22.22 上实测通过）。
- 新增 CI、`.gitignore`、`.gitattributes`、`CONTRIBUTING.md`。

### Known limitations

见 [README「已知限制」](README.md#已知限制) 与 [`docs/limitations.md`](docs/limitations.md)，
其中需重点注意：写批任务 token 偏重、`replay` 对真连 session log 0 命中、
bundle 形态下 plugin record 通道可能降级内存。

[0.2.0]: https://github.com/54dsb1/dsh-stream-agent/releases/tag/v0.2.0
[0.1.1]: https://github.com/54dsb1/dsh-stream-agent/releases/tag/v0.1.1
[0.1.0]: https://github.com/54dsb1/dsh-stream-agent/releases/tag/v0.1.0
