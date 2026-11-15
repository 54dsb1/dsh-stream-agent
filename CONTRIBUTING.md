# Contributing

欢迎 issue 与 PR。改动前请先读完这几条，能省掉大部分返工。

## 红线

1. **不改上游源码**。一切以 plugin entry + patch 形式存在；需要新能力就加 entry，不动 `@deepseek-ai/*`。
2. **`src/kernel/` 零框架依赖**。不许 import 任何 `@deepseek-ai/*`；它必须能被单独拷出去跑单测。
3. **禁止"智能压缩 / 摘要历史"**。上下文只允许整块丢弃尾部，任何编辑中间内容的行为都会摧毁前缀缓存，直接拒。
4. **每个 entry 必须 fail-open**。自身异常时退回默认行为，并在 ledger 或 stderr 留一条，不许静默吞掉。
5. **如实报告**。测试不过就写不过，评测不好看就写不好看。

## 本地开发

```bash
npm test          # 187 用例，零 API 调用
npm run build     # src/*.ts → dist/*.js（Node 原生类型擦除，无第三方依赖）
```

**改完 `src/` 必须重新 build 并提交 `dist/`**：patch 直接引用 `dist/`，源码与产物不一致时 CI 会用 `git diff --exit-code -- dist` 拦下。

## 目录约定

| 目录 | 放什么 | 不放什么 |
|---|---|---|
| `src/kernel/` | 纯函数、内存态、可独立单测的逻辑 | 任何宿主 import、任何 IO |
| `src/entry/` | Cordis 薄壳：事件 → 内核调用 → 事件回写 | 业务逻辑（应下沉到 kernel） |
| `patches/` | 开发与评测用的组合补丁 | 生产装配（那是根目录 `cordis.patch.yml`） |
| `docs/` | 架构、协议、限制 | 变更日志（那是 `CHANGELOG.md`） |
| `eval/` | 指标口径、任务集、runner | 跑出来的批次（`eval/runs/` 除判定批次外不入库） |

## 写 patch 的四个坑

改 patch 之前务必知道，这些都是宿主实测结论：

1. **新增行必须写在 `insert:` 下**。裸的 `- id: X` 是覆盖行，目标不存在会被**静默跳过**。
2. **`inject` 只能写在行内**。loader 只读 `entry.options.inject`，模块导出的 `inject` 不进 patch 行。
3. **相对路径以 patch 文件自身目录为 baseUrl**。所以根目录的 `cordis.patch.yml` 写 `./dist/`，`patches/` 下的写 `../dist/`。
4. **preset 的嵌套行在创建路径上没有消费点**。关键行（尤其是 loop 接管）绝不藏进 preset。

验证方式：`dsh --profile <name> --patch <文件> --dump-config`，能看到 `- id:` 行与解析后的绝对 `file:///` 路径才算挂上。

## 提交

- 提交信息用 `<type>: <中文摘要>`，`type` 取 `feat` / `fix` / `docs` / `refactor` / `chore` / `test` / `eval`。
- 一个提交只做一件事；结构调整与逻辑改动分开。
- 涉及行为变化时同步更新 `CHANGELOG.md` 与受影响文档。

## 发布

**Windows 双击 `release.cmd`** 即可，依次完成：构建 → 测试 → 版本 → 提交 → 打标签 → 推 GitHub → 建 Release → 发 npm。

命令行等价：

```bash
npm run release              # 版本已手动 bump 就沿用，否则 patch+1
npm run release -- --minor   # 或 --major / --set 0.2.0-rc.1
npm run release:dry          # 只演练：跑构建测试 + 打印将执行的步骤
```

脚本会拦下这几类事故（都是实际踩过的）：

| 拦截 | 原因 |
|---|---|
| 不在 `main` 分支 | 从特性分支发版会让 tag 落在错误提交上 |
| npm 未登录 / scope 与账号不符 | `@xxx/` 只能发到自己的用户名或所属组织 |
| `dist/` 与刚构建的结果不一致 | dist 入库且被 patch 直接引用，旧 dist 会让安装版本静默落后 |
| 测试未通过 | 先修再发 |
| npm 上该版本已存在 | 版本号必须递增，重复发布会 403 |
| 标签已存在且不指向 HEAD | 链接会错位；确需覆盖加 `--force-tag` |

版本规则：`package.json` 的 version 大于最近 tag 时视为**已手动 bump**，直接沿用；否则按 `--patch/--minor/--major` 递增。tag 名固定为 `v<version>`，预发布版本（带 `-rc.1`）自动发到 npm 的 `alpha` dist-tag，稳定版才占 `latest`。
