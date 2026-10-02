# Rust 只读快照进程协议 v3

RUST-004 从 RUST-003 最终报告 `f3b398f7f872d5776ab8a65f3eb3ec5d7894c0af` 接续。显式选择 `snapshotProfile: 'v3-5000'` 才使用本协议。默认或 `'v2-2000'` 保持旧 2,000 型号与 v2；原生程序同时兼容 v1/v2。正式应用默认继续 Node，本协议不准入持久化写入、schema 迁移、真实账号或发布。

## 完整事实与 Node 边界

私有 Node version=1 新增封闭操作 `exportLargeVersionedCollectionSnapshot`，仅已有信封和 expectedDatasetId，不接收路径、SQL、分页、筛选或任意方法名。公开 208 命令保持。客户端与 Worker 必须已 boot；原始导出、旧版本导出与新大导出共享单在途预算和快照 ID 防重复。

`DatasetOwnerLargeSnapshotEndpoint` 在既有版本端点上新增同名方法，返回 `{snapshot,version}`；snapshot 恰为 `{epoch,datasetId,snapshotId,models}`，version 恰为 `{epoch,datasetId,revision}`。沿用 RUST-003 同连接 stamp、opaque revision、读取前后 stamp 及身份配对；超限、损坏、变更或错配整体拒绝。

大模式最多 5,000 型号、完整 JSON UTF-8 最多 8,388,608 字节。型号无重复 ID，全部是合法原公开 DTO，包括库存、长度、代表照片和照片数。Node 一次同步 BEGIN 读事务捕获全部型号和水合批次，成功 COMMIT、失败 ROLLBACK，不拼接实时分页。旧导出方法和 guards 仍为 2,000 型号 / 4 MiB。数据库写入所有权及生产容量规则不变。

## 帧、上传与准入

信封仍为 `{protocolVersion:3,requestId,epoch,datasetId,snapshotId,sequence,operation,payload}`。沿用严格 UTF-8 JSON 行、闭集字段、重复字段拒绝、UUID v4 请求/epoch/snapshotId、合法 v1～v8 datasetId、单调序列、最多 65,536 请求及保留关闭序列。成功 prepare 绑定协议与身份，此后不能切换。

| 操作 | payload | 成功 result |
|---|---|---|
| prepare | `{modelCount:N}`，N 是 0～5,000 安全整数 | `{epoch,datasetId,snapshotId,readOnly:true,capabilities:['collection.list'],modelCount:0,expectedModelCount:N}` |
| appendSnapshot | `{chunkIndex:i,models:[...]}` | `{chunkIndex:i,receivedModelCount:累计接收数}` |
| commitBoot | `{}` | null |
| dispatch | 与 v2 一致的 request/filterProjection | 与 v2 一致的完整 collection.list 页 |
| close | `{}` | null，然后自然退出 |

prepare ACK 只确认 manifest，不能查询。chunkIndex 从 0 连续增加，每块恰含 `min(128,N-received)` 个型号，最多 40 块；空库零块。Native 校验每块 DTO、跨块重复 ID、连续索引和准确累计数。append 帧最多 1,048,576 字节，完整规范编码 snapshot 最多 8 MiB，全部 append 输入含每个 LF 累计最多 8 MiB＋64 KiB；一般帧仍最多 4 MiB。三个预算同时生效。

两端单帧预算均不计 LF，与 v1/v2 相同；累计上传预算逐个计入 LF。生成的合法 128 型号块同时满足两侧限制。

TS 每块准确核对 ACK 索引与累计数量，拒绝额外字段、错序、增减和旧 ACK，不重发。没有预先编码并保留全部帧；仅按有界块发送。完整接收且 commitBoot 才封闭上传并准入读取。缺块 boot、额外块、非法启动帧、超限、身份/版本变更和完整前 dispatch 均使 v3 启动失败并清理部分集合，不返回部分列表。上传前、上传中、完整后的合法 close 均可收口；成功必须有 ACK 与真实退出 0/signal=null。

v3 的筛选/Unicode/ASCII lower、分页前 AND、稳定顺序、字面 `%`/`_`、total/hasMore 和 DTO 与 [v2](rust-readonly-sidecar-v2.md) 一致。TS 仍使用完整不可变事实逐次核验回执。公开 collection.list 不接受 readContext，其失败继续由 Node 保留。

## 生命周期与路由

FromOwner 大模式必须有新大版本方法，严格复制/冻结并核对 paired version/身份；缺少方法整体拒绝，无静默降级。Router 大模式继承 [路由 v1](rust-readonly-router-v1.md)：初始 Node、显式 refresh、前后版本探测、generation、单 child、失败候选登记、旧资源退役与原 unknown 写回执不重放。

导出、复制、pin、prepare、全部块和 boot 共用整体单调启动期限。每块请求期限受剩余整体期限限制，不重新累计；同步阻塞后同样检查。来源已接受的合法 RPC 仍正常结算，取消发布不伪造取消来源。v3 Router 的 close/invalidate 即刻封闭已登记的上传候选；等待当前已发块 ACK 后停止下一块，再 close 和自然退出。迟到候选与结果不能恢复发布，关闭失败阻止下一 child。

来源 Node 只借用，其 boot/close 由原控制面负责。没有后台自动刷新、写入迁移、默认开关、安装或真实验收。

## 自动证据

新 Gate 保留 v1/v2 及原 Node/路由测试，新增大快照、精确字节边界、真实 5,000 型号 40 块 / 50 全页 / 108 筛选页、写后刷新、部分 close、实际 SIGKILL、v7 与 unknown 冷启收据。6 种工作量各 10 个 warm 样本记录完整 Node/Rust 含双版本 RPC 与 TS 核验成本，同时记录导出、刷新、上传字节和自然关闭。OS 缓存未控制，合成规模不证明真实库/冷盘收益或硬内存上限。
