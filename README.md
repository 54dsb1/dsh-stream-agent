# dsh-stream-agent

![ci](https://github.com/54dsb1/dsh-stream-agent/actions/workflows/ci.yml/badge.svg)

![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)

|          |                                      |
| -------- | ------------------------------------ |
| 简体中文 | [English](./README.en.md)            |

**给 DeepSeek Harness 换一颗单流的心。** 把"模型看到什么、何时被打断"从回合制改成单流协议：
一次请求内写完全部操作命令，边流边执行，只在真正需要信息时才发下一次请求。

真连实测（10 任务、两臂同模型 `deepseek-flash`，2026-11-15-v02 批次，四分量口径由
`summarize.cjs` 复算）：**token 用量降到原生 loop 的 28.9%，任务正确性持平**。
历史批次的 22.3% 口径见 [eval/RESULTS.md](eval/RESULTS.md) §6 的如实说明——两批不可混用，
R3 重跑后以同批双臂复算为准。

|       |                                                                                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 宿主  | DeepSeek Harness `0.2.2-rc.1`（类型锚点）/ `rc.3`（运行时实测）                                                                                                     |
| 依赖  | 零 npm 依赖；Node ≥ 22.18（原生类型擦除）                                                                                                                           |
| 测试  | 329 用例全绿，零 API 调用（mock 全链路 + 20 个场景 + 装载/桌面页/新能力/会话格式/宿主一致性/截断与宿主契约冲突回归）                                                                              |
| 形态  | 单 bundle 包 + **专用 profile**（`profiles/stream` 模板）；`dsh plugin remove` 整层消失、宿主 loop 原子恢复                                                          |
| 控制栏 | `dsh-stream-agent bar`：四模式 + 中英切换 + 意图核对，装载时自动打印上手引导                                                                                       |
| 桌面页 | 客户端左侧栏「控制栏 / Control bar」：状态 + 四模式 + 中英切换，**不改 Electron 壳**                                                                               |
| 计量  | 四分量脚本出数 + 回放一致性对照臂 10/10 + 发布门禁 6 项                                                                                                             |
| 发布  | GitHub [Releases](https://github.com/54dsb1/dsh-stream-agent/releases) · npm `@hugesb/dsh-stream-agent` **尚未发布**（当前唯一安装路径见 §2）                                                      |

> **0.3.0 安装方式变更（重要）**：独立模式下本插件**只允许装进专用 profile**
> （`profiles/stream` / `profiles/stream-headless`）。0.2.x 的"plugin add 进既有
> profile"装法不再支持——安装前置校验会拒绝 `web` / `desktop`，双 loop 冲突以
> `E_DOUBLE_LOOP` 具名失败。迁移：删旧安装 → 建专用 profile → 重装（见 §2）。

---

## 1. 它解决什么问题

原生 loop 是回合制的：每一步发一次请求，工具结果全量塞回上下文，模型看完再决定下一步。
于是三件事同时发生——**请求次数多、观测重复回灌、前缀缓存被反复打断**。

本插件把这一层接管掉，只改三件事：

1. **单流** —— 模型在一次流里连续写完所有 `tf-*` 命令，解析器逐 chunk 解析、命令闭合即
   派发，独立命令并行执行，不等流结束。
2. **观测不回灌** —— 工具产出默认只回句柄，模型要细节就发 `tf-peek` 按行段取回。注入量
   从"我们猜"变成"模型自己要"。
3. **前缀单调** —— 上下文装配只做尾部追加，发请求前做逐字节断言，不单调就拒绝发送
   （fail-closed），宁可任务失败也不烧缓存。

不重训模型，不改上游源码，全部以 plugin entry + patch 形式存在。

## 2. 安装：专用 profile（唯一支持形态）

```bash
# 1) 复制专用 profile 模板（本地开发用 link:；npm 安装改精确版本号，不用 ^/~ 浮动范围）
cp -r profiles/stream ~/.dsh/profiles/stream

# 2) 安装前置校验（S2）：只读检查；目标必须是 stream / stream-headless
node scripts/install-check.mjs --profile ~/.dsh/profiles/stream --dry-run

# 3) 启动自证：装载横幅应含 TAKEOVER-ACTIVE … code=off … profile=stream
dsh --profile stream

# 4) 装卸回归（可选，10 轮 add → 自证 → remove → 恢复验证）
node scripts/install-cycle.mjs --dsh dsh --profile stream --rounds 10

# 卸载：bundle 层整层消失，宿主 loop 原子恢复；彻底移除删 profile 目录
dsh plugin remove @hugesb/dsh-stream-agent --profile stream
```

- headless 入口用 `profiles/stream-headless`（不引入 preset bundle：宿主 headless 无 preset
  registry，工具面由 profile 决定）。
- 组合顺序 `dsh-base → 主 bundle → preset bundle → 入口` 是契约，改变顺序视为装配变更需
  重新验收；完整说明见 [profiles/stream/README.md](profiles/stream/README.md)。
- `agent-loop` 的停用**只在主 bundle 的 cordis.patch.yml**——`plugin remove` 整层消失、
  卸载原子（C4）；profile 的 patch 层只承载 registry 默认值覆盖，永不接管 loop。
- 误装到 `web` / `desktop` 会被 `install-check` 拒绝；若绕过校验强行装入，宿主会以
  `E_DOUBLE_LOOP`（带 profile 标识与处置建议）具名失败——不静默共存（C2/S3）。
- `dsh plugin` 依赖 `pnpm` 在 PATH 中（或按 dsh-plugin-manager 配置 `pnpmCommand`）。
- **旧会话日志（0.2.x 及 0.3.0 发布前的产物）**：0.3.0 起修正了会话日志的 v4 工具生命周期
  写入——此前写出的日志在桌面端点开历史对话会报"会话加载失败"
  （`tool/call … has no advertised tool lifecycle`，宿主把整条日志判 corrupt，并非数据丢失）。
  升级后跑一次 `node scripts/repair-session-logs.mjs --write`（先不加 `--write` 看清单；
  写前自动备份 `.bak-<时间戳>`、写后清投影缓存），日志即可正常加载。

开发/验证用的临时叠加（不进 profile）仍可用：
`dsh --profile headless --patch ./patches/takeover.yml headless "任务"`。

## 3. 运行模式（控制栏四模式）

`dsh-stream-agent bar` 交互面板 / `dsh-stream-agent mode lean` / 桌面控制页三处同源
（同一份 `kernel/modes.ts`）。模式只提供默认值；**装配里显式写的配置永远压过模式**。

省多少、能不能用（口径如实：只有「默认参数 vs 原生 loop」有十任务两臂实测约 29%，
其余三档是方向性判断并明写"未单独实测"——不把没测过的数字写成百分比）：

| 模式 | 省 token | 可用性 | 标注 |
| --- | --- | --- | --- |
| `balanced`（默认） | 基准（约为原生 loop 的 29%） | 默认模式，装好即用 | tf-code 默认关闭（K1）；该省的省、该看的看得见 |
| `lean` | 较高（比默认更省） | 开箱可用 | 60k 阶梯 + 并行 2 + 不声明 tf-code；长会话差距最明显 |
| `compat` | 最低档（比默认略高） | 开箱可用 | 全文回验恢复、并行 1；即便如此仍低于原生 loop（单流协议本身在省） |
| `power` | 最高档（数据加工最省） | 需宿主 PTC runtime | **唯一显式开 tf-code 的模式**；普通读写反而略高于默认 |

模式 → 配置对应（改模式 = 改这些值；显式配置 > 模式 > 内置默认）：

| 模式 | `selfReadFeedback` | `enableCode` | `persistFallback` | 并行 | 重入 | `budgetTokens` |
| --- | --- | --- | --- | --- | --- | --- |
| `balanced` | `receipt` | `false` | `true` | 3 | 8 | — |
| `lean` | `receipt` | `false` | `true` | 2 | 6 | 60,000 |
| `compat` | `full` | `false` | `true` | 1 | 12 | — |
| `power` | `receipt` | `true` | `true` | 3 | 10 | — |

一句话决策：**默认 `balanced`；账单敏感换 `lean`；排障对照换 `compat`；写程序处理数据换 `power`。**

## 4. tf-* 协议（11 条命令）

语法权威是 `src/kernel/parser.ts`；完整闭环语义见 [docs/protocol.md](docs/protocol.md)。

| 命令 | 作用 | 结果去向 |
| --- | --- | --- |
| `tf-write` | 写文件（body = 正文原文） | 成功只记台账，失败注入 `[tf-stream:error]` |
| `tf-read` | 读文件（可 offset/limit 行段） | 首次/变化完整注入（≤8000 字符截断保头尾）；自写路径只回回执（行数+指纹，O7） |
| `tf-edit` | 精确替换（body 用 `<<<<<<< OLD` / `=======` / `>>>>>>> NEW` 标记块；映射宿主 edit） | 成功只记台账；匹配失败结构化报错，**不做模糊匹配、不静默改全文** |
| `tf-append` | 只追加（可选 anchor 锚点；映射宿主 edit / apply_patch 的 EOF 锚） | 成功只记台账；追加位置与换行规则确定 |
| `tf-grep` | 内容搜索（映射宿主 fs-search），只回匹配行（带行号） | 首次/变化完整注入；超限句柄化 |
| `tf-glob` | 文件名搜索，只回路径 | 同上 |
| `tf-bash` | 执行命令（Windows → pwsh） | 成功只记台账；要看输出用 `tf-peek` |
| `tf-peek` | 按句柄取回行段 | 按需注入 |
| `tf-plan` | 声明/修订计划与验收项（`- [id] 描述` 行） | 状态在驱动器侧，请求只注差分 |
| `tf-final` | 收尾（summary 必须含答案原文） | 有未验证验收项时判过早（F5） |
| `tf-code` | 程序化工具调用（**默认关闭**；`power` 或显式开启） | 上限内值完整注入；超限骨架+句柄；失败 `kind` + 可重试结论 |

公共属性：`id`（缺省自动编号）、`depends_on`（依赖，环会被检测并具名失败）、
`accepts`（验收关联，F5）。两条省 token 的纪律写在协议文本里：**不要读自己刚写过的文件**
（只回回执）、**不要用 tf-bash 做搜索**（tf-grep/tf-glob 更省且只回匹配行）。

## 5. 计划、恢复、长会话（默认开启，各有关闭点）

**计划与验收（F5）**——复合任务的完成判定，"声称完成但无回执"被结构性拦截：

```
<tf-plan id="p1">
- [a1] 生成 intro.md
- [a2] 生成 summary.md
</tf-plan>
<tf-write path="intro.md" id="w1" accepts="a1">…</tf-write>
```

- 验收项只能被**命令成功回执**（`accepts="..."`）验证——模型自述"已完成"不算证据；
- 全部验收项有回执后 `tf-final` 才会收敛，缺项/未验证注入过早提示引导补齐或修订计划；
- 计划状态放驱动器侧，请求**只注差分**（新计划全量一次，之后只注新增/已验证/已移除）；
- 关闭：`enablePlan: false`（tf-plan 命令级失败，accepts 忽略，tf-final 不做验收拦截）。

**恢复意图（F6）**——强杀后的诚实状态，零注入：

- 变更类命令（tf-write/tf-edit/tf-append）派发**前**把意图（op/path/内容指纹）fsync 落盘
  （`~/.dsh-stream-agent/intents/<session>.jsonl`），命令落定即写回执；
- 强杀（kill -9）三时点语义：写入前杀 = 未发生；写入中杀 = 不确定；写入后回执前杀 =
  文件已全量但账面"有意图无回执"——**不自动重放**；
- resume 发现"有意图无回执" → 回合直接 blocked（不发请求、零注入）；人工核对文件后
  `dsh-stream-agent intents`（列出 pending）→ `dsh-stream-agent intents --ack <session>` 闭合；
- 强杀演练（离线可跑）：`node eval/tools/f6-kill-drill.cjs --rounds 10` —— 10 轮 SIGKILL
  三时点，0 重放、0 重复写、三态可判定；
- 关闭：`enableIntents: false`；只告警不阻断：`resumeIntentPolicy: 'ignore'`。

**长会话段边界（F7）**——上下文体积有界（[ADR-001](docs/adr-001-segment-boundary.md)）：

- 追加区超 `segmentMaxChars`（默认 160k 字符 ≈ 40k tokens）时，在**新回合开始处**把旧段
  **整块丢弃**——不摘要、不改写历史（ADR 采纳"整块丢弃"路线、拒绝宿主压缩）；
- 被丢弃原文句柄化（`obs:read:seg-*`），`tf-peek` / `peekHandle()` 按行段回取；
- 代价如实陈述：丢弃后的第一条请求是缓存冷请求；发生时 policyLog + 台账显式记录，
  绝不静默；丢弃只落完整回合边界（工具调用与结果不被拆开）；
- 50 回合 × 2 请求实测：0 前缀违规、末/首请求 ≤1.5×；
- 关闭：`segmentMaxChars: 0`。

## 6. tf-code：默认关闭的可选通道（K1–K6）

- **开启**：`power` 模式，或装配 `enableCode: true`（前提：宿主挂载
  `@deepseek-ai/dsh-ptc-runtime`）。默认装配协议段 0 字符——模型不会幻觉调用；
  不做会话级动态开关（协议段构造期冻结）。
- **执行边界（如实声明，不承诺隔离/等权）**：沙箱只覆盖**文件效果**——程序可联网、可见
  进程；Windows 档报告 `enforcement=partial`（部分强制）；`danger-full-access` 下无约束。
  这些事实逐次记账（`mode` / `denied` / `enforcement`），账本与协议错误里 `partial` 显式可见。
- **失败语义（K3）**：八类 `kind` 原样保留（exception / timeout / abort / worker-exit /
  invalid-output / output-limit / protocol / sandbox-unavailable）+ 插件级 `quota-exceeded`；
  逐类给出可重试结论；沙箱拒绝 ≠ 代码错误，不引导改代码重试权限问题。
- **配额（K5）**：子调用 ≤64 次、输出 ≤256 KiB、墙钟 ≤300 s（`codeQuota` 可配）；
  超限结构化终止，不靠提示。
- **取消（K4）**：回合 signal 直通 resolve 与绑定调用；abort 后等待在途清理再收束；
  abort 与 timeout 分账。
- **结果可见性（F3）**：上限内（4000 字符）首成功/变化值完整注入——省一次 tf-peek 往返；
  超限转骨架 + 句柄，不恢复全量回灌。
- 真机五场景（成功/失败/取消/拒绝/partial）：
  [eval/tools/manual-code-scenarios.md](eval/tools/manual-code-scenarios.md)。

## 7. 计量与评测（数字怎么来的）

工具链全部零 API 依赖、可复算；真机批次由人工执行
（命题清单见 [docs/TEST-PROPOSITIONS.md](docs/TEST-PROPOSITIONS.md)，≈2 元/命题）。

| 工具 | 用途 | 当前证据 |
| --- | --- | --- |
| `eval/tools/summarize.cjs` | M1 四分量汇总（输入/缓存读/缓存写/输出；缺失分量标"不可得"） | 2026-11-15-v02 stamp：基线 446,410 → 插件 129,178（28.9%），逐任务见 summary.json |
| `eval/tools/replay-check.cjs` | M3 回放一致性（重放树哈希 == 实跑树哈希） | 对照臂 **10/10**（修复属性序敏感与增量字段名两个根因后）；基线臂取证面受限如实标注 |
| `eval/tools/t3-cells.cjs` | M2 T3 三格（B / A-1a / A-1b 首请求拆分归因） | 脚本 + 三臂 patch 就绪；tf-code 段实测 1,175 字符；三格数字待同批真机 |
| `eval/tools/runner.cjs` | R3 评测矩阵（双臂 10 任务 + 哨兵） | 0.3.0 重跑待真机（新协议面） |
| `eval/tools/f6-kill-drill.cjs` | F6 强杀演练（SIGKILL × 10 轮 × 三时点） | 离线已跑：0 重放、0 重复写、三态可判定 |
| `npm run check` | R2 装配与文档一致性（entry 集/inject/顺序/README 命令表 4 项） | 一条命令复跑 |
| `npm run gate` | R4 发布门禁（C1/C2/C8/C9 + 装配一致 + 回退演练） | 离线项就地判定；真机项（G5/G6）如实标待复测，未过不发布 |

口径纪律：单位任务 token = Σ(input + cacheRead + cacheWrite + output)（四分量，逐请求
usage 原文留存可复算）；缓存分量缺失标"不可得"不按 0 计；标题旁路请求两臂同剔；
二分量只能作参考并显式标注。

## 8. 控制栏与桌面页

- **装载横幅**：stderr 打印引导面板（接管状态 / 当前模式 / 上手四步 / 意图提示），
  `announce: true` 给每个 entry 打 mounted 行——排障时插件自证已装载。
- **CLI**（`dsh-stream-agent`）：
  - `bar` 交互面板：1-4 切模式、↑↓ 移动、`l` 中英切换、`?` 全模式指南、`r` 重置、`q` 退出；
  - `status` / `mode <balanced|lean|compat|power>` / `lang <zh|en>` / `--json`；
  - `intents` 列出各会话"有意图无回执"（F6 停机核对）；`intents --ack <session>` 人工确认后闭合；
  - `help` 全模式指南。
- **桌面页**：客户端左侧栏「控制栏 / Control bar」——接管状态、当前模式与来源、六个生效
  参数、四张模式卡（"什么时候选 / 代价" + 省 token 档位 + 可用性标注）、中英切换；
  写路径经 `streamAgentRuntime` 服务回 loop（内存 + `control.json` 单一事实源），
  多窗口并发栅栏（409），装配/环境变量锁定的控件置灰，loop 未接管时只读降级。
- **状态落盘**：`<stateDir>/control.json`，优先级 `装配 config > STREAM_AGENT_MODE/LANG >
  control.json > 内置默认`；坏文件告警回默认，绝不阻断装载。

## 9. 目录结构

```
dsh-stream-agent/
├── src/
│   ├── kernel/            # 内核：parser / render / obs / gate / state / modes / control-bar
│   │                      #   （零依赖、无 IO、可独立单测）
│   └── entry/             # Cordis 薄壳：loop（驱动器+工厂）/ ptc-bridge / intent-log /
│                          #   json-persistence / state-handle / obs-broker / action-gate /
│                          #   context-render / eval-probe / mock-provider / control-bar* /
│                          #   cordis-compat / takeover-registry
├── ui/                    # 桌面控制页子包（独立 dsh.client；主包不得声明）
├── dist/                  # 构建产物（25 个文件，提交入库，patch 直接引用）
├── profiles/
│   ├── stream/            # S1 专用 profile 模板（web 入口 + registry 默认值覆盖）
│   └── stream-headless/   # S1 headless 入口变体
├── preset/stream/         # S4 preset-stream 独立 bundle（映射工具面；不进主 bundle patch）
├── patches/               # 开发/评测组合补丁（takeover / eval-baseline / eval-stream /
│                          #   eval-stream-code-on / eval-stream-code-off）
├── eval/                  # METRICS（口径）/ RESULTS（数字）/ tasks / tools
│                          #   （runner / summarize / replay-check / t3-cells / f6-kill-drill）
├── docs/                  # protocol / limitations / architecture / adr-001 /
│                          #   disabled-lines-audit / v0.4.0-plan / TEST-PROPOSITIONS
├── scripts/               # build / check-consistency / gate / install-check / install-cycle /
│                          #   repair-session-logs / release
└── test/                  # 329 用例（kernel 2 套 + entry 21 套 + 20 mock 场景；零 API）
```

## 10. 开发

```bash
npm test          # 329/329，零 API 调用
npm run build     # 产出 dist/ 25 个文件 + 全量 smoke import + 桌面页构建闸门
npm run check     # R2：装配与文档一致性 4 项
npm run gate      # R4：发布门禁 6 项（真机项如实标待复测）
node eval/tools/f6-kill-drill.cjs --rounds 10   # F6 强杀演练（离线，零 API）
npm run release:dry
```

## 11. 文档索引

| 文档 | 内容 |
| --- | --- |
| [docs/protocol.md](docs/protocol.md) | 协议语法与闭环语义（11 条命令 + F5/F6/F7 语义） |
| [docs/limitations.md](docs/limitations.md) | 已知限制（按"你会不会踩到"排序，每条带取证） |
| [docs/adr-001-segment-boundary.md](docs/adr-001-segment-boundary.md) | 长会话段边界 ADR（整块丢弃 vs 宿主压缩的决策） |
| [docs/disabled-lines-audit.md](docs/disabled-lines-audit.md) | 禁用行审计表（S5：每条停用/保留的依据） |
| [docs/v0.4.0-plan.md](docs/v0.4.0-plan.md) | 0.4.0 规划条目实施对照（F5–F7 已随 0.3.0 落地） |
| [docs/TEST-PROPOSITIONS.md](docs/TEST-PROPOSITIONS.md) | 人工测试命题与提示词（≈2 元/命题，复测用） |
| [profiles/stream/README.md](profiles/stream/README.md) | 专用 profile 的安装/选择/卸载/回退 |
| [eval/RESULTS.md](eval/RESULTS.md) · [eval/METRICS.md](eval/METRICS.md) | 评测数字与口径（全部可复算） |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 提交纪律（R1：逐版独立提交、tag、CHANGELOG 段） |

## 12. 已知限制（摘要）

完整清单见 [docs/limitations.md](docs/limitations.md)（按"你会不会踩到"排序），要点：

1. **写批任务**用满重入预算时进程 `exit=1` 但产物正确——护栏语义是"预算耗尽"而非"任务失败"。
2. **tf-code 沙箱只覆盖文件效果**：程序可联网、可见进程；Windows 档 `partial`；
   `danger-full-access` 无约束——使用前自己确认后果。
3. **段边界缓存重置**：丢弃旧段后的第一条请求是缓存冷请求（"整块丢弃"路线的固有代价）。
4. **原生 loop 臂的回放取证受限**：v4 session log 中 write 调用不可解析（如实标注"不可回放"，
   写入正确性由 checks 判定）。
5. **多任务排队 + 段边界**：连续 `pushUserTask` 时段边界取最后一个任务块；需要跨任务上下文
   请合并为一条任务文本。

## License

Apache-2.0
