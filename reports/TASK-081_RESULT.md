# TASK-081 结果报告：Joint Generation 专用一次性 Issuer

## 身份

- 基线提交：`b90c831f62afa2dedcb07630cbb89add2ad3f393`
- 分支：`codex/task-081-joint-capacity-issuers`
- RED 提交：`afa6c4fbfc57a5ea192876e00ca6bc0dd231ade8`
- 实现提交：`f78ae868e7951d085ea008f8554c80559e66e46f`
- 控制状态提交：`a12d36b7e724e2a006eb7b14d2f332a2045e98b7`
- 报告提交：`PENDING_THIS_REPORT_COMMIT`

## 结果

TASK-081 软件范围通过。新增 `scripts/ci/issue-v3-capacity-joint-generation-window.py`，只接受五份原始文件重建出的 `objects-limit:queued-stop:PASS`，并签发 installed supervisor 可直接复核的 `joint/generate/n=1` 一次性窗口。

发行器固定独立 `2,701,131,776` 字节 joint generation 计划，验证候选 Git 分支/HEAD/clean 状态、issuer/supervisor/consumer Hash、245 项精确 source pins、前驱 owned roots、空间与重放边界。正式 `window.json` 仅在所有 preflight 通过后由 pending 文件原子发布；失败目录留下不可重放终态，收据只返回 installed supervisor 的唯一消费命令。

本任务未签发或消费真实 authority，未运行 joint generation、measure 或 queued-stop，未打开设备。Gate B、正式容量结果、外部证据与 Owner 验收均保持 `NOT_RUN`。

## TDD 与兼容性证据

1. RED：专用入口缺失时，完整 CLI 测试以 `JOINT_ISSUER_NOT_READY` 失败。
2. joint issuer 专项：6/6 PASS，覆盖纯合同、前驱字段降级、五文件 SHA/路径闭包、真实 installed supervisor preflight、dirty 候选、前驱篡改与重放路径。
3. objects-limit recovery issuer 回归：19/19 PASS；既有入口仍只接受 `objects-limit`，未放宽历史失败恢复语义。
4. installed supervisor 相邻 joint/generation 专项：5/5 PASS。
5. Owner readiness：17/17 PASS；冻结 Owner readiness 基线仍为 TASK-079，当前 STATUS/WAVE 控制身份精确推进到 TASK-081，generation issuer 标记为 `IMPLEMENTED_NOT_ISSUED`，measure/queued-stop issuer 仍未实现。

## 新鲜验证

| 命令 | 结果 |
| --- | --- |
| `corepack pnpm@10.17.1 install --frozen-lockfile --ignore-scripts` | exit 0 |
| `node --test scripts/ci/test/issue-v3-capacity-joint-generation-window.test.mjs` | 6/6 PASS，exit 0 |
| 临时 Node 22 固定布局下 `node --test scripts/ci/test/issue-v3-capacity-window.test.mjs` | 19/19 PASS，exit 0 |
| `node --test --test-name-pattern 'generation roots\|joint generation预算\|joint generation artifacts\|terminal authority' scripts/ci/test/capacity-phase-supervisor-v2.test.mjs` | 5/5 PASS，exit 0 |
| `node --test scripts/ci/test/verify-v3-owner-readiness.test.mjs` | 17/17 PASS，exit 0 |
| `node scripts/ci/verify-v3-owner-readiness.mjs` | `V3_OWNER_READINESS=PASS` 且 `ready:false`，exit 0 |
| `corepack pnpm@10.17.1 verify` | contracts 186、bridge-core 645、desktop 645；typecheck/test/build exit 0 |
| `node scripts/ci/verify-control-plane.mjs` | `CONTROL_PLANE=PASS`，exit 0 |
| `node scripts/ci/verify-boundaries.mjs` | `BOUNDARIES=PASS`，exit 0 |
| `node scripts/ci/verify-cycles.mjs` | `CYCLES=PASS files=259`，exit 0 |
| `python3 -m py_compile scripts/ci/issue-v3-capacity-joint-generation-window.py` | exit 0 |
| `git diff --check` | exit 0 |

旧 objects-limit issuer 测试要求 Node 可执行文件相邻目录存在 `libnode.*.dylib`。本机 NVM Node 22 为自包含二进制，因此测试使用临时目录复制同一 Node 22 可执行文件并提供只读 `libnode.141.dylib` 身份输入；临时目录不进入候选仓库，实际执行器版本仍为 Node `v22.23.2`。

## 审查结论

- 规格合规：PASS。实现只覆盖 TASK-081 generation issuer，没有改写既有 objects-limit issuer、installed supervisor、benchmark、应用、数据库或设备代码。
- 代码质量：PASS。关键外部文件采用规范绝对路径、ordinary/stable identity、逐 SHA 读取；Git 查询有界且禁 lazy fetch；source/owned 由实际 installed supervisor 再次 preflight；发布使用 exclusive create、fsync 与原子 rename。
- P0/P1/P2：0/0/0。

## Carryover

- 正式 objects-limit queued-stop 仍需取得真实 PASS，TASK-081 本身不创造该前驱。
- joint measure 与 joint queued-stop 专用 issuer 尚未实现；不得跳过或继承 generation authority。
- Draft 外部评审、PR 合并、正式窗口签发/消费、设备、Gate B、发布和 Owner 验收继续作为独立门。

