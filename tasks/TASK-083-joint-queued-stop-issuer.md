# TASK-083：Joint Queued-stop 专用一次性 Issuer

基线 `bb41b96a981ed4554dedf0169af7df5f7931bf0b`，分支 `codex/task-083-joint-queued-stop-issuer`。TASK-082 已实现只消费 `joint:generate:PASS` 的 measure issuer；本任务完成正式路线 order 3 的 joint queued-stop issuer 与消费合同。

## 架构裁决

既有 `issue-v3-capacity-queued-stop-window.py` 是 objects-limit 历史恢复入口，固定冻结 measure-06、历史 issuer/prechild/process failure union、root replacement 与 objects-limit seed。共享 supervisor 的 queued-stop schema、authority、命令与artifact verifier也仍固定 objects-limit。仅放宽 argparse profile 会把错误 seed、错误 measure carryover与历史恢复计费包装成joint窗口。

因此 TASK-083 新增专用 joint queued-stop issuer，并为共享 supervisor/受控benchmark增加按 profile 分流的最小joint合同。objects-limit历史路径保持逐字段兼容。

## 验收合同

1. 只接受完整 `joint:measure:PASS` 原始 window、close、supervision、source/owned manifest、measurement与seed身份；独立复核verifiedComplete/verifiedPassed、1575 samples、105 round receipts、aggregate budget、source/fixture前后不变与authority stable。
2. joint queued-stop窗口固定5 warmup+100 formal、105个fresh child/process与独立clock，使用joint snapshot及measure terminal root，不继承objects-limit失败恢复链。
3. installed supervisor按 profile 分流，joint路径固定构造joint命令并验证joint output；objects-limit的冻结ID、恢复roots与历史回归不改变。
4. 任一非PASS、字段/Hash/路径/候选/toolchain漂移、dirty候选、重放、空间不足或发布失败均fail-closed。
5. 本任务只实现软件控制面，不签发或消费真实authority，不运行105轮正式容量，不打开设备，不升级Gate E、Gate B或Owner验收。

## TDD

- RED：专用joint queued-stop issuer不存在；共享supervisor与benchmark仍拒绝joint queued-stop。
- GREEN：完整合成joint measure PASS只签发一个joint queued-stop window；非PASS与逐字段漂移全部拒绝。
- GREEN：installed supervisor合成preflight与joint output verifier通过；objects-limit issuer/supervisor/benchmark全回归。

## 允许文件

- `tasks/TASK-083-joint-queued-stop-issuer.md`
- `tasks/00_TASK_INDEX.md`
- `project/WAVE-5.yaml`
- `project/V3_TODO.md`
- `project/STATUS.json`
- `scripts/ci/issue-v3-capacity-joint-queued-stop-window.py`
- `scripts/ci/test/issue-v3-capacity-joint-queued-stop-window.test.mjs`
- `scripts/ci/capacity-phase-supervisor-v2.py`
- `scripts/ci/test/capacity-phase-supervisor-v2.test.mjs`
- `packages/bridge-core/test/benchmarks/recording-capacity-process.ts`
- `packages/bridge-core/test/recording-capacity-process.test.ts`
- `scripts/ci/verify-v3-owner-readiness.mjs`
- `scripts/ci/test/verify-v3-owner-readiness.test.mjs`
- `reports/TASK-083_RESULT.md`

本任务不修改既有objects-limit三条issuer的历史恢复数据，不运行正式窗口，不修改应用、业务数据库或设备代码。
