# RUST-003 — 快照版本、刷新与可选读取路由

Owner 的“持续开发”授权从 RUST-002 最终报告 `763b5c62283978c3ab4981c9cce60f4237d1f051` 接续。独立分支 `codex/rust-core-003-snapshot-refresh`，工作树 `worktree/rust-core-003`。主代理 sol6.1/max，最多 4 个 sol6.1/high 子代理，按平台槽位分批，不继续派生。

## 问题与目标

只读快照会落后于 Node 的后续写入；RUST-002 的 124 ms 建立成本也不能忽略。本期让显式可选路由在交付 Rust 结果前验证当前事实，写入、换库、刷新、关闭不能让旧结果或迟到候选覆盖新状态。采用按读取验证的失效检测，不引入后台轮询、真实库写入或生产默认开关。性能收益由包含版本探测的完整调用测量决定。

## 冻结私有接口

- `DatasetCollectionSnapshotVersion = {epoch, datasetId, revision}`；revision 是当前 Owner 内的 UUID v4 不透明令牌，不是持久 schema revision。
- `DatasetVersionedCollectionSnapshot = {snapshot: DatasetCollectionSnapshot, version: DatasetCollectionSnapshotVersion}`。
- `DatasetOwnerVersionedSnapshotEndpoint extends DatasetOwnerSnapshotEndpoint`，增加 `getCollectionSnapshotVersion()` 和 `exportVersionedCollectionSnapshot()`；Node 私有 worker 同名操作，只额外接受 `expectedDatasetId`。公开 IPC 208 命令与 Rust v1/v2 帧保持。
- Repository `readonlySnapshotStamp(): {dataVersion:number,totalChanges:number}`；domain 可选同名方法，前后检查当前身份。只比较同一连接的 SQLite data_version 和 total_changes；任何相关连接写入或 rollback 的保守失效均可接受，不为减少失效忽略写入。
- worker 在成功 boot 后读取 stamp，变化就更换 revision。版本导出在同步完整原子导出前后比较 stamp；不同或身份改变则整体拒绝，不能把不同版本与快照配对。原 export API 保持。
- `createRustReadonlyCollectionRouter(options)` 异步工厂，从已经 boot 的版本化 Owner 借用来源；options 与原 Owner 工厂一致，但 owner 为新扩展类型。返回 `dispatch(request)`, `refresh()`, `invalidate()`, `getStatus()`, `close()`。不 boot、close、替换或重试来源 Owner。
- status 至少有 `phase`（node / refreshing / rust / stale / failed / closed）、`generation`、绑定 epoch/datasetId；已就绪时可包含 snapshotId/revision，失败仅封闭错误码，不包含原始异常、路径、SQL 或凭据。

## 路由与顺序合同

1. 初始显式工厂只绑定就绪来源，默认读 Node。显式 `refresh()` 才导出版本快照、核验 pinned binary、启动 Rust。刷新同时最多一次，重复调用共用在途结果，不排自动重试；旧 child 先完成关闭再启动候选，最多一个 Rust child。
2. 刷新、invalidate、关闭、来源版本/身份变化同步撤销发布权。迟到候选只清理；迟到读取报 `STALE_SNAPSHOT`，不再次执行公开查询。`close()` 等自己创建的候选与 child 收口；来源 Owner 仍由原控制面关闭。
3. 没有就绪 Rust 时，collection.list 发 Node 一次。readContext 继续走 Node。错误身份不进入 Rust；其他命令仅发 Node 一次，并在发起前保守失效。潜在写入在途期间不建立/发布快照；未知写入错误与原 commandId 保留，不自动重放。
4. 可走 Rust 的 collection.list 在调用前后各取一次 Node 版本，校验 epoch/datasetId/revision 与候选一致。调用前发现版本变化，撤销旧 child，本次可以直接读 Node；调用后才发现变化必须拒绝旧结果，不静默重读。关闭或新 generation 后，已审定纯收藏读取 collection.list/detail/copy/photo 的 Node 结果也不得交付旧事实；其他非 list 操作保守按潜在写入处理，保留其已确认或未知回执。
5. 每次刷新有整体单调期限，版本探测有有界期限；超时不清除来源合法在途 RPC。来源失效、版本错配、坏回执、关闭失败均可观察；不得用成功 fallback 掩盖已发送 Rust 请求的失败。

## 证据与范围

测试覆盖同连接写入、其他合成连接提交、回滚、无写入稳定令牌、版本导出竞态；并发刷新/失效/关闭/迟到读取/候选/写入 unknown；真实 Node 两库 → pinned Rust → 刷新前后 SQLite 差分和自然退出。记录 Node/Rust 加前后探测的 warm 完整成本，不设未经测量的速度承诺。

执行 Rust fmt/clippy/test/locked build 与真实进程 Gate；完整 typecheck/unit/build、control-plane/boundaries/cycles；源码/日志/二进制摘要、diff/JSON、远端分支与最终报告身份。独立实现和报告提交，STATUS 保留旧证据，TODO 分开待办与完成。

不扩大 2,000 型号/4 MiB 预算，不变更生产默认、Node 唯一作者或 schema，不访问真实账号/Roon/播放/录音，不迁移数据、不安装、不推送、不发布、不合并 main。大库预算、查询索引、打包签名、持久化迁移与真实验收继续单列。

设计依据：[SQLite data_version](https://www.sqlite.org/pragma.html#pragma_data_version)、[total_changes](https://www.sqlite.org/c3ref/total_changes.html)；令牌不是任意连接之间可比较的全局序号。
