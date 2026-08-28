# TASK-071：Source Picker 与双库交互补齐

基线 `72db8616ddbb461b93e9ffa960576af052c2bdf6`，分支 `codex/task-071-source-picker`。Owner持续开发与GPT-5.6 Sol / High并行授权。TASK070已完成本地自动Gate并clean封版，完整TASK064～079 TODO保持；不push、不合并main、不发布、不访问真实资料/账号/硬件。

## 范围

1. 现有Source Picker增加“Roon浏览 / 已登记收藏关系”局部tab。复用矩阵、数字详情和运行态API，展示Exact/Probable/Related、实体数量与PhysicalOnly/DigitalOnly/未核实。只有当前可用Roon引用才读曲目；离线/needs-resolution保留本地关系，不按标题猜身份、不自动重新定位。关系内选曲与原Roon浏览共用有序选择，跨专辑返回不丢，最多100首/次，明确确认后原append/outbox一次写入。关系不是Source Lock，不播放、不增库存、不写关系。
2. 录音页增加一个由只读事实及用户明确选择历史上下文导出的主要下一步。优先处理原命令、未保存修改、读取错误/未读取、空曲目、源运行/缺失/变化/撤权、媒体规划/预留/复核、母版布局、用户所选Direct/Logic/PREP路径及执行资产检查。不得取各历史集合latest拼成就绪；plan/layout/preparation/prep选择属于本次Renderer上下文，重开需重选，不新增正式Plan持久体。读取失败不解释为未配置；正式Preflight仍待TASK072/F01，不显示可开始正式录音。
3. 当前照片组件延迟到近可视区域才请求有界图片字节，保留比例/来源区分、卸载迟到保护、单图失败明确重试。组件嵌套卡片button时不能再嵌button；重试放独立安全入口或显式非交互模式。不改照片数据库、不修改原文件。合成长名/窄窗/键盘先实际RED再做必要布局修复；不重设计照片墙和侧栏。

## 唯一写入路径与分工

- Picker作者：`MasterSourcePicker.vue`，新增`source-picker-controller.ts`、`SourcePickerRelations.vue`，新增`apps/desktop/test/source-picker.test.ts`。不改RecordingView/App/合同。
- 下一步作者：新增`recording-next-step.ts`、`recording-workflow-controller.ts`、`RecordingNextStep.vue`，新增`apps/desktop/test/recording-next-step.test.ts`。不改RecordingView；先交集成接口，所有生产只读。
- 照片作者：`CollectionPhoto.vue`，必要`CollectionPhotos.vue`、`PhysicalMusicView.vue`，扩展`apps/desktop/test/collection-photos.test.ts`及必要新增纯加载控制器。不得改CollectionView/照片存储；卡片和大图语义分别保持。
- 照片作者交回实现后转测试：仅新增`apps/desktop/e2e/task-071-photo-workflow.ts`，导出合成图片验收helper；不再写已交回生产文件，root调用与执行。
- SPEC1修正授权（下一步作者唯一写入）：`MediaPlanningPanel.vue`、`MasterVersionsPanel.vue`、`ExecutionPanel.vue`及新增`apps/desktop/test/recording-panel-context.test.ts`。仅增加可选初始上下文、失效时不回退首条、媒体候选照片安全单图重试；不改合同/Core。先行为RED，再实现。
- 最终Gate夹具修正（root唯一写入）：`apps/desktop/test/command-outbox-store.test.ts`仅跨进程持锁fixture的强引用和显式GC压力。正式store不变；先强制GC复现原失败，再保持生命周期至SIGKILL，原排他/崩溃恢复断言保留。此为最终Gate根因裁决，不开第三轮规格/质量审查。
- root：`RecordingView.vue`、新增`apps/desktop/e2e/task-071.spec.ts`与`apps/desktop/test/recording-workflow-integration.test.ts`、`tsconfig.e2e.json`、既有`v1-ui.spec.ts`仅照片失败文案和近可视触发前提适配、本任务/ADR/控制/报告。统一build/Electron/E2E；全部共享文件交回后才改。

其余合同/Core/Main/preload/utility、库存/关系/备份数据库均不变。必要新路径先更新本清单并明确唯一owner。外部收藏一键跳录音与任意Roon结果反向badge不在本片最小范围；Picker本身完整显示已有关系，不以title-match伪造。

## 事实和交互要求

只读facts使用现有getDraftSources/listMediaPlans/listMasterVersions/listPreparations/listPrepared/listExecutionAssets。必须校验draftId、草稿revision和所选plan/layout/master/preparation/prep谱系；当前源内容、规划输入或预留变化时不能把旧冻结历史当作当前就绪。历史仍可查看，不改旧M/L/PREP或asset。

关闭源/规划/版本/Logic/PREP/执行面板后刷新，草稿修改保存/切草稿/工作库激活时使旧上下文失效；代际标记拒绝迟到结果。只有一个主要CTA，旧工具仍可明确进入；aria-current步骤来自同一reducer。按钮名称不与旧工具入口造成无意歧义。读状态与原命令重试分离，不绕过pending。

局部来源tab方向键/Home/End、Esc与返回焦点；关系→曲目→返回保留已选；720×480与1440×900无横向溢出，240字符中英文长名、横竖图/无图/失败图，axe serious/critical=0及截图实际查看。照片离屏不预取、滚动后读、卸载不回填；保持原音频/照片字节及库存、关系守恒。

## 验证与接续

TDD真实RED→GREEN，规格先质量、各最多两轮，无第三轮；统一verify/security/Electron/完整E2E含固定native、control/boundaries/cycles、身份/清洁与报告核对。独立实现/报告/最终提交。TASK072须满足F01明确政策后才冻结正式Profile Snapshot/RecordingPlan；当前不自动删音频、不正式录制。真实Roon/资料/SourceRoots/Logic/硬件与Owner验收仍NOT_RUN，旧视觉/发布/R020 carryover不自动关闭。
