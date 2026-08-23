# TASK-037 结果报告：Playback Queue、Lyrics、Quality 与 Library Correctness

## 任务身份与 Git 边界

- 任务：TASK-037 — Playback Queue, Lyrics, Quality & Library Correctness
- 固定工作树：`/Users/yihe/VSCode/MusicBridge/worktree/bugfix`
- 工作分支：`codex/bugfix`
- 基线 SHA：`f93873a8e84a25a9480447afc4e7805c2970f527`
- 基线远端分支：`origin/codex/task-036-main-stabilization`，本任务未 push
- 实现提交：
  1. `bd722e319d31f8923880430dcbc31f3a6db098e1` — `fix: add non-destructive playback queues`
  2. `32d53b01c7ba30db4db05c5ea2e4836f339dd5cd` — `fix: expose truthful playback position and quality`
  3. `b23ece608cd652cb0555cb43170b8f5cb3662ab7` — `fix: make library loading and account state bounded`
  4. `42c5ae1ac7c9bf5c9b41feec7531b36d87cda97e` — `fix: refine now playing and queue inspector`
- 报告提交：本报告文件所在的后续独立文档提交；最终 SHA 以交付时 `git rev-parse HEAD` 为准。
- 外部操作：未创建 PR、未 push、未修改远端、未修改 `project/STATUS.json`。后者保持 TASK-036 身份，因为 TASK-036 是本任务明确禁止修改的范围。

## 根因与修复范围

### 1. 队列语义

原实现把加入队列与替换队列共用会停止/播放的路径，导致加入歌曲重建当前 Roon Session；“下一首播放”也没有独立 IPC 语义。现在合同层、Main、Preload、Utility IPC、Core Controller 和合成 Runtime 均提供：

- `playback.appendQueue`：只追加，不 stop/play，不撤销当前 token，不改变 index、歌曲、位置或本次音质。
- `playback.insertNext`：插入到当前 index + 1，同样不重启当前播放。
- `playback.replaceQueue`：仍然是替换队列并从指定索引开始播放。

Renderer 已拆成 `playTrack`、`appendTrack`、`insertTrackNext`、`replaceAndPlayCollection`；追加后停留在原页面并显示 Toast。

主要文件：

