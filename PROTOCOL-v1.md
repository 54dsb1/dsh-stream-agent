# PROTOCOL-v1 —— dsh-stream-agent 单流协议规范

| 项 | 值 |
|---|---|
| 文档性质 | 自有协议语义规范（权威来源；实现与本规范冲突时，先修实现，规范变更须走变更记录） |
| 适用规范版本 | v1.5.0（命令表 17 条，ADR-002；v1.0 为语义基，后续为可选段与加属性；演进见 §8） |
| 上游关系 | `xuxiang/thinkflow` 0.10.3（PROTOCOL 1.14）为**参考实现**；本规范不跟随上游变更，差异登记于 `docs/upstream-delta.md` |
| 兼容承诺 | 仅对本规范承诺；`tf-*` 命令名保留以兼容既有装配与习惯 |
| 迁移窗口 | 宽松解析仅限 §7 所述迁移形态；运行语义以本规范为准 |

---

## 0. 总则

1. **单流**：模型在一次回复流中输出全部命令；命令闭合即执行（不必等流结束），回合以 `tf-final` 收束（标准通道）。
2. **文本即协议**：命令以 XML 风格标签内联在回复文本中；属性值用双引号；正文命令的标签体内是原文（不做转义还原）。
3. **协议面按通道存在**：标准通道注入完整协议段；代码通道（preset 来源）协议段 0 字符（不声明、不解析）；代码通道（bridge 来源）只声明 `tf-code` 用法（约 200 字符）。
4. **失败可见**：命令失败一定以结构化错误注入下一请求（`[tf-stream:error]`）；没有错误注入即成功。
5. **禁止原生调用格式**：`<｜｜DSML｜｜…>`、`<think>` 包裹、JSON tool_call 等原生格式不会被解析为命令——按协议违规丢弃并记账（见 §7）。

## 1. 命令表（17 条；v1.5.0 起，ADR-002）

| 命令 | 必需属性 | 可选属性 | 正文 | 语义 |
|---|---|---|---|---|
| `tf-write` | `path` | — | 有 | 写文件（正文原样落盘） |
| `tf-read` | `path` | `offset`, `limit` | 无 | 读文件（行段 1 基；`offset` = 起始行，`limit` = 行数） |
| `tf-edit` | `path` | `replace_all`, `offset` | 有 | 精确替换：正文用 `<<<<<<< OLD` / `=======` / `>>>>>>> NEW` 三行标记分隔两段字面量；`offset` 声明目标起始行供版本守卫核对（§2.6）；匹配失败为结构化错误，不做模糊匹配 |
| `tf-append` | `path` | `anchor` | 有 | 只追加：`anchor` 给出唯一锚点字面量（在其后插入）；缺省 = EOF 追加 |
| `tf-grep` | `pattern` | `path`, `include` | 无 | 搜索回匹配行（不回全文） |
| `tf-glob` | `pattern` | `path` | 无 | 路径匹配回路径列表 |
| `tf-bash` | `cmd` | — | 无 | 执行命令（Windows 宿主以 PowerShell 执行） |
| `tf-peek` | `handle` | `from_line`, `to_line`, `symbol`, `offset`, `query` | 无 | 按句柄取回：行段（1 基闭区间）/符号窗口/字符级 `offset`+`query`（§2.3）；handle 支持 `request:N` 别名 |
| `tf-final` | — | `summary` | 无 | 收束：`summary` 必须携带最终答案原文（数字/行内容/路径/结论） |
| `tf-plan` | — | — | 有 | 计划与验收：验收项 `- [id] 描述`，可尾部带机器谓词（§2.4）；`> [id]` 声明唯一活动项；修订 = 重发（整体替换） |
| `tf-code` | — | `timeout`, `description`, `state`, `sandbox`, `release`, `format`, `sandbox_permissions`, `justification` | 有 | 程序化工具调用（可擦除 TS 的 async 函数体）；`state`=命名状态域、`sandbox`=策略名、`release=true` 只释放不执行、`format`=请求形态（实际由宿主 runtime 决定，见 §2.8）；仅在代码通道可用 |
| `tf-call` | `name` | — | 有 | 通用调用：`name` = 本会话工具面内的宿主工具名，正文 = JSON 参数对象 |
| `tf-ask` | `q` | `header`, `options` | 无 | 阻塞式提问（选项逗号分隔取标签）；宿主 timed ask 返回 pending 时回合以 `awaiting:user` 收束 |
| `tf-skill` | `name` | — | 无 | 装载技能 |
| `tf-changes` | — | `path` | 无 | 变更回执目录（v1.5.0）：id/操作/路径/状态/可否回滚/expected 哈希；可选段 v15 开启后模型可见 |
| `tf-diff` | `change` | — | 无 | 回执快照 unified diff（v1.5.0；快照对快照，不是对当前文件断言） |
| `tf-revert` | `change`, `expected` | — | 无 | 守卫式回滚（v1.5.0）：expected 必须 == 回执 after_hash 且 == 当前文件哈希；恢复 before + undo 回执；冲突结构化失败 |

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
| `full` | read/grep/glob/web/test/build/code/skill/agent/job/ask 的首次或内容变化输出；一切执行失败 | 注入（全文；超限才骨架 + 句柄） |
| `handle` | write/append/mkdir/bash 的成功回执 | 句柄化，不注入（只记台账） |
| `dedup` | 重复观测且内容哈希未变；空输出 | 回灌字面量"内容未变化"/`[unchanged]`，不更新句柄目录 |

