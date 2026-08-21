# TASK-031 结果报告：诊断、崩溃恢复与稳定性

## 任务身份

- 任务：TASK-031 — diagnostics, crash recovery and stability
- 基线分支：`codex/task-030-v1-ui`
- 基线 SHA：`a7e12e3cb1d305156fa6d298dc19f2d64785bc77`
- 工作分支：`codex/task-031-diagnostics-stability`
- 实现提交：`978acb00edf7c33a71bf575a3c4743fe97da479b`
- 实现提交信息：`feat: add diagnostics and stability gates`
- 报告提交信息：`docs: record TASK-031 verification`
- 实现提交已推送到 `origin/codex/task-031-diagnostics-stability`
- 未创建 PR、未合并、未 force-push、未发布

## 实现摘要

- 增加固定上限的 Main/Core 结构化诊断环形缓冲；快照只包含公开状态、固定事件枚举、诊断标识、内存摘要、资源计数、延迟和 Gate 状态。
- 增加 `core.getDiagnostics` typed IPC，以及 Diagnostics 页面上的单文件导出入口。
- 导出前执行秘密扫描；拒绝 Cookie、Provider 凭据字段、Authorization/Bearer、Token 值、完整 URL、Query 参数、用户私有路径和 stack trace。
- 导出写入临时文件、设置 600 权限后原子 rename；Renderer 只收到成功/取消布尔结果，不收到文件路径或诊断内容。
- Main 记录 Core Supervisor 的 spawn、ready、exit、restart、failed、stopped 生命周期；不记录进程路径、账号资料或上游响应。
- Bridge Core、Roon Audio Input 和 Stream Gateway 暴露资源计数；播放计时器、停止计时器、订阅回调、流观察者在完成或 shutdown 后清理。
- 保留既有一次自动 Core 重启、二次 fail-closed、陈旧回调、MediaError、ZoneLost、Provider 过期和 URL 过期路径，并把其自动验证纳入本任务证据。

## 自动验证

| 命令/检查 | 退出码 | 结果 |
|---|---:|---|
| `corepack pnpm@10.17.1 verify` | 0 | PASS；workspace typecheck、tests、build 全部通过 |
| contracts tests | 0 | PASS，16/16 |
| Bridge Core tests | 0 | PASS，146/146 |
| Desktop tests | 0 | PASS，33/33 |
| `corepack pnpm@10.17.1 --filter @music-bridge/desktop test:e2e` | 0 | PASS，Playwright 3/3 |
| `node scripts/ci/verify-boundaries.mjs` | 0 | PASS |
| `node scripts/ci/verify-cycles.mjs` | 0 | PASS，44 个源文件 |
| `git diff --check` | 0 | PASS |
| `git diff -- package.json pnpm-lock.yaml` | 0 | 无差异 |

验证过程中第一次完整 `verify` 曾因测试对只读快照直接调用 `pop()` 退出 2；已将测试改为操作副本，随后完整 `verify` 退出 0。该修正未改变生产行为。

## 自动稳定性 Gate

- 100 项合成队列：PASS；诊断快照只报告计数，不包含合成曲目名、曲目标识、Zone 标识或 URL。
- 快速 replace/next/stop 串行压力：PASS；既有 Controller 序列化测试通过，活动流保持单一且停止后资源归零。
- 陈旧 Session/play/terminal 回调：PASS；既有 Roon adapter 代际测试全部通过。
- MediaError、ZoneLost、Provider 过期、一次 URL 过期重试及二次 URL 过期失败：PASS；既有 Bridge Core 测试全部通过。
- Core Supervisor 首次崩溃后一次重启、再次失败后 fail-closed：PASS；生命周期序列测试通过。
- Renderer 隔离、Electron 冷启动、启动崩溃 Gate、safeStorage 合成 Gate：PASS。
- 诊断导出 E2E：PASS；单文件权限为 600，schemaVersion 为 1，导出文本秘密扫描通过，critical/serious axe 问题为 0。
- 播放计时器、Roon listener、Controller listener、Gateway observer 和 stream/token 资源清理：PASS；shutdown 后计数均为 0。

## 诊断导出边界

导出内容限定为：schema/version、平台与运行时版本、公开健康状态、脱敏时间线、内存摘要、队列/流/播放/session/token/listener/timer 计数、启动/播放延迟和 Gate 结果。

导出接口不读取、不输出、不持久化 Provider 原始响应、账号资料、Cookie、Token、二维码、完整 URL、Query、Roon 身份或用户音乐内容。正式运行使用系统保存对话框；测试路径变量仅在合成 UI E2E 模式启用。

## Core Mac 技术 Gate

| Gate | 当前状态 | 说明 |
|---|---|---|
| 30 首授权曲目连续队列 | OWNER ACCEPTANCE PENDING | 本轮只完成合成 100 项队列，未触发真实播放 |
| 10 次冷启动 | OWNER ACCEPTANCE PENDING | 未启动远程 Core Mac 实测循环 |
| 至少一首长曲目 | OWNER ACCEPTANCE PENDING | 未执行真实曲目播放 |
| 快速 next/stop smoke | OWNER ACCEPTANCE PENDING | 自动合成压力已通过，真实 Core Mac 留给 Owner Gate |
| 空闲 60 秒后资源/内存复查 | OWNER ACCEPTANCE PENDING | 未在远程设备等待或读取真实设备日志 |
| Roon 重启、网络短断 | OWNER ACCEPTANCE PENDING | 本轮不停止、不重启或修改 Roon |

本轮没有建立、请求或使用 SSH 通道，没有调用真实 Provider，没有播放歌曲，没有执行播放 POST，也没有读取任何凭据。任务要求允许在自动控制恢复测试通过时保留真实 Roon 技术 Gate 为 Owner acceptance pending；不自动重启 Roon。

## 范围与安全

- 未修改 `package.json`、`pnpm-lock.yaml`、Provider 固定版本、Roon `extension_id`、38501/38502 端口、loopback-only 规则或 Stream Gateway 的网络安全策略。
- 未新增下载、缓存、转码、FFmpeg、解灰、代理或随机 IP 行为。
- 未创建 `.env`，未写入或输出密码、Cookie、Token、账号资料、完整 URL、Query、Roon 标识或真实设备信息。
- 未开始 TASK-032 以后的实现；没有创建 PR、合并或发布。

## 结论

**PASS WITH OWNER-ONLY CORE GATE PENDING**

TASK-031 的诊断实现、自动稳定性、Electron E2E、资源清理和安全扫描全部通过。真实 Core Mac 技术 Gate 保留给 Owner 后续验收，不构成本轮代码阻塞。下一任务为 TASK-032。
