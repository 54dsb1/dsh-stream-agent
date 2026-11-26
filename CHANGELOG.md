# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

> **编号说明**：`0.4.0-beta.1 … 0.4.3.2` 是 artifacts 研发线的内部编号；**stable 线对这些
> 内容统一编号为 `0.4.0`**（本条目）。0.4.3.2 与 0.4.0 的源码等价，唯一差异是版本常量与
> 本段说明。stable 线上一次发布是 `0.3.3`。
>
> **0.5.0 编号说明**：`0.5.0 … 0.6.0` 是 0.5 线研发过程的内部编号（含 `0.5.1-beta`…
> `0.6.0-beta` 各轮）。**正式发布把这条线的全部内容统一编号为 `0.5.0`**（本条目）；内部
> 编号的条目保留在下方作为过程记录，不再单独发版。stable 线上一次发布是 `0.4.0`。

## [Unreleased] — 0.5.1 方向（代码级核查 + 预设体系重构 + wire 传输面）

**四件事：① 执行通道「代码」更名「PTC兼容模式」；② 移除 5 套行为预设，默认数值面对齐
xuxiang-thinkflow 出厂预设，轮数上限（maxSteps）一律不预设；③ wire 传输面对齐 thinkflow
（max_tokens / stream_options / thinking / tool_choice / retries 五键入 limits，面板随时可改）+
推理回传策略两实值补全；④ 文档与操作台去版本留痕（README 全量重写）。** 用户自定义权力完整保留。

### Added

- **wire 传输面（对齐 xuxiang-thinkflow provider.py 请求装配语义）**：limits 新增传输组五键——
  `maxTokens`（max_tokens，0 = 委托给 provider）/ `thinkingBudget`（thinking.budget_tokens，
  ≥1024 生效）/ `streamUsage`（stream_options.include_usage）/ `maxRetries` + `retryBackoffMs`
  （建连失败重试，只覆盖建连、不覆盖流中途）。默认 = thinkflow 出厂预设
  （0/0/0/2/1000），并入 `THINKFLOW_ALIGNED_LIMITS`；每个请求发送前从生效 limits 组装，
  控制面板 / `limits --set` / 装配 config 改完下一请求即生效。配套字符串设置
  `thinkingMode`（disabled/enabled/provider type；enabled 且未给 effort 时默认 high）与
  `tool_choice: 'auto'`（原生工具声明在面内时）。
- **推理回传策略两实值都真实生效**：`reasoningStrategy` 装配项（默认 `provider-required`，
  assistant 消息按宿主原样携带 source）——`drop-stale` 保留 source 壳（宿主 LlmRuntime
  硬要求）但**剥离 replayState**：推理/回放状态绝不回传，请求纯文本、每请求无状态
  （thinkflow 等价语义）。装配投影与 wire 投影共用该策略；`status --json` 暴露诊断面
  （strategy / thinkingMode / effort）。
- **文档与操作台去版本留痕**：README（中英）全量重写——只描述当前版本，无任何
  "相对 x.x 的增量"/版本对照叙述；docs/limits.md 重写（29 键全表 + 传输组）、
  docs/channel-matrix.md、preset.yml、PROTOCOL-v1.md 正文清理版本标签（协议规范自身的
  v1.x 版本史保留）；操作台移除通道卡"行为对照"行与版本字样（`limitsEmpty`、legacy 目录
  去弃用/移除标注），CLI 帮助不再列出旧 mode 别名（命令保留兼容，仅不再展示）。
  新增 `test/v062-wire.test.ts`（传输面 7 用例：默认预设 / 用户覆盖 / thinking 形态 /
  tool_choice / 推理策略 / 建连重试）。

### Changed

- **执行通道更名**：`code` 通道的用户可见名「代码」→「PTC兼容模式」（en `PTC-compat`）。
  内部 id `code`、配置值 `channel: 'code'`、`channel <standard|code>` CLI 取值全部不变
  （配置兼容）。同步面：控制栏面板/指南/状态条、桌面控制页（中英）、CLI 帮助、
  通道不可用告警文案、`preset.yml` 注释、README（中英）、docs/channel-matrix.md。
- **移除行为预设（`kernel/presets.ts` 删除）**：`light/balanced/deep/raw/unlimited` 五套
  整组替换入口全部下线——`p` 键循环、CLI `preset [id]`、桌面预设卡、装配 `config.preset`、
  env `STREAM_AGENT_PRESET`。旧 `control.json` 的 `preset` 标记与 `config.preset`：读取时
  告警并忽略（红线 5 不静默），写盘不再产生该字段（schema 5 不变）。
- **默认数值面 = thinkflow 对齐层（`kernel/limits.ts` 新增 `THINKFLOW_ALIGNED_LIMITS`）**，
  逐项映射 xuxiang-thinkflow `config.example.json`：
  `keepRecent=30`（keep_recent_messages）/ `maxSummaryChars=16000`（max_summary_chars）/
  `maxReadChars=200000`（max_read_chars）/ `maxReentries=8`（max_auto_continues，
  `stallReentries` 由 deriveLimits 跟随）。注入点 = 驱动器 `#limitsFor` 最底层与桌面
  降级视图 effective 投影；`control.json` 保持**纯用户层**（默认层不物化进盘，随版本可传播）。
- **前缀不单调处置改为「接受继续」**：wire 承诺前缀断言的三类违约（stable-drift /
  append-drift / shrink）默认不再 fail-closed/限流——发送前接受为**缓存重置点**，同一份
  next 照常发送（断言在发送前 → **0 额外请求 / 0 重复计费 / 0 注入文本**），对话不中断；
  基线随本请求推进，后续请求恢复单调（缓存恢复命中）。物理下限：违约请求本就只有这一版
  可发，接受即最优；`prefixPolicy='fail'`（显式回退面）保留原 fail-closed + 诊断转储 +
  最小对账。退役：append-drift 的放行限流（每回合 1 / 每会话 3）、§8.4 换基成本判据
  （rebaseBudgetRatio，配置字段保留兼容但不再约束）、stable-drift 的"始终 fail"硬规则。
  同轮自动续跑（`autoContinueOnPrefixFail`）只覆盖 render() 内置 preflight 与显式 fail 面。
- **PTC 兼容模式来源探测 live 化（修复窗口后开 PTC 被误拒）**：原实现只在插件装载期
  `detectCodeChannelSource` 探测一次并固化进判据——宿主 PTC preset 按窗口/会话挂载时，
  装载期探测为空 → `setChannel('code')` 永久拒绝（"写入失败：未检测到 PTC 预设或
  ptcRuntime"）。0.6.1：`StreamDriverConfig` 新增惰性探针 `codeSourceProbe`（apply 传
  闭包，每次现取宿主 tools/ptcRuntime 服务重新判定）；驱动器构造与会话级
  `setChannel('code')` 在判据为空时实时补判，命中即更新缓存来源并放行；控制页状态面
  `codeSource` 同步 live 化。探测为空仍拒绝进入（不静默降级纪律不变）。

### Removed

- **所有预设中的 maxSteps 上限**：轮数上限从 5 套预设（16/24/40）、参考档位
  （`REFERENCE_PROFILES` 整体删除）与档位参考值中移除——`maxSteps` 一律不预设（未设 = 不限制），
  插件永不替用户决定"干到多少轮算够"；需要收紧就显式写 `limits.maxSteps`。
- 参考档位 `light/standard/deep`（`referenceProfileOf`）——唯一消费方是预设系统，随之移除；
  档位（tier）参考值改为 thinkflow 对齐数值（`maxSteps=0`，keepRecent 30 / maxSummaryChars 16k），
  档位差异只剩压缩强度。

### 保留（用户自定义权力）

- 24 键 limits 全量可配：CLI `limits --set/--replace/--reset`、控制栏 `u` 行内编辑、
  桌面页上限区块、`STREAM_AGENT_LIMITS` 环境变量、装配 `config.limits`（含
  `limitsByChannel` / `limitsByTier`）；显式 `0` = 该项不限制，压过默认层。
- 三个行为开关（`contextFold` / `finalCheck` / `contextRaw`）入口不变。

### Tests

- `test/v060-presets.test.ts` → 重写为 `test/v061-defaults.test.ts`（thinkflow 默认层注入、
  用户覆盖、旧预设痕迹迁移告警、contextRaw 强制面、桌面路由 preset 400）；
  `limits.test.ts` / `control-bar.test.ts` / `desktop-ui.test.ts` / `v052-fixes.test.ts` /
  `v060-fixes.test.ts` / `v060-switches.test.ts` / `v050-channel.test.ts` 同步新契约。
- 前缀契约同步（0.6.1「接受继续」）：`v043-prefix.test.ts` P2/P3 重写 + 新增 P2b
  （显式 fail 面）、`v050-prefix.test.ts` P3 重写 + B1 重写（预算判据退役钉）、
  `v060-switches.test.ts` A4/A5 系列显式 `prefixPolicy:'fail'`；
  `v050-channel.test.ts` 新增 R3（惰性探针：窗口后开 PTC → setChannel 放行）与
  R4（构造期探针命中 → 不回退）。
- 全量：615 用例 / 614 通过 / 0 失败 / 1 预置跳过。

## [0.5.0] - 2026-11-27

**0.5.0 正式版（研发线内部编号 `0.6.0`）：行为预设 + 上下文"完全不处理"开放选项 + thinkflow 覆盖核验缺口补齐（changes/security/conversation）+ DSH 标准/PTC 适配面完善。**

本轮在 0.6.0-beta 基础上做四件事：
① 控制面板加 5 套行为预设（省token/均衡/长任务/原样/无限制），可应用、可逐项修改（改后标记"自定义"）；
② 上下文加"完全不处理"开放选项（contextRaw）：压缩/折叠/段丢弃/去重抑制/读取与回灌截断全停，内容原样进请求；
③ 独立覆盖核验（47 模块逐条对照上游源码）发现的实质缺口全部补齐：守卫式回滚与快照回执、默认密钥保护、request:N 别名补登记；
④ 桌面控制页补齐开关/预设 POST 面与宿主 preset 名册展示（DSH 标准/PTC 适配）。

### Added

- **行为预设（`kernel/presets.ts`）**：`light/balanced/deep`（= 参考档位数值面）、`raw`（清空上限 + 原样档）、
  `unlimited`（清空上限，插件初始行为面）。应用 = 整组替换 limits + 设置开关 + 落盘标记；
  终端 `p` 循环、CLI `dsh-stream-agent preset [id]`、桌面页预设卡片、装配 `config.preset` /
  env `STREAM_AGENT_PRESET`（展开为该层 limits 基值，显式 limits 压过预设）。
  任何手工修改 limits/开关 → 标记清为"自定义"；通道/档位切换不清标记。
- **上下文"完全不处理"（`contextRaw`，默认关）**：终端 `x`、CLI `raw on|off|toggle`、桌面页开关、
  装配 `config.contextRaw` / env `STREAM_AGENT_CONTEXT_RAW`。开启时驱动器强制：
  `contextFold=false`、`spanLedger=false`、`effectElision=false`、`maxReadChars/readFeedbackLimit/
  nativeResultLimit/codeValueInjectLimit=0`。预算类 limits 仍生效（那是预算，不是内容处理）。
- **变更回执与守卫式回滚（`kernel/change-store.ts`，对齐 [TF]/changes.py:157-272）**：
  tf-write/tf-edit/tf-append 成功后登记私有回执（before/after 快照 + sha256，持久化在
  `stateDir/changes/<session>/`，模型输入之外）；新命令 `tf-changes`（目录）/`tf-diff`（快照补丁）/
  `tf-revert`（expected 双重校验 + 原子写回 + undo 回执）。快照可用性判定与 TF 同口径
  （超大/二进制/敏感内容只存元数据）；新建文件不可回滚删除。命令表 14 → 17（ADR-002，§8.1 流程）；
  模型可见语法在**可选协议段 v15**（默认不进装配，金样逐字节不变）。
- **默认密钥保护（`kernel/security.ts`，对齐 [TF]/security.py）**：tf-read 拒读 `.env/*.pem/*.key/
  id_rsa/.npmrc/credentials.json/secrets.*` 等 15 类 basename 模式（结构化失败 `[secret]` + 装配级出路）；
  模型可见输出在 obs 登记前脱敏（`api_key/token/secret/password/...` 赋值 → `[REDACTED]`，
  句柄存储/全文回灌/recall 取回继承）。回退点：`allowSensitivePaths: true` / `redactOutput: false`。
- **request:N 别名补登记（conversation 缺口）**：任务起点原文经 `obs.registerRequestText` 句柄化
  （独立登记口，不进工具观测度量）；段边界丢弃段同步登记别名。此前仅压缩路径登记，
  未压缩回合 `tf-peek handle="request:N"` 解析为空。
- **桌面控制页开关/预设面（ui/index.js + ui/client.js）**：POST 增 `preset` / `contextFold` /
  `finalCheck` / `contextRaw`（runtime.applyPreset / setSwitches；降级分支同样不丢开关与预设）；
  ④ 行为开关区块（代码通道验收闸置灰）+ 宿主 agent preset 名册只读展示（DSH 标准/PTC 适配指引）。
