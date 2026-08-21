# WAVE-2 阶段验证报告

## 当前结论

**WAVE-2：PARTIAL WITH TASK-023 CARRYOVER。**

TASK-020、TASK-021、TASK-022 已有各自报告并完成对应 Owner Gate。TASK-023 的实现自动 Gate 已通过并已推送，但本轮新提交尚未部署到 Core Mac，因此 WAVE-2 暂不能标记为完整 PASS。

## 阶段组成

| TASK | 当前状态 | 依据 |
|---|---|---|
| TASK-020 | PASS | `reports/TASK-020_RESULT.md`：真实扫码授权与重启恢复已记录 |
| TASK-021 | PASS | `reports/TASK-021_RESULT.md`：真实桌面库界面 Gate 已记录 |
| TASK-022 | PASS | `reports/TASK-022_RESULT.md`：Owner 已确认两首歌曲自然完整播放、Signal Path 无损、队列结束无残留 |
| TASK-023 | PARTIAL | `reports/TASK-023_RESULT.md`：自动 Gate PASS，Core Mac 实机 Gate 待部署 |

## Git 与远端

- 阶段分支：`codex/wave-2-desktop-core`
- 当前 Head：`bb69fd9b891c192ce8032d93b7aae0383eccece9`
- 远端分支 Head：与本地一致
- TASK-023 实现提交：`feat: add metadata recovery and playback diagnostics`
- 未创建 PR、未合并、未 force-push。

## 自动阶段 Gate

- `corepack pnpm@10.17.1 verify`：PASS
- Contracts：12/12 PASS
- Bridge Core：127/127 PASS
- Desktop：26/26 PASS
- TypeScript 类型检查：PASS
- 生产构建：PASS
- Desktop startup Gate：PASS
- safeStorage credential vault Gate：PASS
- `corepack pnpm@10.17.1 doctor`：PASS
- `git diff --check`：PASS
- `package.json` 与 `pnpm-lock.yaml`：无变化
- 新增内容秘密扫描：PASS

## 阶段边界

- WAVE-1 的 POC-001 无损真实播放结论保持冻结，不被本轮自动化结果改写。
- 本轮未播放歌曲，不执行 `POST /v1/play`，不读取 Provider 原始响应。
- 本轮未修改端口、loopback-only 安全规则、Roon 配对、Provider 依赖或产品架构边界。
- TASK-030 及之后任务均未开始。

## 未完成的实机交接

当前 Codex Shell 没有可用的 Core Mac SSH ControlMaster：目标变量和 ControlMaster socket 均不存在。因此没有把 TASK-023 新提交部署到运行机，也没有将既有旧 release 的运行状态当作新提交证据。

WAVE-2 关闭前仍需完成：

1. 部署 `bb69fd9b891c192ce8032d93b7aae0383eccece9`；
2. 在不停止 Roon 的前提下复核 Provider 过期、URL 一次刷新、MediaError、ZoneLost 和 Core 重启恢复；
3. 检查运行后 `activeStreamCount=0`、无 active playback、loopback 监听和秘密扫描；
4. 更新 TASK-023 报告为最终 PASS 或准确的 BLOCKED/PARTIAL；
5. 由 Owner 决定是否放行 TASK-030。

## 最终状态

**WAVE-2：PARTIAL，TASK-023 实机 Gate carryover。**

**TASK-030：不可开始。**
