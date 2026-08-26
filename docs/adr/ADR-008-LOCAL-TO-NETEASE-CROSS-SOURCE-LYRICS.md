# ADR-008：Local-to-NetEase Cross-source Lyrics

## 状态

提议，等待 Owner 确认后按 TASK-042 至 TASK-047 线性实施。

设计基线：`main` `207f7f04bc11fd4dcf7e6214ab705e999ee6f559`。

## 背景

MusicBridge 已能播放 Roon 本地曲目，也已有 NetEase `lyric_new` 解析、歌词缓存、Roon Time 同步、Smart Matching 和混合队列。但当前歌词入口仍假设 `PlaybackSnapshot.currentTrack.id` 是 NetEase Track ID。直接播放 Roon 本地曲目时，这个 ID 实际由 Roon 运行期引用投影而来，既不能传给 NetEase，也不能作为永久身份保存。

现有 Smart Matching 的方向是 `NetEase Track → Roon Track`，目的是选择音频来源。新需求的方向是 `Roon Local Track → NetEase Track`，目的只是在音频仍由 Roon 播放时取得同一录音的歌词。两者的风险、生命周期、候选类型和确认语义不同，不能共享同一个 MatchResult。

## 产品不变量

- 音频来源始终是 Roon；歌词来源可以是 NetEase。
- 播放先开始，歌词解析异步执行，任何匹配或网络失败都不能停止、暂停、重启或切换音频。
- Roon Transport 是 position、pause、resume、seek 和曲目切换的唯一时间轴权威。
- 不读取媒体路径，不扫描本地文件，不寻找旁路 LRC，不预扫描整个本地曲库。
- 只有 `CONFIRMED` 或用户 `MANUAL` 确认的 LyricsMatch 可以自动加载歌词。
- `POSSIBLE`、`AMBIGUOUS`、`REJECTED` 和 `NONE` 不得显示候选歌词。
- 公开 UI 只显示“歌词来源：网易云”，不显示分数、阈值、证据或工程置信度。
- 永久记录不得包含 Roon runtime reference、item_key、媒体路径、Provider 凭据、上游 URL 或歌词正文。

## 决策

### 1. 建立独立 LyricsMatch 领域

新增内部领域包 `packages/bridge-core/src/lyrics-matching/`。它不复用 Playback `MatchResult`，只允许复用无状态的文本规范化思想。

`LyricsMatchState` 固定为：

- `CONFIRMED`：算法确认唯一同录音候选，可自动加载。
- `MANUAL`：用户明确选择，可自动加载，优先级高于自动结果。
- `POSSIBLE`：存在相关候选，但证据不足。
- `AMBIGUOUS`：存在两个或更多无法安全区分的录音簇。
- `REJECTED`：搜索结果存在，但全部触发版本硬冲突。
- `NONE`：没有可用候选。

内部结果可以携带有界 score、evidence 和候选簇；公开合同不得暴露这些工程字段。Playback Match 只能提供一个“可信 NetEase 身份事实”，由 LyricsMatch 重新生成独立 `CONFIRMED` 结果，不能把 Playback Match 对象强制转换成 LyricsMatch。

### 2. 使用稳定 LocalTrackSignature，而不是运行期 ID

`LocalTrackSignature` 由以下规范化字段组成：

- title；
- artists；
- album；
- durationMs；
- version。

签名键是上述有界字段的 canonical JSON 经 SHA-256 得到的 128-bit 十六进制摘要。title 与 artist 必填；artists 在规范化、去重后按稳定顺序排列；duration 量化到最接近的 1 秒，避免同一 Roon 时长在 Browse/Transport 边界上的毫秒舍入差异。album、duration 和 version 缺失时保留显式空值，不能用 Roon runtime reference 补位。`TrackSummary` 后续增加可选 `version`，Roon 只透传 Browse 明确提供的值。

规范化只做 NFKC、大小写、空白和有限标点处理；不会删除语义版本词。签名在每个 playback generation 的本地曲目确认完成后冻结，后续 position 或展示字段变化不得在同一播放中重建身份。持久仓库保存 canonical signature、signature key、NetEase Track ID、确认来源、算法版本和有界时间戳，不保存路径或歌词。

### 3. 明确歌词身份上下文

LyricsCoordinator 不再把任意 `currentTrack.id` 当成 NetEase ID，而是先构造内部 `LyricsRequestContext`：

- NetEase 音频：直接使用队列中的 NetEase Track ID。
- Smart 播放且音频解析为 Roon：队列仍保留原始 NetEase 逻辑身份，生成独立的 trusted-link LyricsMatch 后直接使用该 ID。
- 直接 Roon 本地播放：从当前 TrackSummary 生成 LocalTrackSignature，再进入 LyricsMatchResolver。

