# RUST-006 — Core 显式可选只读路由与生命周期

Owner 持续开发授权，从 RUST-005 最终报告 HEAD `babce9ad7f933743e1ab23c4edbe6187e83840c7` 接续。分支 `codex/rust-core-006-runtime-integration`，工作树 `worktree/rust-core-006`，证据目录 `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-006-zmfuqlfd`。

## 问题与冻结范围

RUST-003～005 已验证独立只读路由，但正式 Core 的 Dataset Owner 包装仅保留 prepare/dispatch/commitBoot/close，尚未组合 Rust 候选的启动与关闭。实现可信主机显式配置的组合端点，并接入真实 `runCoreUtilityProcess` 启动链。默认 Node 与桌面调用参数保持原状。

- 新内部模块 `packages/bridge-core/src/rust-core/core-dataset-owner.ts`。导出 `RustReadonlyCoreOptions`（既有 router 选项去掉 owner）和同步工厂 `createRustReadonlyCoreDatasetOwner(owner, options)`。
- 组合端点实现既有 DatasetOwnerEndpoint，另提供仅可信主机使用的 refresh/invalidate/getStatus。getStatus 包含组合 phase（new/prepared/booting/ready/failed/closing/closed）、可选 router 与安全 errorCode；不扩展公开 IPC 或诊断合同。
- 组合端点拥有 Node 生命周期，内部 router 借用 Node。prepare、boot、close 合并并发调用；一次 Node boot 后建立 router 并显式刷新，完成完整 ACK/版本核验后才允许 Core ready 和领域请求。
- 初始 boot 使用单一单调期限，覆盖 Node boot、版本探测、完整导出与 Rust boot。关闭立即封闭请求，消费迟到操作，清理候选与 Node 各一次；关闭失败不可冒称自然退出。复用既有 router 的代次、unknown 和单 child 规则，不自动重放写入或刷新。
- `runCoreUtilityProcess` 第七参数为可选 `RustReadonlyCoreOptions`。只能配合显式 DatasetOwnerFactory；来源缺少必要私有能力时拒绝并收口。旧六参数、环境变量、Renderer/父 port 消息不具备启用权限。
- `collection.list` 可走 Rust；其余已有领域命令仍到 Node，Provider/Roon/凭据/播放/录音继续由现有控制面处理。写后退回 Node，保留原回执与 unknown。公开请求、响应、命令闭集与播放事件协议不变。
- 继续现有 v1/v2/v3、默认 2,000/4 MiB、显式 5,000/8 MiB，保持完整 DTO、顺序、total 与逐项校验。无真实用户数据、迁移、真实账号/Roon/播放/录音、安装签名、发布、push 或 main merge。

## 并行文件范围

4 个子代理均显式 gpt-6.1-sol/high，禁止进一步派生；平台总槽位含主代理，仅 3 个实现子代理同时运行，第四个在腾出槽位后独审。

1. 组合端点：新 core-dataset-owner.ts 与 rust-core-owner-lifecycle.test.ts。
2. 启动接入：utility-main.ts 与 rust-core-utility-options.test.ts。
3. 实际进程：新 test/rust-core/runtime-lifecycle-integration.test.ts、helpers/rust-core-utility-fixture.ts；实际 Node Core worker → Node 两库 owner → 固定 Rust binary，合成数据。
4. 独立审查：只读源码和外置审查证据，不修改源码、不重复全部 Gate。

主代理负责任务/ADR、TODO/STATUS、CI Gate、整合与最终验证。默认文件、Native 协议与已有测试不由子代理扩展。

## 验证与交付

单元覆盖 legacy 默认零导出/零 child、显式能力准入、ready 前请求、并发 boot/close、整体期限、迟到创建、失败清理、写回执、关闭失败。实际进程覆盖至少 0/100/2,000/5,000 合成型号、默认 Node 和显式 Rust、筛选/分页深比较、领域写入失效、控制面请求仍为 Node、startup/pin/capacity 失败、自然关闭和资源身份；明确这不是 Electron、真实账号或设备验收。

执行固定 Rust Gate 与新增 TS/实际进程项，再执行工作区 typecheck/unit/生产 build/control-plane/boundaries/cycles。先核外置卷；Node 22.23.2、pnpm 10.17.1、既有 stable Rust 1.95.0，不安装工具链。全量检查只在最终源冻结后运行，失败或修正需要重验对应证据，不重跑已完成的旧阶段。

保留失败日志与证据边界。实现和结果报告分开提交，报告含 base/实现/报告身份、命令退出码、源码/日志/二进制摘要、carryover 与下一分支最终报告 HEAD。TODO 待办在前、已完成在后；阶段完成不代表整个 Rust 升级或生产启用完成。