- **`setLimits` replace 语义**：运行期层整组替换（预设应用与桌面页"整组替换"同一口径）。

### Changed

- `control.json` schema 升 **5**（新增 `contextRaw` / `preset`；v3/v4 文件读入回默认，写回保留未知字段）。
- `controlStatus()` 增 `contextRaw/contextRawSource/preset/presetSource/presets`；
  `effectiveParams()` 增 `contextFold/contextRaw/spanLedger` 生效面。
- 命令表硬上限 14 → 17（check-consistency 检查 5 引用 ADR-002）；README/PROTOCOL-v1 命令表同步。
- porting-matrix 更正：text_filter 映射证据（parser 围栏状态机，非 gate.ts）、changes §9 旧声明
  （"唯一缺 diffstat"与上游事实不符）、security/output_capture 整体豁免对脱敏子功能不成立。

### Fixed

- 降级分支/单字段写盘不再丢失 contextRaw/preset（与 0.5.3 的 limits/开关丢失同一类坑）。
- `tf-changes/tf-diff/tf-revert` 结果进 need_result 回灌通道（此前插件侧命令 output 无注入路径）。
- **收口维护（0.6.0 复查轮）**：`test/v060-security.test.ts` 整文件解析失败修复——tools 端口块
  损坏 + 未定义引用，11 个安全用例自入库起从未运行；按 DriverPorts 契约重建端口块后全部通过。
- **收口维护**：`STREAM_AGENT_MODE`（旧模式别名）在无 `control.json` 的全新安装下被静默忽略
  （source='default' 不走别名映射）——现在同样映射并记告警；显式 `STREAM_AGENT_CHANNEL` 仍压过
  mode；file 来源行为不变（回归用例在位）。
- **收口维护**：工具面守卫——tf- 保留前缀被外部工具占用的检测结果此前算完即焚（`degraded` 被
  显式抹掉、全仓无消费点）；现在作为第 4 级降级 `reserved` 结构化暴露（状态 / 台账 / 中英文案），
  fail-open 照常透传，干净面不受影响（回归用例在位）。
- **收口维护（轻微）**：control-bar 文案表补 `mode` 键（CLI `mode` 命令标签此前靠兜底显示键名）。
- **收口维护（独立审查轮，loop.ts 0.6.0 面）**：
  - **预设 replace 对当前会话不生效**：`setLimits(replace)` 只清 session 层，global 层构造期
    固化的旧 control.limits 继续生效——raw/unlimited 预设应用后当前会话仍被旧上限硬杀。
    现在 replace 重置 global 层的用户部分（control.json 物化值），装配层（新 `assemblyLimits`
    传入）保留，"装配 > 面板"层级不因预设破坏。
  - **applyPreset 半套应用**：开关被 config/env 锁定时只挡了 limits 锁定——limits 已替换落盘、
    开关被拒、preset 标记照常落盘（混合状态）。现在任一开关锁定 → 整体拒绝，保持原子性。
  - **tf-changes path 过滤基准分裂**：过滤左侧回执存的相对路径被 resolve 到 process.cwd() 基准，
    projectDir ≠ cwd 时 `tf-changes path=` 恒返回空目录（回执明明存在）。两侧统一 fileRoot 基准。
  - **CLI 手工改上限不清预设标记**：`updatePersistedLimits` 把 preset 原样写回，与 presets.ts
    "手工修改 → 自定义"契约及进程内路径不一致。已对齐（清标记）。
  - **tf-peek stale 守卫与内容源不对齐**：多句柄候选（request:N 段句柄）下守卫"任一新鲜即放行"，
    正文却固定取第一个候选——第一个候选 stale 时旧文无标注返回。守卫改为返回新鲜候选集，
    全部取回点（行段/offset/query/symbol）从新鲜候选取正文（PE-3 fail-closed 承诺恢复）。
  - **loadChangeReceipts 整批中断**：一个形状不全的回执文件（workspace/snapshots 类型错）抛
    TypeError 中止整批加载。改为逐条 try，坏条 rejected 计数、好条照常加载。
  - **工具声明截断先于排序**：两处 `schemas.slice(0, N)` 按宿主数组顺序截断，assembly.ts
    "按名字典序排序 + 截断"契约被架空；宿主顺序不稳定时 plan 模式声明面漂移。先排序再截断。
  - **source 类型契约滞后**：contextFold/finalCheck/contextRaw/preset 四个 source 联合类型缺
    `'runtime'`（运行期写入值，type-stripping 不报错直通展示层）。已补齐。
- **收口维护（独立审查轮，kernel 解析/观测/渲染面）**：
  - **围栏开启判定只看 chunk 开头（P1，已复现验证）**：单 chunk"正文 + 围栏 + 命令"时
    `<` 之前的围栏开启行被当正文吞掉、围栏从未开启、其中 `<tf-*>` 被真实派发——且行为随
    feed 分块粒度漂移。stepGround 现在在 tag 分派前对前缀完整行扫围栏开启行
    （`#scanFenceOpenPrefix`），行级判定复用 matchFenceOpen。
  - **围栏闭合行允许混合标记字符（P2，已复现验证）**：`` ```~~~ `` 整行被 [`~]+ 一次吃掉
    判闭合，围栏提前关闭、其后命令失去保护。闭合行标记串现在逐字符校验与开启字符一致
    （CommonMark 规则）。
  - **行内代码状态使用陈旧值（P3，已复现验证）**：同 chunk 中反引号与 `<` 相邻时状态未
    推进（只反映已 emit 文本），示例命令被执行——与 F1 拆 chunk 行为互相矛盾（不确定性
    缺陷）。现在按"当前位置"计算行内反引号奇偶；F6 旧断言（0.5.1 旧行为化石）已同步更新。
  - **数字实体码点越界抛 RangeError（P4，已复现验证）**：`&#x110000;` 等使 feed() 崩溃、
    整条流中断。越界/代理区间引用原样保留（不还原、不崩溃）。
  - **中文符号定位恒失败（O1，已复现验证）**：`\b` 只在 ASCII 词字符边界成立，纯中文
    symbol 的 `tf-peek symbol=` 100% 返回 unknown-symbol。改用显式 lookaround（两侧不得是
    ASCII 词字符），ASCII 符号语义不变、中文符号可命中。
  - **queryCandidates 违反"绝不返回空"契约（O2）**：第一条即超 maxChars 预算时返回 []。
    现在至少保留一条（裁剪到预算内）。
  - **freezeDynamics 对空串动态值误抛（R1）**：`''.includes('') === true` 使空值字段误判
    "动态内容进入稳定前缀"，合法装配中断。空值跳过判定。

### 验证

- `npm test` → **612 用例 / 611 通过 / 0 失败 / 1 跳过**（v060-security 11 用例恢复运行；
  新增回归 v060-fixes 6 用例：预设 replace 生效面、CLI 清预设标记、tf-changes 路径过滤、
  畸形回执逐条拒绝）。
- `npm run check` → 7/7；`npm run gate -- --offline` → 3/3；`npm run build` → 39 文件（src↔dist 一致）。
- 覆盖核验（独立只读子智能体）：47 模块 = 插件实现 19 + 宿主提供 23 + 豁免成立 3 + 缺口 2（本轮已补齐）。
- **仍待真机**：tf-revert 写回是否需经宿主工具管线（limitations §七 #21）；RA-0 宿主侧复核；§4.6 API 指标。

## [0.6.0-beta] - 2026-11-25

**0.6.0-beta：行为开关落地（§0 A1–A5）+ TF-PEEK 取回质量（PE-1～PE-4）+ RA-0 探针 + 请求装配契约（RA-1～RA-5）。**

五件事：
① `contextFold` / `finalCheck` 两个用户开关在位，落盘 schema 升 4，控制面板/桌面页/状态面同源；
② 前缀 fail-closed 后**同轮自动续跑**（每回合 ≤2 次），零产出也写事实消息，账本可复算；
③ TF-PEEK 四项：query 未命中给 top-3 候选、行锚间隔可配、句柄 `[stale]` 识别、预算文案含剩余额度；
④ RA-0 六项接缝探针 + `eval/runs/ra0/*` 产物（结论作用域如实标注 `plugin-seam`）；
⑤ `AssemblyPlan` 契约与 plan 模式（纯函数投影 / 载荷去重 / 工具惰性声明 / 预算 fail-closed / 自动回退）。

### Added

- **`contextFold` 总开关（§0 A1，默认开）**：`false` 强制 `surfaceCompaction=false`、
  `effectElisionKeepRecent=0`、`segmentMaxChars=0`（旧内容一律不移出请求）；`true` 沿用用户 limits。
  面板摘要按**有效状态**渲染：开启但三个阈值都未设时显式写"已开启，未设阈值，不触发"。
  终端 `f` 键、CLI `dsh-stream-agent fold on|off|toggle`、装配 config 三处同源（桌面控制页本轮只做上限编辑）。
- **`finalCheck` 独立开关（§0 A2，默认开）**：只控制 `tf-final` 要求、`accepts` 判定、
  premature-final 拦截、收束 nudge；`false` 时 `tf-plan` 仍解析。代码通道下控制面**灰显**
  （"代码通道无验收闸，不生效"），不让开关看起来已生效。
- **同轮自动续跑（§0 A4）**：前缀 fail-closed 后不再要求用户再发消息——记账 + `renderer.rebase()`
  + 清空 wire 基线 + 注入 `[tf-stream:prefix-recovered]` 事实块，同一回合发下一条请求；
  每回合最多 2 次（`MAX_PREFIX_AUTO_CONTINUES`），可用 `autoContinueOnPrefixFail: false` 回退。
- **续跑账本与状态面（§0 A5）**：`prefix-auto-continue`（turn/step/attempt/cause/maxAttempts）与
  `prefix-auto-exhausted` 落 `plugin:tf-agent/fault`；`runtimeStatus().prefixAuto` 暴露
  `attempts / max / remaining / enabled`。
- **TF-PEEK PE-1**：`tf-peek query=` 未命中返回 top-3 候选行段（行号 + 首行，按查询词命中数排序，
  整条响应 ≤2,000 字符）；零命中也有候选（如实标注"无查询词命中，文件头部行"），不再只能盲试。
- **TF-PEEK PE-2**：`limits.peekAnchorEvery`（行锚间隔，未设 = 200 保持 0.5.0 行为；可设 100）；
  索引降级形态增加硬上限（≤2,000 字符，超出按锚截断 + 省略说明）。
- **TF-PEEK PE-3**：`tf-read` 登记 `handle → {path, mtimeMs, size}`；`tf-peek` 前 stat 校验，
  文件变更返回 `[stale]` + 新 mtime/size + 重读建议，**不返回旧正文**（不静默替换）。
- **TF-PEEK PE-4**：预算拒绝文案统一为"已用 / 上限 / 剩余 + 建议窗口"；`[unchanged]` 只计命令数，
  不占正文预算（去重产物不该反过来惩罚自己）。
- **RA-0 探针（§2）**：`src/entry/ra0-probe.ts` + `eval/tools/ra0-probe.mjs`，六项（U1–U6）
  各跑 3 个连续请求，产物 `eval/runs/ra0/U*.json` + `summary.md`；结论只允许
  supported / unsupported / unknown，每条带 `文件:行` 证据，作用域固定 `plugin-seam`、
  `hostVerification=pending`。判定路线：`system-tools-only`（U5 不支持历史改写）。
- **`AssemblyPlan` 契约（§4.3/RA-1）**：`src/kernel/assembly.ts` 纯函数投影——块顺序固定
  `channel → protocol → tools → invariants → state`、`system.hash` 可外部复算、20 次投影逐字节一致；
  `reasoning` 显式策略；`budget` 带 `estimatedInputTokens/limit/overBy`。
- **载荷去重（RA-2，plan 模式生效）**：>2,000 字符载荷同 sha 在单请求内只保留一份，重复项降级为
  `[tf-payload ref=sha256:… chars=…]` 引用行（原文仍按句柄取回，不是摘要改写）。
- **工具惰性声明（RA-3，plan 模式生效）**：plan 模式首请求 `tools` 为空（`toolsChars=0`），后续声明名 ≤7；
  未列出的工具仍按名可调（声明面不是调用面）。
- **发送前预算（RA-4，plan 模式生效）**：`overBy > 0` 即 fail-closed——0 发送、`[budget]` 文案 + 贡献项
  （tokens/占比），台账 `assembly-budget` 可复算。
- **`assemblyPolicy: host|plan` + 自动回退（RA-5）**：默认 `host`（0.5.x 行为逐字节不变）；
  plan 投影异常或前缀断言失败 → 回退 host 并落 `assembly-fallback` 台账，回退后本会话固定 host。

### Changed

- `control.json` **schema 升 4**（新增 `contextFold` / `finalCheck`）；旧文件缺字段回默认 `true`，
  非法值丢弃并告警，写回保留未知字段（回滚兼容），优先级 config > env > file > default。
- `runtimeStatus()` 增 `prefixAuto` 与 `assembly` 两组状态；`controlStatus()` 增两个开关、
  来源字段、`finalCheckInert`（代码通道置灰）与 `switchSummary`（面板同源摘要行）。
