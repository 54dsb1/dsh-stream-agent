# 实机测试：默认模式下「关插件 / 开插件」各跑一个项目

> 目的：拿一组**同题、同模型、同装置**的真机数字，先看 0.3.0 在默认配置下的方向对不对，
> 再决定要不要投入 R3 十题矩阵（`npm run gate` 的 G5 门槛只认 R3 全量数据，本页不能替代它）。
> 状态：工具与题面就绪，等 API key。

## 1. 测什么

| 项 | 取值 |
|---|---|
| 臂 | **baseline** = 插件关（`patches/eval-baseline.yml`：停用五个 entry + 恢复内建 `agent-loop`）<br>**stream** = 插件开（`patches/eval-stream.yml`：默认配置，`balanced`，`enableCode: false`） |
| 项目 | 默认 `R2`（跨文件改配置，3 个 seed 文件，3 条 checks）；可换 `--task C1`（读→算→写，更便宜）或 `W2` / `C2` |
| 次数 | 每臂 **1 次**（单样本，只作方向参考） |
| 控制变量 | 同一份 `tasks.json` 题面、同一批 fixtures、两臂同装 `eval-probe` 探针、同一把 key、同一模型 |
| 口径 | 总 token = Σ(input + cacheRead + cacheWrite + output)，逐请求取 probe `usage` 原文；标题旁路请求两臂同剔（`eval/METRICS.md` M1） |

## 2. 怎么跑

```bash
cd dsh-stream-agent

# 0) 只看计划（不读 key、不调模型）
node eval/tools/machine-test.cjs --plan

# 1) 真跑：两臂串行，跑完自动汇总 + 出报告
node eval/tools/machine-test.cjs --key sk-xxxxxxxx --task R2 --stamp 2026-11-17a

# 也可以把 key 放环境变量（dsh 的 credential 解析顺序：宿主凭据库 → 进程环境 → .env）
DEEPSEEK_API_KEY=sk-xxxx node eval/tools/machine-test.cjs --task R2 --stamp 2026-11-17a

# 2) 只从既有 metrics 重新出报告（不重跑）
node eval/tools/machine-test.cjs --report-only --task R2 --stamp 2026-11-17a
```

参数：`--task <id>`（默认 `R2`）、`--stamp <dir>`（默认 `<今天>-machine`）、`--timeout <秒>`（默认 900）、
`--force`（同 stamp 已存在时覆盖）、`--runs <dir>`（产物根目录，默认 `eval/runs`）。

## 3. 产物在哪、看什么

```
eval/runs/<stamp>/
├── machine-test-report.md          # ← 先看这个：两臂对照表 + 比值 + 如实说明
├── RESULTS.md                      # 逐任务对照（gen-results 生成，不覆盖 eval/RESULTS.md）
├── summary.json                    # M1 四分量逐任务汇总
├── baseline/R2/{ws,probe,metrics.json,session-log/}   # 插件关的原始证据
└── stream/R2/{ws,probe,metrics.json,session-log/}     # 插件开的原始证据
```

判读顺序：

1. `machine-test-report.md` 的 **对照/基线总 token 比**——这是本次唯一结论，别外推到十题。
2. 两臂 `checks` 必须都是 `PASS`；任一 FAIL 说明产物不对，token 比没有意义。
3. 请求数（`M2_callCount.probe`）与 `injected_ratio`（stream 侧）：判断省的是"往返次数"还是"单次注入量"。
4. `exit=1` 但 `checks=PASS` 通常是重入预算护栏耗尽（[docs/limitations.md](../docs/limitations.md) 第 2 条），
   报告里保留原始 exit，不粉饰。

## 4. 红线

- **不改写 README / CHANGELOG 里的 28.9%**：那是 `2026-11-15-v02` 十题批次的全量口径，本页是单题单次。
- **不用本页数字过 G5**：`gate.mjs` 只认 `--stamp` 指向的十题两臂数据；本页最多作为 R3 的前置侦察。
- key 只进子进程环境变量，不落盘、不进日志（工具只打印后 4 位）。
- 失败样本照样计入，不挑数据、不重跑到好看为止。

## 5. 常见失败

| 现象 | 原因 / 处置 |
|---|---|
| `MISSING_CREDENTIAL` / `ACCOUNT_SIGN_IN_REQUIRED` | key 没传到子进程或该 provider 走账号登录态：确认 `--key` 生效（`key: ****abcd`），或先在 dsh 里登录 |
| 某臂 `metrics.json` 缺失 | 该臂 dsh 起不来或超时：看工具打印的 stderr 尾部；必要时 `--timeout 1800` |
| `eval/runs/<stamp> 已存在` | 换 stamp，或 `--force`（只覆盖同名两臂目录） |
| 两臂 model 不一致 | `gen-results` 会在表里标「作废重跑」——别忽略，重跑该臂 |
| 想换项目 | `--task W2`（5 章节文件）/ `--task C2`（失败改道）/ `--task C1`（最便宜） |

## 6. 跑完之后

```bash
node eval/tools/summarize.cjs --stamp <stamp> --md     # 复核四分量
node eval/tools/replay-check.cjs --stamp <stamp>       # 可选：回放一致性（对照臂应 10/10 量级）
npm run gate -- --stamp <stamp>                        # G5 会用该 stamp 复核；G6 仍需装卸演练记录
```

G5 过门禁还需要**十题两臂**（本页只有一题）：跑 `node eval/tools/runner.cjs --arm <baseline|stream> --stamp <新> --tasks all`
两遍，再 `summarize` + `gen-results --out`。
