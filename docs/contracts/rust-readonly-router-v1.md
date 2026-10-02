# Rust 只读路由与版本化快照合同 v1

RUST-003 从 RUST-002 最终报告 `763b5c6` 接续。协议仅在 Core 内部使用，正式应用默认 Node；不增加 Renderer 命令、路径参数、SQL 或 Rust 数据库写入。原 Rust [进程 v2](rust-readonly-sidecar-v2.md) 和 v1 帧保持。

## Node 私有版本操作

私有线程信封沿用 version=1，增加 `getCollectionSnapshotVersion`、`exportVersionedCollectionSnapshot`；请求携带现有身份、序列及 `expectedDatasetId`，禁止公开 request 与额外参数。prepare 和 commitBoot 都成功后才可调用。

`getCollectionSnapshotVersion()` 返回 `{epoch,datasetId,revision}`：epoch/revision 为 UUID v4，datasetId 保持已有合法 UUID v1～v8。revision 是当前 Owner 实例内的不透明版本令牌，不能跨 Owner、重启或工作库比较。只读操作不改变令牌；同连接写入、回滚或其他连接提交使后续探测保守失效。令牌不写入数据库、不变更 schema。

Node 在同一拥有者连接上同步读取 `PRAGMA data_version` 与 `total_changes()`，只将同连接观测用于比较；domain 读前后检查身份。前者检测其他连接提交，后者涵盖当前连接和相关触发器造成的行变化。任何连接错误或非法计数都拒绝，不能假装版本稳定。[SQLite 官方说明](https://www.sqlite.org/pragma.html#pragma_data_version)、[total_changes](https://www.sqlite.org/c3ref/total_changes.html)。

`exportVersionedCollectionSnapshot()` 返回 `{snapshot,version}`。snapshot 沿用既有完整原子 DTO 及 2,000 型号/4 MiB 预算，版本身份与快照完全相同。worker 在同步导出前后比较 stamp，变化则整体失败；成功返回本次配对版本。版本导出与原导出共享单导出在途预算；版本探测不会清除尚在途的合法操作。原 RUST-002 `exportCollectionSnapshot()` 合同保持。

## 显式路由

`createRustReadonlyCollectionRouter({owner,binary,requestTimeoutMs?,closeTimeoutMs?,startupTimeoutMs?,onFatal?})` 只借用已经 boot 的版本化 Owner。只探测并绑定来源，不调用来源 prepare、boot 或 close。返回对象只供内部明确注入使用，不替换应用默认 Dataset Owner。

- `dispatch(request)`：初始 Node；`refresh()` 成功后仅 collection.list 可使用 Rust，公开 readContext 继续交给 Node 按原合同处理；当前 collection.list 的公开 validator 会拒绝 readContext，路由保留同一失败，不冒称该字段已受支持。collection.detail/copy/photo 同样保留 Node 执行及读取结果围栏；其他命令保留 Node 唯一执行与原命令身份。
- `refresh()`：显式建立新版本快照；同时最多一次，重复调用共享在途结果。先排空旧 child，最多一个 Rust child。潜在写入在途时拒绝建立快照，不排自动重试。
- `invalidate()`：立即撤销发布权与已就绪快照；开始清理自己拥有的 child。未改变来源 Owner。
- `getStatus()`：内部只读状态，包括 phase、generation、绑定身份以及可用 snapshotId/revision/封闭错误码，不暴露原始异常、路径、SQL 或凭据。
- `close()`：立即封入口并撤销发布权，等待自己的刷新候选与 child 收口；不关闭来源 Owner。

requestTimeoutMs 与 closeTimeoutMs 各默认 5,000 ms，startupTimeoutMs 默认 5,000 ms；均允许 1～30,000 ms。探测使用 requestTimeoutMs；整段刷新共用单调 startup 期限，包括旧 child 退出、导出、pin、启动、prepare/boot 和最终探测。超时只撤销当前路由发布权，不清除来源在途 RPC，也不重试。关闭失败不允许再建立新 child 或声称自然退出。路由使用进程工厂的内部候选登记回调，在 prepare/boot 启动之前取得资源身份；启动阶段尚未返回就失败的候选也进入退役登记，强杀未退出或关闭回执失败不能遗漏。该回调不进入 options JSON、线程或 Rust 信封。

## 一致性与失败

使用 Rust 前探测版本与当前候选相同，使用后再探测一次。读取成功以最后一次相同版本探测作为一致性观察点，不承诺其后永远不再发生写入。前置探测发现变化时，本次可直接改读 Node 一次；发送 Rust 后发生变化、刷新、失效、换库或关闭时，旧结果拒绝为 `STALE_SNAPSHOT`，不得静默执行第二次公开读取。来源身份变化为 SCOPE_MISMATCH，必须新建绑定当前 Owner 的路由。

无有效 Rust 时 Node collection.list 读取也受 generation 与关闭检查约束。collection.detail/copy/photo 经当前 dispatch/repository 审定为纯读取，只走 Node 并采用相同结果围栏；不按命令名称推断全部 208 命令的副作用。非 collection.list 调用保守失效，不仅成功写入才失效；潜在写入不确定结果保留 Node 原 error、commandId 和 unknown 状态，不能自动重放。协议错误或已发送 Rust 失败保留明确错误，不用成功 fallback 将其覆盖；后续请求可走 Node，新 Rust 只由显式刷新建立。

本期采用按请求验证的失效检测，没有后台推送通知或自动刷新。版本探测增加两次进程往返，必须在完整成本记录中计算；安全一致性测试通过不证明性能提升。大于当前预算、查询索引、应用打包签名、默认启用、持久化迁移和真实设备验收仍分别待办。
