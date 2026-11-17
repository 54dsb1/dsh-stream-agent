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
- **余留**：真连收益需重跑两臂评测确认（本仓库 eval 数据是 0.1.0 口径）；`selfReadFeedback: 'full'`
  可回退旧行为。

### 2. W1 / C2 退出码 1，但产物正确

- **现象**：任务在重入预算（`maxReentries: 8`）内没有收敛，进程 `exit=1`，但 checks 判 PASS。
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
5. **插件级配额（K5）**：子调用次数 / 输出字节 / 墙钟三项硬限制（缺省 64 次 / 256KiB / 300s），
   超限结构化终止（`kind: quota-exceeded`）——配额是插件侧护栏，不是宿主沙箱的一部分。
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

- **行为**：追加区超过 `segmentMaxChars`（缺省 160k 字符 ≈ 40k tokens；0/负数关闭）时，
  在**新回合开始处**把旧段整块丢弃（ADR-001 整块丢弃路线；原文句柄化 `obs:read:seg-*` 可
  tf-peek 回取，绝不摘要改写）。
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
