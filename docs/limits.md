# 用户自定义行为上限（limits）

本插件**不预设任何"会截断/终止工作"的轮数上限**（`maxSteps` 一律不预设，无论默认层还是
参考值）。其余数值的默认面 = **thinkflow 对齐层**（映射自 xuxiang-thinkflow 出厂预设：
`keepRecent=30` / `maxSummaryChars=16000` / `maxReadChars=200000` / `maxReentries=8`，加传输五键）；
用户显式定义的键逐项覆盖默认层，未定义的键跟随默认层，显式写 `0` = 该项不限制。

这条纪律的来由：轮数默认值是插件替用户决定"干到哪算够"。在长任务上，它必然表现为
"任务干到一半被硬杀"。

---

## 1. 两档语义

| 值 | 意义 |
|----|------|
| 未定义 | 该项不生效（= 不限制）。装载时会有一条告警提醒"未设置任何行为上限"（不阻断） |
| `0` | 你**显式选择**不限制（与未定义等效，但会出现在状态面里，表示"我确认过"） |
| `> 0` | 硬上限 |

例外（唯一一处）：换基计数 `maxRebasesPerTurn` / `maxRebasesPerSession` 用 **`-1` = 不限制**，
因为 `0` 在这里是**有意义的取值**——"本回合/本会话禁止换基"。

---

## 2. 全部键（29 个）

| 键 | 单位 | 说明 |
|----|------|------|
| `maxSteps` | 次 | 单任务请求数上限（轮数）。旧名 `maxRequests` |
| `maxInputTokens` | token | 单请求上下文上限，触顶触发压缩。旧名 `budgetTokens` 已改为观测项 |
| `observeBudgetTokens` | token | 预算观测阈值（只告警，不改行为） |
| `maxTokens` | token | **输出预算**（请求 `max_tokens`）。`0` = 委托给 provider，不发字段 |
| `thinkingBudget` | token | **思考预算**（请求 `thinking.budget_tokens`）。`0` = 关闭；`≥1024` 才生效 |
| `streamUsage` | 0\|1 | **流式用量上报**（请求 `stream_options.include_usage`）。`0` = 关，`1` = 开 |
| `maxRetries` | 次 | **请求建立重试**上限（只覆盖建连失败；流中途错误不重试）。`0` = 不重试 |
| `retryBackoffMs` | 毫秒 | 建连重试退避 |
| `peekBudgetChars` | 字符 | 每回合取回（tf-peek）总预算 |
| `peekAnchorEvery` | 行 | 读索引行锚间隔（未设 = 200，可设 100 更密） |
| `maxReadChars` | 字符 | 单次读取上限，超出转行锚索引 |
| `readFeedbackLimit` | 字符 | 回灌截断（`0` = 不截断） |
| `readFeedbackBudgetPerRequest` | 字符 | 单请求读回灌预算 |
| `codeValueInjectLimit` | 字符 | tf-code 的 logs 注入上限（值恒注入，超限只截 logs） |
| `nativeResultLimit` | 字符 | 原生 tool_call 结果单块注入上限 |
| `keepRecent` | 条 | 压缩保留最近条数（不压） |
| `maxSummaryChars` | 字符 | 压缩摘要总长上限（`0` = 不设上限） |
| `segmentMaxChars` | 字符 | 追加区段边界阈值（超出在新回合边界整块丢弃） |
| `effectElisionKeepRecent` | 条 | 已验收效果的折叠门槛（`0` = 不折叠） |
| `maxRebasesPerTurn` | 次 | 每回合换基上限（`-1` = 不限制，`0` = 禁止） |
| `maxRebasesPerSession` | 次 | 每会话换基上限（`-1` = 不限制，`0` = 禁止） |
| `maxReentries` | 次 | 重入上限 |
| `stallReentries` | 次 | **零产出护栏**：连续"本步无产出"的重入上限（见 §5） |
| `closeOutRequests` | 次 | 收束期允许的请求数 |
| `maxParallelToolCalls` | 次 | 同批工具并行度 |
| `maxParallelBindings` | 次 | tf-code 绑定并行度（未设 = 跟随宿主 `maxParallelSubCalls`，宿主默认 10） |
| `codeMaxSubcalls` | 次 | tf-code 子调用次数上限（未设 = 交给宿主 `maxPendingCalls` 128） |
| `codeMaxOutputBytes` | 字节 | tf-code 输出字节上限（未设 = 交给宿主 64 MiB） |
| `codeMaxWallMs` | 毫秒 | tf-code 墙钟上限（未设 = 跟随 `runtime.timeout.maxMs`，宿主默认上限 600000） |

别名归一：`maxRequests→maxSteps`、`budgetTokens→observeBudgetTokens`、
`maxRebases→maxRebasesPerSession`、`peekBudget→peekBudgetChars`、
`maxSubcalls→codeMaxSubcalls`、`maxOutputBytes→codeMaxOutputBytes`、`maxWallMs→codeMaxWallMs`。

