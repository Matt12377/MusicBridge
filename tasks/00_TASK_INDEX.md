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

任何任务若为 BLOCKED，后续任务自动暂停。
