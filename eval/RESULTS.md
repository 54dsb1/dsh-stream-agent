# eval/RESULTS.md —— 基线 vs 对照（分派 08 交付 3/4/5）

> stamp：`2026-11-15-v02`；口径：[eval/METRICS.md](METRICS.md)（v1.1）；复算命令见文末。
> 红线自查：失败任务计入、超时计入、不挑数据；每个单元格可从 probe log + session log 重算。

## 0. 环境与控制变量

- 基线臂 provider/model（逐任务）：deepseek-account/deepseek-flash, deepseek-account/deepseek-flash, deepseek-account/deepseek-flash, deepseek-account/deepseek-flash, deepseek-account/deepseek-flash, deepseek-account/deepseek-flash, deepseek-account/deepseek-flash, deepseek-account/deepseek-flash, deepseek-account/deepseek-flash, deepseek-account/deepseek-flash
- 对照臂 provider/model（逐任务）：deepseek-account/deepseek-flash, deepseek-account/deepseek-flash, deepseek-account/deepseek-flash, deepseek-account/deepseek-flash, deepseek-account/deepseek-flash, deepseek-account/deepseek-flash, deepseek-account/deepseek-flash, deepseek-account/deepseek-flash, deepseek-account/deepseek-flash, deepseek-account/deepseek-flash
- 两臂 model/provider 不一致的任务 = 作废重跑（METRICS.md §4.2），见下表逐任务标注。
- 注意：session log 的 request/header 仅基线臂可得（METRICS.md E6），对照臂 model 取证以 probe options.config 为准。

## 1. 逐任务对照表（四元组：调用次数 / input / output / injected_ratio）

| 任务 | 类型 / 说明 | 基线: 调用/输入/输出 | 对照: 调用/输入/输出 | 对照 injected_ratio | 对照 token/基线 token | checks | replay | 备注 |
|---|---|---|---|---|---|---|---|---|
| W1 | write-batch / 写 3 个文件 | 5 / 38572 / 1900 (对账1) | 9 / 16032 / 6239 | 0.840 | 55% | 基线✓ 对照✓ | FAIL |  |
| W2 | write-batch / 写 5 个章节文件 + index | 5 / 43973 / 5633 (对账1) | 7 / 11657 / 5926 | 0.579 | 35% | 基线✗ 对照✓ | FAIL |  |
| W3 | write-batch / 写 8 个模块文件 + 汇总 | 9 / 96675 / 5051 (对账1) | 3 / 4023 / 1056 | 0.538 | 5% | 基线✓ 对照✓ | FAIL |  |
| R1 | read-peek / 读大文件答指定行细节 | 4 / 29644 / 1112 (对账1) | 5 / 9151 / 1701 | 2.000 | 35% | 基线✓ 对照✓ | FAIL |  |
| R2 | read-edit / 跨文件改配置 | 5 / 37540 / 965 (对账1) | 8 / 11116 / 2592 | 1.667 | 36% | 基线✓ 对照✗ | FAIL |  |
| R3 | read-peek / 日志找错 | 2 / 18290 / 136 (对账1) | 2 / 9964 / 207 | 3.000 | 55% | 基线✓ 对照✓ | FAIL |  |
| R4 | read-join / 双 JSON 求共同记录 | 2 / 16184 / 252 (对账1) | 2 / 4951 / 312 | 2.000 | 32% | 基线✓ 对照✓ | FAIL |  |
| C1 | composite / 读→算→写→汇报 | 6 / 46289 / 1099 (对账1) | 8 / 11136 / 2598 | 2.000 | 29% | 基线✓ 对照✓ | FAIL |  |
| C2 | composite / 失败改道 | 5 / 41225 / 1296 (对账1) | 9 / 12844 / 4550 | 1.389 | 41% | 基线✓ 对照✓ | FAIL |  |
| C3 | composite / 按清单批量产出 | 7 / 58364 / 2210 (对账1) | 6 / 10020 / 3103 | 1.158 | 22% | 基线✓ 对照✓ | FAIL |  |

## 2. 核心命题判定（METRICS.md §2）

- 基线任务集总 token：446410（缺失任务按 0 计入）
- 对照任务集总 token：129178
- 加权平均（对照/基线）：28.9%
- 判定：**通过（≤55%）**

失败/超时任务清单（计入分母，如实上报）：
- stream/W1: exit=1 timedOut=false
- stream/C2: exit=1 timedOut=false

## 3. prefix_hash 序列与 cached 字段取证（对照臂；基线臂同款数据见各自 metrics.json）

