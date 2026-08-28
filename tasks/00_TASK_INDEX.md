# 任务索引

严格按依赖顺序执行；一次只给 LunaMax 一个任务。

| 任务 | 目标 | 依赖 | 退出 Gate |
|---|---|---|---|
| TASK-000 | 环境与运行时重新锚定 | 无 | 仅检查，不实现功能 |
| TASK-001 | Starter 安装、lockfile 与自动基线 | 000 | npm verify 可重复 |
| TASK-002 | Roon 发现、配对与 Zone Gate | 001 | 扩展可见、可选 Zone |
| TASK-003 | 网易云合法 URL 与普通音质实播 | 002 | standard/exhigh 真实出声 |
| TASK-004 | 无损、Range、Signal Path 与长播 | 003 | lossless Gate 或明确降级 |
| TASK-005 | POC 关闭与冻结检查点 | 004 | POC-001_RESULT 完整 |
| TASK-010 | 迁移到最小 pnpm workspace | 005 | 行为不变、测试全保留 |
| TASK-011 | Electron/Vue 安全空壳 | 010 | Main/Preload/Renderer Gate |
| TASK-012 | Bridge Core utilityProcess 与 typed IPC | 011 | Core 独立、崩溃可诊断 |
| TASK-013 | safeStorage 凭据保险库 | 012 | Cookie 不进 Renderer |
| TASK-020 | 网易云扫码登录状态机 | 013 | 扫码/过期/退出 Gate |
| TASK-021 | 搜索、我喜欢与歌单 | 020 | 分页与领域模型 Gate |
| TASK-022 | 队列与播放控制 | 021 | play/stop/next/previous |
| TASK-023 | Roon 元数据、音质与错误恢复 | 022 | 可理解状态与降级 |
| TASK-029 | V1 完成控制面、CI 与 Provider 契约冻结 | 023 | 控制面、CI、安全扫描与 wrapper contract |
| TASK-024 | 同步歌词 | 029 | lyric_new、时序与 stale guard |
| TASK-030 | V1 主界面 | 024 | Home/Search/Library/Now Playing/Settings |
| TASK-031 | 诊断、崩溃恢复与长队列 | 030 | 30 首稳定性 Gate |
| TASK-032 | 菜单栏与应用生命周期 | 031 | 关闭窗口不误杀、退出完整清理 |
| TASK-033 | V1 UI 参考适配（Music Source Sidebar） | 032 | Apple Music 风格导航、synthetic 截图与 E2E |
| TASK-034 | 每日推荐与账户 Settings | 033 | 推荐解析契约、账户 Hero 与 synthetic E2E |
| TASK-035 | Remote Core 开发模式 | 034 | 隧道安全边界、Core/Gateway 合成 Gate |
| TASK-036 | Main CI 稳定化与 Beta.2 重建基线 | 035 | 分层 CI 全绿、控制面一致、beta.2 基线结构 |
| TASK-040 | DMG、签名、公证与干净机 | 036 | Beta 安装 Gate |
| TASK-041 | Beta 总验收与发布包 | 040 | V1 Beta 报告 |
| TASK-042 | LyricsMatch 领域模型与版本冲突 | ADR-008 + main 207f7f0 | 纯领域 RED/GREEN |
| TASK-043 | LocalTrackSignature 与有界仓库 | 042 | 稳定身份与原子持久化 |
| TASK-044 | 异步 NetEase Lyrics Resolver | 043 | 搜索、聚类与 stale guard |
| TASK-045 | Cross-source LyricsCoordinator | 044 | 来源合同与 Roon 时间轴 |
| TASK-046 | 歌词来源与 MANUAL UI | 045 | 选择、撤销与安全 IPC |
| TASK-047 | Synthetic 与真实跨源歌词验收 | 046 | 自动、真实 Roon/NetEase、Owner 分层报告 |
| TASK-048 | V3 收藏与录音导航基础 | V3 文档基线 b0e1ff8 | 双入口、收藏双视图、独立录音页、播放隔离与 V2 回归 |
| TASK-049 | V3 库存领域、账本与录入 | 048 最终 HEAD 5ed814a | SQLite 持久化、数量守恒、永久编号、幂等转移、正式录入与重启恢复 |
| TASK-050 | 实物照片、代表图与收藏墙 | 049 最终 HEAD 71eca19 | 图片安全导入、旧库迁移、代表图、品牌/年代浏览与库存不变 |

任何任务若为 BLOCKED，后续任务自动暂停。

WAVE-4 是 Owner 从已整合 Bug 修复的 `main` 明确启动的功能线，不把尚未完成的 TASK-040/TASK-041 分发验收视为已完成，也不以跨源歌词自动 Gate 替代签名、公证、安装或 Beta Owner Gate。WAVE-4 内部仍严格按 TASK-042 至 TASK-047 线性执行。