### 2.1 传输组（wire）与思考形态

传输五键（`maxTokens` / `thinkingBudget` / `streamUsage` / `maxRetries` / `retryBackoffMs`）
在**每个请求发送前**从生效 limits 组装进请求：

- `maxTokens > 0` → 请求携带 `max_tokens`；`0` = 委托给 provider（不发字段）。
- `thinkingBudget > 0` → 请求携带 `thinking.budget_tokens`（Anthropic 语义：≥1024 且 < max_tokens）。
- `streamUsage = 1` → 请求携带 `stream_options: {include_usage: true}`。
- `maxRetries / retryBackoffMs` → 连接建立失败按预算重试；流中途错误不重试（半截流重发会重复计费）。
- 原生工具声明在面内 → 请求携带 `tools` + `tool_choice: 'auto'`；未声明 → 两者都不发。

配套的字符串设置（装配 config，不在数字 limits 里）：

- `thinkingMode`（默认 `disabled`）：`enabled` 或 provider 特定 type → 请求携带 `thinking`；
  `enabled` 且未显式给 effort 时取 `high`（thinkflow 默认）。
- `reasoningStrategy`：`provider-required`（默认，assistant 消息按宿主原样携带 source）/
  `drop-stale`（保留 source 壳、剥离 replayState——推理/回放状态绝不回传，请求纯文本、
  每请求无状态，thinkflow 等价语义）。

> 传输字段经宿主 `llm.stream` 透传：宿主识别即落到 HTTP body，不识别则忽略。插件控制的是
> 请求装配与取值，不直连 HTTP。

---

## 3. 三层来源（低 → 高）

```
thinkflow 对齐默认层  →  control.json 的 limits  →  STREAM_AGENT_LIMITS 环境变量  →  装配 config.limits
```

再往上叠两个维度覆盖：

```
全局 limits  ←  limitsByChannel[channel]  ←  limitsByTier[tier]  ←  运行期 setLimits(patch)
```

- **thinkflow 对齐默认层**：唯一内置默认（见文首），不物化进 `control.json`
  （文件只存用户键，默认层随版本更新可传播）。
- **control.json**（`<stateRoot>/control.json`）：持久化，跨会话生效，改它不需要重装。
- **环境变量**：`STREAM_AGENT_LIMITS="maxSteps=40;maxInputTokens=48000"`（`;` / `,` / 换行分隔），
  适合一次性试跑，不写盘。
- **装配 config.limits**：随插件配置走，优先级最高。
- **`setLimits(patch)`**：运行期补丁，**只覆盖 patch 里出现的键**，其余沿用；`0` 也算覆盖。

非法键/值（负数、非整数、未知键）一律丢弃并告警，绝不静默采用。

---

## 4. 三种设置方式

```bash
# ① CLI（写 control.json，增量合并）
dsh-stream-agent limits                       # 列出全部键与当前值
dsh-stream-agent limits --json                # 机器可读
dsh-stream-agent limits --set maxTokens=8192,maxRetries=3
dsh-stream-agent limits --set codeMaxWallMs=120000 --replace   # 整体替换
dsh-stream-agent limits --reset               # 清空用户键（回到默认层）

# ② 装配配置
# config: { limits: { maxTokens: 8192, keepRecent: 50 } }

# ③ 环境变量（一次性）
STREAM_AGENT_LIMITS="maxTokens=8192;keepRecent=50" dsh ...
```

生效值会出现在：控制栏（`tier` 行 + `limits` 行）、控制页 `/status` 的
`runtimeStatus().limits`、台账 `plugin:tf-agent/request` 记录。

---

## 5. 两个"看起来像上限但不是"的常量

| 常量 | 默认 | 为什么保留 |
|------|------|-----------|
| `stallReentries`（零产出护栏） | **未设 = 不限制** | 判据是"**本步没有新增 ok 命令**"，有产出立刻清零。**不设也不会无界打转**：重复的同一条 final 拒绝事由 + 零新增产出会走结构性收敛（见 §7） |
| `closeOutRequests`（收束期请求数） | **未设 = 按撞墙事由去重** | 收束期是"已经决定结束、只允许补最后几次请求"的窗口。未设时不限次数，但同一撞墙事由（`steps:<原因>` / `stall` / `no-final`）只收束一次——重复的收束指令信息面零增量。设 `>0` 才是硬次数上限 |
| `maxParallelBindings` | 跟随宿主（10） | 这是**宿主调度器自己的**并发上限（`maxParallelSubCalls`），不是插件加的。显式设 `0` 可由插件侧放开（仍受宿主约束） |

除此之外，插件不补任何数值。取回预算、压缩保留、回灌截断这些"省 token"的旋钮，
未设时**不生效**——省 token 的收益由你自己权衡，不由插件替你扣。

