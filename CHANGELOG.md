# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.3.0] - 2026-11-17

**独立模式 + 全量升级条目。** 交付形态固定为 A-1（专用 profile）；按
`upgrade-plan/`（alpha.1 → alpha.2 → beta.1 → beta.2 → 0.3.0）完成 M/S/K/F/R 五组全部条目，
并把 **0.4.0 规划的 F5/F6/F7 一并实施**（合并产出，最终版本号标记 0.3.0，
实施对照见 `docs/v0.4.0-plan.md`）。

另含**会话日志格式修复（发布前并入，不单独发版）**：0.3.0 开发期写出的会话日志在宿主
v4 校验下被判 corrupt（`tool/call <id> has no advertised tool lifecycle`），桌面端点开历史
对话报"加载失败"；本版修正写入路径，并附存量日志修复脚本。

### Added

- **独立装配（S 组）**
  - **专用 profile 模板（S1）**：`profiles/stream`（web 入口）与 `profiles/stream-headless`；
    组合顺序 `dsh-base → 主 bundle → preset bundle → 入口`；`agent-loop` 停用只在主 bundle
    patch（C4 卸载原子），profile patch 只承载 registry 默认值覆盖。
  - **安装前置校验（S2）**：`scripts/install-check.mjs` —— 允许列表只有 `stream` /
    `stream-headless`；误装 `web`/`desktop` 100% 被拒（含原因与允许列表）；dry-run 打印
    目标 profile、组合包、patch 与受影响 entry；只读不写，无"强制安装"开关。
  - **`preset-stream` 独立 bundle（S4）**：`preset/stream/` —— 只声明映射工具面
    （tool-fs（applyPatch 开）+ tool-fs-search + pwsh/bash 平台二选一）；preset 行不进主
    bundle patch（B 形态不污染既有 profile）；registry 默认值由 profile patch 覆盖指向
    `stream`；headless 不引入 preset。
  - **装卸与回退（S6）**：`scripts/install-cycle.mjs` —— 10 轮 add → 启动自证 → remove →
    恢复验证；回退路径 = 回退 0.2.x 产物或删 profile，不手工修 profile。
  - **双 loop 具名诊断（S3）**：`setFactory` 冲突转 `E_DOUBLE_LOOP`（Error.name），
    携带 profile 标识（宿主 profileContext / env DSH_PROFILE）、冲突来源与处置建议；
    不 catch 后继续、不自动重试。
  - **禁用行审计（S5）**：`docs/disabled-lines-audit.md` —— 逐行记录依赖与结论；审计后
    放弃 0.2.x 计划的全部"候选停用行"（宿主提示行不进请求，停用无 token 收益）；
    PTC 四行 / compaction 四行同族同进同退。
- **能力面（F1–F4）**
  - **`tf-edit` / `tf-append`（F1）**：精确替换（OLD/NEW 标记块，映射宿主 `edit`）与
    只追加（anchor 锚点插入或 EOF 追加，映射宿主 `edit` / `apply_patch` `*** End of File`
    锚）；匹配失败结构化报错，不做模糊匹配、不静默改全文；编辑成功只回回执。
  - **`tf-grep` / `tf-glob`（F2）**：映射宿主 fs-search，只回匹配行（带行号）/ 路径，
    不回全文；协议文本明写"不要用 tf-bash 做搜索"。
  - **code 结果可见性（F3）**：仅 tf-code 显式开启时，首成功/变化值 ≤4000 字符
    （`codeValueInjectLimit` 可配）完整注入，省一次 tf-peek 往返；超限转骨架 + 句柄。
  - **原生通道上限（F4）**：声明 `nativeToolSchemas` 时，原生 tool_call 单块结果
    > 6000 字符（`nativeResultLimit` 可配）→ obs 句柄化 + 骨架，杜绝全量回灌后门。