**句柄地址**：`obs:<family>:<callId>@v<n>`（写文件后版本自增）。`tf-peek` 按 1 基闭区间取回；`request:N` 别名指向第 N 个请求句柄化的段（任务起点原文 + 长上下文压缩段 + 段边界丢弃段；v1.5.0 起三处均登记）。

**span 账本**：已投递区间按 `(handle, from, to, req, 内容哈希)` 记账：
- 命中已投递且内容未变 → 返回一行 `[unchanged]`（约 20 token），不返回正文；
- 部分重叠 → 只返回新增区间 + 一行说明；
- `spanLedger: false`（回退点）→ 不记账。

**取回预算**：每回合取回字符上限（`peekBudgetChars`，档位值）。超预算返回一行 `[budget]`（不允许静默继续）。

**字符级取回（v1.1.0）**：`tf-peek handle=... offset=<字符起点>` 按字符取回；`query=<字面串>` 从 offset 起找首次出现并从该处返回（对齐 `[TF]/recall.py:34`）。返回值带 `next offset=N` 续搜提示；未命中是**正常结果**（正文一行"query 未命中"，不算命令失败）；负 offset/预算耗尽拒绝取回。offset 以 UTF-16 索引计（JS 字符串口径）。与 `symbol`（±40 行）、行段三者互斥优先级：`offset/query` > `symbol` > `from_line/to_line`。

**取回纪律（协议引导，成本模型依据）**：每一次取回都是一次新请求（第 k 次取回的额外成本约 `(k−1) × C`）。要找内容：先 `tf-grep` 取行号 → 再 `tf-peek` 取 ±40 行窗口；禁止从 L1 起逐段取回；禁止对同一文件重复取回同一区间。

### 2.4 计划与验收

- `tf-plan` 声明验收项；请求只注差分（新计划全量一次，此后只注变化）。
- 验证只能来自命令成功回执（`accepts` 属性）或机器谓词；模型自述"已完成"不构成证据。
- **机器谓词（v1.1.0）**：验收项文本尾部 `:: <pred>(...)` 支持 `exists(path)`、`sha256(path,hex)`、`bytes(path,min|max|eq,n)`、`regex(path,/pattern/flags)`。收束前用注入的只读文件事实求值：通过 → `verified`（证据 `machine:<pred>`）；失败 → 记 `acceptance-predicate-failed` 并在 final 拒绝中列出原因。文件事实端口缺省时跳过求值。
- **活动项（v1.1.0）**：`> [id]` 单独一行声明唯一当前活动项，对齐上游 `task_plan` 的单个 `in_progress` 约束；重复声明取第一条并记 `plan-active-duplicate` fault。
- 存在未验证验收项时 `tf-final` 判过早（拒绝收敛并注入提示）。
- **同轮交付**：标准通道下，无未验证验收项、无重入事由、且本回合有生产性命令时，
  流末正文即交付——不强制 `tf-final`（旧行为由 `requireFinal: true` 回退）。零产出回合
  不适用（不得把空转正文当交付）。

