# RUST-004 — 有界的 5,000 型号原子快照与分块传输

Owner 持续开发授权从 RUST-003 最终报告 `f3b398f7f872d5776ab8a65f3eb3ec5d7894c0af` 接续。独立分支 `codex/rust-core-004-bounded-transfer`，工作树 `worktree/rust-core-004`。最多 4 个明确 sol6.1/high 子代理，按平台槽位分批，禁止继续派生；主代理整合、审查与验证。

## 问题和范围

Node 原有公开列表可读取总库 5,000 型号，MBP-008 已有合法的合成总库证据；Rust v1/v2 完整导出硬限 2,000 型号。直接放大单帧或拼接实时分页不能证明完整性。本期增加显式 `snapshotProfile: 'v3-5000'`，将 Node 一次同步读事务捕获的完整快照分块传输，在完整接收并 commitBoot 后才准入查询。没有选项或 `'v2-2000'` 保持现有 2,000 型号/4 MiB 与 v2 帧。

仅扩展私有只读快照，不改变公开 208 命令、现有数据库 schema、生产容量限制、Node 唯一作者或默认运行路径。不迁移真实数据，不连接真实 Provider/Roon，不播放或录音，不安装、不 push、不发布或合并 main。进度计算迁移、查询索引和默认启用仍单列。

## Node 完整事实

- 新固定预算 `MAX_DATASET_LARGE_COLLECTION_MODELS=5_000`、`MAX_DATASET_LARGE_COLLECTION_SNAPSHOT_BYTES=8*1024*1024`；独立大快照 guards 保持旧 guards 的预算不变。沿用同一 DTO/身份结构，拒绝重复 ID、损坏、超型号或完整 JSON 字节预算，不截断。
- Repository 新 `exportLargeReadonlyModels()`，domain 新可选 `exportLargeCollectionModels()`。复用完整库存/照片批量水合，在一次同步 SQLite BEGIN 读事务内捕获全部型号；读取前后验证身份，失败 ROLLBACK，不跨 await 事务。
- 私有 worker 封闭新操作 `exportLargeVersionedCollectionSnapshot`，仅接受已有信封及 expectedDatasetId；boot、scope、stamp 前后配对和原版本令牌规则保持。客户端新 `DatasetOwnerLargeSnapshotEndpoint extends DatasetOwnerVersionedSnapshotEndpoint`，新增同名方法。旧、小、新大三种导出共享一项在途预算，失败/晚到结算才释放；新快照 ID 与旧 API 共用防重复集合。
- 旧 mocks 缺少新方法可继续旧能力；显式 v3 缺少新方法整体拒绝，不降级、不分页拼接。

## TS / Rust v3 冻结帧

UTF-8 JSON 行；信封仍有 protocolVersion、requestId、epoch、datasetId、snapshotId、sequence、operation、payload。v3 的 UUID/筛选/封闭字段/排序/DTO、请求序列和 4 MiB 每帧规则沿用 v2；Native 继续兼容 v1/v2，不允许绑定后切换协议。

1. `prepare` payload 恰为 `{modelCount:N}`，N 是 0～5,000 安全整数。响应恰为 `{epoch,datasetId,snapshotId,readOnly:true,capabilities:['collection.list'],modelCount:0,expectedModelCount:N}`；仅表示接收 manifest，不表示查询就绪。
2. `appendSnapshot` payload 恰为 `{chunkIndex:i,models:[...]}`，i 从 0 连续增加。每块恰含 `min(128,N-received)` 个型号；空快照不发块，非末块必须 128，最多 40 块。每块帧最多 1 MiB，全部 append 输入帧含换行累计最多 `8 MiB+64 KiB`；完整规范编码快照最多 8 MiB。接收时校验每个公开 DTO、跨块重复 ID、完整有界计数和累计字节。
3. append 成功 ACK 恰为 `{chunkIndex:i,receivedModelCount:received}`，TS 必须按当前块准确核对，不接受增减、错序、额外字段或旧 ACK，不重发。
4. `commitBoot` payload `{}`，仅在接收数等于 manifest 后成功，返回 null 并封闭上传；缺块、额外块、错块、重复 ID、超预算、身份/版本变化或非法启动帧使 v3 启动失败并退出。完整前 dispatch 拒绝且不能泄漏部分集合。close 可清理未完成上传，ACK 和自然退出共同决定关闭成功。
5. v3 dispatch 与 v2 完全相同，包括 filterProjection、字面子串、ASCII lower、Unicode 不对称、在分页前 AND 筛选、total/hasMore 与原完整 DTO。所有筛选和查询回执仍由 TS 根据完整不可变事实核验。

`RustReadonlySidecarOptions` 与 FromOwner/Router 增加可选 snapshotProfile，仅接受 `'v2-2000'|'v3-5000'`。FromOwner 的大模式读取新大版本快照，严格校验版本与身份；Router 的大模式用同一版本事实及 RUST-003 前后探测、generation、候选登记和单 child 退役合同。Source Owner 仅借用，不 boot/close；公开 readContext 原合法失败保持。全导出、复制、pin、各块 prepare 和 commitBoot 共用整体单调启动期限，不把每块计时相加为新期限。

不预先编码并保留所有帧；按有界块发送，不能持有多代快照/child。记录完整 Node/Rust 多工作量成本、导出、上传/刷新、关闭及模型/快照/帧字节，合成 warm 数据不冒称冷盘、真实库或硬内存上限。

## 文件所有权

- Node 子代理：collection repository/domain/owner protocol/client/worker，新 `dataset-large-snapshot.test.ts` 与对应新 fixture。主代理保留旧 helpers 的整合修改权。
- Native 子代理：native/rust-core/src/lib.rs、新 tests/query_v3.rs 与必要 native tests；不改 Cargo 依赖/lock。
- TS 子代理：rust-core/readonly-sidecar.ts、readonly-router.ts，新 `rust-large-sidecar.test.ts`；不改 Node 协议文件。
- 第四子代理：实现结束后只读独立审查，输出外置审查 JSON，最多两轮，不改源码、不派生。
- 主代理：冻结任务/合同/ADR、真实两库/Rust 新集成、CI Gate、STATUS/TODO/风险、整合修复与报告。

## 退出 Gate

新大快照通过 5,000 与 5,001、8 MiB、事务/stamp/身份、跨 API 在途与旧 2,000 拒绝行为；Native v1/v2/v3、分块错序/缺块/超量/重复与清理；TS ACK/时限/关闭/晚到候选故障。真正的 Node 两库到 pinned Rust 5,000 型号完整 50 页和固定筛选差分、写后失效与刷新、部分上传真实关闭/崩溃，不使用真实账户或数据。

Rust fmt/clippy/test/locked build、实际进程 Gate；完整 typecheck/unit/build、control-plane/boundaries/cycles；源码/日志/二进制 SHA、diff/JSON、远端/实现/报告身份。实现与结果报告分开提交，下一任务从最终报告 HEAD 接续，TODO 待办在前、已完成在后。