### W1

| seq | fullHash(16) | 与前请求公共前缀 bytes | identical |
|---|---|---|---|
| 1 | 9dd4f076a6de6850 | — | 否 |
| 2 | 9b4ea4553efa3b4b | 2202 | 否 |
| 3 | 6239c60e6bc10f9e | 2402 | 否 |
| 4 | 151a3ddd01b6402a | 2533 | 否 |
| 5 | 82bd4c2c1cf2bacd | 2708 | 否 |
| 6 | 155c31778bbf027a | 2853 | 否 |
| 7 | cb2f908430ad182e | 3001 | 否 |
| 8 | f425979dbc657c99 | 3176 | 否 |
| 9 | e7895b80b2817ba8 | 3312 | 否 |

- cached 字段：probe usage ԭ�ĺ� cache �ֶ�
- usage 原文（前 3 条，全量见 metrics.json）：`{"inputTokens":135,"outputTokens":491,"cacheReadTokens":896,"cacheWriteTokens":0,"totalTokens":1522}`；`{"inputTokens":1008,"outputTokens":507,"cacheReadTokens":1024,"cacheWriteTokens":0,"totalTokens":2539}`；`{"inputTokens":639,"outputTokens":532,"cacheReadTokens":1024,"cacheWriteTokens":0,"totalTokens":2195}`
- injected_ratio：0.840 (injected=42/produced=50，驱动器 snapshot 权威口径)

### W2

| seq | fullHash(16) | 与前请求公共前缀 bytes | identical |
|---|---|---|---|
| 1 | ec01e66e86110e82 | — | 否 |
| 2 | 8f8ec058d8e90f19 | 2202 | 否 |
| 3 | 2d14bde88015dc91 | 2462 | 否 |
| 4 | f47a6f65a0141e77 | 2593 | 否 |
| 5 | e6dab91a358ca92f | 2809 | 否 |
| 6 | 46a06121ff035226 | 2924 | 否 |
| 7 | d1dfdb10045ea16f | 3115 | 否 |

- cached 字段：probe usage ԭ�ĺ� cache �ֶ�
- usage 原文（前 3 条，全量见 metrics.json）：`{"inputTokens":261,"outputTokens":1004,"cacheReadTokens":768,"cacheWriteTokens":0,"totalTokens":2033}`；`{"inputTokens":308,"outputTokens":510,"cacheReadTokens":1024,"cacheWriteTokens":0,"totalTokens":1842}`；`{"inputTokens":853,"outputTokens":1641,"cacheReadTokens":1024,"cacheWriteTokens":0,"totalTokens":3518}`
- injected_ratio：0.579 (injected=22/produced=38，驱动器 snapshot 权威口径)

### W3

| seq | fullHash(16) | 与前请求公共前缀 bytes | identical |
|---|---|---|---|
| 1 | 24410c1a97ba3c52 | — | 否 |
| 2 | a1be614a0d960f73 | 2215 | 否 |
| 3 | a110da90ba9a7e5f | 2532 | 否 |

- cached 字段：probe usage ԭ�ĺ� cache �ֶ�
- usage 原文（前 3 条，全量见 metrics.json）：`{"inputTokens":134,"outputTokens":496,"cacheReadTokens":896,"cacheWriteTokens":0,"totalTokens":1526}`；`{"inputTokens":303,"outputTokens":90,"cacheReadTokens":1024,"cacheWriteTokens":0,"totalTokens":1417}`；`{"inputTokens":642,"outputTokens":470,"cacheReadTokens":1024,"cacheWriteTokens":0,"totalTokens":2136}`
- injected_ratio：0.538 (injected=7/produced=13，驱动器 snapshot 权威口径)

### R1

| seq | fullHash(16) | 与前请求公共前缀 bytes | identical |
|---|---|---|---|
| 1 | 606049efd2f1826b | — | 否 |
| 2 | 2ac328c9ff89df71 | 2182 | 否 |
| 3 | 0bfae75530933faf | 2346 | 否 |
| 4 | 356487b664cfdff2 | 2451 | 否 |
| 5 | 57ef9ec2d4b97229 | 2441 | 否 |

