# TASK-082：Joint Measure 专用一次性 Issuer

基线 `f018cc9fbcda7017d786fd7f1a63e8e44ba2211b`，分支 `codex/task-082-joint-measure-issuer`。TASK-081 已实现只消费 `objects-limit:queued-stop:PASS` 的 joint generation 专用 issuer；本任务实现正式路线 order 2 的 joint measure issuer 软件合同。

## 架构裁决

既有 `issue-v3-capacity-measure-window.py` 是 TASK-078 objects-limit 历史失败恢复入口，强制吸收 legacy partial、terminal issuer failure 与 terminal measure carryover。joint measure 的唯一合法前驱是本路线新鲜的 `joint:generate:PASS`；它不应继承 objects-limit 的失败恢复根、固定 root count 或旧窗口语义。

因此 TASK-082 新增 `issue-v3-capacity-joint-measure-window.py`。它只接受同一 runtime 下完整且不可重放的 joint generation PASS 原始证据，并签发 profile=`joint`、phase=`measure` 的独立一次性窗口；既有 objects-limit issuer 保持原样。

## 验收合同

1. 精确验证 joint generation 的 window、close、supervision、source/owned manifest 与输出 seed；要求 verifiedPassed、authority stable、fixture stable、source before=after、exit 0、无SQLite sidecar、generation plan/space有效。
2. measure window 固定 profile `joint`、phase `measure`、n=105、15分钟窗口、标准 measure limits/plan，并把 seed label、metadata SHA、snapshot SHA及候选身份锁入窗口。
3. 新窗口使用 fresh UUID、目录和 label；authority 只在所有前驱、候选、toolchain、空间与 installed supervisor preflight 通过后原子发布，收据只返回唯一消费命令。
4. 任一非PASS、字段/Hash/路径/候选/toolchain漂移、dirty候选、重放、空间不足或发布失败均 fail-closed，不创建可消费 window。
5. 本任务只实现与验证 issuer，不签发或消费真实 authority，不运行 measure/queued-stop，不打开设备，不升级 Gate E、Gate B 或 Owner 验收。

## TDD

- RED：专用 joint measure issuer 不存在；既有 measure issuer仍只允许 objects-limit，readiness 路线文字不能构成签发能力。
- GREEN：完整合成 joint generation PASS fixture 只签发一个 joint measure window；非PASS、逐文件篡改、dirty候选与重放均拒绝。
- GREEN：installed supervisor 对新窗口执行合成 preflight；既有 objects-limit measure issuer专项保持全绿。

## 允许文件

- `tasks/TASK-082-joint-measure-issuer.md`
- `tasks/00_TASK_INDEX.md`
- `project/WAVE-5.yaml`
- `project/V3_TODO.md`
- `project/STATUS.json`
- `scripts/ci/issue-v3-capacity-joint-measure-window.py`
- `scripts/ci/test/issue-v3-capacity-joint-measure-window.test.mjs`
- `scripts/ci/verify-v3-owner-readiness.mjs`
- `scripts/ci/test/verify-v3-owner-readiness.test.mjs`
- `reports/TASK-082_RESULT.md`

本任务不修改既有 objects-limit 三条 issuer、installed supervisor、benchmark、应用、数据库或设备代码；若新的最小 RED 证明共享纯验证函数必须抽取，先记录最小扩展理由并保持历史路径回归全绿。
