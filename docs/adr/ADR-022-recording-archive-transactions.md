# ADR-022：录音归档内容对象与恢复事务

状态：Core 基础已实现，产品接线与完整 Gate E 待后续。TASK-062，2026-08-28。

## 目的与边界

原始 Local/Roon 源始终只读。准备目录、实际执行资产和最终归档有不同生命周期，不能把“文件已生成”当作“已归档”，也不能把“已归档”当作正式录音完成。F-01 尚未确认；本 ADR 不决定音频长期保留期限，不冻结 RecordingPlan，也不打开实际输出。

## 目录与对象

只读预览验证目标的真实路径和目录身份，拒绝符号链接、系统根，以及与 Source Roots 任一方向重叠的目录。明确确认后，排他创建 `MusicBridge-Archive-<id>`，权限 0700；所有新普通文件 0600。Root 保存随机 owner 标记和目录 dev/ino；每次操作前后复核。Objects 下以完整 SHA-256 作为文件名，Operations 下以稳定 operation_id 存放私有意图、公开谱系清单和暂存。

私有 Intent 保存源 capability、相对源位置、期望 Hash/长度和目标。Manifest 仅记录 M/L/执行资产标识、角色、显示名、Hash/长度和媒体类型，不含私有路径。当前基础支持音频与 JSON 对象；Artwork/J-Card/Photo 对象在相应功能接入时扩展，不能将这些缺项当作完整归档。

采用同卷 hard link 作原子 no-replace 发布，避免 rename 覆盖既有同名对象。发布前后完整 Hash/长度复核；已有对象若内容不同则拒绝，保留现状，标记恢复要求。不会用新数据“修复性覆盖”共享对象。同 Hash 多角色或多操作建立独立引用，但共享一份内容字节。现阶段只支持能够创建硬链接及 fsync 的本地文件系统；不宣称 NAS/FAT 等文件系统通过。

## 事务协议

数据库可先记录 REQUESTED 和已确认请求，此时没有归档对象引用。后续阶段为 INTENT_WRITTEN → STAGED → VERIFIED → PROMOTED → DB_COMMITTED → FINALIZED。

- 临时文件使用随机 `.partial-<id>` 名称和排他只写目标句柄；输入只读，完整复制与输出回读校验后取得稳定暂存名。失败半成品不覆盖、不删除。
- VERIFIED 重新检查 Hash、大小与有界音频容器解析或 JSON 解析；音频解析不冒充新一轮逐帧解码认证。执行层已有解码/PCM 证据由后续产品接线一并引用。
- 文件、阶段标记和父目录先 fsync；PROMOTED 仅表示对象已发布，SQLite 尚未建立引用。
- DB_COMMITTED 在单个 SQLite 事务中写对象、角色引用与状态。已有库存、实体音乐库、执行资产和录音状态不改写。schema 13 与历史迁移同事务，失败回滚。
- FINALIZED 必须看到数据库已提交标记，只移除本操作中已经完整存在于 Objects 的稳定暂存副本。独立 inode 的失败 partial 不删除。link 成功但解除临时别名之前的中断，可在校验 inode 与 Hash 后解除该成功别名。这属于成功操作的副本收尾，不决定长期保留政策。

## 恢复与取消

STAGED/VERIFIED 之后可在原始执行目录离线时利用已校验暂存恢复；PROMOTED 之后只校验已发布对象、补交数据库，不重新复制源。重复恢复不创建新实体或库存。DB_COMMITTED 后恢复补齐 Finalize；FINALIZED 历史仍要重读对象，文件丢失或 Hash 变化记录 ARCHIVE_RECOVERY_REQUIRED，不删引用、不伪称当前可用。损坏对象和半成品原地隔离，不进入成功引用；完整 Quarantine UI/处置和 manifest 重建后续实现。

提交前取消不自动重放；提交后取消不能撤销已建立的不可变引用，恢复只完成收尾并核验对象。撤销 Root 后不继续提交。调用者需把实时 Source/目标撤权及应用关闭接到 AbortSignal；这些服务接线、总体任务期限与公开错误合同是下一任务准入项。当前内核尚未开放 Renderer IPC，不能直接把 private API 当产品 API。

同一 Core 的各调用者按规范化 Root 路径串行；文件排他操作是第二道保护。本阶段不支持两个应用实例同时向同一 Archive Root 写入，后续产品接线必须维持单写者约束。

## 验证边界

合成输入覆盖各阶段故障、磁盘满、重复请求、取消、撤权、目录替换、Hash/格式错误和源属性不变；另以实际 Node 子进程 SIGKILL 覆盖 PROMOTED 与 DB_COMMITTED 后的 SQLite/WAL 冷恢复。具体新鲜结果见 TASK-062_RESULT。它不是实际断电硬件测试、完整备份恢复、完整 Gate E 或 Owner 验收。
