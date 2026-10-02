# RUST-007 — 可信主机显式控制与混合纯读取

Owner 持续开发授权，从 RUST-006 最终报告 HEAD `61df0b33f087823920042f3bcebe4743961c9b74` 接续。分支 `codex/rust-core-007-host-refresh`，工作树 `worktree/rust-core-007`，证据目录 `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-007-iufy2wwd`。

## 问题与冻结范围

RUST-006 已把可选 Rust 组合接入受控 Core 启动链，但内部 refresh/invalidate/getStatus 被外层 DatasetOwnerEndpoint 包装隐去，可信宿主无法在 Node 写后显式恢复读取。现有 router 还在判断纯 Node 读取前撤销快照；收藏页初始化的参考来源/历史/版本和打开型号详情会终止已建立的只读路径。

1. 保留六条经实现审计的纯 Node 命令：`collection.detail`、`collection.copy`、`collection.photo`、`referenceCatalog.sources`、`referenceCatalog.history`、`referenceCatalog.revision`。它们只到 Node，保持原结果与原错误，保留当前 Rust generation/child；仍受请求 scope、generation、invalidate/refresh/close 及潜在写入的迟到结果围栏。`collection.list` 继续旧完整版本探测和 Rust DTO 深验证。其他领域命令保持保守失效及原 Node 写入回执/unknown，不按前缀扩展纯读或重放。
2. 新内部 `host-controller.ts` 导出 `RustReadonlyCoreController`，冻结的闭包对象仅有 refresh/invalidate/getStatus，不能得到 Node/原 endpoint/config/pin/dispatch/prepare/boot/close。
3. `runCoreUtilityProcess` 第八可信可选参数为 `onRustReadonlyCoreController?: (controller: RustReadonlyCoreController) => void`，必须有第七参数的显式 Rust 配置和原 DatasetOwnerFactory。回调在组合登记后、prepare/boot 前同步调用一次，返回值须为 undefined；不等待挂起 Promise 延长预算，意外 Promise 拒绝须消费并收口。无配置/非函数/同步抛错/非同步回调均不能公布 ready 或漏关已创建的 Node。旧六/七参数及默认桌面 core-entry 保持兼容。
4. 主机获取的 controller 遵循既有 phase：ready 前 refresh 拒绝，write/unknown 后不自动刷新，显式刷新方可恢复 Rust；close 后 captured controller 不复活。控制面及公开 ready/health/diagnostics、IPC/worker/Rust v1/v2/v3、容量和二进制 pin 均保持原合同。配置不从 env/父 port/public RPC/Renderer 提供。
5. 实际运行原 Core 入口、真实 Node 两库和固定 Rust binary；测试宿主私有通道驱动可信 control，至少覆盖默认 Node 和显式 100/2,000/5,000、真实来源/已发布参考版本的初始化、纯 Node 与 Rust 读取深比较、Node 写后显式刷新/并发刷新、关闭与刷新在途竞态、回调失败和资源自然退出。受控宿主证据独立于 Electron/签名/真实服务验收，任何轮询时间不宣称精确 Core 延迟或生产性能收益。

## 纯读事实审计

审计链为 dataset-dispatch → repository/detail/copy/photo 和 reference-catalog-store/sources/history/revision。scope 身份检查是文件/身份校验；纯读辅助函数仅 SQL SELECT、读事务、JSON/hash/预算校验和内存投影。参考版本 detail 读取已有快照，不调用创建快照的 INSERT。ready Rust 已完成 Node boot/版本导出，复用已打开连接；不把此结论推广到冷迁移或其他领域命令。

## 并行文件范围

4 个子代理均显式 gpt-6.1-sol/high，不再派生；平台总槽位包括主代理，因此 3 个实现代理并行，第四个接续独审。

- 子代理 1：readonly-router.ts 和新 test/rust-readonly-node-reads.test.ts；只读事实审计与 RED/GREEN。
- 子代理 2：utility-main.ts、新 host-controller.ts 和新 test/rust-core-host-controls.test.ts。
- 子代理 3：test/helpers/rust-core-utility-fixture.ts 和新 test/rust-core/runtime-host-integration.test.ts；RUST-006 实际测试原文保留。
- 子代理 4：只读审查、外置证据；不重复所有 Gate。

主代理负责 Gate、任务/合同/ADR、STATUS/TODO/风险、整合审查、完整验证与两个提交。

## 验证与交付

先确认能复现不必要撤销的行为，再修复。覆盖纯读成功/失败/并发、潜在写入的已知和 unknown 原回执、refresh/invalidate/close 的迟到结果，controller 能力准入、冻结/一次交付、同步/异步异常及提前 shutdown。默认零私有导出/零 Rust；真实初始化和读写后的列表 DTO/total/顺序与 SQLite 深比较，真实 child 峰值 1、普通关闭 ACK 加自然退出，失败/强制清理另记。

固定 Rust Gate 新增两个单元文件和实际宿主测试，保留旧 gate 全部测试与成本身份。 完整回归发现原 router 坏回执与 sidecar 读取超时 fixture 共用 20/25ms 启动期限；子代理 1 接续修订这两条既有测试的正常启动 RPC 预算，保留刻意超时分支、原断言/测试数并加强故障阶段证明，生产预算不改。初次失败和修订前后冻结/日志均保留。完整软件类型、unit、build、control-plane/boundaries/cycles；检验源文件/每步日志/二进制/报告摘要和两轮必要审查。外置构建/缓存/tmp/log，固定 Node 22.x/pnpm 10.17.1，Rust 使用当前已安装稳定工具链且执行固定版本检查。

默认 Node、唯一生产写入者、Roon/Provider/凭据/播放/录音职责不变。无真实用户库或迁移、真实服务/音频/录音、安装签名、远端 CI、push/发布/main merge。MBR-004 与 Gate B P4/P5 carryover 原样保留。实现/报告分开提交，下一分支从最终报告 HEAD 开始，任务完成不代表生产默认启用或全部 Rust 升级。
