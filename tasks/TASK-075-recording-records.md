# TASK-075：录音档案、检索与双库同步

基线`af572126a2abeefdf361e8db2c9ac4a457b7a8be`，分支`codex/task-075-recording-records`。承接074最终提交；Owner授权持续软件开发至079，GPT-5.6 Sol / High并行、保持TODO一致，不push、合并main、安装或发布。依据PRD §64/65、开发包F01/U04～U10。

## 范围与边界

1. 首次Completed事件原子登记不可变Record、当前内容认知和usage，不增加Physical Copy或库存数量。快照引用冻结Plan/执行谱系、首次完成事实与本盘已有JPEG，不从当前母版重建历史。后续cleanup不改首次完成快照。
2. 六个固定dataset scope API：list/get/visual/history/previewDisposition/applyDisposition。分页最大25，筛选AND、关键词字段OR，支持427/C-0427/MB-C-00427；纯数字查既有C/D同号，不分配ID。无任意路径/SQL、registerCompleted、删除历史或设备入口。
3. 当前内容confirmed/unknown/erased与历史分离。明确preview+人工确认后执行五种处置：内容未知、确认既有档案为当前、准备重录、取消重录、声明已擦除。apply固定scope直接IPC+Core幂等回执，不入自动outbox。新Begin在所有执行准入通过后同事务消费精确permit并使旧当前内容unknown，失败准入不消费。
4. 重录专用reserved_from支持recorded/unknown，普通reserve/release边界不放宽。许可绑定实体、目标MediaPlan、revision和前序Attempt；取消只能恢复原recorded/unknown/erased，不返blank/sealed或增加池数量。处置需要无活动Attempt/driver执行槽，已开始侧停交、cleanup静止与实体停止事实齐全。ACK不是静止证明。
5. schema20真实迁移及完整性/备份恢复。19→20保持旧physical_copies逐列不变；旧Completed只从首次事件和冻结Plan补档案，media.snapshotSource=legacy-plan-only、缺descriptor明确未采集，不伪造历史照片。其旧reserved占用允许保留。新Completed使用completion来源并必须有型号描述；照片只取同physicalId已有本地JPEG。
6. 图片最多24张/每张1MiB，sha256去重不可变Blob总1GiB、元数据128MiB，测试仅可下调预算；失败整事务回滚，不静默丢图或假报完成。Artwork未取得本地来源标not-captured；JCard待077标not-implemented，不新增下载或音频引擎。
7. 同一Physical Copy在双库仅一盘；正式条目可Artist未知，旧commercial/legacy约束不放宽。unknown不能借旧标题冒充当前内容；origin不变，旧legacy编辑不能修改正式档案。照片按需读取/单图重试，源照片移除不得破坏历史快照。

## 单一写入

- task071_picker：contracts新录音档案合同、collection/physical-music最小字段及index/ipc/validator与合同测试；完成后由root明确转交UI。
- task070_store：record-store/integrity/visuals、schema20/repository、attempt-store/integrity生命周期hook、plan-integrity精确permit hook、backup/restore及相邻测试。
- restore_index_details：record-disposition/coordinator/projections、physical-music投影与相邻测试；attempt-coordinator只新增内部只读执行槽idle检查。与store作者冻结接口，不并改repository。
- root：runtime/utility、Main/preload、E2E、任务/ADR/控制面/报告、统一build与Gate。共享dist只由root构建。

## 验证与保留项

每个行为先真实RED后实现，focused后SPEC再QUALITY，修复重审最多两轮。完整verify/security/Electron/双native E2E、边界/控制/循环和Git身份复核后才报告本地完成。16固定原生和Electron从074逐文件sha核验复制；不修改/重新生成旧证据。

无设备不阻断本软件任务，生产formalReady=false，Gate B/真实录音/Owner均NOT_RUN；不枚举、打开或配置设备。RME/Apogee+Sony仅Owner未来计划，不是兼容或认证证据。R020大库ready、R021旧CDP退出失败、R022真实HAL及R023全历史验证/Stop延迟全部保留至各自验证。075完成前不建立076实现分支。
