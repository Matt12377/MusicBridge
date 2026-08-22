# TASK-034 结果报告：每日推荐与账户 Settings

## 任务身份

- 任务：TASK-034 — Daily Recommendations & Account Settings
- 前置 v4 远端基线：`b8ae08d40336a2eb32c63ec0bf593f12a778aa20`
- 工作分支：`codex/task-034-daily-recommendations-settings`
- 实现提交：`e7d6b0835792b8bc680c54cbc62a5577b97f2f1f`
- 实现提交信息：`feat: add daily recommendations and account settings`
- 报告提交信息：`docs: record TASK-034 verification`
- v5 分支：未推送、未创建 PR、未合并、未发布 release

## 实现摘要

- 固定使用 Provider `@neteasecloudmusicapienhanced/api` 4.40.1；只接入 `user_account` 与 `recommend_songs({ cookie, afresh: false })`，未升级 Provider，也未实现 `recommend_resource`、`recommend_songs_dislike` 或第三方推荐源。
- 新增 `PublicAccountProfile`、`PublicAccountState`、`DailyRecommendationTrack`、`DailyRecommendationsSnapshot`，并接通 `account.getState`、`account.refresh`、`account.changed`、`library.dailyRecommendations` 的 typed IPC、Main、Preload 与 Renderer 白名单。
- Core 增加账户公开资料与每日推荐的内存缓存、credential generation guard、同日缓存、失败 30 秒抑制、登录过期/退出登录清理；Profile 暂时不可用不会误删有效会话。
- Provider wrapper contract test 先固定 4.40.1 的实际 `recommend_songs` 请求形状，再完成每日推荐解析；解析对推荐理由、重复歌曲、malformed track、50 首上限和网易云图片白名单做了限制。
- Home 新增一行响应式每日推荐封面，覆盖 4/5/6/7/8 列；支持播放一首、替换队列播放全部、查看连续歌曲表、加载/空态/错误/未登录态。
- Sidebar 底部新增固定 Account Footer；Settings 新增账户 Hero、资料 Retry、扫码登录/过期态、退出登录、播放质量、Zone、应用信息与 Diagnostics 入口；Toolbar Popover 只保留 Core/Roon/Provider/Zone/Diagnostics 状态职责。
- 视觉沿用 v4 Apple Liquid Glass：中性石墨背景 `#0E1217`、Apple Cyan `#64D2FF`，音乐内容保持连续内容层，截图只使用 synthetic 头像、昵称、封面和歌曲。

## 自动验证

| 命令/检查 | 结果 |
|---|---|
| `corepack pnpm@10.17.1 verify` | PASS，退出码 0；Contracts 19/19、Bridge Core 167/167、Desktop 57/57；三包 typecheck 与 production build 通过 |
| `corepack pnpm@10.17.1 --filter @music-bridge/desktop run test:e2e` | PASS，Playwright 8/8，退出码 0；含每日推荐播放一首/全部、队列替换、4/5/6/7/8 列、资料不可用但仍授权、登录过期、退出登录清理和 axe gate |
| `node scripts/ci/verify-control-plane.mjs` | PASS |
| `node scripts/ci/verify-boundaries.mjs` | PASS |
| `git diff --check` | PASS，退出码 0 |

## Synthetic 截图 Gate

以下截图均由 `MUSIC_BRIDGE_UI_E2E=1` 生成，只包含 synthetic 数据，未提交到 Git：

- Home：`/var/folders/_n/tl8_8vzx5ng2xr633gkh0cn80000gn/T/musicbridge-task-034-home.png`
- 每日推荐详情：`/var/folders/_n/tl8_8vzx5ng2xr633gkh0cn80000gn/T/musicbridge-task-034-daily.png`
- Settings：`/var/folders/_n/tl8_8vzx5ng2xr633gkh0cn80000gn/T/musicbridge-task-034-settings.png`

截图覆盖 Home 每日推荐封面主体、连续歌曲表、Sidebar Account Footer、账户 Hero、播放设置和应用信息。没有真实头像、昵称、推荐歌曲、Cookie、Provider 原始响应或 Roon 标识进入截图或报告。

## 安全与边界

- Renderer 只收到公开账户资料和标准歌曲摘要，不接触 Cookie、safeStorage、userId、Provider raw response、完整 Provider 调试字段、targetUrl 或内部 Zone ID。
- `avatarUrl` 与歌曲封面都经过网易云图片域名白名单；昵称与推荐理由分别限制为 80/120 Unicode 字符。
- 未新增通用 IPC channel；Core、Stream Gateway、Roon、端口、loopback-only、safeStorage 文件格式和现有播放语义未改变。
- CI 与 synthetic E2E 不连接真实 Provider、真实账号或真实 Roon；测试日志和诊断导出保持脱敏。

## Core Mac Owner-only Gate

本次未执行 Core Mac 部署和 Owner 实机操作。以下布尔值按规范保留为 `false`，不表示真实设备失败，而表示 Owner-only Gate 尚未运行：

```text
profileDisplayed=false
dailyRecommendationsLoaded=false
singleRecommendationPlayed=false
recommendationQueueStarted=false
restartRecovered=false
logoutCleared=false
```

## 结论

**PASS WITH OWNER-ONLY CARRYOVER**

TASK-034 的 contracts、Core、typed IPC、Renderer、synthetic E2E、边界扫描和三张视觉截图 Gate 已通过。真实网易云账户、Core Mac 部署、真实播放、重启恢复和 Owner 验收仍保持为独立的 Owner-only Gate；本分支当前未推送。
