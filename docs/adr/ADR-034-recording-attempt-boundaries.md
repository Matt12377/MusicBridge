# ADR-034：正式录音 Attempt 与执行边界

状态：TASK-074 软件实现；真实输出认证未执行。

## 决定

Attempt固定一份RecordingPlanVersion/contentHash、Physical Copy、Execution Asset及每个非空Side/Program的recipeHash/audioSha256/pcmSha256。源EOF、提交/消费帧、后端drained、引擎停止提交、停止ACK、资源静止和实体停止分别记录，不由一个事实推导另一个。

Cassette A完成后须人工确认实体停止、翻面，再单独请求Begin B。DAT只有Program；空B不创建执行侧。三层完成分别为软件完整播放、实体录制确认和最终核验；未解决中断不会被迟到成功覆盖。重启只追加Interrupted，不自动播放。

事件、头投影和命令回执在同一SQLite事务提交。事件与回执不可变；打开和恢复库先只读验证全历史，再恢复非终态。正常进度预算为安全停止保留余量。可能写入的实体保持占用，旧规划或手工释放不能把它恢复空白；历史存在本身不应冻结别的实体，明确处置与档案登记属于TASK-075。

## 调用与准入

六个有限API通过专用IPC直接调用Core，不进入可自动重放的outbox。业务commandId回执仍持久化；同body可取原回执，异body拒绝。停止不带expectedRevision，避免进度更新挡住停止。

Preload创建时捕获一次工作库身份，等待期间先复制请求；Main核可信来源和严格信封，再转发expectedDatasetId。Core拒绝缺失或过期scope，异步准入后和启动前复核实际库身份。没有Renderer认证、驱动事件或环境绕过入口。

当前生产与合成应用Runtime均不注入正式输出provider，Gate B仍NOT_RUN/formalReady=false；Begin直接拒绝，不新增正式Attempt或打开设备。受控provider仅供构造器测试，测试历史只在专用临时库中使用。

## 生命周期

Begin先持久化再调用driver；同command单飞、全局只允许一个活动执行槽。stop/close先到时，迟到的start句柄仍须关闭；终态不能提前释放仍在关闭的driver。停止持久化失败也不能成为继续输出的理由。驱动close超时不写资源静止事实，Runtime关闭先等Attempt，失败保留为关闭失败，不声称设备无声或整个退出已完成。

## 验证边界

纯状态机、真实SQLite事务/恢复、IPC、真实Electron合成运行及视觉测试分开记账。任何自动通过均不构成真实HAL、设备排空、声音测量、实体录制或Owner产品验收。
