# TASK-072：正式 Profile Snapshot / RecordingPlan / Preflight

基线 `6323b3431ec7beeaba851155c062f9fae4bf41ea`，独立分支 `codex/task-072-recording-plan`。Owner 于2026-08-28确认F-01保守保留政策并授权全速持续开发，智能体统一GPT-5.6 Sol / High。仅合成资料，不push、不合并main、不发布、不访问真实源/账号/设备。

## 范围与准入

- `f01-permanent-execution-v1`：成功实际执行音频及谱系永久保留；原始源按明确归档策略；Prepared原始Render永久保留；失败/取消不自动删除；完整备份含归档音频；缺依赖不承诺重建。
- 明确选择执行资产及FINALIZED归档操作、规划和实体副本，以真实数据库事实/CAS为准。冻结Master/Layout/PlannedTimeline、PREP与RenderTimeline（若适用）、执行Manifest/Hash/格式/后端/profile版本、实体副本和完整Profile+Overrides+effective快照、归档结果/政策。当前session只复制到新Plan，要求执行format与asset一致，不改写历史asset设置，不选latest拼接。
- 身份冻结与执行准入分开：不可变RecordingPlanVersion可保存；当前没有输出Gate B认证，所有Preflight及计划formalReady=false，显式BACKEND_NOT_CERTIFIED。无Start/Attempt/播放/设备操作，无Renderer提供认证。
- Preflight重新验证容量、版本、源/执行/归档完整性、实体预留和设备兼容；失败保留具体有界原因，不把未读取或错误当通过。新版本不改旧计划，不改变库存使用状态。
- 新schema18的备份/隔离恢复保留计划/快照/幂等账本和引用守恒，兼容原14/15/16/17；恢复撤销授权后不得就绪。完整备份仍复制真实归档内容对象。

## 唯一写入范围

- 合同作者task071_picker：`packages/contracts/src/recording-plans.ts`及合同index/protocol/public-api/command-outbox接线、相应合同tests；计划类型/guards/请求响应/命令allowlist。既有归档retention仅必要兼容增加，不改旧事实。
- Core作者task070_store：`packages/bridge-core/src/recording/plan-store.ts`、`plan-coordinator.ts`、`plan-integrity.ts`、`packages/bridge-core/src/collection/repository.ts`迁移和仓储挂接、必要archive-coordinator的新proposal政策；新增/扩展Core计划tests。共享文件追加前告知root。
- 桌面作者restore_index_details：新增`RecordingPlanPanel.vue`、`recording-plan-controller.ts`及对应desktop unit tests；`RecordingView.vue`接入、`recording-next-step.ts`必要CTA及其测试。只经API/outbox调用；不写Main/preload/合同/Core。
- root：Core `runtime.ts`/`utility-main.ts`、desktop Main/preload/API接线及其tests、`backup-index.ts`/`restore-database.ts`与备份恢复测试、正式Electron E2E、本任务/ADR032/控制/报告。统一全量build/Electron/E2E与提交。agents不改root文件，不运行共享dist的build/Electron。

合同入口：`recordingPlans.list/version/preview/freeze/preflight/cancelRead`。只有freeze为持久outbox写；只读preview/preflight不可写库存。明确selection与proposalFingerprint，冻结重读验证后事务保存，原commandId同body重放只返回原计划，异body冲突。

## 验证与后续

各模块先行为RED后实现GREEN；SPEC先QUALITY，各最多两轮，不进行第三轮。最终verify、安全、Electron、完整E2E含固定native、E2E types、控制面/边界/循环、diff检查及code/native/screenshot身份冻结。实现/报告/最终提交分开。

TASK073接后端与GateB，其真实设备授权、测量配置与认证仍待Owner；TASK074～079及历史carryover不删减。自动证据不是Owner验收。

## 集成路径补充

root补 `apps/desktop/src/main/recording-plan-ipc.ts` / `core-supervisor.ts` / `CommandOutboxPanel.vue` 和对应Main、安全读取、preload、outbox标签、文件核对期限测试；`utility-ipc.test.ts`、`restore-dataset-runtime.test.ts`；固定 `collection-schema17.sql` 源于TASK071正式迁移；`backup-package.ts` 新包政策标记兼容；`apps/desktop/e2e/task-072.spec.ts` / `task-072-workflows.ts` / E2E tsconfig。桌面作者获准扩展 `recording-workflow-integration.test.ts`。Core作者 `test/helpers/recording-plan-fixture.ts` 复用完整真实合成资产/归档fixture，root备份集成复用。

最终集成路径补充：root仅调整旧迁移fixture的schema18前置/终点，覆盖 `archive-transactions.test.ts`、`archive-workflow.test.ts`、`collection-repository.test.ts`、`preparation.test.ts`、`prepared-render.test.ts`、`recording-profile.test.ts`、`collection-progress-store.test.ts`、`reference-catalog-store.test.ts`、`spreadsheet-import-store.test.ts`，保留原回滚及守恒断言。Core作者获准向 `test/helpers/archive-backup-fixture.ts` 添加可选DAT格式fixture；root将备份测试扩为实际隔离恢复。root在 `RecordingPlanPanel.vue` 和 `recording-plan-panel.test.ts` 将包装/冻结预留标签中文化（真实SFC RED后修正），最后桌面审查限第二轮。

全量E2E Gate追加root最小兼容路径：`apps/desktop/e2e/task-069.spec.ts`与`task-070.spec.ts`只将当前库PRAGMA终点17改为18，原库存/账本/冷启动断言不变。首次完整E2E73/75，两失败均精确落在旧版本断言，作为RED保留。
