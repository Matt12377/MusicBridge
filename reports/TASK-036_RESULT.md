# TASK-036 结果报告：Main CI 稳定化与 Beta.2 重建基线

## 任务身份

- 任务：TASK-036 — Main CI Stabilization & Beta.2 Rebaseline
- 基线 SHA：`8948aead451e38dddaf7d94756bbebdee946c6b0`（PR #1 合并提交，origin/main）
- 工作分支：`codex/task-036-main-stabilization`
- 实现提交：`05387cb7c0ad4287d52508efc9387fe9c8ca69c8`（ci 分层）；控制面同步 `559107dbcc8aafc4ef1d3b839a4d2ded7123ec4b`；beta.2 标注 `0a4ff2261b80ae9960f329e2e286a4c8fcecdbe0`
- 未 push、未创建 PR、未合并、未发布 release

## 一、CI 测试分层修复（问题 A）

**根因确认**：Ubuntu Runner 启动 Electron 43 时 `chrome-sandbox` 不满足 `root:root` + setuid `4755` 要求，Electron 按安全策略退出。旧 workflow 把 Electron 启动测试放在 Ubuntu（verify 的 xvfb startup 步骤、security 的全量 desktop suite、electron-e2e 整体在 ubuntu）。

**新分层**：

| 层 | Runner | 内容 |
|---|---|---|
| verify.yml | ubuntu | frozen install、control-plane、boundaries、cycles、`pnpm verify`（typecheck+平台无关单测+production build）、`git diff --check`；**无任何 Electron 步骤** |
| verify.yml `dependency-audit` job | ubuntu | 独立 Job，不因其他步骤失败被跳过 |
| security.yml | ubuntu | control-plane、boundaries、cycles、定向平台无关安全测试（`test:security`：security/ipc-security/csp/protocol/preload/credential-provisioning/credential-vault）；不再把 Electron 启动伪装成 security-focused |
| electron-e2e.yml `macos-electron-gate` | **macos-latest** | development/production startup、Core crash/restart、safeStorage vault、credential cold-start recovery（`test:electron`）、Playwright E2E 含窗口生命周期与退出清理（`test:e2e`）；支持 `pull_request` 触发 |

- Desktop 脚本拆分：`test:unit` / `test:electron` / `test:security` / `test:startup` / `test:e2e`；`startup.test.ts` 移至 `apps/desktop/electron-gate/`，不再被普通单测 glob 无条件包含；根目录 `pnpm verify` 在 Ubuntu 不启动 Electron。
- macOS 安装保持 `--frozen-lockfile --ignore-scripts`，Electron 二进制用官方 `install.js` 从锁定树补齐；未升级任何依赖。
- **零 sandbox 绕过**：无 `--no-sandbox`、无 `ELECTRON_DISABLE_SANDBOX`、无安全配置降级。
- 加固反向边界（verify-boundaries.mjs）：verify/security workflow 出现任何 Electron 启动步骤即 FAIL；macOS Gate 必须含 `runs-on: macos-latest` + `test:electron` + `test:e2e`。

## 二、控制面同步（问题 B）

- STATUS/WAVE/任务索引正式登记 TASK-033/034/035/036；WAVE order 补全至 `…032→033→034→035→036→040→041`。
- 新增集成补录：TASK-034、TASK-035（按任务指定），另增 TASK-033（其 RESULT 声称“未合并”，按加强检查项要求一并补录——超出原四文件清单的增量，特此说明）。
- 补录记录：PR #1 已合并、merge commit `8948aead…`、合并前 GitHub verify/security 因 Linux Electron sandbox 失败、非已证实功能回归。
- `verify-control-plane.mjs` 加强：STATUS↔WAVE 活动 task/branch/base 一致；当前任务在索引中且存在定义文件或报告；SHA 格式校验 + `git cat-file` 验证在 Git 历史中可解析（verify/security workflow 相应改 `fetch-depth: 0`）；wave 全序检查；已合并任务的“未推送/未合并”表述必须有集成补录；RELEASE_NOTES 必须包含 package 版本、beta 验收报告不得无声采用新版本号。

