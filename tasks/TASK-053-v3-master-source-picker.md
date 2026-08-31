# TASK-053：Roon 选曲与持久化录音草稿

## 身份与授权

Owner 持续授权全部开发。基线 `bc4290a10b7ca4a5f5fb73fe70898946fb49be16`，分支 `codex/task-053-v3-master-source-picker`。前置 TASK-052 本地自动 Gate 已通过；真实 Roon/Owner 不据此完成。

## 范围

1. 从录音页浏览/搜索 Roon 专辑并选择实际曲目，明确确认后创建或追加 Draft Master。取消不创建草稿，不自动操作播放、库存、文件或设备。
2. 草稿与每个草稿曲目使用独立本地 UUID。只保存安全元数据；Roon runtime reference/itemKey/session 不落盘。应用重启保留草稿和顺序，运行期试听引用不自动恢复。
3. 草稿支持标题、Compilation/Concert/Continuous Program、追加、删除和显式排序。未变曲目 ID 不变，同名曲目不自动合并。默认 Compilation 曲间估算 5 秒，其他类型不假设额外间隔，未知曲长不伪造总时长；估算不等于帧级执行时间线。
4. 只有 Roon 引用时 sourceLockEligible=false。显示来源未验证，不能 Freeze/正式录音；后续实际 Source Binding、Layout 与库存推荐任务继续承接，不用占位成功替代。
5. 复用现有试听接口；Roon 暂不可用保留草稿。Schema 4→5、幂等账本、revision 冲突、事务失败回滚和只读分页。
6. 不在此任务访问真实 Source Roots、转换音频、编译执行资产、启动录音、预留库存或写商业 Exact 关系。

## 允许修改

- `packages/contracts/src/{master-drafts.ts,index.ts,ipc.ts,validator.ts}` 与既有 validator 测试。
- `packages/bridge-core/src/recording/`、`src/collection/repository.ts`、`src/roon/{public-library.ts,synthetic-library.ts}`、`src/{runtime.ts,utility-main.ts}`；既有 collection-repository/utility-ipc/roon-public-library/runtime 测试，允许新草稿协调器测试。
- Desktop main/index、preload api/index、recording 组件及相关 composable，既有 preload/renderer/E2E 测试；沿用明确合成目录双开关，不开放普通生产模式。
- 当前任务/索引/WAVE-5/STATUS/执行计划、ADR-013、结果报告与本地忽略提交的自动证据。

## 验证

先取正式 IPC 与已禁用 UI 入口行为 RED。覆盖引用失效、只存安全元数据、重启、稳定曲目 ID、曲序、同名不合并、零 Source Lock、幂等/回滚/迁移、回执未知和取消。全量 verify/security/Electron/E2E 与 control-plane/boundaries/cycles，窄窗/键盘/axe 分开记录。

F-01、真实目录/设备/账号/Owner、旧歌词与视觉 carryover、跨重启 outbox 和完整 Gate A～E 保留。无 push/main 集成。
