# 播放栏进度与音量交互修复 — 2026-09-05

## 原因与结果

原进度组件在快照回调中重设计时锚点，250ms 步进与 1000ms 滑块刻度共同产生阶梯运动，量化或重复的设备读数可把本地已前进的位置拉回。松手提交后还立即恢复旧锚点。现显示使用独立时钟和动画帧，重复读数不重设；小偏差通过最多 ±20% 的速度校准，明确跳转重新定位。拖动期间保留预览，seek 通过 App 返回确认或失败；切歌/切 Zone 废弃旧确认，短期屏蔽 seek 之前的旧位置。

原音量只在 change（松手）发送，pending 时禁用滑块，随后把可能尚未更新的设备读数重新绑定，造成闪回。现 input 即时反馈并发送，80ms 窗口合并最新目标、最多一个在途请求；每个输出有独立状态。旧回报只更新观测，不抢占拖动/待确认草稿；确认后交回设备读数。失败或 8 秒未得到匹配观测会恢复设备读数并提示。切换设备取消待发目标，分组输出仍分别控制；没有改系统音量。

底部进度区域最大 480px，整体在窗口底部居中，保留两侧时长。网易云共用歌曲列表和队列暂时移除歌曲音质行，保留艺术家/专辑；Roon 专用列表和当前播放栏的真实音质保留。

## 身份与验证

- 工作树 `worktree/v3-ui`，分支 `codex/v3-ui-redesign`。
- Base `c10ff4bb3d2761934ee7cc44eb8a03162125a911`。
- 实现 `4419fcc0db5050c04d7cf5bfa1fce05f7aaa072c`。
- 报告提交用 `git log -1 --format=%H -- reports/V3_PLAYER_MOTION_REPAIR.md` 解析；下一轮从报告 HEAD 开始。
- RED：新增 player-motion 测试，模块缺失时 exit 1；实现后测试通过。
- 47 项定向测试 exit 0：player-motion、player-details、volume-ipc、renderer、playback-acceptance、virtualWindow。
- 覆盖重复/量化快照、连续帧、不受轮询影响的拖动、seek 失败与旧确认、音量在途合并、旧回报、失败、超时、销毁后取消待发请求。
- desktop typecheck、生产 build、control-plane、boundaries 均 exit 0。
- Electron Gate exit 0：浅深色、1980/1440/720 宽度的居中 480px 进度条；列表不再显示音质行；111 帧进度样本无倒退，前进 1815ms；seek 确认 65000ms；仅 input 尚未 change 时模拟设备已更新到 39，释放后继续回读无闪回。设置入口可点击且控件无重叠。
- 看过最终 Electron 音量弹层/短进度条截图。证据 `/Volumes/LifeWeave/Developer/CommandLine/tmp/musicbridge-motion-ui/`，日志同一外置临时根 `musicbridge-motion-*.log`。
- 验证使用隔离合成数据；未操作真实设备音量、未做真实听感确认。未全量测试、未 push/merge/release。用户正在运行的实例没有被重启，重启 UI 开发版加载本次构建。
