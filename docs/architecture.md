# 架构

## 一个包，两层

```
                  ┌──────────────────────────────────────────────┐
                  │            @hugesb/dsh-stream-agent          │
  DSH 宿主        │  ┌──── 内核层（零框架依赖，纯函数 + 内存态）──┐ │
  ┌────────┐      │  │  kernel/state.ts    内容寻址状态树 + 句柄  │ │
  │ Cordis │ 注入 │  │  kernel/obs.ts      info_gain 分类 + 账本  │ │
  │Runtime │◄────►│  │  kernel/parser.ts   tf-* 单流协议解析器    │ │
  └────────┘      │  │  kernel/gate.ts     可逆性判定 + 一次性凭据│ │
                  │  │  kernel/render.ts   三段式装配 + prefix 断言│ │
  llm.stream()    │  └──────────────────┬─────────────────────────┘ │
  tools.execute() │  ┌──────────────────▼─────────────────────────┐ │
  session 事件流   │  │        适配层（薄壳 entry，只做翻译）        │ │
                  │  │  loop.ts  state-handle.ts  obs-broker.ts   │ │
                  │  │  action-gate.ts  context-render.ts         │ │
                  │  │  mock-provider.ts  eval-probe.ts           │ │
                  │  └────────────────────────────────────────────┘ │
                  └──────────────────────────────────────────────┘
```

**这条边界是第一纪律**：`src/kernel/` 不 import 任何 `@deepseek-ai/*`（`obs.ts` / `parser.ts` 连 import 语句都没有），把这个目录单独拷出去就能跑单测。上游 API 漂移只打在 entry 薄壳上，内核资产不受损。

## 内核五个模块

| 模块 | 职责 | 关键不变量 |
|---|---|---|
| `state.ts` | 内容寻址的状态树、句柄分配、blob 寻址 | 同一内容必然得到同一 hash，句柄稳定可重算 |
| `obs.ts` | 工具观测归类（`info_gain` = high / low / none）、行骨架、目录差分 | 分类是纯函数，输入相同结果必相同 |
| `parser.ts` | `tf-*` 命令的逐 chunk 解析 | 协议语法的唯一权威；命令闭合才派发，不等流结束 |
| `gate.ts` | 动作准入：read / spec / commit / fatal 四级 + 一次性凭据 | 缺 reversibility 声明在 `registry.freeze()` 就抛错（启动期失败，不是运行期惊喜） |
| `render.ts` | 上下文三段式装配 + 前缀单调断言 | 动态内容不得进入稳定前缀；hash 不单调即 fail-closed |

## 适配层七个 entry

| entry | 挂载方式 | 作用 |
|---|---|---|
| `loop.ts` | `insert`，最后装载 | AgentFactory + 单流驱动器（唯一"改地基"的部件） |
| `state-handle.ts` | `insert`，最先装载 | 提供 `ctx.state`：句柄、blob 落 storage、resume 重建 |
| `obs-broker.ts` | `insert` | 工具结果出口登记 + `llm/stream` 泄漏扫描（依赖 `state`） |
| `action-gate.ts` | `insert` | `ToolsService` guard：spec 暂存、凭据签发与吊销、deny 层 |
| `context-render.ts` | `insert` | O6 preflight 前缀断言（第二见证） |
| `mock-provider.ts` | **仅** `patches/test-preset.yml` | 离线假模型，绝不进生产组合 |
| `eval-probe.ts` | **仅** `patches/eval-*.yml` | 评测探针，只读透传 |
| `json-persistence.ts` | 被 state-handle / loop 引用的本地持久化兜底库（不单独挂载） | 本地 JSON KvUnit + JSONL 会话日志 + 文件台账（0.2.0，修复限制 3/4） |
| `ptc-bridge.ts` | 被 loop 引用的 PTC 桥接库（不单独挂载） | `ctx.ptcRuntime` duck-type 镜像 + tf-code 执行器（0.2.0）：bindings 走宿主同一条 executeTools 守卫管线 |

## 装配顺序

profile 启动时按层叠加，后者覆盖前者（同 id 整行替换，`config` 不深合并）：

```
@deepseek-ai/dsh-base → 各 bundle patch（本包在这一层）→ profile 自己的 cordis.patch.yml
  → $DSH_HOME/cordis.patch.yml → 命令行 --patch（优先级最高）
```

`dsh --profile <name> --dump-config` 可以看到每一层的来源与最终结果。

**装载顺序有讲究**：四个 sidecar 先、`loop` 最后。loop 接管后如果单流很快终止，进程退出会截断尚未挂载 entry 的激活。

## 接管与卸载

`AgentRegistry.setFactory` 是全局唯一的工厂槽位。插件 init 时注册，卸载时该层消失——**不挂 patch 就回到内建回合制 loop，零残留**。这也是"不改上游源码"红线的落地方式。

## 桌面端 / web 组合的适配面

桌面端（Electron 套壳 web 应用，profile `desktop`）与 headless 的组合差异显著，以下都已在真机验证：

| 差异点 | 本包做法 |
|---|---|
| setup 回调需要 agent 自己的 scoped context | 经宿主 loader 取同源 `dsh-scope`，为每个 agent 铸造真实作用域上下文；不可达时降级 ownerCtx 并告警（headless 不受影响） |
| 客户端模型选择器硬依赖 `modelSelection` 会话投影 | 注册宿主同源投影定义；服务或模块不可达则告警跳过（fail-open） |
| resume 时 seed 会补一个占位事件，导致 seq 错位 | 进入公告前立即 `appendUnstoredSuffix` 落盘对齐 cursor，避免 "append seq mismatch" |
| web/desktop 把 tool-fs / tool-pwsh 挪进 agent preset 层 | setup 完成后用 `agentCtx.tools` 重绑驱动器执行器；headless 下解析回根服务，行为不变 |
| PTC 模式组合（宿主挂 `dsh-tool-executor-ptc` / `ctx.ptcRuntime`） | tf-code 通道自动启用：单流协议负责编排（depends_on / 隐式写序 / 前缀单调），重型数据加工下沉 PTC runtime；runtime 缺失时通道关闭、协议不声明（fail-open） |
| 客户端 prompt 面要求 `steer` / `inbox` / `runMaintenance` | 全部补齐；0.2.0 起 `steer` 对齐内建——注入运行中回合的下一请求（追加区 `[tf-stream:steer]`），空闲时插队当新回合任务；"流内不打断"（不掐当前流）是单流结构前提 |
| 默认模型可能为空 | 三级回退（agentOptions → entry config → 宿主 currentSelection），仍为空则 fail-fast 出 `NO_MODEL_ROUTE`，不烧流 |
| 生命周期时序与内建不一致 | 镜像内建全序：`sessions.prepare` → `persistence.create/open` → 双公告 → setup commit → `{agent, dispose}` |

## 红线

1. 不改上游源码——一切以 plugin entry + patch 形式存在。
2. `src/kernel/` 零框架依赖，单独摘出可测。
3. 禁止"智能压缩 / 摘要历史"——只允许整块丢弃尾部，任何中途改写都会摧毁前缀缓存。
4. 每个 entry 必须有 fail-open 开关：自身异常时退回默认行为并留账，不许静默。本地持久化兜底（0.2.0）同样逐级告警：宿主 storage/sessionPersistence/plugin record 模块 → 本地 JSON 文件 → 内存。
5. 不如实报告等同失败：判定不过就写"不过"。
