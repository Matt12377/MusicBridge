# Rust 只读快照进程协议 v2

RUST-002 从 RUST-001 最终报告 HEAD `abc716686061811cd708eeb733e81ec82a1e93b9` 接续。本协议新增 Node Owner 的原子收藏导出和 Rust 只读筛选。正式应用默认继续使用 Node；Rust 不读取 SQLite、文件路径、Provider、凭据、Roon 或音频。

## Node 原子导出

Node 私有线程协议仍为 version=1，新增封闭操作 `exportCollectionSnapshot`。请求仅由现有信封与 `expectedDatasetId` 组成，不接收公开 request、路径、SQL、筛选或任意方法名。该操作不加入公开 IPC 的 208 个命令，也不暴露给 Renderer。

客户端必须已成功 prepare 和 commitBoot；最多一个导出在途。Worker 同样执行 boot 准入和当前 datasetId 核验。domain 在读取前后检查当前工作库身份，repository 在一次同步 SQLite BEGIN 读事务内选择 rowid DESC 的全部型号并水合所有库存/照片批次，验证成功后 COMMIT，异常 ROLLBACK。不拼接公开分页，不持有跨 await 事务，不改变生产连接和写入所有权。

导出结果为 `{epoch,datasetId,snapshotId,models}`。epoch/snapshotId 为 UUID v4，datasetId 沿用已有工作库 UUID v1～v8 规则，不能更换或收窄合法持久身份；snapshotId 每次新建。最多 2,000 型号、无重复 ID、合法公开 DTO，JSON 编码最多 4,194,304 字节。超限、损坏或身份变化整体拒绝，不截断。客户端验证回执身份、DTO、编码预算及 snapshotId 不重复。原子性仅描述读事务捕获的状态，不宣称该状态在后续写入后仍等于实时库。

## Rust v2 与 v1 兼容

沿用 [v1](rust-readonly-sidecar-v1.md) 的 UTF-8 JSON 行、4 MiB 每帧、模型/序列/在途预算、严格 JSON 子集、二进制 pin、只读能力与自然关闭合同。v2 信封 `protocolVersion=2`，requestId/epoch/snapshotId 仍为 UUID v4；datasetId 接受既有工作库 UUID v1～v8。成功 prepare 同时绑定协议版本与 epoch/datasetId/snapshotId；后续任何版本切换属于协议故障，撤销端点。原生程序继续接受 v1 原信封（包括其 datasetId v4 限制）和无筛选语义。当前 TS 适配器使用 v2，不静默降级。

prepare payload 仍为 `{models}`，ready 仍仅含 epoch/datasetId/snapshotId/readOnly/capabilities/modelCount；commitBoot/close payload 为 `{}`，成功 result 为 null。

v2 dispatch payload 必须恰为：

```json
{"request":{"version":1,"id":"公开请求ID","command":"collection.list","payload":{"page":{"offset":0,"limit":25},"filter":{"query":"　ＳＡ　９０％　","brand":"ＴＤＫ","decade":1990,"stockState":"blank"}}},"filterProjection":{"query":"sa 90%","brand":"tdk"}}
```

公开 request/payload/page/filter 保持现有封闭键、类型、字符串、年代和库存合同；只允许 collection.list，expectedDatasetId 仍必须匹配。公开 collection.list 不接受 readContext，本协议同样拒绝。

filterProjection 仅允许 query/brand。某一原 filter 字符串 JS trim 后非空时，projection 对应字段必须存在；否则不得存在。TS 用现有 NFKC → trim → 连续 JS 空白合并为一个空格 → JS toLowerCase 生成字符串；每字段 UTF-8 最多 8,192 字节。Native 只验证封闭形状、presence 与编码预算，不重新实现 Unicode 归一化。TS 以同一 Node 语义核验实际返回的完整筛选页；错误投影或结果不能悄悄进入公开输出。

模型文本按 SQLite 默认 lower 仅折叠 ASCII A-Z。query 在 `brand + ' ' + name + ' ' + edition` 中做字面子串匹配，品牌做等值比较；`%` 和 `_` 不是通配符。现有 `É`/`İ` 等 Unicode 大小写不对称行为保持，不借本期改变数据库搜索结果。

年代 unknown 对应 null；数字年代为 decade～decade+9。identified 对应 identification=verified；needs-review 对应非 verified 或 counts.unknown>0；blank 对应 sealedBlank+openedBlank>0；recorded 对应 legacyUsed+recorded>0。全部条件 AND，在分页前执行；返回筛选后的 total、原 offset/limit 和实际 hasMore，保持原 rowid DESC 次序及全部 DTO 内容。

## TS 从 Owner 创建端点

`createRustReadonlyDatasetEndpointFromOwner({owner,binary,startupTimeoutMs,...})` 是显式异步工厂，输入为已 boot 的扩展 Node Owner。它读取当前 prepare 身份、取得一次原子快照、复制并严格验证 JSON、核对身份、启动固定二进制、prepare、commitBoot，最终返回已就绪 Rust 端点。不会 commitBoot 或 close 源 Owner，也不会接管其写入和生命周期。

startupTimeoutMs 默认为 5,000 ms，可配置 1～30,000 ms。整个导出与启动共用单调时钟期限，包含等待源、快照复制、二进制摘要、进程建立及准备。同步阻塞后同样检查期限；迟到导出不得启动或发布端点，迟到原生回执不能恢复成功。失败仅以固定中文错误暴露，原始源错误/路径不外传；不自动重试源导出或原生操作。

源 RPC 已被接受时，工厂过期只撤销自己的发布权；源合法回执仍可收口，原 Owner 的单导出预算在真正结算后释放。工厂只清理自己已经创建的 Rust 端点；失败后的清理另有有界关闭期限，不宣称强杀等于成功 close。启动成功后的读取和关闭沿用各自期限，不因启动截止时间过后而失效。

显式完整数组工厂和 v1 的完整公开页帮助函数继续保留；公开页帮助函数仍受每页 100 型号限制。实际大于 100 型号的完整导出使用新的 Owner 原子方法。大于 2,000 型号和更大编码预算未准入。

## 证据

自动 Gate 锁定源码与二进制，验证 v1/v2、Node 原子性、真正的 Node 两库到 Rust 差分、2,000 型号、完整公开筛选、写入后的旧/新快照与异常生命周期，拒绝条件跳过实际二进制测试。成本记录包含导出 roundtrip、整段启动、重复查询的进程往返与 TS 结果验证、ACK 加自然退出；Node/OS 缓存状态如实标为未控制，不冒称冷缓存或性能提升。本地软件 Gate 不代表真实账号、Roon、录音、Owner、打包安装或远端 CI 验收。
