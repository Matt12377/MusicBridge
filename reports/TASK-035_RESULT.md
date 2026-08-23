# TASK-035 结果报告：Remote Core Development Mode

## 任务身份

- 任务：TASK-035 — Remote Core Development Mode
- 基线 SHA：`2a5de19e37d3765c64185e786176e211c57425c2`
- 工作分支：`codex/task-035-remote-core-development`
- 实现提交：`014ed21`（`feat: add remote Core development mode`）
- 报告提交信息：`docs: record TASK-035 verification`
- 未创建 PR、未合并、未 force-push、未发布 release

## 实现摘要

- 新增 `RemoteCoreTunnelManager`，只通过 `/usr/bin/ssh`、`shell: false`、固定参数和 `BatchMode=yes` 建立回环反向隧道；目标仅接受安全的 `user@host` 或 SSH alias 形式。
- 远程端口只允许 `38512`—`38519` 八个候选值；仅在 SSH 明确报告远程 forward 绑定失败时顺序尝试，认证失败、SSH 不可用和健康检查失败均确定性停止。
- 远程就绪必须经过 SSH 子进程存活、Core 重启完成、受控健康响应和公开流基址确认；健康响应只有 `ok: true` 与 `mode: remote-core-development`。
- Core 的正式 `local-core` 默认仍使用 `38501/38502` 和正式 Roon Extension；远程模式只由 Main 显式注入固定 loopback 环境，并使用独立开发 Extension ID `com.musicbridgeforroon.netease.dev`、独立 Settings key 和开发显示名。
- Stream Gateway 在远程模式提供受控健康端点，并把 Roon icon/stream 公共基址切换到选定的远程 loopback 端口；未开启远程模式时不暴露该端点。
- Main 增加受信 Renderer 才可调用的 `get/start/stop/reconnect` typed Preload API；Renderer 不接收或构造 SSH 参数，生产构建拒绝 Remote Core IPC，开发 Settings 默认关闭自动连接。
- 隧道断开时调用既有 `playback.stop`，清理 Roon session、stream registry 和播放状态；自动重连最多一次，不自动恢复歌曲；应用退出时先停止隧道再关闭 Core。
- Provider 版本保持 `@neteasecloudmusicapienhanced/api` `4.40.1`，未改 Provider、V2、正式同机模式或播放语义。

## 自动验证

| 命令/检查 | 结果 |
|---|---|
| `corepack pnpm@10.17.1 verify` | PASS，退出码 0；Contracts 19/19、Bridge Core 174/174、Desktop 68/68，三包 typecheck 与 production build 通过 |
| `corepack pnpm@10.17.1 --filter @music-bridge/desktop run test:e2e` | PASS，Playwright 8/8，退出码 0；覆盖开发 Settings、账号/每日推荐、连续歌曲表、全屏播放、队列、侧栏和 axe gate |
| `corepack pnpm@10.17.1 --filter @music-bridge/desktop run test:startup` | PASS；development 与 production 均输出 `DESKTOP_STARTUP_PASS` |
| `node scripts/ci/verify-boundaries.mjs` | PASS，退出码 0 |
| `node scripts/ci/verify-cycles.mjs` | PASS，检查 56 个文件 |
| `node scripts/ci/verify-control-plane.mjs` | PASS，TASK-035 状态更新后复核 |
| `git diff --check` | PASS，退出码 0 |

## Synthetic Remote Core Gate

Fake SSH/Fake Roon 覆盖以下边界：目标注入拒绝、SSH 固定参数、禁止 shell、禁止控制端口转发、回环绑定、八端口上限、forward 失败回退、认证失败、健康响应解析、子进程异常退出、一次性自动重连、停止清理和正式/开发 Extension 隔离。所有测试均为合成数据，不连接真实 SSH、Provider、Roon 或 Core Mac。

## Core Mac Owner-only Gate

本次未执行双 Mac 实机 Gate。该 Gate 需要 Owner 提供目标 Mac 的 SSH key/known-hosts 条件并在本地 GUI/Roon 会话确认，不能由 CI 或 Fake SSH 代替。以下布尔值均为 `false`，表示尚未运行，不表示对真实设备作出失败判断：

```text
sshKeyAuth=false
remoteHealth=false
remoteCoreReady=false
devExtensionVisible=false
selectedZoneReady=false
remoteRecommendationPlayed=false
tunnelLossStoppedPlayback=false
singleReconnectObserved=false
noAutoResumeObserved=false
appQuitCleanedTunnel=false
```

## 安全与停止边界

- 未扫描 Roon 端口，未修改防火墙、sshd、GatewayPorts 或任何 LAN 监听；没有转发 `38501`，没有把 Provider Cookie、Token、Roon session、Zone 标识或上游 URL 写入 Renderer、日志、报告或 Git。
- 未把真实密码放入命令、环境变量、Shell 历史、测试或报告；SSH 认证失败只返回 `SSH_AUTH_REQUIRED`。
- 本分支已完成自动化和合成 Gate，随后停止在 Owner/Sol Pro 实机审查前；没有创建 PR、merge 或 release。

## 结论

**PASS WITH OWNER-ONLY CARRYOVER**

TASK-035 的隧道安全边界、Core 模式隔离、Gateway 健康契约、Roon 开发 Extension、Settings 控制、播放断线清理、synthetic E2E 和自动校验已通过。真实 Core Mac 双机部署、Roon 实机可见性、真实播放、断线恢复和 Owner 验收仍保持为独立的 Owner-only Gate。
