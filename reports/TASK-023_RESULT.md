# TASK-023 结果报告：Roon 元数据、音质与错误恢复

## 当前结论

**PASS WITH ACCEPTED CARRYOVER**。

自动 Gate、最新未签名 arm64 Electron App 的 Core Mac 部署、真实授权播放与恢复路径均通过。没有把 Fake 测试、旧报告或 Provider 原始响应冒充为实机证据。未破坏真实登录、Roon Zone 或播放链路来制造罕见故障；这些场景有完整的受控故障覆盖，作为 Owner-only carryover 留到后续 Beta 验收。

## Git 与部署身份

- 阶段分支：`codex/wave-2-desktop-core`
- 本轮开始 HEAD：`a68023e6f97b0c2c66d09b927df0ab4717ad4241`
- TASK-023 实现提交：`bb69fd9b891c192ce8032d93b7aae0383eccece9`
- 实现提交信息：`feat: add metadata recovery and playback diagnostics`
- 本轮部署产品 release：`91abdce2b38db54e292189e16e88d5a99bcfa034`
- closure commit：本报告所在的 `docs: close TASK-023 and Wave 2` 提交
- 未创建 PR、未合并、未 force-push。

## 实现范围

- 播放快照提供受约束的错误码、质量提示、诊断 ID 与恢复动作，不携带上游响应、播放地址、凭据或令牌。
- 请求无损但实际质量降级时，保留请求质量与实际质量并产生确定性提示。
- Stream Gateway 对过期响应最多执行一次 resolver 刷新，失败后返回确定性 `STREAM_URL_EXPIRED`。
- `MediaError`、`ZoneLost` 与 Provider `AUTH_EXPIRED` 映射为不同公开诊断状态，并清理流资源与活动播放。
- 封面只接受允许的 Provider HTTPS CDN 主机；不合规地址被丢弃。
- Provider 会话过期会清理 Core 内存态并删除旧安全凭据；Core 恢复时通过 Main-only 加密保险库重新注入有效凭据。
- 控制面错误日志只记录错误码、HTTP 方法与 pathname，不记录查询参数、完整上游地址或内部 details。

## 自动 Gate

| 检查 | 结果 |
|---|---|
| `corepack pnpm@10.17.1 verify` | PASS；Contracts 12/12、Bridge Core 127/127、Desktop 26/26 |
| TypeScript 类型检查 | PASS |
| 生产构建与未签名 arm64 App 打包 | PASS |
| `corepack pnpm@10.17.1 doctor` | PASS |
| `git diff --check` | PASS |
| `package.json` / `pnpm-lock.yaml` | 无变化 |
| 元数据、质量、错误恢复、资源清理测试 | PASS |
| 日志秘密字段测试 | PASS |

## Core Mac 部署与运行态

- 使用已核验的 SSH 配置别名与活动 ControlMaster；未请求、读取、记录或输出密码。
- release commit：`91abdce2b38db54e292189e16e88d5a99bcfa034`
- bundle SHA-256：`ae23ccf9b041d7df30c3c5220d9da6147d4916c8fc6bee89fc37a8dd02ce9699`
- App ASAR SHA-256：`b7c535be8e1d1439adbf8163c65441ed4147625c2a84349561980a7ec6546f56`
- 远端 bundle、ASAR、release metadata 与期望 commit：MATCH；metadata 权限为 `600`。
- current 指向本轮 release；本地 staging、local archive、远端临时 archive：均为 `0`。
- 旧 App 已停止，新 App 已启动；Roon Core 未停止、未重启，Roon 进程仍存在。

## 已完成的 packaged App / Core Mac Gate

| 场景 | 结果 | 脱敏证据 |
|---|---|---|
| App 启动 | PASS | health 可用 |
| safeStorage 登录恢复 | PASS | Provider 公共状态为 `configured` |
| Bridge Core | PASS | runtime ready |
| Roon 与选定 Zone | PASS | Roon ready，选定 Zone 状态保留；未记录 Zone ID |
| 队列播放 | PASS | 一个已授权测试曲目进入 playing |
| 元数据 | PASS | title、artist、album 均存在；未写入具体内容 |
| 安全封面 | PASS | 仅接受规则允许的 HTTPS CDN 主机 |
| 请求/实际质量 | PASS | requested=`lossless`，actual=`lossless`，format=`flac` |
| 停止清理 | PASS | `activeStreamCount=0`，无 active playback |
| App 退出 | PASS | 38501、38502 均释放；Roon 仍在运行 |
| App 重启 | PASS | auth/Roon 恢复，未自动恢复旧音频 |
| 38501 / 38502 | PASS | 仅 loopback 监听 |

Owner 已另行确认两首授权测试曲目按顺序自然完整播放，Signal Path 均显示无损；本报告不记录曲目 ID、名称、完整地址或账号资料。

## 受控故障覆盖与 carryover

以下罕见路径由自动化 Fake/集成 Gate 覆盖并通过：

- `MediaError` 映射与活动播放清理；
- `ZoneLost` 映射与恢复动作；
- URL 过期的一次刷新及二次失败终态；
- Provider `AUTH_EXPIRED` 清理与恢复；
- utilityProcess crash/restart 与第二次失败的 fail-closed 行为。

没有在真实 Core Mac 上破坏性触发上述故障，也没有主动退出真实 Provider 或 Roon Zone。真实账号音乐库的搜索、我喜欢、歌单和歌单详情路径已有 Core、IPC、Renderer 的受控集成测试；真实账号内容的 packaged UI 复核按 GOAL 规定留到 TASK-041 Owner 验收。

这两类未破坏性触发的 Owner-only 场景是唯一 carryover，不包含凭据泄漏、登录恢复失败、播放失败、Roon 恢复失败、资源泄漏或非 loopback 监听。

## 日志、资源与安全扫描

- 应用日志文件秘密扫描：PASS；覆盖 `NETEASE_COOKIE`、`Cookie`、`MUSIC_U`、`__csrf`、`Authorization`、`Bearer`、token 值、完整带查询参数地址。
- 日志扫描只输出 PASS/FAIL，不输出匹配内容；本轮未读取安全凭据文件或 Provider 原始响应。
- 远端日志文件数：1；临时 archive remainder：0。
- 开发机报告禁止字段扫描：PASS；未发现凭据赋值、授权值、Bearer 值、完整查询 URL 或 Core 内部地址。
- 38501/38502 仍为 loopback-only；未修改防火墙、Roon、Provider 依赖、端口或安全边界。

## 未执行事项

- 未执行破坏性真实 `MediaError`、`ZoneLost`、URL 过期或 Provider 登出操作。
- 未读取或输出 Cookie、Token、密码、二维码、账号资料、Provider 原始响应、配置内容、完整播放地址或查询参数。
- 未停止或重启 Roon Core。
- 未修改 `package.json`、`pnpm-lock.yaml`、端口、loopback-only 规则或产品架构。
- 未开始 TASK-029 之前的任何后续实现；TASK-030 不在 WAVE-2 内提前开始。

## 最终状态

**TASK-023：PASS WITH ACCEPTED CARRYOVER。**

**WAVE-2：允许关闭并进入 TASK-029。**