### 2.5 效果压缩

动作生效且验证通过后，程序体与原始输出折叠为一行：

```text
[applied p7] edit src/app.ts → v3 (+42/−8) · verify a1 pass · handle=obs:edit:p7@v3
```

保留：目标、版本、diffstat、验证状态、句柄；丢弃：程序文本、原始 stdout（句柄可 `tf-peek` 回取）。不折叠条件：未验证、失败、或最近 `effectElisionKeepRecent`（默认 3）个效果内。折叠发生在两个合法改写点：重复取回的回灌（`[tf-stream:replay]`）与上下文压缩。

### 2.6 语义状态摘要

一行 `~30 token`：`[tf-stream:state] 目标 N 项 · 已验证 x · 未验证 y（ids）· 失败 z`。标准通道随回灌注入；代码通道经 S5 快照（`systemPrompt.context`，宿主替换旧快照）注入。

### 2.7 文件版本守卫（v1.1.0）

`tf-read` 成功时登记文件观察（全文读 = revision + 空区间；`offset`/`limit` 范围读 = revision + 已读行段）。变更类命令（`tf-edit`/`tf-append`）派发前用注入的 `revisionFacts` 检查：

- 未登记读观察 → `read_required`（拒绝，提示先 tf-read）；
- 文件版本自观察后变化 → `revision_conflict`（拒绝，提示重新 tf-read）；
- `tf-edit offset=<行>` 的目标行段未被已读区间覆盖 → `read_required`（范围读不得越界编辑）。

`revisionFacts` 端口缺省时全部跳过。

**默认装配**（fs 只读事实）：版本守卫与验收谓词不再是"声明了但永不生效"的端口——装配层缺省接上
文件事实（`stat`/`sha256`/`bytes`/`text`），`revisionGuard: false` 或显式端口可覆盖。
同时明确一条边界：**目标文件不存在 + 无读观察 = 新建，放行**（要求"先读一个不存在的文件"会让新建
文件这条主路径死锁）。

写后只更新 revision 与平移已读区间，**不改变授权范围**（范围读不会因写入升级为全文读）。错误码：`read_required` / `revision_conflict`。

### 2.8 b 通道 PTC 对齐（v1.2.0）

`tf-code` 在 code+bridge 来源下可带以下属性（宿主 PTC 真实契约，见 `dsh-ptc-runtime/src/types.ts`）：

- `state="名"` → `resolve.stateOwner`（对象身份保留态；同名复用一个稳定 owner 对象）。
- `sandbox="read-only|workspace-write|danger-full-access"` → 由装配注入的 `resolveSandboxPolicy(name)` 或宿主
  `sandboxPolicy.resolve({ session, mode })` 解析为宿主策略对象后传给 `resolve.sandboxPolicy`；无解析服务则不传
  （宿主保持自身默认，插件**不自行构造策略**）。派生时必须带 `session`——宿主按会话给出有效
  策略（会话级 override、工作区边界都挂在这里），只传 `mode` 等于绕过会话策略、让程序跑在更宽的沙箱里。
  白名单之外的值判 `invalid-attribute`（不静默降级为宿主默认）。`resolve` 抛错或返回空 → 告警 + 不传
  （fail-open，但绝不"降级为更宽策略"）。
- `release="true"` + `state` → `await runtime.release(owner)`，**只释放不执行程序体**；未建立的状态域判
  `state-not-found`；释放失败保留本地身份映射供重试。补充：① 沙箱策略变化 ⇒ 同名 state 的保留态
  **作废**（不跨策略复用内存，台账记 `dropped`）；② 会话结束时 `driver.dispose()` 逐个 release，
  不再"只增不减"地泄漏宿主保留态。
- `sandbox_permissions="workspace-write|danger-full-access"` + `justification="…"`（v1.4.0）→ **单次提权**：
  两个属性必须成对（缺一判 `invalid-attribute`）；经宿主 `dsh-sandbox` 的 `approveEscalation(request, approval)`
  审批，批准后只覆盖**本次**程序执行（`sandboxPolicy` 换成提权后的策略对象），不改变会话常驻策略、不落盘。
  提权执行时忽略 `state`（旧内存态不得在更宽策略下复活，台账记 `dropped`）。拒绝 → `escalation-denied`；
  宿主没有策略/审批服务 → `escalation-unavailable`（不要假设提权一定可用，也不得绕过沙箱重试）。
