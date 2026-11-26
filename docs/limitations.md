# 已知限制

按"你会不会踩到"排序，每条都给出取证位置与缓解方式。**判定不过就写不过**——这份清单不做美化。

> 0.2.0 已定向修复原 1 / 3 / 5 / 7 四条（自写回验 receipt、steer 运行中注入、本地持久化兜底、
> 本地文件台账）。原条目保留修复说明，新增限制排在对应位置。

## 一、成本与正确性的取舍

### 1. 写批任务 token 偏重（0.2.0 已修复）

- **原现象**：写多文件的任务收益不稳定，模型拿到完整反馈后自发做"写 → 读回验 → 再改"循环。
- **修复**：自写回验 receipt（O7）——`tf-read` 命中本任务 `tf-write` 已写过的路径时只注入回执
  （行数 + sha256 指纹），不重复回灌全文（全文就在模型上下文里）；协议文本新增"回验纪律"。
  读**外部文件**的完整反馈保持不变，正确率路径不受影响。
- **取证**：`src/entry/loop.ts` 的 `#writtenPaths` 与 `#buildInjections` receipt 分支；
  `test/fix-limits.test.ts` R1–R3。
- **余留**：真连收益需重跑两臂评测确认（本仓库 eval 数据是 0.1.0 口径）。
- **0.5.1 回摆（如实记录）**：`selfReadFeedback` 默认已由 `receipt` 改为 `full`——自写路径同样全文
  回灌，本条的"只注入回执"不再是默认行为，`selfReadFeedback: 'receipt'` 才是回退点。理由是上游
  `max_content_chars=0`（观测全文可见）与"模型看不见自己写的原文就再读一遍"的实测代价；
  取证改用 `test/fix-limits.test.ts` R1（`receipt` 回退点）/ R2（默认 `full`）与
  `test/v051-closeout.test.ts` V2.2-1/V2.2-2（全文回灌 + `dedup` 桶）。

### 2. W1 / C2 退出码 1，但产物正确

- **现象**：任务在你设定的重入上限（例如 `maxReentries: 8`）内没有收敛，进程 `exit=1`，但 checks 判 PASS。
- **原因**：防荡护栏按设计拦截——写批任务用满 9 次请求后不再放行。
- **影响**：自动化流水线里会看到"失败退出码 + 正确产物"的组合。
- **缓解**：把护栏理解为"预算耗尽"而非"任务失败"；需要更长回验循环时调 `maxReentries`。

## 二、行为语义偏离

### 3. `steer` 语义（0.2.0 已对齐内建）

- **原偏离**：插队到队首，在回合边界生效。
- **修复**：回合运行中收到 steer → 注入运行中回合的**下一请求**（追加区 `[tf-stream:steer]`
  用户块；带未消费 steer 时不允许收敛），对齐内建"注入运行中回合的下一步"；单流
  "流内不打断"（不掐当前流）前提不变。空闲时保持原语义（插队队首、当新回合任务）。
- **取证**：`src/entry/loop.ts` 的 `pushSteer` / `#pendingSteers` 与 `StreamLoopAgent.steer`；
  `test/fix-limits.test.ts` S1–S2。
- **余留**：内建 steer 会在流间立即接管下一步；本实现保证"下一请求可见"，不保证
  "当前流中途打断"——这是单流协议的结构性前提，不是缺陷。

## 三、环境依赖

### 4. `dsh plugin` 需要 pnpm

- PATH 里没有 `pnpm` 时安装/卸载会失败。按 dsh-plugin-manager 配置 `pnpmCommand` 可绕开。

### 5. 持久化依赖宿主 storage（0.2.0 已修复）

- **原现象**：headless 未挂 storage backend / sessionPersistence 时降级内存，跨会话 resume 不可用。
- **修复**：本地持久化兜底（`src/entry/json-persistence.ts`，零依赖）——
  ① state-handle 降级本地 JSON 文件 KvUnit（durable，resume 可重建句柄目录）；
  ② AgentFactory 降级本地 JSONL 会话日志（create 落盘、resume 冷读）。
  状态根目录：`STREAM_AGENT_STATE_DIR` env → `~/.dsh-stream-agent`（子目录 `storage/`、`sessions/`、`ledger/`）。
