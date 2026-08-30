# TASK-065：隔离恢复候选与基本索引重建

## 身份

Owner 持续开发到验收授权。基线 `7dab2bfdaa37d7dcb56e09f66e61f25a14e22420`，分支 `codex/task-065-archive-restore`。0 子代理，无 push/main 合并/发布；仅隔离合成数据。

## 范围

1. 先完整验证备份包，再向新建隔离目录复制数据库、Manifest 和声明内容；原库、原包、已有恢复目录不覆盖。元数据恢复不冒充音频可用。
2. 恢复的数据库保留库存、照片、母版、PREP、执行与归档事实；撤销旧 Source/工作目录/Archive Root 授权。没有用户重新确认新位置前不得访问原路径或挂接正式 Runtime。
3. 独立恢复收据记录源备份 ID/清单 Hash、恢复后数据库/内容 Hash 和候选状态。完全相同的回执可查询；当前恢复库已有新写入时重复恢复明确冲突，不覆盖用户更新。
4. Manifest-only 重建可读的基本索引，严格区分证据缺失/损坏/待核对；不能造出库存数、已完成 Recording、Frozen 或权限。Quarantine 是问题记录，不删除/改写共享内容。
5. 取消、复制故障、重复恢复、恢复后新写保护、元数据包、源包与用户原文件不变的行为测试。

## 后续激活边界

本切片输出隔离候选，不接管当前数据库。TASK-066 必须实现原生授权、明确激活、当前根位置绑定与桌面后台流程；不能把旧 inode 或旧目录权限当作恢复后有效。完整 Gate E-12/E-13 包括激活和再次备份恢复，不能仅靠本候选验证关闭。

## 允许路径

- Core `recording/restore-*.ts` 与 `recording/backup-*.ts` 必要复用；不删除不可变历史触发器，不改写原目录数据。
- `test/archive-restore.test.ts`、`test/archive-backup.test.ts` 与共享归档合成 fixture。
- 当前 task、TODO、索引、WAVE-5、STATUS、执行计划、ADR-025、报告和本地证据。

## Gate

先失败测试，再实现；定向测试、verify、安全/Electron/E2E、静态边界、候选身份与报告分层取证。真实数据/完整Gate E/Owner验收保持待完成。

## 当前结果

本文的隔离恢复与只读索引基础已通过本地自动Gate；结果与身份见 `reports/TASK-065_RESULT.md`。Runtime激活、位置重绑定、持久审核与桌面确认留给TASK-066，完整Gate E与Owner未验收。
