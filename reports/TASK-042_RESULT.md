# TASK-042 结果报告：LyricsMatch 领域模型与版本冲突

## 任务身份

- 任务：TASK-042 — LyricsMatch 领域模型与版本冲突
- 工作分支：`codex/task-042-local-lyrics-match-domain`
- 工作树：`/Users/yihe/VSCode/MusicBridge/worktree/task-042-local-lyrics-match-domain`
- 直接基线：`d65d4e73250ead0e221a80b1296f0c3fa581e95d`（设计 PR #7 HEAD）
- 基线中的最新 `main` 祖先：`207f7f04bc11fd4dcf7e6214ab705e999ee6f559`
- 实现提交：`cc3b02eba2325984ab8be784411909e4ec7e6d83`
- 实现提交信息：`feat(lyrics): add independent lyrics match domain`
- PR：[#8](https://github.com/Matt12377/MusicBridge/pull/8)，base=`codex/local-netease-lyrics-design`，状态 Open
- 集成策略：按 Owner 指令，设计 PR 和功能 PR 暂不合并；全部 Slice 与 Owner 整体验收通过后再决定合并。

TASK-042 原任务文件描述“设计提交合并后的 main”为基线；Owner 随后明确要求设计 PR 不合并、直接创建工作树开发。因此本任务使用设计 PR 的精确 HEAD 作为堆叠基线，没有修改或移动 `main`。

## 实现摘要

- 新增独立 `LyricsMatchResult` 领域品牌，不能与 Playback `MatchResult` 互换。
- 冻结 `CONFIRMED | MANUAL | POSSIBLE | AMBIGUOUS | REJECTED | NONE` 六种状态和算法版本 `lyrics-match-v1`。
- 文本规范化只执行 NFKC、大小写、有限标点、空白和艺人拆分/去重，不引入编辑距离或机器学习依赖。
- 建立 performance、mix、vocal、authorship、release 五轴版本向量；Studio/Live、Original/Remix、Vocal/Instrumental、Original/Cover、Final/Demo 冲突在评分前硬拒绝。
- 英文和中文版本词均可从 title、album、version 字段识别；特殊版本与未标记的默认原版侧也会冲突。
- album mismatch 只失去 album 加分并留下有界 evidence，不直接拒绝。
- 候选按规范化 title、artist identity、版本向量和 3 秒时长容差聚类；同录音的原专辑、精选集和再版候选可进入同一簇。
- 输入最多处理 40 个去重候选，每簇最多公开 20 个成员，每级 evidence 最多 16 项；同分排序与输入顺序无关。
- 自动确认要求 title、artist、无版本冲突，并满足时长差不超过 3 秒，或时长缺失时 album 精确且只有一个安全录音簇。

## TDD 证据

### 首轮 RED

先建立只返回 `NONE` 的最小编译脚手架，避免把模块缺失或编译失败冒充 RED。focused 测试实际执行 16 项：2 项通过、14 项行为断言失败；首个失败为 `actual NONE / expected CONFIRMED`，版本冲突、聚类、歧义、证据不足和稳定排序也按预期失败。

### 边界补充 RED

首轮 GREEN 后补充 ADR 的无时长边界：27 项中仅“duration 缺失 + album 精确 + 唯一簇”失败，实际为 `POSSIBLE`、预期为 `CONFIRMED`。将确认阈值校正为 0.85 后该行为转绿；没有通过放宽版本冲突或 3 秒时长边界实现。

### 最终 GREEN

focused 测试最终为 28/28，覆盖：

- 唯一同录音确认；
- 五轴英文冲突；
- title、album、version 两侧字段位置；
- 现场、混音、纯音乐、翻唱、演示中文标记；
- 跨专辑同录音聚类；
- 多录音簇歧义；
- 稀疏证据 `POSSIBLE`；
- 3 秒包含边界与 3001ms 排除边界；
- 无时长、专辑精确的唯一簇；
- `NONE`、album penalty、稳定排序、有界输出和领域类型隔离。

## 本机验证

| 验证 | 结果 |
|---|---|
| focused `lyrics-match-domain.test.ts` | 28/28，exit 0 |
| bridge-core 全量测试 | 358/358，exit 0 |
| bridge-core typecheck | PASS，exit 0 |
| bridge-core production build | PASS，exit 0 |
| `verify-control-plane.mjs` | `CONTROL_PLANE=PASS` |
| `verify-boundaries.mjs` | `BOUNDARIES=PASS` |
| `verify-cycles.mjs` | `CYCLES=PASS files=93` |
| 精确暂存后的 `git diff --cached --check` | PASS，exit 0 |

## 两阶段审查

规格审查先执行并通过：改动只有任务允许的 5 个 `lyrics-matching` 源文件和 1 个测试文件；没有修改 Playback Matching、LyricsCoordinator、NetEaseClient、Contracts、Renderer、Electron Main、IPC 或持久化。

代码质量审查随后通过：输入、簇成员和 evidence 均有上限；Track ID 去重和同分排序确定性；版本硬拒绝不接受分数覆盖；结果不含歌词正文、Provider 响应、凭据、URL、Roon runtime reference、item_key 或媒体路径。未发现需要第二轮修复的规格或质量问题。

## PR 与 CI

实现 HEAD `cc3b02e` 的 verify、dependency-audit、static-security 均通过。push 触发的 macOS Electron Gate 19/19 通过。

PR 触发的首次 macOS Gate 在既有 Zone 加载态 E2E 中失败：测试在固定等待 100ms 后，5 秒内没有观察到“正在读取播放设备”；其余 18 项通过。该失败不涉及 TASK-042 文件，同一 SHA 的 push Gate 已通过。由于任务 allowlist 禁止修改 Renderer/E2E，本任务没有改变测试或提高超时，只保留失败证据并对该失败 job 执行一次重跑；重跑 19/19 通过。没有第二次重跑。

## 证据边界与 carryover

- TASK-042 是纯领域 Slice，不连接真实 Provider、真实 NetEase 账号或真实 Roon，也不构成跨源歌词真实播放验收。
- PR #8 保持 Open，未合并；设计 PR #7 也保持 Open。
- 自动测试、实现提交、远端 CI、真实设备验收和 Owner 最终接受分别记录，互不替代。
- 下一任务为 TASK-043：稳定 `LocalTrackSignature` 与有界正向仓库；其基线必须是 TASK-042 的最终报告/身份 HEAD，而不是 `main`。

## 结论

**TASK-042 自动与合成 Gate 通过，规格和代码质量审查通过；PR #8 保持未合并，等待后续 Slice 和 Owner 整体验收。**