- **取证**：`test/adapters.test.ts` A4（KvUnit 兜底 + 跨"重启" resume）、`test/fix-limits.test.ts` P1–P2。
- **余留**：本地兜底的会话日志格式是插件私有的 JSONL，与宿主 zstd session log 不互通；
  宿主持久化在位时优先宿主。`persistFallback: false` / `localFallback: false` 可关闭（回内存降级）。

### 5b. `tf-code` 依赖宿主 PTC runtime（0.2.0 新增；0.3.0 默认关闭，fail-open）

- **0.3.0 起（K1）**：`enableCode` 默认 **false**——默认装配的协议段 0 字符，模型不会幻觉调用；
  开启必须显式（`power` 模式或装配 `enableCode: true`），且以 K2–K6 收口为前提。
  不做会话级动态开关（协议段构造期冻结，动态切换会破坏前缀单调）。
- **现象**：宿主未挂 `@deepseek-ai/dsh-ptc-runtime`（`ctx.ptcRuntime` 缺失）或形状不符时，tf-code 通道整体关闭。
- **行为**：关闭是**装配期**的——协议文本不声明 tf-code（稳定前缀里不存在这个命令，模型不会幻觉调用）；
  若模型仍输出 `<tf-code>`（跨装配漂移），命令级失败注入 `no-code-channel` 并建议改道 tf-bash。告警不静默。
- **缓解**：挂载 PTC runtime 后端（如 `@deepseek-ai/dsh-ptc-runtime-node`）+ 显式 `enableCode: true`；
  关闭路径 `enableCode: false`（默认）。
- **取证**：`src/entry/ptc-bridge.ts`、`src/entry/loop.ts` 的 tf-code 分支；`test/ptc-bridge.test.ts`。

### 5b-1. tf-code 沙箱的事实边界（0.3.0 K2/K6 声明，如实陈述）

只声明"文件效果边界 + 事实记账"，**不承诺隔离/等权**：

1. **只覆盖文件效果**：宿主 `SandboxMode` 不包含网络与进程可见性——程序仍可联网、可见进程；
   把"沙箱"理解成"隔离"是错误的使用方式。
2. **Windows 只部分强制**：ACL 档报告 `enforcement=partial`（硬链接别名、读取不受限、
   AppContainer 边界）。需要绝对边界的任务必须显式拒绝或提示；插件不做"绝对只读"承诺。
   `partial` 在账本与协议错误里**显式可见**（K2：`mode` / `denied` / `enforcement` 逐次记账）。
3. **`danger-full-access` 无约束力**：全权限模式下插件没有任何文件边界；账本与 UI 如实标注
   "无约束"，使用前自己确认后果。
4. **preset/profile 不是安全边界**：它们只是组合边界，YAML 与插件仍执行宿主代码；安全声明
   只能引用 sandbox 事实（`docs/disabled-lines-audit.md`），不能引用"独立模式"。
5. **插件级配额（K5）**：子调用次数 / 输出字节 / 墙钟三项**默认不由插件设定**（0 = 不限制，
   交给宿主 `maxPendingCalls` 128 / 64MiB / `runtime.timeout.maxMs`）；用户可用
   `limits.codeMaxSubcalls` / `codeMaxOutputBytes` / `codeMaxWallMs` 收紧，超限结构化终止
   （`kind: quota-exceeded`）——配额是插件侧护栏，不是宿主沙箱的一部分。
6. **取消窗口（K4）**：回合取消直通 resolve 与绑定调用（回合 signal）；abort 后 drain 等待
   在途清理再收束（0 后置写是验收目标）；kill -9 级强杀的窗口语义见 5b-2。

### 5b-2. 写前意图与强杀窗口（0.3.0 F6，零注入）

- 变更类命令（tf-write/tf-edit/tf-append）派发**之前**把意图落盘并 fsync
  （`<stateRoot>/intents/<sessionId>.jsonl`：op/path/内容指纹）；命令落定即写回执。
- **强杀（kill -9）三时点语义**：写入前杀 = 文件不在（oracle 可证"未发生"）；
  写入中杀 = 磁盘可能有半个文件（三态判"不确定"）；写入后回执前杀 = 文件已全量落盘
  但账面"有意图无回执"——同样判"不确定"，**不自动重放**。
