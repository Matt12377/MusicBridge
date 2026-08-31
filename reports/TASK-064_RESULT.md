# TASK-064：一致性快照与归档内容备份基础

## 身份

- 基线：`37bd9a03466a0b2c12a1868fe5b68a272da3dfc7`（TASK-063 最终锁定）。
- 分支：`codex/task-064-backup-foundation`。
- 实现提交：`51c0329e96d11e39326d8347212aef82e3bc459d`。
- 报告提交由最终锁定提交的 STATUS 记录；最终 HEAD 另写本机 final-closeout.json，后续任务必须从该 HEAD 接续。
- Owner 持续开发授权，0 子代理；不 push、不合并 main、不发布。真实 Provider、Roon、音乐目录、设备和 Owner 验收没有因本次测试获得通过。

## 交付范围

1. `project/V3_TODO.md` 列出 TASK-064～079 与每项范围、Owner 条件和历史 carryover；步骤面板同步。
2. 仓库 SQLite Backup API 快照，包括已提交 WAL、库存账本、照片 BLOB 和版本/执行/归档关系；快照独立 journal、完整性检查、Hash 与 fsync。仓库关闭时异步备份仍持有连接，新读写拒绝。
3. 两种明确范围：元数据备份与包含实际 Content Objects 的归档内容备份。后者从快照决定闭包、跨操作按 Hash 去重，验证每个原归档对象与 Manifest，实际复制并复核所有声明字节。后续新归档不混入旧快照。
4. 新任务目录和文件排他创建，不覆盖既有备份或用户文件。异常/取消/缺失/变化/撤权/未完成操作不能通过完成验证；不完整目录保留，不自动清理。验证器只读取包内字节，不访问快照中的原路径。

这是 Core 内部备份基础，没有新增 IPC/UI。备份与恢复原生授权、持久后台任务和 Backup Archive Now 在 TASK-066。TASK-065 继续隔离恢复、Manifest 基本索引与 Quarantine。完整归档内容包不等于所有外部源、Logic 工作副本、全系统或凭据备份；F-01 未确认，不引入清理政策或正式录音。

架构决策：[ADR-024](../docs/adr/ADR-024-archive-backup-snapshot.md)。

## 验证

| 检查 | 结果 | 退出码 |
|---|---|---|
| verify：类型检查 / Contracts / Core / Desktop / build | 71/71、721/721、179/179；全部通过 | 0 |
| 安全 | 22/22 | 0 |
| Electron | 4/4 | 0 |
| 完整 E2E | 49/49，固定原生 bundle | 0 |
| Control / Boundaries / Cycles | PASS / PASS / 159 files PASS | 0 |
| 独立 Python 备份核验 | 5 个对象、1 个操作，SQLite 与 Hash 通过 | 0 |
| 暂存候选核验 | 14 路径允许集、7 个代码/测试 blob 一致，diff --check 通过 | 0 |

新增行为覆盖：WAL 快照隔离、目标禁止覆盖/链接、异步关闭；完整归档离线独立核验、元数据不含音频、快照后新归档排除、缺失/损坏/撤权/未完成拒绝、复制中磁盘满、复制期间撤权、取消、共享内容去重、照片随快照保存、篡改清单即使重算顶层 Hash 仍被数据库引用闭包拒绝；元数据读取前大小限制。

独立 Python 校验保留的合成备份：5 个对象、1 个操作，逐项 SHA-256/字节数、SQLite integrity_check 与 foreign_key_check、数据库引用与 Manifest 全部通过。此证据在新临时目录运行，不读取真实数据。没有把合成磁盘满当作真实拔盘/断电测试。

固定原生 bundle manifest SHA-256：`d552121ea60fdc4d86e7e697503e6208152679f1fad58d1ed48a59a79af597cc`，由 TASK-063 复制、逐文件 Hash 一致；原生产音频/转换路径未修改，完整 E2E 显式启用该候选。实际输出认证和发布准入仍未完成。

## 失败与审查记录

首次快照和备份包失败为生产接口不存在。后续 WAL 测试曾错误查询 inventory_lots.model_id，修正为既有 sku 关联，不修改生产库存结构。TypeScript 检查发现能力缺 id 和 never 控制流类型问题，随后修正。SPEC 后 QUALITY 自查发现元数据大小上限检查晚于 Hash，先跑 Missing expected rejection 行为 RED，再前移 stat 后检查；最终完整验证使用修复后的精确候选。没有独立子代理审查。

本机证据位于 `reports/runtime/task-064-backup-foundation`；最终日志使用 final-*，修复前 verify/e2e 仅作过程证据。final-candidate.json 保存 7 个代码/测试 Git blob，最终 Gate 前后复核一致。截图与 Playwright 产物保留，不提交私有运行目录。

## 接续

TASK-065 从本任务最终状态锁定 HEAD 接续。恢复必须保护当前数据，不使用旧路径/inode 自动恢复权限，不把 Manifest-only 索引重建变成已完成录音或库存事实。完整 Gate E-12～E-14、最终 A～E/U-01～U-10/PRD30 和 Owner 接受保持未完成。

TASK-047 真实歌词、TASK-061 发布准入、既有视觉问题和 Beta 分发验收继续保留。F-01 已再次向 Owner 提问，未收到明确答复前仍为待确认；不阻塞独立备份恢复/目录/导入任务。
