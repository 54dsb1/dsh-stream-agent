# ADR-002：命令表硬上限 14 → 17（v1.5.0 变更回执三命令）

- 状态：已接受（2026-11-25，0.6.0 正式版）
- 关联：PROTOCOL-v1 §8.1（加语法评审流程）、§6.4 / G2（命令表硬上限）、docs/adr-001-segment-boundary.md
- 触发：0.6.0 覆盖核验（独立只读审计）确认 thinkflow `changes.py` 的**快照回执 + 守卫式回滚**
  在插件与宿主两侧均无落点（宿主 `dsh-workspace-changes` 是只读 diff 记录器，无 revert/restore）。

## 背景

v0.4.0 定下命令表 14 条硬上限（11 基础 + tf-call + tf-ask + tf-skill），纪律是"第 15 条必须走
ADR + 退役一条"。目的是控制协议文本的模型可见成本与解析面复杂度。

## 决定

上限提到 **17**，新增三条（全部属 `changes.py` 对齐，缺一条则语义不完整）：

| 命令 | 语义 | 依据 |
| --- | --- | --- |
| `tf-changes` | 列出本会话变更回执（id/操作/路径/状态/可否回滚/expected 哈希） | [TF]/changes.py:217-222 list_changes |
| `tf-diff` | 某次回执的快照 unified diff（快照对快照） | [TF]/changes.py:237-253 diff |
| `tf-revert` | 守卫式回滚（expected 双重校验 + 原子写回 + undo 回执） | [TF]/changes.py:255-272 revert |

## 为什么不合并成一条 / 不退役旧命令

1. **合并（`tf-changes op=list|diff|revert`）仍净增 1 条（15）**，不满足旧上限；且把三种语义
   塞进一个命令的属性分支，parser schema 与错误诊断都更含糊（required 属性随 op 变化）。
2. **退役任何旧命令都破坏既有能力面**（14 条各有真机落点与测试钉死），代价高于收益。
3. **成本可控**：三条命令的模型可见语法住在**可选协议段 v15**（默认不进装配，金样逐字节不变，
   旧会话前缀缓存零回归）——与 v11/v12/v14 同一纪律。默认协议成本不增加；只有显式开启
   `protocolSections: { v15: true }` 的会话才支付这段文本。
4. 解析面复杂度增量是三个**无正文、属性极简**的命令（tf-changes 可选 path；tf-diff 必填 change；
   tf-revert 必填 change+expected），不引入新的正文形态或围栏规则。

## 后果

- `scripts/check-consistency.mjs` 检查 5 的上限改为 17（引用本 ADR）；README §4 命令表同步 17 条。
- 后续再加命令仍须走 §8.1 流程 + 新 ADR；17 不是"随便加"的许可。
- 回执持久化目录 `stateDir/changes/<session>/` 在模型输入之外（模型不能经 tf-write 覆盖
  授权回滚的回执）；快照可用性判定（超大/二进制/敏感）与 TF 同口径，敏感内容不存快照。