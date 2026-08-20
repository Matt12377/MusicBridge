# TASK-031 — 诊断、崩溃恢复与长队列

## 目标

提供脱敏诊断导出，并完成稳定性 Gate。

## 测试

- 30 首连续播放。
- 10 次冷启动。
- 快速 next/stop 压力。
- Roon 重启。
- 网络短断。
- Core 崩溃与一次自动重启。

## Exit Gate

无内存持续增长、token/session/listener 残留；诊断包通过秘密扫描。
