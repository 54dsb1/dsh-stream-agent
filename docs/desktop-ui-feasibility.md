# 桌面客户端控制栏 UI 页面：可行性评估（v0.2.1）

> 结论先说：**可行，而且不需要修改 Electron 壳**。桌面端的 renderer 本身就是一套由本地 Host
> 提供的 Web 客户端，插件可以通过 `dsh.client` + `ctx.slots` 增加一整页内嵌界面。
> v0.2.1 已按这个路径实现了一个可用的垂直切片，并做了宿主侧与扫描侧的实证；
> 视觉部分仍需在真实桌面窗口里人工确认一次（见 §7）。

---

## 1. 现有应用结构（实测，不是推测）

### 1.1 Electron 壳只负责“起 Host + 装页面”

实测对象：`D:\$Applications\dsh`，`resources/app.asar` 内 `package.json` 为
`@deepseek-ai/dsh-desktop@0.2.2-rc.3`。

| 事实 | 证据 | 对 UI 的含义 |
|---|---|---|
| 主窗口不是 `file://` 静态页 | `lib/main.js` 在 `host.start()` 后取 `ready.url`，赋值 `hostUrl`；窗口导航走 `dsh-app://app/` 自定义协议 | renderer 是**本地 Host 提供的 Web 客户端** |
| 静态资源与 API 分离 | `dsh-app://app/` 的协议处理器：`/assets/*` 从 `dsh-web-frontend/dist` 读；其余请求 `forwardWebRequest(request, hostUrl, hostCookie)` | 插件页面和普通 Web 页面同源，可 `fetch('/...')` |
| 鉴权由壳注入 | `forwardWebRequest` 把 `origin` 改成 Host origin，并写入 `cookie: hostCookie` | 页面不需要自己管 token；Host 侧仍能用会话 cookie 鉴权 |
| 主窗口 CSP 允许内联样式 | app 内 CSP：`style-src 'self' 'unsafe-inline' devtools:`；`connect-src ... 'self' ...` | 客户端插件注入 `<style>`、同源 `fetch` 都合法 |
| 壳没有“插件 UI API” | `preload-app.cjs` + IPC 只服务文件、浏览器、更新等原生能力 | 想做 UI 不应走 Electron IPC，应走 Web 客户端插件 |

因此有两条路：

1. **改 `app.asar`**：加 `BrowserWindow`/原生面板/菜单。可行，但插件无法分发这种改动，
   每次升级都要跟着客户端发版——不可接受。
2. **加一个 Web 客户端插件**：由 Host 动态装载，`dsh plugin add` 即可分发，卸载即消失。
   这是本文选的路，也是 dsh 自己拆 `dsh-client-ui-*` 的方式。

### 1.2 客户端插件装载链路

`dsh-client-modules` 是这条链路的枢纽（`packages/client/modules`）：

1. 监听 Cordis Loader 的 `internal/plugin` 事件，按 **entry 的模块名** 增量扫描；
2. 对每个 entry 找最近的 `package.json`，读 `dsh.client` 声明；
3. 只接受 `platform: "web"`，并要求包 `exports["./client"]` 指向浏览器 bundle；
4. 把 bundle 组成 `window.__DSH_BOOT__` 图，经 `/plugins/...` 路由提供；
5. 浏览器侧的 `__ModuleLoader__` 是懒加载 CJS 表，按 id 物化 bundle；`react` 是平台 seed。

这解释了三件事：

- **为什么不用重新打包客户端**：bundle 是运行时从插件目录读的，Host 重启即重新扫描。
- **为什么 UI 必须独立成包**：扫描以“包”为单位，同一个包被多个 Loader 行引用会抛
  `resolves from multiple active Loader sources`。主包已有 6 个 entry，再加 `dsh.client`
  会直接让整个客户端 boot 失败。所以 UI 放在 `ui/` 子包，主包保持不声明 `dsh.client`。
- **为什么 Settings 里的插件页能做成纯 UI 包**：`dsh-client-ui-settings-shell` 的宿主半边
  `apply()` 是空函数，页面完全由 `exports["./client"]` 提供——这就是“表面插件”的官方形状。

### 1.3 页面挂载点

`dsh-client-ui-layout` 声明了 `main`（keyed 主面板）、`sidebar`、`rightbar`、`shell.overlay`；
`dsh-client-ui-sidebar` 声明 `sidebar.panellist`（左侧栏图标）。`dsh-client-ui-plugin-manager`
就是“`main` + `sidebar.panellist`”这一对的标准范例：

```js
ctx.slots.register({ name: 'sidebar.panellist', id: 'plugins', order: 0, label: ... }, Icon)
ctx.slots.register({ name: 'main', key: 'plugins', ... }, Page)
```

