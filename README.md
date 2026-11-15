# dsh-stream-agent

[![ci](https://github.com/54dsb1/dsh-stream-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/54dsb1/dsh-stream-agent/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

简体中文 | [English](./README.en.md)

**给 DeepSeek Harness 换一颗单流的心。** 把"模型看到什么、何时被打断"从回合制改成单流协议：一次请求内写完全部操作命令，边流边执行，只在真正需要信息时才发下一次请求。

真连实测（10 任务、两臂同模型 `deepseek-flash`）：**token 用量降到原生 loop 的 28.9%，任务正确性持平（10/10）**。

| | |
|---|---|
| 宿主 | DeepSeek Harness `0.2.2-rc.1`（类型锚点）/ `rc.3`（运行时实测） |
| 依赖 | 零 npm 依赖；Node ≥ 22.18（原生类型擦除） |
| 测试 | 187 用例全绿，零 API 调用（mock 全链路 + 20 个场景） |
| 形态 | 单个 bundle 包，`dsh plugin add` 一条命令装卸，卸载即回原生 loop |
| 发布 | npm [`@hugesb/dsh-stream-agent`](https://www.npmjs.com/package/@hugesb/dsh-stream-agent) · GitHub [Releases](https://github.com/54dsb1/dsh-stream-agent/releases) |

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

离线或改本地源码时，把上面两处包名换成仓库绝对路径即可（`dsh plugin add /绝对路径/dsh-stream-agent`）。

卸载：`dsh plugin --profile <name> remove @hugesb/dsh-stream-agent`，或不挂 patch——接管层整体消失，回到原生行为，零残留。

> `dsh plugin` 依赖 `pnpm` 在 PATH 中（或按你的 dsh-plugin-manager 配置 `pnpmCommand`）。

## 效果

真连、10 任务、两臂同模型同日跑完，失败与超时全部计入（口径见 [`eval/METRICS.md`](eval/METRICS.md)，逐任务明细见 [`eval/RESULTS.md`](eval/RESULTS.md)）：

| 指标 | 基线（原生 loop） | 本插件 | 判定 |
|---|---|---|---|
| 总 token | 446,410 | **129,178（28.9%）** | ✅ |
| checks | 10/10 | **10/10** | ✅ 持平 |

逐任务 token 比（对照 / 基线）：W1 55% · W2 35% · W3 **5%** · R1 35% · R2 36%（checks ✗）· R3 55% · R4 **32%** · C1 **29%** · C2 41% · C3 **22%**。

读查类与复合任务全面改善；**写批任务偏重**——模型拿到完整反馈后会自发做读写回验循环。这是"正确性优先"的显式取舍，不是免费收益。

## 工作原理

**`tf-*` 协议**（写进系统提示；语法以 `src/kernel/parser.ts` 为唯一权威）：

| 命令 | 语义 | 结果处理 |
|---|---|---|
| `tf-write` | 写/改文件 | 成功只记 ledger，绝不注入 |
| `tf-read` | 读文件（可选 `offset`/`limit`，1 基行号） | 成功完整反馈一次（≤8000 字符，超限留头尾），补充靠 `tf-peek` |
| `tf-bash` | 执行命令（Windows 宿主走 `pwsh`） | 失败注入，成功只记 ledger |
| `tf-peek` | 从句柄取回行段 | 按需注入 |
| `tf-final` | 声明完成 | 触发收束判定；同 id 覆盖 = 更新最终答案 |

**六项 token 优化**：

| # | 优化 | 一句话 |
|---|---|---|
| O1 | 观测三档 + 行骨架 | 完整反馈优先，超限降级为结构骨架（< 原文 10% 体积） |
| O2 | `tf-peek` | 观测权反转：取多少由模型自己决定 |
| O3 | 句柄目录差分 | 只注增量（added / changed / stale），前缀永远单调 |
| O4 | 动态上下文冻结 | 时间、目录快照一律移到易变尾，稳定前缀里不放逐请求变化的字段 |
| O5 | 预算分级 | <70% 正常 / 70–90% 只注 high / >90% 只收 `tf-final` 并降级交付 |
| O6 | preflight 断言 | 每次发请求前校验前缀 hash，不单调直接拒绝发送 |

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
├── cordis.patch.yml      # bundle 入口：停用内建 agent-loop，挂 5 个 entry
├── preset.yml            # 生产装配清单（声明式，不承载接管）
├── src/
│   ├── kernel/           # 零框架依赖：state / obs / parser / gate / render
│   └── entry/            # Cordis 薄壳：只做翻译，不写业务逻辑
├── dist/                 # 构建产物（提交入库，patch 直接引用）
├── test/                 # 187 用例 + 20 个 mock 场景
├── patches/              # 开发与评测用的组合补丁
├── docs/                 # 架构、协议、限制
├── scripts/build.mjs     # 零依赖构建（Node 原生类型擦除）
└── eval/                 # 指标口径、10 任务集、两臂 runner、判定结果
```

**内核 / 适配边界是第一纪律**：`src/kernel/` 不 import 任何 `@deepseek-ai/*`，拷出目录即可单测；上游 API 漂移只打在适配层薄壳上。实现细节见 [`docs/architecture.md`](docs/architecture.md) 与 [`docs/protocol.md`](docs/protocol.md)。

## 开发

```bash
npm test          # 187/187，零 API 调用
npm run build     # 产出 dist/ 13 个文件 + 全量 smoke import
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

完整清单与取证见 [`docs/limitations.md`](docs/limitations.md)。最需要提前知道的四条：

1. **写批任务偏重** —— 完整反馈 + 回验循环换正确性；读查、复合任务才有大幅收益。
2. **`steer` 语义偏离内建** —— 本实现插队到队首、在回合边界生效（单流"流内不打断"），不是注入运行中回合的下一步。
3. **持久化依赖宿主 storage** —— headless 未挂 storage backend 时按设计降级内存（功能不损，跨会话 resume 不可用）；补 `@deepseek-ai/dsh-storage-json` 即恢复。
4. **bundle 形态下 plugin record 通道可能降级** —— 宿主模块不可达时降级内存台账（stderr 告警，不静默），代价是 resume 后 `tf-*` 状态不可重放。

## 更新日志

完整记录见 [`CHANGELOG.md`](CHANGELOG.md)（遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)）。

| 版本 | 日期 | 要点 |
|---|---|---|
| 0.1.0 | 2026-11-15 | 首个可安装版本：单流内核（`tf-*` 五命令）+ O1–O6 token 优化 + 上游语义对齐（隐式写序 / 幂等 id / 乐观 peek / resume 对账）+ 桌面端 Electron 真连适配。真连实测 28.9% / checks 10/10。 |

## 致谢

设计理念上游是 [muxueqingze/xuxiang-thinkflow](https://github.com/muxueqingze/xuxiang-thinkflow)（`tf-*` 流式命令、成功不回灌、失败才打断）。本包在其 v0.10.0 设计基础上独立实现，并补上了驱动器级闭环（隐式写序、幂等 id、乐观 peek、resume 对账等）。

## License

[Apache-2.0](./LICENSE)