- 段边界（F7）在丢弃旧段后补注 `[tf-stream:context-rebased]`——0.5.x 只在压缩路径注入，
  段边界静默重置与"记账 + 显式"纪律不一致。
- 零产出**前缀失败**收场也写事实消息（"没有产生交付"），其它零产出收场保持 0.3.3 语义（不伪造交付）。

### Fixed（收口轮：独立审查 → 修复）

- **`renderReadIndex` 降级顺序**：2000 字符硬上限此前只挤掉锚点体，已投递区间一多（实测 40 段）
  就把"索引 + 未投递区间"整段顶掉，读索引失去导航价值。改为：超限时**导航信息优先**
  （head → 索引 → 未投递区间 → 已投递末位并截断），已投递区间先合并再压缩成"最近 6 段"；
  未超限时输出字节与 0.5.0 完全一致。
- **`finalCheck=false` 的静态提示**：运行期闸门/nudge 已关，但 `DEFAULT_SYSTEM_PROMPT` /
  `DEFAULT_INVARIANTS` 仍要求 `tf-final`。新增 `DEFAULT_SYSTEM_PROMPT_NO_FINAL` /
  `DEFAULT_INVARIANTS_NO_FINAL` 两个变体，`composeChannelTexts` 按开关选择——开关关掉后
  模型侧也不该再被要求交一条它不该交的收尾。
- **写盘丢开关的剩余路径**：`ControlSession.reset()`（`r` 键）与 `applyLimits('reset')` 会重建
  状态对象、把 `contextFold/finalCheck` 丢掉；桌面页降级分支同样只写 channel/tier/lang。
  三处全部保留开关，并补三条回归用例（`A3-5` / 桌面页降级用例）。
- **`maxParallelToolCalls` 运行期不生效**：未进 `#applyLimitValues`（唯一落点），面板改它静默无效；
  补进落点，`effectiveParams()` 一并曝光（供状态面/断言）。
- **`budgetContributions` 口径**：一律 `chars/4` 会把中文长段低估 2–3 倍；改为与
  `estimatedInputTokens` 同一个 `estimateTokensRaw`（CJK 加权）。
- **peek 预算判定/记账口径**：判定看正文、记账看整块；统一为 `rec.output`（台账拆 `chars/bodyChars`）。
- **兜底文案**：`autoContinueOnPrefixFail=false` 时不再谎称"已尝试同轮自动续跑"。
- **面板摘要阈值**：`switchSummaryLine` 增 `effective` 参数，装配 config 设了阈值时不再误报"未触发"。
- **段边界 `dropAppendHead(0)`**：退化形态（无可丢块）不再追加 rebase 行（否则每回合 +1 行、永远压不下去）。
- **换基失败留痕**：`#tryPrefixAutoContinue` 的 rebase 异常此前只打日志，现落 `prefix-auto-rebase-failed` 台账。
- **测试加固**：A2 扩到 2×2 各 5 回合 + 静态提示断言；A1 补 4 组合；A4 补零产出事实消息（`finals` 捕获）
  与 `awaiting:user` 显式判定；RA-1b 补"0 前缀违规"断言与预算独立复算；RA-2c 补引用行/原文长度；
  RA-3b 补端到端 `tf-call` 调未声明工具；PE-1c 补驱动端响应 ≤2000；PE-4a 改为按记录数断言。
- `docs/limitations.md` 增 RA-0 段（#18–#20）：U5 不支持、U3 unknown、全部结论待宿主复核。
- 旧用例按新契约同步：schema 断言 3→4；v0.4.3 前缀收场面显式 `autoContinueOnPrefixFail: false`
  （钉 0.4.3 语义，续跑行为由 `v060-switches` 覆盖）。

## [0.5.3-beta] - 2026-11-24

**0.5.3-beta：把"上限"真正交到控制面板 + 0.5.2 遗留缺陷复查修复。**

四件事：
① 控制面板（终端交互栏 + 桌面控制页）新增 **③ 用户上限** 编辑区——23 个上限键的唯一定义入口；
② 去掉最后两个插件预设（`stallReentries=6` / `closeOutRequests=2`），收敛改为**结构性**判据；
③ 修复 0.5.2 引入/遗留的 4 个真缺陷（无界重入、两处运行时 ReferenceError、降级分支抹掉 limits）；
④ b 通道补 `sandbox_permissions`/`justification` 单次提权（新增可选 v14 协议段）。

### Fixed

- **P0 无界重入（0.5.2 引入）**：`premature-final` 只有 ③④ 内容面（占位/过期）做了去重，
  ①② 面（依赖未满足/命令未完成/计划验收未验证）每次都重新注入。此前靠 `stallReentries` 缺省 6
  兜住；上限交给用户（0 = 不限制）后立刻退化成无限重入——实测请求数无界增长、回合永不收敛
  （`V1.3-1/2/3` 三例挂起，`node --test` 报 `test timed out`）。修复：`#prematureInjected`
  按"拒绝事由键 + 注入时的生产性 ok 计数"记账，同一事由且零新增产出 → 不重复注入、本步收场
  `blocked`（新台账 `final-reject-exhausted`）；模型做了新工作则照常重新提示。
- **P0 两处运行时 ReferenceError（0.5.2 引入）**：① `tf-code` 释放分支写成 `await runtime(owner)`，
  `owner` 从未在该作用域声明——ReferenceError 被 catch 吞成 `release-failed`，`release="true"`
  永远释放不了宿主保留态；改为 `runtime(known.owner)`。② 装配处调用不存在的
  `createHostVerificationRunner(tools)`——真实实现是驱动器私有 `#hostVerificationRunner()`；
  改为不注入（走驱动器自带实现），避免"装了 ctx.tools 就崩"。
  （两处均由自建作用域扫描器 `scratch/scopecheck.mjs` 在纯类型擦除构建中抓出；`npm run build`
  不做类型检查，这类错误只在运行时炸。）
- **P0 控制面板改上限会丢配置（0.5.2 引入）**：`applyChannel`/`applyTier`/`applyLang` 各自只写
  三个字段，改一次通道就把用户 `limits` 从 control.json 抹掉；桌面页降级分支同样只写
  channel/tier/lang。修复：统一 `persistControlState()`（通道/档位/语言/limits 一起写）；
  UI 降级分支把生效 limits 一并带上（`desktop-ui.test.ts` 有回归用例）。
- **P1 上限只在部分键上生效**：`setLimits` 之前只落 7 个键，其余 16 个静默不生效。修复：
  新增私有 `#applyLimitValues(values)` 作为**唯一**落点（18 个 driver 字段 + `codeQuota`），
  构造期、`setLimits`、档位切换、通道切换四处共用。

### Added

- **控制面板 ③ 用户上限**（终端）：`renderPanel` 新增区块 C（未设时显式打印"全部未设（不限制）"）；
  `u` 键进入行内编辑，键入 `key=value`（`;` 分隔多项，`reset` 清空）回车生效并落盘；`Esc` 取消、
  非法键/负数当场拒绝且不落盘；`r` 重置会把上限一起清空（初始状态 = 一项上限都没有）。
- **控制面板 ③ 用户上限**（桌面页）：`ui/client.js` 新增 `LimitsEditor`——按 6 个分组渲染 23 个
  数字输入框（空 = 未设 = 不限制），"写入上限 / 清空"两个动作，提交面
  `{limits:{k:v}, limitsReplace:true}`；`ui/index.js` 路由校验走内核 `sanitizeLimitPatch`，
  未知键/非整数/负数 → 400，部分键被忽略时在 `warnings` 里回报。
- **b 通道单次提权**：`tf-code` 新增 `sandbox_permissions` + `justification`（成对校验、白名单
  `workspace-write|danger-full-access`、经宿主 `dsh-sandbox` 的 `approveEscalation` 审批、只覆盖
  本次执行、提权时忽略 `stateOwner`）；无策略/无审批服务 → `escalation-unavailable`，拒绝 →
  `escalation-denied`。新增可选协议段 **v14**（默认不进装配，金样逐字节不变）。
- `controlStatus()` 增 `limits` / `limitsSource` / `limitCatalog`（23 键结构化投影），
  `streamAgentRuntime` 增 `setLimits(patch, {replace})` 服务方法。
- 收束期按**撞墙事由**去重（`steps:<原因>` / `stall` / `no-final`）：未设 `closeOutRequests`
  时同一事由只收束一次，不再靠缺省 2 次。

### Changed

- 缺省值收敛到"零预设"：`stallReentries` 6 → 未设（不限制）、`closeOutRequests` 2 → 未设
  （按事由去重）。`K4` 用例随之把请求数从 3 降到 2（去重命中即收场，不再补一条同义 nudge）。
- 协议版本表新增 **v1.4.0（0.5.3-beta）**；`PROTOCOL_SECTION_IDS` 仍 11 项（8 + v11/v12/v14）。
- `docs/limits.md` 新增 §7「不预设上限如何保证不无限打转」：把结构性出口写成可核对的表。

### Tests

`npm test` → 522 用例 / 521 通过 / 1 跳过 / 0 失败（新增 `C1–C3` 控制栏上限编辑、
4 条桌面路由 limits 用例、`K4` 语义更新）。`npm run build` 34 文件、`npm run check` 7/7 全绿。

---

## [0.5.2-beta] - 2026-11-23

**0.5.2-beta：上限全部交给用户 + PTC 契约对齐复核 + thinkflow 缺口补齐。**

两条主线：
① **插件不再预设任何会截断工作的上限**（轮数/token/取回/压缩/换基/重入/tf-code 配额一律用户定义，
未定义 = 不限制），档位降级为"参考数值展示"，新增 `limits` 子命令与三层来源合并；
② 按宿主真实契约复核 b 通道（PTC bridge）与 thinkflow 47 模块覆盖，修复审计确认的
15 项契约不符与 10 项装配缺口。

### Added

- **`limits` 内核与三层来源（新模块 `src/kernel/limits.ts`）**：23 个键、别名归一、
  非法规格丢弃并告警；来源优先级 `control.json < STREAM_AGENT_LIMITS < config.limits`，
  再叠 `limitsByChannel` / `limitsByTier` / 运行期 `setLimits`。`0` = 不限制，
  换基计数用 `-1` = 不限制（`0` 是"禁止换基"）。详见 `docs/limits.md`。
- **`dsh-stream-agent limits` 子命令**：无参列出全部键与当前值；`--json`；
  `--set k=v[,k=v]`（增量）；`--replace`（整体替换）；`--reset`（清空）。
- **`control.json` schema 3**：持久化 `limits` 字段，坏值告警不静默；新增
  `updatePersistedLimits()` 读-合并-写。
- **PTC 运行时描述符消费**：`language` / `programFormat` / `sandboxMode` / `retainsState` /
  `timeout` / `executionInstructions` 进协议段（宿主运行时事实）与状态面
  （`runtimeStatus().ptc`）；`language` 非 TS/JS 时关闭 code 通道并告警。
- **`receipt:N` 引用空间**：写后读回执带 `receipt=N`，可用 `tf-peek handle="receipt:N"` 复读。
- **审计字段**：`runtimeStatus().limits`（用户上限原样投影）、`ptc`（运行时描述符）、
  tf-code 失败注入携带 `logsChars`。

### Changed

- **档位不再预设上限**：`light/standard/deep` 的 `values` 全为 0（未设），原 16/24/40
  移入 `reference`（只展示、不生效）。控制栏数值行改为"生效值 + 参考值"。
- **0 = 不限制统一语义**：`maxReadChars` / `nativeResultLimit` / `segmentMaxChars` /
  `codeValueInjectLimit` / `effectElisionKeepRecent` / `readFeedbackBudgetPerRequest`
  不再回落到 `DEFAULT_*` 常量（常量保留为文档参考值）。
- **tf-code 输出体裁对齐宿主**：一次运行的结果按 `{logs, sandbox, result}` 并列注入
  （`logs:` 段 + `result:` 段）；失败不再把 logs 截到 200 字符——程序自己打印的诊断可见。
- **失败反馈不再硬截断**：`rec.detail` 上限从 800 字符放开（`[tf-stream:error]` 注入
  原本就不截断，问题在被截断的源头）。
- **token 估算口径**：ASCII 仍 4 字符/token，CJK 按 0.7 token/字符（旧口径把汉字也按
  4 字符/token 计，中文会话触顶判定晚 ~2.8 倍）；原生通道 `tools` schema 字节计入。
- **`query` 未命中不再算命令失败**：改为正常结果正文（原先走 `[tf-stream:error]` 通道，
  被当成执行错误计账并触发重入判定）。
- **tf-edit 兼容上游 body 形态**：三行标记与 `<old>…</old><new>…</new>` 均可；
  `match="file"` 不再被当未知属性丢弃。
- **tf-code 配额默认交给宿主**：`codeQuota` 由 64 次/256KiB/300s 改为 0（不限制），
  墙钟跟随 `runtime.timeout.maxMs`；用户可用 `codeMax*` 收紧。
- **装配样例不再预置上限**：`preset.yml` 删掉 `maxParallelToolCalls: 3`，改为 `limits` 注释示例
  （写文件仍按同流先写后读隐式串行，并发只影响读/搜索类命令的批量派发）。

