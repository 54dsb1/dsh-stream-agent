# 本版本相比 V0.4.0（main 仓库）升级了什么

本文只对比**两个版本**：本版本（`artifacts-v0.5` 工作区，协议规范 v1.5.0）与 main 仓库
V0.4.0（`dsh-stream-agent` 0.4.0，14 条命令 / 四模式控制栏）。不涉及中间版本的演进叙述。

## 一句话总结

V0.4.0 是"单流协议 + 四模式数值预设 + tf-code 可选窄桥"；本版本把它升级为
**"双通道执行轴 + 自有请求装配链 + wire 传输面用户可控 + 上下文治理全面增强"**——
执行面多出一条完整的 PTC 兼容通道，请求的传输字段从宿主决定变为用户随时可调，
默认数值面与请求组装语义对齐 xuxiang-thinkflow 出厂预设。

## 总览

| 维度 | V0.4.0 | 本版本 |
| --- | --- | --- |
| 执行形态 | 单通道（tf-* 命令）+ tf-code 可选开关 | 双通道：标准通道 + PTC兼容模式（preset / bridge 双来源） |
| 控制轴 | 四模式（balanced/lean/compat/power，数值预设） | 执行通道 × 上下文档位两正交轴（档位仅参考值） |
| 默认数值 | 四模式各带一组预设上限（lean 60k 阶梯等） | thinkflow 对齐层（无轮数上限），29 键全部用户可调 |
| wire 传输 | 宿主决定（插件只有 provider/model/messages/tools） | max_tokens / thinking / stream_options / tool_choice / 建连重试，请求前逐项组装 |
| 推理回传 | 宿主原样续传 | `provider-required` / `drop-stale`（剥离 replayState）双策略 |
| tf-* 命令 | 14 条 | 17 条（新增变更回执三命令） |
| 测试规模 | 388 用例全绿 | 623 用例 / 622 通过 / 0 失败 / 1 预置跳过 |

## 1. 执行通道：从"单通道 + 开关"到"双通道双来源"

- V0.4.0 只有 `enableCode: true/false` 一个开关（power 模式才开 tf-code），走
  `ctx.ptcRuntime` 单一窄桥。
- 本版本新增**PTC兼容模式**（内部 id `code`）：来源判定先探测宿主 PTC preset 工具面
  （`preset` 来源——插件完全让位执行，协议段 0 字符），再探测 `ctx.ptcRuntime`
  （`bridge` 来源——受限 `tf-code` 窄桥 + `sandbox_permissions` 单次提权）。判定是
  **惰性实时**的：会话创建与切换通道时现取宿主服务重新判定，PTC preset 按窗口/会话
  后挂载也能进入；两来源皆无时拒绝进入并回退标准通道（不静默降级）。

## 2. 请求装配链自有化

- V0.4.0 的请求内容由渲染器直出。
- 本版本内核新增 `assembly.ts`：`AssemblyPlan` 纯函数投影是请求内容的唯一事实源——
  内容寻址去重、预算 fail-closed、dry-run 可对账；plan 模式下 `tools` 声明面**只由
  投影决定**（首请求 0 schema、≤7 名；`tools: null` 时字段整体不发）。

## 3. wire 传输面（全新）

- V0.4.0：`max_tokens` / `stream_options` / `thinking` / `tool_choice` 全由宿主决定，
  插件不可控。
- 本版本：每个请求发送前从生效 limits 逐项组装——`maxTokens`（0 = 委托 provider）、
  `thinkingBudget`（≥1024 生效）、`streamUsage`（`stream_options.include_usage`）、
  `thinkingMode` + `reasoningEffort`（enabled 未给 effort 时取 high）、原生工具声明
  在面内 → `tool_choice: 'auto'`、`maxRetries` / `retryBackoffMs` 建连重试。
  数值默认 = thinkflow 出厂预设，控制面板 / `limits --set` / 装配 config 改完下一
  请求即生效。

## 4. 推理回传策略（全新）

