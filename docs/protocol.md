# 单流协议

## 命令语法

模型在一次流里连续输出 `tf-*` 命令。语法以 `src/kernel/parser.ts` 为唯一权威，下面只是等价描述。

| 命令 | 属性 | 语义 | 结果处理 |
|---|---|---|---|
| `tf-write` | `path`、`content`/`patch` | 写或改文件 | 成功只记 ledger，**绝不注入** |
| `tf-read` | `path`，可选 `offset`/`limit`（1 基行号） | 读文件 | 读**外部文件**完整反馈一次（≤8000 字符，超限留头尾）；读**本任务 `tf-write` 写过的路径**只注入回执（`[tf-stream:receipt]`，行数 + sha256 指纹，0.2.0 O7）；补充走 `tf-peek` |
| `tf-bash` | `command`、`description` | 执行命令（Windows 宿主映射到 `pwsh`） | 失败注入，成功只记 ledger |
| `tf-peek` | `handle`、`from`/`to` | 从句柄取回行段 | 按需注入 |
| `tf-final` | `id`、`summary` | 声明任务完成 | 触发收束判定；同 id 携带新 summary = 覆盖最终答案（last-wins） |
| `tf-code` | `description`，可选 `timeout`（毫秒）；body = async TS 函数体（可擦除语法） | 程序化工具调用（PTC 桥接）：绑定 `tools.write/read/pwsh` 走宿主管线 | 返回值（无损 JSON）句柄化进 `code` 族，首/变化注骨架；失败结构化注入。需宿主 `ctx.ptcRuntime`，缺失时命令级失败（`no-code-channel`）引导改道 |

命令可带 `depends_on` 声明依赖，驱动器据此决定派发时机。

## 驱动器闭环语义

光有命令集不够——单流能不能跑稳，取决于这几条边界行为。全部有单测与真连取证：

| 语义 | 规则 | 解决的问题 |
|---|---|---|
| **隐式写序** | 同流内后续命令自动等待先闭合的 `tf-write`（写族 FIFO，读批并行） | 同流 `write → read` 读到旧内容 |
| **重复 id 幂等** | 同 id 同内容 = 返回原回执不重执行；同 id 不同内容 = 拒绝并要求换新 id；被拒命令可用原 id 修正重发 | 模型 id 抖动伪造成功 |
| **乐观 peek 延迟重试** | 同流 peek 未就绪句柄 → 流末 drain 后重试一次，仍无才失败 | 同流内部依赖断链 |
| **`tf-final` last-wins** | final 无副作用，同 id 携带新 summary 视为更新答案 | 模型从不换 id 却想改答案 |
| **过早 final 检测** | final 带未满足依赖或未完成命令时，注入引导让模型重发 | 提前收工 |
| **错误取因** | 逐层解包 `ToolBatchExecutionError.cause` | 失败 detail 不可定位 |
| **tf-code 隔离执行（0.2.0）** | 程序体闭合即派发到宿主 PTC runtime（resolve→run）；返回值无损 JSON 句柄化，中间结果与日志不进上下文；绑定失败对齐 ToolCallError 语义（程序内 try/catch 可续） | 重型数据加工（过滤/统计/变换）只回结论不回过程；模型代码无直接 IO，全部经宿主守卫管线 |
| **自写回验 receipt（O7）** | `tf-read` 命中本任务 `tf-write` 已写过的路径（分隔符规范化后比对）→ 回执注入，不回灌全文；`selfReadFeedback: 'full'` 关闭 | 写批任务"写 → 读回验"循环烧 token |

## 上下文装配

一次请求的 messages 分三段：**稳定前缀**（系统提示 + 任务 + 冻结的动态段）→ **观测注入**（只放高增益）→ **易变尾**（本轮新增内容）。装配规则：

- **只追加，不改写**。禁止摘要、压缩、编辑中间内容——那会直接摧毁 prefix cache。
- **O3 目录差分**：句柄目录不整段重注，只注自上次请求以来的增量（added / changed / stale 三列）。
- **O4 动态冻结**：时间戳、目录快照等逐请求变化的内容一律移到易变尾，稳定前缀里不允许出现。
- **O6 前提断言**：每次发请求前算 `renderHash`，与上一次比对必须单调，否则拒绝发送（fail-closed）。宁可任务失败，也不烧缓存。

## 预算分级（O5）

任务级 token 预算执行三档降级：

| 用量 | 行为 |
|---|---|
| < 70% | 正常：按 `info_gain` 注入 |
| 70–90% | 只注 high 与失败，low / none 一律句柄化 |
| > 90% | 停止一切注入，只收 `tf-final`，输出降级交付（已完成 / 未完成 / 已排除 / 下一步） |

预算在每步请求前的 preflight 校验，不是事后统计。

## 动作准入（gate）

四级可逆性：

| 级别 | 行为 |
|---|---|
| `read` | 直接放行 |
| `spec` | 只写暂存区 + 产 diff，不碰真实工作区；产出绑定内容 hash 的一次性凭据 |
| `commit` | 必须携带有效凭据（`already_used` / `expired` / `hash_mismatch` / `unknown` 四种结构化拒绝） |
| `fatal` | 无人工批准通道时直接拒绝 |

缺 `reversibility` 声明不会静默通过——`registry.freeze()` 在装配期就抛 `MissingReversibilityError`。把"忘记声明"变成启动期失败，而不是运行时的意外放行。
