# Roon 原生播放确认等待修复（2026-09-19）

## 身份与范围

- 工作树：`/Volumes/LifeWeave/VSCode/MusicBridge/worktree/v3-ui`。
- 分支：`codex/unified-search`；base HEAD：`c9f8cec4e0a9774035862406f822fd7401016cec`。
- 实现提交、报告提交：均未创建；保留既有未提交工作，未暂存、提交或推送。
- 分支未配置 upstream；未查询远端 HEAD。本轮不是远端交付或新 WAVE 任务关闭。
- 用户反馈：跨专辑点击播放全部后，实际声音已经切到新专辑，但界面仍等待或报 `ROON_TIMEOUT`。

## 原因与实现

旧链路先等待 Library Browse 播放回执，再启动 Transport 播放状态确认。回执迟到时，即使目标曲目已出声，界面也继续等待；早到的目标状态还可能被后续快照覆盖。受控测试复现了这条能够导致反馈现象的路径，尚无现场跟踪证据证明它是所有超时的唯一原因。

- 增加 `runConfirmedTrackAction`，在身份校验和动作选择完成、最终播放命令派发前注册 Transport 确认，并读取最新 revision。
- 有效目标播放事件先到即可完成，不必等待 Browse 回执；迟到回执错误不覆盖已确认的成功。
- Browse 接受命令不等于实际播放成功；旧 revision、其他设备、其他曲目及暂停事件仍不能冒充成功。
- 导航失败立即返回；派发后的确认仍有原有超时上限。没有延长 timeout，也没有改变 stop 策略。
- 内部日志记录安全阶段耗时与随机请求关联标识，不包含曲名、设备标识、Roon session 或凭据。桌面 Core 的日志不保证显示在 VSCode 终端。
- 确认超时的公开错误增加经过数值校验的准备/确认耗时，并提示实际声音可能已经切换、不要连续重复点击。准备耗时从进入本轮协调器开始，不包括更早的 Renderer 分页收集与 stop。

## 验证

全部串行执行，测试并发为 1；Node 22.23.2，pnpm 10.17.1。临时目录、构建日志和隔离 UI 产物位于外置 LifeWeave 卷。

| 检查 | 结果 | 退出码 |
| --- | --- | --- |
| 等价旧串行等待基线 | 4 项中 2 项按预期失败，捕获回执阻塞与迟到错误覆盖 | 1（预期 RED） |
| 确认协调器、Library、Public Library、Adapter、Controller、Utility IPC 相关测试 | 234/234 通过 | 0 |
| Core 与 Desktop 类型检查 | 通过 | 0 |
| Core 构建与 Desktop 生产构建 | 通过 | 0 |
| 隔离 Electron：六项可用性修复、Roon 自动续播界面更新 | 2/2 通过 | 0 |
| Control Plane 与 Boundaries | 通过 | 0 |
| `git diff --check` | 通过 | 0 |

日志根：`/Volumes/LifeWeave/Developer/CommandLine/tmp/`。

- `mb-play-confirm-red.log`
- `mb-play-confirm-tests.log`
- `mb-play-confirm-types.log`
- `mb-play-confirm-core-build.log`
- `mb-play-confirm-desktop-build.log`
- `mb-play-confirm-ui.log`；UI 结果目录 `mb-play-confirm-ui/`

确认时序测试使用合成 Transport/Browse，不是真实 Roon；Electron 用例使用隔离合成 IPC，只证明相关 UI 回归未被破坏。本轮未执行全量回归或真实设备 Gate。

## 交付边界与后续

代码和构建完成；真实用户实例未重启、未切歌，Owner 验收仍待完成。后端改动需要重启开发进程，单独刷新 Renderer 不足以生效。若仍出现确认超时，新的公开错误可提供分段耗时继续定位。

上一轮搜索页面保留规则、六项可用性修复及原生队列跟随的未提交改动全部保留，历史真实设备/发布 carryover 未关闭。没有创建下一分支；后续仍以当前 HEAD 加保留的工作区为上下文，不能把该脏工作区当成已提交基线。
