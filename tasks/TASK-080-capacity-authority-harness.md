# TASK-080：Clean-clone 容量 Authority 接线

基线 `d98eff24c0085ad8a340457f58dc3334709ca241`，分支 `codex/task-080-capacity-authority-harness`，独立树 `worktree/task-080-capacity-authority-harness`。TASK-079 的软件控制面与 PR #21 六项 Harness/E2E 修复已经合入 `v3-integration`；本任务只解决 clean-clone 入口与正式一次性 authority/window 合同互相冲突的问题。

## 目标

1. clean-clone 入口可以安装固定依赖、构建 contracts，并对实际 `os.tmpdir()` 做只读空间预检。
2. 没有 issuer 产生的 `ISSUED_NOT_EXECUTED` 收据时，入口必须返回 `AUTHORITY_REQUIRED`，不得启动 benchmark、不得输出正式 `PASS`。
3. 有合法收据时，入口只能消费收据内由既有 queued-stop issuer 固定生成的 installed supervisor 命令；不得自行拼接 worker 命令、window、UUID、label 或 authority。
4. 入口只报告消费是否启动/退出；正式容量结论仍由 authority 绑定的 close/receipt 验证器决定，进程 exit 0 不能直接升级为 Gate E PASS。
5. 本任务不签发或消费真实窗口，不运行105轮 benchmark，不清理历史证据，不操作设备、Roon、Logic、真实资料或 Owner 验收。

## TDD 验收

- RED：环境、依赖与空间全就绪但没有 authority 收据时，旧入口仍直接启动 benchmark 并输出 `CAPACITY_CLASSIFICATION=PASS`。
- GREEN：无收据时 benchmark 调用数为0且返回 `AUTHORITY_REQUIRED`。
- GREEN：合法收据只触发一次收据固定的 installed supervisor 命令；直接 worker seam 永远不可达。
- GREEN：参数形状、收据 schema、window SHA、候选 root/branch/HEAD、installed supervisor/consumer 命令或文件身份漂移均 fail-closed，benchmark 与 consumer 调用数均为0。
- GREEN：空间不足、依赖/构建失败、dirty clone、非 Node 22 继续在任何 authority 消费前停止。

## 允许文件

- `tasks/TASK-080-capacity-authority-harness.md`
- `tasks/00_TASK_INDEX.md`
- `project/WAVE-5.yaml`
- `project/V3_TODO.md`
- `project/STATUS.json`
- `scripts/ci/run-v3-capacity-clean-clone.mjs`
- `scripts/ci/test/run-v3-capacity-clean-clone.test.mjs`
- `reports/TASK-080_RESULT.md`

除非新的最小 RED 证明现有 issuer/supervisor 合同缺少必要字段，本任务不修改 TASK-079 issuer、supervisor、lineage 合同、Bridge Core benchmark、应用、数据库或设备代码。
