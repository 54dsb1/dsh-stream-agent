# docs/channel-matrix.md —— 三通道来源 × 能力矩阵

> 实现面 = `src/entry/loop.ts`（通道闸门）与 `src/entry/tool-surface.ts`（reserved-only）。本矩阵与实现同步验收（判据："通道矩阵与实现一致"）。

## 1. 通道与来源

执行通道（区块 A）是控制面的轴一：`standard` / `code`。`code` 的用户可见名为**「PTC兼容模式」**；其**来源**是探测结果，不是选项：

| 来源 | 判定（R12：只按执行器实现，不按 preset id） | 能力 |
|---|---|---|
| `preset` | 当前作用域执行器为 PTC 实现（内省面 duck-type，或工具清单含 `run_code`） | 完全让位（§2 完整列） |
| `bridge` | `ctx.ptcRuntime` 服务在位且形状符合（resolve + run） | 受限窄桥（仅 tf-code） |
| `none` | 两者皆无 | **不可用**：拒绝进入，回退标准通道（不静默降级） |

判定入口：`detectCodeChannelSource()`（loop.ts）；显式 `codeChannelSource: 'preset' | 'bridge'` 绕过探测。

## 2. 能力矩阵

| 能力 | 标准 | PTC兼容模式（preset） | PTC兼容模式（bridge） |
|---|---|---|---|
| 模型可见工具 | `tf-*` + 宿主工具透传（reserved-only） | preset 决定，本插件注册数 0 | 仅 `tf-code` |
| 协议段字符数 | 完整（PROTOCOL-v1） | **0** | 约 200（只写 tf-code 用法） |
| 命令解析 | 是（`<tf-*>` 全表） | 否（`tf-*` 标记账丢弃，reason=code-channel-yield） | 有限（仅 `tf-code` 块） |
| 验收闸（拒绝收敛） | 是 | 否，降级为状态提示（S5） | 否 |
| 回合收束 | `tf-final`（四类拒绝 + 计划验收） | 流正常终止且无重入事由 → completed | 同左 |
| 回合内注入 | 是（观测/计划/状态摘要回灌） | 否（仅 S5 快照） | 否（仅 S5 快照） |
| 状态摘要 | 是（`[tf-stream:state]` 回灌） | 是（S5） | 是（S5） |
| 效果压缩单元 | 按程序/调用（单次工具调用） | 按程序（`run_code` 一次 = 一条） | 按调用 |
| 原文取回 | `tf-peek` + span 账本 | 程序内读取，无 peek | 程序内读取，无 peek |
| 压缩路径 | dropAppendHead + 确定性摘要（P3） | 同左（整块丢弃，不逐条改写；未采用 `surfaceOp: replace`） | 同左 |
| 执行器来源 | `dsh-base` native | `dsh-tool-executor-ptc`（宿主装载） | `ctx.ptcRuntime` 窄桥 |
| 依赖 | 无 | 会话 preset 含 PTC | `ptcRuntime` 服务存在 |
| 不可用时的行为 | — | 降级到 bridge（自动判定；差异如实显示） | 拒绝进入，回退标准（不静默） |

## 3. 让位清单（preset 来源下停掉什么）

| 项 | 标准通道 | PTC兼容模式（preset） | 可验证形式 |
|---|---|---|---|
| `tf-*` 工具注册 | 是 | 否 | 对 `ctx.tools` 注册数 = 0 |
| 协议段 | 完整 | 空串 | system prompt 中无 `## tf-*` 引导 |
| 输出解析 | 是 | 否 | `tf-*` 标记账丢弃（code-channel-yield），不派发 |
| 验收闸 | 是 | 否 | 无 tf-final 拦截；无 nudge 逼问 |
| 回灌 | 是 | 否 | 无 `tf-*` 调用即无回灌 |
| 执行器 | 不碰 | 不碰 | 全包无 `setExecutor` 调用（grep 可验） |
| 压缩 | 是 | 是 | 两个通道同一条路径（`dropAppendHead` + 确定性摘要 + 句柄化），由 `surfaceCompaction` 总开关控制 |
| 状态摘要 | 是 | 是 | S5 快照（systemPrompt.context，替换旧快照） |

"不写入对方表面"是可验证的（G3）：PTC兼容模式下，本插件对 `ctx.tools` 的注册数为 0，对 session 日志的写入为 0（只有投影读取）；system prompt 侧**不是 0 字符**——协议段为空串，但稳定前缀里仍有本插件写入的 3 段常量共 263 字符（通道措辞 117 + 工具面说明 33 + 不变量 109 + 2 处分隔符），且跨请求固定、不随回合增长。这 3 段是通道语义的必要说明（否则模型不知道工具面由 preset 决定、压缩由谁做），不计入"让位"范围。

## 4. 与 PTC 的共存判据（8 项，§5.10）

PTC兼容模式下"完整兼容"的定义是**不写入对方拥有的任何表面**：

| PTC 能力 | 保持方式 | 验证 |
|---|---|---|
| 原生工具集 | 本插件不注册、不裁剪（reserved-only 透传） | 工具清单与无本插件时逐个相等 |
| `run_code` 唯一入口 | 协议段 0 字符 | 模型可见工具中无 `tf-*` |
| 三档 `executionMode` | 不触碰 | 逐档执行同一程序，结果一致 |
| `stateOwner` / `scriptPersistence` | 不触碰 | `vm-script` 档变量跨调用存活 |
| `sandboxPolicy` | 不触碰 | 越权调用被拒 |
| 宿主默认 `maxPendingCalls` 128 / 64MiB / 600s；插件侧不预设（`codeMax*` 可收紧） | 不触碰 | 触顶报错文案一致 |
| 子调用并发 10 | 不触碰 | 并发探针 |
| `errorClass` 分类 | 不触碰（八类 kind 原样保留） | 6 类错误映射 |

禁止项：修改 PTC 的配额、并发、沙箱策略、工具清单。

## 5. 让位判据（切换与回退）

1. **切换生效时机**：通道切换在**下一个用户任务边界**生效（§3.3 约束 5）；任务进行中提交的切换请求排队，不中断当前任务。
2. **切换 = 计划性换基**：工具面与协议段同时变化，必然破前缀——重置基线一次 + `[tf-stream:context-rebased]` 注入 + `cache-reset` 记账（cause=channel-switch）。
3. **回退**：`none` 来源 → 拒绝进入，回退标准通道；控制栏显示"PTC兼容模式不可用：未检测到 PTC 预设或 ptcRuntime"（不静默降级）。
4. **限流**：超过 `maxRebasesPerSession`（默认 8）时通道切换要求确认（R1）。
5. **档位切换不换基**：区块 B 只改数值（maxSteps / maxInputTokens / 压缩强度 / 取回预算 / keepRecent / 摘要上限），不触碰工具面、并行度、执行器、协议段。

## 6. 兼容矩阵（宿主组合 × 期望，§6.5）

| 宿主组合 | 期望 | 验收点 |
|---|---|---|
| 纯宿主（standard preset） | 接管生效，标准通道可用 | 基线 |
| 宿主 + PTC 预设 | 接管生效；PTC兼容模式来源 = preset；工具清单不变 | 8 项能力逐项验证 |
| 宿主 + PTC 预设 + 第三方工具插件 | 第三方工具不被隐藏，程序内可调用 | 工具可达性探针（reserved-only） |
| 宿主 + 另一 loop 插件 | 降级为 sidecar 并报冲突（takeoverOnConflict=degrade） | 无静默覆盖（takeover-registry owner） |
| 宿主 + `ptcRuntime`（无 preset） | PTC兼容模式来源 = bridge | 受限能力如实显示 |
