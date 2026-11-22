# PROTOCOL-v1 —— dsh-stream-agent 单流协议规范（v1.0，冻结于 0.5.0）

| 项 | 值 |
|---|---|
| 文档性质 | 自有协议语义规范（权威来源；实现与本规范冲突时，先修实现，规范变更须走变更记录） |
| 适用版本 | `@hugesb/dsh-stream-agent` 0.5.0 |
| 上游关系 | `xuxiang/thinkflow` 0.10.3（PROTOCOL 1.14）为**参考实现**；本规范不跟随上游变更，差异登记于 `docs/upstream-delta.md` |
| 兼容承诺 | 仅对本规范承诺；`tf-*` 命令名保留以兼容 0.4.x 装配与习惯 |
| 迁移窗口 | 0.5.0 接受宽松解析（两种风格）；0.6.0 仅保留本规范语义 |

---

## 0. 总则

1. **单流**：模型在一次回复流中输出全部命令；命令闭合即执行（不必等流结束），回合以 `tf-final` 收束（标准通道）。
2. **文本即协议**：命令以 XML 风格标签内联在回复文本中；属性值用双引号；正文命令的标签体内是原文（不做转义还原）。
3. **协议面按通道存在**：标准通道注入完整协议段；代码通道（preset 来源）协议段 0 字符（不声明、不解析）；代码通道（bridge 来源）只声明 `tf-code` 用法（约 200 字符）。
4. **失败可见**：命令失败一定以结构化错误注入下一请求（`[tf-stream:error]`）；没有错误注入即成功。
5. **禁止原生调用格式**：`<｜｜DSML｜｜…>`、`<think>` 包裹、JSON tool_call 等原生格式不会被解析为命令——按协议违规丢弃并记账（见 §7）。

## 1. 命令表（14 条）

| 命令 | 必需属性 | 可选属性 | 正文 | 语义 |
|---|---|---|---|---|
| `tf-write` | `path` | — | 有 | 写文件（正文原样落盘） |
| `tf-read` | `path` | `offset`, `limit` | 无 | 读文件（行段 1 基；`offset` = 起始行，`limit` = 行数） |
| `tf-edit` | `path` | `replace_all` | 有 | 精确替换：正文用 `<<<<<<< OLD` / `=======` / `>>>>>>> NEW` 三行标记分隔两段字面量；匹配失败为结构化错误，不做模糊匹配 |
| `tf-append` | `path` | `anchor` | 有 | 只追加：`anchor` 给出唯一锚点字面量（在其后插入）；缺省 = EOF 追加 |
| `tf-grep` | `pattern` | `path`, `include` | 无 | 搜索回匹配行（不回全文） |
| `tf-glob` | `pattern` | `path` | 无 | 路径匹配回路径列表 |
| `tf-bash` | `cmd` | — | 无 | 执行命令（Windows 宿主以 PowerShell 执行） |
| `tf-peek` | `handle` | `from_line`, `to_line` | 无 | 按句柄行段取回观测原文（1 基闭区间）；handle 支持 `request:N` 别名 |
| `tf-final` | — | `summary` | 无 | 收束：`summary` 必须携带最终答案原文（数字/行内容/路径/结论） |
| `tf-plan` | — | — | 有 | 计划与验收：正文按行声明验收项（`- [id] 描述`）；修订 = 重发（整体替换） |
| `tf-code` | — | `timeout`, `description` | 有 | 程序化工具调用（可擦除 TS 的 async 函数体）；仅在代码通道可用 |
| `tf-call` | `name` | — | 有 | 通用调用：`name` = 本会话工具面内的宿主工具名，正文 = JSON 参数对象 |
| `tf-ask` | `q` | `header`, `options` | 无 | 阻塞式提问（选项逗号分隔取标签） |
| `tf-skill` | `name` | — | 无 | 装载技能 |

公共属性（所有命令）：`id`（建议显式、全任务唯一；缺省自动编号）、`depends_on`（逗号分隔依赖 id）、`accepts`（逗号分隔验收项 id——命令成功回执即验证对应验收项）。

## 2. 语义

### 2.1 id 与幂等

- 同 id 同内容且已有回执 → **幂等**：返回原回执（含句柄），不重复执行；模型丢失上下文时原结果回灌一次（`[tf-stream:replay]`；效果已折叠时回灌 `[applied pN]` 一行）。
- 同 id 不同内容 → **拒绝**（换新 id）。
- 被拒绝（无副作用）的命令可用原 id 修正后重发。
- `tf-final` 无副作用：同 id 携带新 summary = 覆盖最终答案（last-wins）。

### 2.2 依赖与写序

- `depends_on` 指向本任务内的命令 id；依赖未满足的命令不执行（依赖失败/不存在 → 结构化错误）。依赖环（`cycle`）上的命令全部判失败。
- **隐式写序**：同流内后续命令自动等待先闭合的 `tf-write` 完成（先写后读不会读到旧内容）。
- 独立命令并行执行（默认上限 3）。

