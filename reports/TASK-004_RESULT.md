# TASK-004 结果报告

## 最终结论

**PASS**

TASK-004 的 generation 隔离、Range/If-Range、真实无损播放、较长曲目完整播放、Signal Path、运行时清理和安全边界验收均已完成。TASK-005 可以在本报告提交后按 Owner 已有授权开始；TASK-002 不重开，也未开始 TASK-010。

## 基线与提交

- 基线 SHA：`d3912260c17b4cbac2f3b68de9b6b621992f61f4`
- 分支：`codex/task-004-lossless-range-gate`
- generation 修复提交：`c25f714bfa68c1c0712bad5d12c56e5ecb5edcf0` — `fix: isolate Roon playback generations`
- Range/If-Range 验证提交：`8c0717a864393d46131b8920bd115e484e50c669` — `test: verify lossless range and long playback`
- 本报告提交信息：`docs: record TASK-004 verification`

## Generation 隔离修复

修复了 `ROON-SESSION-GEN-001`：每次播放拥有独立 generation、track identity、session 引用和取消句柄。Session、play、terminal、ZoneLost、连接错误和 timeout 回调在修改状态前验证 generation；旧回调只写入不含身份值的 stale 诊断，不得清理新播放的状态、token、session 或 status。

覆盖的 generation 回归场景包括：旧 `SessionEnded`、`EndedNaturally`、`StoppedUser`、`Paused`、`MediaError`、play/session `ZoneLost`、连接错误、旧 `SessionBegan`、未知 session/play 事件、旧 `Playing`、停止时 timeout 失效和 stale 日志字段隔离。全量测试由原有 72 个扩展为 86 个，最终 86/86 通过。

## 本地自动验证

| 检查 | 结果 | 退出码 |
|---|---:|---:|
| `bash -n scripts/deploy/build-agent-bundle.sh` | PASS | 0 |
| `bash -n scripts/deploy/deploy-agent.sh` | PASS | 0 |
| `bash -n scripts/deploy/start-agent.sh` | PASS | 0 |
| `bash -n scripts/deploy/stop-agent.sh` | PASS | 0 |
| `bash -n scripts/deploy/status-agent.sh` | PASS | 0 |
| `npm run typecheck` | PASS | 0 |
| `npm test` | PASS — 86/86 | 0 |
| `npm run build` | PASS | 0 |
| `npm run verify` | PASS | 0 |
| `npm run doctor` | 环境诊断未通过 | 1 |

`npm run doctor` 的两个失败项属于开发机运行环境：控制端口当时由既有 SSH 隧道占用，开发机本地没有 Provider 配置。远程 Core Mac 的 runtime status 已独立通过，未因此修改端口、Provider 行为或安全边界。

## Bundle 与部署

- 部署 release SHA：`8c0717a864393d46131b8920bd115e484e50c669`
- Bundle SHA-256：`167637f32a5e8cd3209fd00706146bb53ffdd74349ea0faf36491a53e72a8616`
- Bundle 顶层文件清单：`dist`、生产 `node_modules`、`package.json`、`package-lock.json`
- 原生 `.node` 模块：0
- 开发机与 Core Mac CPU 架构：均为 `arm64`
- 远程 release 额外部署元数据：存在，权限 `600`
- staging/archive：部署成功、失败路径清理逻辑通过；本次实际部署后的 staging 清理为 PASS
- 远程 release 未包含 `src`、`test`、`docs`、`tasks`、`reports`、`.git` 或 `.env`

构建流程执行了 `npm ci`、`npm run verify`、`npm run build` 和生产依赖安装；没有修改 `package.json` 或 `package-lock.json`。

## Core Mac Runtime 验证

- 新 SSH zsh Shell 的 Node.js：`v22.23.2`
- Core Mac CPU 架构：`arm64`
- Roon Core 进程：存在；未停止、重启或修改 Roon
- 预检端口：38501 和 38502 均为 loopback-only
- current、running、agent release、expected release：全部为 `8c0717a864393d46131b8920bd115e484e50c669`
- Provider credential status：`configured`
- XEAPI public key status：`ready`
- Health：`true`
- `neteaseConfigured`：`true`
- `activeStreamCount`：`0`
- `activePlayback`：不存在
- 日志秘密扫描：`pass`
- `RELEASE_IDENTITY_CONSISTENT`：`true`
- 最终远程 runtime status：`PASS`

开发机通过既有 SSH 控制隧道访问控制接口验证成功；隧道只验证控制接口，没有转发或暴露流端口。

## Range、HEAD 与传输验证

自动测试覆盖并通过：

- GET `Range` 请求转发
- `If-Range` 请求头转发
- `206 Partial Content`
- `Content-Range`、`Accept-Ranges`、`Content-Type`、`Content-Length`
- HEAD 不返回响应 body，保留 headers
- HTTPS preflight 使用受限 Range 请求并取消响应 body
- 上游 pipeline error 与下游 client abort 的清理路径
- MediaError、ZoneLost 和旧 generation terminal callback 的清理路径

## 真实无损播放 Gate

两首曲目均由 Owner 确认完整播放、听到声音且无损。报告不记录歌曲 ID。

### 曲目 A

- 请求质量：`lossless`
- 实际 level：`lossless`
- 实际 type：`flac`
- 实际 bitrate：`753411`
- 实际 size：`22773338 bytes`
- transport：HTTPS upgraded
- 完整播放：Owner 确认

### 曲目 B（较长曲目）

- 请求质量：`lossless`
- 实际 level：`lossless`
- 实际 type：`flac`
- 实际 bitrate：`1646929`
- 实际 size：`39282015 bytes`
- transport：HTTPS upgraded
- 完整播放：Owner 确认
- 较长曲目：Owner 确认

Signal Path 脱敏证据：

- [signal-path-lossless.png](runtime/TASK-004/signal-path-lossless.png)
- SHA-256：`fe4ed3f171a90257ef5f2a6f7bfc614cbfee51aea6d5b817d212181c4ae3f10d`
- 截图显示：`FLAC 44.1 kHz 24bit 2ch`，经 Roon Advanced Audio Transport 到目标输出

此前一次启动曾出现 `exhigh/mp3` 降级结果，已按实际结果保留；后续两次新鲜请求均达到 `lossless/flac`，没有将降级结果伪报为无损。

## 静态安全检查

- 未发现 FFmpeg、libav、avconv 或转码调用
- 未发现音频文件落盘、音频下载缓存或完整音频缓存逻辑
- `Buffer.concat` 仅存在于控制接口 JSON 请求体解析；音频路径仍使用流式转发，测试中的 `arrayBuffer()` 只用于测试响应断言
- 未开放非 loopback 控制或流端口
- 未启用代理、解灰或随机中国 IP 安全开关
- 未新增 Cookie、Token、账号信息、完整播放 URL 或私密环境变量到代码、日志或报告

## 未执行事项

- 未播放其他未授权曲目
- 未执行 `POST /v1/play` 之外的任何下载、转码或缓存操作
- 未读取 Roon 数据库或音乐库
- 未修改产品架构、端口、extension_id、Provider 行为或 Stream Gateway 核心边界
- 未创建 PR、未合并、未发布
- TASK-005 在本报告提交前尚未开始

## 验收状态

**TASK-004：PASS**

所有必要自动 Gate、远程 runtime Gate、真实双曲目 Gate、较长曲目 Gate、Signal Path Gate 和播放结束清理 Gate 均已通过。
