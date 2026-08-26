# TASK-045：Cross-source LyricsCoordinator 与来源合同

## 目标

把 LyricsMatchResolver 接入现有 LyricsCoordinator，正确区分 NetEase、Smart-Roon 和直接 Roon 本地曲目，并让来源字段与 Roon Transport 时间轴通过公开合同安全到达 Renderer。

## 基线与分支

- 基线：TASK-044 合并后的最新 `main`。
- 分支：`codex/task-045-cross-source-lyrics-coordinator`。

## 允许范围

- `packages/contracts/src/lyrics.ts`、validator、IPC 类型与测试
- `packages/contracts/src/library.ts` 的可选 `TrackSummary.version`
- Roon descriptor → TrackSummary 的明确 version 透传
- `packages/bridge-core/src/lyrics/coordinator.ts`
- Runtime/Controller 中构造 LyricsRequestContext 所需的最小 seam
- Main/Preload 对新增只读歌词状态合同的必要透传
- 对应 contracts、bridge-core、desktop tests
- 本任务结果报告和 `project/STATUS.json`

不得加入 MANUAL 选择 UI。

## RED

至少覆盖：

- NetEase 音频直接使用队列 NetEase ID；
- Smart 播放解析为 Roon 时仍使用原始 NetEase 逻辑 ID；
- `preferredSource === 'roon'` 的直接本地曲目生成 LocalTrackSignature；
- Roon runtime ID 不会传给 `lyric_new` 或持久仓库；
- 本地播放先进入 playing，歌词仍可保持 loading；
- 快速切歌/stop/Zone 切换后旧结果不覆盖；
- pause 冻结，resuming 不推进，真实 Roon playing 后重新锚定；
- seek 确认后立即更新 activeLine；
- activeLine 变化不受通用 250ms 节流，逐字仍保持 100ms 专用节流；
- `LyricsSnapshot.source` 只接受 `netease`，不接受 confidence/evidence/raw response；
- 无匹配、无歌词和网络失败不改变 PlaybackSnapshot 或调用 stop。

## GREEN

- LyricsCoordinator 的 cache key 使用歌词身份，不再只用 `currentTrack.id`。
- `LyricsSnapshot.source?: 'netease'` 仅在 ready/instrumental 的 NetEase 结果中设置。
- TrackSummary.version 仅透传来源明确字段，不从标题猜测。
- Controller 保持音频状态权威；LyricsCoordinator 只订阅，不 mutation playback。
- 现有 NetEase 歌词、Smart queue、pause/resume/seek 行为不得回归。

## Gate

- contracts/bridge-core/desktop focused RED/GREEN；
- 全量 `verify`；
- control plane、boundaries、security；
- Electron synthetic gate；
- `git diff --check`。

实现提交：`feat(lyrics): coordinate cross-source local lyrics`。

报告：`reports/TASK-045_RESULT.md`。