- **resume 停机核对**：恢复会话时发现"有意图无回执"→ `runTurn` 直接 blocked（不发请求、
  零注入），人工核对文件后 `dsh-stream-agent intents --ack <session>` 闭合。
  零注入纪律：意图与回执永不进入模型上下文。
- 回退点：`enableIntents: false`（不落盘、不核对）/ `resumeIntentPolicy: 'ignore'`（只告警）。
- 取证：`src/entry/intent-log.ts`、`eval/tools/f6-kill-drill.cjs`（10 轮强杀演练，0 重放 0 重复写）。

### 5c. 桌面控制页依赖动态客户端插件机制（0.2.1 新增）

- **依赖**：dsh `>=0.2.2-rc.1` 的 `dsh-client-modules`（扫描 `dsh.client`、组 `__DSH_BOOT__`）与
  `dsh-client-ui-layout` / `dsh-client-ui-sidebar` 的 `main` / `sidebar.panellist` 槽位；桌面 `rc.3` 实测在位。
- **装载**：页面在 `ui/` 独立子包，主包**不能**声明 `dsh.client`（同包多 entry 会触发
  `resolves from multiple active Loader sources`，整个客户端 boot 失败）。构建闸门与
  `test/desktop-ui.test.ts` 都钉住这条。
- **生效**：bundle 无 HMR，升级插件后必须重启客户端；页面只影响新会话；装配 config/env 的值
  会锁定对应控件（界面不覆盖显式配置）。
- **边界**：不是原生窗口，没有托盘/菜单/全局快捷键；这些需要改 Electron `app.asar`，不在插件能力内。
- **降级**：loop 未接管时页面仍可打开，显示"未接管"、允许写 `control.json`，并提示修复装载后重启；
  路由鉴权复用 `ctx.connection.admit`，跨站/非 JSON 请求被拒。

### 6. `tf-bash` 可能被沙箱拒

- 部分目录下 pwsh grant 失败（Win32 5）。基线臂同样受限，属环境因素而非插件缺陷。
- 缓解：把工作区放到 DSH 已授权的目录下。

### 7b. 长会话段边界的缓存重置（0.3.0 F7，ADR-001）

- **行为**：追加区超过 `segmentMaxChars` 时，在**新回合开始处**把旧段整块丢弃（ADR-001 整块丢弃路线；原文句柄化 `obs:read:seg-*` 可 tf-peek 回取，绝不摘要改写）。**0.5.2 起该值不预设：未设 = 不切段**，要启用请显式写 `limits.segmentMaxChars`（参考值 160k 字符 ≈ 40k tokens）。
- **代价（如实陈述）**：丢弃后的第一条请求是缓存冷请求（cacheWrite 重新计费）——这是
  "整块丢弃"路线的固有代价；阈值越高重置越少。发生时 policyLog + 台账显式记录，不是静默修复。
- **边界纪律**：丢弃只落在完整回合边界（当前回合的块永不丢弃，工具调用与结果不被拆开）；
  preflight 对"未记录的"前缀不一致仍然 fail-closed。
- 取证：`docs/adr-001-segment-boundary.md`、`src/kernel/render.ts` 的 `dropAppendHead`、
  `test/f7-segment.test.ts`（50 回合 × 2 请求，0 前缀违规）。

## 四、降级通道（有告警，不静默）

### 7. bundle 形态下 plugin record 通道降级（0.2.0 已修复为文件台账）

- **原现象**：bare import `@deepseek-ai/dsh-session` 拿不到宿主同一模块实例 → 降级易失内存台账，
  resume 后 `tf-*` 状态不可重放。
- **修复**：`attachSessionLedger` 先走宿主 loader 三级同源解析（`loader.import` →
  `loader.internal.import` → 动态 import）；仍不可达时降级**本地 JSONL 文件台账**（可重放），
  resume 时 `rehydrateRecords` 把 final 答案回灌新驱动器。每级降级都告警，不静默。
- **取证**：`src/entry/loop.ts` 的 `attachSessionLedger` / `collectTfAgentRecords` /
  `SingleStreamDriver.rehydrateRecords`；`test/fix-limits.test.ts` L1–L3。
