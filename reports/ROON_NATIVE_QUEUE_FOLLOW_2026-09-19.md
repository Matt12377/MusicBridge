# Roon 原生队列续播状态同步修复

## 身份与范围

- 工作树：`worktree/v3-ui`；分支：`codex/unified-search`。
- 基线 HEAD：`c9f8cec4e0a9774035862406f822fd7401016cec`。
- 实现提交、报告提交：未提交。保留已有搜索及其他未提交改动，未推送；远端尚无同名分支。下一次继续当前工作树，不能只用基线 SHA 重建。
- 本轮处理：从 MusicBridge 发起 Roon 本地播放后，Roon 自动续播时当前曲目未更新。

## 原因与实现

旧逻辑只在原生播放进入 stopped 时推进 MusicBridge 队列，而 Roon 可以持续保持 playing，只更新 now_playing。时间事件又严格绑定首曲，因此后续歌曲被当成不匹配事件过滤。

- 在现有 Roon 状态订阅链中读取所选 Zone 的当前播放观测；收到更新的 playing/paused 曲目信息时同步当前曲目、播放代次、进度和来源，发送已有 playback.changed 事件。
- 唯一匹配 MusicBridge 已知原生队列项时复用其曲目身份、队列位置和封面。队列外曲目只采用 Roon 当前元数据，使用临时内部数字身份，不伪造 Browse 引用，不沿用旧封面或音质。
- 队列外当前曲目不高亮旧队列项，保留原队列；不声称已导入 Roon 的完整队列。此时应用队列的上一首/下一首不可用，暂停、恢复、停止仍使用原生控制路径。
- 歌词上下文按新的本地曲目信息创建；没有可信网易云身份时，不把观测身份当网易云歌曲 ID。无可重播身份的观测曲目不加入主页最近播放入口。
- 校验 Zone、播放代次、状态与单调 revision；旧设备/旧观测和 loading 不改写当前曲目。原生停止回调绑定播放代次，避免连续播放已经进入新曲后又被旧 stopped 回调推进一次。
- 本轮跟随既有 Roon 播放，不向 Roon 重复发送切歌或重排其原生队列。

## 验证

Node 22.23.2；测试文件并发 1；类型检查、构建和 Electron 测试顺序执行。所有日志、临时目录和结果包位于已核验的外置 LifeWeave APFS 卷。

- 新增三项缺陷回归在修复前全部失败，覆盖无 stopped 续播、应用队列外续播及迟到 stopped 竞态。
- 最终相关测试：175 通过，0 失败；退出码 0。包括 controller、lyrics、local-lyrics-acceptance、roon-adapter。另覆盖同名不同艺人、暂停时曲目变化、旧 revision、其他 Zone、网易云不被接管及公开 IPC 快照校验。
- 首次扩展测试为 174 通过、1 失败，原因是合成旧封面引用不符合公开格式；修正夹具后通过，未放松生产校验。
- Core/桌面类型检查、Core 构建和桌面生产构建通过，退出码 0。首次类型检查发现新增测试可选字段缺少确定性标记，修正后通过。
- Electron E2E：2 通过，退出码 0。覆盖底栏和全屏播放页跟随连续曲目事件，以及原搜索、分页、播放队列和歌词交互。使用隔离合成数据和 mock keychain，不连接真实 Provider 或 Roon。
- control-plane、boundaries、git diff --check：通过，退出码 0。

日志根：`/Volumes/LifeWeave/Developer/CommandLine/tmp/`。

关键日志：`musicbridge-native-follow-red.log`、`musicbridge-native-follow-focused.log`、`musicbridge-native-follow-typecheck.log`、`musicbridge-native-follow-desktop-typecheck.log`、`musicbridge-native-follow-core-build.log`、`musicbridge-native-follow-desktop-build.log`、`musicbridge-native-follow-e2e.log`。

## 交付边界

没有操作用户真实播放，没有重启开发窗口、替换安装版或发布。需要重启开发版加载新 Core 和 Renderer。真实设备自然播完后续播、听感与 Owner 验收仍待验证；此前《逆光》播放复测待办独立保留。
