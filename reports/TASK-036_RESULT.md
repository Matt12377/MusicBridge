# TASK-036 结果报告：Main CI 稳定化、Beta.2 重建基线与 Electron 凭据恢复

## 任务身份与 GitHub 状态

- 任务：TASK-036 — Main CI Stabilization & Beta.2 Rebaseline
- 基线 SHA：`8948aead451e38dddaf7d94756bbebdee946c6b0`（`origin/main`）
- 工作分支：`codex/task-036-main-stabilization`
- PR：`#2`，base=`main`，head=`codex/task-036-main-stabilization`，状态 **Open**
- 本轮修复后的实现 HEAD：`39db58cf22f1eaf33400c66396c49f43c0b7c6d2`
- PR #2 当前未合并，未发布 Release；PR 的最终 HEAD 还会包含本报告提交以及后续只更新 `project/STATUS.json` 的 identity commit。
- 初始报告提交：`5a2ea20465332cc9fc3dda1fa1bea5c659465bfe`
- 最终修订后的报告提交由后续 STATUS identity commit 的 `reportCommit` 锁定；最终身份 SHA 在交付记录中给出。

实现提交（基于 TASK-036 基线的完整序列）：

1. `05387cb7c0ad4287d52508efc9387fe9c8ca69c8` — `ci: split platform-independent tests from macOS Electron gate`
2. `559107dbcc8aafc4ef1d3b839a4d2ded7123ec4b` — `chore: sync control plane with merged main state`
3. `0a4ff2261b80ae9960f329e2e286a4c8fcecdbe0` — `docs: mark beta.2 as rebaselining stage`
4. `39db58cf22f1eaf33400c66396c49f43c0b7c6d2` — `fix: add true Electron cold-start credential gate`

## 一、CI 分层与必需 Check

当前由三个 Workflow 提供四个逻辑必需 Check，不是“四个 workflow”：

| Workflow | Job / Check | Runner | 范围 |
|---|---|---|---|
| `verify.yml` | `verify` | `ubuntu-latest` | frozen install、control-plane、boundaries、cycles、平台无关 verify、diff check |
| `verify.yml` | `dependency-audit` | `ubuntu-latest` | 生产依赖审计 |
| `security.yml` | `static-security` | `ubuntu-latest` | control-plane、边界、cycles、定向安全测试 |
| `electron-e2e.yml` | `macos-electron-gate` | `macos-latest` | Electron Gate 与 Playwright E2E |

`electron-e2e.yml` 保留 `pull_request` 触发器，用于为 PR 提供必需的 `macos-electron-gate`；这是本任务的明确要求，不是越界变更。Ubuntu Workflow 不启动 Electron，也没有加入 `--no-sandbox`、`ELECTRON_DISABLE_SANDBOX` 或其他安全绕过。

## 二、凭据恢复 Gate 修复

### 1. Core restart credential recovery

这是同一 Electron Main 进程内的语义，测试名称和 marker 已单独改为 `Core restart credential recovery`：

- Main 在隔离临时 userData 中写入 synthetic credential 到 safeStorage vault；
- Core utility process 通过 crash probe 崩溃并由 `CoreSupervisor` 重启；
- `onReady` 通过 vault 读取并重新注入凭据；
- Gate 同时检查 `supervisor.restarts === 1`、Core ready、Provider=`configured` 和 vault=`configured`；
- 结束时删除 synthetic vault 并关闭 Core/Electron。

它不再被描述为 Electron cold start。

### 2. Electron cold-start credential recovery

这是两个独立 Electron OS 进程的语义，由 `scripts/cold-start-credential-gate.mjs` 串行执行：

- 为本次运行创建唯一的 `musicbridge-task036-cold-start-*` 临时 userData 目录；
- Electron 进程 A 使用 `seed` 阶段写入 synthetic credential，并完整退出；A 必须退出码为 `0`；
- 检查同一 vault 已生成、权限为 `0600`，且文件不含 synthetic credential 明文；
- 只有 A 完整退出后才启动 Electron 进程 B；
- A、B 均严格删除 `NETEASE_COOKIE`、`MUSIC_U`、`__csrf`、`MUSIC_A`、`MUSIC_R_T`、`MUSIC_R_I`、`NETEASE_TOKEN` 和 `NETEASE_CREDENTIAL` 等明文凭据环境变量；
- B 使用同一个隔离 userData，以 `restore` 阶段从磁盘 safeStorage vault 读取并恢复 Provider=`configured`；B 必须退出码为 `0`；
- B 完成后删除 synthetic vault，最后递归清理临时 userData 目录。

启动测试配置只接受 `MUSIC_BRIDGE_STARTUP_USER_DATA_DIR`、`MUSIC_BRIDGE_CREDENTIAL_COLD_START_STAGE=seed|restore` 和命名 Gate 变量；这些变量必须在 `MUSIC_BRIDGE_STARTUP_TEST=1` 下使用，路径必须是系统 temp 目录下的限定名称。旧的 `MUSIC_BRIDGE_CREDENTIAL_RECOVERY_GATE` 会 fail closed。

