# TASK-084 结果报告：容量历史 Runtime 显式迁移闭包

## 身份

- 基线提交：`b606784a5969d813984975ca096c48725bc1c432`
- 分支：`codex/task-084-capacity-path-remap`
- recovery RED：`90b15e8b03628204f989f96011d65ce36218bee3`
- recovery实现：`1f0a41c8b03ccb9c38c37bdf7e681b30c84d93c4`
- issuer RED／实现：`de4f637ba6a9a27854a1f050bd8dd06f0c42b848`／`c542eccb0281b3142a0d8f1010c27ea52c80973f`
- supervisor RED：`509a496bcd2716918b78b433327e5e0015a4e574`
- consumer RED／实现：`e630aa7c8737a163b8d02e67937b65d17af5b7ca`／`c54ca45f8820e7c8dde6076454cf402cdb1b5585`
- readiness RED／控制面：`f42937f9d33f82d210c30dab5552de01f1842378`／`141834f410b44d0213c8ec2a073a0227428650bc`

## 结果

TASK-084软件范围通过。新 `exact75-v3-runtime-relocation-closure` 收据显式绑定历史runtime与当前规范runtime，并对63个仍存在的live root逐项记录historical/current identity。每个current root均重新核验规范路径、device、inode及marker SHA；7个历史缺失根仍为`LOST`，通过新的historical-control-only replacement闭合exact75计数，不复制历史marker内容。

queued-stop issuer只有在完整验证v3收据后，才对历史issuer、pre-child和PROCESS_EXIT carryover做内存路径投影。installed supervisor与TypeScript consumer采用同一边界：不可变历史文件先按原Hash读取，再在内存中投影路径并对当前root重新做identity/marker验证。历史JSON、SHA、window-06、window-07、旧recovery receipt及失败谱系均未改写；window-07继续永久禁止重放。

TASK-083遗留的joint queued-stop专用issuer状态也在readiness控制面中校正为`IMPLEMENTED_NOT_ISSUED`。正式路线现为：签发一个新的objects-limit queued-stop authority；仅其PASS后，才能依次签发joint generation、joint measure与joint queued-stop。四段均要求fresh process/clock/audit与一次性窗口，任何非PASS立即停止后续签发。

本报告封板时尚未签发或消费新authority，正式样本数为0，未打开设备。Gate B、真实HAL、可听结果、实体打印及Owner验收均保持`NOT_RUN`。

## TDD与兼容性证据

1. recovery creator：27/27 PASS，覆盖显式runtime relocation、exact63映射、旧根重现、marker/device/inode漂移、发布竞态和Git clean/pushed约束。
2. queued-stop issuer：73/73 PASS，覆盖三类carryover的只读内存投影、递归PROCESS_EXIT谱系、跨recovery代际与exact75稳定根。
3. installed supervisor：59/59 PASS，覆盖v2原路径、v3 relocation、历史失败谱系、exact76 owned闭包、空间计费和636文件成功闭包。
4. Bridge容量：139/139 PASS，v3 relocation在首样本前自然越过准入，同时全部v2/fail-closed回归保持通过。
5. Owner readiness：17/17 PASS；实际入口返回`V3_OWNER_READINESS=PASS`且`ready:false`，没有把软件准入升级为设备或Owner通过。

## 新鲜验证

| 命令 | 结果 |
| --- | --- |
| `corepack pnpm@10.17.1 install --frozen-lockfile --ignore-scripts` | exit 0 |
| `node --test scripts/ci/test/create-v3-capacity-measure-root-recovery.test.mjs` | 27/27 PASS，exit 0 |
| `node --test scripts/ci/test/issue-v3-capacity-queued-stop-window.test.mjs` | 73/73 PASS，exit 0 |
| `node --test scripts/ci/test/capacity-phase-supervisor-v2.test.mjs` | 59/59 PASS，exit 0 |
| `node --import tsx --test packages/bridge-core/test/recording-capacity.test.ts` | 139/139 PASS，exit 0 |
| `node --test scripts/ci/test/verify-v3-owner-readiness.test.mjs` | 17/17 PASS，exit 0 |
| `node scripts/ci/verify-v3-owner-readiness.mjs` | `V3_OWNER_READINESS=PASS`、`ready:false`，exit 0 |
| Node `v22.23.2` 下 `corepack pnpm@10.17.1 verify` | contracts 186/186、Bridge 1304 PASS＋1显式skip、desktop 645/645，typecheck/build均exit 0 |
| `node scripts/ci/verify-control-plane.mjs` | `CONTROL_PLANE=PASS`，exit 0 |
| `node scripts/ci/verify-boundaries.mjs` | `BOUNDARIES=PASS`，exit 0 |
| `node scripts/ci/verify-cycles.mjs` | `CYCLES=PASS files=259`，exit 0 |
| `python3 -m py_compile` 三个变更Python入口 | exit 0 |
| `git diff --check` | exit 0 |

## 审查结论

- 规格合规：PASS。实现只解决可审计runtime迁移与消费者等价，不改写历史、不重放旧窗口、不打开设备。
- 代码质量：PASS。relocation是显式可拒绝合同，不依赖符号链接偶然可达；每次投影后重新验证真实文件系统身份。
- 兼容性：PASS。v2 recovery、旧PROCESS_EXIT谱系、objects-limit与joint profile路由均保留完整回归。
- 最终未解决P0/P1/P2：0/0/0。

## Carryover

- 新objects-limit queued-stop必须基于TASK-084最终clean且pushed HEAD唯一签发并只消费一次；旧window-07不可重放。
- joint generation → measure → queued-stop仅在逐阶段正式PASS后线性推进，任一失败都不得跳过或补抽。
- runtime正式容量证据属于Git忽略目录，须在任务状态中记录窗口、Hash、退出码、样本和replay策略，但不得提交大型运行产物。
- Draft外部评审、PR Ready/merge、真实设备、Gate B、发布与Owner验收继续作为独立门。
