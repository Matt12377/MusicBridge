# MBRS-011 实际复用核对

基线：`db4cded876e8eda7755d781ed4827dfc38332a10`。原 REUSE_MAP / 13_MODEL_AND_STATE_MAPPING 只作定位线索，本表以当前实现为准。

| 能力 | 当前权威与接点 | 本轮增量 |
|---|---|---|
| 原始标签、人工覆盖、生效信息 | `packages/bridge-core/src/collection/local-catalog-store.ts`、`packages/contracts/src/local-catalog.ts` | 保留分离与稳定 track/asset/edition 身份，增量扫描不抹人工编辑 |
| 唯一库作者与批事务 | 原 Dataset Owner / Node SQLite 连接、`localCatalog.privateBatch` | 不引入第二作者；确认与逐项回执同事务，撤销用新 CAS 修订 |
| 持久命令与 unknown 恢复 | 原 Main `command-outbox-service.ts` / `command-outbox-store.ts` | confirm/undo 进入原 outbox，冷启不自动重发，计划状态另行对账 |
| 原音乐库 UI 与列表 | `LocalLibraryView.vue`、`useLocalLibrary.ts`、`TrackTable.vue` | 复用原页面、原三播放动作和 84px 行高；Organizer 使用独立 busy |
| 音频读者保护 | `physical-resource-locks.ts`，Core 与 Owner 共用 dev/ino 原子资源表 | MB_ONLY 不取音频排他锁；SOURCE_FILES 的统一旧域保护未完成时强阻断 |
| 历史与冻结资源 | SourceStore / MasterVersion / Prepared / Archive 旧权威 | 不改历史 Hash、冻结绑定或旧录音资产；014 负责跨域保护补齐 |
| 发行与版本 | AlbumEdition / AlbumEditionTrack | 仅以明确发行身份展开 active 曲目；同名信息只提示，不自动合并 |

Renderer 不持有绝对路径、读票据或 SQLite 连接；公开入口仍为显式闭集，源权限和客户端 approval 不是写授权。
