# TASK-023 结果报告：Roon 元数据、音质与错误恢复

## 当前结论

**PARTIAL — 自动 Gate、Core Mac 部署与 Electron App 重启恢复通过；需要真实播放或真实故障触发的高阶实机 Gate 尚未关闭。**

本轮没有把自动化 Fake 测试或旧 POC 播放证据冒充为 TASK-023 实机证据。现有 SSH 配置中的可复用 ControlMaster 已核验并用于部署；此前报告中“当前 Shell 没有 SSH 通道”的文字属于部署前记录，本报告已更正。

## Git 身份

- 分支：`codex/wave-2-desktop-core`
- 当前部署 HEAD：`91abdce2b38db54e292189e16e88d5a99bcfa034`
- TASK-023 实现提交：`bb69fd9b891c192ce8032d93b7aae0383eccece9`
- 实现提交信息：`feat: add metadata recovery and playback diagnostics`
- 报告与阶段验证此前提交：`91abdce2b38db54e292189e16e88d5a99bcfa034`
- 本轮未创建 PR、未合并、未 force-push。

## 实现范围

- 播放快照增加受约束的 `lastIssue` 与 `qualityNotice`，包含稳定错误码、中文用户文案、可重试标志、诊断 ID 和恢复动作；不携带上游响应、播放地址、凭据或令牌。
- 请求无损但实际音质降级时，保留请求/实际音质并产生可理解提示。
- Stream Gateway 对上游过期响应只允许一次 resolver 刷新；刷新后仍失败时返回确定性的 `STREAM_URL_EXPIRED`，不无限重试。
- `MediaError`、`ZoneLost` 和 Provider `AUTH_EXPIRED` 映射到不同的公开诊断状态，并在终止路径清理流资源和活动播放。
- 曲目封面只接受允许的 NetEase HTTPS CDN 主机；不合规封面被丢弃。
- Provider 会话过期时清理 Core 内存态并删除旧安全凭据；Core readiness 恢复时通过 Main-only 加密保险库重新注入有效凭据。
- 控制面错误日志只记录错误码、HTTP 方法和 pathname，不记录查询参数、完整上游地址或内部 details。

## 自动 Gate

以下检查在本轮部署前后均通过，构建未产生产品依赖文件变更：

| 检查 | 结果 |
|---|---|
| `corepack pnpm@10.17.1 verify` | PASS |
| Contracts 测试 | 12/12 PASS |
| Bridge Core 测试 | 127/127 PASS |
| Desktop 测试 | 26/26 PASS |
| TypeScript 类型检查 | PASS |
| 生产构建 | PASS |
| Electron 未签名 arm64 App 打包 | PASS |
| `corepack pnpm@10.17.1 doctor` | PASS |
| `git diff --check` | PASS |
| `package.json` / `pnpm-lock.yaml` 差异检查 | 无变化 |
| 自动化秘密字段与日志脱敏测试 | PASS |

## Core Mac 部署证据

- 使用开发 Mac 上已存在、已核验的 SSH 配置别名与活动 ControlMaster；未请求、读取或记录密码。
- 新 release commit：`91abdce2b38db54e292189e16e88d5a99bcfa034`
- bundle SHA-256：`ae23ccf9b041d7df30c3c5220d9da6147d4916c8fc6bee89fc37a8dd02ce9699`
- App ASAR SHA-256：`b7c535be8e1d1439adbf8163c65441ed4147625c2a84349561980a7ec6546f56`
- 远端 bundle 与本地 bundle：MATCH
- 远端 bundle 与 ASAR：MATCH
- release metadata：commit、bundle、ASAR 均匹配，权限 `600`
- `current`：指向本轮部署 release，SHA 匹配
- 旧 Music Bridge Electron App：已停止
- 新 Music Bridge Electron App：已启动，进程存在
- Roon Core：未停止、未重启；远端 Roon 进程仍存在
- 本地 staging：部署后残留 `0`
- 本地 archive：部署后残留 `0`
- 远端临时 archive：部署后残留 `0`

## 远端运行态 Gate

部署后和 Electron App 重启后均执行脱敏状态检查：

| 检查 | 结果 |
|---|---|
| Bridge `/health` | PASS |
| Provider 公共状态 | `configured` |
| Roon 公共状态 | `ready` |
| `activeStreamCount` | `0` |
| `activePlayback` | 不存在 |
| `/v1/playback` | `idle` |
| 38501 监听 | loopback-only |
| 38502 监听 | loopback-only |
| Roon Core 进程 | 仍存在 |

## Electron App 重启恢复

本轮仅停止当前 release 对应的 Music Bridge App 进程并重新启动同一 `current` release，没有触碰 Roon Core：

- 旧 App 进程停止：PASS
- 新 App health：PASS
- Provider 状态恢复为 `configured`：PASS
- Roon 状态恢复为 `ready`：PASS
- `activeStreamCount=0`：PASS
- `activePlayback` 不存在：PASS
- 38501/38502 仍为 loopback-only：PASS

## 日志与秘密检查

- 应用日志文件扫描：PASS；未发现凭据字段、授权值、Bearer 值、完整带查询参数的地址或查询参数泄漏。
- macOS 统一日志宽泛关键词预检出现了授权/令牌类词语，但没有匹配到凭据值、完整地址或查询参数；该系统日志预检不作为应用秘密泄漏证据。
- 未读取或输出安全凭据文件、配置文件内容、Provider 原始响应、账号资料或完整播放地址。

## 实机 Gate 状态

| 场景 | 自动 Gate | 本轮 Core Mac 实机 Gate |
|---|---|---|
| 元数据与安全封面 | PASS | 未执行真实库读取 |
| 请求无损但实际音质降级 | PASS | 未执行真实播放 |
| URL 过期单次刷新 | PASS | 未执行真实播放/强制过期 |
| Roon `MediaError` | PASS | 未注入真实故障 |
| Roon `ZoneLost` | PASS | 未操作 Roon Zone |
| Provider 登录过期 | PASS | 未登出或破坏真实登录状态 |
| Electron Core 重启恢复 | PASS | PASS |

未执行上述高阶实机项是有意的：它们分别需要测试歌曲、真实上游响应、Roon 人工操作或真实账号状态变更；本轮没有播放歌曲、没有执行 `POST /v1/play`，也没有停止或重启 Roon。

## 未执行事项与范围检查

- 未执行歌曲播放或队列播放。
- 未执行 `POST /v1/play`。
- 未停止、未重启 Roon Core。
- 未读取或请求 Provider 原始响应。
- 未读取、输出或记录任何凭据内容、账号资料、二维码内容、完整播放地址或配置文件内容。
- 未修改 `package.json`、`pnpm-lock.yaml`、Provider 依赖版本、端口、loopback-only 规则、Roon 配对或架构边界。
- 未开始 TASK-030 或任何后续任务。

## 下一步与边界

TASK-023 要从 PARTIAL 关闭为 PASS，还需要 Owner 安排真实测试歌曲/人工故障场景，并分别确认实际音质、过期刷新、MediaError、ZoneLost 与 Provider 过期恢复；这些 Gate 不能由 Fake 测试替代。TASK-030 在此之前不可开始。

## 最终状态

**TASK-023：PARTIAL。**

自动 Gate、部署完整性、运行健康、loopback 安全边界和 Electron App 重启恢复已通过；真实播放/真实故障触发 Gate 保持未关闭。**TASK-030：未开始。**
