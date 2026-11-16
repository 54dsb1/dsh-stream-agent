# eval/METRICS.md —— 评测指标口径（分派 08 交付 1）

> 状态：**草案 v1.0（2026-11-14），待项目负责人确认。** 确认后 03/07 号包计数器上报按此对齐；
> 口径变更必须走 §6 变更记录，禁止评测中途改口径（08 号任务书红线）。
> 上游契约：06 驱动器 `snapshot().counters` 是 `injected_ratio` 的**权威口径**（07 号结果 §3.2）；
> 本文件同时是 03/07 号包计数器上报与 09 号对照组的口径锚。

## 0. 环境事实（口径得以成立的实测前提，2026-11-14 勘察）

| # | 事实 | 对口径的影响 |
|---|---|---|
| E1 | session log 位于 `%USERPROFILE%\.dsh\sessions\<工作区slug>\session-*\session.v4.jsonl.zstd`（zstd JSONL，Node 24 原生可解） | 存档 oracle 的路径与复算入口 |
| E2 | session log 的 `request/header` **不含 messages**（只有 config/adapterDefaults/tools）；`assistant/attempt.data.stream` 内嵌逐 chunk 流，含 `{"type":"usage","usage":{...}}` | 调用次数主口径可用 session log；**逐请求 messages 必须 session log 之外的插桩来源** |
| E3 | dsh-llm `TokenUsage`（`dsh-llm/lib/types/types.d.ts:160`）：`inputTokens` 为**未缓存输入**（DISJOINT），缓存输入单列 `cacheReadTokens`/`cacheWriteTokens`，"billed input = sum of the three" | 单位任务 token 必须三分量求和，漏掉 cache 分量会系统性低估两臂（对照臂尤甚——它是靠缓存省钱的） |
| E4 | 插桩方案：中立探针 entry `entry/eval-probe.ts`（只挂 `llm/stream`，逐请求抓 messages + usage 原文，透传不改流，fail-open），**两臂同装**；06 驱动器加 env 门控 turn-end dump（`STREAM_LOOP_EVAL_DUMP`） | prefix_hash / cached 字段 / injected_ratio 的数据源；插桩对两臂对称，属测量仪器不属于对照变量 |
| E5 | 会话标题生成是宿主旁路请求（`session/title-llm-request`，maxTokens 64） | 从指标中剔除（两臂同剔），见 M1 与 M2 的实现细则 |
| E6 | session log 的 `request/header` 由内建 dsh-agent-loop 写入（lib/index.js:1030），llm 层与对照臂驱动器路径均不写；smoke 实测基线臂 1/1、对照臂 0/1 | M2 主口径改为 eval-probe 计数（变更记录 v1.1）；考虑给驱动器补写 request/header 的替代方案被否——向 session 写宿主 known-event 有投影污染风险 |

## 1. 指标定义

```yaml
单位任务 token (M1):
  定义: Σ over agent 回合内全部请求 [inputTokens + cacheReadTokens + cacheWriteTokens
        + outputTokens]     # E3：三分量求和 == provider prompt+completion 计费口径
  含: 注入内容（骨架/peek/错误块/句柄目录差分）逐请求计入；全部请求计入
  排除: 系统提示跨任务固定差值（同任务集内两臂对齐后不影响对照）
  排除: 会话标题旁路请求（E5；识别特征：maxTokens=64 且 messages 单条，剔除规则两臂一致）
  来源: eval-probe 逐请求 usage 原文 JSON（留存）；session log assistant/attempt usage 对账
  原文留存: probe 落盘的 usage JSON 逐条保留，RESULTS.md 贴原文片段（M4 取证要求）

模型调用次数 (M2):
  定义: 主口径 = eval-probe 捕获的 agent 回合请求数（剔除标题旁路，同 M1）
        对账口径 = session log 中 request/header 记录数（**仅基线臂可得**——实测确认该记录由
        内建 dsh-agent-loop 写入（dsh-agent-loop/lib/index.js:1030），llm 层不写；对照臂
        驱动器路径无此记录。任务书原文口径在对照臂不可用，按变更记录 v1.1 调整）
  对账纪律: 基线臂两口径必须相等；不等逐条解释，差异不明 = 数据不可信
  排除: 标题旁路请求（同 M1）
  来源: eval-probe 逐请求计数（两臂同装同口径）+ session log 解析（基线臂对账）

injected_ratio (M3):
  定义: injected / produced（obs.ts 计数器；produced=0 时为 0）
  权威来源: 06 驱动器 snapshot().counters（env STREAM_LOOP_EVAL_DUMP 落盘；07 号 §3.2 裁定）
  旁证: obs-broker 工具通道全量 counters（分母含原生 tool_call，与驱动器口径不同纲，
        只做量级对账，不进 RESULTS 数字格）
  基线臂: n/a（内建 loop 无此概念，不填数字，如实标 n/a）

prefix_hit (M4):
  定义: 相邻请求公共前缀长度（逐请求 messages 序列化后的字节级公共前缀）
        → prefix_hash 序列 = 逐请求 fullHash（含 messages 全量），单调性为验收项
  补充口径: provider usage 的 cacheReadTokens / cacheWriteTokens
        （存在则贴原始 JSON；不存在如实写"不可得"——08 号任务书要求二选一如实标注）
  来源: eval-probe 逐请求 messages 原文（E2：session log 不含 messages，只能插桩取）
        + usage 原文

回放一致性 (M5):
  定义: 按 session log / probe 记录重放全部写入操作后，工作区树哈希 == 实跑后工作区树哈希
  工作区树哈希: 逐文件 sha256（相对路径排序 + 内容），runner 落盘 manifest.json
  来源: replay-check 工具（对照臂从 tf-* 命令重放；基线臂从 session log 工具调用重放）
```