### Fixed

- **控制栏把"不限制"显示成"上限 0"**：档位 `values` 归零后，控制页仍拿 `tier.values` 渲染
  生效值 → 档位卡出现 `maxSteps 0 · maxInputTokens 0k`，降级视图也把 0 当上限。
  现 `runtimeStatus().effective` 扩为 7 键、由运行时按 cfg 如实报账；`0` 一律渲染为
  「不限」，档位卡改摆 `tier.reference` 并标注「参考值（未生效）」，降级视图改由用户
  `limits` 推导（不再用档位顶替）。
- **控制页其余 5 项恒为 "—"**：`effective` 原先只投影 `maxSteps` / `maxInputTokens`，
  `peekBudgetChars` / `keepRecent` / `maxSummaryChars` / `compactAggressiveness` /
  `surfacePolicy` 永远取不到值。已随上条一并修复，并新增 `effectiveParams()`。
- **`sandbox.denied` 恒丢失**：宿主契约是 boolean，0.5.1 按数组解析（`length>0`）→ 恒 false。
  改为布尔直读，账本 `denied` 字段与 `sandboxLine()` 渲染同步修正。
- **`subCallId` 撞 id**：改为宿主规则 `<parentCallId>:ptc:<提交序号>`（原用工具名，
  同一程序里多次调用同一工具会重复）。
- **子调用审计串账**：单槽 `let dispatchSink` → `WeakMap<agent, driver>`；删除
  "构造期事件由缓冲兜住"的错误注释（从未有缓冲）。
- **exclusive lane 缺失**：非只读绑定与 `parallel` 并发派发；现按宿主
  `executionMode` 语义分 lane（exclusive 屏障 + fail-closed 默认独占）。
- **无 abort + drain**：收束期只 abort 不等在飞调用；现 `finally { abort(); await drain(); }`
  拒绝排队者并等待在飞绑定结算，`runOver()` 守卫避免迟到派发。
- **生产装配只 3 绑定**：`createCodeExecutor` 未传 `surfaceToolNames` → tf-code 程序只能
  看 write/read/pwsh；现按会话冻结工具面生成全绑定，`maxParallelBindings`/`classifyBinding`/
  `onDescriptor` 一并接线。
- **`revisionFacts` / `deliveryFacts` 从未装配**：版本冲突守卫不可达、`:: exists(...)` 谓词
  永不开、带谓词的验收项永远 verified 不了（final 被卡到重入上限）。现默认装配
  （fs 只读事实），`revisionGuard: false` / 显式端口可覆盖。
- **新建文件被守卫拦死**：`revisionFacts` 在位后，对**不存在**的文件缺少读观察会判
  `read_required`；改为"目标不存在 + 无读观察 = 新建，放行"。
- **交付构建校验恒失败**：兜底实现硬编码 `bash + {cmd}`（DSH 没有该工具）→ 只要项目有
  `package.json` 每次收束都 blocked。现经 `toolMapping` 转成宿主 shell 调用
  （`tf-bash → pwsh{command,description}`），失败正文放宽到 4000 字符。
- **可运行脚本清单恒空**：`!name.includes('.')` 与扩展名判据互斥 → 永远筛不出脚本；
  已修，且清单改为**注入上下文**（此前只写台账，模型看不到）。
- **`stateOwner` 跨策略复用**：沙箱策略变化后仍复用同一 owner（旧内存 + 新更宽策略）；
  现策略变化即作废旧身份并记账。
- **`#codeStateOwners` 只增不减**：会话结束无人释放宿主保留态；新增
  `driver.dispose()` 逐个 `release`，由 agent dispose 调用。
- **`sandboxPolicy` 只传 mode**：丢会话级策略（可用比会话约定更宽的沙箱）；改为
  `resolve({session, mode})`，仅接受白名单三值，`resolve` 失败告警并不传（fail-open，
  不静默降级为更宽策略）。
- **bash 成功输出不可见**：`bash` 在低增益回执族，成功只记 ledger → 模型跑完
  `npm test` / `git status` 看不到任何内容。改为高增益族（首次/变化 full，重复 dedup）。
- **行内反引号未隔离**：`` `<tf-read .../>` `` 这类示例文本会被当命令执行；现按行内代码
  边界（奇偶反引号、遇换行重置）隔离，围栏隔离不变。
- **`maxParallelBindings` 不可运行期调整**：deps 接受数字，改为 `number | (() => number)`。

### Docs

- 新增 `docs/limits.md`（23 键全表 / 三层来源 / 迁移自查）。
- `docs/channel-matrix.md` 删除"配额 2048 次"（无出处，宿主实为 `maxPendingCalls` 128）。
- `docs/limitations.md`：修正配额缺省值；补"已知未做"清单（plan 跨 resume 持久化、
  沙箱模式切换中止在跑程序、`receipt:N` 仅覆盖自写回执）。

## [0.5.1-beta] - 2026-11-23

**0.5.1-beta：按 `0.5.1-beta.txt` 清单落地的第一批（M1 收尾 + M2 解析/回灌）。**
本版只实现清单里"约束完整、可离线验证"的条目；其余条目（P0 真机门禁、协议加语法项、
宿主能力依赖项）按下述"未纳入本版"保留，不引入清单未授权的行为。

### Added

- **围栏状态机（清单 2.1，P0）**：`parser.ts` 在 ground 模式按行首开启围栏（反引号 / 波浪线，
  ≥3 个标记字符并同类闭合，0–3 空格缩进，闭合行长度 ≥ 开启行，未闭合延续到流末）。围栏内 `<tf-*>` 只作散文，
  **0 执行 / 0 副作用 / 正文逐字节保留**；命令正文里的围栏标记不改变状态。
- **思考通道协议违规可见（清单 2.1）**：`reasoning-delta` 命中 `<tf-`（含跨 chunk）记
  `protocol-error:reasoning-channel` 台账，并在下一请求注入一次纠正——思考通道不解析命令，
  但不再静默丢弃。
- **`TurnEndReason` 增 `awaiting:user`（清单 1.1）**：`tf-ask` 返回宿主 timed ask 的
  `{pending:true}` 时，回合以 `awaiting:user` 收束（0 nudge / 0 额外请求），不再被当成未完成收尾。
- **配置 `requireFinal`（清单 1.1 回退开关）**：`false`（默认）= 无验收项且有生产性产出时
  流末正文即交付；`true` = 0.4.x 旧语义（流末无 `tf-final` 必 nudge）。装配级
  `requireFinal: true` 可逐字节回到旧收束行为。

### Changed

- **回合收尾（清单 1.1，P1）**：取消"流末无 `tf-final` 必 nudge"。标准通道下，若本回合
  无未验证验收项、无重入事由、无 final 被拒、且至少有一条生产性 ok 命令，则流末正文
  直接作为交付（同轮、0 额外请求）。零产出回合仍走 nudge/blocked（不伪造交付）；
  有验收项时仍按验收闸提示。
- **验收证据绑定（清单 1.3，P1）**：证据字符串改为 `cmdId@<验收项文本哈希>(handle=… fp=…)`。
  计划修订改了验收项文本 ⇒ 旧证据作废（记 `plan-evidence-invalidated`，条目回到未验证）；
  非 ok 回执不产生验证（`plan-accept-not-ok`）；`accepts` 指向不存在的验收项记
  `plan-accept-unknown` 台账。**"单个 in_progress"未实现**——见下方未纳入项。
- **回灌方向与三档命名（清单 2.2，P1）**：`info_gain` 三档由 `high/low/none` 改为
  `full/dedup/handle`，与 request 记录的 `feedbackBytes{full,dedup,handle}` 逐字一致；
  `selfReadFeedback` 默认由 `receipt` 改为 `full`（写后读回灌全文，`receipt` 保留为回退点）；
  dedup 桶接线（`[unchanged]` / 部分重叠 / 效果折叠行），peek 命中已投递区间记 dedup。

### Docs

- PROTOCOL-v1 §7/§8：围栏语义与 0.5.1 变更记录（明确未新增命令/属性，命令表仍 14 条）。
- 文档口径同步：README.md / README.en.md（用例数 481、`selfReadFeedback` 默认 `full`、`tf-read` 行、
  `tf-final` 同轮交付）、docs/protocol.md（O7 自写回验）、docs/architecture.md 与
  docs/upstream-delta.md（三档命名）、docs/limitations.md（0.5.1 回摆如实记录）。

## [v1.2.0] - 2026-11-23（b 通道 PTC 对齐，审查修正版）

按宿主真实契约（ptc-runtime/types.ts:76-110 + index.ts:126-138）对齐 b 通道，审查后修正三处"名字像但不兼容"：

- `tf-code` 加 `state` / `sandbox` / `release` / `format` 属性；仅 `stateOwner` / `sandboxPolicy` 进 resolve，`errorClass` 进 bindings namespace（`memberNameProperty` 必填），`release` 为 runtime async 方法，`format` 不伪装为已对齐（执行形态由宿主 `programFormat` getter 决定）。
- 装配两个端到端端口：`resolveSandboxPolicy`（宿主注入策略对象，插件不自行构造）与 `ptcRuntimeRelease`（默认从 `ptcRuntime.release` 桥接）。release 只释放不执行程序体；未建立状态域判 `state-not-found`；异步失败可诊断且不丢身份映射。
- 新增可选 v12 协议段，桥接通道显式开启可达（金样逐字节不变）。
- 子调用审计只写插件私有 ledger（让位纪律：不冒充宿主 `tool/ptc-dispatch` 事件）。
- 新测试 `test/v120-ptc-align.test.ts`（6 例，按宿主真实契约断言）；500 用例（499 pass + 1 预置跳过 / 0 fail）、check 7/7。
- 第 3 轮：`recallText` 对齐上游 query 上下文窗口（回退 ≤200 字符 + 行首对齐 + 行尾截断 + 续搜锚点）；1.2 交付构建校验端到端接线（`buildVerificationPlan` → `runVerification` → final 闸，`projectFacts`/`projectDir` 生产转发，失败持久到任务结束防重发绕过）；`errorClass` 生产赋值；全部取回路径预算耗尽发 `[budget]`。新测试 `test/v110-kernel.test.ts` 增至 13 例。

## [v1.1.0] - 2026-11-23（本轮，未提交）

> 解除清单 A10 阻塞：PROTOCOL-v1 §8.1 定义"加语法评审流程"（规范先行 → 内核纯函数 → 测试向量 → 变更记录 → 双通道声明）。按该流程落地 1.2 / 1.3 / 2.3 / 4.1。

### Added

- **1.2 验收机器判定**：新 `src/kernel/delivery.ts`（零依赖纯函数）——`tf-plan` 验收项尾部 `:: exists|sha256|bytes|regex(...)` 在收束前用注入的 `deliveryFacts.stat` 求值，通过即 verified，失败列原因并拒绝 final；`buildVerificationPlan`/`scriptFeedback` 对齐 `[TF]/delivery.py`（待宿主 `runVerification` 端口接线后启用）。
- **1.3 单个活动项**：`tf-plan` 的 `> [id]` 声明唯一活动项（对齐上游单个 `in_progress`），重复记 `plan-active-duplicate` fault。
- **2.3 字符级取回**：`tf-peek` 增 `offset`/`query`（对齐 `[TF]/recall.py`），新 `ObservationLedger.recallText`，带 `next offset=N` 续搜提示；负 offset/预算耗尽 fail-closed；计入 peek 度量。
- **4.1 文件版本守卫**：新 `src/kernel/changes.ts`（对齐 `[TF]/executor.py:469`），`tf-read` 登记读观察、`tf-edit/append` 派发前检查 `read_required`/`revision_conflict`；`tf-edit` 增 `offset` 属性声明目标行。写后只推进 revision 与平移区间，不升级授权范围。
- 新测试 `test/v110-kernel.test.ts`（现 13 用例，含反例与边界；v1.1.0 另加可选 v11 协议段——模型可见语法，默认不进装配以保证缓存零回归）。

### 未纳入本版（清单条目与阻塞原因）

- **7.1（P0）四臂真机 L0–L3**：缺 `DEEPSEEK_API_KEY` 与宿主真机环境，`eval/runs/four-arm-*.json`
  无法产出；G5/G6 真机项仍未勾选，**不得据此宣称"正式版"**。
- **3.1 / 3.2 / 3.3（b 通道 PTC 对齐）**：`state/format`/`sandboxPolicy`/dispatch 事件依赖宿主 PTC 版本 conformance 与配额口径冲突（A3），尚未施工。
- **2.4 / 3.2 / 3.3 / 3.4 / 5.x / 6.1 / 7.2 / 7.3**：分别依赖二选一决策、宿主 guard/凭据
  管线、PTC 配额口径冲突（A3）、宿主 rc.3 挂点实测（A4）、`[TF]` session/executor 参考实现
  或真机演练；本轮不实现。

## [0.5.0-beta] - 2026-11-22