## 三、最终本机验证（实际退出码）

以下均为修复后当前工作树实际运行结果；`exit=0` 为命令进程实际退出码：

| 验证项 | 实际结果 |
|---|---|
| `corepack pnpm@10.17.1 install --frozen-lockfile --ignore-scripts` | `exit=0` |
| `corepack pnpm@10.17.1 run typecheck` | `exit=0` |
| `corepack pnpm@10.17.1 --filter @music-bridge/contracts run test` | `19/19`，`exit=0` |
| `corepack pnpm@10.17.1 --filter @music-bridge/bridge-core run test` | `174/174`，`exit=0` |
| `corepack pnpm@10.17.1 --filter @music-bridge/desktop run test:unit` | `69/69`，`exit=0` |
| `corepack pnpm@10.17.1 --filter @music-bridge/desktop run test:security` | `19/19`，`exit=0` |
| `corepack pnpm@10.17.1 run build` | production build，`exit=0` |
| `node scripts/ci/verify-control-plane.mjs` | `CONTROL_PLANE=PASS`，`exit=0` |
| `node scripts/ci/verify-boundaries.mjs` | `BOUNDARIES=PASS`，`exit=0` |
| `node scripts/ci/verify-cycles.mjs` | `CYCLES=PASS files=57`，`exit=0` |
| `git diff --check` | `exit=0` |
| `corepack pnpm@10.17.1 --filter @music-bridge/desktop run test:electron` | 4/4：启动/Crash、safeStorage、同进程 Core restart、双进程 Electron cold start，`exit=0` |
| `corepack pnpm@10.17.1 --filter @music-bridge/desktop run test:e2e` | Playwright `8/8`，`exit=0` |

本机验证只使用 synthetic credential、synthetic Core/Provider 和 fake 测试边界；没有访问真实 Provider、真实 Roon、SSH 或账号。

## 四、完成收尾时的 Git 身份证据

- `git rev-parse origin/main`：`8948aead451e38dddaf7d94756bbebdee946c6b0`
- `git rev-parse HEAD`：本轮实现提交为 `39db58cf22f1eaf33400c66396c49f43c0b7c6d2`；报告提交和最终 STATUS identity commit 会顺序追加，最终 HEAD 以身份提交为准。
- 最终 `git status --short --branch` 必须如实保留本地 worktree 容器：

  ```text
  ## codex/task-036-main-stabilization...origin/codex/task-036-main-stabilization
  ?? worktree/
  ```

  `?? worktree/` 是本地允许保留的工作树容器，未进入 PR，也未影响产品工作树；因此不能把工作区描述成完全没有未跟踪内容。

## 五、main 分支保护清单（仍待 Owner 在 GitHub 配置）

目标是管理员也不得绕过时，必须勾选 **Do not allow bypassing the above settings**。当前若仓库仍只有 Owner 一名真人写权限用户，清单应为：

1. `Require a pull request before merging`：开启；`Required approvals` 为 `0`，或不启用 Required approvals。
2. Required Checks：`verify`、`dependency-audit`、`static-security`、`macos-electron-gate`。
3. `Require branches to be up to date before merging`：开启。
4. `Require conversation resolution before merging`：开启。
5. `Do not allow bypassing the above settings`：**勾选**。
6. `Allow force pushes`：关闭。
7. `Allow deletions`：关闭。

只有存在另一位具备写权限、能够真正审批的真人 GitHub 协作者时，`Required approvals` 才设置为 `≥1`；PR 作者不能批准自己的 PR。当前分支保护配置仍属于 Owner carryover，本任务未伪造 GitHub 设置已完成。

## 六、STATUS、carryover 与下一基线

修复期间 `project/STATUS.json` 已恢复为 `in_progress`，并移除 `local-pass-awaiting-push`。自动化与安全 Gate 的状态按事实记录为：旧 PR HEAD 的 GitHub PR automated/security Gate 已通过，新 HEAD 需重新运行；真实 Provider/Roon 仍为 Owner-only pending。完成新一轮远端 Check 后，最终 STATUS identity commit 才将 `state` 改为 `complete`，并将 `reportCommit` 指向本报告最终提交。

明确 carryover：

- 真实 Provider；
- 真实 Roon；
- Remote Core 双机 Owner Gate；
- beta.2 DMG/hash/signing/Owner acceptance；
- main 分支保护仍待 Owner 配置。

下一分支基线：**PR #2 合并后的 main merge SHA**；合并前不预填伪造 SHA。

## 七、结论

本报告在当前本地修复阶段结论为：**LOCAL PASS；PR #2 新 HEAD 的四个远端必需 Check 仍待重新运行，暂不宣称完整 PASS，也不执行合并。**

本任务不修改产品功能、Provider、Roon、Remote Core、UI、版本号或 beta.1 历史证据。
