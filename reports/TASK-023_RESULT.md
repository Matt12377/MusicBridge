# TASK-023 结果报告：Roon 元数据、音质与错误恢复

## 当前结论

**PARTIAL — TASK-023 自动 Gate 已通过；Core Mac 实机复核尚未执行。**

本轮完成了最小范围的元数据安全、实际音质提示、播放地址单次刷新、Roon 终止事件诊断、Provider 会话过期处理和 Electron Core 重启后安全凭据恢复。由于当前 Codex Shell 没有可用的 Core Mac SSH ControlMaster，本轮没有部署新 release，也没有把自动化结果冒充为 Core Mac 实机结果。

## Git 身份

- 分支：`codex/wave-2-desktop-core`
- TASK-023 实现提交：`bb69fd9b891c192ce8032d93b7aae0383eccece9`
- 实现提交信息：`feat: add metadata recovery and playback diagnostics`
- 远端分支已核对到同一提交：PASS
- 未创建 PR、未合并、未 force-push。

## 实现范围

- 播放快照增加受约束的 `lastIssue` 与 `qualityNotice`，包含稳定错误码、中文用户文案、可重试标志、诊断 ID 和恢复动作；不携带上游响应、播放地址、Cookie 或 Token。
- 请求无损但实际音质降级时，保留 `requestedQuality`/`actualQuality` 并产生“请求无损，实际高品质”提示。
- Stream Gateway 对上游 401/403/404 只允许一次 resolver 刷新；刷新后仍失败时返回确定性的 `STREAM_URL_EXPIRED`，不无限重试。
- `MediaError`、`ZoneLost` 和 Provider `AUTH_EXPIRED` 映射到不同的公开诊断状态，并在终止路径清理 stream token、stage observer 和 active playback。
- 曲目封面只接受允许的 NetEase HTTPS CDN 主机；不合规封面被丢弃。曲目公开元数据仍保留标题、艺人、专辑、时长和安全封面字段。
- Provider 会话过期时清理 Core 内存态并进入 `expired`；Main 收到该事件后删除旧安全凭据文件，避免重启重新注入已过期会话。
- Electron CoreSupervisor 在重新收到 `core.ready` 后，通过 Main-only safeStorage vault 恢复 Provider 会话；恢复失败时 fail closed。
- 控制面错误日志只记录错误码、HTTP 方法和 pathname，不记录查询参数、完整 URL 或内部 details。

## 自动 Gate

以下命令在实现提交后再次执行，均退出码为 `0`：

| 检查 | 结果 |
|---|---|
| `corepack pnpm@10.17.1 verify` | PASS |
| Contracts 测试 | 12/12 PASS |
| Bridge Core 测试 | 127/127 PASS |
| Desktop 测试 | 26/26 PASS |
| TypeScript 类型检查 | PASS |
| 生产构建 | PASS |
| `corepack pnpm@10.17.1 doctor` | PASS |
| `git diff --check` | PASS |
| `package.json` / `pnpm-lock.yaml` 差异检查 | 无变化 |
| 新增内容秘密扫描 | PASS |

新增或强化的行为测试覆盖：

- 真实错误状态的公开诊断对象和非法诊断对象拒绝；
- 实际音质降级提示；
- Roon `MediaError`、`ZoneLost` 的状态、文案、诊断 ID 和资源清理；
- Provider 会话过期后的状态和资源清理；
- 上游过期地址一次刷新成功，以及刷新后再次过期的确定性失败；
- NetEase 真实登录状态包装兼容、嵌套会话过期和封面域名约束；
- CoreSupervisor 初次启动/重启 readiness hook 和 safeStorage 凭据恢复。

## 实机 Gate 状态

| 场景 | 自动 Gate | Core Mac 实机 Gate |
|---|---|---|
| 元数据与安全封面 | PASS | 待部署复核 |
| 请求无损但实际降级 | PASS | 待实际上游复核 |
| URL 过期单次刷新 | PASS | 待实际网关复核 |
| Roon MediaError | PASS | 待实机触发/复核 |
| ZoneLost | PASS | 待实机触发/复核 |
| Provider 登录过期 | PASS | 待实机复核 |
| Electron Core 重启恢复 | PASS | 待 Core Mac 部署后复核 |

## 远程部署状态

- 本轮未部署 `bb69fd9b891c192ce8032d93b7aae0383eccece9` 到 Core Mac。
- 当前 Codex Shell 中 `CORE_SSH_TARGET` 未设置，`SSH_CONTROL_PATH` 未设置，ControlMaster socket 不存在。
- 未请求密码、未读取或输出密码、未停止或重启 Roon、未播放歌曲。
- 不能把先前 release 的运行证据复用于本轮 TASK-023 实机 Gate。

## 安全与范围

- 未修改 `package.json`、`pnpm-lock.yaml`、Provider 依赖版本、Roon extension id、端口或 loopback-only 规则。
- 未执行 npm install、npm ci、pnpm install、歌曲播放、`POST /v1/play` 或 Provider 原始接口调用。
- 未读取、请求、输出或记录 Cookie、Token、账号资料、二维码内容、config.json 或完整播放 URL。
- 本轮修改仅涉及 Contracts、Bridge Core、Desktop 的错误/恢复实现及对应测试；未开始 TASK-030。

## 阻塞与下一步

要将 TASK-023 从 PARTIAL 关闭为 PASS，需要 Owner 在本地终端建立已验证的 SSH ControlMaster，并在不把密码发到聊天的前提下提供可复用的本地通道。随后应部署本提交并逐项复核上表实机 Gate；如果任何实机 Gate 失败，保留脱敏阶段状态并停止，不进行无限重试。

## 最终状态

**TASK-023：PARTIAL。**

自动实现和安全边界已通过；Core Mac 实机部署与恢复复核待 SSH 通道恢复后完成。**TASK-030：未开始。**