- **余留**：命令记录刻意不回放（属性不回放则幂等指纹永不匹配，回放反而占用 id 命名空间）；
  final 答案与句柄目录可跨 resume 续用。

## 五、评测工具自身的缺陷

### 8. replay 一致性对真连 session log 0 命中（0.3.0 对照臂已修复）

- **0.2.x 现象**：`replay-check.cjs` 对照臂提取 0 命中 → replay 列全 FAIL。
- **0.3.0 修复（M3）**：两个根因——①提取正则要求 `path` 在 `id` 之前（属性序敏感）；
  ②`text-delta` 增量字段读错（`textDelta` → 实际是 `text`）。修复后对照臂 10/10 通过
  （树哈希 == 实跑，`eval/RESULTS.md` §6.2）；基线臂（原生 loop 的 v4 session log）
  write 调用未以可解析形态出现，如实标注"不可回放"（4/10），写入正确性由 checks 判定。
- **取证**：`eval/tools/replay-check.cjs`、`eval/runs/2026-11-15-v02/*/metrics.json` 的 replay 字段。

### 9. `injected_ratio` 口径偏差

- 驱动器 snapshot 计数在 peek / 完整反馈场景下会偏大或偏小。
- **口径**：以驱动器 turn-end snapshot 为权威值，`eval/METRICS.md` 有定义；不要用它单独论证收益，token 总量才是判据。

## 六、桌面显示面（0.3.1）

### 10. 实时帧只送思考过程，正文在落盘后显示

- **现象**：stream 模式下，桌面端流式显示的是思考过程（reasoning-delta 实时帧）；回答正文
  在该步 assistant/message 落盘后才出现（一次性）。
- **原因**：流文本是 tf-* 协议标记——逐帧透传会让标记在界面上闪现成乱码（0.3.1 修的正是
  这个）。内建 loop 的流文本是最终答案本身，所以可以逐帧透传；两种模式的流文本语义不同，
  不宜对齐。
- **取证**：`src/entry/loop.ts` 的 `#frameReasoningDelta`（只发 reasoning-delta）与
  `#consumeStream` 的落盘注释；`test/v031-display.test.ts` R3。
- **缓解**：思考过程全程实时可见；正文延迟与 0.3.0 相同（0.3.0 是全程无实时显示）。

### 11. 有工具执行的步骤，live attempt 在首个工具广告前收束

- **现象**：一条流内一旦开始派发工具（工具广告落盘），思考过程的实时帧即停止（该步后续
  的思考不再实时出现，只在落盘消息里可见）；无工具的步骤全程实时。
- **原因**：客户端 fold（`ClientAssistantStream`）把活跃 attempt 期间到达的 assistant/message
  暂存进 pending，而 end 帧只消费一条结算——广告消息不收束会滞留到下一步，触发
  `events.restart()` 整窗重建（比"提前收束"更伤体验）。
- **取证**：`src/entry/loop.ts` 的 `#frameEndAbandonedIfOpen`；`test/v031-display.test.ts` R3。

## 七、协议组件化的边界（0.4.1-beta.1）

### 12. 档位/段配置是构造期冻结，改配置要新会话

- **现象**：`protocolLevel` / `protocolSections` / `protocolAppend` / `invariants` 改动只对
  **新建会话**生效；已开回合的会话继续用构造时的协议文本。
- **原因**：协议文本进稳定前缀（O4），会话内突变会触发前缀断言 fail-closed（宁可拒发
  不烧缓存）。这与 `toolSurface` 档位（§8.1）同一语义。
- **缓解**：装配/模式级配置，新会话即生效；CLI `dsh-stream-agent protocol` 可先预览效果
  再写进装配。

### 13. 省多少只有静态字符数，没有真机 token 复算

- **现象**：README/CHANGELOG 里的 2,836 → 1,161 字符是**源文本实测字符数**（金样测试
  钉死），不是四分量口径的 token 数字。
- **原因**：P6 三臂真机复跑需要 API key 批次（与 0.4.0-beta.1 的 T1 门槛判定同批）；
  在此之前任何"省 X% token"的换算都是编造。
- **取证**：`test/v041-protocol.test.ts` C8（字符数护栏）+ `npm run check` 6/6；真机数字
  待 `eval/tools/summarize.cjs` 同批双臂产出。