WAVE-5 是 Owner 于 2026-08-27 认可 Preview 02 后授权启动的 V3 开发线，见 `project/WAVE-5.yaml`。首任务从已同步最新需求的 V3 文档基线建立，旧 WAVE-3 控制面不改写。首任务只包含导航基础；后续任务从上一任务最终 HEAD 建立并单独定义范围，不将历史验收或 F-01 自动标为完成。

- [TASK-051：实体音乐库](TASK-051-v3-physical-music-library.md) — 原版 CD/磁带、旧录音内容与同库展示；基线 TASK-050。

- [TASK-052：Roon 双向关系](TASK-052-v3-roon-physical-links.md) — 确认关系、离线保留、Provenance 与收藏矩阵；基线 TASK-051。

- [TASK-053：Roon 选曲草稿](TASK-053-v3-master-source-picker.md) — 持久化草稿、稳定曲目身份、明确排序与未验证来源边界；基线 TASK-052。

- [TASK-054：只读源验证](TASK-054-v3-source-evidence.md) — 明确授权目录、实际文件校验、独立证据与后台任务；基线 TASK-053。

- TASK-055：分面规划、现有库存推荐与明确预留；从 TASK-054 最终身份接续，持续开发授权。

- [TASK-056](TASK-056-v3-master-layout-versions.md)：源帧证据与不可变母版/布局版本。

- [TASK-057](TASK-057-v3-logic-preparation.md)：Logic 工作副本、Preparation Workspace 与安全交接清单。

- [TASK-058](TASK-058-v3-prepared-render-conformance.md)：原始 Render、实际 Marker、Conformance 与 Frozen PREP。

- [TASK-059](TASK-059-v3-execution-planning.md)：显式执行格式、精确帧配方与 PCM 编译内核。
- [TASK-060](TASK-060-v3-execution-assets.md)：版本化 Profile、本次参数、持久执行资产与桌面确认。
- [TASK-061](TASK-061-execution-conversion.md)：执行转换谱系、固定格式编译与独立 Derivative。

- [TASK-062](TASK-062-archive-foundation.md)：归档 Root、内容去重和文件/数据库事务恢复基础。

- [TASK-063](TASK-063-archive-workflow.md)：归档授权、完整执行谱系与桌面明确确认。

- [TASK-064](TASK-064-backup-foundation.md)：一致性快照与归档内容备份基础（本地自动 Gate 通过；恢复与 Owner 待后续）。

剩余 TASK-065～079 与 Owner 条件见 [V3 TODO](../project/V3_TODO.md)，任务开始前展开详细范围。

- [TASK-065](TASK-065-archive-restore.md)：隔离恢复候选、重复恢复保护与基本索引重建（本地自动 Gate 通过；激活与 Owner 待后续）。

- [TASK-066](TASK-066-backup-restore-workflow.md)：备份恢复持久工作流、位置绑定、明确激活与桌面入口（本地自动 Gate 通过；容量与Owner边界保留）。

- [TASK-067](TASK-067-command-outbox.md)：跨Renderer/应用重启未确认命令、工作库身份隔离和人工恢复入口（本地自动 Gate 通过；Owner未验收）。

- [TASK-068](TASK-068-reference-catalog.md)：参考资料版本、目录修订、合并拆分审核与Unknown/Missing边界（本地自动Gate通过，Owner未验收）。
- [TASK-069](TASK-069-excel-import.md)：Excel原行追踪、非破坏导入修订与明确数量账本更正（本地自动Gate通过，Owner未验收）。

- [TASK-070](TASK-070-want-completion.md)：求购目标、当前持有长度与不可变收藏完成度（本地自动Gate通过，Owner未验收）。

- [TASK-071](TASK-071-source-picker.md)：关系选曲、明确历史上下文的下一步与照片按需读取（本地自动Gate通过，Owner未验收；F01已确认）。

- [TASK-072](TASK-072-recording-plan.md)：F-01 已确认；不可变 Profile Snapshot / RecordingPlan 与执行 Preflight（本地自动阶段通过，Gate B 未认证仍阻断）。

- [TASK-073 输出后端与Gate B](TASK-073-output-backend.md)：无设备阶段、输出面板、隔离生命周期及启动退出/配置隔离本地Gate通过；真实Gate B待验。Owner已授权后续软件任务顺序开发至TASK079，实机与人工验收分别保留。

- [TASK-074](TASK-074-recording-attempts.md)：录音Attempt状态机、不可变事实、崩溃中断及介质保护；本地Gate通过，真实输出准入仍阻断。

- [TASK-075](TASK-075-recording-records.md)：不可变录音档案、检索、当前内容认知与双库同步；本地Gate162/1035/505、安全29、Electron4、E2E86通过，实机及Owner待验。

- [TASK-076](TASK-076-digital-replica.md)：历史执行音频/原始Render与有限Replica会话；本地软件Gate通过（174/1066/532、安全29、Electron4、E2E88），可听播放及Owner待验。

- [TASK-077](TASK-077-j-card.md)：基础J-Card、Artwork归属与不可变Printed Artifact；本地软件Gate184/1088/601、安全29、Electron4、E2E90通过，真实打印/Owner待验。
