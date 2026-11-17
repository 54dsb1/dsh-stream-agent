# 能力对等矩阵（v0.4.0 P0 取证）

> 判据（design §5.1 G1）：`standard`/`ptc` 能调到的每一个工具，stream 模式都有**一条可成功的调用路径**，
> 语义（参数、错误、结果形状）一致。本页给出逐工具的通道取证与成本数字；全部可由
> `node eval/tools/surface-baseline.cjs` 复算（原始产出见 `eval/runs/surface-baseline-2026-11-18.{txt,json}`）。

## 1. 通道对等矩阵

取证行：standard/ptc = `@deepseek-ai/dsh-web-app/presets/{standard,ptc}.patch.yml`（rc.3）；
stream = 本包 `preset/stream/cordis.patch.yml`（0.4.0，16 行）。

| 模型可见工具 | standard | ptc | stream（0.4.0）通道 |
|---|---|---|---|
| read | tool-fs | tool-fs | tf-read ／ tf-call ／ native(core) |
| write | tool-fs | tool-fs | tf-write ／ tf-call ／ native(core) |
| edit | tool-fs | tool-fs | tf-edit ／ tf-call ／ native(core) |
| apply_patch | —(applyPatch:false) | —(applyPatch:false) | tf-append(EOF 锚) ／ tf-call ／ native(core 流开 applyPatch:true) |
| read_image | tool-fs | tool-fs | tf-call ／ native(standard/full) |
| grep | tool-fs-search | tool-fs-search | tf-grep ／ tf-call ／ native(core) |
| glob | tool-fs-search | tool-fs-search | tf-glob ／ tf-call ／ native(core) |
| bash \| pwsh | tool-bash \| tool-pwsh | 同左 | tf-bash ／ tf-call ／ native(core) |
| job_list / job_output / job_kill | tool-jobs | tool-jobs | tf-call ／ native(standard/full) |
| schedule_*（4 个） | tool-schedule | tool-schedule | tf-call ／ native(standard/full) |
| skill | tool-skill | tool-skill | tf-call ／ native(standard/full) |
| create_goal / get_goal / update_goal | tool-goal + command-goal | 同左 | tf-call ／ native(standard/full) |
| exit_plan_mode | plan-mode 组 | plan-mode 组 | tf-plan 收束语义承担计划审批（不经宿主 plan-mode） |
| subagent / subagent_fork | delegation 组 | delegation 组 | tf-call（0.4.0 preset 已声明 delegation 组） |
| workflow | tool-workflow | **disabled** | 不启用（§5.2 非目标：与 ptc 对齐） |
| ask_user_question | tool-ask-user | tool-ask-user | tf-call ／ native(standard/full) |
| todo_write | tool-todo | tool-todo | tf-call ／ native(standard/full) |
| web_search / web_fetch | tool-web | tool-web | tf-call ／ native(standard/full) |
| present | present | present | tf-call ／ native(standard/full) |
| office_*（3 个） | tool-office | tool-office | tf-call ／ native(standard/full) |
| run_code | — | tool-executor-ptc | tf-code（PTC 桥接；K1 默认关，P5 全绑定） |

**结论**：除 `workflow`（ptc 也停用）与 `exit_plan_mode`（语义由 tf-plan/收束判定承担）外，
每个工具都有 ≥1 条通道；`tf-call` 是全量可达兜底（G2：命令表净增 1）。G1 = **有路径**，逐工具
smoke 用例见 `test/v040-surface.test.ts`（S5 透传）与后续真机三臂复跑（P6）。

## 2. schema 成本（为什么 tf-call 是省 token 的通道）

宿主工具包源文本静态提取（近似下界——description 多为运行时拼装，真机成本待复测）：

- standard 面可提取 schema 源文本合计 ≈ **17.4 KB / 27 个 defineTool 块**
  （≈ 4.4k 字符 ≈ **1.2k tokens/请求** 的下界；含 runtime-composed 描述则更高）。
  每请求都付；nativeTools 全量声明 = 每请求 +1.2k tokens。
- core 白名单（read/write/edit/apply_patch/grep/glob/bash|pwsh）≈ **5.6 KB**（≈ 0.4k tokens）。
- tf-call：协议段一次性成本 **533 字符**（≈ 153 tokens，含 tf-ask/tf-skill），逐调用 `{"query":"…"}` ≈ 15-30 tokens。
  非高频工具的会话总成本显著低于全量声明（调用 5 次 ≈ 100 tokens vs 声明 10 请求 ≈ 12k tokens）。

分族数字（params+desc 源字节）：fs read 358B / write 377B / apply_patch 547B / edit 692B /
read_image 137B；fs-search grep 465B / glob 469B；bash|pwsh 1653B；jobs 738B（3 工具）；
schedule 2141B（4 工具）；skill 266B；goal 1259B（3 工具）；subagent 518B；
ask_user_question 2993B（两个 defineTool 变体，运行时取其一）；todo_write 554B（描述运行时拼装）；
web 440B（2 工具）；present 1009B；executor-ptc run_code 未提取（executor 面）。

## 3. stream 固定协议段（字符，src 导入实测）

| 段 | 字符 | ≈tokens | 声明条件 |
|---|---|---|---|
| DEFAULT_SYSTEM_PROMPT | 85 | 25 | 恒定 |
| DEFAULT_PROTOCOL_TEXT | 2836 | 811 | 恒定（0.3.1 基线含 DSML 第 7 条） |
| DEFAULT_CALL_PROTOCOL_SECTION | 533 | 153 | callCommand 开（默认开，toolSurface≠off；含 tf-ask/tf-skill 两条专用语法） |
| DEFAULT_CODE_PROTOCOL_SECTION | 1175 | 336 | 仅 enableCode:true |
| DEFAULT_INVARIANTS | 242 | 70 | 恒定 |

**合计（默认配置）≈ 3696 字符 ≈ 1.06k tokens/请求**，与 0.3.x 相比净增 533 字符（tf-call 段，含 tf-ask/tf-skill 专用语法）。
T1 的协议段瘦身（§9：−15%~25%）在 P2 落地时从映射关系说明里压缩，不在本 beta 的默认配置中体现
（beta 先保对等，瘦身作为 T1 度量后的独立提交）。

## 4. 已知口径限制

- `paramsBytes` 是宿主源码里 `parameters` 字面量的 UTF-8 字节数；JSON 序列化后与此同量级，但
  `description` 为运行时拼装的工具（todo_write 等）静态提取不到 → 真机 schema 成本待复测。
- `ask_user_question` 在宿主包里有两个 defineTool 变体（静态提取不可区分运行时取哪个），合计数偏大。
- `exit_plan_mode` 的"路径"是语义等价（tf-plan + 收束判定 + F5 验收），不是宿主 plan-mode 的
  状态机——如实记录差异，不算严格对等（见 design §5.2 非目标边界）。