### 14. `protocolLevel` 不进模式目录（四模式输出逐字节不变）

- **现象**：`balanced/lean/compat/power` 四模式的行为与 0.4.0-beta.1 完全一致——协议档位
  只在显式装配配置时改变输出。
- **原因**：把 lean 档绑进 lean 模式是行为变更（旧用户的稳定前缀会变），不属于"只追加"
  的版本纪律；待评审后再做。
- **取证**：`test/v041-protocol.test.ts` D5（缺省构造的前缀与 0.4.0-beta.1 一致）。

### 15. 计划与命令记录不跨 resume 持久化（0.5.2 如实声明）

- **现象**：`tf-plan` 的验收项状态（verified / 证据）与 `#records` 只在驱动器内存里；
  resume 后计划为空、历史命令记录为空。
- **影响**：resume 后需要重新 `tf-plan` 声明验收项；final 闸不会因"旧计划未验证"而拒绝
  （计划为空 ⇒ 不启用验收闸），因此**不会死锁**，但已获得的机器证据（谓词通过、回执）
  需要重跑一次。
- **未做原因**：计划快照的持久化格式（修订号 / 文本哈希 / 谓词 / 证据）需要与宿主 session
  事件对齐，当前只在台账 `plugin:tf-agent/plan` 里有可复算的流水；落盘格式定稿前不写半成品。
- **取证**：`src/entry/loop.ts` 的 `#plan` / `#records`（构造期为空）。

### 16. 沙箱模式切换不中止在跑程序（0.5.2 如实声明）

- **现象**：`tf-code sandbox=` 改变只影响**之后**的运行；已提交给宿主 PTC runtime 的程序
  继续按旧策略跑完。宿主契约里"策略变化 → 中止在跑程序"的编排需要 runtime 侧支持
  （`release` + 重新 `resolve` 的时机由宿主决定），插件不擅自 kill。
- **替代保障**：`state=` 的保留态在策略变化时**作废**（不跨策略复用内存），并在台账
  记 `plugin:tf-agent/code { dropped: true, reason }`。

### 17. `receipt:N` 只覆盖"写后自读回执"（0.5.2 如实声明）

- **现象**：目前只有 `tf-read` 命中本任务 `tf-write` 已写路径时产生的回执带编号
  （`[tf-stream:receipt … receipt=N]`），可用 `tf-peek handle="receipt:N"` 复读。
  其它命令的成功回执（`handle` 族）仍走句柄目录，不经 `receipt:N`。
- **原因**：回执编号空间要避免与句柄空间混淆；先覆盖"跨步回看自己写过什么"这一最高频需求。

## 六、0.6.0 RA-0 探针结论与未确认项（如实声明）

探针产物：`eval/runs/ra0/U1-messages.json … U6-usage.json` + `summary.md`（`node eval/tools/ra0-probe.mjs` 可复跑）。
**作用域**：只测本插件掌握的接缝（`DriverPorts.stream` 入参契约 + 适配器行为），探针自带 mock host，
**不经过真实 DSH 宿主**——因此所有结论都不能读成「宿主已验证」。宿主侧
（DSH `llm/stream`）的真实校验一律标 `hostVerification: pending`，离线不冒充已在宿主验证。

### 18. U5 `surfaceOp:'replace'` 不支持（历史改写不可行）

- **结论**：`unsupported`。适配层契约里没有 `surfaceOp` 字段（0.5.0 已决议不使用该通道）。
- **影响**：插件无法表达"替换历史"；RA-2 的载荷去重只能"不产生第二份"，不能"事后删除已发内容"。
- **路线判定**：`system-tools-only`——只做 system / tools 投影；messages 保持 append-only。
- **取证**：`eval/runs/ra0/U5-surface-replace.json`；`src/entry/loop.ts` 的 `StreamRequestOptions` 无该字段。

### 19. U3 reasoning 必需性未确认（unknown）

- **结论**：`unknown`。本插件走文本协议，请求里从无 reasoning 块，因此"provider 是否要求原样回传"
  离线无法判定；`reasoningPolicy` 固定 `provider-required`，不尝试丢弃旧推理。
- **待确认**：真机 DeepSeek thinking 通道下补一次探针（计划 §2.2 U3）。
- **取证**：`eval/runs/ra0/U3-reasoning.json`。

