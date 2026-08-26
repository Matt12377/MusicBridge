# TASK-046：歌词来源与 MANUAL 选择 UI

## 目标

在不暴露工程置信度或内部签名的前提下，显示 NetEase 歌词来源，并为未自动确认的当前本地曲目提供候选选择和撤销能力。

## 基线与分支

- 基线：TASK-045 合并后的最新 `main`。
- 分支：`codex/task-046-local-lyrics-manual-ui`。

## 允许范围

- 当前歌词匹配状态、候选会话、选择和撤销的有界 Contracts/IPC
- Core 当前播放上下文校验与 MANUAL repository mutation
- Main/Preload 安全透传
- `LyricsPanel.vue`、`NowPlayingView.vue` 及其最小样式/组件
- 对应 contracts、Core、Renderer 和 E2E tests
- 本任务结果报告和 `project/STATUS.json`

不得增加全曲库预扫描、批量匹配页面或置信度调试界面。

## RED

至少覆盖：

- ready/instrumental NetEase 歌词显示“歌词来源：网易云”；
- UI 不包含 score、confidence、evidence、algorithmVersion；
- `POSSIBLE/AMBIGUOUS` 不自动显示候选歌词；
- 候选列表只显示 title、artists、album、duration；
- 选择必须来自当前未过期 session，且属于候选 allowlist；
- 曲目切换后旧 session 的选择请求被拒绝；
- MANUAL 选择立即为当前曲目重新加载歌词，但不重启音频；
- 撤销删除当前 signature 记录并重新解析；
- 无候选、无歌词、网络失败和 Provider 未配置有可理解文案；
- 键盘、焦点、Escape、屏幕阅读器 label 和窄窗口布局可用。

## GREEN

- Renderer 不接触 LocalTrackSignature、Roon reference 或搜索原文。
- Core 创建短期 `matchSessionId`，并校验 playback generation、signature key 和 candidate membership。
- MANUAL 记录使用当前安全候选，不接受 Renderer 任意 Track ID。
- UI 复用现有 Popover/Drawer 视觉语言，不引入原生 select 气泡。
- 第一版只面向当前正在播放的直接 Roon 本地曲目。

## Gate

- contracts/Core/Renderer RED/GREEN；
- Playwright synthetic E2E；
- axe critical/serious = 0；
- Electron、安全与边界测试；
- `git diff --check`。

实现提交：`feat(desktop): add manual local lyrics matching`。

报告：`reports/TASK-046_RESULT.md`。