控制页复用同一对：`key/id = "stream-agent"`，点击左侧栏滑杆图标即打开整页。

---

## 2. 可复用组件

| 能力 | 来源 | 在本页的用法 | 复用程度 |
|---|---|---|---|
| 主面板 + 左侧栏图标 | `ctx.slots`（`main` / `sidebar.panellist`） | 整页与入口图标 | 直接复用，零改动 |
| 面板选中/几何 | `ctx.layout.selectPanel` / `panelInfo` | 可选：页内跳转；本版未依赖 | 可复用 |
| 设置卡片位 | `ctx.slots`（`plugins.item`） | 后续可加“控制栏”设置卡；本版未用 | 可复用 |
| 全局浮层 | `ctx.slots`（`shell.overlay`） | 后续可做 toast/状态胶囊 | 可复用 |
| 插件状态读取 | `ctx.remote.pluginInventory.list()` | 交叉核对 entry 的 `fiberPhase`/`diagnostic` | 直接复用 |
| 客户端语言 | `ctx.locale.getSnapshot().locale` | 左侧栏标签跟随界面语言 | 直接复用 |
| 表单/校验 | `ctx.configForms` + `ctx.settings` | **未用**：控制状态的事实源是 `control.json`，不是 entry config | 可复用但不合适 |
| 主题令牌 | `--dsw-alias-*` / `--dsw-radius-*` / `--dsw-font-*` | 明暗主题下的颜色、圆角、字体 | 直接复用 |
| Host 鉴权 | `ctx.connection.admit(req)` | 控制路由的 401/403 | 直接复用 |
| 客户端模块格式 | `window.__ModuleLoader__.load` + 懒 CJS | 浏览器 bundle 的外壳 | 直接复用 |

刻意**没有**复用 `@deepseek-ai/dsh-client-ui-primitives` 的 React 组件：它需要额外的包注入，
而本页只需要 `react` 一个平台 seed。少一个依赖，就少一个“版本对不上导致整页不渲染”的故障面。

---

## 3. 需要改动的范围

### 3.1 新增

| 文件 | 作用 | 规模 |
|---|---|---|
| `ui/package.json` | 独立子包；声明 `dsh.client`（web）、`exports["./client"]`、`external: ["react"]` | ~25 行 |
| `ui/index.js` | 宿主半边：`/stream-agent/control` 同源路由、鉴权、读写、降级 | ~300 行 |
| `ui/client.js` | 浏览器半边：`__ModuleLoader__` bundle、整页 React、左侧栏图标、样式 | ~560 行（26 KB） |
| `test/desktop-ui.test.ts` | 包声明、bundle 契约、中英文案对称、路由 7 组用例 | ~344 行 |
| `docs/desktop-ui-feasibility.md` | 本文 | — |

### 3.2 修改

| 文件 | 改动 |
|---|---|
| `src/entry/loop.ts` | `resolveEffective()` 改为每次创建 driver 时重算；提供 `streamAgentRuntime` 服务（status/setMode/setLang）；服务注册失败只告警，不影响 loop |
| `src/entry/control-state.ts` | 增加 `langSource`、`updatedAt`（并发栅栏）；来源联合类型增加 `runtime`（本次运行未落盘） |
| `cordis.patch.yml` | 第 7 个 entry `stream-agent-ui`（`./ui/index.js`） |
| `preset.yml` / `patches/takeover.yml` | 同步第 7 个 entry；`preset.yml` 行序调回 `sidecar → control-bar → ui → loop`；顺手修掉 preset 里一处 `config:/n` 的坏 YAML |
| `package.json` | `files` 加 `ui/` |
| `scripts/build.mjs` | 构建闸门：主包不得有 `dsh.client`；UI 包声明合规；`ui/index.js` 可导入；`ui/client.js` 语法可编译 |
| `README.md` / `README.en.md` | 新增「桌面客户端控制页」章节与三个面的对照表 |
| `CHANGELOG.md` / `docs/architecture.md` / `docs/limitations.md` | 0.2.1 条目、模块清单与「桌面页依赖动态客户端插件机制」限制 |

### 3.3 明确不改

- `app.asar`、`lib/main.js`、`preload-app.cjs`、Electron 版本、窗口/菜单/托盘；
- `@deepseek-ai/*` 任何包；
- 用户 profile 的 `cordis.patch.yml`（仍由 `dsh plugin add` 管理）；
- CLI 行为：`mode`/`lang`/`bar`/`status` 的语义与输出保持兼容，只是多了一个写 `control.json` 的入口。

---