### 20. RA-0 全部结论待宿主侧复核（hostVerification: pending）

- **现状（0.6.0 收口）**：U1/U2/U4/U6 已全部改走**真实驱动器**（`SingleStreamDriver` + `ports.stream`，
  各 3 个连续请求）：U1 对账"端口收到的 messages = 插件投影"（10 条逐字节一致）；U2 量到
  "首请求 0 schema、后续 7 项 ≤7"；U4 量到 system 字节恒定（3502）而消息数 2→6→10；
  U6 量到逐请求 `providerInputTokens / cacheRead / cacheWrite`。U3 仍是 `unknown`（provider 语义），
  U5 是契约缺失（`StreamRequestOptions` 无 `surfaceOp`）。
- **仍需真机**：宿主是否补回 messages/tools、是否强制注入 system、是否允许 messages 与其
  session 投影不同——这三件只能在真机 profile 上重跑同一组探针，离线不做结论。
- **处置**：`plan` 模式默认关闭（`assemblyPolicy: 'host'`），且任何前缀违规/投影异常自动回退 host
  （`assembly-fallback` 台账可检索）。不因为"接缝看起来支持"就默认发布 plan 模式。
- **未跑的指标（计划 §4.6，延后到真机）**：四分量（未缓存输入 / 缓存读 / 缓存写 / 输出）、严格二分量、
  请求数与前缀命中、10 题任务集逐任务对比——都需要真实 API 与真实宿主，本轮离线阶段只回答
  "装配形态是否正确"，不回答"省了多少 token"。

## 七、0.6.0 正式版新增能力的边界（如实声明）

### 21. tf-revert 是插件侧 fs 写回（不经宿主工具管线）

- **现状**：回滚的原子写回（tmp+rename）由 entry 直接执行，路径根 = `projectDir ?? cwd`
  （与 revisionFacts 同一解析口径）。宿主沙箱/审批不约束这条写回——守卫是
  **expected 双重校验 + 私有回执目录（模型不可写）+ 快照哈希完整性**，不是宿主审批。
- **待确认**：真机宿主是否要求所有文件写都经工具管线（hostVerification: pending）。
  若要求，正确落点是把写回经 toolMapping 转宿主 write 工具（语义不变，端口替换）。
- **崩溃窗口**：回执是写后确认（begin+complete 在写成功后结算），不是文件系统事务；
  "写已发生但回执未落盘"的窗口由 F6 意图日志覆盖（resume 停机核对）。与 TF 同一免责声明。

### 22. 密钥保护是 basename 模式 + 正则脱敏（不是完整 DLP）

- 拒读判定只看 basename（与 TF fnmatch 口径一致）；内容脱敏只覆盖
  `api_key/token/secret/password/access_token/refresh_token/bearer_token` 赋值形态。
  变形密钥（Base64 整段、自定义键名）不在默认面内——需要更强策略请在宿主侧配置。
- `allowSensitivePaths: true` / `redactOutput: false` 是显式回退点（装配级）。
- 宿主工具自身的日志/显示面不在插件管辖（插件只保证**进模型请求的内容**脱敏）。

### 23. 预设与开关的生效时机

- 预设应用 = 整组替换 limits + 设置开关 + 落盘标记。**limits 立即对当前会话生效**
  （setLimits replace）；**开关（fold/final/raw）在下一次创建 agent 时生效**——
  它们进稳定前缀/观测管线，构造期冻结，会话内不突变（与 0.6.0-beta 的 fold/final 同口径）。
- 任何手工修改 limits/开关把预设标记清为"自定义"；通道/档位切换不清标记。

### 24. 上下文"完全不处理"（contextRaw）的精确语义

- 停用：压缩、效果折叠、段边界丢弃、span 重复抑制、读取/回灌/原生结果/tf-code 注入截断。
- **不停用**：用户 limits 的预算类上限（peekBudgetChars/readFeedbackBudgetPerRequest 等）——
  那是预算拒绝，不是内容处理；句柄目录/行锚索引（导航辅助，只增不改内容）；脱敏（安全面）。
- 原样档开启时折叠在生效面强制关（状态面如实写"原样开启，折叠强制关"）。