直接 Roon 曲目的识别依据是当前队列项 `preferredSource === 'roon'`；不能仅依据 `source === 'roon'`，因为 Smart 播放也可能使用 Roon 音频。

### 4. 版本轴必须硬拒绝

领域模型使用五个独立版本轴：

| 版本轴 | 对立值 |
|---|---|
| performance | studio / live |
| mix | original / remix |
| vocal | vocal / instrumental |
| authorship | original / cover |
| release | final / demo |

英文和中文明确标记均参与判断，例如 `Live/现场`、`Remix/混音`、`Instrumental/纯音乐/伴奏`、`Cover/翻唱`、`Demo/演示`。一侧有明确非默认版本而另一侧没有同轴标记，按默认原版侧与特殊版本冲突处理；两个明确不同值也硬拒绝。硬拒绝发生在评分之前，不能被 title、artist、album 或 duration 加分抵消。

Acoustic、karaoke 等未进入产品硬拒绝清单的词第一版只作为降分证据，不扩展为新的产品规则。

### 5. Album 只降分，候选按录音聚类

NetEase 搜索最多执行两个有界查询，每次最多 20 条：

1. `title + primary artist`；
2. 第一轮没有可确认结果时，补充 `title + primary artist + album`。

候选先按 NetEase Track ID 去重，再按 normalized title、artist identity、五轴版本向量和 duration tolerance 聚成“录音簇”。同一录音出现在原专辑、精选集或再版专辑时属于同一候选簇，album 不同只减分。不同版本或时长明显不同的候选不得合簇。

自动 `CONFIRMED` 至少要求：

- normalized title 一致；
- artist 有明确交集；
- 五个版本轴无冲突；
- duration 差不超过 3 秒，或 duration 缺失时 album 一致且只有一个候选簇；
- 只有一个达到确认门槛的录音簇，且与次高簇有安全 margin。

多个达到门槛的录音簇为 `AMBIGUOUS`；单一候选但证据不足为 `POSSIBLE`；所有相关候选均版本冲突为 `REJECTED`。阈值和算法版本由 Slice A 测试冻结，后续改变必须提升 `algorithmVersion`。

### 6. 有界持久化只保存正向确认

持久仓库只保存 `CONFIRMED` 和 `MANUAL` 的 `LocalTrackSignature → NetEase Track ID` 映射；`NONE`、`REJECTED`、网络错误和临时候选只进入短时内存缓存。

- schema version：1；
- 最大记录数：4096；
- LRU 更新 `lastUsedAt`，超限淘汰最久未使用记录；
- 自动确认记录绑定 `algorithmVersion`，版本变化时重新解析；
- MANUAL 记录在用户撤销前有效，但仍受全局容量上限；
- 严格校验、串行 mutation、临时文件 + 原子 rename、目录 0700、文件 0600；
- 文件损坏时 fail closed，不静默覆盖。

正式路径由 Electron Main 的 `userData/data` 注入 Core；不得继续依赖 `process.cwd()` 作为永久数据位置。测试通过依赖注入使用临时路径。

### 7. Resolver 异步、可失效且不影响播放

`LyricsMatchResolver` 接收 LocalTrackSignature、可选 trusted NetEase ID、搜索端口、歌词可用性端口和仓库端口。

解析顺序：

1. trusted NetEase link；
2. MANUAL/有效 CONFIRMED 仓库记录；
3. 有界 NetEase 搜索、硬拒绝、评分和聚类；
4. 仅对最终确认簇检查/获取歌词；
5. 写入正向确认记录并返回。

播放触发的解析只允许一个 active request；队列预取最多并发 2 个且只预取接下来 2 首直接 Roon 曲目。每个请求绑定 playback generation 和 signature key。曲目切换、stop、Zone 切换或 shutdown 后，旧网络请求即使完成也不得写入 active lyrics；已得到的安全正向映射可以进入仓库，但必须先通过其自身签名校验。

Provider 未配置、登录过期、网络断开、搜索失败、无歌词或 API 不可用只改变歌词状态，不调用任何播放控制方法。

### 8. LyricsCoordinator 继续以 Roon Transport 为权威

LyricsCoordinator 拆成“身份解析/歌词加载”和“时间轴推进”两个职责，但保留单一公开 LyricsSnapshot 流。

- pause/pausing/resuming：冻结推进；
- resume：只有 Controller 收到真实 Roon `playing` 后才重新锚定；
- seek：使用 Controller 确认后的 Roon `positionMs` 立即重算 activeLine；
- activeLine 变化立即推送；逐字变化维持当前 100ms 专用节流，不进入通用 250ms playback snapshot 节流；
- generation 同时包含 playback generation、signature key 和 lyrics request generation。

当前 `LyricsSnapshot` 增加可选 `source: 'netease'`。只有成功取得 NetEase ready/instrumental 歌词时设置；不增加 confidence、match state 或 NetEase 原始响应。