- `format="function-body|repl|script"` → 仅本地校验并 ledger 记录请求；**不进 resolve**，宿主执行形态由 `runtime.programFormat` getter 决定（不伪装成已对齐）。
- 类型化绑定错误 `errorClass` 放在 bindings namespace（`{name:'ToolCallError', memberNameProperty:'toolName'}`），非 resolve 顶层。
- 子调用审计只写插件私有 ledger（让位纪律：不写宿主 session、不冒充 `tool/ptc-dispatch*` 事件）。
  字段与宿主同词汇（`phase`/`parentCallId`/`subCallId`/`name`/`isError`/`content`），
  `subCallId = <parentCallId>:ptc:<提交序号>`；出口按 agent 路由（多 agent 不串账）。
- 运行时描述符消费：`language` / `programFormat` / `sandboxMode` / `retainsState` / `timeout` /
  `executionInstructions` 写进 bridge 协议段（宿主运行时事实）与 `runtimeStatus().ptc`；
  `language` 非 TypeScript/JavaScript ⇒ code 通道关闭并告警（程序体在宿主里跑不起来）。

## 3. 通道语义（§3.2 能力矩阵的规范面）

| 能力 | 标准通道 | 代码通道（preset） | 代码通道（bridge） |
|---|---|---|---|
| 模型可见工具 | `tf-*` + 宿主工具透传 | preset 决定（本插件注册数 0） | 仅 `tf-code` |
| 协议段 | 本规范全文 | 0 字符 | 约 200 字符（§1 的 `tf-code` 行） |
| 命令解析 | 全表 | 不解析（`tf-*` 标记账丢弃） | 仅 `tf-code` |
| 验收闸 | 是 | 否（降级为状态提示） | 否 |
| 执行器 | 宿主 native | 宿主 `tool-executor-ptc` | 本插件窄桥（`ctx.ptcRuntime`） |

**让位纪律**：代码通道（preset）下本插件不注册工具、协议段 0 字符、不解析模型输出、不拦截 final——对 `ctx.tools` 注册数为 0、对 session 日志写入 0（只有投影读取）。system prompt 侧保留 3 段常量（通道措辞、工具面说明、不变量，共 263 字符，跨请求固定），用于说明"工具面由 preset 决定、压缩由本插件做"；除此之外不写入。这些面全部可验证（G3）。

**来源判定**：`auto`（默认）按"当前作用域执行器是否为 PTC 实现"判定（不按 preset id）；`preset`/`bridge` 显式指定绕过探测；两者皆无 → 拒绝进入代码通道，回退标准通道（不静默降级）。

## 4. 错误码（结构化注入）

| 错误 | 注入形态 | 语义 |
|---|---|---|
| `unknown-handle` | `[tf-stream:error id=.. cmd=tf-peek] unknown-handle:<handle>` | 句柄不存在（核对句柄目录增量） |
| `query-not-found` | 正常结果正文（**非**错误通道） | tf-peek 的 `query` 未命中（正常结果，不算命令失败） |
| `unknown-receipt` | 正常结果正文 | `receipt:N` 不在本会话回执表 |
| `unknown-tool` | tf-call 失败注入（含相近工具建议） | 工具名不在会话工具面 |
| `bad-json-arguments` | tf-call 失败注入 | body 不是合法 JSON 对象 |
| `invalid-attribute` | 命令级失败 | 属性值不在白名单（如 `sandbox="ro"`；白名单：read-only / workspace-write / danger-full-access） |
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

请求消息序列满足**前缀单调**：上一请求收尾后的稳定段必须逐字节出现在下一请求头部。
违约（不单调）默认**发送前接受为缓存重置点**——同一份 next 照常发送（0 额外请求 /
0 重复计费 / 0 注入文本），对话不中断；基线随本请求推进，后续请求恢复单调（缓存恢复命中）。
仅 `prefixPolicy: 'fail'`（显式回退面）保留 fail-closed。

