# TASK-074：正式录音 Attempt 状态机

基线`017dfef43d615b26db770c206dec2e38105bd1e5`，分支`codex/task-074-recording-attempts`。Owner已明确“持续开发全部任务，直到079，列出todo面板”；GPT-5.6 Sol / High按独立路径并行。仅本地提交，不push、合并main、安装或发布。

## 软件范围与真实准入

依据V3 PRD第59～64节、DAT与Gate B冻结补充，实现明确RecordingPlan的Attempt状态、不可变事件/回执、崩溃恢复、可能写入介质保护及桌面上下文流程。生产Gate B未认证，正式Begin必须拒绝，不新建虚假正式Attempt、不调用设备或将无设备check当准入。测试provider仅在测试构造器注入；不开放Renderer认证或driver事件入口。

1. 固定Plan/contentHash/PhysicalCopy与每个非空Side/Program；源EOF、驱动排空、软件播放完成、实体停止/录制确认、最终核实分别保存。三层完成全部成立且无未解中断才Completed。
2. Cassette A结束后停止、明确实体停止和翻面确认，再由新的显式Begin B执行；绝不自动翻面/续播。空B不制造输出，DAT只有Program、不虚构Track ID。
3. In Progress/Completed/Aborted/Failed/Interrupted分开，源变化/路由变化/断连/读取失败/underrun/崩溃等保留中断事实；停止ACK不代表回调静止或设备排空，迟到成功不能抹掉终止。重启/恢复所有未结束Attempt只增加一次Interrupted，无自动输出。
4. 头投影、不可变事件与幂等回执原子事务；commandId同body返回原回执，异body拒绝，expectedRevision拒绝旧确认。严格预算、分页、schema19备份恢复/只读验证同步，未知或篡改数据拒绝。
5. 开始后可能写入的PhysicalCopy不得由原规划释放/更正路径自动恢复blank/erased；保持库存数量、物理ID与历史，最终双库登记留TASK075。
6. Begin/Begin B/stop不进入可自动恢复执行的outbox；纯人工确认也不得替代新的执行边界。UI保留明确阻断、阶段、三层事实及迟到失效/焦点/720窗口，测试资料不生成正式演示历史。

## 单一写入与协调

- task071_picker：`packages/contracts/src/recording-attempts.ts`、index/ipc/validator注册及合同相邻测试。先冻结contracts-design并通知另两位作者，避免同义接口；之后由root显式转交桌面UI。
- restore_index_details：`packages/bridge-core/src/recording/attempt-state.ts`、`test/recording-attempt-state.test.ts`。纯函数与内部可信事件，和store作者明确函数契约；不改合同、store或运行时。
- task070_store：recording/attempt-store、attempt-integrity（必要）、attempt-coordinator及相邻测试；collection/repository的迁移/服务接线/库存保护；必要backup-index、restore-database、restore-dataset-runtime的schema19接受与完整性验证及相邻测试。精确路径先交root，不改runtime/utility/desktop。
- root：Core runtime/utility、desktop Main/preload注册、必要UI集成及E2E、任务/ADR/控制/报告、统一build与实际Electron验证。共享文件写入先转交，禁止与作者并改。

## 验证与完成边界

每个行为先真实RED再生产实现；focused→SPEC→QUALITY，各新增模块最多两轮。root最后执行完整verify、安全、Electron、双native完整E2E、边界/控制/循环及身份检查，保护所有旧test-results。固定16个原生文件从073逐文件校验复制，不修改或重新生成。旧包CDP退出R021、真实HAL/Gate B R022与实机/Owner验收保留，当前测试不触真实声卡、账号或音乐资料。

软件阶段验证与实机验收分别记账；TASK073实机待验不会阻塞已授权的软件开发，但不据此提升formalReady或认证。当前TASK074未完成，TASK075～079仍按顺序等待本阶段最终HEAD。
