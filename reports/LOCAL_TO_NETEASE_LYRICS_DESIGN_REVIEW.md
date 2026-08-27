# Local-to-NetEase Cross-source Lyrics 设计修订报告

## 身份

- 设计基线：`main` `207f7f04bc11fd4dcf7e6214ab705e999ee6f559`
- 基线来源：PR #6 merge commit
- 设计分支：`codex/local-netease-lyrics-design`
- 设计 ADR：`docs/adr/ADR-008-LOCAL-TO-NETEASE-CROSS-SOURCE-LYRICS.md`
- 实施计划：`project/WAVE-4.yaml`
- 生产代码改动：无

## 现状核对

本轮直接审阅了以下现有边界：

- `packages/bridge-core/src/lyrics/coordinator.ts`
- `packages/bridge-core/src/netease/client.ts`
- `packages/bridge-core/src/netease/lyrics.ts`
- `packages/bridge-core/src/matching/`
- `packages/bridge-core/src/application/bridge-controller.ts`
- `packages/bridge-core/src/roon/public-library.ts`
- `packages/bridge-core/src/favorites/repository.ts`
- `packages/contracts/src/lyrics.ts`
- `packages/contracts/src/library.ts`
- `packages/contracts/src/playback.ts`
- `packages/contracts/src/matching.ts`
- `packages/contracts/src/validator.ts`

确认已有基础：

- LyricsCoordinator 已有 generation stale guard、50 首内存 LRU、Roon Time/estimated/static 时序和 active line 立即推送。
- NetEaseClient 已有受控 Track Search 和固定 `lyric_new` 能力。
- Controller 的 Smart Roon 队列保留原始 NetEase 逻辑 Track ID。
- 直接 Roon 队列项通过 `preferredSource: roon` 与 Smart-Roon 区分。
- Roon Library descriptor 已有可选 version，但当前 TrackSummary 尚未透传。
- Favorite repository 已提供严格校验、串行 mutation、原子 rename 和有界集合的可复用实现模式。

确认的架构缺口：

1. LyricsCoordinator 当前把任意 `currentTrack.id` 当 NetEase ID；直接 Roon ID 实际是运行期引用投影。
2. Playback Match 方向是 NetEase → Roon，不能表示 Roon Local → NetEase 的歌词确认。
3. 现有 MatchState 没有 `AMBIGUOUS`，且 Playback 阈值/缓存生命周期不适合歌词错误风险。
4. 没有稳定 LocalTrackSignature 或 Local → NetEase 正向持久仓库。
5. LyricsSnapshot 没有公开歌词来源字段。
6. 没有当前曲目的 MANUAL 候选会话和撤销 seam。
7. Core 正式持久数据路径需要由 Electron `userData/data` 注入，不能新增 cwd 依赖。

## 修订结论

- 需求可以在现有架构内实现，不需要更换播放状态机或扫描本地媒体。
- 必须新增独立 LyricsMatch 领域，Playback Match 只能作为可信身份输入，不能直接复用结果对象。
- LocalTrackSignature 由 title/artists/album/duration/version 构成，artists 稳定排序、duration 按 1 秒量化，并在每个 playback generation 内冻结。
- 五组版本冲突在评分前 hard reject；album mismatch 只降分；同录音跨专辑按录音簇处理。
- 只持久化 `CONFIRMED/MANUAL` 正向记录；其余状态和网络失败不落盘。
- Roon 播放、Zone、Queue 和 Transport 不接受 Resolver mutation；跨源歌词失败永远不能成为播放失败。
- 完整产品范围保留 MANUAL UI，按 TASK-042 至 TASK-047 线性实施。

## 验证

| 检查 | 结果 |
|---|---|
| `git diff --check` | PASS |
| `project/WAVE-4.yaml` 解析 | PASS |
| `node scripts/ci/verify-control-plane.mjs` | `CONTROL_PLANE=PASS` |
| `node scripts/ci/verify-boundaries.mjs` | `BOUNDARIES=PASS` |
| 需求 1–17 对照 ADR-008 | 全部有明确设计落点 |
| Synthetic/真实样本对照 | 已进入 ADR-008 与 TASK-047 验收矩阵 |

这些是 docs-only 设计验证，不是行为 GREEN，也不替代 Slice A RED/GREEN、完整 Synthetic E2E、真实 Roon/NetEase 或 Owner 验收。

## 下一 Gate

Owner 接受 ADR-008 后：

1. 合并设计修订；
2. 从该 merge SHA 创建 `codex/task-042-local-lyrics-match-domain`；
3. TASK-042 仅写纯领域 RED，确认有效失败后再写 GREEN；
4. 不提前接 IPC、磁盘、网络或 UI。
