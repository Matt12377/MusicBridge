# TASK-042：LyricsMatch 领域模型与版本冲突

## 目标

在不接 IPC、磁盘、Provider 或 UI 的前提下，建立独立的 LyricsMatch 领域模型，冻结候选规范化、五轴版本硬拒绝、录音聚类、评分和结果状态。

## 基线与分支

- 基线：ADR-008 设计提交合并后的最新 `main`。
- 分支：`codex/task-042-local-lyrics-match-domain`。
- 本任务不得从 `bugfixv2` 或旧 V2 工作树继续开发。

## 允许范围

- `packages/bridge-core/src/lyrics-matching/types.ts`
- `packages/bridge-core/src/lyrics-matching/normalize.ts`
- `packages/bridge-core/src/lyrics-matching/version-profile.ts`
- `packages/bridge-core/src/lyrics-matching/scorer.ts`
- `packages/bridge-core/src/lyrics-matching/index.ts`
- `packages/bridge-core/test/lyrics-match-domain.test.ts`
- 本任务结果报告和 `project/STATUS.json`

不得修改 Playback Matching、LyricsCoordinator、NetEaseClient、Contracts、Renderer 或 Electron Main。

## RED

先写最小失败测试，至少覆盖：

- 唯一同 title/artist/duration/版本的候选为 `CONFIRMED`；
- Studio/Live、Original/Remix、Vocal/Instrumental、Original/Cover、Final/Demo 五组冲突逐项 `REJECTED`；
- 版本词位于 title、album 或 version 字段时同样生效；
- 同一录音位于不同 album 时聚成一个录音簇；
- 两个相似但不同版本或时长的录音簇为 `AMBIGUOUS`；
- 单一候选但 duration/artist 证据不足为 `POSSIBLE`；
- 无候选为 `NONE`；
- 排序在同分时稳定，与输入顺序无关；
- 领域结果与 Playback `MatchResult` 类型不可互换。

RED 必须证明行为断言失败；编译失败、路径错误或 0 tests 不是有效 RED。

## GREEN

- `LyricsMatchState` 包含 `CONFIRMED | MANUAL | POSSIBLE | AMBIGUOUS | REJECTED | NONE`。
- 五轴硬拒绝先于评分执行，任何加分不得覆盖冲突。
- album mismatch 只能减分，不得直接拒绝。
- 聚类结果保留有界内部 evidence，不含歌词正文、Provider 响应或凭据。
- `algorithmVersion` 为显式常量，测试冻结阈值和版本。
- 不加入 YAGNI 的声纹、ISRC、媒体路径、编辑距离库或机器学习依赖。

## Gate

- focused RED/GREEN 测试；
- bridge-core typecheck；
- `git diff --check`；
- 规格审查先于代码质量审查；
- 自动测试、提交、PR/CI 和 Owner 接受分开记录。

实现提交：`feat(lyrics): add independent lyrics match domain`。

报告：`reports/TASK-042_RESULT.md`。
