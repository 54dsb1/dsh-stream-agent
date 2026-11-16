# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.1] - 2026-11-16

**装载期热修 + 控制栏。** 0.2.0 在 dsh 桌面 profile 里"装了但完全不能用"
（`1 entry did not activate stream-agent`），根因是两个独立的 Cordis 4.x 契约违约；
本版把两者都修掉，并补上给新用户看的控制栏（四模式 + 中英切换 + 桌面控制页）。

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
