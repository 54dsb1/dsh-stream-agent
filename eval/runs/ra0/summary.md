# RA-0 宿主装配接缝探针（0.6.0）

- 探针项：6；结论：supported 4 / unsupported 1 / unknown 1
- 作用域：`plugin-seam`（DriverPorts.stream 入参契约 + 适配器行为）。**宿主侧（DSH llm/stream）真实校验一律标 hostVerification=pending**，离线不冒充已在宿主验证。

| 探针 | 结论 | 依据 | 证据 |
| --- | --- | --- | --- |
| U1 | supported | 真实驱动器 3 个请求：最后请求的 messages 与插件投影逐条逐字节一致（10 条），2/3 个请求含插件专有块（[tf-stream:…]）——"这次带什么"由插件决定，宿主未重建；前两个请求只做快照（驱动器的投影每请求重建，探针无法在请求间隙取快照）；宿主是否允许它与自身 session 投影不同仍需真机确认 | `entry/loop.ts:485`<br>`entry/loop.ts:3746` |
| U2 | supported | 真实驱动器：首请求 tools 字段缺省（0 schema）、后续 7/7 项（≤7）；端口未补回工具面。宿主是否强制补回需真机确认 | `entry/loop.ts:3751`<br>`kernel/assembly.ts:144` |
| U3 | unknown | 本插件不走 reasoning 通道（文本协议，请求里从无 reasoning 块）；provider 是否要求回传只能由真机 provider 判定，离线不得推断。策略固定 provider-required。 | `entry/loop.ts:3777`<br>`kernel/assembly.ts:60` |
| U4 | supported | 真实驱动器 3 个请求：system 字节恒定（3502）而消息总数增长（2→6→10）、总字节增长（3512→3796→4080）——插件每次送完整 system，是替换语义；宿主是否再追加一份仍需真机确认 | `kernel/render.ts:445`<br>`entry/loop.ts:3746` |
| U5 | unsupported | 适配层契约里没有 surfaceOp 字段（0.5.0 已决议不使用该通道）：插件无法表达"替换历史"，历史改写不可行，RA-2 只能"不产生"而不是"事后删"。 | `entry/loop.ts:148`<br>`kernel/render.ts:583` |
| U6 | supported | 真实驱动器 3 个请求的 request 记录都带 cacheRead/cacheWrite，且 providerInputTokens = 未命中 + 缓存读 + 缓存写（640/643/646）——可外部复算 | `entry/loop.ts:3107`<br>`entry/loop.ts:3106` |

## 对装配路线的影响

- 判定：**system-tools-only** —— 只做 system / tools 投影；messages 保持 append-only（U5 不支持历史改写）
- 门禁（计划 §5 M0）：6 项全部有结论 ✅；`unknown=1`（要求 ≤1）✅。
- U3 为 unknown：缺真机宿主/provider，已写入 docs/limitations.md，不作为通过项。

## 逐项证据

### U1（supported）

- 问题：llm/stream 的 messages 是否可与 session 投影不同（裁剪 / 替换 / 重排）
- 观测点：3 个连续请求的 messages 快照；最后一个请求与插件投影逐条 diff
- 理由：真实驱动器 3 个请求：最后请求的 messages 与插件投影逐条逐字节一致（10 条），2/3 个请求含插件专有块（[tf-stream:…]）——"这次带什么"由插件决定，宿主未重建；前两个请求只做快照（驱动器的投影每请求重建，探针无法在请求间隙取快照）；宿主是否允许它与自身 session 投影不同仍需真机确认
- 观测：消息条数 2 → 6 → 10
- 观测：含插件专有块的请求数 2/3
- 观测：最后请求与投影逐条一致：是（10 条）
- 证据：`entry/loop.ts:485` — stream(options: StreamRequestOptions): AsyncIterable<StreamChunkLike>;
- 证据：`entry/loop.ts:3746` — messages: toWireMessages(messages),

### U2（supported）

- 问题：tools 字段能否由插件置空或裁剪；宿主是否补回自己的工具面
- 观测点：请求 tools 字段与宿主 request/header.tools
- 理由：真实驱动器：首请求 tools 字段缺省（0 schema）、后续 7/7 项（≤7）；端口未补回工具面。宿主是否强制补回需真机确认
- 观测：每请求声明工具数 0 → 7 → 7（宿主面共 12 个）
- 证据：`entry/loop.ts:3751` — ? (this.#lastPlan === null || this.#lastPlan.tools === null ? {} : { tools: this.#lastPlan.tools })
- 证据：`kernel/assembly.ts:144` — export function projectToolDecls(

### U3（unknown）

- 问题：reasoning 块是否必须原样回传（DeepSeek thinking 语义）
- 观测点：去掉旧 reasoning 后的请求是否被拒 / 降质
- 理由：本插件不走 reasoning 通道（文本协议，请求里从无 reasoning 块）；provider 是否要求回传只能由真机 provider 判定，离线不得推断。策略固定 provider-required。
- 观测：3 个请求均无 reasoning 块（hasReasoningBlocks=false）
- 证据：`entry/loop.ts:3777` — case 'reasoning-delta': {
- 证据：`kernel/assembly.ts:60` — reasoning: 'provider-required' | 'drop-stale';

### U4（supported）

- 问题：systemPrompt.context 是替换还是追加；多次注入是否累积
- 观测点：连续 3 次注入后的 system 字节
- 理由：真实驱动器 3 个请求：system 字节恒定（3502）而消息总数增长（2→6→10）、总字节增长（3512→3796→4080）——插件每次送完整 system，是替换语义；宿主是否再追加一份仍需真机确认
- 观测：system 字节 3502 → 3502 → 3502
- 观测：消息条数 2 → 6 → 10
- 观测：请求总字节 3512 → 3796 → 4080
- 证据：`kernel/render.ts:445` — stableMessages(): RenderMessage[] {
- 证据：`entry/loop.ts:3746` — messages: toWireMessages(messages),

### U5（unsupported）

- 问题：surfaceOp:'replace' 是否被宿主接受并影响下一请求
- 观测点：replace 后下一请求的 messages 基线
- 理由：适配层契约里没有 surfaceOp 字段（0.5.0 已决议不使用该通道）：插件无法表达"替换历史"，历史改写不可行，RA-2 只能"不产生"而不是"事后删"。
- 观测：3 个请求的 StreamRequestOptions 均不含 surfaceOp 字段（契约无此键）
- 证据：`entry/loop.ts:148` — export interface StreamRequestOptions {
- 证据：`kernel/render.ts:583` — requestHistoryCompression(req: {

### U6（supported）

- 问题：请求头 / usage 是否暴露逐请求 cacheRead / cacheWrite
- 观测点：eval-probe 逐请求 usage 原文
- 理由：真实驱动器 3 个请求的 request 记录都带 cacheRead/cacheWrite，且 providerInputTokens = 未命中 + 缓存读 + 缓存写（640/643/646）——可外部复算
- 观测：请求 1: providerInput=640 cacheRead=500 cacheWrite=40
- 观测：请求 2: providerInput=643 cacheRead=501 cacheWrite=41
- 观测：请求 3: providerInput=646 cacheRead=502 cacheWrite=42
- 证据：`entry/loop.ts:3107` — requestRecord.cacheRead = u.cacheReadTokens;
- 证据：`entry/loop.ts:3106` — requestRecord.providerInputTokens = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;

