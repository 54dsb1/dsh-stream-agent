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
| `text_filter.py` | 211 | 命令准入闸 | kernel/gate.ts | ✔（两段式动作准入，0.4.0） |
| `output_store.py` | 174 | 原文落盘 + tail/preview | entry/state-handle.ts | ✔（0.4.0） |
| `delivery.py` | 163 | 交付校验 | kernel/final.ts + 验收闸 | ✔（0.3.1/0.4.0） |
| `task_plan.py` | 148 | acceptance / evidence | loop.ts #plan/#markAccepts（0.4.0） | ✔ |
| `file_observations.py` | 134 | 文件级观测合并 | kernel/obs.ts（key=路径，版本自增） | ✔（0.4.0；0.5.0 span 账本增强） |
| `conversation.py` | 126 | 消息单一事实源 | kernel/render.ts | ✔（实现不同：三段式装配） |
| `feedback.py` | 111 | 回灌格式 | kernel/obs.ts + loop 注入 | ✔（标记文本自有化，PROTOCOL-v1 §5） |
| `message_projection.py` | 86 | 消息投影 | kernel/render.ts | ✔（0.4.0；0.5.0 surface replace 通道） |
| `recall.py` | 83 | `request:N` + offset/query | obs.ts resolveHandleRef / peekWithLedger | **✔（0.5.0 补齐）** |
| `prompts.py` | 57 | 协议与系统提示文本 | kernel/protocol.ts | ✔（自有化，PROTOCOL-v1） |
| `context_budget.py` | 22 | 上下文预算 | **kernel/governor.ts（新，0.5.0）** | ✔ |

**合计 15/15 到位**（P6 判据满足）。新增内核模块 2 个（compaction.ts / governor.ts），预算治理另在 loop.ts 集成。

## 3. 选搬（13 模块 / 2,986 行 / 19.5%）—— 按需，部分只搬语义

| 模块 | 行数 | 处置 | 0.5.0 状态 |
|---|---|---|---|
| `executor.py` | 811 | 只搬语义（声明序 = 执行序 = 注入序），不搬单 worker 实现 | ✔（语义在） |
| `session.py` | 415 | 补 fsync/原子性，其余已有 intent-log.ts | ✔（0.4.0 F6） |
| `changes.py` | 272 | 可选，effect record 的 diffstat | 部分（效果行含 diffstat 字段；diffstat 计算待真机接线） |
| `configuration.py` | 269 | 只搬字段语义 | ✔（LoopEntryConfig 附录 A 总表） |
| `runtime.py` / `streaming.py` / `model_registry.py` / `workspace.py` / `events.py` / `session_delta.py` / `runtime_context.py` | — | 宿主已有 | ✔（duck-type 接缝） |
| `workspace_search.py` | 103 | 由 `tf-grep` 替代 | ✔ |
| `workspace_git.py` | 103 | 可选 | 未搬（宿主 git 工具可用） |

## 4. 参考不移植（1 模块 / 2,527 行 / 16.5%）

| 模块 | 行数 | 提取的三处语义 |
|---|---|---|
| `agent_loop.py` | 2,527 | ① `need_result` 的 break 语义（→ tf-peek need_result 通道）；② `check_completion` 的收敛判据（→ 验收闸四类拒绝）；③ auto-continue 的上限纪律（→ closeOutRequests / maxSteps 收束期） |

## 5. 不移植（18 模块 / 6,610 行 / 43.2%）—— 宿主职责

`cli.py`(1,744) / `desktop_service.py`(1,169) / `renderer.py`(689) / `interfaces.py`(426) / `usage_tracker.py`(385) / `provider.py`(296) / `skills.py`(289) / `interactive_controller.py`(272) / `baseline_agent.py`(270) / `security.py`(225) / `tui.py`(198) / `desktop_terminal.py`(180) / `process_owner.py`(174) / `provider_diagnostics.py`(92) / `config_cli.py`(78) / `output_capture.py`(53) / `desktop_catalog.py`(50) / `__init__.py`(20)。

理由：CLI/TUI/桌面端/渲染/Provider/权限/技能装载/计费/进程管理均为宿主（@deepseek-ai/dsh）已有职责；移植 = 争夺职责（§1.2 非目标）。

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
