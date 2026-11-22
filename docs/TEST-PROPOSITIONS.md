# 0.3.0 人工测试命题与提示词（复测用）

> 用途：发布前人工复测（API/真机验证只由人执行——本仓库的开发过程零 API 调用）。
> 执行方式二选一：
>   headless：`dsh --profile stream-headless --patch 无 headless "<提示词>"`（或既有 profile + 插件已装）
>   桌面端：装好插件后新建会话，把提示词整段粘贴发送。
> 每个命题独立新会话（避免跨命题上下文污染）；跑完保留 `~/.dsh/sessions` 对应会话存档与工作区产物。
>
> **预算口径（每个命题 ≈2 元）**：按 deepseek-account/deepseek-flash 计费模型
> （输入未命中 ¥2/M、缓存命中 ¥0.2/M 级、输出 ¥8/M 级——以账单实际为准），单命题
> 单臂总 token 约 1.5 万–5 万（0.2.0 实测：对照臂 12.9 万/10 任务 ≈ 1.3 万/任务），
> 单臂约 0.2–0.8 元；基线对照（跑两臂）合计 ≤2 元/命题。若某命题实际花费显著超过
> 2 元，本身就是发现（记录任务 id 与会话存档，作为 token 账证据）。
>
> 判定纪律：失败与超时计入，不重跑挑数据；产物核对用下方 checks 列，不要靠肉眼"看起来对"。

## A 组：回归命题（0.2.0 已有能力，防 0.3.0 改坏）

### A1 写批基础（对应 eval W1）

提示词：
```
请在当前目录写三个文件：intro.md（3 行，主题：本项目的目标）、plan.md（3 行，主题：实施计划）、notes.md（2 行，主题：注意事项）。每个文件第一行以 '# ' 开头标题。
```
- checks：三个文件存在；intro.md 含 `#`；回合以 tf-final 收束。
- 关注点：无 `[tf-stream:error]` 重入；请求数 ≤5。

### A2 批量写 + 汇总（对应 eval W3）

提示词：
```
请写 8 个文件 modules/m1.txt 到 modules/m8.txt，第 N 个文件内容为 'module N: ok'。然后写 modules/summary.txt，按顺序列出全部 8 个文件名，一行一个。
```
- checks：m1–m8 存在且内容正确；summary.txt 列全 8 行。
- 关注点：写序保证（summary 不缺文件）；总 token 不高于 0.2.0 同任务。

### A3 读大文件答行（对应 eval R1）

seed：`eval/tasks/fixtures/big-report.md` → 工作区 `data/big-report.md`。
提示词：
```
请读取 data/big-report.md，回答两个问题并直接给出答案：1) 第 137 行的完整原文；2) 该文件总行数。不要省略第 137 行的内容。
```
- checks：最终答案含 `424242` 与 `L137-quirk-quokka`。
- 关注点：offset/limit 或 peek 的用法；不整文件重复读。

## B 组：0.3.0 新能力命题

### B1 编辑替代重写（F1 tf-edit；对照"整文件重写"）

seed：`eval/tasks/fixtures/big-report.md` → `data/big-report.md`（约 1.6 万字符）。
提示词：
```
data/big-report.md 里第 137 行是 'L137-quirk-quokka 424242'。请把其中的 424242 改成 999999，其余内容一个字都不能变。改完后回答：第 137 行现在的完整原文。
```
- checks：第 137 行变为 `L137-quirk-quokka 999999`；文件其余行数不变（wc -l 对比 seed）。
- 关注点：模型应走 `tf-edit`（精确替换）而不是 tf-write 整文件重写——**本命题编辑 token
  ≤ 整文件重写 60%** 是 F1 验收口径：用 `summarize.cjs` 对比本命题与 A3 的 token（同 seed）。
- 判定脚本：`node eval/tools/summarize.cjs --stamp <你的stamp> --md`（逐任务四分量）。

### B2 追加语义（F1 tf-append）

seed：任意 md。
提示词：
```
notes.md 已存在（内容 2 行）。请在文件末尾追加一行 'append-ok-<今天日期>'，其余内容一字不改。
```
- checks：原 2 行逐字节保留；末尾恰好多一行。
- 关注点：tf-append 不重写全文；失败时结构化报错不静默。