### 9. MANUAL UI 使用临时候选会话

Renderer 不提交 LocalTrackSignature，也不能自行搜索 NetEase。Core 为当前播放曲目生成短期 `matchSessionId`，公开候选只包含：NetEase Track ID、title、artists、album 和可选 durationMs。

新增受控动作：

- 读取当前歌词匹配状态与候选；
- 选择当前 session 内的一个候选；
- 撤销当前 LocalTrackSignature 的 MANUAL/CONFIRMED 记录并重新解析。

选择动作必须同时校验 session、当前 playback generation 和候选 membership。UI 不显示 score、evidence、margin 或 algorithmVersion。第一版 UI 只在当前直接 Roon 曲目未自动取得歌词时提供“选择歌词版本”；播放本身永远不等待该界面。

### 10. 安全与版权边界不变

- 仍只使用固定 Provider SDK 的 search、song detail 和 `lyric_new` 能力；不下载、缓存、代理或替换音频。
- 歌词正文只保存在现有有界内存 LyricsSnapshot/LRU，不写入持久仓库、诊断、日志或报告。
- CI 只使用 synthetic Provider/Roon，不连接真实账号或真实 Roon。
- 不记录搜索原文、歌词正文、NetEase Cookie 或 Roon item_key；诊断只记录有界状态、耗时区间和结果枚举。

## 切片与依赖

| Slice | Task | 内容 | 禁止提前实现 |
|---|---|---|---|
| A | TASK-042 | LyricsMatch 领域、版本轴、评分聚类 | IPC、磁盘、网络、UI |
| B | TASK-043 | LocalTrackSignature、正向仓库 | Resolver、Coordinator、UI |
| C | TASK-044 | 异步 Resolver、NetEase 搜索、竞态 | Renderer UI |
| D | TASK-045 | LyricsCoordinator、来源合同、Roon 时间轴 | MANUAL UI |
| E | TASK-046 | 来源提示、MANUAL 选择与撤销 | 真实验收结论 |
| F | TASK-047 | Synthetic E2E、真实 Roon + NetEase 验收 | 新功能扩展 |

每个 Task 从前一 Task 的已合并 `main` 创建独立分支；自动测试、提交、PR/CI、真实 Roon/NetEase 和 Owner 验收分别记录。

## 验收矩阵

| 样本 | 预期 |
|---|---|
| 本地 Track 有唯一 NetEase 同版本且有歌词 | 音频立即播放，异步显示歌词与“歌词来源：网易云” |
| Studio / Live 冲突 | `REJECTED`，不显示候选歌词 |
| Original / Remix 冲突 | `REJECTED` |
| Vocal / Instrumental 冲突 | `REJECTED` |
| Original / Cover 冲突 | `REJECTED` |
| Final / Demo 冲突 | `REJECTED` |
| 同一录音位于不同专辑/精选集 | 可聚成同一录音簇并确认 |
| 多个相似版本 | `AMBIGUOUS`，不自动选择 |
| NetEase Track 无歌词 | 播放不受影响，歌词 unavailable |
| 网络断开/Provider 不可用 | 播放不受影响，歌词 error/unavailable |
| Pause / Resume | pause 冻结；真实 playing 后重新锚定 |
| Seek | Roon position 确认后立即更新 activeLine |
| 快速切歌 | 旧结果不得覆盖新曲目 |
| 重复播放同一本地 Track | 使用稳定正向记录，不重新全量搜索 |
| MANUAL 选择后重播 | 使用 MANUAL 记录；UI 不显示工程置信度 |
| MANUAL 撤销 | 删除记录并重新进入自动解析 |
| `归零` 等真实本地样本 | 真实 Roon 音频保持，NetEase 歌词与 Roon 时间轴同步 |

## 后果

- 现有 Playback Smart Matching 保持不变，新 LyricsMatch 不会反向影响音频来源。
- 需要为直接 Roon Track 保留 version 元数据，并为 LyricsCoordinator 提供可靠的队列来源上下文。
- 需要新增一个由 Main 注入的持久仓库路径和少量受控 IPC，但不会把 Roon runtime reference 或本地路径暴露给 Renderer。
- 第一版若延期 TASK-046，TASK-042 至 TASK-045 仍可提供只自动确认的可靠能力；`POSSIBLE/AMBIGUOUS` 继续不显示歌词。

## 否决方案

- 直接把 Roon runtime Track ID 当 NetEase ID：身份错误且重连不稳定。
- 直接复用 Playback Match：方向、候选实体和安全语义不一致。
- 模糊匹配后取第一条：会在 Live、Cover、Remix 和同名版本上显示错误歌词。
- 在播放前等待搜索：会把网络与 Provider 故障升级为播放故障。
- 扫描媒体路径或旁路 LRC：超出产品、安全和隐私边界。