- **中性能力（0.4.0 规划条目，随本版实施）**
  - **计划与验收（F5）**：`tf-plan` 命令（body = `- [id] 验收项` 行）+ 公共属性
    `accepts`（任意命令可声明验收关联）；计划状态放驱动器侧，请求**只注差分**
    （新计划全量一次，此后只注新增/已验证/已移除；无变化不产生块）；验收项只能被
    **命令成功回执**验证（模型自述不算证据）；有未验证验收项时 `tf-final` 判过早；
    `enablePlan: false` 回退点。
  - **恢复意图（F6）**：新增 `entry/intent-log.ts` —— 变更类命令（tf-write/tf-edit/tf-append）
    派发**前**意图 fsync 落盘（`<stateRoot>/intents/<session>.jsonl`：op/path/内容指纹），
    落定即回执；resume 发现"有意图无回执" → **停机核对**（`runTurn` 直接 blocked，
    不发请求、零注入、不自动重放）；CLI `dsh-stream-agent intents`（三态判定列出）/
    `intents --ack <session>` 人工确认闭合；三态 = 未发生 / 已发生 / 不确定（强杀三时点
    可区分）；`enableIntents: false`、`resumeIntentPolicy: 'ignore'` 回退点；
    强杀演练 `eval/tools/f6-kill-drill.cjs`（10 轮 SIGKILL × before/mid/after-write 三时点，
    离线零 API 已跑：0 重放、0 重复写）。
  - **长会话段边界（F7）**：先出 **ADR-001**（`docs/adr-001-segment-boundary.md`，
    采纳"整块丢弃"、拒绝宿主压缩与摘要改写）；`render.ts` 新增 `dropAppendHead()`
    （整块 + policyLog 记录 + 前缀基线重置——唯一合法的前缀重置入口，未记录的漂移仍
    fail-closed）；驱动器 `segmentMaxChars`（默认 160k 字符 ≈ 40k tokens，0 = 关闭）在
    新回合开始处整块丢弃旧段；被丢弃原文 obs 句柄化（`obs:read:seg-*`）可
    `tf-peek` / `peekHandle()` 回取；`appendBlockCount` / `appendChars` 只读投影；
    测试：50 回合 × 2 请求 = **100 请求 0 前缀违规**，末/首请求 ≤1.5×。
- **计量与治理（M 组 / R 组）**
  - **M1 四分量计量**：`eval/tools/summarize.cjs` —— 逐请求 usage 原文求和
    （输入/缓存读/缓存写/输出），标题旁路剔除，缺失分量标"不可得"不按 0 计；
    产出 `summary.json` + Markdown 表；`eval/RESULTS.md` §6 以 2026-11-15-v02 批次复算
    （基线 446,410 → 插件 129,178 = 28.9%，与历史 22.3% 批次的不可比性如实说明）。
  - **M3 replay 修复**：对照臂提取器两个根因——①属性序敏感（path 必须在 id 前）；
    ②`text-delta` 增量字段读错（`textDelta` → 实际 `text`）——修复后对照臂回放一致性
    **10/10**（树哈希 == 实跑，含 64 次写入回放）；支持 tf-edit/tf-append 回放；
    提取器错误如实记"提取失败"；零写入任务种子树 == 结果树即通过。
  - **M2 T3 三格采集**：`eval/tools/t3-cells.cjs`（首请求拆分 system/协议段/工具 schema/
    任务四部分 + A-1a==B 逐字节判定 + 差值 == code 段长度判定）；三臂 patch：
    `patches/eval-stream-code-on.yml`（A-1a）/ `eval-stream-code-off.yml`（A-1b）；
    B 格用 v0.2.1 tag 产物；tf-code 协议段实测 1,175 字符。
  - **R2 一致性检查**：`scripts/check-consistency.mjs`（`npm run check`）—— entry 集 /
    inject / 装载顺序 / README 命令表四项，一条命令复跑；当前 4/4 全绿。
  - **R4 发布门禁**：`scripts/gate.mjs`（`npm run gate`）—— 装配一致性 / C2 单 loop /
    C8 卸载原子 / C9 tag=package / C1 token 门槛 / 回退演练六项；离线项就地判定，
    真机项（G5/G6）如实标"待人工复测"，未过不发布。
  - **K6 真机五场景**：`eval/tools/manual-code-scenarios.md`（成功/失败/取消/拒绝/partial，
    每场景记录 kind/账本/最终状态）。
  - **测试命题**：`docs/TEST-PROPOSITIONS.md` —— A 组回归 + B 组新能力（B1 编辑、B3 搜索、
    B4 计划、B5 幻觉检查、B6 五场景、B7 强杀、B8 段边界、B9 双 loop、B10 校验）+
    C 组成本对照；≈2 元/命题，供人工复测。
