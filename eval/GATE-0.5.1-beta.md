# eval/GATE-0.5.1-beta.md —— 0.5.1-beta 发布门禁记录

> 生成：scripts/gate.mjs（自动项每次重判；真机项保留既有勾选，不覆盖人工记录）

## 自动项

- [x] G1 装配一致性（7 项全绿） — [check] 7/7 全绿：entry 集 / inject / 装载顺序 / README 数字与命令表 / 命令表上限 / 矩阵一致 / NOTICE 一致。
- [x] G2 C2 单 loop 权威（agent-loop 停用 + E_DOUBLE_LOOP 具名） — agent-loop 停用行=true，loop entry 最后装载=true，具名诊断=true（单测 test/activation.test.ts）
- [x] G3 C8 卸载原子（停用只在 bundle 层；profile patch 无接管行） — profiles/stream/cordis.patch.yml 无 agent-loop 行=true（真机装卸回归：scripts/install-cycle.mjs，待人工复测）
- [ ] G4 C9 tag = package — 当前 HEAD 无精确 tag（发布提交时打 v0.5.1-beta；工作区数字以 package.json 为准）
- [ ] G5 C1 对照数据（0.4.x 两口径 + 四臂 H1/H2） — 未指定 --stamp（发布必须显式指定本次批次目录，缺省不取历史批次）；两口径可复算：四分量=28.9%、严格二分量=134.9%；四臂真机产物缺失（需 eval/runs/four-arm-<stamp>.json，schema=four-arm-real/*，verdict.h1/h2 均已判定）
- [ ] G6 回退演练（九项开关 + 安装循环） — 九项开关 9/9 通过（rollback-2026-11-23.json，生成 2026-11-23T13:06:09.446Z；驱动级离线）；真机项未勾选 5/5：安装-回退循环、R3 评测矩阵、四臂 benchmark、M2 T3 三格、K6 真机五场景

## 回退开关逐项（§12.4，九项；产物 eval/runs/rollback-<stamp>.json）

- [x] channel: 'standard' — PASS（rollback-2026-11-23.json；代码通道不启用：回退标准通道后可验证，标准通道工具路径可用）
- [x] tier: 'standard' — PASS（rollback-2026-11-23.json；数值回默认：maxSteps 24 / maxInputTokens 20k / peek 24k / keepRecent 30 / 摘要 16k）
- [x] effectElision: false — PASS（rollback-2026-11-23.json；保留程序全文：不产生 [applied pN]，幂等重发仍回灌原始结果）
- [x] surfaceCompaction: false — PASS（rollback-2026-11-23.json；不压缩：无摘要、无 context-rebased，消息序列保持原样）
- [x] spanLedger: false — PASS（rollback-2026-11-23.json；无重复抑制：重复读取恒回正文（行为等价 0.4.x））
- [x] peekIndex: false — PASS（rollback-2026-11-23.json；回到头部截断：大文件不再投行锚索引）
- [x] prefixPolicy: 'fail' — PASS（rollback-2026-11-23.json；绝不换基：append-drift 也 fail-closed，违约必报错）
- [x] surfacePolicy: 'profile' — PASS（rollback-2026-11-23.json；0.4.x 工具面：走 core 白名单过滤）
- [x] maxSteps / maxInputTokens 取消 — PASS（rollback-2026-11-23.json；无上限（仅观测告警）：不压缩、不收束，长任务不中断）

## 真机复测清单（发布前必须回填）

- [ ] 安装-回退循环 — scripts/install-cycle.mjs 10 轮 + 回退 0.4.0 产物验证宿主恢复（真机）
- [ ] R3 评测矩阵 — 10 任务 + 哨兵两臂重跑（eval/tools/runner.cjs --stamp <新>），数字可复算
- [ ] 四臂 benchmark — L0–L3 真机，产物写入 eval/runs/four-arm-<stamp>.json（判定见 G5）
- [ ] M2 T3 三格 — B / A-1a / A-1b 同批首请求对照（eval/tools/t3-cells.cjs）
- [ ] K6 真机五场景 — 成功/失败/取消/拒绝/partial（eval/tools/manual-code-scenarios.md）
