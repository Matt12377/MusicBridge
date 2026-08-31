# TASK-081：Joint Generation 专用一次性 Issuer

基线 `b90c831f62afa2dedcb07630cbb89add2ad3f393`，分支 `codex/task-081-joint-capacity-issuers`。TASK-080 已把 clean-clone 入口锁到一次性 authority 收据；本任务实现正式路线 order 1 的 joint generation issuer 软件合同。

## 架构裁决

`issue-v3-capacity-window.py` 是 objects-limit 历史失败恢复 issuer：它强制读取同 profile 的 terminal generation failure/carryover，并使用 objects-limit 的固定空间计划。仅把 argparse 的 profile 枚举放宽为 joint，会把错误前驱和错误计划包装成看似合法的窗口。

因此 TASK-081 新增专用 `issue-v3-capacity-joint-generation-window.py`。它只接受正式 `objects-limit:queued-stop:PASS` 前驱，不继承旧 authority，不复用历史失败 recovery receipt，也不改写 objects-limit issuer。

## 验收合同

1. 精确验证 objects-limit queued-stop window、close、supervision、source/owned manifest、seed、候选与 toolchain 身份；close 必须为正式 PASS、terminal/nonreplay、group empty、zombies empty、deviceOpened false、formalReady false、Gate B NOT_RUN。
2. joint generation window 固定 profile `joint`、phase `generate`、n=1、独立 process/clock/receipt、20分钟窗口及 `plannedBytes=2,701,131,776`。
3. 新窗口使用 fresh UUID、目录和 label；authority 只能最后一步原子发布，收据只返回 installed supervisor 的唯一消费命令。
4. 任一前驱非PASS、字段/Hash/路径/候选/toolchain漂移、dirty候选、重放、空间不足或发布失败均 fail-closed，不能创建可执行 window。
5. 本任务只实现与验证 issuer，不签发或消费真实 authority，不运行 generation/measure/queued-stop，不打开设备，不升级 Gate E、Gate B 或 Owner 验收。

## TDD

- RED：专用 joint generation issuer 不存在；现有 objects-limit recovery issuer拒绝 joint，readiness 路线文字不能构成签发能力。
- GREEN：完整合成前驱 PASS fixture 只签发一个 joint generation window；非PASS与逐字段漂移负例均拒绝。
- GREEN：objects-limit recovery issuer原专项保持全绿，证明没有放宽或改写历史路径。

## 允许文件

- `tasks/TASK-081-joint-generation-issuer.md`
- `tasks/00_TASK_INDEX.md`
- `project/WAVE-5.yaml`
- `project/V3_TODO.md`
- `project/STATUS.json`
- `scripts/ci/issue-v3-capacity-joint-generation-window.py`
- `scripts/ci/test/issue-v3-capacity-joint-generation-window.test.mjs`
- `scripts/ci/verify-v3-owner-readiness.mjs`
- `scripts/ci/test/verify-v3-owner-readiness.test.mjs`
- `reports/TASK-081_RESULT.md`

本任务不修改既有 objects-limit 三条 issuer、installed supervisor、benchmark、应用、数据库或设备代码；若新的最小 RED 证明共享纯验证函数必须抽取，先在本任务报告中记录最小扩展理由。
