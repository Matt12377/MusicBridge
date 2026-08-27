# TASK-045 结果报告：Cross-source LyricsCoordinator 与来源合同

## 身份

- 分支：`codex/task-045-cross-source-lyrics-coordinator`
- 基线：`3185b381b261a61458df6696ac69c1dfad32d963`（TASK-044 最终 HEAD）
- 实现提交：`f2d6b3eba57deabdca51fef69ab415f25c44deb6`（`feat(lyrics): coordinate cross-source local lyrics`）
- PR：待创建，base=`codex/task-044-local-lyrics-resolver`，保持未合并

## 实现

- 新增内部 `LyricsRequestContext`，不再把任意 `currentTrack.id` 当作 NetEase ID：直接 NetEase 使用队列逻辑 ID，Smart→Roon 使用稳定本地签名与原 NetEase trusted link，直接 Roon 只使用稳定签名。
- 无法安全生成签名的 Roon 曲目明确进入 `unavailable`，不调用 search、`lyric_new` 或持久仓库；Roon runtime ID 不进入歌词端口或永久记录。
- `LyricsCoordinator` 的缓存键改为歌词身份；只长期缓存本地 `ready/instrumental` 结果，未确认/无歌词仍受 Resolver 30 秒负缓存约束，可在后续播放重新解析。
- `LyricsMatchResolver` 由 Runtime 注入 Coordinator；解析与歌词下载异步执行，不等待、不停止也不修改音频播放。
- playback generation、signature cache key 与 Coordinator generation 共同阻止快速切歌、stop、Zone 切换或 shutdown 后的旧结果覆盖新曲目。
- pause/pausing/resuming 保持冻结；真实 `playing` 后重新锚定；seek 后使用已确认 Roon position；active line 立即推送，逐字仍保持 100ms 专用节流。
- `LyricsSnapshot.source?: 'netease'` 只允许出现在 `ready/instrumental`，公开合同继续拒绝 confidence、evidence 和 Provider 原始响应。
- `TrackSummary.version` 只透传明确来源字段；Roon descriptor → Public Library → Controller 保留 version，歌词候选映射也保留该字段，不从标题猜测。
- Electron Main 将已准备的 `userData/data` 作为受控环境值注入 Utility Core；持久仓库显式落在该目录，Runtime 默认不再用 `process.cwd()` 推断永久位置。
- Synthetic Runtime 输出同一来源合同；Renderer、公开 PlaybackSnapshot 与音频控制合同未获得签名、运行期引用或匹配工程字段。

## TDD 与 Gate

- RED 覆盖：跨源上下文缺失、来源合同拒绝、Main 数据目录未注入、无法签名时误走 NetEase、未确认结果被长期缓存。
- Lyrics/Coordinator focused：27/27。
- Contracts 全量：26/26；Main environment focused：10/10；Roon Public Library focused：14/14。
- bridge-core 全量：392/392；desktop 全量：161/161。
- workspace `verify` PASS；contracts/Core/Desktop typecheck、test、build 全部 PASS。
- control-plane、boundaries、cycles（97 files）PASS；`git diff --check` PASS。
- Electron startup/crash/safeStorage/credential recovery：4/4。
- Playwright synthetic E2E：19/19；axe critical/serious = 0。

规格审查先确认三类歌词身份、时间轴权威、来源字段与无播放 mutation。代码质量审查随后收紧了 Main 数据目录注入、无法签名 fail-closed、来源状态约束和本地 negative-cache 边界。一次手工循环依赖命令误用了不存在的 `verify-import-cycles.mjs`，不计入 Gate；随后执行仓库正式入口 `verify-cycles.mjs` 并通过。

所有自动测试均使用 synthetic Provider/Roon；本任务没有连接真实账号或真实 Roon，也不声称 Owner 验收。

## 结论

**TASK-045 本地自动 Gate 通过；待创建堆叠 PR，保持未合并。下一步 TASK-046 增加来源提示与受控 MANUAL 选择/撤销 UI。**
