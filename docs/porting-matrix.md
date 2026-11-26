# docs/porting-matrix.md —— 上游移植矩阵（0.5.0 P6）

> 事实基准：thinkflow 0.10.3（47 模块 / 15,299 行，MIT）；PTC 三包 5,955 行 TS（MIT）。判据（计划书 §9.4）："能力完整" = **必搬 15 模块全部到位**，而非行数占比。移植不搬项等于与宿主争夺职责。

## 1. 移植方式三分

| 方式 | 适用 | 动作 | 风险对策 |
|---|---|---|---|
| 直接依赖 | PTC 三包（TS，5,955 行） | npm dependency / 宿主装载；0 行复制 | 版本漂移 → 锁宿主版本（dsh >=0.2.2-rc.3） |
| 语义重写 | thinkflow（Python，15,299 行） | 按行为契约重写为 TS，并移植测试向量 | 非源码复制；以原测试为判据（R8：只搬语义，不搬 FIFO 等语言假设） |
| 不移植 | thinkflow 的 UI/CLI/Provider 层 | — | 宿主职责冲突 |

## 2. 必搬（15 模块 / 3,176 行 / 20.8%）—— 0.5.0 到位状态

| 模块 | 行数 | 能力 | 落点 | 0.5.0 状态 |
|---|---|---|---|---|
| `parser.py` | 558 | `<tf-*>` 解析、fence 感知 | kernel/parser.ts | ✔（0.4.0 起持续；DSML 宽松形态见 upstream-delta D-10） |
| `context.py` | 574 | 观测记录、read_spans、注入字符串 | kernel/obs.ts + render.ts | ✔（0.5.0 补 span 账本 = D5 修复） |
| `tool_registry.py` | 399 | `TOOL_FLOW_*` 分类 | kernel/obs.ts classifyTool | ✔（族分类 + tf-call 扩族） |
| `compaction.py` | 330 | 确定性摘要、keepRecent | **kernel/compaction.ts（新，0.5.0）** | ✔ |
| `text_filter.py` | 211 | 流式文本过滤（命令/散文分离） | kernel/parser.ts 围栏状态机（§7） | ✔（**0.6.0 更正映射**：能力在 parser 的围栏排除执行 + 显示面只发 reasoning-delta；kernel/gate.ts 是 spec/commit 动作准入闸，不是文本过滤——旧映射证据错误） |
| `output_store.py` | 174 | 原文落盘 + tail/preview | entry/state-handle.ts | ✔（0.4.0） |
| `delivery.py` | 163 | 交付校验 | kernel/final.ts + 验收闸 + kernel/delivery.ts | ✔（0.3.1/0.4.0；**0.5.2 补齐**：文件事实默认装配、构建校验经 toolMapping 走宿主 shell、脚本清单注入上下文） |
| `task_plan.py` | 148 | acceptance / evidence | loop.ts #plan/#markAccepts（0.4.0） | ✔ |
| `file_observations.py` | 134 | 文件级观测合并 | kernel/obs.ts（key=路径，版本自增） | ✔（0.4.0；0.5.0 span 账本增强） |
| `conversation.py` | 126 | 消息单一事实源 + request:N 登记 | kernel/render.ts + obs.registerRequestText | ✔（实现不同：三段式装配；**0.6.0 补齐** request:N 别名：任务起点原文 + 压缩段 + 段边界丢弃段三处均登记，原仅压缩路径） |
| `feedback.py` | 111 | 回灌格式 | kernel/obs.ts + loop 注入 | ✔（标记文本自有化，PROTOCOL-v1 §5） |
| `message_projection.py` | 86 | 消息投影 | kernel/render.ts | ✔（0.4.0；0.5.0 整块压缩走 dropAppendHead，未采用 `surfaceOp: replace`——宿主行为未验证，见 channel-matrix「压缩路径」） |
| `recall.py` | 83 | `request:N` + offset/query | obs.ts resolveHandleRef / peekWithLedger | **✔（0.5.0 补齐）** |
| `prompts.py` | 57 | 协议与系统提示文本 | kernel/protocol.ts | ✔（自有化，PROTOCOL-v1） |
| `context_budget.py` | 22 | 上下文预算 | **kernel/governor.ts（新，0.5.0）** | ✔ |

**合计 15/15 到位**（P6 判据满足）。新增内核模块 2 个（compaction.ts / governor.ts），预算治理另在 loop.ts 集成。

## 3. 选搬（13 模块 / 2,986 行 / 19.5%）—— 按需，部分只搬语义

