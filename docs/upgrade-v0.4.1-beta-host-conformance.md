# 升级设计：宿主一致性面（Host-Conformance Surface）—— 0.4.1-beta 线

> 状态：已实施（随 0.4.1-beta.2 交付）｜基线：0.4.1-beta.1（59faab1）+ beta.2 收束补丁
> 关联事故：会话 `session-1da5f8fc`（历史加载失败 + UI 卡住）；取证与修复记录见 CHANGELOG 0.4.1-beta.2。

## 0. 一句话

把插件对宿主的 duck-type 契约从"事故驱动打补丁"升级为"契约驱动守护"：宿主侧对插件
的一切可观测约束（会话事件形状、agent 运行面、事件总线）变成 CI 里**持续验证的资产**，
并在本版把已知的三大类契约全部落进回归套件——以后宿主升级（rc.1 → rc.3+）时，
契约漂移在 `npm test` 里显形，而不是在用户的历史会话里显形。

## 1. 为什么升级（两案的共性）

0.3.0 以来三次真机事故，全部是**同一类错误的三个实例**：

| 事故 | 版本 | 缺口 | 宿主侧契约 |
| --- | --- | --- | --- |
| `tool/call has no advertised tool lifecycle` | ≤0.3.0 | 从未写工具广告消息 | v4 会话格式：`assistant/message(tool-call 块) → tool/call → tool/result` 三段齐全 |
| `message must have model source` | ≤0.4.1-beta.1 | source 只有 `{kind:'model'}` | `assertMessageEventShape` → `hasProviderModel`：assistant 消息 source 必须带非空 `provider`/`model` |
| UI 永远转圈 / `agent.inject is not a function` | ≤0.4.1-beta.1 | 从不发 `agent/status`；缺 `inject` | 内建 loop 的 `setPhase` 语义 + `dsh-user-approval setPolicy` 的 agent 面 |

共同点：插件用 duck-type 复刻宿主运行面（红线：零宿主依赖），但**复刻得对不对只有
真机会话坏了才知道**。宿主不会在插件写入时报错（写入面宽松），只在**读取**（历史加载）
或**消费**（UI 事件总线）时拒绝——错误延迟到用户侧爆炸。

结论：需要一层"宿主同款规则"的持续验证，把读取侧的校验规则搬到插件仓库的测试里，
并在有宿主环境时用**宿主自己的校验器**复核（可选通道）。

## 2. 契约清单（本版钉死的全部条目）

插件写出的每类会话事件 × 宿主校验规则（`dsh-session/lib/index.js` 本地镜像）：

| 事件类型 | 契约（读取侧校验） | 写入方 | 回归 |
| --- | --- | --- | --- |
| `assistant/message` | `message.id` 非空；`role==='assistant'`；`content` 数组；`source={kind:'model',provider:<非空>,model:<非空>}`（`hasProviderModel`）；`turn/step` 为非负整数且落在打开的 turn+step 内；`stream` 数组 | `createSessionEventWriter` 三条路径 + `makeAssistantMessage` | HC1/HC2/HC3/HC6 |
| `assistant/attempt` | `turn/step` 非负整数；`stream` 数组（settlement 形状） | 错误/空内容分支 | HC6 |
| `tool/call` | 同步骤 `assistant/message` 的 tool-call 块先行（name/arguments 逐字节一致）；step/end 前必须闭合 | 宿主工具管线 | HC6（广告三段在 session-format.test.ts 全绿） |
| `tool/result` | `role==='tool'`；`source={kind:'tool',callId}` 且 `toolCallId===source.callId`；未开始调用只接受 `TOOL_NOT_STARTED` 修复形状 | 宿主管线 + `repairToolCall` | HC6 + session-format S2 |
| `user/message` | `role==='user'`；`source.kind` 非空；`content` 数组 | followup / steer / **inject**（本版新增） | HC5/HC6 |
| `system/message` | `source.kind==='system-prompt'` | 宿主（插件不写） | HC6 类型表 |
| `developer/message` | `role==='developer'`；`source.kind` 非空 | 宿主（插件不写） | HC6 类型表 |
| `model/selection` | known-event 类型；ModelSelection 形状 | `agent.model.select` | HC6 类型表 |
| `plugin:tf-agent/*` | 必须匹配 plugin record 语法且**自动 `ignorable:true`**（宿主不认识的必需事件会拒整条日志） | ledger（`appendPluginRecord` / 本地台账） | HC6 ignorable 断言 |

agent 运行面 × 宿主消费面：

