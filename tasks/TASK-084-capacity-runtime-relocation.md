# TASK-084：容量历史 Runtime 显式迁移闭包

基线 `b606784a5969d813984975ca096c48725bc1c432`，分支 `codex/task-084-capacity-path-remap`。TASK-083 已封板三条 joint 专用 issuer；正式 objects-limit queued-stop 的冻结 measure 与三类失败 carryover 仍来自 TASK-078 runtime。

## 根因与裁决

历史容量证据记录的 runtime 前缀为 `/Users/yihe/VSCode/...`，当前规范物理路径为 `/Volumes/LifeWeave/VSCode/...`；迁移同时改变了 live root 的 device/inode。旧 JSON、SHA、失败窗口与 LOST root 都是不可变证据，不能通过改写历史文件或重放 window-07 修复。

本任务采用显式、可审计的 `historicalRuntime → currentRuntime` relocation 收据：对63个仍存在的 live root 逐项保存 historical/current identity，并在准入时重新核验规范路径、device、inode与marker SHA；7个缺失根继续保持 `LOST`，由新的 historical-control-only replacement闭合计数。历史 issuer、pre-child、PROCESS_EXIT 文件只在内存中投影到当前规范路径，原始字节与Hash不变。

## 验收合同

1. recovery creator仅接受exact70历史根、63 live、7 missing、唯一future root；显式迁移时必须产生63项确定性相对路径映射，marker SHA逐项一致。
2. queued-stop issuer必须先验证v3 relocation收据，再对历史carryover做只读内存投影；旧window、旧receipt与旧JSON不得改写或重放。
3. installed supervisor与Bridge consumer必须与issuer保持等价：读取不可变文件后投影路径，并以当前文件系统重新验证root identity与marker。
4. 任一映射缺项/夹带、路径越界、marker漂移、root重现、Git/HEAD/权限漂移或历史事实不一致均在首样本前fail-closed。
5. 软件封板后只允许在clean且pushed的TASK-084 HEAD签发一个新objects-limit queued-stop窗口并消费一次；仅其正式PASS后，才能按generation → measure → queued-stop顺序进入joint链。
6. 本任务不打开设备、不升级Gate B或Owner验收；真实HAL、可听结果、实体打印与最终Owner仍是独立门。

## TDD

- RED：recovery creator拒绝跨runtime根；随后要求exact63 relocation映射。
- GREEN：发布exact75-v3只读收据，旧/新root身份与marker闭合。
- RED/GREEN：issuer、installed supervisor与TypeScript consumer分别要求相同内存投影语义。
- 回归：v2原路径、历史失败谱系、exact76 owned闭包、权限/Git/marker fail-closed全部保持通过。

## 允许文件

- `tasks/TASK-084-capacity-runtime-relocation.md`
- `tasks/00_TASK_INDEX.md`
- `project/WAVE-5.yaml`
- `project/V3_TODO.md`
- `project/STATUS.json`
- `scripts/ci/create-v3-capacity-measure-root-recovery.py`
- `scripts/ci/issue-v3-capacity-queued-stop-window.py`
- `scripts/ci/capacity-phase-supervisor-v2.py`
- `scripts/ci/verify-v3-owner-readiness.mjs`
- 上述入口对应的 `scripts/ci/test/` 测试
- `packages/bridge-core/test/helpers/recording-capacity-phases.ts`
- `packages/bridge-core/test/recording-capacity.test.ts`
- `reports/TASK-084_RESULT.md`

runtime下新收据、replacement roots、正式窗口与样本是Git忽略的受控证据，不得进入仓库。任何凭据、真实Provider、真实Roon或设备数据均不进入本任务。
