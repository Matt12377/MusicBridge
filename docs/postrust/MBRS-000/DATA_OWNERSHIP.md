# 数据、播放与资源的唯一权威

基线：`044e6b24edf81b64030d4c96741082670532971c`。当前默认 Node；可选 Rust 收藏只读默认 OFF。下表登记实际已存在权威与未实现增量，不把新 schema 当 writer 迁移。

| 领域 / 库 | 语言 / 进程 | 唯一权威 / 写入入口 | 事务 / 恢复边界 | MBRS 增量与保留 |
|---|---|---|---|---|
| 收藏、实物关联、录音来源、冻结 / Prepared / Archive 历史，当前激活工作库 | TypeScript / Node，Core 内 dataset-owner worker | `attachDatasetOwnerWorkerPort` → `dispatchDatasetCommand` → `createCollectionRepository` 和 worker 内领域服务；UI / Main 只请求 | 默认 `<privateRoot>/collection.v1.sqlite`；恢复激活后 `<selectedDataset.database.path>/collection.sqlite`，`datasetIdentities.bind` 跟随同一激活库。`BEGIN IMMEDIATE` / ledger / 幂等与关闭等待。SourceStore、ArchiveStore 是仓库内存储组件，不是第二 writer | MBRS-002/011/014 仅沿此 owner 扩展表 / 关联 / 保护；旧 ID / Hash / 库存 / 照片不重导或重编号 |
| 备份维护工作流库，`backup-maintenance.v1.sqlite` | TypeScript / Node，同一 dataset-owner worker | `createBackupWorkflowStore`，由 `restore-dataset-runtime.ts` 组合 | 独立数据库 / 维护 journal，不能把多个库称作同一 SQLite 事务 | 作者仍唯一；跨库未知结果和步骤恢复保留，不用一个 COMMIT 承诺两库全局原子 |
| Main 命令 outbox，`command-outbox.v1.sqlite` | TypeScript / Electron Main | `createCommandOutboxStore`，Main `createCommandOutboxService` / executor；Core 执行业务而不写该 Main 库 | 原 confirmation / sending / uncertain / ACK 事务；跨库 unknown 对账，不承诺两库或文件全局原子 | 复用原 outbox；不得用新 Organizer 复制全局事务框架或跨进程双写 |
| 本地数字曲库 | 尚未实现；拟沿已验收 Node dataset owner | MBRS-002 才新增 LocalFileAsset / LocalTrack；扫描 / UI / sidecar 仅提交经过验证的请求 | 尚无持久扫描或新库结果；设计阶段独立 stable ID / revision，不复用录音精确 SourceBinding 作为可变主键 | 原 writer 保持，若以后迁 Rust，由原 Rust 路线单独交接并证明兼容 / 幂等 / unknown / 回退 |
| 全局播放 owner / attempt / 队列 / 代际 | TypeScript / Node Core | 唯一 `BridgeController`；`RoonAdapter` 是真实观察 / 提交端口 | 原意图 / owner / generation 围栏；UI 仅观察；未确认提交要 reconcile | MBRS-006/007 增量接入 local_file；不新增播放器 / 全局队列 / 歌词时钟 |
| 远程 stream 注册与 token 生命周期 | TypeScript / Node Core | `StreamRegistry` / `StreamGateway`，由既有 runtime 组合 | 既有远程来源安全策略、服务关闭与撤销；8 小时 token 不等于本地 FD lease | MBRS-005 增加本地固定 FD / revision / Range 与统一资源协调；不放宽 SSRF |
| 根授权 / 源证据 | TypeScript / Node dataset worker 及 Core reader | 仓库内 SourceStore 登记 `RootCapability`；`source-files.ts` 提供 root / FD 安全原语 | 旧录音严格 Hash / 技术校验保持；普通扫描单独策略 | 复用授权权威，不建互不知情的根表；旧 Frozen 无 local ID 时保守保护 |
| 文件 reader / Organizer 排他锁 | 尚未存在完整新统一协调者 | MBRS-005/014 定义单一协调者，再由 MBRS-012 接受已授权计划 | 按规范物理资源聚合别名 / 硬链接 / cover / CUE / 歌词；执行前再核 revision / 活跃读者 / 冻结，再取锁 | 不把 `output-run-lease` 当整个音乐库全局锁，也不允许两个进程各建锁表 |
| Rust 收藏快照 / 查询 | Rust sidecar；TypeScript Core 路由 / optional manager | Rust **无数据库 writer**；借用 Node owner 的已核 revision 快照 | 普通 v2 为 2000 型号 / 4 MiB；v3 为既有独立 5000 / 8 MiB 对照；超限 / 写后失效回 Node，原关闭围栏 | 收藏模型不当数字曲目索引，默认 OFF 保持，不用本行声称完整 Rust 迁移 |

相关路径、实际符号和 blob / SHA256 见 `BASELINE_INPUTS.json` 与复用表。归属从生产组合与事务入口核实，不能从类名猜测。跨库 / 文件操作使用明确 journal 和步骤恢复；意外退出 unknown 保留，不能自动重放副作用。

此表没有读取任何真实用户数据库或运行 App，也没有迁移数据库。未实现数字库和统一锁明确保持设计状态，后续生产准入及保护测试通过前不开启源写。
