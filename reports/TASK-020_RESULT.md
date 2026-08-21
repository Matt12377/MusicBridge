# TASK-020 结果报告：Provider 二维码登录状态机

## 结论

**PASS**

TASK-020 的实现、自动化 Gate、安全边界检查、真实 Provider 二维码扫码和完整应用重启恢复均已完成。Owner 确认全新二维码扫码后进入 `authorized`，完全退出并重新启动同一版本后授权状态仍保持 `authorized`，因此本任务的 Exit Gate 已全部关闭。

TASK-021 可按 Owner 已有授权继续执行。

## Git 身份

- WAVE：`WAVE-2`
- TASK：`TASK-020`
- 分支：`codex/wave-2-desktop-core`
- 基线 SHA：`3a0f24bdad8d8c1fe0dd39e9f3b62b541e468129`
- 实现 SHA：`87279a2a198b12477bfaf29286372f3e37e549a4`
- 实现 commit：`feat: add QR login state machine`
- 实现 commit 已推送到当前阶段分支。

## TASK-020R 修复与 Owner 实机 Gate（最终）

- 原始 TASK-020 实现 commit：`87279a2a198b12477bfaf29286372f3e37e549a4`
- TASK-020R 解析修复 commit：`0511564338771d5d0b3d2b59383abad2eeba69ff`
- 部署流程修复 commits：`bd051e225e890c53ed275c872e7f5bf76f8cdf65`、`c9454da03cac14a8bebd13723d97df614e746445`、`974844bb9cd261f54a94358c67af8efe8f9d5535`
- Core Mac 最终运行 release SHA：`974844bb9cd261f54a94358c67af8efe8f9d5535`
- bundle SHA-256：`dde00c12146703dab3013d41fcef770290478a538e40fced05d5f305b8dad264`
- `qrCodeDisplayed=true`
- `scanned=true`
- `authorized=true`
- `credentialPresent=true`
- `credentialVerified=true`
- `vaultSaved=true`
- `restartRestored=true`

Owner 确认真实扫码授权成功，并确认完全退出后重新启动同一版本无需重新扫码即可恢复授权状态。未执行歌曲播放。

## 实现范围

- 新增 QR 登录状态机：创建、等待、已扫描、已授权、过期、取消和错误状态。
- Provider key 仅保留在 Core 内部；公开状态只包含不透明 challenge ID、受限二维码图片和过期时间。
- QR poll 串行化，支持超时、取消优先和重复确认收敛；授权后只验证一次并返回一次内部凭据结果。
- 通过 Provider 登录状态接口验证账号状态后，Main 才写入 Electron safeStorage，并通过受控 Core 请求配置运行时。
- 新增 Main-only 内部 IPC 响应类型；Preload/Renderer 只接收公开状态，不能接收凭据。
- 退出登录先请求 Core 清理 Provider 会话，再删除 safeStorage 文件；远程注销失败时 Core 仍清理本地内存。
- Renderer 增加二维码展示、轮询、取消和退出登录界面；未增加 Node、Electron 或通用 IPC 访问。
- 更新 contracts、Core 事件、Main/Preload 边界与状态契约文档。

## 修改文件