- cached 字段：probe usage ԭ�ĺ� cache �ֶ�
- usage 原文（前 3 条，全量见 metrics.json）：`{"inputTokens":254,"outputTokens":91,"cacheReadTokens":768,"cacheWriteTokens":0,"totalTokens":1113}`；`{"inputTokens":503,"outputTokens":373,"cacheReadTokens":896,"cacheWriteTokens":0,"totalTokens":1772}`；`{"inputTokens":568,"outputTokens":131,"cacheReadTokens":896,"cacheWriteTokens":0,"totalTokens":1595}`
- injected_ratio：2.000 (injected=10/produced=5，驱动器 snapshot 权威口径)

### R2

| seq | fullHash(16) | 与前请求公共前缀 bytes | identical |
|---|---|---|---|
| 1 | 915cb84e945d2cab | — | 否 |
| 2 | 63cbc71b737be59e | 2184 | 否 |
| 3 | ef870b1506065a80 | 2330 | 否 |
| 4 | 51092031fb5c6e45 | 2461 | 否 |
| 5 | 8abfcbf83c7f8d3c | 2584 | 否 |
| 6 | 3706bd8fccced212 | 2574 | 否 |
| 7 | 8e8a4a5f225d4a58 | 2697 | 否 |
| 8 | e7d6d1ecc2b394f3 | 2687 | 否 |

- cached 字段：probe usage ԭ�ĺ� cache �ֶ�
- usage 原文（前 3 条，全量见 metrics.json）：`{"inputTokens":244,"outputTokens":82,"cacheReadTokens":768,"cacheWriteTokens":0,"totalTokens":1094}`；`{"inputTokens":321,"outputTokens":267,"cacheReadTokens":896,"cacheWriteTokens":0,"totalTokens":1484}`；`{"inputTokens":535,"outputTokens":453,"cacheReadTokens":896,"cacheWriteTokens":0,"totalTokens":1884}`
- injected_ratio：1.667 (injected=20/produced=12，驱动器 snapshot 权威口径)

### R3

| seq | fullHash(16) | 与前请求公共前缀 bytes | identical |
|---|---|---|---|
| 1 | 4bb5ddc0683f991c | — | 否 |
| 2 | f2e556e7540025ab | 2179 | 否 |

- cached 字段：probe usage ԭ�ĺ� cache �ֶ�
- usage 原文（前 3 条，全量见 metrics.json）：`{"inputTokens":247,"outputTokens":55,"cacheReadTokens":768,"cacheWriteTokens":0,"totalTokens":1070}`；`{"inputTokens":8053,"outputTokens":152,"cacheReadTokens":896,"cacheWriteTokens":0,"totalTokens":9101}`
- injected_ratio：3.000 (injected=3/produced=1，驱动器 snapshot 权威口径)

### R4

| seq | fullHash(16) | 与前请求公共前缀 bytes | identical |
|---|---|---|---|
| 1 | b01ef8c6c4ed3445 | — | 否 |
| 2 | ffc4ee78019c8bd5 | 2277 | 否 |

- cached 字段：probe usage ԭ�ĺ� cache �ֶ�
- usage 原文（前 3 条，全量见 metrics.json）：`{"inputTokens":154,"outputTokens":40,"cacheReadTokens":896,"cacheWriteTokens":0,"totalTokens":1090}`；`{"inputTokens":2877,"outputTokens":272,"cacheReadTokens":1024,"cacheWriteTokens":0,"totalTokens":4173}`
- injected_ratio：2.000 (injected=4/produced=2，驱动器 snapshot 权威口径)

### C1

| seq | fullHash(16) | 与前请求公共前缀 bytes | identical |
|---|---|---|---|
| 1 | 063ccef48ca01b0f | — | 否 |
| 2 | 094775a01fc13dfa | 2210 | 否 |
| 3 | 3e904f5eb369d8ff | 2374 | 否 |
| 4 | d7ed7cf323dfb46d | 2498 | 否 |
| 5 | 94c27897b3d1d1d1 | 2488 | 否 |
| 6 | dea23f2c1a131551 | 2593 | 否 |
| 7 | 8a63f3a92652d60c | 2593 | 否 |
| 8 | 0451b2a6a51f67c8 | 2593 | 否 |

- cached 字段：probe usage ԭ�ĺ� cache �ֶ�
- usage 原文（前 3 条，全量见 metrics.json）：`{"inputTokens":259,"outputTokens":94,"cacheReadTokens":768,"cacheWriteTokens":0,"totalTokens":1121}`；`{"inputTokens":1242,"outputTokens":852,"cacheReadTokens":1024,"cacheWriteTokens":0,"totalTokens":3118}`；`{"inputTokens":265,"outputTokens":192,"cacheReadTokens":1024,"cacheWriteTokens":0,"totalTokens":1481}`
- injected_ratio：2.000 (injected=14/produced=7，驱动器 snapshot 权威口径)

