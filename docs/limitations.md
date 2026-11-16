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

### 5b. `tf-code` 依赖宿主 PTC runtime（0.2.0 新增，fail-open）

- **现象**：宿主未挂 `@deepseek-ai/dsh-ptc-runtime`（`ctx.ptcRuntime` 缺失）或形状不符时，tf-code 通道整体关闭。
- **行为**：关闭是**装配期**的——协议文本不声明 tf-code（稳定前缀里不存在这个命令，模型不会幻觉调用）；
  若模型仍输出 `<tf-code>`（跨装配漂移），命令级失败注入 `no-code-channel` 并建议改道 tf-bash。告警不静默。
- **缓解**：挂载 PTC runtime 后端（如 `@deepseek-ai/dsh-ptc-runtime-node`）；或 `enableCode: false` 显式关闭。
- **安全面**：程序体自身不做任何直接 IO——唯一绑定命名空间 `tools`（write/read/pwsh）走驱动器同一条
  `executeTools` 通道，宿主 guard/工作区策略/凭据全部生效；沙箱能力（文件策略/超时）按宿主 runtime 装配为准。
- **取证**：`src/entry/ptc-bridge.ts`、`src/entry/loop.ts` 的 tf-code 分支；`test/ptc-bridge.test.ts`。

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

### 8. replay 一致性对真连 session log 0 命中

- **现象**：`replay-check.cjs` 在真连产出的 zstd session log 上提取不到工具调用（smoke 造数场景正常）。
- **判定**：**工具缺陷，不是回放机制失败**。所以 `eval/RESULTS.md` 里 replay 列全是 FAIL，请以 probe log + metrics 为准。
- **影响**：想用 replay 做零成本回归前，得先修提取器。

### 9. `injected_ratio` 口径偏差

- 驱动器 snapshot 计数在 peek / 完整反馈场景下会偏大或偏小。
- **口径**：以驱动器 turn-end snapshot 为权威值，`eval/METRICS.md` 有定义；不要用它单独论证收益，token 总量才是判据。