- V0.4.0：assistant source 按宿主原样携带（含 provider 会话续传状态）。
- 本版本：`reasoningStrategy` 双实值——`provider-required`（默认，原样携带）与
  `drop-stale`（保留 source 壳、剥离 replayState：请求纯文本、每请求无状态，靠前缀
  单调续缓存而非 provider 会话续传）。

## 5. 上下文治理增强

- 沿用 V0.4.0：观测句柄化（大结果回句柄 + 摘要）、行段取回。
- 本版本新增/增强：span 账本去重、行锚索引、确定性压缩、效果折叠、语义状态摘要、
  `tf-peek` 取回预算（`peekBudgetChars`）。

## 6. 前缀不单调处置变更

- V0.4.0：append-drift 受限放行（每回合 1 次/每会话 3 次限流 + 换基成本判据）；
  stable-drift / shrink 一律 fail-closed，另靠同轮自动续跑（≤2 次/回合）救场——
  超限即对话中断。
- 本版本：三类违约在 `prefixPolicy ≠ 'fail'` 时统一为**发送前接受为缓存重置点**——
  同一份请求照常发送（0 额外请求 / 0 重复计费 / 0 注入文本），基线随本请求推进，
  后续恢复单调；限流与成本判据退役（保留为观测计数）。`prefixPolicy: 'fail'`
  显式回退面保留拒发 + 诊断转储 + 最小对账。

## 7. 协议与交付

- 命令 14 → 17 条：新增 `tf-changes` / `tf-diff` / `tf-revert`（写操作成功后登记
  私有变更回执，支持守卫式回滚；写前意图台账 V0.4.0 已有，本版本与回执打通）。
- 可选协议段机制（默认不注入、前缀缓存零回归）：v14 `sandbox_permissions` 单次提权、
  v15 变更回执语法。
- 协议规范独立成文：`PROTOCOL-v1.md`（v1.5.0，命令表 ≤17 硬上限由一致性检查把关）。

## 8. 默认安全面与预设体系

- 新增默认密钥保护：`tf-read` 拒读 `.env` / `*.pem` / `id_rsa` 等（`allowSensitivePaths`
  显式放行），模型可见输出脱敏（`redactOutput` 回退点）。
- 预设体系变更：V0.4.0 四模式（各带预设上限）→ 本版本移除行为预设，默认数值面 =
  thinkflow 对齐层（`keepRecent=30` / `maxSummaryChars=16000` / `maxReadChars=200000` /
  `maxReentries=8`；**无轮数上限**），29 键全部由用户显式定义或覆盖（0 = 该项不限制）；
  旧四模式值走别名映射兼容。

## 9. 控制面升级

- 控制栏从四模式单轴升级为通道/档位两轴交互（`1-5` 选、`c`/`t` 快切、`u` 编辑上限、
  `f`/`v`/`x` 行为开关、`l` 中英）。
- CLI 子命令族：`channel` / `tier` / `limits --set|--replace|--reset` / `fold` /
  `final` / `raw` / `lang` / `intents` / `protocol` / `status --json`。
- 桌面控制页：通道卡（含来源行）、29 键上限编辑器（留空 = 默认预设）、行为开关
  （PTC兼容模式验收闸置灰）、宿主 preset 名册只读展示、中英切换；多窗口并发写 409
  冲突提示刷新，装配锁定的控件置灰。

## 10. 装配纪律与验证体系

- `ra0` 装配自证探针：离线核验"请求真的由插件装配"（证据逐条对源码）。
- `npm run check` 一致性七项（entry 集 / inject / 装载顺序 / README 命令表 / 命令表
  ≤17 / preset ↔ 矩阵一致 / NOTICE 两栏制）。
- 发布门禁 `npm run gate -- --offline`（G1–G3）与发布演练。
- 计量口径收紧：只保留七列尺子（外部可复算），未实测的"省 X%"叙述不进文档；
  四臂评测工具（原生 / 仅 PTC / 本插件 A / 本插件 B）随包提供。