### 2.3 观测与取回（三档）

| 档 | 触发 | 处理 |
|---|---|---|
| high | read/grep/glob/web/test/build/code/skill/agent/job/ask 的首次或内容变化输出；一切执行失败 | 注入（骨架或全文，按读取上限） |
| low | write/append/mkdir/bash 的成功回执 | 句柄化，不注入（只记台账） |
| none | 重复观测且内容哈希未变；空输出 | 回灌字面量"内容未变化"，不更新句柄目录 |

**句柄地址**：`obs:<family>:<callId>@v<n>`（写文件后版本自增）。`tf-peek` 按 1 基闭区间取回；`request:N` 别名指向第 N 个请求句柄化的段（长上下文压缩段）。

**span 账本（0.5.0）**：已投递区间按 `(handle, from, to, req, 内容哈希)` 记账：
- 命中已投递且内容未变 → 返回一行 `[unchanged]`（约 20 token），不返回正文；
- 部分重叠 → 只返回新增区间 + 一行说明；
- `spanLedger: false`（回退点）→ 不记账，行为等价 0.4.0。

**取回预算（0.5.0）**：每回合取回字符上限（`peekBudgetChars`，档位值）。超预算返回一行 `[budget]`（不允许静默继续）。

**取回纪律（协议引导，成本模型依据）**：每一次取回都是一次新请求（第 k 次取回的额外成本约 `(k−1) × C`）。要找内容：先 `tf-grep` 取行号 → 再 `tf-peek` 取 ±40 行窗口；禁止从 L1 起逐段取回；禁止对同一文件重复取回同一区间。

### 2.4 计划与验收

- `tf-plan` 声明验收项；请求只注差分（新计划全量一次，此后只注变化）。
- 验证只能来自命令成功回执（`accepts` 属性）；模型自述"已完成"不构成证据。
- 存在未验证验收项时 `tf-final` 判过早（拒绝收敛并注入提示）。

### 2.5 效果压缩（0.5.0）

动作生效且验证通过后，程序体与原始输出折叠为一行：

```text
[applied p7] edit src/app.ts → v3 (+42/−8) · verify a1 pass · handle=obs:edit:p7@v3
```

保留：目标、版本、diffstat、验证状态、句柄；丢弃：程序文本、原始 stdout（句柄可 `tf-peek` 回取）。不折叠条件：未验证、失败、或最近 `effectElisionKeepRecent`（默认 3）个效果内。折叠发生在两个合法改写点：重复取回的回灌（`[tf-stream:replay]`）与上下文压缩。

### 2.6 语义状态摘要（0.5.0）

一行 `~30 token`：`[tf-stream:state] 目标 N 项 · 已验证 x · 未验证 y（ids）· 失败 z`。标准通道随回灌注入；代码通道经 S5 快照（`systemPrompt.context`，宿主替换旧快照）注入。

## 3. 通道语义（§3.2 能力矩阵的规范面）

| 能力 | 标准通道 | 代码通道（preset） | 代码通道（bridge） |
|---|---|---|---|
| 模型可见工具 | `tf-*` + 宿主工具透传 | preset 决定（本插件注册数 0） | 仅 `tf-code` |
| 协议段 | 本规范全文 | 0 字符 | 约 200 字符（§1 的 `tf-code` 行） |
| 命令解析 | 全表 | 不解析（`tf-*` 标记账丢弃） | 仅 `tf-code` |
| 验收闸 | 是 | 否（降级为状态提示） | 否 |
| 执行器 | 宿主 native | 宿主 `tool-executor-ptc` | 本插件窄桥（`ctx.ptcRuntime`） |

**让位纪律**：代码通道（preset）下本插件不注册工具、协议段 0 字符、不解析模型输出、不拦截 final——对 `ctx.tools` 注册数为 0、对 system prompt 贡献 0 字符、对 session 日志写入 0（只有投影读取）。这些面全部可验证（G3）。

**来源判定**：`auto`（默认）按"当前作用域执行器是否为 PTC 实现"判定（不按 preset id）；`preset`/`bridge` 显式指定绕过探测；两者皆无 → 拒绝进入代码通道，回退标准通道（不静默降级）。

## 4. 错误码（结构化注入）