## 4. 与现有控制逻辑的交互

### 4.1 单一事实源

```
装配 config.mode/lang  ─┐
STREAM_AGENT_MODE/LANG ─┤
control.json           ─┼─→ resolveControlState() → control { mode, lang, modeSource, langSource }
内置默认                ─┘                              │
                                                         ├─→ 控制页 GET 状态
                                                         ├─→ CLI status/bar
                                                         └─→ loop 每次创建 driver 时 resolveEffective()
```

- UI **不直接读文件**：它调 `streamAgentRuntime.status()`，拿到的是 loop 内存里的 `control`
  以及 `resolveEffective()` 的实时结果。这样页面显示的模式一定等于“下一个 agent 会用的模式”。
- UI 的写也**不直接改文件**：它调 `setMode`/`setLang`，由 loop 更新内存、`markTakeover()`、
  再原子写 `control.json`。CLI 与页面因此不会各写一套。
- 只有 loop 缺席（装载失败/headless）时，UI 才降级为直接写文件，并明确标注
  `takeover: false` + “重启后生效”。

### 4.2 生效时机

`resolveEffective()` 从“装载时算一次”改成“每次 `createDriver` 时算一次”：

- 切模式后，**之后创建的 agent** 用新参数；
- 已开的会话保持创建时的 driver 配置（不在会话中途突变，避免上下文/预算跳变）；
- `persistFallback` 是四个模式里唯一不变的值（全为 `true`），因此仍按装载时决定，
  不影响“切模式立即生效”的语义。

### 4.3 锁定规则

- `modeSource === 'config' | 'env'` → 页面模式卡置灰，路由返回 409 `locked`；
- `langSource === 'config' | 'env'` → 语言开关置灰；
- 原因写在页面上（“装配配置/环境变量写死了这个值”），不静默失败；
- CLI 仍可直接改文件，但下一次 `resolveControlState` 仍会被更高优先级的 config/env 压回去——
  这与 0.2.1 既有的优先级纪律一致。

### 4.4 与横幅/CLI 的一致性

- `setMode` 会调用 `markTakeover(next)`，控制栏 entry 的 `statusLine()` 立即读到新值；
- 语言/模式写入后，`dsh-stream-agent status` 与 `bar` 读取同一份 `control.json`；
- 装载横幅只在启动时打印一次，不会因为页面切模式而重印——这是预期行为（横幅是“装载自证”，
  不是实时仪表盘）。

---

## 5. 权限与状态同步

### 5.1 鉴权

- 路由处理第一步调用 `ctx.get('connection').admit(req)`，复用桌面/Web 共用的会话鉴权：
  - 无 cookie/launch token → 401；
  - Host/Origin 不可信 → 403；
  - 通过 → 继续。
- `connection` 缺席时（极简宿主/测试）只允许回环地址，避免把写接口暴露到网络。
- 不实现自定义 token：复用宿主已有的 cookie 机制，少一套密钥生命周期。

### 5.2 CSRF / 跨站

- 只接受 `POST` + `content-type: application/json`：跨站表单无法直接构造，跨源请求会先触发
  preflight，而路由不返回 CORS 头；
- `sec-fetch-site` 存在且不是 `same-origin`/`none` → 403；
- 不返回任何 CORS 头，浏览器跨源读不到响应；
- 请求体上限 4 KB，字段只接受 `mode` / `lang` / `expectedUpdatedAt` 三个白名单键。

### 5.3 并发与多窗口

- `control.json` 写入是“临时文件 + rename”的原子替换；
- GET 返回 `updatedAt`；POST 可带 `expectedUpdatedAt`，不匹配返回 **409 + 最新状态**；
- 页面收到 409 后直接刷新为最新值并提示“已被其他窗口或 CLI 修改”，不重试覆盖；
- 多进程（CLI + 桌面 + 另一个窗口）同样是“最后写入者赢”，但至少有一次显式冲突提示，
  不会在用户不知情时把 lean 改回 balanced。

### 5.4 故障隔离

| 故障 | 行为 |
|---|---|
| `ui/index.js` 装载失败 | 只该 entry failed；loop/sidebar 仍工作；客户端页面不出现 |
| `ui/client.js` 语法错误 | **会**让客户端 boot 失败——因此构建期 `new Function` 闸门 + 扫描测试是硬要求 |
| `streamAgentRuntime` 注册失败 | loop 只告警；页面降级为文件视图 |
| 路由 handler 抛错 | 该请求 500；不影响 Host 其他路由 |
| 状态文件损坏 | `readPersistedControl` fail-open 回默认并告警；页面显示默认值 |

---

## 6. 风险与约束

