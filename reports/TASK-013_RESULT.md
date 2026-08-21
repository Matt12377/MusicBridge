# TASK-013 结果报告：safeStorage 凭据保险库

## 结果

**PASS**

TASK-013 已完成。Main 进程使用 Electron safeStorage 异步 API 保存和读取 Provider 凭据；Renderer 没有读取凭据的接口；Core 只通过 Main 发起的受控 typed IPC 请求短暂获得运行时凭据。safeStorage 不可用、文件损坏、符号链接、删除和密钥轮换路径均有明确处理与测试。

TASK-020 可以开始实现；TASK-020 的真实扫码操作仍需 Owner 在本地完成，不能用自动测试替代。

## Git 身份

- WAVE：`WAVE-2`
- TASK：`TASK-013`
- 分支：`codex/wave-2-desktop-core`
- 基线 SHA：`c65d8a2498087256e7a254ddaeea913642de05e1`
- 实现 SHA：`f749400f254e7a8d4ca37608505a5736c64116af`
- 实现 commit：`feat: add safeStorage credential vault`
- 实现 commit 已推送到当前阶段分支。

## 修改文件

- `apps/desktop/src/main/credential-vault.ts`
- `apps/desktop/src/main/credential-provisioning.ts`
- `apps/desktop/src/main/index.ts`
- `apps/desktop/scripts/startup-gate.mjs`
- `apps/desktop/test/credential-vault.test.ts`
- `apps/desktop/test/credential-provisioning.test.ts`
- `apps/desktop/test/startup.test.ts`
- `packages/contracts/src/ipc.ts`
- `packages/contracts/src/validator.ts`
- `packages/contracts/test/validator.test.ts`
- `packages/bridge-core/src/netease/client.ts`
- `packages/bridge-core/src/runtime.ts`
- `packages/bridge-core/src/utility-main.ts`
- `packages/bridge-core/test/utility-ipc.test.ts`
- `docs/12_CONTRACTS_AND_STATE_MACHINES.md`

未修改 `package.json`、lockfile、端口、Roon extension id、loopback-only 规则、Provider 安全开关和 Stream Gateway 行为。

## 实现说明

### 加密存储

- 使用 `safeStorage.isAsyncEncryptionAvailable()`、`encryptStringAsync()` 和 `decryptStringAsync()`；没有退化到同步 API 或明文文件。
- 加密文件写入独立 data 目录，临时文件使用唯一名称，写入后通过原子 rename 替换目标。
- 目标文件必须是普通文件并保持 `600` 权限；读取拒绝符号链接、非普通文件、空文件、超限文件和无法解密的数据。
- 凭据长度受限；空值、换行和超限输入拒绝保存。
- safeStorage 不可用时保存直接拒绝；不存在明文 fallback。
- decrypt 返回密钥轮换标记时，读取路径会重新加密并原子替换存储文件。
- 删除后会再次确认文件不存在；Core 内存先清除，再删除本地加密文件。

### Main、Core 与 Renderer

- Main 启动时从 Core 子进程环境中移除 `NETEASE_COOKIE`。
- 既有 POC 环境输入只经过 safeStorage 迁移；迁移完成后从当前环境对象移除，不直接传入 Core 环境。
- Main 读取加密存储后，仅通过 `auth.setCredential` 受控 IPC 请求将凭据交给 Core；响应只返回公开状态。
- `auth.clearCredential` 用于清除 Core 内存中的凭据；Preload 没有暴露 set/clear credential 方法，Renderer 不能读取凭据。
- contracts 对受控请求做版本、长度、payload 和公开结果校验；凭据不进入 IPC 响应、Renderer 状态或日志。

## 自动验证

| 命令 / Gate | 结果 |
| --- | --- |
| `node --import tsx --test apps/desktop/test/credential-vault.test.ts` | 5/5，退出码 `0` |
| `node --import tsx --test apps/desktop/test/credential-provisioning.test.ts` | 3/3，退出码 `0` |
| 受控 IPC 测试 | 退出码 `0` |
| contracts 测试 | 8/8，退出码 `0` |
| desktop 测试 | 23/23，退出码 `0` |
| bridge-core 测试 | 91/91，退出码 `0` |
| contracts / bridge-core / desktop typecheck | 均退出码 `0` |
| `MUSIC_BRIDGE_CREDENTIAL_VAULT_GATE=1 node apps/desktop/scripts/startup-gate.mjs development` | `CREDENTIAL_VAULT_GATE=development`，退出码 `0` |
| `corepack pnpm@10.17.1 verify` | 退出码 `0` |
| `git diff --check` | 退出码 `0` |

真实 Electron Gate 使用合成测试值，只验证系统 safeStorage 的异步加密、读取、删除和不回显行为；没有读取、请求、输出或配置任何真实 Provider 凭据。

## 安全检查

- 没有把凭据放入命令参数、日志、报告、Git、Renderer 或公开 IPC 响应。
- 没有输出完整上游地址、授权头、令牌、账号信息或配置文件内容。
- 没有调用 Provider、播放歌曲、执行播放接口或修改 Roon。
- 没有新增 LAN 监听、远程控制、下载、缓存、转码、解灰、代理或随机 IP 行为。
- 未安装依赖、未升级依赖版本、未创建 PR、未合并、未发布。

## 未完成或残余风险

- TASK-013 不实现扫码登录；扫码状态机属于 TASK-020。
- 当前报告只证明凭据保险库和受控 Core 注入路径；不等同于真实账号登录或播放验收。
- 报告 commit 将以独立文档 commit 提交并推送。

## 下一任务是否可开始

**YES：TASK-020 可开始实现。**

TASK-020 的自动状态机测试可以继续执行；到真实扫码、真实账号和重启恢复的实机 Gate 时必须暂停，等待 Owner 人工操作和验收。
