# TASK-003 结果报告

## 最终结论

**BLOCKED — TASK-003R 已完成有界诊断，但没有形成 Playing 或实际 Zone 音频。TASK-004 不得开始。**

本轮修正了一个重要判断：此前的 ROON_TIMEOUT 只说明旧的合并 30 秒窗口内没有进入 Playing，不能证明没有收到 SessionBegan。新的单次诊断显示：Roon 确实返回了 Session callback，但事件为 InvalidRequest，未收到有效 SessionBegan/session_id，因此没有调用 audioInput.play，也没有进入 Gateway stream。

## 任务边界与提交

- 当前分支：codex/task-003-standard-exhigh-playback
- TASK-003R 起始报告 HEAD：225868f153066f4f5793f4824071d698d02a77e8
- TASK-003R 实现提交：1a08695df4faa8943d7982d6fe1a391cd63bf8b6
- 实现提交信息：fix: localize Roon Audio Input session timeout
- 后续观测日志修复提交：c0f7664ae3d459a68401ee2fc6912f29d75dd213
- 后续修复提交信息：fix: preserve Roon diagnostic event envelope
- 当前远程运行 release：c0f7664ae3d459a68401ee2fc6912f29d75dd213
- 未修改 Provider HTTPS 策略、Provider 凭据通道、Roon extension_id、正式端口、loopback-only 规则、解灰、代理或随机 IP 规则。
- 未修改 package.json、package-lock.json；未新增依赖。
- 未开始 TASK-004、TASK-005 或 TASK-010；未创建 PR、未合并。

## 修复前历史记录与判断纠正

此前 HTTP→HTTPS Gate 的真实尝试曾记录 191248、1347524822 和 191174 的 Provider/播放结果。旧版本只使用一个覆盖 begin_session、SessionBegan、audioInput.play、Gateway media request 和 Playing 的 30 秒计时器。

因此，旧记录中的 ROON_TIMEOUT 只能表示“30 秒内没有进入 Playing”，不能回溯证明 SessionBegan 缺失、play 未调用或 Gateway 未收到 stream 请求。本报告不再把旧 ROON_TIMEOUT 解读为 SessionBegan 缺失。

## TASK-003R 实现内容

1. Roon Audio Input 流程拆为 awaiting_session 与 awaiting_playing 两个阶段。
2. awaiting_session 默认超时 10 秒；awaiting_playing 默认超时 30 秒；测试可注入更短 timeout，不真实等待 10 秒或 30 秒。
3. 超时保留现有 ROON_TIMEOUT 外层兼容码，同时以错误消息、timeoutCode 和 details.phase 明确区分 ROON_SESSION_BEGIN_TIMEOUT 与 ROON_PLAYING_TIMEOUT。未修改不在本轮允许范围内的 shared error code union。
4. begin_session 只传 zone_id 和 display_name，不传 icon_url；Gateway 图标 endpoint 仍保留，并支持 GET/HEAD。
5. Session callback 每次都记录脱敏事件名、phase 和 hasSessionId；SessionBegan 缺少有效 session_id 时立即失败；未知 Session 事件不再静默等待。
6. 记录脱敏 begin_session、Session、play、connection 和 Gateway icon/stream 阶段事件。日志不记录 session_id、zone_id、output_id、stream token、media URL、Query、歌曲 ID、Core/Zone 名称或凭据。
7. 发现 logger 的保留 event 字段会被同名回调字段覆盖后，改用 eventName 记录回调事件名，并加入 logger envelope 回归测试。
8. Gateway 在进入 proxyStream 前记录 routeClass=stream、method 和 proxyStream=true；不会记录 stream token。icon 请求只记录 routeClass=icon 和 GET/HEAD。
9. 移除既有 stream_proxy_started 日志中的歌曲 ID，并移除 roon_core_paired 日志中的 Core 名称。

## 自动化验证

所有本地检查均在登录 zsh 的 Node.js v22.23.2、npm 10.9.8 环境中执行。

| 检查 | 结果 |
|---|---|
| npm run doctor | 退出码 0；本地 .env 不存在，doctor 的本地 Provider 配置项提示缺失；合法凭据仅在运行机配置 |
| npm run typecheck | 退出码 0 |
| npm test | 退出码 0，56/56 通过；原有 45 项全部保留 |
| npm run build | 退出码 0 |
| npm run verify | 退出码 0 |
| git diff --check | 退出码 0 |
| 阶段超时、有效 SessionBegan、缺失 session_id、未知事件、Zone 映射、MooError | 通过 |
| icon/stream GET/HEAD 观测和 token/歌曲 ID 脱敏 | 通过 |
| eventName 不覆盖日志外层 event | 通过 |

部署构建阶段按既有流程执行 npm ci、npm run verify、npm run build 和生产依赖安装；没有修改产品依赖声明或锁文件。

## 远程部署与运行身份

有效真实 Probe 使用的 release：

- Probe release：1a08695df4faa8943d7982d6fe1a391cd63bf8b6
- Probe bundle SHA-256：a3c6bb06659e50a2c2b8cfc07e9d0fe7fa0f639856759dc141db357595db3d05
- Probe 前的 staging/archive 已由部署脚本清理。

