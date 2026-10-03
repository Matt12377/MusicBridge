# MBRS-000：真实基线与准入范围

更新：2026-10-04。当前产品 G0：**NOT_ADMITTED**；隔离准备模式：**EXPLICIT_PHASE_HANDOFF**。RUST-015 的限定本地交付完成不等于完整 Rust 迁移完成。

| 项目 | 本轮值与证据 |
|---|---|
| 仓库 | `/Volumes/LifeWeave/VSCode/MusicBridge`，公共 Git 目录为其 `.git` |
| 隔离树 | `worktree/mbrs-000-baseline-admission`；创建后本轮首次读取 `git status --short` 无输出 |
| 分支 / base | `codex/mbrs-000-baseline-admission` / `044e6b24edf81b64030d4c96741082670532971c` |
| RUST-015 实现 | `8c58fdee4309a781dbf6640d8aeba46bb8fe1bd3` |
| RUST-015 最终报告 | `044e6b24edf81b64030d4c96741082670532971c`；`git log -1 -- reports/RUST-015_CAPACITY_COST_VALIDATION.md` 与本轮 HEAD 相同 |
| 远端身份 | 本轮主控已核远端对应分支 HEAD 精确等于 final `044e6b24`；实现 `8c58fdee` 是该 final 的祖先；最新外置身份收据 `HANDOFF_INPUT_IDENTITY.json` 已按4109字节 / SHA256绑定到 `BASELINE_INPUTS.json`，8交接文件、96内部校验和与精确远端HEAD本轮匹配。旧报告中 `NOT_RUN_AT_THIS_REPORT_COMMIT` 是 push 前快照，不能作最新 push 结论 |
| 包身份 | PostRust v1.2，替代 v1.1 执行文本；126 条旧验收加 30 条衔接验收，共 156 条。包自身 PASS 不推出应用 PASS |
| 实际组件 | 见 `DATA_OWNERSHIP.md`、`REUSE_MAP_RESOLVED.md` 和 `BASELINE_INPUTS.json`，路径 / blob / SHA256 均绑定 base |
| 原线保护 | 旧 `worktree/rust-core-015` 已封存；其它83已注册工作树（含2不存在树）、18树非空状态与 WIP 按外置 `PROTECTED_WORKTREES_BEFORE.json` 保留。新树内 MBRS-000 范围之外不写入 |
| 退出范围 | 015 仅普通收藏只读容量 / 成本的限定本地交付；Node 控制面 / 数据 writer、Roon / Provider / 播放 / 录音未迁移。未找到完整迁移退出全部闭合的证据 |
| 准入模式 | Owner 已明确换届并连续执行 v1.2；仅先做 MBRS-000 与隔离基线 / 合同 / 纯规则 / 合成 HTTP / 安全离线修复。授权定位见 `AUTHORITY_SCOPE.md` |
| G0 阻塞 | R15-C06：继承 verify / Electron / Rust 工作流失败与生产 node-forge high 未闭合；修复责任保留原 Rust 基线前置，不能转入依赖 G0 的 MBRS-002～017 后形成循环 |
| 实机许可 | 此阶段无新增真实扫描目录、Zone、账号、媒体 LAN、发声、DSP / 音量、源写、Core 重启、main、安装替换或发布许可；仅阻断对应动作 |
| 有效 ADR | ADR-MBRS-001/002/003 是本轮规则记录；生效提交由本文件最后的 `git log` 解析，不以固定自引用 SHA 描述报告自身 |

实际构建 / 检查入口来自 base 的 `package.json`、AGENTS 与已封存 015 报告：Node 22.x，`corepack pnpm@10.17.1 install --frozen-lockfile --ignore-scripts`；`corepack pnpm@10.17.1 verify`；`node scripts/ci/verify-control-plane.mjs`；`node scripts/ci/verify-boundaries.mjs`；`node scripts/ci/verify-rust-core.mjs`；Electron 宿主入口为 `apps/desktop/scripts/startup-gate.mjs`。所有新构建、结果、日志、缓存和临时目录必须位于外置 `/Volumes/LifeWeave/Developer/CommandLine`，先确认挂载 / 可写。以上是入口盘点，本角色没有运行构建、软件回归或 App。

回归与失败分层见 `REGRESSION_LEDGER.json`；全部未完 Rust 事项见 `RUST_TO_MBRS_RESOLVED.json`。`project/POSTRUST_PLAN.json` 逐条保存任务与 156 验收，`project/POSTRUST_TODO.md` 提供人读入口。结构 Gate 只证明记录一致性与 Git 关联，不证明权限真实、应用行为或实机质量。
