# TASK-082 结果报告：Joint Measure 专用一次性 Issuer

## 身份

- 基线提交：`f018cc9fbcda7017d786fd7f1a63e8e44ba2211b`
- 分支：`codex/task-082-joint-measure-issuer`
- RED 提交：`c48740601e019d0fa59d053276eb0708358234ae`
- 实现提交：`8af0cb69213b103532e7e698487045f956c18d7d`
- 控制状态提交：`9b0d7ab9e9c6128fe8e739b21fb5684e393fbcb2`
- 报告提交：由后续身份封存提交回填。

## 结果

TASK-082 软件范围通过。新增 `scripts/ci/issue-v3-capacity-joint-measure-window.py`，只接受原始 window、terminal close、supervision、source/owned manifest、seed 与 fixture 共同闭合的 `joint:generate:PASS`，并签发 installed supervisor 可直接复核的 `joint/measure/n=105` 一次性窗口。

发行器固定标准 measure limits 与 `3 group clones / 3 full hashes / 105 stop receipts / 1,575 samples` 计划；锁定 seed metadata、snapshot、fixture owner、候选 Git 分支/HEAD/clean 状态、TASK-081 issuer fact、installed supervisor、consumer 与 source pins。它独立重算 generation command、source before/after、checkpoint、space receipt、seed/fixture/SQLite 身份，不信任单独的 exit 0 或 `verifiedPassed` 布尔值。

共享 supervisor 有界补齐 `musicbridge-capacity-generation-window-close`：在既有 supervision 与 artifact probe 完成后写入同一 generation 事实、authority admission/terminal、supervisor SHA 与 terminal/nonreplay 策略，使 measure 前驱不再把 `supervision/supervisor.json` 冒充路线声明的 close receipt。

本任务未签发或消费真实 authority，未运行正式 generation、measure 或 queued-stop，未创建正式样本，未打开设备。Gate B、正式容量结果、外部证据与 Owner 验收均保持 `NOT_RUN`。

## TDD 与兼容性证据

1. RED：专用入口缺失时专项以“缺少专用joint measure issuer”失败；既有 objects-limit measure issuer仍只允许 `objects-limit`。
2. joint measure issuer 专项：6/6 PASS，覆盖纯合同、generation任一降级、独立generation close、完整CLI与installed supervisor preflight，以及dirty候选、close/seed/issuer fact篡改和重放路径。
3. TASK-081 joint generation issuer回归：6/6 PASS。
4. objects-limit measure issuer完整回归：25/25 PASS；历史terminal union、legacy partial与失败恢复语义未放宽。
5. installed supervisor完整专项：58/58 PASS；新增close不改变既有generation/measure/queued-stop执行合同。
6. Owner readiness：17/17 PASS；冻结验收基线仍为TASK-079，当前控制身份推进到TASK-082，generation与measure issuer均为`IMPLEMENTED_NOT_ISSUED`，queued-stop issuer仍未实现。

## 新鲜验证

| 命令 | 结果 |
| --- | --- |
| `corepack pnpm@10.17.1 install --frozen-lockfile --ignore-scripts` | exit 0 |
| `node --test scripts/ci/test/issue-v3-capacity-joint-measure-window.test.mjs` | 6/6 PASS，exit 0 |
| `node --test scripts/ci/test/issue-v3-capacity-joint-generation-window.test.mjs` | 6/6 PASS，exit 0 |
| `node --test scripts/ci/test/issue-v3-capacity-measure-window.test.mjs` | 25/25 PASS，exit 0 |
| `node --test scripts/ci/test/capacity-phase-supervisor-v2.test.mjs` | 58/58 PASS，exit 0 |
| `node --test scripts/ci/test/verify-v3-owner-readiness.test.mjs` | 17/17 PASS，exit 0 |
| `node scripts/ci/verify-v3-owner-readiness.mjs` | `V3_OWNER_READINESS=PASS`，`ready:false`，exit 0 |
| `corepack pnpm@10.17.1 verify` | typecheck、tests与production build全部exit 0；contracts 186/186、desktop 645/645 |
| `node scripts/ci/verify-control-plane.mjs` | `CONTROL_PLANE=PASS`，exit 0 |
| `node scripts/ci/verify-boundaries.mjs` | `BOUNDARIES=PASS`，exit 0 |
| `node scripts/ci/verify-cycles.mjs` | `CYCLES=PASS files=259`，exit 0 |
| `python3 -m py_compile scripts/ci/issue-v3-capacity-joint-measure-window.py scripts/ci/capacity-phase-supervisor-v2.py` | exit 0 |
| `git diff --check` | exit 0 |

## 审查结论

- 规格合规：PASS。实现只覆盖joint measure专用签发与其不可缺少的generation terminal close；没有修改objects-limit三条issuer、benchmark、应用、数据库或设备代码。
- 代码质量：PASS。外部文件采用规范绝对路径、ordinary/stable identity与逐SHA读取；候选Git身份有界且必须clean；generation artifacts由受控supervisor函数重新计算；measure window经实际installed supervisor再次preflight；发布使用exclusive create、fsync与原子rename。
- P0/P1/P2：0/0/0。

## Carryover

- 正式objects-limit queued-stop仍需独立真实PASS；TASK-082不创造或假设该前驱。
- joint queued-stop专用issuer尚未实现；不得跳过measure或继承上一阶段authority。
- Draft外部评审、PR合并、正式窗口签发/消费、设备、Gate B、发布和Owner验收继续作为独立门。