- `packages/bridge-core/src/application/bridge-controller.ts`
- `packages/contracts/src/ipc.ts`
- `packages/contracts/src/playback.ts`
- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/preload/api.ts`
- `apps/desktop/src/renderer/src/App.vue`

### 2. 收藏/歌单完整连续播放

原实现把首屏渲染页误当成播放集合，播放全部只能覆盖第一批歌曲，点击歌单第 N 首也无法形成后续队列。新增 `loadCollectionTracks`，按 20 首有界分页、保持 Provider 顺序、按 track ID 去重，最多构建 500 首；队列构建代次会阻止旧请求继续写入新队列。Provider 分页失败时不会先破坏当前队列。

主要文件：

- `apps/desktop/src/renderer/src/composables/collectionQueue.ts`
- `apps/desktop/src/renderer/src/App.vue`
- `packages/bridge-core/src/runtime.ts`

### 3. 真实队列摘要与播放位置

原 Queue Inspector 用 Renderer 生成“队列歌曲 N”，并重复显示当前歌曲。公开模型现在区分 `PlaybackQueueRequestItem` 与 `PlaybackQueueEntry`；Core 先取得并验证 `TrackSummary`，Inspector 只显示当前歌曲一次，未来项只显示 `queue.index` 之后的真实摘要，未解析时显示“正在读取歌曲信息”。

原进度依赖歌词行 `startMs`，无歌词时停滞。`PlaybackSnapshot.positionMs` 现在由 Core 接收经过白名单和边界校验的 Roon Time，绑定内部 playback generation；Renderer 用 `performance.now()` 平滑插值，进度条保持只读。停止、错误、切歌和自然结束会清理位置。Queue Inspector 支持 Escape 关闭并恢复触发按钮焦点。

主要文件：

- `packages/contracts/src/playback.ts`
- `packages/bridge-core/src/application/bridge-controller.ts`
- `packages/bridge-core/src/roon/adapter.ts`（使用现有安全 Roon Time 形状，不扩大公开 payload）
- `apps/desktop/src/renderer/src/components/inspector/PlaybackInspector.vue`
- `apps/desktop/src/renderer/src/components/NowPlayingView.vue`

### 4. 歌词与音质

`LyricsCoordinator` 改为“最近一次 Roon position + 单调时钟”锚点，稀疏 Roon Time 之间继续估算，并保留约 250ms 的发布节流。全屏歌词和 Inspector 共用 `LyricsLines`，支持当前行居中、邻近行可读、远处行淡化、用户滚动暂停约 4 秒、减弱动画偏好以及切歌重置。

音质从写死 `lossless` 改为默认 `auto`，公开区分用户偏好、实际请求等级和 Provider 返回等级。固定偏好只在 actual rank 低于 requested rank 时警告；自动回落和未知等级保持中性。用户修改偏好只影响下一次播放，不重启当前歌曲。

主要文件：

- `packages/bridge-core/src/lyrics/coordinator.ts`
- `packages/bridge-core/src/netease/policy.ts`
- `packages/bridge-core/src/config/config.ts`
- `apps/desktop/src/renderer/src/components/LyricsLines.vue`
- `apps/desktop/src/renderer/src/components/NowPlayingView.vue`
- `apps/desktop/src/renderer/src/components/BottomPlayer.vue`
- `apps/desktop/src/renderer/src/components/settings/SettingsView.vue`

### 5. 懒加载、账户切换与其他产品语义

搜索、收藏、歌单详情分别维护首屏加载、加载更多、底部错误、请求代次和已有数据；列表底部使用 `IntersectionObserver`，加载下一页时保留已有行、歌单头部和滚动位置，按 `track.id` 去重。登录成功会重载账户、收藏、歌单和每日推荐；退出/过期会清空所有私有资料库、每日推荐和 Renderer 内存中的最近播放历史。首页收藏区区分未登录、首次加载、已有内容、真实为空和失败。

另外完成了六种播放状态中文映射、搜索输入与 Escape 单一清空路径、真实 playing 历史（最多 6 首）、时间问候、统一 Toast、SafeArtwork 失败回退，以及 macOS `Music Bridge for Roon` 应用名称和标准菜单。

主要文件：

- `apps/desktop/src/renderer/src/components/media/TrackTable.vue`
- `apps/desktop/src/renderer/src/composables/libraryPagination.ts`
- `apps/desktop/src/renderer/src/composables/useLibrarySources.ts`
- `apps/desktop/src/renderer/src/components/SafeArtwork.vue`
- `apps/desktop/src/renderer/src/components/inspector/PlaybackInspector.vue`
- `apps/desktop/src/main/index.ts`

## 自动验证（最终源码）

下列命令均在固定工作树执行，实际退出码为 0；测试使用 synthetic/fake 边界，不连接真实 Provider、真实账号、真实 Roon 或 Core Mac。

| 验证项 | 结果 |
|---|---|
| `corepack pnpm@10.17.1 install --frozen-lockfile --ignore-scripts` | PASS，退出码 0；依赖基线未改变 |
| `corepack pnpm@10.17.1 verify` | PASS，退出码 0；typecheck、Contracts 19/19、Bridge Core 184/184、Desktop 73/73、production build |
| `corepack pnpm@10.17.1 --filter @music-bridge/desktop test:e2e` | PASS，Playwright 9/9，退出码 0 |
| `node scripts/ci/verify-control-plane.mjs` | `CONTROL_PLANE=PASS`，退出码 0 |
| `node scripts/ci/verify-boundaries.mjs` | `BOUNDARIES=PASS`，退出码 0 |
| `git diff --check` | PASS，退出码 0 |

TASK-037 Electron E2E 覆盖：

- 960×640、1440×900、2048×1152 的 Now Playing 封面/歌词几何、无水平溢出和可视区域；
- 真实队列名称、艺人、专辑与未来歌曲数量；
- 120 首歌单完整播放队列及第 120 首可见；
- 收藏第二页加载后第一首仍存在；
- 加入队列不进入 Now Playing、不重置当前播放；
- 账户资料不可用、登录过期清理、Sidebar、窗口恢复、退出清理和 axe serious/critical gate；
- 应用名称为 `Music Bridge for Roon`，Inspector Escape 关闭并恢复焦点。

## 明确未实现与 Owner 验收

本任务没有实现也没有伪装以下能力：Pause、Seek、Gapless、Shuffle、Repeat、队列拖拽排序、删除队列项、音量控制、Roon 本地曲库匹配、V2、Provider 升级、CI/GitHub/TASK-036 修改、端口/loopback/sandbox 改动。

技术验证通过不等同于真实设备验收。以下保持 Owner-only carryover：

- Core Mac 正式部署与真实 Roon Zone；
- 真实 Provider/账号登录、真实歌曲连续播放和实际 Signal Path 音质确认；
- 真实 Roon Time/自然结束回调在 Owner 设备上的验收；
- 发布、push、PR、合并和下一编号任务放行。

结论：**TASK-037 本地实现与自动化 Gate PASS；未 push，等待 Owner 按独立边界进行真实设备验收和后续 Git 操作授权。**
