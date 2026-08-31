# TASK-076：Digital Replica历史音频与会话

基线`7f890be5badee3e9ea08355729e29c5aefeec377`，branch `codex/task-076-digital-replica`。075已本地封版，本任务正式启动。Owner授权软件开发至079、Sol/High按路径并行；不push/merge main/安装发布，不读取用户源、不操作设备。对应PRD§66及已批准F01。

## 范围

1. 明确历史Record为根，选择actual-execution或original-render及A/B/Program；只使用冻结Plan、Prepared/Execution谱系和FINALIZED归档对象，或当前活跃恢复binding。不能调用依赖当前Session/预留的Plan.capture。当前内容未知、已擦除、后来Master变化或旧源离线不否定完整历史执行音频。
2. 实际执行目标严格匹配冻结文件/PCM hash、format、frames、recipe和归档角色；原始Render匹配冻结原件hash/帧/采样率/声道，编码从原件有限WAV解析，今天计算的PCM hash标为verified-render-bytes。Direct无original-render；空B无音频不创建0帧成功；不重复添加烘焙gap，不自动转码、重建或替换同名源。
3. 只读O_NOFOLLOW授权FD，完整文件/PCM核验、单链接/路径与句柄身份、实时撤权/取消/末验。正常FINALIZED归档及备份恢复单链接不放宽。metadata-only恢复无音频能力，不回退历史路径；所有恢复能力需live授权闭包。
4. 六API：getRecordingReplicaStatus、inspectRecordingReplica、cancelRecordingReplicaRead、startRecordingReplica、getRecordingReplicaRun、stopRecordingReplica；IPC recordingReplica.status/inspect/cancelRead/start/get/stop。固定dataset scope、严格DTO、无路径/FD/设备/测试provider公共参数，不入outbox。
5. 单活动会话、有限runId/readId账本（上限不靠驱逐旧取消ID重新放行），取消先到、相同请求不重复运行、异body冲突、首终因保留、关闭与迟到句柄都等待资源收口。停止应答不等于静止，closing超时不能释放FD冒完成。保持Attempt/Record/当前内容与库存不变；与已有Attempt执行互斥。
6. 私有provider测试构造器可注入合成消费，成功证据明确synthetic-only；正常和合成App runtime均无真实provider、status blocked/start NOT_READY、不开设备、不制造正在播放/完成状态。此子阶段软件通过不等于PRD可听播放或Gate B/Owner通过。
7. 长租期不得直接全局取消15分钟限制。旧source/output-check/helper默认预算保持；新Replica按不可变目标时长及准备/末验/cleanup有限预算，单调时钟控制，测试只收紧或注入时钟。当前synthetic维持有限运行上限。超限明确拒绝，不自动分段重启或续播。
8. 075明确历史详情内局部Replica入口；核验、目标与侧选择显式；后端blocked时不可点击播放，分别呈现音频可核验/后端缺失。读失败不是空对象，取消失败保留run恢复入口，焦点/窄窗/卸载迟到防护沿现模式。无第二份库存或永久业务表。

## 单一写入

- task071_picker：contracts recording-replica.ts与index/ipc/validator及合同测试；冻结后再转Renderer局部面板/controller与075详情入口。
- task070_store：replica-input.ts、必要readonly store seam、source-files/execution-wave最小新内部函数、相邻真实归档/恢复输入测试。不得改会话/runtime/合同；原默认安全限制不放宽。
- restore_index_details：replica-coordinator/error/provider内部接口与会话测试、必要Attempt执行互斥只读hook；与input作者先冻结私有接口，禁止并改input/source-files。
- root：runtime/utility/Main/preload、公共E2E、task/ADR/控制面、统一build/Gate与报告。共享dist仅root构建。

## 必须的RED/GREEN

历史与当前解耦、Direct gap exact PCM、Prepared两目标差异、旧源离线只归档仍可验证、缺失/篡改/硬链/恢复撤权拒绝、真实完整备份恢复与metadata拒绝、取消先到/迟到/同ID冲突/close/FD收口、无设备默认零输出、所有路径零Attempt/Record/库存变化。全verify/security/Electron/E2E、身份/控制/边界/循环和16native pin验证后才封本地软件阶段。R020-023与073/Gate B/Owner保持开放。