| 宿主消费点 | 契约 | 回归 |
| --- | --- | --- |
| `dsh-api-session-controller` `agent/status` 监听 | 状态转换必须发 `{agent, status}`，只在真正变化时发（内建 `setPhase` 语义） | HC4a/HC4b |
| `dsh-user-approval` `setPolicy` | `agent.inject(message)` 存在且不唤醒空闲 agent | HC5a/HC5b/HC5c |
| 桌面端 approval/policy 命令路径 | 注入的 `user/message` 形状合法（见上表） | HC5a + HC6 |

存量数据面 × 修复脚本（用户数据写入者，必须有自己的回归）：

| 面向 | 契约 | 回归 |
| --- | --- | --- |
| `scripts/repair-session-logs.mjs` | 三类 corrupt（缺广告 / final 写在 step/end 后 / 缺 model source）全部可修；修完必须过本地形状复核 + 生命周期复核；只动损坏会话，完好会话一个字节不动 | HC7（fixture 集成）+ HC8（宿主真校验器） |

## 3. 实施项

### H1 契约测试套件扩展（`test/host-conformance.test.ts`）

- **HC6 事件类型清单**（新增）：表驱动遍历插件可能写出的全部会话事件类型：
  ① 类型名必须在宿主 known-event 集 / plugin record 语法二选一里（类型名拼错 =
  读取侧 `unknown to this harness` 拒整条日志）；② `plugin:*` 记录必须 `ignorable:true`；
  ③ 五类 message 事件逐条过 `assertMessageEventShape` 本地镜像（HC1 的规则推广到
  全事件流，不只 assistant 消息）。
- **HC4/HC5（补丁已入）**：agent/status 转换序列精确性 + 发射异常熔断 + inject 三态。

### H2 修复脚本集成回归（fixture 驱动，新增）

修复脚本是**用户数据写入者**（改写 `~/.dsh` 下真实会话日志），此前零测试覆盖——本次
两案修复恰好把它扩了两个类目（补广告之上加 model source 补齐 + 形状复核）。用
合成 fixture（临时状态根 + 单帧 zstd 日志）驱动 CLI 全链路：

- HC7a dry-run：报告损坏会话与修复条数，**不落盘**（原文件字节不变）；
- HC7b `--write`：备份文件出现（`.bak-<时间戳>`）、修复后日志过本地形状复核、
  完好 fixture 不被触碰、投影缓存清理路径不误删 fixture。

### H3 宿主真校验器可选通道（新增）

`DSH_HOST_MODULES=<host>/node_modules/@deepseek-ai` 在位时，HC7 的 fixture 修复产物与
一份**真实事故日志形状样本**逐个过宿主 `dsh-session-persistence.validateStoredEvents`
（0.3.2 取证用的同一路径）；宿主模块不可达（CI 纯离线）→ skip 并如实标注。
价值：本地镜像与宿主实现漂移时，真机环境第一时间显形。

## 4. 硬边界（不做什么）

1. **不引入宿主包依赖**（红线）：宿主校验器只在 `DSH_HOST_MODULES` 显式在位时经
   dynamic import 使用，缺席即 skip；本地镜像才是 CI 的权威。
2. **不在运行时加形状闸**：写入面兜底（`'unknown'` 兜底 + fail-open 告警）已保证
   合规；在热路径加断言违背"驱动器自身异常不阻断任务"的红线 5。
3. **不自动改写用户日志**：修复脚本保持 `--write` 显式开启 + 自动备份的既有纪律。
4. **不覆盖并行条目**：beta.2 收束补丁（final 收束闸 / 重复回灌 / 孤立闭合标签）与
   协议组件化（beta.1）零改动——本升级只动 `test/` 与 `scripts/` 注释层。

## 5. 验收

- `npm test` 全绿（用例数从 347 增至 352，见 CHANGELOG）；
- `npm run check` 6/6；`npm run gate --offline` G1–G3 PASS（G4–G6 真机项如实待批次）；
- 真机复核（本机已执行）：13 条损坏会话日志修复后，宿主 `validateStoredEvents`
  33/33 PASS（修复前 13 FAIL）——见 CHANGELOG 0.3.2/0.4.1-beta.2 取证记录。

## 6. 后续路线（不在本版）

- **宿主版本矩阵**：契约随宿主 rc 版本可能加严（如 rc.3 的错误文案带 `(gateway/internal)`
  后缀）。路线：把契约清单升级为"宿主版本 × 规则"矩阵，`DSH_HOST_MODULES` 指向多版本
  宿主时逐版本复核。
- **事件总线契约**：`agent/assistant-stream` 帧契约（revision/index 递增）目前由驱动器
  自证，路线：把 `dsh-api-session-controller SessionAssistantStreamAccumulator.accept`
  的服务端 fold 规则也纳入本地镜像。
- **插件记录目录注册**：`plugin:tf-agent/*` 类型随命令表演进，路线：与 `npm run check`
  联动做"命令表 ↔ 记录类型"一致性断言。
