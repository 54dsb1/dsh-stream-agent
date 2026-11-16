# tf-code 真机五场景（K6，人工执行；每场景记录输入 / kind / 账本 / 最终状态）

> 前提：宿主挂载 `@deepseek-ai/dsh-ptc-runtime`，装配 `enableCode: true`（或 `power` 模式）。
> 每个场景跑完记录：任务文本、结果 kind、`plugin:tf-agent/command` 账本行（sandbox 事实）、
> 最终状态（completed / blocked / error）。mock 不替代真机（K6 红线）。
> 预算参考：每场景约 0.5–2 元（deepseek-flash；见 docs/TEST-PROPOSITIONS.md 口径）。

## S1 成功（happy path）

```
请用 tf-code 统计 data/sales-q1.csv 的行数与"amount"列的总和，把结果写进 out/summary.md（两行：total=、sum=）。
```

- 期望：`tf-code` ok；`enforcement` 记账在账本；summary.md 内容正确；completed。
- 取证：账本 `mode`/`enforcement`；driver-*.json 里 command c1 ok。

## S2 失败（代码错误 → 结构化 kind）

```
请用 tf-code 读取 data/sales-q1.csv 并统计，把结果写进 out/summary.md。（程序里故意写错：调用不存在的 tools.parseCsv）
```

- 期望：失败注入 `[tf-stream:code-error] kind=exception retry=yes`（或 invalid-output）；
  模型修复后重发（换新 id）或改道 tf-bash；不允许原样重跑拿到相同错误后无进展循环。

## S3 取消（K4）

```
（发起一个 tf-code 长程序后，在运行中按 Esc / 发取消）
```

- 期望：`kind=abort`，abort ≤500ms 内传导；回合以 aborted 收束；**0 次后置写**
  （取消后工作区不再出现新文件——对照工作区 manifest 前后快照）。
- 取证：账本 command failed kind=abort；turn-end reason aborted。

## S4 沙箱拒绝（K2：拒绝与代码错误分开）

```
（把 workspaceRoot 指到只读目录，或用 sandboxPolicy 拒绝写路径后）
请用 tf-code 把结果写入 out/blocked.md。
```

- 期望：绑定 write 失败 → 程序失败 `kind=exception`（宿主拒绝文本）或程序改道；
  账本记录 `denied` 与 `mode`；注入文案**不得**引导"修改代码重试"来解决权限问题
  （拒绝 ≠ 代码错误，K3 红线）。

## S5 partial（Windows enforcement 可见）

```
（Windows 宿主 + ACL 档沙箱）请用 tf-code 在工作区内写 out/partial.md 并读回验证。
```

- 期望：账本 `enforcement=partial` 显式可见；文档/注入不出现"已隔离/绝对只读"表述；
  结果按"文件效果部分强制"陈述。

## 通过标准

5/5 场景全部符合期望；声明面抽查：README / docs/limitations.md / docs/protocol.md
三处无"隔离/等权"表述、`partial` 与 `danger-full-access` 均可见（K6 声明一致）。
