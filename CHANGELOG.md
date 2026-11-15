# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.1] - 2026-11-15

首次发布到 npm（`@hugesb/dsh-stream-agent`）。

### Fixed

- **桌面端 preset 层工具解析失败**：agent 作用域改用宿主同源 `dsh-scope` 铸造，key 取 agent
  实例本身（镜像内建 `createScope(loopCtx, this)`）。此前作用域 key 不是 agent 实例，
  宿主工具执行器 `selectExecutor(input.agent)` 与守卫 `chainLayers(exec.agent)` 走
  `scopeChainOf(agent)` 时永远落到根层，而 desktop/web 组合的根层不含 `write`/`edit`/`pwsh`
  （这些在 `standard.patch.yml` 的 preset 层），表现为「工具已注册但不可达」。作用域在
  `dispose` 时一并释放；铸造失败回退 ownerCtx 并留痕告警，不影响 headless/fake host。
  Electron 桌面客户端真连实测通过。

### Added

- `README.en.md`：英文 README，与中文版同结构。
- 仓库发布脚本（一条命令完成构建 → 测试 → 版本校验 → GitHub 推送 + tag + Release → npm 发布）。

### Changed

- npm 包名从 `@54dsb1/dsh-stream-agent` 改为 `@hugesb/dsh-stream-agent`（`54dsb1` 是 GitHub
  账号，npm 侧对应账号为 `hugesb`，scope 必须与 npm 账号一致）。README、`preset.yml` 注释与
  架构图中的包名同步更新；GitHub 链接保持 `54dsb1` 不变。

## [0.1.0] - 2026-11-15

首个可安装版本。上游锚点 `@deepseek-ai/dsh@0.2.2-rc.1`（类型）/ rc.3（运行时实测）。

### Added

- **内核层**（`src/kernel/`，零框架依赖，可单独摘出单测）
  - `state.ts` 内容寻址状态树与句柄
  - `obs.ts` `info_gain` 分类与观测账本
  - `parser.ts` `tf-*` 单流协议解析器（协议语法的唯一权威）
  - `gate.ts` 可逆性判定（read/spec/commit/fatal）与一次性凭据
  - `render.ts` 三段式装配与 prefix 单调校验器
- **适配层**（`src/entry/`，薄壳只做翻译）：`loop.ts` AgentFactory + 单流驱动器、`obs-broker.ts`
  泄漏扫描与结果登记、`action-gate.ts` ToolsService guard、`state-handle.ts` `ctx.state` 服务、
  `context-render.ts` O6 第二见证与 O4 动态冻结、`mock-provider.ts` 离线假模型、`eval-probe.ts`
  评测取证。
- **`tf-*` 命令集**：`tf-write` / `tf-read`（支持 `offset`/`limit`）/ `tf-bash` / `tf-peek` / `tf-final`。
- **O1–O6 token 优化**：观测三档返回与行骨架、`tf-peek` 按需取回、句柄目录差分注入、
  动态上下文冻结、预算分级降级、preflight 前缀断言（fail-closed）。
- **上游语义对齐**：隐式写序、重复 id 幂等、乐观 peek 延迟重试、`tf-final` 同 id 覆盖、
  过早 final 检测、错误取因。
- **官方 bundle 形态**：`dsh.manifestVersion: 1` + `dsh.bundle.patch: ./cordis.patch.yml` +
  `engines.dsh`，卸载即回原生行为。
- **桌面端/web 组合适配**：agent 作用域铸造（key = agent 实例本身，镜像内建
  `createScope(loopCtx, this)`——宿主工具执行器与守卫按 `scopeChainOf(agent)` 选层，
  preset 层的 write/edit/pwsh 由此可达）、`modelSelection` 会话投影注册（客户端模型选择器的
  数据面）、resume 序号对账（seed 占位事件立即落盘，根除 "append seq mismatch"）、
  create 冲突回退 resume（桌面端草稿重试不再报 "already exists"）、`steer`/`inbox`/
  `runMaintenance` prompt 面补齐、默认模型三级回退与无路由 fail-fast。桌面客户端
  Electron 真连实测通过。
- 测试 187 用例（`node:test`，零 API 调用），`eval/` 指标口径与 10 任务集两臂 runner。

### Changed

- 仓库结构整理：开发/评测用的组合补丁统一收进 `patches/`，根目录只留 bundle 入口
  `cordis.patch.yml` 与生产装配清单 `preset.yml`。
- 文档拆分为 [`docs/architecture.md`](docs/architecture.md)、[`docs/protocol.md`](docs/protocol.md)、
  [`docs/limitations.md`](docs/limitations.md)，README 只保留结论与入口。
- `engines.node` 从 `>=24` 放宽到 `>=22.18`（构建与 187 用例在 Node 22.22 上实测通过）。
- 新增 CI、`.gitignore`、`.gitattributes`、`CONTRIBUTING.md`。

### Known limitations

见 [README「已知限制」](README.md#已知限制) 与 [`docs/limitations.md`](docs/limitations.md)，
其中需重点注意：写批任务 token 偏重、`replay` 对真连 session log 0 命中、
bundle 形态下 plugin record 通道可能降级内存。

[0.1.1]: https://github.com/54dsb1/dsh-stream-agent/releases/tag/v0.1.1
[0.1.0]: https://github.com/54dsb1/dsh-stream-agent/releases/tag/v0.1.0
