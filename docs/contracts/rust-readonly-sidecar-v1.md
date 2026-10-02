# Rust 只读快照进程协议 v1

RUST-001 从 MBR-004 最终报告提交 `2392b8f69836f02e39ce58f6e6e6e2563c6cc5d4` 开始。此协议只准入 `collection.list` 的无筛选快照分页；不是现有完整 Dataset Owner 的替代实现。正式入口默认保持 Node，不读写 SQLite、不接收数据库路径、Provider 凭据、Roon 会话、文件授权或音频。

## 传输与身份

私有 stdin/stdout 使用 UTF-8 JSON 行，每帧最多 4,194,304 字节（不计末尾 LF），最多 2,000 个型号。stdout 仅为协议帧；stderr 不转发到公开日志。UTF-8、JSON、未知字段和安全整数必须检查。超限、损坏帧和不可信回执使端点失败，不能继续用旧快照。父 stdin EOF 自然退出；不完整的末帧以非零退出。

每个请求都有这些且仅有这些信封字段：

```json
{"protocolVersion":1,"requestId":"UUID-v4","epoch":"UUID-v4","datasetId":"UUID-v4","snapshotId":"UUID-v4","sequence":1,"operation":"prepare","payload":{"models":[]}}
```

`requestId` 每次新建；`sequence` 在同一进程内从 1 连续递增，最多 65,536 次请求，为 close 保留最后一个序列位。最后序列位的其他操作返回 CAPACITY_EXCEEDED 并非零退出；请求历史因此有界。`epoch/datasetId/snapshotId` 在 prepare 时绑定，此后必须完全匹配。快照是 Node 产生的完整、已排序、不可变的公开 `CollectionModel[]`，保留其顺序及字段内容。不能把多次分页混合导出当作原子快照。调用方必须显式创建新端点刷新数据；此端点不宣称快照等于当前实时库。

响应恰有同样的身份字段（含 operation）以及 `ok/result` 或 `ok/error`：

```json
{"protocolVersion":1,"requestId":"UUID-v4","epoch":"UUID-v4","datasetId":"UUID-v4","snapshotId":"UUID-v4","sequence":1,"operation":"prepare","ok":true,"result":{"epoch":"UUID-v4","datasetId":"UUID-v4","snapshotId":"UUID-v4","readOnly":true,"capabilities":["collection.list"],"modelCount":0}}
```

失败只包含固定 `code/message`，不返回输入片段、路径、原生错误、stderr 或栈。错误码为 `INVALID_REQUEST / UNSUPPORTED_OPERATION / UNSUPPORTED_COMMAND / UNSUPPORTED_FILTER / SCOPE_MISMATCH / CAPACITY_EXCEEDED / NOT_READY / CLOSING / PROTOCOL_ERROR`。

## 操作与适配

| operation | payload | result | 约束 |
|---|---|---|---|
| prepare | `{models: CollectionModel[]}` | 上述 ready 对象 | 一次性绑定，重复不得重新装载 |
| commitBoot | `{}` | `null` | prepare 后，只标记可读取，无持久写入；TS 恢复为 undefined |
| dispatch | `{request: IpcRequest}` | 公开 `Page<CollectionModel>` | commitBoot 后，仅 `collection.list`，只准入无 filter 或空 filter |
| close | `{}` | `null` | 封闭入口，清空内存，ACK 后自然退出；TS 恢复为 undefined |

dispatch 保留公开请求 version/id/command/payload/expectedDatasetId/readContext/performanceTrace 的既有验证。公开 payload 是 `{page:{offset,limit},filter?:{}}`；offset 为 0～1,000,000，limit 为 1～100。非空筛选返回 UNSUPPORTED_FILTER，其他命令一律拒绝；不按命令前缀授权。expectedDatasetId 存在时必须等于快照 datasetId。返回 `{items,total,offset,limit,hasMore}`，不能重新排序、生成 ID 或重算历史 hash。

TS 客户端复用 `DatasetOwnerEndpoint`（prepare/dispatch/commitBoot/close）接口，同时明确只读能力。快照和结果都由现有公开 DTO 校验器验证；拒绝非 JSON 值、重复型号 ID、残缺/不完整页导出及超限输入。prepare 返回现有 `{epoch,datasetId}`，私有 ready 的其他字段只用于能力检查。现有公开合同不允许 collection.list 携带 readContext，原型同样拒绝；客户端另有本地请求期限，超时撤销发布权并令端点失败。原命令未知结果规则没有被这个只读协议代替。

## JSON 数据边界

此私有协议接受公开 DTO 的严格 JSON 子集：普通对象/数组、无覆盖式重复键、完整 Unicode 标量、安全整数；不执行访问器、toJSON 或自定义原型。collectorPolicy 必须是声明的枚举字符串，旧校验器通过 String(value) 意外接受的数组不准入。孤立 UTF-16 代理项在启动前拒绝，不能宣称协议接受所有旧 JS 校验器可能放行的值。有效的中文和补充平面字符正常保留，字符串长度仍按公开合同的 UTF-16 单元数检查。

JSON 数值不保留负零，TS 导出时将 -0 归一化为 0；不因此重算任何历史 hash 或写回原始库。既有 null 和缺省可选字段保持各自含义。freezeCollectionSnapshot 只接受一次完整公开页；现有 collection.list 每页上限 100，因此该帮助函数只能捕获不超过 100 个型号的完整结果。factory 可接受调用方独立保证完整性的最多 2,000 个型号数组；本期没有实现活跃大库的原子全量导出。

## 资源与关闭

客户端最多 16 个在途请求，采用可配置但有界的请求与关闭期限，处理 stdin 背压。关闭先封入口，等已接受请求结算，再发 close；close ACK 和自然 child close(code=0, signal=null) 两项同时成立才返回成功。强杀、超时、提前退出、坏身份、重复或孤立回执都不得伪称成功关闭；不能自动重放请求。无源码/配置开关改变现有默认运行路径。

只接受调用方显式提供的绝对可执行文件路径和 SHA-256 pin，不查 PATH、不启用 shell；子进程不继承凭据环境变量。本地构建、Cargo registry/target、测试临时目录和日志使用外置 LifeWeave。CI 锁定工具链和 Cargo.lock，单独执行 fmt/clippy/test、实际 Rust/TS 差分与故障测试。只读原型证据不代表生产安装、数据库迁移、性能改善、Roon 真实恢复或录音验收。
