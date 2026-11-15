# 已知限制

按"你会不会踩到"排序，每条都给出取证位置与缓解方式。**判定不过就写不过**——这份清单不做美化。

## 一、成本与正确性的取舍

### 1. 写批任务 token 偏重

- **现象**：写多文件的任务（W1 / W2 / W3 / C2 / C3）收益不稳定，W1 只到 55%，R2 甚至 checks 不过。
- **原因**：`tf-read` 成功会完整反馈一次，模型拿到内容后倾向做"写 → 读回验 → 再改"的循环。这是把正确率从 6/10 拉到 9/10 的代价。
- **影响**：写比重越大，收益越接近 1；读查（R1/R3/R4）、复合（C1/C3）才有 5%–32% 的显著收益。
- **缓解**：如果你只做读查类任务，收益最稳；写批任务请以正确率为先，不建议为了 token 关掉完整反馈。

### 2. W1 / C2 退出码 1，但产物正确

- **现象**：任务在重入预算（`maxReentries: 8`）内没有收敛，进程 `exit=1`，但 checks 判 PASS。
- **原因**：防荡护栏按设计拦截——写批任务用满 9 次请求后不再放行。
- **影响**：自动化流水线里会看到"失败退出码 + 正确产物"的组合。
- **缓解**：把护栏理解为"预算耗尽"而非"任务失败"；需要更长回验循环时调 `maxReentries`。

## 二、行为语义偏离

### 3. `steer` 与内建语义不同

- **内建**：注入到运行中回合的下一步。
- **本包**：插队到队首，在回合边界生效——因为单流协议"流内不打断"是它的前提。
- **影响**：依赖"立即插话"的交互脚本体感会有差异。桌面端已如实声明，不做静默兼容。

## 三、环境依赖

### 4. `dsh plugin` 需要 pnpm

- PATH 里没有 `pnpm` 时安装/卸载会失败。按 dsh-plugin-manager 配置 `pnpmCommand` 可绕开。

### 5. 持久化依赖宿主 storage

- headless profile 未注册 storage backend 时，`state-handle` 按设计降级内存：服务照常提供、功能不损，但**跨会话 resume 不可用**。
- 缓解：补挂 `@deepseek-ai/dsh-storage-json`。

### 6. `tf-bash` 可能被沙箱拒

- 部分目录下 pwsh grant 失败（Win32 5）。基线臂同样受限，属环境因素而非插件缺陷。
- 缓解：把工作区放到 DSH 已授权的目录下。

## 四、降级通道（有告警，不静默）

### 7. bundle 形态下 plugin record 可能降级内存

- **现象**：通过 `dsh plugin add` 安装时，bare import `@deepseek-ai/dsh-session` 可能拿不到宿主同一模块实例，`appendPluginRecord` 不可达。
- **行为**：降级为内存台账，stderr 打告警（`[stream-loop] plugin:tf-agent ledger ...`）。
- **代价**：resume 后 `tf-*` 状态不可重放；session log 里仍有 turn / step / assistant 事件。
- **取证**：`src/entry/loop.ts` 的 `attachSessionLedger`。

## 五、评测工具自身的缺陷

### 8. replay 一致性对真连 session log 0 命中

- **现象**：`replay-check.cjs` 在真连产出的 zstd session log 上提取不到工具调用（smoke 造数场景正常）。
- **判定**：**工具缺陷，不是回放机制失败**。所以 `eval/RESULTS.md` 里 replay 列全是 FAIL，请以 probe log + metrics 为准。
- **影响**：想用 replay 做零成本回归前，得先修提取器。

### 9. `injected_ratio` 口径偏差

- 驱动器 snapshot 计数在 peek / 完整反馈场景下会偏大或偏小。
- **口径**：以驱动器 turn-end snapshot 为权威值，`eval/METRICS.md` 有定义；不要用它单独论证收益，token 总量才是判据。