| cause | 可归因 | 可计划 | 处置 |
|---|---|---|---|
| planned-rebase | 是（本方压缩/通道切换） | 是 | 正常执行并记账（context-rebased 注入 + cache-reset 事件） |
| append-drift | 是 | 有界 | 接受为缓存重置点：放行同一份 next（0 额外请求；限流与成本判据已退役） |
| stable-drift | 否 | 否 | 同上：接受为缓存重置点继续对话（`prefixPolicy: 'fail'` 时 fail + 诊断转储） |
| shrink | 否 | 否 | 同上：接受为缓存重置点继续对话（`prefixPolicy: 'fail'` 时 fail） |

## 7. 宽松解析（迁移窗口）

- `<tf-*` 命令名未知 → malformed（`unknown-command`），不作为 prose 透传。
- DSML 噪声（`<｜｜DSML｜｜ invoke name="tf-xxx" ...>`）→ 改写回等价 tf-* 头部（命令不丢）；其余包装形态记账丢弃。
- 参数式 invoke 块（`parameter` 子标签）缓冲到块闭合后归集属性；块内裸文本按正文处理。
- 孤立/畸形闭合标签（`</tf-*>`、带属性的闭合）记账丢弃，不进 prose，并注入一次定向纠错。
- 未知属性降级丢弃（不拒整条命令）；`lines="N-M"` 归一为 `from_line`/`to_line`。
- XML 实体（`&quot;` 等）解码；属性值容忍内嵌引号。
- **围栏隔离**：行首（≤3 空格缩进）的反引号 / 波浪线围栏（≥3 个标记字符）内的 `<tf-*>` 只作散文——
  不解析、不执行、正文逐字节保留；未闭合围栏延续到流末。命令正文里的围栏标记不改变状态。
- **行内代码隔离**：单反引号行内代码（`` `…<tf-read …/>…` ``）里的 `<tf-*>` 同样只作散文。
  判据：本行内反引号计数为奇数即处于行内代码；行内代码不跨行（遇换行重置）。围栏内不适用本判据。
- 宽松形态中属于上游习惯的（DSML 系列）转为纯记账丢弃——运行语义以本规范为准。

## 8. 变更记录

### 8.1 加语法评审流程（v1.1 起生效）

本协议命令表上限 17 条（G2/§6.4；v1.5.0 起，ADR-002：14 条基线 + 变更回执三命令）；再加命令必须经 §8.1 流程 + 新 ADR，故常规能力扩展**只增属性、不增命令**。
"新增属性"按以下流程办理，任一缺项不得进 `parser.ts` 的 schema：

1. **规范先行**：在 §1 命令表该行的"可选属性"列出新属性名；在 §2 对应小节写明取值域、缺省行为、错误码与状态影响。
2. **内核纯函数**：语义落 `src/kernel/` 的零依赖模块（不 import 任何 `@deepseek-ai/*`、不 IO），由构造注入使用。
3. **测试向量**：`test/` 下具名用例覆盖合法值、缺省值、非法值三类；`README` 命令表与 `check-consistency` 计数同步。
4. **变更记录**：本节追加版本行（v1.1.0 起），写明属性名、依据模块与兼容性（旧会话是否可解析）。
5. **双通道声明**：写明属性在 a（standard）/b（code）两通道各自是否生效；b 通道若让位，写明代位形态。

旧会话兼容：新增属性一律为 optional；缺省行为必须与新增前逐字节一致。违反此条视为破坏性变更，须升 minor 并走退役流程。

