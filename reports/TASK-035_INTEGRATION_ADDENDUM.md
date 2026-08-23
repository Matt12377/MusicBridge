# TASK-035 集成补录（Integration Addendum）

本文件只补充集成事实，不修改 `reports/TASK-035_RESULT.md` 的历史记录。

## 集成事实

- TASK-035 的工作分支 `codex/task-035-remote-core-development` 即 PR #1 的源分支，已合并进入 main。
- 分支最终尖端：`6b0c5e7`（`fix: harden remote Core tunnel diagnostics`），包含实现提交 `014ed21` 与后续诊断加固。
- 合并提交：`8948aead451e38dddaf7d94756bbebdee946c6b0`；该尖端是合并提交的父提交之一，已进入 main 历史。
- 原报告“未创建 PR、未合并、未 force-push、未发布 release”仅描述报告提交当时的状态，自 PR #1 合并起不再成立。

## 合并前的 Gate 状态

- PR #1 合并时，GitHub Actions 的 `verify` 与 `security` workflow 处于失败状态。
- 失败根因：Ubuntu Runner 启动 Electron 43 时 `chrome-sandbox` 权限不符合安全策略要求导致 Electron 退出；属 CI 测试分层缺陷。
- 该失败不是已证实的播放器或 Remote Core 功能回归；TASK-035 本机的 verify/E2E/startup/boundaries/cycles Gate 记录保持不变。

## 后续处理

CI 分层修复、控制面同步与 beta.2 重建基线由 TASK-036 承担（见 `reports/TASK-036_RESULT.md`）。