**0.5.0 研发线起点：单插件双通道与正式版。** 一个插件包，一个装载形态；原设想拆两包的两部分能力
改为同一控制栏上的两个区块（执行通道 × 上下文档位）。发布判据：架构定稿、有对照数据、
可逐项回退（数据面见 eval/FOUR-ARM-2026-11-22.md；真机臂完成前不给出省 token 结论）。

### Breaking

- **配置键破坏性变更**：四档模式（balanced / lean / compat / power）删除，拆为两轴——
  `channel`（standard | code）× `tier`（light | standard | deep）。旧 `mode` 值走
  LEGACY_MODE_ALIAS 别名映射（读旧配置输出一行 warn），保留一个 minor，**0.6.0 移除**；
  control.json 迁移为 {channel, tier, lang}（schema 2），旧 mode 字段按反向别名保留一个
  minor 供回滚。
- **`toolSurface: 'off'` 档删除**（D2 修复）：它曾把第三方工具砍到完全不可达；工具面策略
  走 `surfacePolicy`（默认 `reserved-only` = 只管 tf-* 前缀、其余透传——对第三方工具
  零影响）。`profile` 档（0.4.x 过滤行为）已弃用，仅回退演练保留；`CORE_TOOLS` 白名单
  不再随默认档位生效（D3 修复）。
- **默认值变更**：`readFeedbackLimit` 缺省 8000 → **0**（回灌侧不截断；读取侧
  `maxReadChars` 32k 已控住，§7.5 双旋钮）。`budgetTokens` 由控制变量降为**观测项**
  （D7：cacheRead 不再按 1:1 计入控制；预算治理走 maxSteps / maxInputTokens 双旋钮）。
- **预算模型**：预算基数从会话累计改为**任务起点**（D1 修复：同会话第二个任务不再开局
  即 final-only）。

### Added

- **单插件双通道（P2）**：执行通道 standard / code；代码通道三来源判定（preset 探针 /
  bridge / none，只按执行器实现判定不按 preset id）；preset 来源完全让位（不注册工具、
  协议段 0 字符、不解析输出、不拦截 final——8 项 PTC 能力逐项可验）；bridge 来源受限
  窄桥（仅 tf-code，协议段约 200 字符）；来源皆无 → 拒绝进入并回退标准通道（不静默降级）。
- **上下文档位（P1）**：light / standard / deep 三档只改数值（maxSteps 16/24/40、
  maxInputTokens 12k/20k/48k、压缩强度、取回预算 12k/24k/48k、keepRecent 12/30/60、
  摘要上限 8k/16k/32k）；控制栏两区块渲染；任务级预算指令 `[tf-budget: 8steps/20k]`
  与结构化 source.tfBudget（装配显式上限不可逾越）。
- **双旋钮预算（P1，§4.5）**：`maxSteps`（N 上限，触顶走收束期）+ `maxInputTokens`
  （C 上限，触顶触发压缩）；下限保护（< 3×前缀估算拒绝启动并给出最小值，R11）；
  运行时 `setChannel` / `setTier` / `setBudget`（`setMode` 保留为别名）。
- **确定性压缩（P3，§7.6）**：kernel/compaction.ts（每条一行、头尾保留、keepRecent、
  maxSummaryChars 收敛、不调模型）；`maxInputTokens` 触顶 → dropAppendHead + 摘要 +
  原文句柄化 + `request:N` 取回别名 + 计划性换基记账。
- **效果压缩与语义状态（P3，§5.6）**：`[applied pN]` 折叠行（回灌/压缩两个合法改写点；
  effectElisionKeepRecent=3）；`[tf-stream:state]` 一行语义状态摘要（标准通道回灌、
  代码通道 S5 快照）；`[unchanged]` / `[seen]` 跨回合工作集。
- **取回策略（P5，§7.3/§7.5）**：已投递 span 账本（命中未变 → `[unchanged]` 一行；
  部分重叠只发新增——D5 修复）；read 行锚索引（每 200 行 + 顶层符号 + 未投递区间显式
  列出——D4 修复；索引超 2k 只给符号名，R9）；`peekBudgetChars` 回合取回预算
  （触顶 `[budget]` 一行，不静默继续）；协议新增 peek 段（取回纪律，成本模型依据）。
- **前缀策略（P4，§8）**：三类处置判定表——planned-rebase（正常路径，记账 + 模型可见）
  / append-drift 受限换基（§8.4 成本判据 rebaseBudgetRatio）/ stable-drift 始终 fail；
  `prefixPolicy` auto/rebase/fail、maxRebasesPerTurn/Session 限流；`cache-reset`
  台账事件（cause / contextTokens / estimatedColdCost）。
- **接管让位（§6.2）**：`takeoverOnConflict` degrade（默认，转 sidecar，owner 具名显示）
  / refuse；takeover-registry 增 owner 字段。
- **文档与法务（P6）**：PROTOCOL-v1.md（自有规范冻结）；docs/channel-matrix.md、
  docs/upstream-delta.md、docs/porting-matrix.md；NOTICE（thinkflow 派生 / PTC 依赖分栏）。
- **评测（P7）**：eval/tools/run-four-arm.mjs 四臂离线结构跑批 + eval/FOUR-ARM-2026-11-22.md
  报表（H1/H2 结论待真机臂）。
- **四臂真机跑批（P7）**：patches/eval-ptc.yml（L1）与 patches/eval-stream-ptc.yml（L3，
  `channel=code` / `codeChannelSource=preset`）；eval/tools/four-arm-real.mjs 编排四臂
  （复用 runner.cjs 的取证管线，新增 `--patch` 覆盖）→ `eval/runs/four-arm-<stamp>.json`
  （schema `four-arm-real/1`）；判据在 eval/tools/four-arm-verdict.mjs（纯函数 + `--selftest`）。
  缺凭据时 exit 3 且不写产物——不得把"没跑"写成"数据不足"。
- **回退开关演练（§12.4）**：eval/tools/rollback-drill.mjs 把九项开关逐项映射到具名用例
  → `eval/runs/rollback-<stamp>.json`（schema `rollback-drill/1`）；映射失效即判失败。

### Fixed

- **D1**：预算基数改任务起点（同会话多任务不再累积误杀）。
- **D2**：`compat` 档不再关闭 tf-call/第三方工具（档位删除，reserved-only 透传）。
- **D3**：`lean` 档不再把工具面裁到 7 项白名单（同上）。
- **D4**：read 截断不再取头部（行锚索引替代——头部截断策略本身制造取回）。
- **D5**：取回不再对同一区间重复付费（span 账本去重）。
- **D6**：readFeedbackLimit 双旋钮拆分（读取侧/回灌侧各自独立）。
- **D7**：cacheRead 不再按 1:1 计入预算控制（缓存命中不再加速降级）。
- **发布门禁自锁（R4）**：`scripts/gate.mjs` 的 G1 曾断言 `6/6 全绿`，而一致性检查已扩到
  7 项，导致 CI 恒 FAIL、正式版路径被自己的脚本堵死。改为从输出解析 `N/N`（项数不再硬编码）。
  同批修掉：G5 正则匹配不到带千分位的 `129,178 / 446,410 = 28.9%`；G5 增四臂 `verdict.h1/h2`
  取证；G6 改为消费 `rollback-<stamp>.json` + 真机勾选；记录文件按版本命名
  （`eval/GATE-<ver>.md`）并保留人工勾选（原实现每次重跑都会覆盖人工记录）；stamp 不再
  静默回落到固定历史批次。
- **文档口径（§5.3/§12.2/附录）**：代码通道"对 system prompt 贡献 0 字符"不成立——协议段
  确为空串，但稳定前缀内仍有 3 段常量共 263 字符（通道措辞 117 + 工具面说明 33 + 不变量
  109 + 2 处分隔符），跨请求固定。对外表述收窄为"协议段 0 字符"。
- **压缩通道（P3，U2）**：`surfaceOp: replace` 未采用（宿主行为未验证），两个通道同走
  `dropAppendHead` + 确定性摘要 + 句柄化；`surfaceCompaction` 键名保留但语义改为"压缩总开关"。
  code 通道的不变量文案同步改写（原写"压缩可能替换旧消息为摘要"，与实现不符）。

## [0.4.0] - 2026-11-22

**首个 stable 0.4 发布：在 0.4.3.2 的基础上回流 0.3.3 的三项真机修复。**
0.4.0 自 0.3.1 分叉，0.3.2/0.3.3 的收束改造、读注入预算、正文闭合容错未回流——真机
表现与 0.3.x 同症状（13 步任务中途 blocked、桌面端只剩最后一句 prose、`</tf-*>` 漏进正文）。
本版把三项修复语义移植进 0.4 能力面（`426+` 行 loop、`68+` 行 parser），并以 0.3.3 的
19 个探针原样验收（`test/v040-closeout.test.ts` 10 + `test/v040-wildcard-closer.test.ts` 9）。

### Added

- **生产性重入与停滞重入分账**：`stallReentries`（连续零产出重入上限，有新增 ok 命令即清零）
  + `maxRequests`（请求硬上限，生产性步骤也计）+ `closeOutRequests`（收束期）。
  `maxReentries` 语义收窄为停滞预算缺省值——干活的步骤不再被"重入次数"硬杀。
- **收束期 `[tf-stream:closeout]`**：撞墙但**有事实可交付**时不立刻砍，先注入"停止探索、
  立即 tf-final"的收束指令（最多 `closeOutRequests` 次），用尽仍无 final 才收场。
- **兜底交付泛化**：`#deliverFallbackFinal` 现在同时服务"收束撞墙"与"前缀 fail-closed"
  两条路径，写一条 `[未完成交付]` 台账事实说明（零产出回合不写，不伪造完成）。
- **单请求读注入预算** `readFeedbackBudgetPerRequest`（缺省 `12000` 字符）：一次读多文件时
  预算内给全文、超出给"头 800 字符 + 句柄"，下一请求 `tf-peek` 补全；`0` = 关闭（回退点）。
- **畸形闭合定向纠错** `malformedCloserNudge`：`</tf-*>` / `</tf-write 属性…>` 第一次出现时
  挂一条纠错注入（只一次），把"猜语法"变成"照抄正确形态"。

### Fixed

- **正文闭合容错**：`findBodyClose` 允许尾随空白/属性（`</tf-write >`、`</tf-write path="x">`）；
  旧实现只认逐字 `</tf-write>`，模型换个写法就整段正文在流末按 truncated 丢弃（"写到一半没了"）。
- **DSML 内嵌闭合剥离**同步改正则（块内尾部闭合带空白/属性时正文不再拖尾）。
- **`probeTag` 畸形闭合变体**：协议命名空间内 `</tf-` 紧跟非空白即按 `close-tag` 处理，
  `indexOf('>')` 换成引号感知扫描（`cmd="a>b"` 不再截半）；通配名 `</tf-*>` 如实进台账。
- **升格块不再顶掉合法 final**：饥饿升格改为"先算块、后挂块"——本步有合法 final 时不挂，
  只有确定要重入才挂。
- **易变尾 durable 前置**：`observation/peek/replay/tool-result/plan/receipt` 前置，瞬态
  指令（error/nudge/closeout）后置——转正后的历史前缀可覆盖到最后一个 durable 块。
- **兜底交付与 stepEnd 顺序**：assistant/message 必须先于 step/end（v4 要求落在打开的
  turn+step 内），两处前缀失败路径同步修正。

### Tests

- 407 用例：406 pass + 1 预置跳过，0 fail（零 API 调用）；`npm run check` 见下。
- 新增 `test/v040-closeout.test.ts`（P1–P3/C1–C4/R1–R3）、`test/v040-wildcard-closer.test.ts`
  （W1–W9）——0.3.3 的探针原样迁移，不改断言。

## [0.4.3.2] - 2026-11-22

**纯文档/注释收尾（不改行为；`dsh-stream-agent-待改清单-2026-11-22.md` B 组）。**
回归计数订正、口径表正名、活文档阈值作废、"缓存读零损失"与"全文断言"两处过期表述统一。

### Fixed

- **B1**：0.4.3.1 条目回归计数 387→388（与 Tests 节及 `node --test` 实测一致）。
- **B2**：`eval/METRICS.md` §8 口径表——严格二分量的被加数由 `inputTotal + output`（含缓存读，实为四分量）正名为 `inputUncached + output`。
- **B3**：`docs/TEST-PROPOSITIONS.md` —— 全仓唯一还把 22.3% 当活阈值的文档改为「四分量 ≤ 基线 28.9%（446,410）；22.3% 已作废，禁止再作为阈值」。
- **B4**：`loop.ts` 三处「覆盖全部 prompt（缓存读零损失）」注释加限定——无 transient 尾时零损失；有 transient（error/nudge）时该块被丢弃、前缀在该 index 断裂（bounded 一块；0.5.0 起按 transient-drop 计量，见清单 A12/C1）。
- **B5**：`context-render.ts` ×2、`loop.ts` ×2 注释里的「全文断言」统一改为「承诺前缀断言」，与 `assertRequestPrefix(promised, …)` 实际语义一致。

### Tests

- 用例数不变：388（387 pass + 1 预置跳过，0 fail，零 API）；`npm run check` 6/6。版本 `0.4.3.2`（未发布 npm）。

## [0.4.3.1] - 2026-11-22