### C2

| seq | fullHash(16) | 与前请求公共前缀 bytes | identical |
|---|---|---|---|
| 1 | 902877ef221a22d9 | — | 否 |
| 2 | b21c7f9aca91d0e8 | 2319 | 否 |
| 3 | 7aad4c9afaa0e6b9 | 2483 | 否 |
| 4 | dda6d49b0907cd56 | 2596 | 否 |
| 5 | 18339eb1f2b35e29 | 2691 | 否 |
| 6 | d21ec2b1e3387db7 | 2786 | 否 |
| 7 | 48b1cf7bcdca8ea5 | 2882 | 否 |
| 8 | a2fcfbfe4cad99c0 | 2978 | 否 |
| 9 | f4d58b37d86aa7ec | 3093 | 否 |

- cached 字段：probe usage ԭ�ĺ� cache �ֶ�
- usage 原文（前 3 条，全量见 metrics.json）：`{"inputTokens":156,"outputTokens":56,"cacheReadTokens":896,"cacheWriteTokens":0,"totalTokens":1108}`；`{"inputTokens":350,"outputTokens":196,"cacheReadTokens":1024,"cacheWriteTokens":0,"totalTokens":1570}`；`{"inputTokens":385,"outputTokens":593,"cacheReadTokens":1024,"cacheWriteTokens":0,"totalTokens":2002}`
- injected_ratio：1.389 (injected=25/produced=18，驱动器 snapshot 权威口径)

### C3

| seq | fullHash(16) | 与前请求公共前缀 bytes | identical |
|---|---|---|---|
| 1 | cb53058fe632b867 | — | 否 |
| 2 | b792b288c7f259e3 | 2270 | 否 |
| 3 | ec2bcd6181c5f1b7 | 2416 | 否 |
| 4 | 32d833ef321e675b | 2587 | 否 |
| 5 | 89271d06bc50ff81 | 2736 | 否 |
| 6 | 1f24cda68eb1fc97 | 2868 | 否 |

- cached 字段：probe usage ԭ�ĺ� cache �ֶ�
- usage 原文（前 3 条，全量见 metrics.json）：`{"inputTokens":158,"outputTokens":59,"cacheReadTokens":896,"cacheWriteTokens":0,"totalTokens":1113}`；`{"inputTokens":463,"outputTokens":1205,"cacheReadTokens":1024,"cacheWriteTokens":0,"totalTokens":2692}`；`{"inputTokens":252,"outputTokens":376,"cacheReadTokens":1024,"cacheWriteTokens":0,"totalTokens":1652}`
- injected_ratio：1.158 (injected=22/produced=19，驱动器 snapshot 权威口径)

## 4. 复算命令（每个数字可重算）

```powershell
node eval/tools/runner.cjs --arm baseline --stamp 2026-11-15-v02 --tasks all   # 基线臂（重跑）
node eval/tools/runner.cjs --arm stream  --stamp 2026-11-15-v02 --tasks all   # 对照臂（重跑）
node eval/tools/replay-check.cjs --stamp 2026-11-15-v02                        # M5 回放一致性（回填 metrics.json）
node eval/tools/gen-results.cjs --stamp 2026-11-15-v02                         # 本文件重生成
# 单任务初算数据：eval/runs/<stamp>/<arm>/<TASK>/metrics.json
# 原始取证：probe/probe.jsonl（逐请求 options+usage 原文）、session-log/session.v4.jsonl.zstd（原样存档）、driver-*.json（对照臂 snapshot）
```

## 5. 口径与如实声明

- 调用次数主口径 = eval-probe 逐请求计数（两臂同装，METRICS.md v1.1/E6）；基线臂括注 session log 对账值。
- 单位任务 token = Σ(input + cacheRead + cacheWrite + output)（METRICS.md E3）；usage 原文逐条留存于 metrics.json。
- injected_ratio 权威口径 = 06 驱动器 snapshot（07 号 §3.2）；obs-broker counters 为旁证不进本表。
- 标题旁路请求已剔除（METRICS.md E5），剔除计数见 metrics.json M2.titleExcluded。
- 泄漏扫描 leak 记账（原生 tool_call 全文回灌）对应 06 号 §3.2 v1 限制，单列不计入命题判定。
- 原始证据链：tasks.json（任务文本写死）→ fixtures（逐字节固定）→ probe/session log（原样存档）→ metrics.json（初算）→ 本文件。
