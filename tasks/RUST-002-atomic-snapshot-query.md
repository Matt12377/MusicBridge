# RUST-002 — 原子收藏快照与只读筛选

Owner 于 2026-10-02 要求持续开发，从 RUST-001 最终报告 HEAD `abc716686061811cd708eeb733e81ec82a1e93b9` 接续。分支 `codex/rust-core-002-atomic-snapshot`，独立工作树 `worktree/rust-core-002`。主代理 gpt-6.1-sol/max；沿用本会话最多 4 个 gpt-6.1-sol/high 子代理授权，受平台额度限制时分批运行，不继续派生。

## 本期范围

- Node 数据库所有者在一次同步 SQLite 读事务内导出最多 2,000 型号的完整公开 DTO；保持 rowid DESC、库存/照片/可选字段，超限和损坏失败，不截断、不拼接公开分页。
- 增加封闭私有 `exportCollectionSnapshot` 操作及客户端方法，绑定 epoch/datasetId/new snapshotId；只在成功 commitBoot 后准入。旧公开 IPC、208 命令列表、默认生产路径和数据库写入所有权不变。
- Rust 新协议 v2 支持 collection.list 的 query/brand/decade/stockState；v1 仍按既有无筛选合同工作，一进程绑定一种版本。
- Unicode NFKC、trim、空白合并和 query/brand 的 JS toLowerCase 留在 TS，私有 v2 dispatch 带 `filterProjection`。Rust 只对模型文本作 SQLite 一致的 ASCII lower，字面子串/品牌等值、年代与库存谓词在分页前应用，保持原次序。
- TS 工厂从已就绪 Node Owner 显式建立 Rust 快照端点；导出和启动具有整体期限，过期或失败不能发布端点，也不能关闭或接管原 Node Owner。
- 自动测试、真实 Node 两库/Rust 差分、2,000 型号与并发写入、坏输入/身份/超限/关闭保护，记录完整调用成本及源码/二进制身份。

## 冻结接口

Node Repository：`exportReadonlyModels(): readonly CollectionModel[]`，同步读事务；domain 可选 `exportCollectionModels?(): readonly CollectionModel[]`，为封闭 worker 操作提供 DTO。Node client 返回扩展端点，新增 `exportCollectionSnapshot(): Promise<DatasetCollectionSnapshot>`；一次最多一个导出在途，失败不自动重试。

`DatasetCollectionSnapshot = {epoch, datasetId, snapshotId, models}`，各身份按既有 UUID 规则检查，型号最多 2,000 且不重复；数据与编码均有 4 MiB 预算。worker 私有请求仅 export 操作额外带 `expectedDatasetId`，不接收路径、SQL、任意方法或参数。期望身份必须等于当前 domain，读前后执行既有工作库身份检查。

兼容性审查补充：datasetId 沿用持久工作库 UUID v1～v8，epoch/snapshotId/requestId 保持 v4；Rust v1 的冻结 datasetId v4 限制不变，仅 v2 与 Node 既有合法身份规则一致。

Rust v2 prepare 仍为 `{models}`；dispatch 为 `{request, filterProjection:{query?:string,brand?:string}}`。projection 中 query/brand 仅在原 filter 对应字符串 JS trim 后非空时存在，内容由 TS 既有归一化产生；各字符串 UTF-8 最多 8,192 字节。v2 各帧 version=2，ready 仍声明 collection.list 只读能力；v1 payload 和无筛选限制不变。客户端 v2 核验匹配快照的完整过滤结果与页，拒绝未申请/损坏投影和回执。

## 保持的授权边界与门禁

不切换生产默认、不访问真实工作库/账号/Roon/录音、不接管写入、不迁移用户数据、不替换安装 App、不推送或发布。继承 MBR-004 与 RUST-001 的真实验收 carryover，不冒称性能收益。

Rust fmt/clippy/test/locked build、真实二进制与异常集成 Gate、工作区 typecheck/完整单元/build、control-plane/boundaries/cycles、最终差异/JSON/源码与二进制身份。独立实现和报告提交，STATUS 只增加本期事实；下一任务从最终报告 HEAD 建立。
