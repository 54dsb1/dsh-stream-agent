# dsh-stream-agent

![ci](https://github.com/54dsb1/dsh-stream-agent/actions/workflows/ci.yml/badge.svg)

![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)

|      |                           |
| ---- | ------------------------- |
| 简体中文 | [English](./README.en.md) |

**给 DeepSeek Harness 换一颗单流的心。** 把"模型看到什么、何时被打断"从回合制改成单流协议：一次请求内写完全部操作命令，边流边执行，只在真正需要信息时才发下一次请求。

真连实测（10 任务、两臂同模型 `deepseek-flash`）：**token 用量降到原生 loop 的 28.9%，任务正确性持平（10/10）**。

|     |                                                                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 宿主  | DeepSeek Harness `0.2.2-rc.1`（类型锚点）/ `rc.3`（运行时实测）                                                                                                                |
| 依赖  | 零 npm 依赖；Node ≥ 22.18（原生类型擦除）                                                                                                                                     |
| 测试  | 255 用例全绿，零 API 调用（mock 全链路 + 20 个场景 + 装载/桌面页回归）                                                                                                                       |
| 形态  | 单个 bundle 包，`dsh plugin add` 一条命令装卸，卸载即回原生 loop                                                                                                                   |
| 控制栏 | `dsh-stream-agent bar`：四个模式 + 中英切换，装载时自动打印上手引导                                                                                                                    |
| 桌面页 | 客户端左侧栏「控制栏 / Control bar」：状态 + 四模式 + 中英切换，**不改 Electron 壳**                                                                                                      |
| 发布  | npm [`@hugesb/dsh-stream-agent`](https://www.npmjs.com/package/@hugesb/dsh-stream-agent) · GitHub [Releases](https://github.com/54dsb1/dsh-stream-agent/releases) |

> **npm 源公告**：`v0.2.1` 的 npm 源**最多 3 天内可用**（即 2026-11-19 前；发布即在  
> [`@hugesb/dsh-stream-agent`](https://www.npmjs.com/package/@hugesb/dsh-stream-agent) 更新）。  
> 在此之前请用**仓库绝对路径**或 GitHub Release 的 tarball 安装；发布后  
> `dsh plugin --profile desktop add @hugesb/dsh-stream-agent@0.2.1` 可直接安装。  
> 0.2.0 在 dsh 里装载失败（根因与修复见下方「v0.2.1：0.2.0 为什么不能用」一节），不建议再装 0.2.0。



---

## 它解决什么问题

原生 loop 是回合制的：每一步发一次请求，工具结果全量塞回上下文，模型看完再决定下一步。于是三件事同时发生——**请求次数多、观测重复回灌、前缀缓存被反复打断**。

本插件把这一层接管掉，只改三件事：

1. **单流** —— 模型在一次流里连续写完所有 `tf-*` 命令，解析器逐 chunk 解析、命令闭合即派发，并行执行，不等流结束。
2. **观测不回灌** —— 工具产出默认只回句柄，模型要细节就发 `tf-peek` 按行段取回。注入量从"我们猜"变成"模型自己要"。
3. **前缀单调** —— 上下文装配只做尾部追加，发请求前做 hash 断言，不单调就拒绝发送（fail-closed），宁可失败也不烧缓存。

不重训模型，不改上游源码，全部以 plugin entry + patch 形式存在。

## 安装

```bash
# 方式一：bundle 安装（推荐，进 profile，重启后生效）
dsh plugin --profile headless add @hugesb/dsh-stream-agent

# 方式二：临时叠加（开发/验证用，不进 profile，命令结束即失效）
dsh --profile headless --patch ./patches/takeover.yml headless "你的任务"

# 方式三：桌面客户端（装入 desktop profile 后重启客户端，bundle 无 HMR）
dsh plugin --profile desktop add @hugesb/dsh-stream-agent
```

npm 源未上线前的等价写法（把包名换成仓库绝对路径）：

```bash
dsh plugin --profile desktop add /绝对路径/dsh-stream-agent
dsh-stream-agent status          # 确认装载到的是 0.2.1
```

离线或改本地源码时同理。卸载：`dsh plugin --profile <name> remove @hugesb/dsh-stream-agent`，  
或不挂 patch——接管层整体消失，回到原生行为，零残留。

> `dsh plugin` 依赖 `pnpm` 在 PATH 中（或按你的 dsh-plugin-manager 配置 `pnpmCommand`）。  
> 装完先跑一次 `dsh-stream-agent status`：能打印模式行就说明 CLI 与状态文件都就位。

<a id="control-bar"></a>

## 控制栏：先看这一节

控制栏是 0.2.1 给新用户加的**三个面**，同一份状态、同一份文案：

> 别把「安装方式」和「运行模式」混在一起：bundle / 临时 overlay / desktop 是**装载方式**（见上一节的三条安装命令），  
> balanced / lean / compat / power 是**运行模式**（本节四个）。两者正交——同一套装法可以随时换模式。

| 面                          | 什么时候出现           | 用来干什么                |
| -------------------------- | ---------------- | -------------------- |
| 装载横幅                       | 插件装载时打一遍（stderr） | 证明"接管生效"、报当前模式、给上手四步 |
| 交互栏 `dsh-stream-agent bar` | 随时手动打开           | 看四个模式的差别、直接切换、切中英    |
| 桌面页（v0.2.1 新增）             | 客户端左侧栏「控制栏 / Control bar」 | 图形化看状态、点选模式、切中英；无需改 Electron |

装载横幅长这样（`STREAM_AGENT_NO_BANNER=1` 可静音，`announce: false` 可在 patch 里关掉）：

```
╭─ dsh-stream-agent v0.2.1 - 控制栏 ─────────────────────────────────────────╮
│ * 接管生效：单流协议已接管 agent 创建                                      │
│ 模式: 1 均衡 (balanced) | 回执 | code 跟随宿主 | 并行 3                    │
│ 适合  第一次用，日常读写与查改任务、不确定选哪个时：先用它。               │
│                                                                            │
│ 上手四步                                                                   │
│   1 安装   dsh plugin --profile desktop add <包名或本地路径>               │
│   2 选模式 dsh-stream-agent mode lean（或在控制栏按 1-4）                  │
│   3 下任务 直接说需求，模型在一次流里跑完 tf-* 命令                        │
│   4 核对   dsh-stream-agent status                                         │
│                                                                            │
│ 打开控制栏  dsh-stream-agent bar                                           │
│ 按键  交互栏支持 1-4 切模式、l 切语言、? 看全模式指南                      │
│ 文档: README.md#control-bar                                                │
╰────────────────────────────────────────────────────────────────────────────╯
```

### 打开与操作

```bash
dsh-stream-agent bar          # 交互栏（TTY）；1-4 切模式、l 切中英、? 看全模式指南
dsh-stream-agent bar --once   # 打印一次面板（非 TTY 自动如此）
dsh-stream-agent status       # 一行状态：当前模式 + 参数（接管状态由装载横幅负责）
dsh-stream-agent status --json  # 机器可读（CI / 脚本用）
dsh-stream-agent mode lean    # 直接切模式：balanced / lean / compat / power
dsh-stream-agent lang en      # 直接切语言：zh / en
dsh-stream-agent help         # 全模式指南
```

交互栏键位（中英一致，`--json` 里也是同一套字段）：

| 键                          | 作用                    |
| -------------------------- | --------------------- |
| `1` `2` `3` `4`            | 直接切到对应模式              |
| `Up` / `Down`（或 `k` / `j`） | 移动焦点（不应用）             |
| `Enter`                    | 应用焦点模式                |
| `l`                        | 中文 / English 切换（立即落盘） |
| `?` / `h`                  | 全模式指南（再按 `q` 返回）      |
| `r`                        | 重置为默认模式（balanced）     |
| `q` / `Esc` / `Ctrl-C`     | 退出                    |

### 四个模式：该选哪个

四个模式只映射**既有**配置项，不是第二套开关；`balanced` 与 0.2.0 的出厂默认等价。

| 模式                | 一句话                      | 什么时候选                           | 代价                                             |
| ----------------- | ------------------------ | ------------------------------- | ---------------------------------------------- |
| `balanced` 均衡（默认） | 该省的省，该看的看得见              | 第一次用、日常读写查改、不确定选哪个              | 写批任务读自己刚写的文件只回回执，需要全文用 `tf-peek`               |
| `lean` 精简         | 省钱优先，预算阶梯提前介入            | 长会话、批量脚本、读查为主且答案明确              | 60k 预算触发降级（70% 只注高增益，90% 只收 `tf-final`），可能牺牲细节 |
| `compat` 兼容       | 最接近原生回合制的观感，命令串行         | 行为看着不对、要跟原生 loop 对照、第三方工具依赖完整读回 | token 最高：恢复全文回验、并行度降到 1，速度也更慢                  |
| `power` 增强        | 单流里直接写 `tf-code` 程序处理重数据 | 多步数据加工（过滤/统计/变换/聚合）、大日志分析       | 宿主没有 `ctx.ptcRuntime` 时通道自动关闭；协议段更长，固定成本略高     |

一句话决策：**默认 `balanced`；账单敏感换 `lean`；排障对照换 `compat`；写程序处理数据换 `power`。**

省多少、能不能用（与 `dsh-stream-agent bar` 面板、桌面控制页的标注同源，同一份 `kernel/modes.ts`）：

| 模式         | 省 token        | 可用性                        | 标注                                    |
| ---------- | --------------- | -------------------------- | ------------------------------------- |
| `balanced` | 基准（约为原生 loop 的 29%） | 默认模式，装好即用                  | 不动任何配置就是它，本版参数与实测时一致                  |
| `lean`     | 较高（比默认更省）      | 开箱可用，无前置                   | 60k 阶梯 + 并行 2 + 不声明 tf-code，长会话差距最明显 |
| `compat`   | 最低档（比默认略高）     | 开箱可用，无前置                   | 恢复全文回验、并行降到 1；即便如此仍低于原生 loop          |
| `power`    | 最高档（数据加工最省）    | 需宿主 PTC runtime，没有就回落为默认参数 | 收益只在数据加工类任务上兑现，普通读写反而略高于默认            |

**口径要说清**：只有「默认参数 vs 原生 loop」有十任务两臂实测（约 29%，即省约七成），
其余三档是方向性判断、未单独评测——把没测过的数字写成百分比会误导预算，所以只给档位。

模式与配置项的对应（改模式 = 改这些值；装配里显式写的值仍然优先）：

| 模式       | `selfReadFeedback` | `enableCode`       | `persistFallback` | 并行 | 重入 | `budgetTokens` |
| -------- | ------------------ | ------------------ | ----------------- | -- | -- | -------------- |
| balanced | `receipt`          | `auto`（宿主有 PTC 就开） | `true`            | 3  | 8  | 关              |
| lean     | `receipt`          | `false`            | `true`            | 2  | 6  | 60000          |
| compat   | `full`             | `false`            | `true`            | 1  | 12 | 关              |
| power    | `receipt`          | `true`             | `true`            | 3  | 10 | 关              |

### 中英切换与状态文件

- 切语言：交互栏按 `l`，或 `dsh-stream-agent lang en`；**装载横幅与 CLI 面板同一份文案表**，  
  不会出现"横幅中文、命令英文"的错位。
- 状态落盘：`~/.dsh-stream-agent/control.json`（`STREAM_AGENT_STATE_DIR` 可改）：
  ```json
  { "schema": 1, "mode": "balanced", "lang": "zh", "updatedAt": "2026-11-16T13:00:00.000Z" }
  ```
- 优先级：\*\*装配里显式写的 `mode`/`lang` > 环境变量 `STREAM_AGENT_MODE`/`STREAM_AGENT_LANG`
  > `control.json` > 内置默认（`balanced` / `zh`）\*\*。配置文件损坏只会告警并回默认，不会阻断装载。
- 模式在**下一次 agent 创建**时生效（无需重启 dsh；已开的会话保持创建时的配置）。

<a id="desktop-control-page"></a>

### 桌面客户端控制页（v0.2.1）

装进 `desktop` profile 后**重启客户端**，左侧栏会多一个「控制栏 / Control bar」图标（滑杆图标）。
点开是一整页，不需要改 Electron、不需要重新打包客户端——它走的是 dsh 自己的客户端插件机制
（`dsh.client` + `ctx.slots`），由本地 Host 提供同源数据。

> 已在 dsh 桌面真机验收：左侧栏图标、整页渲染、四张模式卡切换、中英切换、明暗主题、重启后保留。

页面能做的事：

| 区域 | 内容 |
|---|---|
| 顶部 | 版本、**接管生效 / 未接管**、当前模式、当前语言 |
| 当前状态 | 模式、来源（装配配置 / 环境变量 / 状态文件 / 默认值）、语言、更新时间、状态文件路径 |
| 运行模式 | 四张卡：`balanced` / `lean` / `compat` / `power`，每张都写「什么时候选」「代价」，并标注**省 token 档位**与**可用性**（是否需要宿主 PTC），点一下即切换 |
| 生效参数 | 自写回验、tf-code、本地兜底、并行命令、最大重入、token 预算 |
| 语言 | 中文 / English，立即落盘到 `control.json` |
| 页脚 | 等价的 CLI 命令，方便脚本化 |

规则与边界：

- **只影响新会话**：切换模式后，之后创建的 agent 用新参数；已经开着的会话保持创建时的配置。
- **装配优先**：如果 profile patch 里显式写了 `mode`/`lang`，或设了 `STREAM_AGENT_MODE`/`STREAM_AGENT_LANG`，
  页面会把控件置灰并说明原因——界面不能覆盖显式配置，这是 0.2.1 的优先级纪律。
- **多窗口**：页面带 `updatedAt` 并发栅栏；另一个窗口或 CLI 改过状态时，本次写入返回 409 并自动刷新，不会静默覆盖。
- **降级可诊断**：如果 loop 没接管（装载失败），页面仍能打开，会显示「未接管」并允许写状态文件，
  同时明确提示"修复装载后重启生效"——不会假装成功。
- **装载方式不变**：仍然是 `dsh plugin --profile desktop add ...`；bundle 没有 HMR，改完必须重启客户端。
- **不是原生窗口**：没有新增 Electron `BrowserWindow`、没有改 `app.asar`、没有 preload IPC；
  因此也不可能出现"插件升级要跟着客户端发版"的耦合。完整评估见
  [`docs/desktop-ui-feasibility.md`](docs/desktop-ui-feasibility.md)。

> 如果重启后左侧栏没有图标：先 `dsh plugin --profile desktop list` 确认 0.2.1 在列，
> 再看客户端日志里有没有 `stream-agent-ui` 的装载错误。页面依赖 `dsh-client-modules` 的
> 动态客户端插件机制（dsh 桌面 `0.2.2-rc.3` 实测在位）。

## v0.2.1：0.2.0 为什么不能用

**症状**（dsh 桌面 profile，装完 0.2.0 后）：

```
启用失败：dsh: warning: 1 entry did not activate stream-agent
(file:///.../@hugesb/dsh-stream-agent/dist/entry/loop.js):
Error: cannot get property "ptcRuntime" without inject
```

**根因是两个独立的 Cordis 4.x 契约违约，第一个先炸、第二个被掩盖**：

1. **可选服务裸读**。`apply()` 里写的是  
   `(ctx as { ptcRuntime?: unknown }).ptcRuntime ?? ctx.get?.('ptcRuntime')`。  
   `??` 左侧先求值，而 Cordis 4.x 的 context 是 Proxy：对**未 inject** 的属性读取直接抛  
   `cannot get property "ptcRuntime" without inject`，右侧兜底永远到不了。  
   `ptcRuntime` 是可选服务（宿主不挂 PTC 时不存在），于是 entry 在装载期抛错。
2. **函数式插件返回值违约**。五个 entry 结尾都 `return { ...句柄 }`。  
   Cordis 把返回值当 **effect** 收集，只接受 function / null / thenable / iterator，  
   普通对象直接 `TypeError: Invalid effect`。修掉第 1 条就会撞上它，只是报错更难定位。

**为什么现象是"完全不能用"**：entry 抛错 → fiber 进 failed 态 → 注册被回滚 →  
`setFactory` 没发生 → bundle 里内建 `agent-loop` 已被停用 → 该 profile 一个 agent 都创建不出来。

**修复**（`src/entry/cordis-compat.ts`）：

- `getService(ctx, name)`：只走 `ctx.get(name)`（reflect.get 无 inject 要求），  
  属性回退包在 `try/catch` 里兼容测试桩；`ptcRuntime` / `loader` / `sessionProjections` /  
  `agentDefaultModel` / `storage` / `logger` 全部改走它。可选服务**不进 inject 数组**  
  （数组在 Cordis 里是"必需"，缺席会把 entry 永久挂起）。
- `asPluginEffect(handle)`：把句柄包成可调用 disposer，属性原样挂在函数上——  
  测试与调用方读取方式不变，Cordis 侧拿到合法 effect。

**验证**：用 dsh 自带的 Cordis 4.1.0 起一个最小宿主，按 patch 的 inject 逐行挂载七个 entry：

```
ACTIVE  stream-agent-state / obs-broker / action-gate / context-render / control-bar / stream-agent-ui / stream-agent（7/7, state 2）
factory registered: true
control route GET: 200（takeover: true, modes: 4）
```

回归用例进了仓库：`test/activation.test.ts`（严格 inject 守卫的 ctx + 返回值契约，10 例）。

## 效果

真连、10 任务、两臂同模型同日跑完，失败与超时全部计入（口径见 [`eval/METRICS.md`](eval/METRICS.md)，逐任务明细见 [`eval/RESULTS.md`](eval/RESULTS.md)）：

| 指标      | 基线（原生 loop） | 本插件                | 判定   |
| ------- | ----------- | ------------------ | ---- |
| 总 token | 446,410     | **129,178（28.9%）** | ✅    |
| checks  | 10/10       | **10/10**          | ✅ 持平 |

逐任务 token 比（对照 / 基线）：W1 55% · W2 35% · W3 **5%** · R1 35% · R2 36%（checks ✗）· R3 55% · R4 **32%** · C1 **29%** · C2 41% · C3 **22%**。

读查类与复合任务全面改善；写批任务是 0.1.0 口径的短板——模型拿到完整反馈后自发做读写回验循环。**0.2.0 的 O7 自写回验 receipt 正是冲着这条循环去的**（自写文件只回回执不回全文，见下方优化表）；写批收益以新一轮两臂实测为准。

## 工作原理

**`tf-*` 协议**（写进系统提示；语法以 `src/kernel/parser.ts` 为唯一权威）：

| 命令         | 语义                                  | 结果处理                                                                        |
| ---------- | ----------------------------------- | --------------------------------------------------------------------------- |
| `tf-write` | 写/改文件                               | 成功只记 ledger，绝不注入                                                            |
| `tf-read`  | 读文件（可选 `offset`/`limit`，1 基行号）      | 读外部文件完整反馈一次（≤8000 字符，超限留头尾）；读**自己刚写过的文件**只注入回执（O7，行数+指纹，掐断回验循环）             |
| `tf-bash`  | 执行命令（Windows 宿主走 `pwsh`）            | 失败注入，成功只记 ledger                                                            |
| `tf-peek`  | 从句柄取回行段                             | 按需注入                                                                        |
| `tf-code`  | 程序化工具调用（PTC 桥接；body = async TS 函数体） | 返回值（无损 JSON）句柄化进 `code` 族，首/变化注骨架；失败结构化注入。需宿主 `ctx.ptcRuntime`，缺失时命令级失败引导改道 |
| `tf-final` | 声明完成                                | 触发收束判定；同 id 覆盖 = 更新最终答案                                                     |

**七项 token 优化**：

| #  | 优化           | 一句话                                                 |
| -- | ------------ | --------------------------------------------------- |
| O1 | 观测三档 + 行骨架   | 完整反馈优先，超限降级为结构骨架（< 原文 10% 体积）                       |
| O2 | `tf-peek`    | 观测权反转：取多少由模型自己决定                                    |
| O3 | 句柄目录差分       | 只注增量（added / changed / stale），前缀永远单调                |
| O4 | 动态上下文冻结      | 时间、目录快照一律移到易变尾，稳定前缀里不放逐请求变化的字段                      |
| O5 | 预算分级         | <70% 正常 / 70–90% 只注 high / >90% 只收 `tf-final` 并降级交付 |
| O6 | preflight 断言 | 每次发请求前校验前缀 hash，不单调直接拒绝发送                           |
| O7 | 自写回验 receipt | 读自己刚写过的文件只回回执（行数+指纹），掐断"写→读回验"循环                    |

**PTC 桥接（0.2.0）**：与官方 PTC 模式（`run_code` 工具）正交互补——PTC 改"工具调用介质"，  
本包改"循环层"。宿主 `ctx.ptcRuntime` 在位时，模型可在单流里写 `<tf-code>` 程序做重型数据  
加工（过滤/统计/变换），返回值句柄化、中间结果不进上下文；绑定的 `tools.write/read/pwsh`  
走宿主同一条守卫管线。通道缺失时自动关闭且协议不声明，零残留。

**一次回合的生命周期**：

```
用户任务 ─► 发起 1 次流式请求
            │ 模型在单流里输出：思考 + 连续的 tf-* 命令 + depends_on
            ▼
       parser 逐 chunk 解析 ─► 命令闭合即派发
            │                    │
            │              gate.admit()      可逆性判定 / 改写 / 拒绝
            │                    │
            │              tools.execute()   独立命令并行（worker 池 ≤3）
            │                    │
            │              结果写 blob + ledger，默认不注入
            ▼                    ▼
       流终止 && 队列 drain && 无未满足依赖
            │
            ├─ 无需补充信息 ─► finish（1 次模型调用）
            └─ 需要注入 ─► 仅拼入高增益观测，发下一请求（次数 = 命令批次数）
```

## 仓库结构

```
dsh-stream-agent/
├── cordis.patch.yml      # bundle 入口：停用内建 agent-loop，挂 7 个 entry（含控制栏）
├── preset.yml            # 生产装配清单（声明式，不承载接管）
├── src/
│   ├── kernel/           # 零框架依赖：state / obs / parser / gate / render / modes / control-bar
│   └── entry/            # Cordis 薄壳：只做翻译，不写业务逻辑（+ cordis-compat 适配纪律）
├── ui/                   # 桌面控制页子包：宿主路由 + 浏览器 bundle（独立 dsh.client）
├── dist/                 # 构建产物（提交入库，patch 直接引用）
├── test/                 # 255 用例（含装载回归 + 控制栏双语/排版 + 桌面页路由）+ 20 个 mock 场景
├── patches/              # 开发与评测用的组合补丁
├── docs/                 # 架构、协议、限制
├── scripts/build.mjs     # 零依赖构建（Node 原生类型擦除）
└── eval/                 # 指标口径、10 任务集、两臂 runner、判定结果
```


**内核 / 适配边界是第一纪律**：`src/kernel/` 不 import 任何 `@deepseek-ai/*`，拷出目录即可单测；上游 API 漂移只打在适配层薄壳上。实现细节见 [`docs/architecture.md`](docs/architecture.md) 与 [`docs/protocol.md`](docs/protocol.md)。

## 开发

```bash
npm test          # 255/255，零 API 调用
npm run build     # 产出 dist/ 24 个文件 + 全量 smoke import
```

`dist/` 是提交入库的发布产物，patch 直接引用它。**改完 `src/` 必须 `npm run build`**——CI 用 `git diff --exit-code -- dist` 拦下"源码改了忘重建"的静默故障。

真连评测（需要 `DEEPSEEK_API_KEY`，或用 `patches/eval-account.yml` 走账号通道）：

```powershell
node eval/tools/runner.cjs --arm baseline --stamp <YYYY-MM-DD> --tasks all
node eval/tools/runner.cjs --arm stream   --stamp <YYYY-MM-DD> --tasks all
node eval/tools/replay-check.cjs --stamp <YYYY-MM-DD>
node eval/tools/gen-results.cjs --stamp <YYYY-MM-DD>   # 重算 eval/RESULTS.md 判定段
```

桌面端排障：`STREAM_LOOP_DEBUG=1` 打开驱动器逐里程碑追踪（`createAgent.enter` / `agent.scope.minted` / `projection.modelSelection.registered` / `resume.suffix.flushed` / `stream.call` / `stream.finish`）。

## 已知限制

完整清单与取证见 [`docs/limitations.md`](docs/limitations.md)。v0.2.0 已定向修复原四条：

1. ~~**写批任务偏重**~~ → **O7 自写回验 receipt**：读自己刚写过的文件只回回执（行数+指纹），不再回灌全文；读外部文件的完整反馈保持不变（`selfReadFeedback: 'full'` 可回退）。
2. ~~**`steer` 语义偏离内建**~~ → **运行中注入**：steer 注入运行中回合的下一请求（追加区 `[tf-stream:steer]`）；"流内不打断"（不掐当前流）是单流协议的结构性前提，仍与内建有此差异。
3. ~~**持久化依赖宿主 storage**~~ → **本地兜底**：缺 storage backend / sessionPersistence 时降级本地 JSON 文件（`~/.dsh-stream-agent`，`STREAM_AGENT_STATE_DIR` 可改），跨会话 resume 可用；`persistFallback: false` 回内存降级。
4. ~~**plugin record 通道可能降级内存**~~ → **本地文件台账**：宿主模块不可达时降级 JSONL 文件台账（可重放），resume 时 final 答案回灌新驱动器；命令记录刻意不回放（幂等指纹不可复算）。

仍需注意的：

- **写批任务收益需重跑评测确认** —— `eval/` 里的 28.9% 是 0.1.0 口径（receipt 之前）；O7 预期显著改善写批任务，数字以新一轮两臂实测为准。
- **本地兜底会创建状态目录** —— 默认开启（`~/.dsh-stream-agent/{sessions,ledger,storage,control.json}`），不想要就 `persistFallback: false`；`control.json` 只存控制栏的模式与语言，删掉即回默认。
- **0.2.0 在 dsh 里装载失败** —— 已于 0.2.1 修复（可选服务裸读 + 返回值契约，见上文「v0.2.1：0.2.0 为什么不能用」）；仍在使用 0.2.0 的 profile 请升级，不要只重启。
- **`tf-code` 依赖宿主 PTC runtime** —— `ctx.ptcRuntime` 缺失/形状不符时通道自动关闭（协议不声明），已声明的 `<tf-code>` 命令级失败并引导改道；见 [`docs/limitations.md`](docs/limitations.md)。
- **桌面控制页依赖 dsh 的动态客户端插件机制** —— 需要 dsh `>=0.2.2-rc.1`（桌面 `rc.3` 实测）；bundle 无 HMR，升级插件后必须重启客户端；页面只影响新会话，且不是原生窗口（无托盘/菜单/快捷键）。
- **`dsh plugin` 需要 pnpm**、**replay 工具对真连 session log 0 命中**、**`injected_ratio` 口径偏差** —— 见 [`docs/limitations.md`](docs/limitations.md) 4 / 8 / 9。

## 更新日志

完整记录见 [`CHANGELOG.md`](CHANGELOG.md)（遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)）。

| 版本 | 日期 | 要点 |
|---|---|---|
| 0.2.1 | 2026-11-16 | 装载期热修：修掉 0.2.0 在 dsh 里完全不可用的两个 Cordis 4.x 契约违约（可选服务裸读、函数式插件返回值当 effect）；新增控制栏（装载横幅 + `dsh-stream-agent bar`）与四个运行模式（balanced / lean / compat / power），中英双语可切换并落盘。 |
| 0.2.0 | 2026-11-16 | 四个已知限制的定向修复（O7 自写回验 receipt、steer 运行中回合注入、本地持久化兜底、本地文件台账）+ PTC 桥接：新增 `tf-code` 命令，把宿主 `ctx.ptcRuntime` 收编为单流执行通道（程序化数据加工、中间结果不进上下文，协议按通道可用性声明，缺失时自动降级）。 |
| 0.1.0 | 2026-11-15 | 首个可安装版本：单流内核（`tf-*` 五命令）+ O1–O6 token 优化 + 上游语义对齐（隐式写序 / 幂等 id / 乐观 peek / resume 对账）+ 桌面端 Electron 真连适配。真连实测 28.9% / checks 10/10。 |

## 致谢

设计理念上游是 [muxueqingze/xuxiang-thinkflow](https://github.com/muxueqingze/xuxiang-thinkflow)（`tf-*` 流式命令、成功不回灌、失败才打断）。本包在其 v0.10.0 设计基础上独立实现，并补上了驱动器级闭环（隐式写序、幂等 id、乐观 peek、resume 对账等）。

## License

[Apache-2.0](./LICENSE)