| 错误 | 注入形态 | 语义 |
|---|---|---|
| `unknown-handle` | `[tf-stream:error id=.. cmd=tf-peek] unknown-handle:<handle>` | 句柄不存在（核对句柄目录增量） |
| `unknown-tool` | tf-call 失败注入（含相近工具建议） | 工具名不在会话工具面 |
| `bad-json-arguments` | tf-call 失败注入 | body 不是合法 JSON 对象 |
| `missing-attribute:<k>` | parser malformed | 必需属性缺失 |
| `bad-integer-attribute:<k>` | parser malformed | 整数属性非法 |
| `duplicate-id` | 命令拒绝 | 同 id 已被不同内容占用 |
| `premature-final` | `[tf-stream:error cmd=tf-final]` | 依赖未满足 / 有命令未完成 / 验收项未验证 |
| final 内容拒绝 | `tf-final 无效：<detail>` | 占位 summary / 过期 final |
| `kind=<ptc 八类>` | `[tf-stream:code-error]` | tf-code 失败分类（K3 保真）+ 可重试结论 |
| `quota-exceeded` | `[tf-stream:code-error]` | 配额硬终止（子调用/输出字节/墙钟） |
| `no-code-channel` | 命令级失败 | tf-code 未开启（通道关闭） |
| `code-channel-yield` | 台账 | 代码通道下 tf-* 被让位丢弃 |
| `peek-budget` | `[budget]` | 回合取回预算触顶 |
| `task-budget-floor` | blocked 文案 | 预算下限保护（< 3×前缀估算，拒绝启动） |
| `prefix-broken` / `prefix-reset` | 台账 | 前缀破坏的 fail-closed / 受限换基 |
| `cache-reset` | 台账 | 换基记账（cause / contextTokens / estimatedColdCost） |

## 5. 注入标记（模型可见）

| 标记 | 语义 |
|---|---|
| `[tf-stream:observation]` | high 观测反馈（全文或骨架 + 句柄） |
| `[tf-stream:receipt]` | 自写回验回执（行数 + 指纹，不回灌正文） |
| `[tf-stream:peek]` | tf-peek 取回结果 |
| `[tf-stream:replay]` | 重复命令的原结果回灌（或效果折叠行） |
| `[tf-stream:plan]` / `[tf-stream:plan-diff]` | 计划全量 / 差分 |
| `[tf-stream:state]` | 语义状态摘要（一行） |
| `[tf-stream:error]` | 结构化错误 |
| `[tf-stream:degraded]` | 预算/工具面降级说明 |
| `[tf-stream:steer]` | 用户插话（运行中 steer） |
| `[tf-stream:truncated]` | 输出截断续写指令 |
| `[tf-stream:nudge]` | 收尾提示 |
| `[tf-stream:closeout]` | 收束期指令（停止探索、立即交付） |
| `[tf-stream:context-rebased]` | 换基说明（压缩/通道切换；缓存已重置，行为不变） |
| `[tf-stream:tool-result]` | 原生 tool_call 结果回灌 |
| `[unchanged]` | span 账本命中（不重发正文） |
| `[budget]` | 取回预算触顶 |
| `[applied pN]` | 效果压缩折叠行 |
| `[seen]` | 代码通道版本戳提示（跨回合工作集退化形态） |
| `[句柄目录增量 O3]` | 句柄目录差分（只追加） |

## 6. 前缀与换基（§8）

请求消息序列满足**前缀单调**：上一请求收尾后的稳定段必须逐字节出现在下一请求头部。违约三类处置：

| cause | 可归因 | 可计划 | 处置 |
|---|---|---|---|
| planned-rebase | 是（本方压缩/通道切换） | 是 | 正常执行并记账（context-rebased 注入 + cache-reset 事件） |
| append-drift | 是 | 有界 | 受限换基：每回合 1 次 / 每会话 3 次内放行同一份 next；`prefixPolicy: 'rebase'` 时另需成本判据（剩余预算 > rebase_cost × rebaseBudgetRatio） |
| stable-drift | 否 | 否 | **始终 fail**（不受 prefixPolicy 影响）+ 诊断转储 |
| shrink | 否 | 否 | fail（历史收缩必须走段边界/计划性换基通道） |

## 7. 宽松解析（迁移窗口，0.5.0）

- `<tf-*` 命令名未知 → malformed（`unknown-command`），不作为 prose 透传。
- DSML 噪声（`<｜｜DSML｜｜ invoke name="tf-xxx" ...>`）→ 改写回等价 tf-* 头部（命令不丢）；其余包装形态记账丢弃。
- 参数式 invoke 块（`parameter` 子标签）缓冲到块闭合后归集属性；块内裸文本按正文处理。
- 孤立/畸形闭合标签（`</tf-*>`、带属性的闭合）记账丢弃，不进 prose，并注入一次定向纠错。
- 未知属性降级丢弃（不拒整条命令）；`lines="N-M"` 归一为 `from_line`/`to_line`。
- XML 实体（`&quot;` 等）解码；属性值容忍内嵌引号。
- **0.6.0**：仅保留本规范语义；上述宽松形态中属于上游习惯的（DSML 系列）转为纯记账丢弃。

## 8. 变更记录

| 版本 | 变更 | 依据 |
|---|---|---|
| v1.0（0.5.0） | 自 thinkflow PROTOCOL 1.14 分叉：新增 peek 段（取回纪律）、span 账本语义、`request:N` 句柄别名、`[unchanged]`/`[budget]`/`[applied pN]`/`[tf-stream:context-rebased]` 标记、代码通道三来源与让位语义、双旋钮预算（maxSteps/maxInputTokens）、前缀三类处置判定表 | 0.5.0 计划书 §7/§8/§5；成本模型（分页取回 (k−1)×C） |
