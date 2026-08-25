# TASK-037 搜索回归修复结果

## 结果

**PASS（自动 Gate）**

本报告是 TASK-037 完成后的搜索回归修复补录，范围只覆盖搜索三类结果、错误映射和搜索快照缓存。没有修改任务控制面、依赖版本、Provider 版本、Roon、端口或安全边界。

真实 Provider、真实账号、真实 Roon 和 Owner 实机验收不在本轮自动 Gate 范围内，继续作为 Owner-only carryover；自动验证只使用 synthetic/fake 边界。

## Git 身份

- 固定工作树：`/Users/yihe/VSCode/MusicBridge/worktree/bugfix`
- 分支：`codex/bugfix`
- 修复基线 SHA：`569c3c159af950fa173acd717b1ef239c5742de5`
- 实现提交：`974e245cb64a3d5b8c0d37e4c3dc896a95fab454`
- 实现提交信息：`fix(search): avoid authenticated search endpoint failures`
- 报告提交：`96a900468d9b38832681b13d1838785c3e8a657d`（独立文档提交）。
- 下一分支基线：`974e245cb64a3d5b8c0d37e4c3dc896a95fab454`；本轮不启动新的编号任务，不修改 `project/STATUS.json` 或 `project/WAVE-3.yaml`。

## 根因与修复

### 根因

Provider 的公开搜索接口在携带当前账户凭据时会拒绝请求；最小回归 Fake 将该请求建模为 HTTP 405。此前三类搜索都会把凭据字段传入 `search`，所以同一个查询的艺人、专辑和单曲请求一起失败。查询快照随后可能把失败结果当成可复用缓存，导致 Core 恢复后继续复现旧错误。Electron IPC 包装错误也会把内部调用文本直接显示到搜索区。

### 修复

- `NeteaseClient` 仍保留登录凭据门禁，但三类公开搜索请求不再把账户凭据放进搜索参数；需要凭据的收藏、歌单、详情和播放路径不变。
- 搜索快照只有在三类分区都成功且结果未过期时才进入缓存；失败或部分失败快照不会污染同词重试。
- Renderer 搜索错误把 Electron IPC/Core 内部文本转换为公开、可操作的中文提示，同时保留 `AUTH_REQUIRED` 与 `AUTH_EXPIRED` 语义。

## 修改文件

- `packages/bridge-core/src/netease/client.ts`
- `packages/bridge-core/test/library.test.ts`
- `packages/bridge-core/test/search.test.ts`
- `apps/desktop/src/renderer/src/composables/search.ts`
- `apps/desktop/test/searchAggregation.test.ts`

没有修改 `package.json`、`pnpm-lock.yaml`、contracts、`project/STATUS.json`、`project/WAVE-3.yaml`、Provider 依赖、安全开关、端口或 Roon 集成。

## TDD 证据

先保留新增回归测试并暂时恢复旧实现，聚焦测试按预期变红：

- Bridge Core：13 项中 2 项失败，分别暴露凭据字段转发和连续搜索 405。
- Desktop：6 项中 2 项失败，分别暴露失败快照缓存和 IPC 内部错误穿透。
- 该命令退出码为 1。

恢复最小修复后，聚焦测试全部通过：

- Bridge Core `search.test.ts + library.test.ts`：13/13，退出码 0。
- Desktop `searchAggregation.test.ts`：6/6，退出码 0。

## 验证

| 命令 / Gate | 结果 |
| --- | --- |
| `corepack pnpm@10.17.1 install --frozen-lockfile --ignore-scripts` | PASS，退出码 0 |
| `corepack pnpm@10.17.1 verify` | PASS，退出码 0；Contracts 20/20、Bridge Core 199/199、Desktop 94/94，typecheck/build 通过 |
| `corepack pnpm@10.17.1 --filter @music-bridge/desktop run test:security` | PASS，19/19，退出码 0 |
| `corepack pnpm@10.17.1 --filter @music-bridge/desktop run test:electron` | PASS，4/4，退出码 0 |
| `corepack pnpm@10.17.1 --filter @music-bridge/desktop run test:e2e` | PASS，Playwright 10/10，退出码 0 |
| `node scripts/ci/verify-control-plane.mjs` | `CONTROL_PLANE=PASS`，退出码 0 |
| `node scripts/ci/verify-boundaries.mjs` | `BOUNDARIES=PASS`，退出码 0 |
| `node scripts/ci/verify-cycles.mjs` | `CYCLES=PASS files=62`，退出码 0 |
| `NPM_CONFIG_REGISTRY=https://registry.npmjs.org corepack pnpm@10.17.1 audit --prod --audit-level high` | PASS，`No known vulnerabilities found` |
| `git diff --check` | PASS，退出码 0 |

本机默认 registry 的审计端点不提供 audit API，首次审计得到 `ERR_PNPM_AUDIT_ENDPOINT_NOT_EXISTS`；按项目既有验证约定只做命令级官方 registry 覆盖后通过，未修改仓库配置。

## 安全检查

- 搜索参数不再携带账户凭据；测试只使用 synthetic 值，不包含真实账号数据。
- Renderer 只接收公开领域结果和中文错误提示，不接收 Provider 原始响应、Cookie、上游 URL 或内部栈。
- `verify-boundaries`、`test:security`、`git diff --check` 均通过。
- 未新增 `[DEBUG-...]` 日志；搜索源码和测试目录未发现残留调试标记。

## 未完成或残余风险

- 未使用真实 Provider/账号复验搜索结果；需要 Owner 在本机登录态下确认不同关键词连续搜索及登录过期恢复。
- 未使用真实 Roon；该修复不涉及播放链路。
- `apps/desktop/test-results/` 是现有未跟踪测试产物，本轮未暂存、未删除，按工作树保护规则保留。

## 下一任务是否可开始

**NO。** 本轮只完成 TASK-037 搜索回归修复补录；等待 Owner 对真实 Provider 搜索和当前分支交付状态确认，不自行推进下一编号任务。
