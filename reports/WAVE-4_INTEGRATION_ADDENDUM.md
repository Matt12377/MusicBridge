# WAVE-4 歌词功能线集成补录

## Owner 授权与验收边界

2026-08-27，Owner 明确要求将当前本地音乐匹配网易云歌词功能直接合并到 main，并准备 v3。该授权取代各 Slice 历史报告中等待整体验收后才能合并的限制，仅授权代码集成和下一阶段准备。

- Synthetic 自动验证与真实 Roon/NetEase 工程验收、Owner 产品接受分别记录。
- 真实验收矩阵尚未完成，TASK-047 保持 carryover，不标记 complete。
- 不修改音频来源，不发布新版本，不执行签名、公证或部署。
- 歌名正则清洗仅完成可行性分析，未实现，不夹带到本次集成。

## 精确来源与合并方式

- 集成前 main：`207f7f04bc11fd4dcf7e6214ab705e999ee6f559`。
- 已验证功能来源：`f4bc89306302c7f86cf74209637249d002a8afa1`。
- 最终功能分支：`codex/task-047-local-lyrics-acceptance`。
- 依赖链：设计 PR #7 → TASK-042/#8 → TASK-043/#9 → TASK-044/#10 → TASK-045/#11 → TASK-046/#12 → TASK-047/#13。
- 已逐段执行 `git merge-base --is-ancestor`，七段均 exit 0；末端包含全部前置提交。
- 将 [PR #13](https://github.com/Matt12377/MusicBridge/pull/13) 的目标改为 main，通过 merge commit 整体集成，保留各任务实现、报告和身份提交，不 squash、不重写历史。
- 本补录及状态修订仅涉及文档；源码、测试和 lockfile 与上述功能来源一致。
- 本补录提交由后续独立 STATUS 身份提交记录。最终合并 SHA、合并时间和最终远端 Gate 以 PR #13 和 GitHub Actions 为准，不在合并前预填成功结果。

## 验证证据

本轮已在线核对来源 `f4bc893` 的 GitHub verify、dependency-audit、static-security 和 macos-electron-gate，全部 SUCCESS。该证据只对应此来源 SHA；追加文档后的最终 PR HEAD 仍需重新检查 Gate，通过后才能执行合并。

本轮在 TASK-047 工作树使用 Node 22.23.2 / pnpm 10.17.1 执行：

| 验证 | 结果 |
|---|---|
| `corepack pnpm@10.17.1 verify` | exit 0；Contracts 27/27、Core 422/422、Desktop 162/162，类型检查及生产构建通过 |
| `corepack pnpm@10.17.1 test:security` | exit 0；22/22 |
| control-plane / boundaries / cycles | 分别 exit 0；PASS / PASS / PASS（98 files） |
| `git diff --check` | exit 0 |
| 来源 SHA 对比 apps、packages、package.json、pnpm-lock.yaml | exit 0；无源码、测试或依赖差异 |

本轮不在本地启动 Electron、不连接真实账号或 Roon。最终 Electron/E2E 验证由 PR 的 macOS 合成 Gate 执行，不替代真实验收。

## 工作区保护

TASK-047 中既有未跟踪的桌面测试结果保留，不暂存、不清理、不用于真实账号验收。main 中既有的工作树目录保留。旧功能分支与工作树不删除。

## v3 交接

从 PR #13 合并后的最新 main 创建 `codex/v3`，与既有验收工作树隔离。准备范围及未解决问题见 [v3 准备说明](../project/V3_PREPARATION.md)。这里的 v3 是开发阶段名称；现有包版本仍为 `0.1.0-beta.2`。