| 风险 | 等级 | 缓解 |
|---|---|---|
| 同包多 entry + `dsh.client` → 多源抛错，整页 boot 失败 | **高** | UI 独立子包；主包禁止 `dsh.client`；构建闸门 + `test/desktop-ui.test.ts` 断言 |
| 浏览器 bundle 语法错误 → 客户端 boot 失败 | **高** | `new Function` 只编译不执行；`__ModuleLoader__` 包装与 id 断言；真实 `ClientModuleRegistry` 扫描测试 |
| `connection.admit`、slot 名、`--dsw-*` 令牌属于宿主内部契约 | 中 | 版本锚定 `>=0.2.2-rc.1`；所有可选服务走 `ctx.get`；失败降级不阻断 loop |
| 桌面 bundle 无 HMR | 中 | 文档明确“升级后重启客户端”；页面显示版本，便于核对 |
| 主题令牌在明暗主题下表现不同 | 中 | 全部给 fallback；明暗主题已人工过一遍（§7） |
| 页面只影响新会话，用户误以为旧会话也变了 | 低 | 页头/保存提示明确写“对新会话生效”；文档同口径 |
| 原生菜单/托盘/快捷键不可用 | 低 | 明确列为非目标；需要时只能改 Electron，另立方案 |
| Web 部署的 CSP 与桌面不同 | 低 | 桌面 CSP 已实测允许内联样式；Web 部署需按同一 CSP 复核 |

---

## 7. 验收：已实证（脚本/测试 + 真机）

### 已实证（脚本/测试）

1. **7/7 entry 在真实 Cordis 4.1 上 active**（state 2），`setFactory` 已注册；
2. **控制路由 GET 200**：`takeover: true`、`modes.length === 4`；
3. **`setMode('lean')` 返回 `{ok:true, persisted:true}`**，再次读状态为 `lean`；
4. **真实 `dsh-client-modules` 扫描**：7 个 Loader 行 + UI 子包 → boot 图里**恰好 1 条**
   `@hugesb/dsh-stream-agent-ui`，无多源错误；
5. **250/250 测试通过**，含 10 条桌面页用例（鉴权/跨站/JSON/非法值/锁定/409/首次写入/降级/中英文案对称）；
6. **构建闸门**：主包无 `dsh.client`、UI 包声明合规、`ui/client.js` 语法可编译。

复现命令（工作区根目录）：

```bash
node scratch/repro-all-entries.mjs     # 7 entry + 路由 + setMode
node scratch/repro-client-scan.mjs     # 真实 client-modules 扫描
npm test                               # 250 用例
npm run build                          # 含 UI 闸门
```

### 已人工验收（2026-11-16，真实桌面窗口）

headless 环境渲染不了 React 客户端，以下项由人工在 dsh 桌面里逐条确认：

- 左侧栏出现滑杆图标，点击打开整页；
- 四张模式卡可点击切换，切换后 `dsh-stream-agent status` 同步；
- 中文 / English 双向切换，文案与页面一致；
- 明暗主题下对比度正常；
- 重启客户端后页面仍在（bundle 无 HMR，必须重启）。

> 验收结论：桌面控制页可作为客户端内嵌界面直接使用，不需要修改 Electron 壳。
> 双窗口 409 提示属"有则更好"的保护，逻辑已在 `test/desktop-ui.test.ts` 里覆盖，未列入本次人工项。

---

## 8. 分期建议

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0（v0.2.1） | 左侧栏整页、状态、四模式、中英切换、409 并发栅栏、降级诊断 | 已实现 |
| P1 | Settings → Plugins 里加一张“控制栏”卡（`plugins.item`）；页内高级参数编辑；会话级临时覆盖 | 可选 |
| P2 | 原生托盘/菜单/全局快捷键；多用户远程部署的细粒度权限 | 需要 Electron 改动或 Host 权限模型，另立方案 |

---

## 9. 结论

- **技术可行性：高**。dsh 桌面端已经把“UI 作为客户端插件”做成了一等扩展面，控制页只是
  按既有 `main` + `sidebar.panellist` 形状再加一个消费者。
- **改动风险：可控**。不动 Electron，不动宿主包；最大的坑（同包多源）用独立子包 + 构建闸门
  + 回归测试封死。
- **产品价值：中高**。新用户不必记 CLI 参数，打开就能看到“我现在是什么模式、为什么、怎么换”；
  同时保留 CLI 作为脚本化/排障通道。
- **不建议**为了这个页面去改 `app.asar`：收益是原生窗口/菜单，成本是插件失去独立分发能力，
  与“`dsh plugin add` 一条命令装卸”的产品形态冲突。
