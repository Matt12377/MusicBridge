# TASK-022 结果报告：队列与播放控制

## 当前结论

**PASS — 自动 Gate、部署 Gate 和 Owner 真实 Roon 两首完整连续播放 Gate 均已通过。**

TASK-022 已完成队列控制实现和脱敏控制面部署。当前版本支持 `replaceQueue`、`play`、`stop`、`next`、`previous`、自然结束自动下一首、快速重复操作串行化、幂等 stop，以及不可用歌曲的明确跳过策略。Owner 已完成两首歌曲的真实 Roon 完整自然播放，确认按顺序自动推进、两首 Signal Path 均为无损，并确认队列结束后无活动播放残留。自动化 10 首 Fake 队列回归仍保留。

## Git 身份

- 分支：`codex/wave-2-desktop-core`
- TASK-021 闭环基线：`18eb50127a4e6dfba78c506eab87cb5c0db2ceb1`
- TASK-022 核心实现提交：`131ecc00d6170ea3682458501417d6b39b6909f9`
- 核心实现提交信息：`feat: add queue playback controls`
- 本地控制面补充提交：`aae316a2aee1a33ee56d989f28869610f544a245`
- 补充提交信息：`feat: expose local queue control endpoints`
- 两个提交均已推送到当前阶段分支；未创建 PR、未合并、未 force-push。

## 实现范围

- Contracts 增加播放质量、队列项、队列快照、播放快照和播放状态类型。
- Typed IPC 增加 `playback.getState`、`playback.play`、`playback.stop`、`playback.next`、`playback.previous`、`playback.replaceQueue` 以及播放/队列变化事件。
- Bridge Controller 维护单一 active stream token/session；所有播放控制通过串行操作尾链执行。
- 自然 `ended` 事件自动推进下一首；队列结束时清理 stream registry、active token 和 active playback。
- `TRACK_UNAVAILABLE`、`TRACK_PREVIEW_ONLY` 只在队列场景跳过并继续；其他错误进入 error 状态并停止推进。
- 停止操作幂等；不实现 pause、seek 或 gapless。
- Main/Preload 只暴露脱敏 PlaybackSnapshot，不暴露 upstream URL、Gateway token、Cookie 或 Provider 原始字段。
- 本地 loopback Control API 增加队列替换、下一首、上一首和脱敏播放状态读取入口，便于执行真实 Roon Gate；仍不开放 LAN。

主要修改文件：

- `packages/contracts/src/playback.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/ipc.ts`
- `packages/contracts/src/validator.ts`
- `packages/contracts/test/validator.test.ts`
- `packages/bridge-core/src/application/bridge-controller.ts`
- `packages/bridge-core/src/control/server.ts`
- `packages/bridge-core/src/runtime.ts`
- `packages/bridge-core/src/utility-main.ts`
- `packages/bridge-core/test/controller.test.ts`
- `packages/bridge-core/test/control-server.test.ts`
- `packages/bridge-core/test/utility-ipc.test.ts`
- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/preload/api.ts`
- `apps/desktop/src/preload/index.ts`
- `apps/desktop/test/preload.test.ts`

未修改 `package.json`、`pnpm-lock.yaml`、Provider 依赖版本、Roon extension id、端口配置、loopback-only 规则、Stream Gateway 行为、网易云安全开关或架构核心边界。

## 自动化 Gate

最终自动验证均退出码为 `0`：

| 检查 | 结果 |
|---|---|
| `corepack pnpm@10.17.1 verify` | PASS |
| Contracts 测试 | 12/12 PASS |
| Bridge Core 测试 | 117/117 PASS |
| Desktop 测试 | 24/24 PASS |
| TypeScript 类型检查 | PASS |
| 生产构建 | PASS |
| Control API 队列测试 | 2/2 PASS |
| Fake Roon 队列测试 | PASS |
| 快速重复控制串行化 | PASS |
| 自然结束 10 首连续队列无残留 | PASS |
| 不可用歌曲跳过/全不可用停止策略 | PASS |
| `git diff --check` | PASS |
| `package.json` / `pnpm-lock.yaml` | 无变化 |
| 新增/变更内容秘密扫描 | PASS |

覆盖的 Fake Gate 包括：队列替换、next/previous、快速重复操作、自然结束自动下一首、队列结束清理、不可用项跳过、全不可用队列停止，以及 10 首自然结束后 `activeStreamCount=0`、无 active playback。

## Core Mac 部署 Gate

- 最终部署 release SHA：`aae316a2aee1a33ee56d989f28869610f544a245`
- bundle SHA-256：`30ff48ab1c526e0bb89ad82e32e66a8eddf0e95f2a0c91012abf437247b820a7`
- App ASAR SHA-256：`882e94c506509c10ade67454181326758d6c44ef7758bc510cc8a662a5899c3d`
- 远端 bundle 与本地 SHA 匹配：PASS
- 远端 App ASAR 与本地 SHA 匹配：PASS
- `current` 指向最终 release：PASS
- 旧 Music Bridge App 已停止；新 App 进程存在：PASS
- Roon 未停止、未重启；Roon 进程仍存在：PASS
- 38501：loopback 监听数 `1`，非 loopback `0`
- 38502：loopback 监听数 `1`，非 loopback `0`
- `/health`：HTTP PASS
- 远端脱敏运行状态：runtime `ready`、Roon `ready`、Provider `configured`
- 初始 `activeStreamCount=0`
- 初始 `activePlayback` 不存在
- `/v1/playback`：队列长度 `0`、状态 `idle`、index `-1`
- 日志秘密扫描：PASS
- 本地 staging/archive 和远端临时 archive：均已清理

## Owner 真实 Roon Gate（两首完整播放，已完成）

Owner 在 Core Mac 本地终端使用两个已确认可播放的数字歌曲 ID，通过已部署的 loopback Control API 提交队列。歌曲 ID 未写入本报告，也未回传聊天。

已确认：

1. 队列提交成功，第一首开始播放。
2. 两首歌曲按队列顺序完整自然结束并自动进入下一首。
3. Owner 听到两首歌曲完整播放，且两首 Signal Path 均显示无损。
4. 第二首结束后自动停止，脱敏状态为 `activeStreamCount=0`、`activePlayback` 不存在、播放状态为 `idle`。
5. 38501/38502 仍只有 loopback 监听，日志秘密扫描仍为 PASS。

可使用的本地接口路径为：`POST /v1/queue`、`GET /v1/playback`、`POST /v1/next`、`POST /v1/previous`、`POST /v1/stop`。真实播放期间不需要也不应访问任何完整 Provider 播放 URL。

## 未执行事项

- 本轮未由 Codex 代替 Owner 选择或播放真实歌曲；真实歌曲由 Owner 在 Core Mac 本地完成验收。
- 未请求、读取、输出或记录 Cookie、Token、账号资料、Provider 原始响应、二维码内容或完整播放 URL。
- 未执行 pause、seek、gapless、下载、缓存、转码、解灰、代理或随机 IP。
- 未停止或重启 Roon；未修改防火墙、端口或安全边界。
- TASK-023 在本任务真实 Gate 完成前未开始；Owner 已在本报告关闭后授权继续 TASK-023。

## 最终状态

**TASK-022：PASS。**

两首真实 Roon 歌曲已完整自然播放，Signal Path 均确认无损，队列结束后脱敏状态回到 idle 且无活动播放残留。TASK-022 已关闭，后续任务由 Owner 单独授权后开始。
