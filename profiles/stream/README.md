# stream 专用 profile —— 安装、选择、卸载、回退（S1/S2/S4/S6）

本目录是 `dsh-stream-agent` 独立模式（A-1）的专用 profile 模板。核心事实：**插件只允许
装进专用 profile**；`web` / `desktop` 等既有 profile 会被安装前置校验拒绝（S2）。

## 组合层次（顺序即契约，改变顺序视为装配变更需重新验收）

```text
@deepseek-ai/dsh-base          ← 服务层（llm/session/tools/sandbox/ptc-runtime…）
@hugesb/dsh-stream-agent       ← 主 bundle（停用 agent-loop + 7 个 entry，loop 最后）
@hugesb/dsh-stream-agent-preset-stream  ← preset bundle（S4：只声明映射工具面；仅 web 变体）
@deepseek-ai/dsh-web-app       ← 入口（web 变体）；headless 变体用 @deepseek-ai/dsh-headless
profile cordis.patch.yml       ← 只承载覆盖声明（registry default → stream），不接管 loop
```

- `agent-loop` 的停用**只在主 bundle 的 cordis.patch.yml**——`plugin remove` 整层消失，
  卸载原子（C4）。本目录的 patch 层永远不出现停用行。
- headless 变体（`profiles/stream-headless/`）不引入 preset bundle：宿主 headless 无
  preset registry，工具面由 profile 决定。

## 安装（web 入口变体）

```bash
# 1. 复制模板到宿主 profiles 目录（版本精确锁定；不用 ^/~ 浮动范围）
cp -r profiles/stream "$HOME/.dsh/profiles/stream"
# 2. 本地开发用 link:（模板默认）；npm 安装改为精确版本号：
#    "@hugesb/dsh-stream-agent": "0.3.0"
#    "@hugesb/dsh-stream-agent-preset-stream": "0.3.0"（npm 源未发布该子包前用 link:/复制目录）
# 3. 前置校验（S2）：目标 profile 必须在允许列表（stream / stream-headless）
node scripts/install-check.mjs --profile "$HOME/.dsh/profiles/stream" --dry-run
# 4. 在 profile 内安装依赖后启动自证：
dsh --profile stream --version
dsh --profile stream        # 装载横幅应含 TAKEOVER-ACTIVE … code=off … profile=stream
```

选择：启动时 `dsh --profile stream`（web 入口）或 `dsh --profile stream-headless`。
**不要**把本插件 `plugin add` 进 web / desktop——`install-check` 会拒绝，宿主侧也会以
`E_DOUBLE_LOOP` 具名失败（S3：双 loop 冲突必须具名失败，不静默共存）。

## 卸载与回退（S6）

```bash
# 卸载插件（bundle 层整层消失，宿主 agent-loop 原子恢复）
dsh plugin remove @hugesb/dsh-stream-agent --profile stream
# 完全移除：删除 profile 目录（含 preset bundle 与状态文件引用）
rm -rf "$HOME/.dsh/profiles/stream"
# 装卸回归（有真实宿主的机器）：
node scripts/install-cycle.mjs --dsh dsh --profile stream --rounds 10
# 回退到旧版本产物：回退 0.2.x tag 产物（git checkout v0.2.1 后重复安装步骤），
# 不把新版本装进既有 profile——那是 B 形态，不是本插件的交付形态。
```

卸载验证清单（每轮装卸后）：宿主 loop 恢复（横幅无 TAKEOVER-ACTIVE）、web 能创建会话、
无 `stream-agent-*` 残留 entry、`agent-loop` 重新可用。

## 版本锁定

profile 依赖必须精确锁定（不用 `^` / `~`）；宿主版本与本插件版本的对应关系记录在
主包 `package.json` 的 `engines`（`dsh >= 0.2.2-rc.1`）。升级插件 = 改精确版本号 +
重跑 `install-check --dry-run` + 一轮装卸演练，不做"浮动升级"。

## 安全边界声明

profile/preset 只是**组合边界**，不是安全边界：YAML 与插件仍执行宿主代码。安全声明
只能引用 sandbox 事实（`docs/limitations.md`）——`tf-code` 的沙箱只覆盖文件效果，
Windows 档报告 `partial`，不承诺网络/进程隔离。