---

## 6. 与档位（tier）的关系

`tier` 现在**只决定压缩强度与参考数值的展示**，不再隐式设定任何上限。
参考值对齐 thinkflow 对齐层——**轮数一律 0（不限制）**，保留/摘要取 thinkflow 数值：

| 档位 | 参考 maxSteps | 参考 keepRecent | 参考 maxSummaryChars | 压缩强度 |
|------|---------------|-----------------|----------------------|----------|
| light | 0（不限制） | 30 | 16000 | aggressive |
| standard | 0（不限制） | 30 | 16000 | balanced |
| deep | 0（不限制） | 30 | 16000 | conservative |

这些数字只出现在控制栏的"参考"位置与文档里，**永远不参与 resolve**（生效面 = thinkflow
对齐层 + 用户 limits）。想收紧就直接写 `limits`；`dsh-stream-agent limits --set ...` 一条命令即可。

### 控制栏怎么显示

| 位置 | 数据来源 | `0` 的显示 |
|------|----------|-----------|
| "生效参数"七项 | `runtimeStatus().effective`（运行时按 cfg 如实报账；含 thinkflow 默认层） | 「不限」 |
| 档位卡数值行 | thinkflow 对齐默认层说明（轮数不设上限） | 「不限」 |
| 降级只读视图 | 生效投影 = thinkflow 对齐层 + 用户 `limits`（loop 未接管时无 cfg 可读） | 「不限」 |

`effective` 的 7 个键：`maxSteps` / `maxInputTokens` / `peekBudgetChars` / `keepRecent` /
`maxSummaryChars`（以上来自 limits，0 = 不限）+ `compactAggressiveness` / `surfacePolicy`
（来自档位与装配，非 limits）。

---

## 7. "不预设上限"如何保证不无限打转

去掉所有缺省数值后，收敛必须靠**信息面判据**而不是计数：

| 场景 | 结构性出口 | 落点 |
|------|-----------|------|
| 模型反复发同一条被拒的 `tf-final`（计划未验证 / 命令未完成 / 占位 summary / 答案过期） | 同一拒绝事由**已经提示过**，且此后**没有任何新增 ok 命令** → 不再重复注入，直接收场 | `blocked`，台账 `final-reject-exhausted` + 兜底交付（台账事实，不伪造结论） |
| 撞墙后仍收不到 `tf-final`（触顶 / 停滞 / 无 final） | 同一撞墙事由只收束一次（收束指令重复注入 = 同一句话再说一遍） | `blocked` + 兜底交付 |
| 模型做了**新工作**（新 ok 命令）后再次被拒 | 判据不成立 → 照常重新提示（生产性回合不受影响） | 继续重入 |

换句话说："不限制"只是把**次数**交给用户，插件仍然保留"同一句话不说第二遍"的纪律——
这不是上限，是去重。

## 8. 三个行为开关（不属于 limits）

这些开关**不是上限**，因此不在 §2 的键表里；它们与 limits 一起落 `control.json`。

| 开关 | 默认 | 关掉后 | 设置方式 |
|---|---|---|---|
| `contextFold` | 开 | 压缩 / 效果折叠 / 段边界全部停用：`surfaceCompaction=false`、`effectElisionKeepRecent=0`、`segmentMaxChars=0`（旧内容一律不移出请求） | 终端 `f` 键 · `dsh-stream-agent fold on\|off\|toggle` · `STREAM_AGENT_CONTEXT_FOLD` · 装配 `contextFold` |
| `finalCheck` | 开 | 不要求 `tf-final`、不判 `accepts`、不拦 premature-final、**不注入收束 nudge**；`tf-plan` **仍解析** | 终端 `v` 键 · `dsh-stream-agent final on\|off\|toggle` · `STREAM_AGENT_FINAL_CHECK` · 装配 `finalCheck` |
| `contextRaw` | 关 | **开启后**上下文完全不处理：折叠强制关 + span 去重关 + 效果折叠关 + 读取/回灌/原生结果/tf-code 注入截断全部为 0（内容原样进请求）。预算类 limits 仍生效 | 终端 `x` 键 · `dsh-stream-agent raw on\|off\|toggle` · `STREAM_AGENT_CONTEXT_RAW` · 装配 `contextRaw` |

- **面板按有效状态显示**：`contextFold=开（已开启，未设阈值，不触发）`——避免"以为在省 token"；
  原样档开启时显示"原样开启，折叠强制关"。
- **PTC兼容模式置灰**：`finalCheck` 在 PTC兼容模式（内部 id `code`）没有验收闸，
  控制面显示"PTC兼容模式无验收闸，不生效"。
- **来源可诊断**：`controlStatus()` 的 `contextFoldSource` / `finalCheckSource` / `contextRawSource` 为
  `config | env | file | default`，优先级 config > env > file > default。
