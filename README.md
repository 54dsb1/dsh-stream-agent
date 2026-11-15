# @54dsb1/dsh-stream-agent

**再次感谢muxueqingze大佬开源的项目xuxiang-thinkflow项目，本项目基于此将大部分内容转化为deepseekharness插件**

> v0.1.0 ——
>
> **单流协议 DSH 插件**：把"模型看到什么、何时被打断"从回合制改成单流协议。
>
> 0.2.2-rc.3（运行时实测，含桌面客户端）。Node ≥ 24，零 npm 依赖。
> 上游对照项目：[muxueqingze/xuxiang-thinkflow](https://github.com/muxueqingze/xuxiang-thinkflow)（tf-\* 流式命令、成功不回灌、失败才打断的同源理念），本包在其 v0.10.0 设计基础上独立实现并做了驱动器级闭环。

## 命题与状态

**命题**：回合边界能否在不重训模型的前提下被消除？单位任务 token 能降到传统 loop 的 55% 以下吗？

**真连判定（2026-11-15，两臂同模型 deepseek-flash，10 任务全计入，逐字节数据见 [eval/RESULTS.md](eval/RESULTS.md)）**：

| 指标 | 数值 | 判定 |
|---|---|---|
| 加权 token 比（vs 原生 loop 基线 Σ446,410） | **129,178（28.9%）** | ✅ **通过（阈值 ≤55%）** |
| 任务正确性 checks | **9/10（与基线持平，唯一 FAIL = R2）** | ✅ 与基线持平 |

逐任务（对照/基线）：W1 55% · W2 35% · W3 **5%** · R1 35% · R2 36%✗ · R3 55% · R4 **32%** · C1 **29%** · C2 41% · C3 22%。
读查与复合任务全面改善且正确性达标；写批任务偏重——模型利用完整反馈做读写回验循环，
checks 达标率由中途迭代的 6/10 升至 9/10 的来源——这是"正确性优先"的显式取舍，README 已如实标注。

机制级证据（mock + 宿主，187/187 测试全绿）：单流协议生命周期、失败注入改道、挂起-重入、
O3 句柄目录差分、O6 前缀断言、隐式写序、幂等回执、乐观 peek 延迟全部实测；
真连 prefix 缓存命中实证（probe usage 原文含 `cacheReadTokens`，逐请求留存于 metrics.json）；
桌面端真连实测：会话投影 / resume 序号对账 / preset 层工具链路全部打通（见「桌面端适配」）。

## 架构

```
                      ┌──────────────────────────────────────────────┐
                      │        @54dsb1/dsh-stream-agent              │
  DSH 宿主            │  ┌───────── 内核层（零框架依赖，纯函数）─────┐ │
  ┌──────────┐        │  │ kernel/state.ts   内容寻址状态树+句柄     │ │
  │  Cordis  │ 服务注入│  │ kernel/obs.ts     info_gain 分类+观测账本 │ │
  │  Runtime │◄──────►│  │ kernel/parser.ts  tf-* 单流协议解析器     │ │
  └──────────┘        │  │ kernel/gate.ts    可逆性判定+一次性凭据   │ │
                      │  │ kernel/render.ts  三段式装配+prefix校验器 │ │
  llm.stream()        │  └──────────────────┬───────────────────────┘ │
  ctx.tools.execute() │  ┌──────────────────▼───────────────────────┐ │
  session 事件流      │  │      适配层（薄壳 entry，只做翻译）        │ │
                      │  │ entry/loop.ts        AgentFactory+驱动器 │ │
                      │  │ entry/obs-broker.ts  泄漏扫描+结果登记   │ │
                      │  │ entry/action-gate.ts ToolsService guard  │ │
                      │  │ entry/state-handle.ts ctx.state 服务     │ │
                      │  │ entry/context-render.ts O6 第二见证+O4   │ │
                      │  │ entry/mock-provider.ts 离线测试假模型    │ │
                      │  └──────────────────────────────────────────┘ │
                      └──────────────────────────────────────────────┘
```

**内核/适配边界是第一纪律**：`src/kernel/` 不 import 任何 `@deepseek-ai/*`（obs.ts / parser.ts 连
import 语句都没有），拷出目录即可单测；上游 API 漂移只打在适配层薄壳上。

## 单流协议生命周期

```
用户任务 ──► loop 发起 1 次流式请求
             │  模型在单流中输出：思考 + 连续 tf-* 命令 + depends_on 依赖声明
             ▼
        parser 逐 chunk 解析 ──► 命令闭合即派发（不等流结束）
             │                      │
             │               gate.admit(cmd)   # 可逆性判定 / 改写 / 拒绝
             │                      │
             │               ctx.tools.execute(...)  并行跑独立命令（worker 池 ≤3）
             │                      │
             │               结果写 blob + ledger，默认不注入上下文
             ▼                      ▼
        流终止 && 队列 drain && 无未满足 depends_on
             │
             ├─ 无需补充信息 → finish（1 次模型调用）
             └─ 需要注入（high 观测 / peek 结果 / 失败）
                    → 仅把高增益观测拼进 messages，发下一请求（请求次数 = 命令批次数）
```

**tf-\* 命令集**（写进系统提示的模型侧协议，`kernel/parser.ts` 为唯一权威语法）：

| 命令 | 语义 | 结果处理 |
|---|---|---|
| `tf-write` | 写文件 / 改文件 | 成功只记 ledger，绝不注入 |
| `tf-read` | 读文件（可选 `offset`/`limit`：1 基行号起点与行数） | 成功**完整反馈一次**（≤8000 字符，超限头尾保留 + 中段省略），`tf-peek` 按行段取回补充 |
| `tf-bash` | 执行命令（Windows 宿主以 pwsh 执行） | 失败注入，成功只记 ledger（需看输出用 tf-peek） |
| `tf-peek` | 从句柄取回内容片段（行号范围） | 按 need_result 注入 |
| `tf-final` | 声明任务完成 | 触发收束判定；同 id 携带新 summary = 覆盖最终答案（last-wins） |

## 特性：O1–O6 token 优化

| # | 优化点 | 一句话 |
|---|---|---|
| O1 | 观测三档返回 + 行骨架，**完整反馈优先** | tf-read 成功按序完整反馈一次（≤8000 字符；超限头尾保留 + 中段省略 + peek 提示），行骨架（< 原文 10% 体积）作为超限降级兜底 |
| O2 | `tf-peek` 按需取回 | 注入量从"我们猜"变成"模型自己要" |
| O3 | 句柄目录差分注入 | 目录只注增量（added/changed/stale 三列），前缀始终单调 |
| O4 | 动态上下文冻结 | 本 loop 请求由 renderer 装配，DSH runtime-context 动态注入路径结构性不存在 |
| O5 | 预算分级降级阶梯 | <70% 正常 / 70–90% 只注 high / >90% final-only 降级交付 |
| O6 | preflight 前缀断言 | 每次发请求前 hash 断言，不单调直接拒绝发送（fail-closed） |

## 特性：上游 xuxiang-thinkflow 语义对齐（驱动器级闭环）

对照上游 0.10.0 设计（DESIGN.md「必须成立的约束」）与真连评测失败证据，本包落地 6 项语义
（全部有取证与单测，187/187 回归全绿，真连实证）：

| # | 语义 | 对齐上游 | 实证 |
|---|---|---|---|
| 1 | **隐式写序**：同流内后续命令自动等待先闭合的 tf-write（写族 FIFO，读批并行） | DESIGN「信息工具先等之前的写入」 | 写读竞态根除（同流 write→read 不再读到旧内容） |
| 2 | **重复 id 幂等语义**：同 id 同内容 = 返回原回执不重执行；同 id 不同内容 = 拒绝换新 id；被拒命令可用原 id 修正重发 | DESIGN「重复 id 不能伪造成功；相同命令返回原回执」 | 模型 id 抖动被原回执化解 |
| 3 | **乐观 peek 延迟重试**：同流 peek 未就绪句柄 → 流末 drain 后重试一次，仍无才失败 | 「信息工具先等之前的写入」的驱动器闭环 | 同流 peek 依赖关系不再断链 |
| 4 | **tf-read 行范围**：`offset`/`limit` 属性透传宿主 read（1 基行号） | 上游 read-ranges | 模型自发用三段 offset/limit 精确扫描 |
| 5 | **tf-read 成功完整反馈**：成功结果按序完整反馈一次 | DESIGN「已知独立调用在同批声明，成功结果按序完整反馈一次」 | 模型不再因看不到内容而幻觉确认；R3 型任务答案完整交付 |
| 6 | **tf-bash → pwsh 映射**：DSH Windows 宿主 shell 工具是 `pwsh`（command+description 双必填，dsh-tool-pwsh lib/index.js:249-250），不假设供应商工具名 | （上游 bug 类比：不假设供应商工具名） | "unknown tool bash" 全部消除 |

另有配套语义：**tf-final 同 id 覆盖（last-wins）**——final 无副作用，模型复用同 id 携带新
summary 视为更新最终答案（deepseek-flash 真连实证其从不换 id）；**过早 final 检测**——
final 带未满足依赖/未完成命令时注入引导重发；**错误取因**（`describeToolError` 逐层解包
`ToolBatchExecutionError.cause`，失败 detail 直接可定位根因）。

## 桌面端 / web 组合适配（本包对桌面客户端的完整适配面）

DSH 桌面客户端（Electron 套壳 web 应用，profile `desktop`，runtime 0.2.2-rc.3）与 headless
组合差异显著。以下适配全部有真连取证与单测，`STREAM_LOOP_DEBUG=1` 可开逐里程碑追踪：

1. **Agent 作用域上下文铸造**：宿主 setup 回调（`installModelSelection` + preset 绑定）需要
   agent 自己的 scoped context（dsh-agent-preset-registry bind()/mount() 的 `scopeOf(ctx)`
   必须命中宿主 dsh-scope 的 kScope 标签）。经 entry ctx 的 loader（internal 通道）获取宿主
   同源 dsh-scope（kScope Symbol 必须同一实例），为每个 agent 铸造真实作用域上下文并传给
   setup；不可达时降级 ownerCtx 并告警（headless 不受影响）。
2. **`modelSelection` 会话投影注册**：内建 agent-loop 在 Service.init 向 `ctx.sessionProjections`
   注册该投影（dsh-agent-loop rc.3:50110，定义导出自 `@deepseek-ai/dsh-agent`）；客户端
   dsh-client-ui-model-selection 的 `syncInputs` 硬依赖投影值（缺失 → 模型选择器永久停在
   "正在加载模型…"）。entry apply 时经宿主 loader 取同源定义注册；服务/模块任一不可达 →
   告警跳过（fail-open）。inbox 投影为 agent-loop 内部定义（未导出），客户端全部消费点均有
   `?? EMPTY_QUEUE` 兜底，如实不注册。
3. **resume 序号对账**：resume 把已落盘事件作为 seed 传入 `sessions.prepare` 时，会话机制补
   `session/end-seed` 占位事件（seq = seed 长度）；镜像内建在进入公告前调
   `appendUnstoredSuffix` 立即落盘对齐 handle cursor——缺这步时宿主 checkpoint flush
   （`ctx.sessions.flush`）从占位事件之后起批，触发 "append seq mismatch"（桌面端恢复会话后
   首个模型请求即死）。
4. **工具执行器 agent 作用域重绑**：web/desktop 组合把 tool-fs/tool-pwsh/tool-jobs 等从宿主
   平面挪进 agent preset 层（dsh-web-app presets/standard.patch.yml，宿主行 disabled），
   entry 根 ctx 解析不到 write/edit。setup（preset 绑定）完成后用 `agentCtx.tools` 重绑
   驱动器执行器（`SingleStreamDriver.setToolsExecutor`）；headless 的 agentCtx=ownerCtx →
   解析回根服务，行为不变。
5. **桌面 prompt 面补齐**：`steer`（插队队首，回合边界生效——单流"流内不打断"的显式语义
   偏离，如实声明）、`inbox`（恒空队列，空内容续跑按 session/agent-busy 如实拒绝）、
   `runMaintenance`（透传）。
6. **默认模型三级回退**：agentOptions（宿主 `agentDefaultModel` 惰性 getter）→ entry config →
   宿主 `agentDefaultModel.currentSelection()`；provider/model 为空时请求前 fail-fast 出
   结构化 `NO_MODEL_ROUTE` 错误而非烧流。
7. **生命周期镜像内建**：sessions.prepare → persistence.create/open → 双公告（session +
   agent）→ setup commit → {agent, dispose} 全序对齐（dsh-agent-loop createAgent/resume）；
   工厂持 `AgentRegistry.setFactory` 唯一槽位（dsh-agent/lib/index.js:558-566），卸载即回原生。

## 安装与启用

```bash
# 方式一：bundle 安装（官方插件格式，进 profile node_modules）
#   前提：PATH 中有 pnpm（安装/卸载经 pnpm 执行；或按 dsh-plugin-manager 配置 pnpmCommand）
dsh plugin --profile headless add ./dsh-stream-agent

# 方式二：开发/patch 形态（不进 profile，随命令叠加）
dsh --profile headless --patch patch-takeover.yml headless "<任务>"
```

- **官方格式声明**（`package.json`）：`dsh.manifestVersion: 1` + `dsh.bundle.patch: "./cordis.patch.yml"`
  + `engines.dsh: ">=0.2.2-rc.1"`。bundle patch 在组合中以 bundle 层应用：
  覆盖行停用内建 `agent-loop`，`insert:` 行挂五个生产 entry（`./dist/entry/*.js` 相对路径按
  cordis-plugin-loader 的 `import(name)` 语义以 patch 文件 URL 为 baseUrl 解析）。
- 接管原理：`AgentRegistry.setFactory` 是唯一工厂槽位，插件 init 时注册工厂。**卸载即回原生
  行为**（`dsh plugin remove` 或不挂 patch，零残留）。
- patch 行方言注意：`inject` 必须写在 YAML 行内（`entry.options.inject`），模块导出无效——
  这是实测踩坑结论（`cordis-plugin-loader/lib/index.js:768`）。
- headless profile 未注册 storage backend 时，state-handle/action-gate 持久层按设计降级内存
  （功能不损，跨会话 resume 不可用）；生产装配建议补 `@deepseek-ai/dsh-storage-json`。
- 桌面客户端：插件装入 desktop profile 后重启客户端即生效（bundle 无 HMR）。

## 仓库结构

```
dsh-stream-agent/
├── package.json / preset.yml / cordis.patch.yml / patch-*.yml
├── src/
│   ├── kernel/               # 零框架依赖（不 import @deepseek-ai/*）
│   └── entry/                # Cordis 插件 entry（薄壳）
├── test/                     # 内核单测 + mock E2E（187 用例，node:test，零 API）
├── scripts/build.mjs         # 零依赖构建（Node 原生 stripTypeScriptTypes）
└── eval/                     # 指标口径、10 任务集、两臂 runner、结果生成器
```

## 开发与测试

```bash
npm test          # 187/187 全绿，零 API 调用（mock 全链路）
npm run build     # dist/ 13 产物 + 全量 smoke import
```

真连评测（需要 `DEEPSEEK_API_KEY` 或 deepseek-account 路由，两臂同 key 同日跑完）：

```powershell
node eval\tools\runner.cjs --arm baseline --stamp <YYYY-MM-DD> --tasks all
node eval\tools\runner.cjs --arm stream  --stamp <YYYY-MM-DD> --tasks all
node eval\tools\replay-check.cjs --stamp <YYYY-MM-DD>
node eval\tools\gen-results.cjs --stamp <YYYY-MM-DD>   # 生成 eval/RESULTS.md 判定段
```

桌面端排障：设 `STREAM_LOOP_DEBUG=1` 打开驱动器逐里程碑追踪（createAgent.enter /
agent.scope.minted / projection.modelSelection.registered / resume.suffix.flushed /
stream.call / stream.finish）。

## 已知限制（如实声明）

1. **W1/C2 exit=1 但 checks PASS**：重入预算内未收敛（写批任务模型利用完整反馈做读写回验，
   9 次请求烧到护栏），产物正确但回合判定 blocked——防荡护栏语义如实计入。
2. **写批任务 token 偏重**：完整反馈 + 回验循环换正确性的显式取舍；读查/复合任务全面改善。
3. **M5 回放一致性 FAIL（工具缺陷）**：replay 提取器对真连 session log 0 命中（smoke 造数
   双场景验证过、真连 zstd 格式失效）——如实标注，不是回放机制本体失败。
4. **plugin record ledger 通道降级**：bundle 安装形态 bare import `@deepseek-ai/dsh-session`
   不可达宿主模块实例 → 按设计降级内存台账（有 stderr 告警非静默；降级代价 = resume 后
   tf-\* 状态不可重放，session log 仍有 turn/step/assistant 事件）。
5. **headless profile 需补挂 storage backend**（`@deepseek-ai/dsh-storage-json`），否则持久层
   降级内存（bundle 形态实测同此）。
6. **injected_ratio 语义注意**：驱动器 snapshot 计数在 peek/完整反馈场景偏大或偏小
   ——口径为 06 驱动器 snapshot 权威值，如实照登。
7. `dsh plugin add` 依赖 pnpm（PATH 中有 `pnpm`，或按 dsh-plugin-manager 配置 `pnpmCommand`）。
8. **pwsh sandbox ACL**：部分目录下 tf-bash 受 DSH 沙箱 grant 失败（Win32 5）——基线臂同样
   受限，环境因素非本插件缺陷。
9. **steer 语义偏离**：内建 steer 注入运行中回合的下一步；本实现插队到队首、在回合边界生效
    （单流协议"流内不打断"），桌面端已如实声明。

## 红线（架构约束，也是贡献者须知）

1. 不改上游源码——一切以插件 entry + preset 形式存在。
2. `src/kernel/` 零框架依赖，单独摘出可测。
3. 版本锚点：`@deepseek-ai/dsh@0.2.2-rc.1`（类型）/ rc.3（运行时实测）。
4. 禁止"智能压缩/摘要历史"——只允许整块丢弃尾部（摧毁前缀缓存 = 烧钱）。
5. 每个 entry 必须有 fail-open 开关：自身异常时退回默认行为并留账，不许静默。

## License

[Apache-2.0](./LICENSE)