**对 `dsh-stream-agent-v0.4.3-清单符合性核查-2026-11-22.md` 两个阻断项的修复 + 口径回写。**
核查结论：0.4.3 结构在位但有可复现误判（阻断项 A）与错值标签（阻断项 B）；本版只改断言内核与文档，不改协议面。

### Fixed（阻断项 A：混合易变尾导致 append-drift 误判）

- **根因**：0.4.3 的承诺前缀基线用 `horizon = stableLen + 转正块数` 公式，隐含假设"durable
  尾块连续排在易变尾最前"。实际 `#buildInjections` 的压入顺序是 error（transient）在前、
  observation（durable）在后——同一步"结构化失败 + 成功读"的尾 = `[error, observation]`；
  `#commitDeliveredTail` 只转正 observation，下一请求该位置是 observation 而基线是 error
  → 误报 append-drift。预算每回合 1/每会话 3，C2/R2 类任务一次会话 3 次很常见 → 第 4 次
  fail-closed **误杀任务**——正是 P0-6 要消灭的失败模式换了个触发条件被装回来。
- **修复（核查 §2.5）**：基线从"上一请求前 N 条"改为 **`promised` = 转正之后的
  stableMessages() 逐字节快照**——下一请求的前 `promised.length` 条必须与它逐字节一致；
  分类锚点 `stableLen`（转正前长度）不变。transient 尾块不转正、不在承诺里，断言与易变尾
  块序**完全解耦**；`horizon` 概念删除。`RequestBaseline` 改为 `{ promised, stableLen }`。
- **回归**：K6（内核：混合尾 transient 前置不进承诺，观测块转正即匹配）+ P5（驱动器：
  核查 §2.2 的复现场景原样收编——同流 `depends_on="nope"` 失败读 + 成功读，R2 尾 =
  [error, observation] 混合序，0 prefix-reset / 0 prefix-broken / 任务完成）；P1–P4 与
  全量 388 用例通过（387 pass + 1 预置跳过）。

### Fixed（阻断项 B：22.3% 是 cacheRead 二次计入的错值）

- **三个恒等式**：446,410 + 393,728 = 840,138；129,178 + 58,112 = 187,290；187,290 / 840,138
  = 22.29%。`M1_tokens.input` 本身就是"未缓存 + 缓存读"（W1 的 metrics.json：input=16,032
  而逐请求 `usage.inputTokens` 之和只有 6,432）——在它之上再加一次 cacheRead 即得错值。
  **"0.2.0 更早批次（四分量 22.3%）"不存在**：`eval/runs/` 只有 2026-11-15 与
  2026-11-15-v02 两个完整批次，baseline 都是 446,410；v0.2.0/v0.2.1/v0.3.0 三个 tag 的
  README 均无 840,138/187,290/22.3。
- **正确口径**：四分量（未缓存输入+缓存读+缓存写+输出）= 446,410 → 129,178 = **28.9%**
  （本批缓存写两臂均为 0）；严格二分量（未缓存输入+输出）= 52,682 → 71,066 = **134.9%**
  （插件更高——请求数 +18% 与输出 28,284 > 19,654，正是 P0-2/P0-10 要压的方向）。
- **影响面全改**（核查 §3.4 表）：README（中英）、CHANGELOG 0.4.3 条目、`eval/RESULTS.md`
  §2、`docs/v0.4.3-thinkflow-gap-review.md`、升级清单 v3 §0.1/§0.5/P0-10——全文不再出现
  840,138 / 187,290 / 22.3%；"0.2.0 更早批次"删除。升级清单 v3 同步回写 P0-6 措辞
  （"全文断言"→"承诺前缀断言"、"重发"→"放行一次"、兜底交付加"有产出"限定、第二见证
  明确为事实见证不 fail-closed）。
- **命名澄清**：`M1_tokens.input`（= 未缓存+缓存读+缓存写）与 `summary.json`
  `inputTokens`（= 未缓存）同名不同义是错值根因之一；`eval/METRICS.md` 定义正名
  （`inputTotal` / `inputUncached`），历史 metrics.json 不回改。
- **costPerPass 价格快照机制**（核查 §4.5）：`eval/METRICS.md` 新增价格快照章节 +
  `eval/price-snapshot.json`（schema 固定，价格发布前按 DeepSeek 官网当日定价回填）；
  未回填前七列中 costPerPass 标"待快照"，其余六列照常可复算。

### Tests

- 用例 385 → 388（+3：K6 混合尾内核钉、P5 真实装配漂移驱动器钉、M0 同轨迹两次 renderHash
  序列逐字节一致——核查 §6 条目 2 的验收项）；全量 388/387 + 1 预置跳过，零 fail。版本 `0.4.3.1`（0.4.3 未发布 npm，按核查 §0 建议以 0.4.3.1 定版）。

## [0.4.3] - 2026-11-22

**P0-6 前缀退路（wire 承诺前缀断言 + 三类成因 + 兜底交付）+ P0-7① 七列尺子 + P1-4 口径收口。**
升级清单 v3（`dsh-stream-agent-升级清单-2026-11-22.md` §7）的 0.4.3 阶段：先立尺子和退路——
P0-6 把断言从 stable 扩到上一请求全文，**失败率必然上升**；没有 fallback final 就是把
"缓存问题"升级成"任务失败"（§7 顺序理由）。行为变更（P0-1/2/3/4）按清单放 0.5.0；
P0-9（PTC 源码迁移）与 P0-10 T0 放 0.4.4。

### Added（P0-6：前缀退路——§2.7 两个盲区的修复）

- **wire 边界承诺前缀断言（P0-6①②）**：`loop.ts` 增 `#lastRequest`，每请求装配后先对
  它做**承诺前缀断言**（内核新增 `assertRequestPrefix`）——比较"上一请求收尾后的稳定段
  （转正之后的 stableMessages()）"与本次请求的头部。旧断言（`render()` 内置 preflight）
  只比装配时的 stable，从不覆盖两件事：①转正块与已发文本是否逐字节一致；②追加区是否
  被代码改写。transient 尾块（nudge/error/degraded）不转正、不在承诺里。段边界
  （`dropAppendHead`）显式重置基线——唯一合法的历史收缩通道。（0.4.3 首版用 horizon
  公式，混合尾会误判，0.4.3.1 改 promised，见下。）
- **三类成因分类与处置（P0-6③④）**：`PrefixBrokenError` 增 `prefixCause:
  'stable-drift' | 'append-drift' | 'shrink'` + `stablePrefixLen`（判定式
  `error.index < stablePrefixLen`）。处置：`stable-drift` 0 放行（稳定段被改写 = 装配
  被破坏，放行只烧缓存不修根因）；`append-drift` 预算内放行**一次同一份 next**（断言在
  发送前——"放行"= 记账后照常发送，0 额外请求；每回合 1 次、每会话 3 次，第 4 次降级
  fail-closed；放行即显式缓存重置点 `prefix-reset`，基线随本请求推进）；`shrink` 0 放行
  （文案指出"段边界必须走 `dropAppendHead`"）。
- **有产出时才有交付（P0-6⑤，自 0.3.3 回植）**：`#buildFallbackFinal` /
  `#deliverFallbackFinal` / `#turnOkRecords` / `#productiveOkCount` 回植到 0.4.x 线——
  fail-closed 收场时把**台账事实**写成一条明确标注 `[未完成交付]` 的 assistant 消息，
  不再让异常炸出 `runTurn`（旧实现：`PrefixBrokenError` 直接抛出，用户侧只剩半截输出）。
  零产出回合不写（不伪造"已完成"），跳过事实落台账（`fallback-final-skipped`）。
- **receipt 最小对账（P0-6⑤）**：前缀破坏收场时把 pending 写前意图整批标记 unknown
  （`intent-log.ts` 新增 `reconcilePendingIntents`，ack 记录 note 写死语义："只解除恢复
  锁，不重放工具，不声称回滚"——P0-8/0.5.1 再补完整三态）。对账后 `pendingIntents`
  悬空数 = 0；IO 失败 fail-open + 告警（意图保持 pending，恢复锁不解除）。
- **第二见证升级（P0-6②）**：`context-render.ts` 从"只看 `messages[0]`"改为**整条序列
  见证**——保留上一请求全文，逐请求落首差异位（`firstDiffIndex`）与长度收缩（`shrunk`）
  事实进 prefix 台账；fail-closed 仍只守首条（wire 层无法区分段边界的合法收缩与改写，
  强制收口在驱动器 `#lastRequest` 断言——那里有显式基线重置通道）。

### Added（P0-7①：七列尺子——ΣproviderInput / N / resetCount 可外部复算）

- **request 记录尺子字段**：`prefixTokensEst`（Σ消息字符/4 上取整，与 O5 阶梯同启发式，
  交叉校验用——权威值是 providerInputTokens，E9）、`providerInputTokens`（计费输入 =
  未命中 input + cacheRead + cacheWrite；usage chunk 在流末才到，记录先建、数字后补——
  同一对象引用，外部复算不受影响）、`cacheRead` / `cacheWrite` / `output`、
  `resetSeq` / `resetCause`（重置纪元与成因：`segment-drop` / `prefix-reset`）、
  `feedbackBytes{full, dedup, handle}`（反馈字节分类，按注入位点整块字节计入：全量观测
  /peek/replay/native ≤ 上限 = full；骨架/截断/自写回执/native 句柄化 = handle；指令块
  （nudge/error/degraded）与计划差分不计入；dedup 由 P0-4/0.5.0 引入，0.4.3 恒 0）。
- **聚合三元组**：`cacheStats()` 增 `providerInputSum` / `requests` / `resetCount`——
  全部可从 request 记录逐条复算（ΣproviderInput / N / 末条 resetSeq）。七列
  （P0-10：`N / inputPerPass / outputPerPass / costPerPass / resetCount / cacheReadAbs /
  checks`）的推导公式落 README §7.3，少一列不算结果。
- **`cacheHitRatio` 降级为 diagnostic-only**（代码 JSDoc + README）：分母随总量压缩收缩，
  命中率与低成本在本插件形态下必然背离（清单 §0.5），不进门禁、不进对外标题。

### Changed（P1-4：口径收口）

- README（中英）的口径标签修正（0.4.3 首版标反了，0.4.3.1 依符合性核查 §3 改正）：
  **129,178/28.9% 是四分量**（未缓存输入+缓存读+缓存写+输出；本批缓存写两臂均为 0）；
  严格二分量（未缓存输入+输出）= 52,682 → 71,066 = **134.9%**（插件更高——请求数与
  输出都更多）；**187,290/840,138/22.3% 是 cacheRead 二次计入的错值，已作废**（首版曾
  为它虚构"0.2.0 更早批次"，该批次不存在）。对外表格固定四列（请求数 / 二分量 / 四分量
  / checks）；任何对外数字必须同表四列，标题不出现单一倍数或命中率主卖点（P2-2）。

### Tests

- 用例 368 → 385（+17）：`test/v043-prefix.test.ts`——内核断言 5 例（K1 承诺前缀放行 /
  K2 append-drift 分类 / K3 stable-drift 分类 / K4 shrink + allowTailDrop / K5 role 变化
  归类）+ 四类探针 4 例（P1 恰好 1 次重发任务完成 / P2 stable 漂移 0 重发 + 兜底交付 /
  P3 每回合必漂移第 4 次不静默 / P4 最小对账悬空 0）+ 尺子回归 6 例（M1 prefixTokensEst
  独立复算 / M2 计量回填与缺省噪声 / M3 聚合三元组 / M4 resetSeq 段边界纪元 /
  M5 feedbackBytes 分类 / M6 无漂移零噪声）；`test/loop.test.ts` B1 更新为 P0-6⑤ 新契约
  （blocked + prefix-broken + fallback-final，不再断言异常炸出）。全量 385/385 离线通过
  （1 例预置跳过，零 API 调用）。
- 版本 `0.4.3`；**未发布 npm**（G5/G6 真机项待批次；发布纪律：G5/G6 未过前不得发布）。
  阶段对照见升级清单 v3 §7：0.4.4 = P0-9（PTC 迁源码 + 协议快照 v3）+ P0-10 T0。

## [0.4.2-beta.1] - 2026-11-20

**V0.4.2 独立升级：缓存经济学可观测化（Cache Economics Observable）。** 与并行 0.3.2
的问题修复（截断/记忆蒸发，已随 0.4.1-beta.2 同源回植）**不同主题**——0.4.2 的身份是
"把 O6 前缀单调性换来的缓存收益变成一等可观测、可对账、可配置的资产"：台账有命中率、
预算按计费口径、控制页看得见。真机取证 `session-6b61cb4d`（2026-11-19：27.4K tok、
缓存命中 64%、9 步被重入上限杀掉）；规划对照见 `docs/v0.4.2-plan.md`。

### Added