- `apps/desktop/src/main/core-supervisor.ts`
- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/preload/api.ts`
- `apps/desktop/src/preload/index.ts`
- `apps/desktop/src/renderer/src/App.vue`
- `apps/desktop/src/renderer/src/style.css`
- `apps/desktop/test/core-supervisor.test.ts`
- `apps/desktop/test/preload.test.ts`
- `apps/desktop/test/renderer.test.ts`
- `docs/12_CONTRACTS_AND_STATE_MACHINES.md`
- `packages/bridge-core/src/netease/client.ts`
- `packages/bridge-core/src/netease/parse.ts`
- `packages/bridge-core/src/netease/qr-login.ts`
- `packages/bridge-core/src/runtime.ts`
- `packages/bridge-core/src/utility-main.ts`
- `packages/bridge-core/test/netease-client.test.ts`
- `packages/bridge-core/test/parse.test.ts`
- `packages/bridge-core/test/qr-login.test.ts`
- `packages/bridge-core/test/utility-ipc.test.ts`
- `packages/contracts/src/ipc.ts`
- `packages/contracts/src/state.ts`
- `packages/contracts/src/validator.ts`
- `packages/contracts/test/validator.test.ts`

未修改 `package.json`、lockfile、端口、Roon extension id、Provider 安全开关或 Stream Gateway 行为。

## 自动化验证

| Gate | 结果 |
| --- | --- |
| contracts typecheck | 退出码 `0` |
| contracts tests | `9/9`，退出码 `0` |
| bridge-core typecheck | 退出码 `0` |
| bridge-core tests | `100/100`，退出码 `0` |
| desktop typecheck | 退出码 `0` |
| desktop tests | `24/24`，退出码 `0` |
| Electron desktop startup Gate | 通过 |
| Electron Core crash/restart Gate | 通过 |
| Electron safeStorage synthetic Gate | 通过 |
| `corepack pnpm@10.17.1 verify` | 退出码 `0` |
| `git diff --check` | 退出码 `0` |

本节记录的是初始自动 Gate：测试只使用合成 QR 图片、challenge、登录状态和凭据占位值。真实扫码由 Owner 通过本地桌面界面完成；凭据、二维码内容、账号资料和 Provider 原始响应均未写入聊天、报告、Git 或日志。

## TASK-020R 最终自动复核

| Gate | 结果 |
| --- | --- |
| `corepack pnpm@10.17.1 verify` | 退出码 `0`；bridge-core `102/102`，desktop `24/24`，contracts `9/9` |
| `git diff --check` | 退出码 `0` |
| `package.json` / `pnpm-lock.yaml` | 无变化 |
| `parseLoginStatusResponse()` 真实 4.40.1 `body.data` 形状 | 通过 |
| 未签名 App 部署、Core runtime、Roon、loopback 和健康检查 | 通过 |
| 日志秘密扫描 | 通过；未输出匹配内容 |

## 安全检查

- Renderer 只暴露 `getAuthState`、`beginQrLogin`、`pollQrLogin`、`cancelQrLogin` 和 `logout` 等业务方法。
- 带凭据的 QR poll 响应只能由 Main 的显式内部 validator 接收；公开响应 validator 会拒绝该形状。
- Main 在收到授权结果后先完成 safeStorage 保存和 Core 配置，失败时清理本地保存与 Core 内存，并向 Renderer 返回通用失败。
- 日志、公开状态、事件和 Renderer 源码不包含 Provider 会话材料。
- 二维码图片仅接受受长度限制的 `data:image/*` 数据；不接受上游 URL、通用 URL、查询参数或外部页面跳转。
- 未新增 LAN 监听、远程控制、下载、缓存、转码、解灰、代理或随机 IP 行为。

## Exit Gate 状态

### 已通过

- 状态机等待 → 已扫描 → 已授权路径：自动测试通过。
- 过期、取消、取消优先于迟到响应：自动测试通过。
- 重复授权 poll 不重复返回内部凭据：自动测试通过。
- 登录状态验证失败时不进入授权状态：自动测试覆盖。
- safeStorage 加密保存、删除和启动注入路径：现有 Electron synthetic Gate 与 desktop 测试通过。

### Owner 实机 Gate（已完成）

- Owner 完成全新二维码扫码并确认授权：通过（`authorized=true`）。
- 完全退出并重新启动同一版本后授权状态保留：通过（`restartRestored=true`）。
- 未执行歌曲播放或 `POST /v1/play`。

## 未执行事项

- 未请求、读取、输出或记录真实 Provider 凭据。
- 未在命令行、报告或日志中输出 Provider 原始响应；真实登录仅通过本地桌面界面完成。
- 未播放歌曲，未执行播放接口。
- 未创建 PR、未合并、未发布。

## 下一步

**TASK-021：可开始。**

TASK-020 实机 Exit Gate 已通过；完成本报告关闭 commit 并推送后，按既有授权继续 TASK-021。
