# TASK-062：归档事务与内容对象基础

基线 `e785308b3ccf31cd01f4947f88c9942330b15d07`；分支 `codex/task-062-archive-foundation`。Owner 已授权持续开发到最终 Owner 验收，0 子代理，不 push、不合并 main、不发布。

## 范围与退出要求

为后续预检和归档界面先建立 Core 基础：明确授权的独立 Archive Root、只读源复制、SHA-256 内容对象去重、稳定 operation_id、不可变清单、文件与 SQLite 分阶段提交和幂等恢复。持久层只记录归档对象与版本引用，不创建录音 Attempt，不改变库存和实体音乐库。

采用 INTENT_WRITTEN → STAGED → VERIFIED → PROMOTED → DB_COMMITTED → FINALIZED；数据库可在写意图之前记录 REQUESTED，但不得出现正式对象引用。校验长度、Hash、音频格式和目录归属，落盘并同步后才允许晋级；旧内容对象不得覆盖。失效 Root、缺失对象和损坏必须返回恢复要求。测试覆盖每个中断点、重复恢复、磁盘满、源保护、去重与提交失败。

本任务是内部内核，不开放任意路径 IPC。桌面授权/预览/确认与现有执行资产的完整接线接续到下一任务；不以孤立内核作为产品归档功能完成。Root、操作意图与暂存含私有路径，只保存在本地私有目录/数据库，不进入报告或 Renderer。

## 决策边界

F-01 的长期保留政策尚待 Owner 回复。此内核不冻结该政策，不删除失败或取消产物，不自动清理独有音频。成功提交后的 FINALIZED 只移除本操作已验证存在于内容对象库的暂存副本；不删除内容对象、源文件或其他操作。完整备份、索引重建、Replica 和真实 Gate E 分别后续实现。

## 允许路径

Core recording/archive-*、collection/repository.ts 及对应测试；复用执行夹具和旧 schema 迁移夹具；既有 Desktop CoreSupervisor 长超时单测的确定性时钟修正（不改生产超时）；本任务/索引、WAVE-5、STATUS、V3 执行计划、ADR-022、结果报告。先记录 RED，再实现和回归；本地自动证据与 Owner/实机验收分开。

## 本地退出证据

最终 verify 退出 0：Contracts 66、Core 678、Desktop 175；安全 22、Electron 4、显式原生 E2E 49 全通过。归档聚焦 24 项含两次实际子进程 SIGKILL；独立 Python 复核 3 对象/3 引用/1 操作与十次重复运行，源 Hash/身份和库存状态不变。限定内核范围 SPEC → QUALITY 主代理自查通过，非独立审查。具体三提交身份与剩余边界见结果报告及 STATUS；不等同完整 V3 或 Owner 接受。
