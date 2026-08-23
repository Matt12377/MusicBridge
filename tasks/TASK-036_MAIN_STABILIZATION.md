# TASK-036 — Main CI Stabilization & Beta.2 Rebaseline

## 背景与触发

PR #1 合并后，GitHub Actions 的 `verify` 与 `security` workflow 失败。根因是 Ubuntu Runner 启动 Electron 43 时 `chrome-sandbox` 不满足 `root:root` + `4755` 权限要求，Electron 按安全策略主动退出。这是 CI 测试分层问题，不是已证实的播放器功能回归。

同时，项目控制面（STATUS/WAVE/任务索引）停留在 TASK-035 合并前状态，package 版本已到 `0.1.0-beta.2` 但发布文档仍绑定 beta.1。

## 目标（仅四类）

A. **修复 GitHub Actions 测试分层**
   - 平台无关层（Ubuntu）：Contracts、Bridge Core、不启动 Electron 的 Desktop 单测、typecheck、production build、control-plane、boundaries、cycles、dependency audit、`git diff --check`。
   - macOS Electron Gate（macos runner）：development/production startup、Core crash/restart、safeStorage vault、credential cold-start recovery、Electron Playwright E2E、窗口生命周期与退出清理。
   - Desktop 脚本拆分为 `test:unit` / `test:electron` / `test:security` / `test:startup` / `test:e2e`。
   - 根目录 `pnpm verify` 在 Ubuntu 不隐式启动 Electron；startup gate 从普通单测 glob 中移出。
   - dependency audit 为独立 Job，不被其他步骤失败连带跳过。
   - 全部安装保持 frozen lockfile；禁止一切 sandbox 绕过手段。

B. **修复控制面与真实仓库状态的偏差**
   - 正式登记 TASK-033/034/035/036；STATUS 与 WAVE 的活动任务/分支/基线一致。
   - 为已合并任务补充集成补录，避免历史“未推送/未合并”表述被误读为当前状态。

C. **建立 beta.2 候选基线结构**：只做标记与待执行清单，不伪造构建证据。

D. **main 分支保护清单**：写入 TASK-036 结果报告，供 Owner 手工配置。

## 明确不做

- 不改网易云业务逻辑、Roon 播放语义、Remote Core 功能设计、UI 视觉、端口、安全边界或 Provider 版本。
- 不升级任何依赖。
- 不修改旧报告的历史事实。
- 不伪造 beta.2 DMG/hash/签名/Owner 结论。
- 不 push、不创建 PR、不合并、不发 Release。

## 退出 Gate

1. 平台无关全套验证在本机全绿（contracts/bridge-core/desktop unit、typecheck、build、三份 ci 校验脚本、`git diff --check`）。
2. Mac 本机实跑 `test:electron`（startup/crash/vault/recovery）与 `test:e2e` 并记录；无法运行则记 BLOCKED。
3. 控制面四文件交叉一致，`node scripts/ci/verify-control-plane.mjs` PASS。
4. `reports/TASK-036_RESULT.md` 完成并给出每个 Gate 的 PASS/FAIL/BLOCKED 与 Owner 待办清单。

完成后状态才允许翻为 `complete` 或明确 `carryover`。