Probe 后为修复日志事件外层字段，重新部署当前版本；没有再次调用播放接口：

- 最终运行 release：c0f7664ae3d459a68401ee2fc6912f29d75dd213
- 最终 bundle SHA-256：26dad6b2d1a6d63ffc39878f7a9daf4c73bbae83fa316b9219f400ea758baac6
- 当前 release、running release、agent.release 和 expected release 一致。
- 最终 staging/archive 清理：PASS。
- 开发机和运行机 CPU 架构一致；production node_modules 中没有原生 .node 模块。

最终远程 runtime 状态：

| 项目 | 结果 |
|---|---|
| release identity | PASS；四个 release 标识均为 c0f7664ae3d459a68401ee2fc6912f29d75dd213 |
| Agent 进程 | running |
| Node.js | v22.23.2 |
| Provider 凭据状态 | configured |
| XEAPI 公钥状态 | ready |
| health | true |
| NETEASE_CONFIGURED | true |
| activeStreamCount | 0 |
| active playback | 不存在 |
| 控制/流监听 | 均为 loopback |
| 日志秘密扫描 | pass |
| runtime status | PASS |

## TASK-003R 唯一有效真实 Probe

Probe 使用此前已经通过 HTTPS preflight 的已知完整曲目 191248、音质 exhigh，只执行了一次有效播放请求。没有尝试 standard、其他歌曲或其他 Zone。

| 阶段 | 结果 |
|---|---|
| HTTPS preflight success | YES；流程未返回 Provider/HTTPS 错误，并继续进入 begin_session |
| begin_session requested | YES；收到 roon_begin_session_requested |
| Session callback received | YES |
| Session event name | InvalidRequest |
| valid session_id received | NO；hasSessionId=false |
| audioInput.play invoked | NO |
| Gateway icon request | NO |
| Gateway stream request | NO |
| GATEWAY_STREAM_REQUEST_OBSERVED | false |
| Roon play callback received | NO |
| Playing received | NO |
| timeout phase | N/A；本次在 awaiting_session 阶段收到 InvalidRequest 后立即以协议错误终止，没有等到阶段超时 |

受控播放请求结果为 HTTP 502、错误码 ROON_MEDIA_ERROR、phase=awaiting_session。响应和日志均未输出 session_id、请求 body、stream token、media URL、Query 或凭据。

准备 Probe 时有一次 SSH 连接因错误复用方式走到本机代理并失败；随后一次命令引号错误导致无效 JSON，Core 仅返回 HTTP 400，未进入 Controller、Provider 或 Roon 播放流程。这两次均不是有效歌曲 Probe；有效的 191248/exhigh Probe 只执行一次，之后没有再次调用 /v1/play。

## Smoke 与 Zone 对照结果

- Smoke result：NOT RUN。主程序已经收到 Session callback，未满足“完全没有 Session callback”这一 Smoke 触发条件。
- Smoke extension：未新增、未运行；没有发送独立 extension_id、media_url 或 stream token。
- Zone 对照：NOT RUN。没有进入 Smoke 双 Zone Gate，因此没有触碰第二个 Zone，也没有修改 Roon Audio 设置、删除或重建 Zone。
- RoonServer/RAATServer 日志 Gate：NOT RUN。该 Gate 仅在两个 Zone 的最小 Smoke 都失败后触发；没有复制或提交原始 Roon 日志。

## 阻塞根因与当前解释

当前可证明的阻塞点是：Roon Audio Input 对 begin_session 返回了 InvalidRequest Session callback，而不是 SessionBegan；因此主程序没有拿到有效 session_id，没有调用 audioInput.play，Gateway 没有收到 icon 或 stream 请求，Playing 当然也没有发生。

本轮 A/B 已按要求移除 icon_url。InvalidRequest 说明请求仍在 Roon Audio Input session 阶段被拒绝，但仅凭本轮事件还不能把原因扩展为 Roon Server、Zone、协议字段或其他具体根因。应保留该阶段证据，不恢复 icon_url 进行第二次真实播放，也不开始 TASK-004。

## 安全与未执行事项

- 未访问原始 HTTP；未启用 HTTP fallback、代理、解灰、随机 IP 或备用流字段。
- 未读取、输出或保存 Cookie、账号凭据、Token、config.json 内容、完整播放 URL 或内部 Query。
- 诊断事件只包含允许的事件名、phase、hasSessionId、method、routeClass、proxyStream 和 elapsedMs 等脱敏字段。
- 未开放 LAN 监听，未修改防火墙，未读取 Roon 数据库或音乐库。
- 未确认 Zone 出声、Roon 元数据、Signal Path、完整播放或精确终止。
- 最终 Agent 保持运行在当前 release，activeStreamCount=0、无 active playback、日志秘密扫描通过。
- 未开始 TASK-004、TASK-005 或 TASK-010；未创建 PR、未合并、未发布。

## 当前决定

**TASK-003：BLOCKED**

**TASK-004：未开始，不可开始。**

下一步等待 Owner 决定如何处理 Roon Audio Input 的 InvalidRequest 阶段；在收到有效 SessionBegan、调用 play、观察 Gateway/Playing，并完成真实 Zone 音频、元数据/Signal Path、清理和日志 Gate 前，TASK-003 不得标记 PASS。
