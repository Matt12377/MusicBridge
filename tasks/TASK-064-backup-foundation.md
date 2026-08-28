# TASK-064：一致性快照与归档内容备份基础

## 身份与授权

Owner 持续开发授权及本轮“把剩余 task 列在 todo 上，并继续开发”。独立分支 `codex/task-064-backup-foundation`，基线 `37bd9a03466a0b2c12a1868fe5b68a272da3dfc7`。不 push、不合并 main、不发布，不使用真实音乐/账号/设备，0 子代理。

## 范围

1. SQLite Backup API 生成数据库一致性快照，包含已提交 WAL，不复制活动数据库主文件冒充快照。目标必须是新建的受控目录，不能覆盖用户文件。
2. 归档内容备份按快照中的已完成操作、Manifest、内容引用选取闭包；从快照读取范围，不在复制期间重新枚举活动 DB。未完成归档明确阻断本切片的完整范围备份。
3. 复制声明范围内的实际 Content Object 字节，逐项 Hash/大小、Manifest 与数据库关系校验，保存版本化备份清单；元数据和完整归档内容两种范围必须区分。完整归档内容不等于整台设备或所有外部工作副本备份。
4. 非破坏性写入、有界文件流、取消/失败不产生可用完成标记，已有对象或目录不覆盖；只验证已明确持有的能力目录。备份不继承新的音频保留或自动清理政策。
5. 合成 WAL/库存/母版/执行/归档测试，证明快照一致、缺字节/Hash 变化/未完成操作/目标冲突拒绝，源与已有文件不变。

## 明确排除与后续

TASK-065 承接隔离恢复、当前库切换、基本索引重建与 Quarantine；TASK-066 承接 Main/preload/UI 原生授权和后台任务。当前 API 只在 Core 内部使用，不暴露任意路径 IPC。

当前档案对象范围含已归档的源/Render/执行音频和清单。SQLite 内的收藏照片随一致性快照保存。尚未归档的外部 Source、工作副本、账号凭据、Roon 运行时会话不宣称已备份。F-01 仍待 Owner，不解锁正式 Plan/Attempt。完整 Gate E、真实恢复和 Owner 验收未完成。

## 允许路径

- `packages/bridge-core/src/collection/repository.ts` 的一致性快照边界与生命周期保护。
- `packages/bridge-core/src/recording/backup-*.ts`，必要的既有 archive/source 安全文件能力复用。
- `packages/bridge-core/test/collection-repository.test.ts`、新备份边界测试和既有合成 fixture。
- `tasks/TASK-064-backup-foundation.md`、索引、WAVE-5、STATUS、V3 执行计划/TODO、ADR-024、结果报告及本地证据。

## Gate

先运行最小失败测试，再实现。定向备份/归档/库存测试、完整 verify、安全/Electron/E2E、control-plane/boundaries/cycles、diff 与身份检查，分层记录。若后续 UI 尚未接入不得以 Core 测试称 Backup Archive Now 已交付。

## 当前结果

本地自动 Gate 已通过，结果与身份见 `reports/TASK-064_RESULT.md`（报告提交阶段生成）。当前仅完成本文的 Core 基础范围，后续恢复激活/UI和完整Gate E未完成。