| 版本 | 变更 | 依据 |
|---|---|---|
| v1.0（0.5.0） | 自 thinkflow PROTOCOL 1.14 分叉：新增 peek 段（取回纪律）、span 账本语义、`request:N` 句柄别名、`[unchanged]`/`[budget]`/`[applied pN]`/`[tf-stream:context-rebased]` 标记、代码通道三来源与让位语义、双旋钮预算（maxSteps/maxInputTokens）、前缀三类处置判定表 | 0.5.0 计划书 §7/§8/§5；成本模型（分页取回 (k−1)×C） |
| v1.0.1（0.5.1-beta） | 未新增命令/属性：补围栏隔离（§7）、同轮交付与 `tf-ask` 的 `awaiting:user`（§2.4/§1）、观测三档更名 `full/dedup/handle`（§2.3，与 `feedbackBytes` 三桶逐字一致） | 0.5.1-beta 清单 2.1 / 1.1 / 2.2；命令表仍为 14 条 |
| v1.1.0（本轮） | 加属性（按 §8.1 流程，命令表仍 14 条）：`tf-peek` 增 `offset`（字符级起点）/`query`（字面续搜，对齐 `[TF]/recall.py:34`）；新增 `kernel/delivery.ts`（验收谓词 `exists/sha256/bytes/regex` + `verify_delivery` 构建序列）与 `kernel/changes.ts`（文件 read revision 守卫，对齐 `[TF]/executor.py:469`）；`tf-plan` 验收项支持尾部 `:: predicate(...)` 与 `> [id]` 活动项（单个 in_progress）。双通道：全部仅 a（standard）通道生效；b（code）通道让位时仍不解析 tf-*。 | 1.2 / 1.3 / 2.3 / 4.1；A10 流程解除 |
| v1.2.0（本轮） | b 通道 PTC 对齐（审查修正版）：`tf-code` 加 `state`/`sandbox`/`release`/`format` 属性（§2.8）；按宿主真实契约仅 `stateOwner`/`sandboxPolicy` 进 resolve、`errorClass` 进 bindings、`release` 为 runtime async 方法、执行形态由 `runtime.programFormat` 决定；新增可选 v12 协议段（bridge 通道显式开启可达）；子调用审计只写私有 ledger。 | 清单 3.1/3.2/3.3；宿主 ptc-runtime/types.ts:76-110 + index.ts:126-138 |
| v1.3.0（0.5.2-beta） | 未新增命令/属性（命令表仍 14 条）：① `sandbox` 取值收为白名单三值并新增错误码 `invalid-attribute`（§2.8）；② `sandboxPolicy` 派生改 `{session, mode}`（不再丢会话策略）；③ 沙箱策略变化 ⇒ 同名 `state` 保留态作废；会话结束时逐 owner release（§2.8）；④ 版本守卫与验收谓词**默认装配**，并明确"目标不存在 + 无读观察 = 新建放行"（§2.7）；⑤ `tf-peek query` 未命中改为**正常结果正文**（原为结构化失败，误入错误通道）；⑥ 新增 `receipt:N` 引用空间（自写回执可用 `tf-peek handle="receipt:N"` 复读）；⑦ 行内代码（`…`）内的 `<tf-*>` 只作散文（§7）；⑧ tf-edit body 兼容上游 `<old>/<new>`（§1 备注）。双通道：①–⑥⑧ 仅 a 通道生效；⑦ 两通道共用解析器。 | 0.5.2 审计（PTC 契约 M1–M17 / thinkflow 缺口 C1–C20）；§8.1 全流程 |
| v1.4.0（0.5.3-beta） | 加属性（命令表仍 14 条）：`tf-code` 增 `sandbox_permissions` + `justification`（成对、白名单、宿主 `approveEscalation` 审批、只覆盖本次、提权时忽略 `state`），新增可选 v14 协议段；`limits` 语义定型（23 键、未设/0 = 不限制、三层来源），缺省不再预设 stallReentries / closeOutRequests；收敛改为**结构性**（同一 premature-final 事由 + 零新增产出 → blocked；收束期按撞墙事由去重）。双通道：属性仅 b（bridge）通道生效，v14 段仅显式开启可达。 | 0.5.3 修复轮（V1.3-1/2/3 实抓的无界重入 / 上限 UI）；§8.1 全流程 |
| v1.5.0（0.5.0 正式版） | **加命令**（ADR-002，命令表 14 → 17）：`tf-changes`（回执目录）/`tf-diff`（快照差分）/`tf-revert`（守卫式回滚，expected 双重校验 + undo 回执），对齐 `[TF]/changes.py:157-272`；新增可选 v15 协议段（默认不进装配，金样逐字节不变）。同轮配套（不加语法）：`request:N` 别名补登记到任务起点与段边界丢弃（原仅压缩路径）；默认密钥文件拒读 + 模型可见输出脱敏（`[TF]/security.py`，装配 `allowSensitivePaths`/`redactOutput` 回退点）；行为预设与上下文"完全不处理"开放选项（控制面，不进协议）。双通道：三命令与 v15 段两通道共用解析器；preset 让位形态下模型可见性由宿主 preset 决定。 | 0.6.0 覆盖核验（changes/security/conversation 缺口）；ADR-002；§8.1 全流程 |