| 模块 | 行数 | 处置 | 0.5.0 状态 |
|---|---|---|---|
| `executor.py` | 811 | 只搬语义（声明序 = 执行序 = 注入序），不搬单 worker 实现 | ✔（语义在） |
| `session.py` | 415 | 补 fsync/原子性，其余已有 intent-log.ts | ✔（0.4.0 F6） |
| `changes.py` | 272 | 读版本守卫 + 快照回执 + 守卫式回滚 + diff | ✔ 守卫（**0.5.2 默认装配** `revisionFacts`，新建文件放行）；**0.6.0 补齐**：kernel/change-store.ts（begin/complete/revert 语义，对齐 changes.py:157-272）+ tf-changes/tf-diff/tf-revert（v15 段，ADR-002）；回执持久化在 stateDir/changes/<session>/（模型输入之外）；diff 为快照 unified diff（有界 LCS），diffstat 可由 tf-diff 补丁复算 |
| `configuration.py` | 269 | 只搬字段语义 | ✔（LoopEntryConfig 附录 A 总表） |
| `runtime.py` / `streaming.py` / `model_registry.py` / `events.py` / `session_delta.py` | — | 宿主已有 | ✔（duck-type 接缝） |
| `runtime_context.py` | — | 宿主已有运行时上下文通道 | **部分**：本插件只经 `systemPrompt.context` 推状态摘要快照，**不读 `AGENTS.md`**（上游会把仓库约定注入 system）；需要时请自行写进 `systemPrompt`/`protocolAppend` |
| `workspace.py` | — | 宿主已有工作区解析 | **部分**：cwd 解析已接（session header → workingDirectory 服务）；**会话附件（图片/文件引用）未搬**——由宿主工具面处理，插件不解包 |
| `workspace_search.py` | 103 | 由 `tf-grep` 替代 | ✔ |
| `workspace_git.py` | 103 | 可选 | 未搬（宿主 git 工具可用） |

## 4. 参考不移植（1 模块 / 2,527 行 / 16.5%）

| 模块 | 行数 | 提取的三处语义 |
|---|---|---|
| `agent_loop.py` | 2,527 | ① `need_result` 的 break 语义（→ tf-peek need_result 通道）；② `check_completion` 的收敛判据（→ 验收闸四类拒绝）；③ auto-continue 的上限纪律（→ closeOutRequests / maxSteps 收束期） |

## 5. 不移植（18 模块 / 6,610 行 / 43.2%）—— 宿主职责

`cli.py`(1,744) / （`output_capture.py` 的语义已由 0.5.2 的 tf-code `logs` 注入承担：程序 stdout/stderr 与返回值并列回给模型）/ `desktop_service.py`(1,169) / `renderer.py`(689) / `interfaces.py`(426) / `usage_tracker.py`(385) / `provider.py`(296) / `skills.py`(289) / `interactive_controller.py`(272) / `baseline_agent.py`(270) / `security.py`(225) / `tui.py`(198) / `desktop_terminal.py`(180) / `process_owner.py`(174) / `provider_diagnostics.py`(92) / `config_cli.py`(78) / `output_capture.py`(53) / `desktop_catalog.py`(50) / `__init__.py`(20)。

理由：CLI/TUI/桌面端/渲染/Provider/权限/技能装载/计费/进程管理均为宿主（@deepseek-ai/dsh）已有职责；移植 = 争夺职责（§1.2 非目标）。

**0.6.0 更正（覆盖核验）**：`security.py` 与 `output_capture.py` 的**默认密钥保护子功能**不在宿主职责内——
宿主沙箱只做路径根约束（dsh-fs-sandbox），dsh-client-ui-secret-mask 自述 "Pure UI"（显示掩码，不进模型路径）。
该子功能已落插件：`kernel/security.ts`（DEFAULT_SECRET_PATTERNS 拒读 + SENSITIVE_ASSIGNMENT_RE 脱敏，
对齐 security.py:15-35/193-225），entry 接线在 tf-read 派发前与 obs.observe 登记前（落盘/回灌/取回继承脱敏）。
沙箱根约束 / 危险命令审批 / 进程持有仍属宿主。`interfaces.py` 的可选 image_generation 适配器（默认 disabled）
无宿主对应：需要时经 tf-bash 外部命令替代，记为"按设计不实现"（与 tf-python 同理，§9）。

## 6. 核对表

| 分类 | 模块数 | 行数 | 占比 | 处置 |
|---|---|---|---|---|
| 必搬 | 15 | 3,176 | 20.8% | 重写为 TS + 移植测试向量（0.5.0 全部到位） |
| 选搬 | 13 | 2,986 | 19.5% | 按需，部分只搬语义 |
| 参考 | 1 | 2,527 | 16.5% | 只读，提取 3 处语义 |
| 不移植 | 18 | 6,610 | 43.2% | 宿主职责 |
| 合计 | **47** | **15,299** | **100%** | — |

## 7. PTC 三包（直接依赖，0 行复制）

| 包 | 行数 | 提供 | 处理 |
|---|---|---|---|
| `dsh-ptc-runtime` | 343 | 抽象契约、保留字集合、沙箱策略类型 | 直接依赖（bridge 通道） |
| `dsh-ptc-runtime-node` | 3,274 | 三种 evaluator、bindings、environment、scriptPersistence | 直接依赖（bridge 通道） |
| `dsh-tool-executor-ptc` | 2,338 | `run_code` 注册、`setExecutor`、client、错误分类 | 不依赖；preset 通道由宿主装载 |
| 合计 | **5,955** | — | **0 行复制** |

