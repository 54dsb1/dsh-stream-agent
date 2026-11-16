
# Roadmap

- M0：冻结 fixture 工作区与 build-manifest 规格格式。
- M1：实现 tf-write，落地写序保证与幂等台账。
- M2：实现 tf-read 与行骨架注入，支持 offset/limit 分段读取。
- M3：实现 tf-bash，在 pwsh 宿主上执行命令并句柄化输出。
- M4：实现 tf-peek，支持按句柄与 1 基闭区间取行。
- M5：补齐 [tf-stream:error] 注入与失败改道流程。
- M6：引入句柄目录增量，支撑跨请求观察。
- M7：加入 depends_on 依赖图与同流并行调度。
- M8：完善收尾纪律，强制 tf-final 并校验 summary 内容。
- M9：跑通 METRICS 采集与 baseline 对照评估。
- M10：文档定稿、fixture 回归稳定，协议进入维护期。
