# TASK-044：异步 NetEase Lyrics Resolver

## 目标

接入受控 NetEase 搜索和 `lyric_new`，实现不阻塞 Roon 播放、可复用可信 NetEase 身份、按候选簇确认并防止旧请求覆盖的 LyricsMatchResolver。

## 基线与分支

- 基线：TASK-043 合并后的最新 `main`。
- 分支：`codex/task-044-local-lyrics-resolver`。

## 允许范围

- `packages/bridge-core/src/lyrics-matching/resolver.ts`
- `packages/bridge-core/src/lyrics-matching/candidate-cluster.ts`
- 必要的 NetEase 只读搜索/歌词端口与解析适配
- Resolver 内存 cache、generation 和有界预取协调器
- 对应 bridge-core tests
- 本任务结果报告和 `project/STATUS.json`

不得修改 Renderer；不得让 Resolver 调用任何播放、Zone 或 Queue mutation。

## RED

至少覆盖：

- trusted NetEase ID 生成独立 LyricsMatch 并跳过搜索；
- repository 的 MANUAL 优先于自动记录，合法 CONFIRMED 可复用；
- 搜索最多两轮、每轮最多 20 条，候选按 ID 去重；
- album 不同的同录音候选可确认；
- 五轴冲突不调用 `lyric_new`；
- `POSSIBLE/AMBIGUOUS/REJECTED/NONE` 不加载或返回候选歌词；
- 已确认 NetEase Track 无歌词时返回 unavailable，但不影响映射；
- 网络失败、Provider 未配置、登录过期不传播到播放控制；
- 快速切歌后旧搜索、旧歌词和旧候选会话不能覆盖 active 结果；
- 相同 signature 的并发请求去重；
- active request 上限 1，预取并发上限 2，只预取后续 2 首；
- 仓库写入失败不阻断已经开始的 Roon 音频，且公开错误有界。

## GREEN

- Resolver 输入是 LocalTrackSignature 或 trusted NetEase link，不接 Roon runtime reference。
- Provider 调用仅使用固定 SDK search、song detail/metadata 和 `lyric_new`。
- 自动确认后才调用歌词加载；候选列表和歌词正文不写日志。
- stale guard 同时绑定 playback generation、signature key 和 resolver generation。
- 临时失败只进入短 TTL 内存缓存；正向确认才进入持久仓库。
- 取消可以是逻辑取消；即使底层 Provider 不支持 AbortSignal，完成结果也必须被 generation 丢弃。

## Gate

- focused RED/GREEN 与 deterministic fake clock；
- bridge-core typecheck/test；
- Provider wrapper contract 与 boundaries；
- `git diff --check`；
- CI 不连接真实 Provider。

实现提交：`feat(lyrics): resolve local tracks against NetEase`。

报告：`reports/TASK-044_RESULT.md`。