### B3 搜索替代 shell（F2 tf-grep / tf-glob）

seed：`eval/tasks/fixtures/` 下多文件铺开（big-report.md、settings.yaml、deploy.yaml）。
提示词：
```
请在当前目录下搜索所有包含 'revision' 的文件与行（含行号），并统计一共出现多少次；再列出所有 *.yaml 文件的路径清单。把两个答案直接写进最终回复。
```
- checks：最终答案行数/路径清单正确。
- 关注点：走 tf-grep/tf-glob，**0 次**用 tf-bash 调 Select-String/findstr 兜底（台账可见命令序列）。

### B4 计划与验收（F5 tf-plan + accepts；复合任务）

提示词：
```
请完成一个小任务包：1) 写 plan/step1.txt 内容为 'step1 done'；2) 写 plan/step2.txt 内容为 'step2 done'；3) 写 plan/report.md 汇总两步的文件名与内容。开始前先声明计划与验收项，每完成一步用验收回执标记，全部验收通过后收尾。
```
- checks：三文件存在且内容正确。
- 关注点：会话台账出现 `tf-plan` 与 `plan-accept` 记录；"声称完成但无回执"的项会被
  过早 final 拦截（若模型直接自述完成，驱动器注入 `tf-final 过早：…验收未验证`——记录这次拦截）。

### B5 tf-code 默认关闭（K1 幻觉检查）

提示词（默认装配，未开 tf-code）：
```
请统计 data/big-report.md 里 'quirk' 出现的次数，把结果写进 out/count.txt。
```
- checks：out/count.txt 数字正确。
- 关注点：**协议不声明 tf-code 时模型 0 次尝试 `<tf-code>`**（若有尝试，驱动器注入
  `no-code-channel` 并改道——记录该行为）；本命题用 tf-bash（node/pwsh）或 tf-read 完成。

### B6 tf-code 显式开启五场景（K2–K6）

power 模式（或 `enableCode: true`）下跑 `eval/tools/manual-code-scenarios.md` 的
S1–S5（成功/失败/取消/拒绝/partial）。每场景记录 kind、账本 sandbox 事实、最终状态。

### B7 恢复意图（F6 强杀）

提示词（任意写批任务，如 A2）：
```
请写 8 个文件 modules/m1.txt 到 modules/m8.txt，第 N 个文件内容为 'module N: ok'。
```
- 操作：任务进行中 kill -9 杀掉 dsh 进程（写入前后各试一次）；重启后向**同一会话**继续。
- checks：重启后第一回合**立即 blocked（停机核对）**，不发请求；`dsh-stream-agent intents`
  能列出 pending 意图；人工核对文件后 `--ack` 闭合，重发任务能正常完成且**无重复写**。

### B8 长会话段边界（F7）

操作：同一会话连续发 10+ 个独立小任务（如"写 seg-<N>.txt 内容为 N"）。
- checks：中途某回合起台账出现 `segment-drop`；被丢弃段可用 `tf-peek` 句柄回取；
  会话末尾若干任务的首请求体积不再随历史增长（≤1.5× 首任务口径）。

### B9 双 loop 具名诊断（S3）

操作：把插件装进**已有内建 loop 的 profile**（web/desktop）。
- checks：启动/接管**具名失败**，错误含 `E_DOUBLE_LOOP`、`profile=`、处置建议；
  不是宿主裸错，也不静默共存。装回专用 profile 恢复正常。

### B10 安装前置校验（S2）

操作：`node scripts/install-check.mjs --profile web --dry-run` 与 `--profile stream --dry-run`。
- checks：web/desktop 被拒（含原因与允许列表）；stream 允许并打印装配面；
  校验不写任何东西。

## C 组：成本对照（R3 的手工版）

- 每个命题跑两臂（原生 loop 臂：卸载插件或用 eval-baseline patch；插件臂），
  `node eval/tools/summarize.cjs --stamp <你的stamp> --md` 出逐任务四分量表。
- 判定：插件臂四分量 token ≤ 基线 28.9% 口径下的同批复算值（446,410）；22.3% 已作废，禁止再作为阈值；checks ≥9/10；
  请求数护栏 ≤59/10 任务。**新命令面（B1/B3）单独建基线，不与旧任务混算比例。**
