# docs/upstream-delta.md —— 与 thinkflow 的逐条差异及原因（0.5.0 P6）

> 协议自主（计划书 §9.6）：0.5.0 起 `PROTOCOL-v1.md` 为自有规范，thinkflow 0.10.3（PROTOCOL 1.14）降为参考实现。本文件列出与上游不一致处及原因；变更判据从"上游是否变更"改为"成本模型是否需要"。定期评审：只吸收与成本模型相关的变更（R6）。

## 1. 分叉总览

| 项 | thinkflow 0.10.3 | 本插件 0.5.0 | 原因 |
|---|---|---|---|
| 语言/宿主 | Python / 自有 CLI+TUI | TypeScript / DSH 插件（Cordis） | 宿主职责分层（§9.4：43.2% 上游代码是宿主已有职责，不搬） |
| loop | `agent_loop.py`（asyncio，2,527 行） | `SingleStreamDriver`（TS/AsyncIterable） | 架构不同；只提取三处语义（need_result break / 收敛判据 / auto-continue 上限纪律） |
| 回合制 | 逐轮工具调用 | 单流：命令闭合即执行 | 单流协议省 token 的主因是消灭回合数 |
| 状态 | 程序变量持有（删文本 = 删状态） | 句柄/版本号寻址（删文本 ≠ 删状态） | K5：状态有地址 ⇒ 历史可压缩 |
| 协议规范 | PROTOCOL.md 1.14 跟随 | PROTOCOL-v1 自有，上游列参考 | 变更判据改为成本模型 |

## 2. 保留的上游语义（行为契约级一致）

| 语义 | 上游出处（模块） | 本插件落点 | 一致性判据 |
|---|---|---|---|
| `<tf-*>` 命令语法与 id/depends_on | parser.py | kernel/parser.ts | 测试向量重述（schema/属性校验/环检测） |
| 观测三档（full/dedup/handle；0.5.1 前称 high/low/none） | context.py | kernel/obs.ts | 分类规则表逐条 |
| 声明序 = 执行序 = 注入序 | executor.py（只搬语义，不搬单 worker 实现） | kernel/parser.ts readyCommands + loop #dispatchReady | 顺序单调性测试 |
| 确定性摘要纪律（`_build_summary`） | compaction.py | kernel/compaction.ts | max_item_chars / 保留头尾 / 不做语义归纳 |
| 消息单一事实源 | conversation.py | kernel/render.ts（实现不同：三段式装配） | 前缀单调断言 |
| 回灌格式 | feedback.py | kernel/obs.ts + loop 注入 | 标记文本自有（PROTOCOL-v1 §5） |
| `request:N` + offset/query 取回 | recall.py | obs.ts resolveHandleRef / peekWithLedger | 语义一致，实现并入 span 账本 |
| 交付校验 | delivery.py | kernel/final.ts + 验收闸 | 四类拒绝（依赖/未完成/验收/占位） |
| 协议与系统提示文本 | prompts.py | kernel/protocol.ts | 分叉（见 §3） |

## 3. 有意分叉（含原因）

| # | 差异 | 上游 | 0.5.0 | 原因（成本模型） |
|---|---|---|---|---|
| D-1 | 取回纪律成段 | 无专门协议段 | 新增 peek 段：先 grep 后 peek ±40 行、禁止逐段取回、禁止重复区间 | 分页取回额外成本 ≈ (k−1)×C（§7.1）；目标 k→1 |
| D-2 | span 账本 | read_spans 只记录 | 已投递区间账本：命中未变 → `[unchanged]` 一行；部分重叠只发新增 | D5：重复取回同一区间重复付费 |
| D-3 | 取回预算 | 无 | `peekBudgetChars`（回合级）+ `[budget]` 注入 | 取回是请求级成本，需要回合预算护栏 |
| D-4 | read 截断策略 | 全文或按上限截断 | 行锚索引（每 200 行 + 顶层符号）+ 未投递区间显式列出 | D4：头部截断策略本身制造取回 |
| D-5 | 双旋钮预算 | `max_input_tokens`（单请求）+ `max_run_turns` | 同构：`maxInputTokens`（C 上限）+ `maxSteps`（N 上限）；`budgetTokens` 降为观测 | D1/D7：累计预算含 cacheRead 且按会话累计——缓存命中越好越早降级 |
| D-6 | 前缀策略 | 无（上游无前缀缓存纪律） | 三类处置判定表 + 计划性换基（planned-rebase）+ `[tf-stream:context-rebased]` | K8：宿主 surfaceOp:replace 提供合法换基通道；"报错/重发"二分不通用 |
| D-7 | 效果压缩 | 无 | `[applied pN]` 折叠行（回灌/压缩两个改写点） | §5.6：效果落账后程序体与原始输出可折叠 |
| D-8 | 通道语义 | 无（上游单通道） | standard / code 两通道 + 三来源让位 | PTC 共存（K6/K1）；让位可验证（注册数 0） |
| D-9 | 验收闸 | `check_completion` 收敛判据 | tf-plan/accepts + tf-final 四类拒绝 | 0.4.x 已交付，保留并纳入规范 |
| D-10 | DSML 宽松解析 | 无 | DSML 噪声改写/丢弃（迁移窗口） | 真机取证（0.3.1/0.3.2）；0.6.0 收敛为纯记账丢弃 |
| D-11 | 协议文本语言 | 英文 | 中文（控制栏/协议段） | 宿主与用户群语言；语义以 PROTOCOL-v1 为准 |

## 4. 不移植项（与 docs/porting-matrix.md 第四类一致）

UI/CLI/TUI/Provider/安全/技能装载/进程管理等 18 模块（6,610 行，43.2%）为宿主职责，不搬。逐条理由见 porting-matrix。

## 5. 评审纪律

- 上游发版（>0.10.3）→ diff `PROTOCOL.md` 与必搬模块；只吸收与成本模型相关的变更（R6 对策）。
- 本文件的每一行分叉在 PROTOCOL-v1.md §8 有对应版本记录；规范变更必须同时更新两处。
- U7（thinkflow `main` 与 v0.10.3 差异）为真机侧待办：拉 tag 比对后回填本文件 §6（预留）。
