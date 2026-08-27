# TASK-052：Roon 与原版实物双向关系

## 身份与目标

Owner 持续授权全部开发；基线 `60d4752d585c8a1b67629b0d5d3f85b36ba9362e`，分支 `codex/task-052-v3-roon-physical-links`。TASK-051 自动验证已通过，真实照片/Roon/Owner 待验收。

## 范围

1. V3 中从真实 Roon 浏览/搜索选择专辑，明确确认 Exact / Probable / Related；实体与本地数字关联对象保持独立 UUID。相同标题不能自动 Exact。
2. 本地数字元数据快照与关系持久化，Roon runtimeReference / itemKey / session 只留运行内存。不把元数据关系当 Source Lock 或精确音频证据。
3. 重启/断连保留关系和实体，显示链接待定位/不可用；重新定位须用户确认当前候选，不静默根据同名恢复。失效引用不得越过当前 Core 作用域。
4. CD Rip Provenance 单独显式确认，仅适用所选原版 CD。Physical Only / Digital Only 必须有明确缺少声明；未检查保持未匹配，新关联原子消除冲突声明。
5. 音乐详情与 V3 Collection Matrix 双向可见，可查看关联的另一侧；复用现有曲目试听但不修改 V2 Library/Search/Album UI，也不启动正式录音。
6. 自录不纳入商业原版数量；历史/正式自录的曲目源关系由后续 Master Source Picker/归档按曲目补齐，不创建伪商业 Exact。最终 PRD 仍须覆盖该承接项。
7. Schema 3 → 4 可回滚迁移、不可变操作账本/幂等、revision 冲突、有界查询与用户取消。继承原照片/音乐数据。

## 允许修改

- `packages/contracts/src/{physical-links.ts,physical-music.ts,index.ts,ipc.ts,validator.ts}`、既有 validator 测试。
- `packages/bridge-core/src/collection/`、`src/roon/public-library.ts`、`src/{runtime.ts,utility-main.ts}`；既有 collection-repository/utility-ipc/roon-public-library/runtime 测试，新增独立关系协调器测试可用于新模块行为。
- Desktop main/index、preload api/index、collection 组件与相关 composable、既有 preload/renderer/E2E 测试。合成 Roon 目录仅可在明确 Core test 模式注入。
- 本任务、索引、WAVE-5/STATUS/执行计划、ADR-012、报告与忽略提交的本地证据。

## 验证与边界

先由正式 IPC/Renderer 产生行为 RED。Core 覆盖作用域失效、离线、元数据不是精确来源、关系/缺少状态冲突、Provenance、幂等、迁移及私密引用不落盘。UI 覆盖选择/确认/取消/重新定位、双方往返、窄窗/键盘/axe，完整 verify/security/Electron/E2E 和控制面 Gate。

合成底层 Roon 服务可驱动正式 coordinator 和持久化，但不伪称真实 Roon 验收。F-01、真实账号/音乐 Source Roots/硬件、Owner 验收、跨重启未确认命令 outbox 等保留；不 push/合并 main。

合成 Roon E2E 需要将 `main/core-environment.ts` 与既有 `test/core-environment.test.ts` 纳入允许范围，只在 uiE2e 模式传递明确的合成目录开关；`src/roon/synthetic-library.ts` 仅在 Core test 分支创建，不改变正常环境。