## 2. 任务集与判定规则

- 任务集 ≥10：写入批 ≥3 / 读改查 ≥4 / 复合 ≥3，任务文本 JSON 写死（`eval/tasks/*.json`），
  基线与对照**逐字节同一任务**（含 seed fixtures 逐字节同一份）。
- 每任务fresh工作区（两臂各自独立全新 seed，杜绝跨臂污染）；同一 API key、同一天跑完两臂。
- 逐任务记录四元组：M2 调用次数 / M1 input / M1 output / M3 injected_ratio。
- **判定（加权平均 = Σ任务 token / Σ任务基线 token，全部任务计入，失败与超时照算）：**

| 对照加权平均 | 判定 |
|---|---|
| ≤ 55% | 命题通过 |
| 40%–55% | 边缘：分析注入占比与调用次数，指出 O1/O3 实际效果方向 |
| < 40% 且 06 号未降级 | 命题失败风险：回查 O2 tf-peek 遵循度与 O1 骨架质量 |
| 06 号已降级 | 只报"降级形态收益"，上限按 20-30% 口径解读，如实标注 |

- 失败任务计入：任务失败/超时时，其基线值照常进分母，对照值取实际发生值（含 0 与失败标记）。

## 3. 数据来源与取证映射

| 指标 | 主数据源 | 对账源 | 取证要求 |
|---|---|---|---|
| M1 | probe usage JSONL | session log assistant/attempt usage | usage 原文逐条留存 |
| M2 | session log request/header | probe request 记录 | 差值逐条解释 |
| M3 | driver snapshot dump | obs-broker metrics（旁证） | dump JSON 原样归档 |
| M4 | probe 逐请求 messages | session log 时序 | prefix_hash 序列逐任务导出；cached 字段 JSON 原文 |
| M5 | replay-check | runner 的 workspace manifest | 两侧哈希清单落盘 |
| 任务成败 | runner 退出码 + session log turn/end + 期望检查器 | — | 失败原因原文进 RESULTS |

## 4. 控制变量（红线）

1. 同一任务集、同一 API key、同一天跑两臂；两臂 runner 参数除 patch 外逐项相同。
2. 模型/provider 锁定：以 session log `request/header.config` 记录为准，逐任务归档；
   两臂 model/provider 不一致 = 该任务作废重跑（如实标注）。
3. 插桩（eval-probe）两臂同装；探针自身异常 fail-open 放行并留痕，不改流（测量不改对象）。
4. 数据不许挑：失败计入、超时计入、全部如实上报；每个数字可从 probe log + session log 重算。

## 5. 语义裁定（对 06/07 号交接事项的评测侧裁定）

1. **06 §3.1（high 压过 tf-final）保留**：tf-final 后仍有未注入 high 观测 → 仍重入一次。
   该语义影响 M2 调用次数（读+收尾型任务 +1 请求），两臂判定不受影响（对照臂特性，
   进 RESULTS 分析，不改驱动器）。
2. **06 §3.6（饥饿升格注入断链）评测前修复**：`#turnLoop` 的 noteStep 返回值已接入注入块
   （升格骨架按 high 观测格式注入，final-only 档除外）。修复后信息真空场景的重入可能 +1，
   属设计内行为，M2 如实记录。
3. **07 §3.3（泄漏扫描记账）**：原生 tool_call 通道的全文回灌 leak 记账对应 06 §3.2 的 v1
   限制，RESULTS 中单独列示，不计入命题判定。

## 6. 变更记录（口径变更必须留痕）

| 版本 | 日期 | 变更 | 理由 | 批准 |
|---|---|---|---|---|
| v1.0 | 2026-11-14 | 初稿（08 号任务书 yaml 定义 + E3 缓存三分量修正 + E5 标题请求剔除 + 06/07 交接事项裁定） | 勘察 E1-E5 实测事实 | 待项目负责人确认 |
| v1.1 | 2026-11-14 | M2 主口径从"session log request/header 数"改为"eval-probe 逐请求计数"；request/header 降为基线臂对账口径 | smoke 实测 E6：request/header 由内建 loop 写入，对照臂为 0（数据源缺失非口径偏好）；实测发生在任何真连之前，不影响已采集数据 | 待项目负责人确认（随 v1.0 一并） |

---

## 7. 0.3.0 计量工具（M1/M3 交付；口径不变，计算器收敛）

- **M1**：`eval/tools/summarize.cjs` —— 四分量逐请求求和（输入/缓存读/缓存写/输出），
  标题旁路剔除（E5），缺失分量标"不可得"（不按 0 计，E3 纪律的落地）；产出
  `summary.json`（逐任务可复算的权威形态）与 Markdown 表。RESULTS.md 的数字一律由它出。
- **M3**：`eval/tools/replay-check.cjs` —— 0.3.0 修复对照臂提取器两个根因
  （属性序敏感、`text-delta` 字段名），对照臂回放一致性 10/10（树哈希 == 实跑）；
  基线臂 v4 session log 的 write 调用不可解析（如实标注"不可回放"，checks 才是判定）。
- **M2**：`eval/tools/t3-cells.cjs` —— T3 三格采集（B / A-1a / A-1b 首请求四段拆分 +
  逐字节相等判定 + 差值 == tf-code 段长度判定）；三臂 patch：`eval-stream.yml`（B，
  v0.2.1 tag 产物）/ `eval-stream-code-on.yml`（A-1a）/ `eval-stream-code-off.yml`（A-1b）。
  三格必须同批跑，禁止拼历史数字。