- **会话日志修复工具（发布前并入）**
  - **`scripts/repair-session-logs.mjs`：存量日志修复**。默认 dry-run，`--write` 落盘；
    为缺失广告的 `tool/call` 补入同 turn/step 的 `assistant/message`（tool-call 块），
    把误写在 `step/end` 之后的 final 答案移回 step 内，重排 seq 与全部 seq 引用
    （`sourceEventSeqs` / `messageSeqs` / `throughSeq` / `headerSeq` / 压缩范围），
    写前备份 `.bak-<时间戳>`、写后清除投影缓存；设 `DSH_HOST_MODULES` 时用宿主自己的
    v4 校验器复核（`restoreReleasedV4Artifact` + `assertReleasedV4Relationships`）。
    实测：本机 10 条历史会话全部修复为可读，27/27 会话通过宿主校验。
  - **`test/session-format.test.ts`**：S1 正常回合的广告顺序、S2 派发前异常的
    `TOOL_NOT_STARTED` 闭合、S3 final 答案早于 `step/end`；用"宿主同款"假工具管线
    （start → tool/call，commit → tool/result）复核生命周期。

### Changed

- **K1：`tf-code` 默认关闭**。`balanced` 模式的 `enableCode` 从 `'auto'` 改为 `false`
  （`'auto'` 保留为兼容值、等价 false）；驱动器语义改为"仅显式 `enableCode: true` 且
  `executeCode` 端口在位才启用"；`cordis.patch.yml` / `preset.yml` / `patches/eval-stream.yml`
  显式写 `enableCode: false`（装配断言）。默认装配协议段 0 字符，模型不会幻觉调用；
  关闭 ≠ 删除通道：`ptc-runtime` 等四行保留，`no-code-channel` 命令级失败引导改道。
- **K2 策略透传与沙箱记账**：`ptc-bridge` resolve 透传会话 cwd（session header.cwd →
  workingDirectory 服务默认目录，不复制宿主优先级规则）；`result.sandbox` 的
  `mode`/`denied`/`enforcement` 逐次记账（新增 `sandbox` 台账记录与 DriverRecord 类型），
  `enforcement=partial` 显式可见。
- **K3 失败分类保真**：`CodeOutcome` 结构化（`kind`/`retryable`/`advice`）；
  `classifyCodeFailure()` 逐类给出可重试结论（八类 kind 原样保留 + `ptc-runtime-misuse` /
  `quota-exceeded`）；注入文案 `[kind=... retry=yes|no]` + 日志尾 200 字符；
  沙箱拒绝与代码错误分开引导。
- **K4 取消链路**：驱动器新增回合级 `#turnController`（runTurn 创建、cancel abort、
  finally drain 等待在途清理再释放）；tf-code 与 executeTools 派发共用回合 signal，
  替换原"独立且永不触发的 AbortController"；取消类错误识别（`isAbortError`）与超时分账。
- **K5 配额**：`codeQuota`（maxSubcalls/maxOutputBytes/maxWallMs，缺省 64 / 256KiB / 300s）；
  配额在绑定调用与结果两侧硬终止（程序内吞掉配额错误也照样结构化终止），
  墙钟经自铸 controller abort 传导，与宿主 timeout 独立记账。
- **协议文本**：命令表新增 tf-edit/tf-append/tf-grep/tf-glob/tf-plan 与"计划与验收"节；
  修正 v0.1 遗留的过时描述（"tf-read 成功不回灌"→ 实际首版/变化完整注入）；
  tf-code 段补配额与沙箱事实说明。
- **护栏按回合重置（F7 测试实抓的真 bug）**：`#reentryCount` / `#finalNudges` /
  `#finalOnlyRequests` 在 `#turnLoop` 入口清零——此前跨回合累计，多任务长会话会在
  第 N 个回合被历史计数误杀（blocked 重入上限）。
- **版本**：`package.json` / `src/version.ts` → 0.3.0；`files` 增加 `profiles/` 与 `preset/`；
  `scripts` 增加 `check` / `gate`（另有并入的 `repair-session-logs.mjs` 存量日志修复）；
  engines 维持 `dsh >= 0.2.2-rc.1`。