## 三、Beta.2 重建基线（问题 C）

- RELEASE_NOTES 增加 beta.2 状态段（重建基线中、未发布、无任何构建证据），beta.1 章节原样保留；KNOWN_ISSUES 加 beta.2 边界说明。
- 新增 `reports/BETA2_REBASELINE_CHECKLIST.md`：冻结 SHA→干净重建→重算 hash→Fuses/签名复审→安装冒烟→自动化 Gate→Core Mac 健康 Gate→Owner 20 项验收→文档翻转的完整待执行清单。
- 未伪造任何 DMG hash、ASAR hash、签名结果或 Owner 结论；未覆盖 beta.1 历史。

## 四、验证记录（本机 macOS 开发机）

| Gate | 结果 |
|---|---|
| `corepack pnpm@10.17.1 install --frozen-lockfile --ignore-scripts` | PASS |
| 三包 typecheck | PASS |
| Contracts 测试 19/19 | PASS |
| Bridge Core 测试 174/174 | PASS |
| Desktop unit 66/66（不含 Electron） | PASS |
| Desktop 定向 security 19/19 | PASS |
| Production build | PASS |
| `node scripts/ci/verify-control-plane.mjs` | PASS |
| `node scripts/ci/verify-boundaries.mjs` | PASS |
| `node scripts/ci/verify-cycles.mjs` | PASS（56 文件） |
| `git diff --check` | PASS |
| `test:electron`（startup dev/prod、crash、vault、recovery）3/3 | PASS |
| `test:e2e` Playwright 8/8（含 axe、窗口隐藏/恢复、退出清理） | PASS |

无 FAIL、无 BLOCKED。GitHub Actions 上的实际运行需 Owner 授权 push 后观察。

## 五、main 分支保护清单（问题 D，供 Owner 手工配置）

当前状态：仓库为 Public，main 未设分支保护。建议在 GitHub → Settings → Branches → Add rule 配置：

1. Branch name pattern：`main`
2. ✅ Require a pull request before merging（Required approvals ≥ 1）
3. ✅ Require status checks to pass：
   - `verify`（ubuntu 平台无关层）
   - `dependency-audit`
   - `static-security`
   - `macos-electron-gate`（electron-e2e workflow）
4. ✅ Require branches to be up to date before merging（基于最新 main）
5. ✅ Require conversation resolution before merging
6. ✅ Do not allow force pushes
7. ✅ Do not allow deletions
8. ⬜ 不勾选 “Do not allow bypassing”（管理员默认不得绕过 → 即需要勾选允许绕过的反义；实际操作：保持管理员也受限则不开启任何 bypass 例外）

可见性保持 Public，本任务未改动任何仓库设置。

## 六、仍需 Owner 完成

1. 审查本分支后授权 push / 创建 PR / 合并（本报告提交时均未执行）。
2. 按第五节清单配置 main 分支保护。
3. 推送后在 GitHub Actions 观察 4 个 workflow 首次全绿（Ubuntu 不再启动 Electron）。
4. 指定 beta.2 冻结 SHA 并启动 `reports/BETA2_REBASELINE_CHECKLIST.md` 流程。
5. Owner-only Gate 维持不变：真实 Provider 登录、真实 Roon 播放、Core Mac 双机 Remote Core 验收、beta.2 统一实机验收。

## 七、结论

**PASS — LOCAL GATES COMPLETE; PUSH/PR/MERGE 与 GitHub 设置为 OWNER-AUTHORIZED 后续动作**

四类目标全部落地：CI 分层修复且零 sandbox 绕过、控制面与真实仓库状态一致、beta.2 明确处于重建基线阶段并具备待执行结构、main 保护清单就绪。所有本机 Gate PASS，无 BLOCKED。建议 Owner 审查后合并本分支。