preset 通道下本插件不 import 这三包：`run_code` 由宿主 preset 装载，本插件只读其结果（§5.3 让位）。

## 8. b 通道对 `run_code` 参考实现的三处**有意不消费**（0.5.3 复核）

对照 `dsh-tool-executor-ptc/src/ptc.ts` 逐项核对后，桥通道在下列三点与参考实现刻意分叉。
它们都不是"没搬"，而是**在插件侧没有语义落点**，硬搬会制造假对齐：

| 参考实现字段 | 参考实现怎么用 | 桥通道为什么不消费 | 替代 |
|---|---|---|---|
| `concludesTurn` | `run_code` 的程序可以声明"本次调用结束整个回合"，工具层据此收束 | 桥通道的收束契约是 `tf-final` + 验收闸（§1/§2.7）；程序声明结束会绕过验收闸与兜底交付 | 程序结束 ≠ 回合结束：模型在流末发 `tf-final`；代码通道无验收闸时"流正常终止即收束"（§3.2） |
| `deferContext` | 把大结果"延后进上下文"，由工具层决定注入位置与时机 | 插件已有统一的观测/回灌管线（obs 三档 + `codeValueInjectLimit`），再由工具层二次注入会出现**同一份内容两条入口**，破坏前缀单调与字节可复算 | `tf-code` 结果按 `codeValueInjectLimit` 截断后进易变尾；需要复读用 `tf-peek` |
| `toolSet`（工具集 id） | 供 SDK 生成器选出绑定集合 | 桥通道的绑定集由 `PRESET_BINDINGS`/装配决定并冻结（旧程序体只增不减，§8.4），运行期传入第二个工具集来源会让"程序里能用什么"不可复算 | 绑定集在装配期确定，`runtimeStatus().ptc.bindings` 可查 |

其余契约（`programFormat` getter、`errorClass` 在 bindings、`release(owner)` 为 async、
`sandbox.denied` 为 boolean、子调用 id `<parentCallId>:ptc:<n>`、dispatch 事件 drain、
`maxSubCalls` 由 `timeoutMs` 推算、`maxParallelSubCalls` 由宿主调度决定）**全部按参考实现对
齐**，见 `src/entry/ptc-bridge.ts` 与 `PROTOCOL-v1.md §2.8`。

## 9. `tf-python`（thinkflow `tools/python.py`）为什么没有对应命令

thinkflow 的工具表里有 `python`（`CORE_NATIVE_TOOLS` 之一），语义是"把一段 Python 交给解释器执行、
取回 stdout/异常"。本插件**不提供 `tf-python`**，理由是落点不存在而不是漏搬：

| 维度 | 事实 |
|---|---|
| 宿主能力 | DSH 的工具面里没有 Python 执行器；`tf-bash` 走的是宿主 bash 工具（`dsh-tool-bash`），不是 Python 运行时 |
| 插件侧自建代价 | 要自己 `spawn python3` + 管 stdin/stdout/超时/临时目录 → 在插件里新开一条**未受宿主沙箱约束**的执行通道，与"沙箱策略只由宿主决定"（§2.8）直接冲突 |
| 已有替代 | ① 代码通道 `tf-code` 已在宿主 PTC runtime 内执行 TypeScript（沙箱/超时/保留态都由宿主负责）；② 需要跑 Python 就用 `tf-bash`（`python3 -c ...` 或脚本），权限与超时由宿主 bash 工具裁决 |
| 结论 | 归入"不移植"（宿主职责）。若将来宿主提供 Python 执行器，正确做法是让 `tf-code` 走它（`runtime.language`），而不是新增一条平行命令 |

同理可推：thinkflow 的 `conversation` / `output_capture` / `session_delta` 没有同名命令，它们由
"回合台账（`plugin:tf-agent/step`）+ 观测三档 + `finalAnswer` 事件"承担；`__init__` 门面由
entry 装配（`src/entry/loop.ts` apply）承担。

**0.6.0 更正**：旧版此处声称"唯一仍然缺语义的是 `changes.diffstat`"——与上游源码事实不符：
① diff/diffstat 宿主 `dsh-workspace-changes` 已提供（numstat + structuredPatch）；② 真正缺的是
**快照回执与守卫式回滚**（changes.py:157-272 begin/complete/revert），旧声明遗漏了它。
0.6.0 已补齐：`kernel/change-store.ts` + `tf-changes`/`tf-diff`/`tf-revert`（v15 可选段，ADR-002），
快照以 base64 存私有回执目录（内核仍零 IO：字节读取/原子写回由 entry 承担，与 revisionFacts 同一注入纪律）。
`task_plan.py` 的步骤状态机 context 字段（summary/decisions/files）未搬：插件验收纪律以证据绑定为核心
（accepts + 谓词 + in_progress），宿主 tool-todo 提供状态面；context 字段属上游 TUI 展示需求，记为有意分叉。
