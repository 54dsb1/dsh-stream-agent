# 禁用行审计表（S5，0.3.0-beta.1 交付）

> 审计对象：`cordis.patch.yml`（主 bundle patch）中全部停用行 + 全部"候选停用未停用"行。
> 判定规则（升级方案 §10.2）：不确定就保留；同族同进同退；按 id+name 双重匹配；
> 不以 token 为由停宿主提示行；每条停用必须带启动用例。
> 宿主服务面锚点：`@deepseek-ai/dsh-base`（rc.3）`dsh-web-app/cordis.patch.yml`、`presets/standard.patch.yml`。

## 1. 已停用行（主 bundle patch）

| 行 id | 插件 name | 被谁 inject / 依赖 | 停用后哪条路径不可用 | 验证用例 | 结论 | 依据 |
|---|---|---|---|---|---|---|
| `agent-loop` | `@deepseek-ai/dsh-agent-loop` | `agents` 服务消费 factory；loop entry 接管后由 `setFactory` 全局唯一槽位决定 | 内建回合制 loop（本插件以单流协议替代） | `test/activation.test.ts`（严格 inject 守卫 ctx 装载回归 + factory 冲突 `E_DOUBLE_LOOP` 具名失败）；真机装卸回归 `scripts/install-cycle.mjs` | **必须停用** | C2 单 loop 权威；停用留在 bundle 层（C4），卸载原子恢复 |

停用行总数：**1**。审计结论：主 bundle 只停内建 loop 一行；不存在"批量 disabled"。

## 2. 候选停用但保留的行（含保留依据）

以下行在 standard preset / host 平面中存在，对本协议"不消费"，但**全部保留**——
宿主提示行不进本驱动器请求（升级方案已核实），停用只缩小装配面、不省 token，
而每停一行都要一张启动用例证明"运行期不缺服务"。风险收益不成比，宁可保留。

| 行 id / 族 | 保留依据（谁在用、停了会怎样） | 风险 | 结论 |
|---|---|---|---|
| `persona` / `agent-instructions` / `time-context` | 宿主 system 组装面；驱动器自建 system，这些行不进请求 | 停用影响同 profile 其它 preset 使用者 | 保留 |
| `tool-jobs` / `tool-schedule` / `tool-goal` / `command-goal` | 宿主平面工具；协议不声明，模型不会调用（未列工具 0 调用，S4） | 停用后宿主其它入口（jobs API）缺服务 | 保留 |
| `tool-web` / `tool-skill` / `tool-present` / `tool-office` | 同上；协议面只有 tf-* | 同上 | 保留 |
| `tool-todo` / `tool-ask-user` | 同上 | 同上 | 保留 |
| `tool-subagent*` / `tool-agent-team` | delegation 族（宿主 isolate 组）；本驱动器不派发子代理 | 族内行同进同退，单停任一行会破坏 isolate 组挂点 | 保留（族） |
| `plan-mode`（planning 组） | planMode isolate 组挂点 | 组拆散 = 装配面漂移 | 保留 |
| `compaction-basic` / `command-compact` / `tool-result-pruner`（compaction 族） | compaction isolate 组挂点；本驱动器不触发压缩 | 若宿主在 `llm/stream` 层挂压缩钩子则须停用（否则改写历史破 C7 前缀）；rc.3 实测挂点在 agent 层、本驱动器路径不触发 | 保留（族）+ 监控：任何"历史被改写"都会被 preflight fail-closed 拦截 |
| `workflow-ptc` / `tool-workflow` / `tool-executor-ptc` / `ptc-runtime`（PTC 族，四行） | PTC 四行同进同退（升级方案强制）；K1 后默认 `enableCode=false`（协议不声明 tf-code），四行**全保留**且不动 | 只停任一行会留下悬空依赖（启动期缺服务） | 保留（族，全进全退）；`tf-code` 通道由 `enableCode` 配置控制，不由装配禁行控制 |
| `tool-pwsh` / `tool-bash`（平台二选一） | `tf-bash` 映射目标（preset 内按平台 disabled） | 全停 = tf-bash 无映射目标 | 保留其一 |
| `tool-fs` / `tool-fs-search` | `tf-write/tf-read/tf-edit/tf-append` 与 `tf-grep/tf-glob` 的映射目标 | 全停 = 全部文件命令无映射 | 保留 |
| `agent-preset-registry`（仅 web） | `preset-stream` 的注册与默认值（S4） | 停用 = preset 面不可用 | 保留 |
| `llm` / `session` / `storage` / `settings` / `credentials` / `fs-sandbox` / `sandbox` / `sandboxPolicy` | 服务层（S 组保留清单，驱动器 inject 依赖） | — | 保留 |

## 3. 判定过程记录（为什么没有更多停用行）

1. 0.2.x 曾计划"停用 tool-web 等候选行以缩小装配面"——0.3.0 审计后**全部放弃**：
   这些行不进驱动器请求（无 token 收益），停用唯一效果是装配面变化 + 每行一个
   启动回归的维护成本。把"装配面缩小"写成"token 优化"属于虚报（C5）。
2. PTC 四行与 compaction 四行按族处理（升级方案 §10.1 强制），本版全保留；
   `tf-code` 的开关在配置层（`enableCode`，K1 默认 false），通道关闭 = 协议段
   0 字符 + 命令级失败引导改道，不需要动装配行。
3. compaction 族的"挂点验证"：宿主 rc.3 的 compaction 组挂在 agent isolate 层，
   本驱动器路径不触发；若未来宿主把压缩挂到 `llm/stream` 层，preflight 断言
   （`PrefixBrokenError`）会立即 fail-closed 暴露——届时按本表"族同进同退"停用。

## 4. 回归锚点

- 装载回归：`test/activation.test.ts`（严格 inject 守卫 + 可选服务探测）
- 装配一致性：`npm run check`（R2 四项，含"停用只在 bundle 层"结构检查）
- 真机装卸：`scripts/install-cycle.mjs`（10 轮，卸载后宿主 loop 恢复、0 残留）