- **缓存命中可观测面（三层）**：
  ① **台账层**——usage 镜像与记录对齐宿主 dsh-llm Usage 口径（types.d.ts:160-179：
  `inputTokens` 只是未命中缓存的输入，`cacheReadTokens`/`cacheWriteTokens` 单列，计费
  输入 = 三者之和），逐请求携带缓存字段（适配器未上报时不写 0 噪声）；回合台账
  `plugin:tf-agent/step` 新增 `cacheHitRatio`。
  ② **预算层**——O5 阶梯按**计费输入**升档：旧口径只累计未命中输入，缓存读大户会漏判
  升档（V3 回归钉死）。
  ③ **控制页层**——驱动器 `cacheStats()` 经运行时状态面（`controlStatus().cache`）上
  桌面控制页"缓存命中"行（当前会话有缓存数据才显示；离线/mock 适配器隐藏该行，
  不渲染成 0%）。
- **计划/验收回执转正（V-b 修复，也属 0.4.2 自有升级）**：转正清单补 `plan`/`plan-diff`/
  `receipt`——计划清单与验证差分、自写回验回执都是"发生过的事实"，随下一请求装配转正
  进追加区，模型在任意后续请求都能看到计划与验收进度。

### Fixed

- **计划/验收回执跨请求蒸发（6b61cb4d 死循环的直接原因）**：计划在声明那一请求的易变尾
  出现过一次后彻底消失，模型不知道要验收什么，premature-final 连续 6 步被拒（a2/a3 一直
  未验证）、每步重发重复读命令，直到重入上限 blocked，任务中断（见上条转正修复）。
- **重入上限误当任务预算**：四模式上限放宽（balanced 8→12、lean 6→8、compat 12→16、
  power 10→14）。语义是"防打转兜底"不是"任务步数预算"——计划+实现+验收类任务 9 步不够；
  打转根因（0.4.1-beta.2 的记忆蒸发主修 + 本版计划转正）已修，残余打转由重复命令护栏
  （replay-capped）兜底，上限只放宽兜底余量。无重评，方向性调整（上限不是成本承诺）。

### Fixed（宿主契约冲突 —— 对照 GitHub 上游源码定位，与 0.3.2 同源；真机 `session-8f22c7a0`）

截断修复后的真机会话（23:31）仍中断：缓存命中已到 88%，但 6 步后结束，最终答案是一句
"我将重写实现文件"的意图陈述。对照上游 `packages/llm/llm/src/index.ts`（master）确认四个
**独立**因素叠加，逐一修复：

- **assistant 线消息缺 `source`（崩溃主因）**：宿主 `LlmRuntime.forAdapter` 无防护读
  `message.source.replayState`——"正文落追加区"用 role:'assistant' 但不带 source，正文
  首次落史后的下一请求必崩（日志 seq 121 实证）。现在 `RenderMessage.source` /
  `toWireMessages` 透传 / `commitStepDigest` 落史带 `modelSource()`（kind 固定 'model'）。
- **nudge 进度感知护栏**：nudge 在写文件步被消耗后，任何无注入步骤直接 blocked——即使
  模型正在干活。改为有新 ok 命令即继续，零产出的连续 nudge 才收束（C3 零产出语义不变）。
- **XML 实体解码**：`cmd="... &quot;EXIT=1&quot;"` 的实体原样进 PowerShell，白烧一步。
  属性值统一解码（单遍替换，`&amp;quot;` 不二次展开）。
- **DSML 内联属性 invoke 统一块缓冲** + 非正文恢复边界纳入 DSML 标签 + 配对闭合终止时
  剥尾部闭合（残片立即露出，不吞到流末）。

### Changed

- 用例 360 → 368（+8）：`test/v042-cache.test.ts`（V1 计划块跨请求可见、V2 usage 缓存
  字段随流进台账、V3 预算阶梯按计费输入升档、V4 `cacheStats()` 控制页口径快照）+
  `test/v032-conflict.test.ts`（W1 assistant 线消息携带 source、W2 nudge 进度感知、
  W3 XML 实体解码、W4 DSML 内联属性混合形态）。
- 版本 `0.4.2-beta.1`；**未发布 npm**（G5/G6 真机项待批次；缓存命中率以回合台账
  `cacheHitRatio` + 控制页取证，真机复跑口径见 docs/v0.4.2-plan.md §3）。

## [0.4.1-beta.2] - 2026-11-18

**回合收束补丁：把 v0.3.1 的「任务半途截断」修复同源回植到 0.4.1。** 与 0.4.1-beta.1 相比
只改"回合如何收尾"与"协议残片如何处理"：工具面、协议段组装、命令表（14 硬上限）、装配
清单均零变化。

### Fixed（会话中途截断 —— v0.3.2 同源补丁，未打新 tag）

**现象**：任务做到一半，模型思考区出现 "The history is truncated"；最终答案只剩
`README.md r10` / `Get-ChildItem ... b902` 这类残片，回合以 `blocked（重入上限）` 结束。
真机取证 `session-e4b9a89c`（0.3.2 线已修，本版同源回植）：

- **请求之间没有会话记忆（主因）**：追加区从不写 assistant 正文 / 命令 / 结果；观测只在
  易变尾注入一次。第 3 个请求起模型只看到 system + 任务 + 句柄目录行。现在每步把
  **正文 + 命令摘要**落追加区，已发出的易变尾在下一请求装配后**转正为历史**（只转正
  observation/peek/tool-result/replay 事实类块；nudge/degraded/error 不转正），对齐内建
  `dsh-agent-loop` 的 `session.deriveMessages()` 语义，前缀仍严格单调。
- **DSML 参数式调用被当噪声**：`<｜｜DSML｜｜ invoke name="tf-read">` +
  `<｜｜DSML｜｜ parameter name="path">README.md</...>` 形态下，0.4.1 只认内联属性，
  parameter 子标签判 malformed、**标签间的值作为 prose 漏进正文**，命令却没执行。
  现在整块缓冲到闭合后按 parameter 归集成属性并发命令；块内文本不再透传。未闭合即流终止：
  非正文命令能救则救，正文命令按 truncated 丢弃（不写半截文件）。
- **非正文命令少写 `/` 吞掉后续输出**：遇到下一个 `<tf-` / `</tf-` 即视为闭合（命令照发、
  后续照解析）；流末仍未闭合也发命令并把剩余文本归还 prose。
- **截断没有续写事由**：`finish=max-tokens` / 命令体未闭合 → 强制一次
  `[tf-stream:truncated]` 续写注入（带已生成尾部 ≤800 字符），回合级上限 4 次。
- **计划门槛拒绝不给计划内容**：final 被"计划有未验证项"拒绝时，注入附带计划快照
  （id + 原文 + 状态），模型不必凭记忆猜验收项。

**涉及文件**：`src/kernel/parser.ts`、`src/entry/loop.ts`、`src/entry/mock-provider.ts`
（剧本选择改为"最新 marker 优先"——历史持久后旧 marker 仍在，首匹配会无限重演）。
**回归**：`test/v032-truncation.test.ts` 8 例；全量 360/360 通过（1 例预置跳过）。

### Fixed（与 v0.3.1 `a8b4111` 逐处等价）

- **占位/过期 final 被当作交付答案**：新增内核模块 `src/kernel/final.ts`（`checkFinalSummary`
  纯函数，判定 `empty` / `placeholder` 两种形态；`done`、`已完成` 这类短答案刻意放行）。
  收束闸由"只查 `depends_on` 与未完成命令"扩为四类拒绝：① 依赖未满足 ② 计划有未验证项
  ③ summary 是占位 ④ 这条 final 之后又发出过命令（答案已过期）。拒绝**同类只注入一次**
  （`#reportedFinalRejects` 按 kind 去重），反复不改则如实 `blocked`，绝不把占位当交付。
- **重复命令幂等但空手**：`#queueReplay` / `#materializeReplays`。模型把同一条
  read/grep/glob/bash 再发一次时，原实现只回 `duplicate-idempotent`（内容早已不在上下文），
  模型只能再猜再读、原地打转。现在幂等语义不变（不重复执行），但把原观测按既有上限回灌
  一次；每回合上限 `MAX_REPLAY_INJECTIONS = 4`，超限记 `replay-capped` fault，不静默。
- **孤立闭合标签落进正文**：`parser.ts` 新增 `close-tag` 探针与 `closeTagName()`。ground 模式
  下出现的 `</tf-xxx>`（自闭合命令被多关一次、或流末半截残片）一律记
  `malformed(stray-close-tag:...)` 后丢弃，不再作为 prose 落盘——桌面端正文里不再出现裸的
  `</tf-bash>`。普通 HTML 闭合标签仍按正文透传（不过度拦截）。

### Fixed（宿主一致性补丁，与 0.3.2 同一套；真机会话 `session-1da5f8fc` 取证）

- **历史加载失败（`message must have model source`）**：beta.1 及更早版本写 assistant/message
  时 source 只有 `{kind:'model'}`，缺宿主校验器（dsh-session `assertMessageEventShape` →
  `hasProviderModel`）要求的非空 `provider`/`model`——日志读取时整条被判 corrupt。现在
  `makeAssistantMessage` 携带实时 provider/model（`createSessionEventWriter` 新增 `modelInfo`
  写入时回调；驱动器 `modelSource()` 随 `applySelection` 换模而动，不缓存）；无路由信息时落
  `'unknown'` 兜底。**存量损坏日志**：`node scripts/repair-session-logs.mjs --write`（修复
  脚本新增 model source 补齐类目 + 本地消息形状复核；写前备份、写后清投影缓存纪律不变）。
- **回合结束后 UI 永远转圈**：`StreamLoopAgent` 从不发 `agent/status`——桌面端
  dsh-api-session-controller 靠它转发 `api-session/status` 收起"运行中"指示。状态转换统一走
  `#setStatus`（镜像内建 setPhase：只在真正变化时发；发射异常 fail-open 告警），factory 从
  `ctx.emit` 接线 `emitStatus`。
- **装配清单解除 `maxReentries: 8` 钉死（决定性修复，与 0.3.3 同源）**：cordis.patch.yml /
  preset.yml 显式钉死 8——按"装配压过模式"规则，模式默认值的上限提升从不生效
  （真机 session-7fbfef8f：11:57 的会话仍以"重入上限 8"硬杀）。现在上限由模式默认值
  决定（balanced 12 / lean 8 / compat 16 / power 14），驱动器直构兜底值同步 8→12。
  同批真机缓存命中 91%（26.6K tok）。
- **改审批策略命令报 `agent.inject is not a function`**：新增 `inject(message)`——落盘
  user/message + 并入下一请求装配，不唤醒空闲 agent（镜像内建 `send(input,'next-step',false)`）。

### Changed

- 用例 331 → 352（+21）：parser 孤立闭合标签 4 条（跨 chunk / 流末半截 / 不误伤 HTML / 配对式），
  loop 收束闸 4 条（K1 占位拒绝、K2 过期拒绝、K3 重复命令回灌、K4 屡教不改如实 blocked），
  宿主一致性 13 条（`test/host-conformance.test.ts`：整条日志逐事件过宿主同款消息形状校验、
  换模实时 source、unknown 兜底、agent/status 转换序列精确性、发射异常熔断、inject 三态、
  事件类型清单镜像（62 项 known-event + plugin record 语法）、修复脚本 fixture 集成回归
  （dry-run 不落盘 / --write 备份与完好会话零触碰）、宿主真校验器可选通道
  （DSH_HOST_MODULES 在位时过 validateStoredEvents；缺席如实 skip））。
- 版本 `0.4.1-beta.2`；**未发布 npm**（G5/G6 真机项仍待批次，与 0.4.1-beta.1 的门禁结论一致）。

### Notes

- 与 v0.3.1 的差异只在基线：0.4.1 的 `tf-call` / `tf-ask` / `tf-skill` 与 `protocol.ts`
  协议组件化不受影响；稳定前缀零漂移（协议金样与字符数护栏回归全绿）。
- 宿主一致性补丁与 0.3.2 同源同修（两版本同一套 duck-type 契约缺口）；升级设计
  （host-conformance 持续化）见 `docs/upgrade-v0.4.1-beta-host-conformance.md`。

## [0.4.1-beta.1] - 2026-11-18

**协议文本组件化（v0.4.1 主题：省 token + 内容可自定义 + 可删减瘦身）。** 自 0.4.0-beta.1
分叉；命令表不动（14 硬上限）、四模式默认行为零变化、装配清单零变化。

### Added

- **协议组件化——`src/kernel/protocol.ts`（新内核模块）**：`DEFAULT_PROTOCOL_TEXT` 拆成 7 个
  具名段（syntax / plan / results / selfread / timing / finalSummary / rules），由
  `composeProtocolText({ level, sections, enablePlan })` 组装。**缺省组装与 0.4.0-beta.1
  原文逐字节一致**——full 段文本由 v040 `src/entry/loop.ts` 程序化切分注入（不手抄），
  `test/golden/v040-protocol.txt` 金样逐字节钉死（稳定前缀字节不漂移 = 缓存零回归）。
- **精简档位 `protocolLevel: 'full'（默认）| 'lean' | 'minimal'`**：lean = 全 7 段压缩说明
  文字（2,836 → 2,324 字符，省 18.1%）；minimal = 语法铁律面（selfread/timing 落选，
  → 1,446 字符，省 49.0%）。语法行逐字保留，只砍解释性散文（harness 才是权威）。
  字符数回归护栏进测试（C8）：改文本必须显式更新金样与断言。
