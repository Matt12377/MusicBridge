# TASK-020 结果报告：Provider 二维码登录状态机

## 结论

**PARTIAL**

TASK-020 的实现、自动化 Gate 和安全边界检查已完成；真实 Provider 二维码扫码、真实账号登录后的应用重启恢复仍需 Owner 在本地完成，因此本任务的 Exit Gate 尚未全部关闭。

在 Owner 完成实机 Gate 前，不开始 TASK-021。

## Git 身份

- WAVE：`WAVE-2`
- TASK：`TASK-020`
- 分支：`codex/wave-2-desktop-core`
- 基线 SHA：`3a0f24bdad8d8c1fe0dd39e9f3b62b541e468129`
- 实现 SHA：`87279a2a198b12477bfaf29286372f3e37e549a4`
- 实现 commit：`feat: add QR login state machine`
- 实现 commit 已推送到当前阶段分支。

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

自动测试只使用合成 QR 图片、challenge、登录状态和凭据占位值；没有调用真实 Provider、没有读取或写入真实账号材料、没有播放歌曲，也没有执行播放接口。

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

### 待 Owner 实机完成

- 在本地桌面界面完成一次真实二维码扫码并确认授权状态。
- 观察授权后的应用重启，确认状态从 safeStorage 恢复为已授权；不向聊天、报告或 Git 提供任何会话材料。
- 如需验证真实过期、取消或重复扫码，使用本地界面完成；不得把账号材料复制到命令行参数、日志或报告。

## 未执行事项

- 未请求、读取、输出或记录真实 Provider 凭据。
- 未调用真实 Provider API。
- 未播放歌曲，未执行播放接口，未开始 TASK-021。
- 未创建 PR、未合并、未发布。

## 下一步

**TASK-021：暂缓。**

Owner 完成上述实机 Exit Gate 并确认结果后，才继续下一任务。
