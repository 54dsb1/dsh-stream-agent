# eval/GATE-0.3.0.md —— 0.3.0 发布门禁记录

> 生成：scripts/gate.mjs（离线项就地判定；真机项见下）

- [x] G1 装配一致性（R2 四项） — [check] 4/4 全绿：entry 集 / inject / 装载顺序 / README 数字与命令表。
- [x] G2 C2 单 loop 权威（agent-loop 停用 + E_DOUBLE_LOOP 具名） — agent-loop 停用行=true，loop entry 最后装载=true，具名诊断=true（单测 test/activation.test.ts）
- [x] G3 C8 卸载原子（停用只在 bundle 层；profile patch 无接管行） — profiles/stream/cordis.patch.yml 无 agent-loop 行=true（真机装卸回归：scripts/install-cycle.mjs，待人工复测）
- [x] G4 C9 tag = package — tag v0.3.0 精确命中
- [ ] G5 C1 token 门槛（T1/checks/请求数） — eval/runs/2026-11-15 两臂在位；T1=?%（0.2.0 基线口径）；0.3.0 对照数字以 summarize.cjs 复算为准，发布前必须重跑 R3
- [ ] G6 回退演练（安装→使用→回退→宿主恢复） — 未记录 → 发布前在真机执行 scripts/install-cycle.mjs 并勾选 eval/GATE-0.3.0.md 中的回退演练项

## 真机复测清单（发布前必须回填）

- [ ] R3 评测矩阵：10 任务 + 哨兵两臂重跑（`eval/tools/runner.cjs --stamp <新>`），数字可复算
- [ ] 回退演练：已执行（scripts/install-cycle.mjs 10 轮 + 回退 0.2.x 产物验证宿主恢复）
- [ ] M2 T3 三格：B / A-1a / A-1b 同批首请求对照（eval/tools/t3-cells.cjs）
- [ ] K6 真机五场景：成功/失败/取消/拒绝/partial（eval/tools/manual-code-scenarios.md）