- `preset.yml` 与 `cordis.patch.yml` 对齐（stream-agent inject 补 `sessionProjections`，
  与 0.2.1 真机验证过的装配形态一致）。
- **兼容性（会话日志）**：装配、协议、配置项全部不变（`enableCode` 仍默认关闭）。0.3.0 起
  写出的日志可被 0.2.x 读取（新增的只是合法的 `assistant/message` 事件）；0.2.x 及 0.3.0
  发布前的开发期产物写出的旧日志仍需跑一次 `repair-session-logs.mjs` 才能加载。

### Fixed

- **M3 对照臂 replay 0/10 → 10/10**（详见 Added/M3）。
- **多回合护栏误杀**（详见 Changed/护栏按回合重置）。
- **F6 演练脚本与 t3-cells 的 Windows 路径 / 事件循环问题**（file:// URL 导入、
  Atomics.wait 阻塞 stdout 事件）。
- **会话日志 v4 工具生命周期（致命，桌面端"历史加载失败"的直接原因）**
  - **工具调用生命周期缺失**：驱动器把 tf-* 命令映射成宿主工具后直接调
    `ctx.tools.execute`，由宿主管线写 `tool/call` + `tool/result`，却从未写 v4 格式要求的
    `assistant/message`（content 带 `tool-call` 块）。`dsh-session-format-v3-to-v4` 的
    `tool()` 在读取时抛 `tool/call <id> has no advertised tool lifecycle` → 整条日志被判
    corrupt；表现是会话列表能列出、点开却"历史加载失败"。现在每次派发**前**先广告同名
    同参的 tool-call 块（`advertiseToolCalls`）；派发异常 / 批次缺项时用 `repairToolCall`
    闭合生命周期——未开始 = 宿主唯一接受的 `TOOL_NOT_STARTED` 修复形状
    （`message.id = interrupted-tool-result-<callId>-<n>`、`isError:true`、
    `error.code = TOOL_NOT_STARTED`），已开始 = 普通错误结果，已有 result 不重复写。
    原生 `tool_call` 通道的调用块随同一条 assistant 消息一起广告。
  - **final 答案写在 step/end 之后（同类 corrupt）**：`finalAnswer` 原在 `step/end` 之后写
    `assistant/message`；v4 要求该事件落在打开的 turn+step 内（否则读取时抛
    `assistant/message does not match an open turn and step`）。收束判定前移到
    `step/end` 之前写出。
  - **不可重试流错误的 step/end 早于在途工具**：fail-fast 分支先写 `step/end` 再结束，
    流中途已派发的 `tool/call` 会在 `step/end` 之后才落 `tool/result`（同一类 corrupt）。
    现在先 `drain()` 等在途工具落定，再写 `step/end`。

### Security

- 安全声明收口为"文件效果边界 + 事实记账"（C5）：`docs/limitations.md` §5b-1 明确
  ①只覆盖文件效果（网络/进程不在范围）；②Windows 档 `enforcement=partial`；
  ③`danger-full-access` 无约束；④preset/profile 不是安全边界；⑤`partial` 与
  `danger-full-access` 在账本与文档中显式可见；全文无"隔离/等权"表述。

### 测试

- 275/275 全绿（+5 F5 计划验收、+5 F6 意图、+4 F7 段边界、+3 会话格式回归）。
- 离线演练：F6 强杀 10 轮通过；M3 对照臂 replay 10/10；M1 复算一致。
- 真机复测项（不阻塞本版提交，阻塞正式发布）：R3 评测矩阵重跑、M2 三格、K6 五场景、
  S6 十轮装卸、回退演练 —— 全部命令与命题见 `docs/TEST-PROPOSITIONS.md` 与
  `eval/GATE-0.3.0.md`。

## [0.2.1] - 2026-11-16

**装载期热修 + 控制栏。** 0.2.0 在 dsh 桌面 profile 里"装了但完全不能用"
（`1 entry did not activate stream-agent`），根因是两个独立的 Cordis 4.x 契约违约；
本版把两者都修掉，并补上给新用户看的控制栏（四模式 + 中英切换 + 桌面控制页）。

> 注：本节末尾的"模式标注（saving/availability）"与 `wrapText()` 重写两节在 v0.2.1 tag
> 之后完成，随 0.3.0 一并发布（R1 纪律：不追溯移动已发布 tag）。

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