- **段级增删 `protocolSections`**：`{ plan: false }` 等逐段开关；未知段 id fail-fast 抛错
  （装配错别字不静默）；本档未含的段可显式加回（缺专属文本时回退 full 文本）。
- **自定义追加 `protocolAppend`**：追加在协议末尾（call 段之后）进稳定前缀——加一条
  项目规则不用再抄 2,836 字符默认文本。**不变量段可关 `invariants: false`**（省 242 字符；
  string 整段替换语义不变）。
- **CLI `protocol` 子命令（预览工具）**：`dsh-stream-agent protocol --level minimal
  --stats-only`——逐段字符数、总量对比 full、节省百分比；`--sections plan=off` /
  `--append "…"` / `--code` / `--no-call` / `--no-plan` 可模拟装配效果；`--json` 机器可读。
  "瘦身多少"可复算后才写进装配。

### Fixed

- **`enablePlan: false` 时协议仍声明「计划与验收」段**（0.4.0-beta.1 漏洞）：开关关了
  ~285 字符的 tf-plan 引导段照发，模型被引导调用一个会被拒的命令，白烧一次错误往返。
  现在 enablePlan=false **硬联动**去 plan 段（`sections.plan: true` 不能复活；命令级失败
  兜底仍在驱动器——协议不声明 + 驱动器拦截，防御纵深）。

### Changed

- 组装顺序：`基座（protocolText 替换 或 档位+段组装）+ code 段 + call 段 + protocolAppend`；
  优先级 `protocolText > protocolLevel/protocolSections > 缺省 full`。档位与段配置都是
  **构造期冻结**（进稳定前缀，会话内不突变——O4 红线不变）。
- `LoopEntryConfig` 新增 `protocolLevel`（宽松 string，未知值归一 full + 告警）、
  `protocolSections`（宽松表，未知段告警丢弃）、`protocolAppend`、`invariants: string | false`。
- README 数字回填实测值：331 用例 / dist 28 文件（v0.4.0-beta.1 残留的 275/25 旧数一并修正）。

### 已知限制（beta 边界，如实记录）

- 全部节省数字为**静态源文本字符数**（协议进稳定前缀、每请求计费，缓存命中后按
  cache-read 计价）；没有真机四分量复算，不宣称 token 折算率——P6 三臂复跑后补。
- `protocolLevel` 不进模式目录（四模式默认逐字节不变）；要把 lean 档绑进 lean 模式属
  行为变更，待评审。
- 控制页 UI 不新增协议档位控件（CLI `protocol` 子命令已覆盖预览需求；UI 改动留待
  有真机批次时一并做）。

## [0.4.0-beta.1] - 2026-11-18

**能力对等 beta（G1-G3）+ 工具面真实化（P1）+ 通用调用通道（P2/G2）+ 对等装配面（P3）+ 模式切换（P4）+ PTC 对等（P5）+ 基线度量（P0）。**
设计文档：`upgrade-plan/v0.4.0-stream-mode-design.md`（2026-11-18 评审定案，决议见 §16）。
自 0.3.1 分叉；`check` 扩到 6 项（命令表 ≤14 + preset↔矩阵一致）。

### Added

- **工具面真实化（P1）——`src/entry/tool-surface.ts`（新模块）**：会话首请求从宿主
  `ctx.tools.resolve / ctx.tools.schemas` 解析并冻结准入视图；此后只允许新增（additions-only）；
  解析失败沿用旧面（degraded=stale 一行注入 + 台账）。降级阶梯 L0-L2（L3 装载期拒绝，0.3.0 已有）。
  无宿主面（headless/离线）= 稳态 protocol-only（0.3.x 行为，不注行不记账——mock/评测零噪声）。
  配置：`toolSurface: core|standard|full|off`（默认 standard，off=回退点）、
  `nativeTools`（默认 false——schema 的每请求成本由 tf-call 逐调用成本替代）、
  `strictAdmission`（默认 false，R5 决议：beta 不透传 toolSet，P6 复跑后再收紧）。
- **tf-call 通用调用通道（P2/G2）**：协议命令表 11→14（=§6.4 硬上限，检查5 把关）：tf-call + tf-ask（阻塞提问，`q`/`header`/`options` 逗号标签）+ tf-skill（技能装载）。tf-call 的 body = JSON
  参数对象透传 `ctx.tools.execute`；unknown-tool 结构化失败注入带前缀匹配建议（不回灌全表）；
  bad-json-arguments 结构化失败；观测按宿主工具名分族（obs.ts 扩族：skill/agent/job/ask
  高增益候选，office/goal 回执族）。协议段 533 字符（DEFAULT_CALL_PROTOCOL_SECTION，含两条专用语法）。
- **对等装配面（P3）**：`preset/stream/cordis.patch.yml` 从 4 行扩到 16 行（与 ptc preset
  同款全量：web/skill/goal/plan/jobs/schedule/ask/todo/present/office/subagent）；
  workflow 不启用（§5.2 非目标，与 ptc 对齐）。检查6 把关 preset↔矩阵一致性。
- **模式切换（P4/G3）——`src/entry/preset-router.ts`（新模块）**：空白会话三向切换
  （standard↔ptc↔stream）；已开回合 `agent-preset/locked` 原样上抛（不自行判断、不包装）；
  服务缺席返回 undefined（无切换面）。控制页（ui/）GET 附 preset 名册（只读展示），
  切换本体在宿主"新建会话选择 preset"入口。控制页/状态面新增 `toolSurface` 能力档字段
  （modes.ts：模式提供档位默认值——lean=core、compat=off、balanced/power=standard，不是第五个模式）。
- **PTC 对等（P5）**：tf-code 绑定从固定 3 个（write/read/pwsh）扩为按会话冻结工具面生成
  （固定三个恒在——旧程序体只增不减）；绑定并发上限 `maxParallelBindings`（默认 4，
  对齐 ptc maxParallelSubCalls 语义）。
- **基线度量（P0）——`eval/tools/surface-baseline.cjs`**：对等矩阵 + schema 源文本成本
  （standard 面可提取 ≈17.4KB/27 块，真机成本待复测）+ stream 固定协议段字符数（src 导入实测）。
  产出：`docs/capability-parity.md` + `eval/runs/surface-baseline-2026-11-18.{txt,json}`。

### Changed

- **`npm run check` 4 项 → 6 项**：新增检查5（协议命令表 ≤14 硬上限，G2/§6.4）与
  检查6（preset 声明 ↔ 对等矩阵一致，R3 漂移把关）。
- 控制页状态面（runtime + fallback）与模式目录新增能力档字段；README 命令表 12 条（上限 14）。
- tf-code 绑定缺省面从固定三件变为"固定三件 + 会话冻结面"（无面 = 0.3.x 行为，回退点不变）。

### 已知限制（beta 边界，如实记录）

- 真机三臂复跑（P6/G4 token 门槛）未执行：本版为能力面交付，T1 ≤ 0.3.1×1.15 的门槛判定
  待有 key 的实机批次（`docs/capability-parity.md` 的 schema 成本为静态近似下界）。
- 宿主管理的 deferLoading 投放需要 request/header + developer/message 事件（E6 红线：本插件
  不写）→ T2 由 tool-surface 自管：nativeTools 开启时 core 档白名单声明 + additions-only；
  非 core 工具可达性走 tf-call（不声明 schema），这是省 token 的主线。
- `exit_plan_mode` 的对等是语义等价（tf-plan + 收束判定），不是宿主 plan-mode 状态机
  （矩阵如实标注）。

## [0.3.1] - 2026-11-18

**桌面端思考过程显示修复 + 第三方评审反馈修复合集。** 两部分内容并入同一补丁版本：
评审反馈修复（只动评测产物与文档，不改运行时行为）与思考过程显示修复（改运行时行为，
见下）。

### Fixed（思考过程显示 —— 桌面端"乱码"bug）

**现象**：electron 桌面端跑 stream 模式时，模型的思考过程显示错误，输出内容大多是乱码。
取证（本机会话日志 `~/.dsh/sessions/` 真机样本 + 宿主渲染面源码）定位到三个根因，逐一修复：

- **思考过程被丢弃**：驱动器对 `reasoning-delta` 只计体积（`reasoningChars`）不落盘，
  而桌面端思考区只认 assistant 消息里的 `{type:'reasoning'}` 内容块（取证：
  `dsh-client-ui-chat/src/client/conversation-nodes/event-projection.ts:117`）。本版把
  reasoning delta 按块捕获，随 assistant/message 落成首个内容块（块序镜像内建
  BlockAssembler：思考先于正文；中断路径的部分思考同样落盘）。
- **协议标记与 DSML 噪声进正文**：0.3.0 把整段流原文（含 `<tf-*>` 标记）落成消息文本；
  模型偶尔混入的原生调用格式 `<｜｜DSML｜｜ …>`（全角竖线）在桌面端渲染成乱码，协议
  标记则被 Markdown 渲染器吞掉或显示破碎。两处修复：
  - **落盘正文纯 prose 化**：assistant/message 只落解析器的 prose 事件（命令事实仍完整
    记在 `plugin:tf-agent/*` 台账，会话事实层不丢、resume 重放不受影响）；
  - **parser DSML 归一化**：`<｜…DSML…>` 形态一律不作为 prose 透传——
    `<｜｜DSML｜｜ invoke name="tf-xxx" …>` 改写回等价 tf-* 头部（命令不丢），
    其余包装行按 `malformed(dsml-wrapper)` 记账后丢弃（只进台账，不注入、不打断流）。
  - 协议文本补第 7 条规则：禁止输出 DSML/原生调用格式（省输出 token，治本）。
- **无实时流**：驱动器从不发 `agent/assistant-stream` 帧，桌面端在整个流期间没有 live
  内容（内建 loop 的思考区 live 数据源就是这套帧）。本版补发：start → 逐 reasoning-delta
  chunk → end。契约对齐宿主两端 fold（`SessionAssistantStreamAccumulator.accept` 要求
  revision 逐帧 +1、chunk index 逐块 +1；客户端 `ClientAssistantStream.acceptFrame`）。
  两条自保语义：**正文不逐帧透传**（流文本是协议标记，实时显示会闪现乱码）；**工具广告
  前收束 attempt**（广告是流中落盘的 assistant/message，落在活跃 attempt 内会被客户端
  fold 暂存进 pending 且 end 帧只消费一条结算 → 滞留到下一步触发 `events.restart()` 整窗
  重建）。发射异常熔断（本会话不再发），无端口/无监听器是 no-op——headless/离线零影响。

### Fixed（评审反馈）

- **评测产物 GBK 乱码**：`eval/tools/runner.cjs` 有 7 处输出文案、`eval/RESULTS.md` 有 10 行
  「cached 字段」取证行是早期 GBK 编码残留的替换字符（U+FFFD），grep 不到、无法检索。
  已还原为中文；并把 46 个 `metrics.json` 与 5 个 `summary.json` 里的同类 `note` 字段一并迁移
  （**只改文案，数字与口径未动**）。`runner.cjs` 的**代码注释**仍有历史乱码（不可逆，不影响执行），
  后续重写该文件时清理。
- **`gen-results.cjs` 覆盖证据文档**：它默认写 `eval/RESULTS.md`，而 §6（0.3.0 复算）是人工追加段，
  重跑新批次会整段丢失。新增 `--out <路径>`，并对「目标含 §6」直接拒写（需 `--force` 才覆盖）。
- **RESULTS.md 两处误读点**：`replay` 列改为 `metrics.json` 回填后的复算值（对照臂 10/10 PASS），
  并加注记说明与历史 FAIL 快照的区别；`stream/W1`、`stream/C2` 的 `exit=1` 行链到
  [docs/limitations.md](docs/limitations.md) 第 2 条（重入预算护栏耗尽，产物 checks 判 PASS，不是任务失败）。
- **`eval/GATE-0.3.0.md` 自相矛盾**：模板写「回退演练：已执行」但复选框是 `[ ]`，等于假记录。
  改为「未执行（待真机）」，与 G6 判定一致。
- **§6.1 的 `summary.json` 没写路径**：补成 `eval/runs/2026-11-15-v02/summary.json`（该文件本已入库）。

### Added

- **`eval/tools/machine-test.cjs`**：单项目实机对照——默认配置下「插件关 / 插件开」两臂各跑 1 次，
  自动 `summarize` + `gen-results --out`（不碰 `eval/RESULTS.md`），产出
  `eval/runs/<stamp>/machine-test-report.md`。支持 `--plan`（不读 key）/ `--report-only` / `--runs`；
  key 只进子进程环境变量，日志只印后 4 位。
- **`eval/machine-test-2026-11-17.md`**：本轮实机测试手册（两臂定义、命令、判读顺序、红线、故障排查）。

### Changed

- **CI 覆盖面**：`.github/workflows/ci.yml` 新增 `npm run check` 与 `npm run gate -- --offline`；
  `gate.mjs` 增加 `--offline`（只判 G1–G3：装配一致性 / 单 loop 权威 / 卸载原子）。
  G4（tag=package）只在发布提交上成立、G5/G6 需真机数据，故不进 CI，仍由发布流程与真机复测守。

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
