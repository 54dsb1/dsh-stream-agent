# dsh-stream-agent

![ci](https://github.com/54dsb1/dsh-stream-agent/actions/workflows/ci.yml/badge.svg)
![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)

简体中文 · [English](./README.en.md)

**给 DeepSeek Harness 换一颗单流的心。** 把"模型看到什么、何时被打断"从回合制改成单流协议：
一次请求内写完全部命令、闭合即派发、独立命令并行；工具结果默认只回句柄，要细节按行段取回；
上下文只追加、不改写，发请求前做逐字节前缀断言。

| 项 | 值 |
| --- | --- |
| 当前版本 | `0.5.0`（协议规范 v1.5.0，见 [PROTOCOL-v1.md](./PROTOCOL-v1.md)） |
| npm | [`@hugesb/dsh-stream-agent`](https://www.npmjs.com/package/@hugesb/dsh-stream-agent) |
| 宿主 | DeepSeek Harness ≥ `0.2.2-rc.1`（类型锚点 / 运行时实测 rc.3） |
| 运行时 | Node ≥ 22.18（原生类型擦除，零 npm 依赖） |
| 测试 | 623 用例 / 622 通过 / 0 失败 / 1 预置跳过（零 API） |
| 构建 | `dist/` 39 个文件（提交入库，patch 直接引用 `../dist/`） |
| 许可 | Apache-2.0（第三方归属见 [NOTICE](./NOTICE)） |

---

## 快速开始

**正式形态：装进专用 profile**（本插件只允许装进 `stream` / `stream-headless`，误装 `web` / `desktop`
会被前置校验拒绝，绕过则以 `E_DOUBLE_LOOP` 具名失败——不静默共存）：

```bash
cp -r profiles/stream ~/.dsh/profiles/stream                  # 1) 复制模板（本地开发用 link:）
node scripts/install-check.mjs --profile ~/.dsh/profiles/stream --dry-run   # 2) 只读前置校验
dsh --profile stream                                          # 3) 启动自证：stderr 出现 TAKEOVER-ACTIVE … profile=stream
dsh plugin remove @hugesb/dsh-stream-agent --profile stream   # 卸载：bundle 整层消失，宿主 loop 原子恢复
```

headless 入口用 `profiles/stream-headless` 模板（不引 preset bundle）。装卸回归演练（可选）：
`node scripts/install-cycle.mjs --dsh dsh --profile stream --rounds 10`。

**零安装试跑**（`--patch` 临时叠加，不改 profile、命令结束即失效；只验"接管 + 协议 + 单流执行"，
不带四个 sidecar）：

```bash
export DEEPSEEK_API_KEY=sk-...            # 唯一必需凭据
cd <本包根目录>
dsh --profile headless --patch ./patches/takeover.yml headless "在当前目录建 hello.txt，写一行 hello，再读回来确认"
dsh-stream-agent bar                      # 想先调上限再跑任务：按 u 进入上限编辑
```

**评测对照**（四臂 = L0 原生 / L1 仅 PTC / L2 本插件·A / L3 本插件·B；缺凭据时 `exit 3` 不写结论）：

```bash
node eval/tools/four-arm-real.mjs --plan                    # 只打印将执行的命令，零请求
DEEPSEEK_API_KEY=... node eval/tools/four-arm-real.mjs --stamp 2026-11-24
```

---

## 工作原理

插件用两条**正交轴**描述自己：**执行通道**决定"命令怎么执行"，**上下文档位**只提供参考数值。

| | 标准通道 `standard`（A） | PTC兼容模式 `code`（B） |
| --- | --- | --- |
| 模型侧入口 | `tf-*` 命令（逐条 XML 标签） | 单一 `run_code` 程序（或受限的 `tf-code`） |
| 谁执行 | 插件驱动器：解析 → 派发 → 映射宿主工具 | `preset` 来源：宿主 PTC 全权；`bridge` 来源：插件窄桥 |
| 协议注入 | 8 段基础协议（full 实测 3,673 字符） | `preset` 0 字符（完全让位）；`bridge` 222 + 117 字符 |
| 验收闸 | 有（`tf-plan` + `accepts` 回执 + 过早 final 拦截） | 无（流正常终止且无事由即完成） |
| 适用 | 日常读写改查、需要"可验收"的任务 | 多步数据加工、批处理、写程序算 |

**B 模式来源判定是显式优先**：`codeChannelSource: 'preset' | 'bridge'` 直接钉死；`'auto'` 时先探测
宿主 PTC preset 工具面、再探测 `ctx.ptcRuntime`。探测是**惰性实时**的——会话创建与切换通道时
现取宿主服务重新判定，PTC preset 按窗口/会话后挂载也能进入；两种来源都没有 → **拒绝进入并回退
A**（不静默降级）。`bridge` 来源支持 `sandbox_permissions` **单次提权**（与 `justification` 成对，
经宿主审批，只覆盖本次执行）。

**上下文治理**（两条通道共用）：观测句柄化（大结果只回句柄 + 摘要，`tf-peek` 按需取回）、
span 账本去重、行锚索引、确定性压缩、效果折叠、计划性换基、前缀逐字节断言——前缀不单调在
发送前**接受为缓存重置点**继续对话：同一份请求照常发送（0 额外请求 / 0 注入文本），基线随本
请求推进，后续请求恢复单调、缓存恢复命中；仅显式 `prefixPolicy: 'fail'` 保留拒发 + 同轮自动
续跑 ≤2 次。

**wire 传输面**（对齐 thinkflow 的请求装配语义，数值默认即 thinkflow 出厂预设，随时可改）：

| 设置 | limits 键 | 默认（thinkflow 预设） | 行为 |
| --- | --- | --- | --- |
| 输出预算 | `maxTokens` | `0` | `>0` 时请求携带 `max_tokens`；`0` = 委托给 provider，不发字段 |
| 思考预算 | `thinkingBudget` | `0` | `>0` 时请求携带 `thinking.budget_tokens`（≥1024 才生效） |
| 思考形态 | `thinkingMode`（装配） | `disabled` | `enabled` 或 provider 特定 type → 请求携带 `thinking`；`enabled` 且未显式给 effort 时取 `high` |
| 流式用量 | `streamUsage` | `0` | `1` → 请求携带 `stream_options: {include_usage: true}` |
| 建连重试 | `maxRetries` / `retryBackoffMs` | `2` / `1000` | 连接建立失败按预算重试（只覆盖建连，流中途错误不重试——半截流重发会重复计费） |

原生工具声明在面内 → 请求携带 `tools` + `tool_choice: 'auto'`；未声明 → 两者都不发。
传输设置在**每个请求发送前**从生效 limits 逐项组装，控制面板 / `limits --set` / 装配 config
改完即生效（下一个请求就带着新值）。

**推理回传策略**（`reasoningStrategy`，装配 config；`status --json` 可见）：

- `provider-required`（默认）：assistant 消息按宿主原样携带 source（含 provider 会话续传状态）。
- `drop-stale`：保留 source 壳、**剥离 replayState**——推理/回放状态绝不回传，请求纯文本、
  每请求无状态（thinkflow 等价语义：靠前缀单调续缓存，不靠 provider 会话续传）。

**安全**：默认密钥保护拒读 `.env` / `*.pem` / `*.key` 等 15 类敏感文件（结构化失败 `[secret]`），
模型可见输出在登记前脱敏（密钥类赋值 → `[REDACTED]`）；变更类命令写前落意图（fsync），
强杀三时点语义明确，resume 发现"有意图无回执" → 回合 `blocked`，人工 `intents --ack` 闭合。

---

## 配置面

**默认数值面 = thinkflow 对齐层**（映射自 thinkflow 出厂预设）：
`keepRecent=30` / `maxSummaryChars=16000` / `maxReadChars=200000` / `maxReentries=8`，加传输五键
（见上表）。**轮数上限（maxSteps）一律不预设**——插件永不替你决定"干到多少轮算够"；
未设 = 不限制（`0` = 显式不限制），用户显式定义的键逐项覆盖默认层。

### 三个行为开关

`contextFold`（上下文折叠，默认开）/ `finalCheck`（流末验收，默认开；PTC兼容模式置灰）/
`contextRaw`（上下文原样 = 完全不处理，默认关；开启时强制停用压缩/折叠/去重/截断，预算类 limits 仍生效）。
入口：终端 `f` / `v` / `x`，`dsh-stream-agent fold|final|raw on|off|toggle`，装配 config，桌面页。

### 用户上限（29 个键）

```bash
dsh-stream-agent limits                                   # 列出 29 个键与当前值
dsh-stream-agent limits --set maxTokens=8192,maxRetries=3
dsh-stream-agent limits --replace codeMaxWallMs=120000    # 整组替换
dsh-stream-agent limits --reset
STREAM_AGENT_LIMITS="maxTokens=8192;keepRecent=50" dsh ...   # 一次性试跑，不写盘
```

按组摘录（全表见 [docs/limits.md](docs/limits.md)）：

| 组 | 键（未设时行为） |
| --- | --- |
| 预算 | `maxSteps` / `maxInputTokens`（触顶压缩）/ `observeBudgetTokens`（只观测） |
| 取回 | `peekBudgetChars` / `peekAnchorEvery`（未设 200）/ `maxReadChars` / `readFeedbackLimit` / `readFeedbackBudgetPerRequest` / `codeValueInjectLimit` / `nativeResultLimit` |
| 压缩 | `keepRecent` / `maxSummaryChars` / `segmentMaxChars`（未设不切段）/ `effectElisionKeepRecent` |
| 换基/重入 | `maxRebasesPerTurn` / `maxRebasesPerSession`（`0` = 禁止换基）/ `maxReentries` / `stallReentries` / `closeOutRequests` |
| 执行 | `maxParallelToolCalls`（未设 3，调度常量非任务上限）/ `maxParallelBindings` |
| 传输 | `maxTokens` / `thinkingBudget` / `streamUsage`（0=关 1=开）/ `maxRetries` / `retryBackoffMs` |
| 代码 | `codeMaxSubcalls` / `codeMaxOutputBytes` / `codeMaxWallMs` |

三级来源（低 → 高）：`control.json` < `STREAM_AGENT_LIMITS` < 装配 `config.limits`；再叠
`limitsByChannel` / `limitsByTier` 与运行期 `setLimits()`。**改上限不抹通道，改通道不抹上限。**

"不设上限"不会无限打转——收敛靠**信息面判据**：同一拒绝事由已提示过且此后零新增 ok 命令 →
不再重复注入，本步收场 `blocked`；同一撞墙事由只收束一次；做了新工作则判据不成立、照常重新提示。
"不限制"只是把次数交给你，插件保留的是"同一句话不说第二遍"——那是去重，不是上限。

---

## 命令参考：17 条命令

语法权威是 `src/kernel/parser.ts`（`COMMAND_NAMES`）；闭环语义见 [docs/protocol.md](docs/protocol.md)。

| 命令 | 作用 | 结果去向 |
| --- | --- | --- |
| `tf-write` | 写文件（body = 正文原文） | 成功只记台账；失败注入 `[tf-stream:error]` |
| `tf-read` | 读文件（可 `offset`/`limit`） | 首次/变化完整注入；自写路径默认同样全文注入 |
| `tf-edit` | 精确替换（`OLD`/`NEW` 三段式） | 成功只记台账；匹配失败结构化报错，不模糊匹配 |
| `tf-append` | 只追加（可选 `anchor`） | 成功只记台账 |
| `tf-grep` | 内容搜索，只回匹配行（带行号） | 首次/变化完整注入；超限句柄化 |
| `tf-glob` | 文件名搜索，只回路径 | 同上 |
| `tf-bash` | 执行命令（Windows → `pwsh`） | 成功只记台账；要看输出用 `tf-peek` |
| `tf-peek` | 按句柄取回（行段 / 符号 / `offset` / `query`） | 按需注入；未命中给 top-3 候选 |
| `tf-plan` | 声明/修订计划与验收项（`- [id] 描述`） | 状态在驱动器侧，请求只注差分 |
| `tf-final` | 收尾（`summary` 含答案原文） | 有未验证验收项时判过早；流末正文即可同轮交付 |
| `tf-code` | 程序化工具调用（A 模式默认关闭；B 模式主要入口） | 上限内值完整注入；超限骨架 + 句柄 |
| `tf-ask` | 阻塞式提问（`q` 必填） | 回答完整注入 |
| `tf-skill` | 装载技能（`name` = 技能名） | 技能说明完整注入 |
| `tf-call` | 通用调用通道：`name` = 宿主工具名，body = JSON 参数 | 按宿主工具分族（读类注入、写类回执） |
| `tf-changes` | 变更回执目录（可加 `path` 过滤） | 结果完整注入（id/状态/可否回滚/expected 哈希） |
| `tf-diff` | 某次回执的快照 diff（`change` = 回执 id） | 结果完整注入 |
| `tf-revert` | 守卫式回滚（`change` + `expected` 双重校验） | 恢复 before 内容；undo 回执登记；冲突结构化失败 |

公共属性：`id`（缺省自动编号）、`depends_on`（成环具名失败）、`accepts`（验收关联）。
两条协议纪律：**不要读自己刚写过的文件**、**不要用 `tf-bash` 做搜索**。
`tf-write` / `tf-edit` / `tf-append` 成功后自动登记可回滚的变更回执（快照持久化在模型输入之外）。

**协议注入成本**（源文本实测字符数，非 token 折算）：`protocolLevel: 'full'`（默认）3,673 →
`lean` 3,161 → `minimal` 2,283 → `minimal` + 关计划段 1,998。三个可选增强段（v11/v12/v14/v15）
默认不进装配。预览与统计：

```bash
dsh-stream-agent protocol --stats-only                 # 逐段字符数 + 总量
dsh-stream-agent protocol --level minimal --no-plan    # 预览瘦身
```

---

## 控制面

三个入口操作同一份 `<stateDir>/control.json`（原子写盘，坏文件告警回默认、绝不阻断装载）：

- **终端交互栏**：`dsh-stream-agent bar`——`1-5` 选通道/档位、`c`/`t` 快切、`u` 编辑上限、
  `f`/`v`/`x` 切开关、`l` 中英、`?` 指南、`r` 重置、`q` 退出。
- **CLI 子命令**：`channel` / `tier` / `fold` / `final` / `raw` /
  `lang` / `limits` / `intents` / `protocol` / `status --json` / `help`。
  例：`dsh-stream-agent channel code && dsh-stream-agent status --json`。
- **桌面控制页**：左侧栏「控制栏」——接管状态、通道与来源、生效参数、通道/档位卡、
  29 键编辑区（留空 = 未设，含传输组）、开关区块（PTC兼容模式验收闸置灰）、宿主 preset 名册只读展示、中英切换。
  写路径经 runtime 回 loop，多窗口并发 409 冲突提示刷新，装配锁定的控件置灰，未接管时只读降级。

**装配里显式写的配置永远压过面板选择。**

---

## 质量门禁

```bash
npm test          # 623 用例 / 622 通过 / 1 预置跳过（零 API；node --test 原生 TS 类型擦除）
npm run build     # dist/ 39 个文件 + 全量 smoke import
npm run check     # 装配与文档一致性 7 项（entry 集 / inject / 装载顺序 / README 命令表 /
                  #   命令表 ≤17 上限 / preset ↔ 矩阵一致 / NOTICE 两栏制）
npm run gate -- --offline   # 发布门禁离线三项（G1–G3）；真机项如实标待复测
npm run release:dry         # 发布演练
```

构建是**纯类型擦除**（不做类型检查）——未声明变量只会在运行时炸；改完 `src/` 必须重跑
`npm run build`（`dist/` 入库且被 patch 直接引用，CI 校验 src ↔ dist 同步）。

```
src/kernel/   零依赖、无 IO：parser / render / obs / gate / state / limits / control-bar /
              protocol / compaction / assembly / changes / change-store / security / delivery ...
src/entry/    Cordis 薄壳：loop（驱动器）/ ptc-bridge / intent-log / json-persistence /
              control-state / control-session / control-bar-cli / obs-broker / context-render /
              tool-surface / ra0-probe ...
ui/           桌面控制页子包（独立 dsh.client）  dist/  构建产物（入库）
profiles/ preset/ patches/ eval/ docs/ scripts/ test/
```

---

## 已知边界（逐条核实）

只写能在代码里指出位置的问题。

| 面 | 事实 |
| --- | --- |
| 证据面 | 四臂 benchmark / R3 双臂 / 真机五场景数据未在本 README 回填；本文不写任何"省 X%"结论 |
| 执行面 | B 模式 `preset` 来源下插件完全不执行代码；B 模式无验收闸；单次提权说明只在可选 v14 段（默认不注入）；沙箱只覆盖文件效果、Windows 档 `partial` |
| 传输面 | max_tokens / stream_options / thinking 等字段经宿主 `llm.stream` 透传——宿主识别即落到 HTTP body，不识别则忽略；插件控制的是请求装配与取值，不直连 HTTP |
| 语义面 | `tf-plan` 验收项只存内存（resume 后要重新声明）；协议档位构造期冻结（改了要新会话）；不提供 `tf-python` 与 diff 统计（用 `tf-bash python3` / `git diff --stat`） |
| 文案面 | 两处协议稳定前缀文本与实际行为不一致（自读回执 vs 全文回灌；`tf-final` 必需 vs 同轮交付）——改动会推翻前缀断言与金样，属协议版本升级，暂列不改 |
| 显示面 | 实时帧只送思考过程，正文在该步落盘后一次性出现 |

收敛、恢复、长会话语义详见 [docs/limitations.md](docs/limitations.md)。

---

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [PROTOCOL-v1.md](PROTOCOL-v1.md) | 协议规范（命令 / 属性 / 增强段，含 `sandbox_permissions`） |
| [docs/protocol.md](docs/protocol.md) | 协议语法与闭环语义 |
| [docs/limits.md](docs/limits.md) | 29 键全表、三级来源、结构性收敛、开关 |
| [docs/channel-matrix.md](docs/channel-matrix.md) | 通道 × 档位能力矩阵 |
| [docs/porting-matrix.md](docs/porting-matrix.md) | thinkflow 47 模块处置 + PTC 契约对齐 |
| [docs/architecture.md](docs/architecture.md) | 分层与装配（kernel 零 IO / sidecar 顺序） |
| [docs/limitations.md](docs/limitations.md) | 已知限制长清单 |
| [docs/adr-001-segment-boundary.md](docs/adr-001-segment-boundary.md) / [adr-002-change-commands.md](docs/adr-002-change-commands.md) | 段边界 / 变更命令 ADR |
| [eval/METRICS.md](eval/METRICS.md) · [eval/RESULTS.md](eval/RESULTS.md) | 计量口径与实测数字 |
| [profiles/stream/README.md](profiles/stream/README.md) | 专用 profile 安装 / 卸载 / 回退 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 提交纪律 |

## License

Apache-2.0。第三方归属与派生声明见 [NOTICE](./NOTICE)（thinkflow 派生 / PTC 依赖分栏制）。

---

## 各模式下的参与边界

逐条声明插件在每种形态下**对任务和对话各参与了什么、不参与什么**——以代码为准
（`src/entry/loop.ts`、`src/entry/ptc-bridge.ts`、`src/entry/tool-surface.ts`）。

**标准通道（A，`standard`）**——插件深度参与全程：

| 参与面 | 插件做什么 |
| --- | --- |
| 请求装配 | 全权装配模型看到的每个请求：8 段协议注入、`tf-*` 工具面声明、块序与系统提示、逐字节前缀断言 |
| 命令执行 | 解析流内 XML 命令 → 独立命令并行派发 → 映射宿主工具执行 → 结果句柄化（大结果只回句柄 + 摘要） |
| 上下文治理 | span 账本去重、行锚索引、确定性压缩、效果折叠、`tf-peek` 按需取回、计划性换基；前缀不单调在发送前接受为缓存重置点继续对话 |
| 验收 | `tf-plan` 声明 + `accepts` 回执 + 过早 `tf-final` 拦截；未达标不收场 |
| wire 传输字段 | 每请求从生效 limits 组装 `max_tokens` / `thinking` / `stream_options` / `tool_choice` / 建连重试 |
| 推理回传 | `reasoningStrategy` 决定 assistant source 是否携带 replayState（`drop-stale` 剥离） |
| 交付与台账 | 兜底交付（收场写事实消息，不伪造结论）、意图台账、变更回执与守卫式回滚（`tf-changes` / `tf-diff` / `tf-revert`） |
| 计量 | 七列尺子（请求/段级，外部可复算） |

**PTC兼容模式（B，`code`）· preset 来源**——模型侧入口是宿主 PTC 的单一 `run_code`，
插件**让位执行、保留装配**：协议段 0 字符，代码执行与沙箱完全归宿主 PTC，无验收闸；
插件仍然负责：单流驱动与消息装配、上下文治理（同 A 表全部条目）、wire 传输字段、
推理回传策略、兜底交付与意图台账、请求级计量。代码本身插件不解析、不执行、不接触。

**PTC兼容模式 · bridge 来源**——宿主只有 `ctx.ptcRuntime` 服务缝时走插件窄桥：
协议段 222 + 117 字符，插件解析并执行受限 `tf-code`（受 `codeMaxSubcalls` /
`codeMaxOutputBytes` / `codeMaxWallMs` 三配额约束），支持 `sandbox_permissions`
单次提权（与 `justification` 成对，经宿主审批）。其余参与面同 A。

**控制面（两通道共用，不参与对话内容）**：控制栏 / CLI / 桌面控制页只读写控制状态——
执行通道、上下文档位（仅参考值）、语言、29 键上限（含 wire 传输组）、三个行为开关——
经 `control.json` 落盘，装配 config / 环境变量 / 文件三层合并，插件不往对话里注入任何
控制面文本。

## 致谢

本插件自 [xuxiang/thinkflow](https://github.com/xuxiang/thinkflow) 派生而来（MIT，Copyright (c) 2026 沐雪清泽）：
`tf-*` 命令族语义基、解析器、压缩与取回策略、单流"前缀单调 + 命令闭包即派发"骨架均移植自
thinkflow（Python → TypeScript 语义重写，逐模块清单见 [docs/porting-matrix.md](docs/porting-matrix.md)）。

thinkflow 的出厂预设是本插件**默认数值面与 wire 传输面的直接来源**：`keepRecent=30`、
`maxSummaryChars=16000`、`maxReadChars=200000`、`maxReentries=8`，以及 `max_tokens` /
`thinking.budget_tokens` / `stream_options.include_usage` / 建连重试的请求组装语义——
插件开箱即呈现 thinkflow 的行为面，用户可随时逐项覆盖。双通道化、控制面与上下文治理
增强为本插件自有工作，与上游无关。

感谢沐雪清泽与 thinkflow 社区。完整归属与派生声明见 [NOTICE](./NOTICE)。
