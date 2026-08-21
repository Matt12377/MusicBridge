# Music Bridge for Roon 工程执行约定

## 任务推进

任务按 `tasks/00_TASK_INDEX.md` 与 `project/WAVE-3.yaml` 的线性顺序推进。每个任务必须有独立分支、实现提交、结果报告提交、自动 Gate；下一任务从上一任务最终 HEAD 创建。只有 Owner 明确放行的任务才可开始。

开始任务前，先确认项目根目录、当前分支、HEAD、远端对应分支和工作区状态。完成任务后必须复核 `git diff --check`、工作区清洁、远端 HEAD 和报告身份。使用明确文件路径暂存，保留与任务无关的用户变更。

## 证据边界

- 自动测试、打包测试、Core Mac 实机 Gate、Owner 验收、GitHub push 分开记录。
- 受控 Fake 可以覆盖破坏性或不可重复的故障，但不得伪称真实账号、真实 Roon 或真实听感证据。
- `project/STATUS.json` 是机器读取的当前任务状态；每个任务分支都必须更新它，并保持无用户内容、无凭据、无私密环境变量。
- 详细任务约束放在 `tasks/`；架构决策放在 `docs/adr/`；阶段风险放在 `project/RISK_REGISTER.md`。

## 安全边界

Provider 凭据只允许经本地安全通道和已批准的桌面保险库流动，不进入聊天、命令参数、Shell 历史、Git、报告、日志、Renderer 或 Roon。CI 永远使用合成数据，不连接真实 Provider、真实账号或真实 Roon。

Control API 与 Stream Gateway 只绑定 loopback。V1 不下载、缓存、转码、解灰、代理替换来源或随机 IP；不把上游 URL、Cookie、Token、Roon session ID 或内部错误栈暴露到公开合同。

## 验证入口

开发机使用 Node.js 22.x 与固定 Corepack pnpm 版本。标准本地入口是：

```bash
corepack pnpm@10.17.1 install --frozen-lockfile --ignore-scripts
corepack pnpm@10.17.1 verify
node scripts/ci/verify-control-plane.mjs
node scripts/ci/verify-boundaries.mjs
```

Electron 启动、utilityProcess crash/restart 和 safeStorage 测试使用 `apps/desktop/scripts/startup-gate.mjs`；不要在 CI 中写入真实 Provider 凭据或访问 Roon。

## 报告与停止

报告必须给出 base SHA、实现/报告提交、验证退出码、carryover 和下一分支基线。遇到凭据、真实账号、Owner 人工操作或安全/播放/登录恢复 fatal Gate 时停止并报告；非 fatal 的视觉或可选能力问题记录为 bounded carryover，不跳过验收标准。
