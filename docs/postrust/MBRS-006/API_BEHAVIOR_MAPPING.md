# MBRS-006 API与状态映射

本文件记录006有限软件候选的接线与验证边界；最终退出码、提交、CI和验收状态以独立结果报告及机器状态为准。基线为005最终报告cce8594；原11AT文字和kind保持。真实Roon、LAN/NAS、听感及Owner验收不能由本文件代签。

| 接点 | 本次行为及验证要求 |
| --- | --- |
| `utility-main.dispatch` → `runtime.playbackPlayLocal` → `BridgeController.playLocal` | 公开九字段请求进入原协调器的三动作；同request_id回同一受理结果，既有网易云/native入口保留。legacy实际运行入口必须明确unsupported；compact-v1才支持local。 |
| `RoonAudioInputAdapter.captureLocalTarget` | 使用锁定SDK实际core_id、选中Zone、配对连接代际和不可逆目标结构代际；Zone/group指纹恢复不能复活旧意图，普通进度及无关Zone不撤资格；公开target只作约束，显示名称和请求字段不能自证。 |
| `DatasetOwnerEndpoint`私有capture/revalidate/release → `createLocalSourceTickets` | 唯一Owner读取同一SQLite连接的扫描accepted资格、asset/file/root/location/selection/sourceRoot事实；每次新ticket和16字节SAB，有限容量16。票据不经过公开IPC、Renderer或Rust只读snapshot。 |
| `LocalSourceFence.dispatch` → `RoonAudioInputAdapter.sdkDispatch` | CAS claim仅覆盖实际同步SDK send，所有await后和发送前核Controller/Owner/Core/Zone及票据；发送已出不能由本地abort撤回。独立自有session清理不借失效票据控制外部播放。 |
| catalog.transaction / catalog.privateBatch / SourceStore.revoke | 最终COMMIT前在原连接读最终事实并不可逆撤票；只封相关依赖。Busy必须先确认ROLLBACK成功，再事务外有限等待quiet、使用原commandId重核；COMMIT或ROLLBACK未知封Owner而不重放SDK。 |
| `StreamRegistry.registerLocalSource` → 005 Pool/Gateway固定FD | 继续scanner observation→expectedSignature→固定FD及全局物理读guard；HTTP整文件/Range完成不等于Playing或下一首。CUE非null片段仍拒绝，不隐式替换成整文件。 |
| `BridgeController.startLocalItem`及Adapter私有session回报 | PREPARING、SUBMITTING、AWAITING_ROON、PLAYING、PAUSED、SUBMISSION_UNKNOWN、OWNERSHIP_LOST、终态分别表达。SessionBegan确认与真实Playing回报分别处理；迟到回报只调和本attempt，旧A不得覆盖/清B。 |
| compact发布、歌词和桌面consumer | 保留local_file命名空间与明确本地身份，不做网易云数字ID或smart映射。暂缺本地歌词时明确unavailable，不调用云Provider；收藏和最近播放由显式来源授权。 |
| runtime正常关闭与utility Owner fatal | 先同步seal派发，收口所属attempt并join真实prepare/HTTP/FD，再关闭Owner及退出；窗口隐藏沿原策略。未quiet不释放物理锁或宣称成功，远端停止未知另列。 |

001锁定SDK为`node-roon-api-audioinput` rev `21ff59e52a12cf36a21bb9d3fd546f3e6d70581f`。begin_session的SessionBegan消息体提供私有session；play事件以实际消息名识别。controls许可与HTTP成功不能升级为Playing。seek调用沿原Adapter换算：公开毫秒、SDK transport绝对秒。raw session只保留私有关联，公开session_epoch使用不透明身份。确定MediaError、StoppedUser、主动stop及prepare失败先更新同attempt终态，再收资源；未知回报仍独立表示。原native分页→本地PLAY_NOW撤旧context，追加/下一首沿原分页物化与提交准入，避免第二队列和mailbox自等待。

公开本地quality四轴（HTTP字节、Signal Path、数字输出、gapless）保持各自未测状态，文件格式和大小不能冒充Roon实际输出。没有本地HTTP请求观测时交付状态显示UNKNOWN；HTTP完成不会触发Roon终态。

| 原AT | 软件层需保留的行为证据 | 原真实层 |
| --- | --- | --- |
| 01 live_roon | 唯一Owner、Controller、FD和SDK Fake接线只能证明软件流程 | 20真值样本NOT_TESTED |
| 02 integration | 禁用mapping/sidecar/封面网络和云依赖仍走本地链 | 不代签真实播放 |
| 03 unit | 各阶段区分，HTTP完成不Playing/不推进 | 不代签真实状态 |
| 04 live_roon | pause/resume/seek受控回报及能力负例 | 真实控制与歌词时间NOT_TESTED |
| 05 fault | begin/Playing丢回报先调和，不重复begin/play/队列副作用 | 不代签真实故障恢复 |
| 06 fault | A→B、旧epoch/session和晚SQL失效安全收口 | 不代签真实快速切歌 |
| 07 live_roon | takeover/Zone/group/断连受控负例不抢回、不global stop | 真实接管NOT_TESTED |
| 08 integration | 增强关闭无依赖，Core退出join与窗口隐藏边界 | 普通AppNOT_RUN |
| 09 integration | 原网易云/native回归，local不隐式换源、不云收藏 | 真实账号NOT_RUN |
| 10 integration | 原Controller/Adapter/Owner增量接入，无第二播放器 | 不代签新产品验收 |
| 11 unit | 本地ID、事件、队列、歌词、实际consumer来源一致 | iOS合同采用另跟踪 |

自动Gate复用001的外置/hosted准入和TAP完整性校验，重建contracts/Core/固定metadata worker，再核contracts、Core、Desktop与E2E类型及四组行为。产品数量只由完整实际TAP冻结，不用声明数、准备失败或旧报告代替。总预算6分钟、单阶段3分钟；本机路径均在外置LifeWeave，不重跑100k/300k。最终报告记录冻结源码与新鲜产物身份、原失败保留和证据层级；007队列/预取、008音质、009正式库UI及012/014源写保护仍分别负责后续范围。

候选新增46项：Core41、contracts2、Desktop3；最终有限Gate额外保留563项受影响回归，总609。计数由完整已执行TAP冻结，最终Gate仍需重新验证各组数量与fresh产物。行为入口为`packages/bridge-core/test/mbrs006/`、`packages/contracts/test/mbrs006/`和`apps/desktop/test/mbrs006-local-consumer.test.ts`；实际Owner/SQLite/扫描→FD、Controller/SDK Fake三动作、迟到/UNKNOWN/目标变更、终态与默认Node utility阻塞IO/fatal均分别取证。

R1四项根因通过同case有效RED后修正：重复shutdown共用先登记的完成/拒绝flight；旧分页context；本地确定终态；Zone/group ABA。正式审查最多两轮，最后结果和原失败指针进独立报告。20真值样本、四轴音质、真实账号/Roon/LAN/NAS/普通App及Owner均未运行，不用上述软件计数抵扣。

本次有限资源上限为Owner票据16、本地request_id回执256；相同请求返回原Promise，回执容量满明确拒绝新请求。当前没有持久回执清理策略，后续007需与队列恢复策略一并评估；本次不宣称无限长运行容量。SDK递交后HTTP观测仍UNKNOWN，四轴质量未测。

初始源b50261e的实际security与workspace仅同一个旧preload方法闭集期待失败；原29安全case中28通过，工作区4330总/4327通过/1失败/2原条件跳过。仅给原strict期待加已审的playLocalLibraryTrack，不放宽其它keys/私有负例；原54冻结路径不变，完整安全29及Desktop组合121重新通过。7文件定向安全组并入最终Gate，原失败保留，旧CI不rerun。

第二源5dd13d2的workspace4330总/4328通过/2原条件跳过已成功，后继001离线Gate实际失败；同源本机复现32总/31通过/1旧SessionEnded通知期待失败。仅更新旧测试与合成POC的同根因期待，保持严格资源/迟到负例、32case和118既有回归；完整001软件Gate已通过。原55路径不变，最新57冻结；该32项与八个直接输入并入006有限Gate，重新绑定609组计数，不修改历史001报告或升级真实验收。

第三源 a940c340 的远端 Core 单测在原 recording-capacity-queued-stop 的 progressMs≤100ms 断言失败；实际值未输出，不能由2803ms整条case耗时推算。Contracts256通过，Core2648总/2645通过/1失败/2原条件skip，Desktop未执行。该产品源码与第二源完整workspace通过时相同；跨文件争用为待证推断。Root只把原8项墙钟测试移至全Core普通阶段自然成功后的独立阶段，其余文件保留原默认并行，全部case及100/250/500/2000ms阈值、原105-child窗口和历史收据不变。原文件并入有限回归，389项与32脚本已通过，最终609 Gate另以新收据绑定。

同一第三源另有旧Electron E2E严格定位失败：TASK-085成功回执和静态hint都包含“原 ZIP 不长期归档。”，原getByText命中两元素，103通过/1失败/4原skip。此为独立根因，不归因排队Stop耗时。只修一行原断言为role=status并匹配完整成功回执前缀，其余case/阈值/产品不变；先前57文件保持、冻结共58。本机单case入口因官方Electron本轮身份收据和native可执行前置缺失而未进入测试，退出1记PREPARATION_NOT_REACHED_TEST，不称GREEN。新自然CI实际E2E结果另封存。旧E2E文件加入声明输入，有限功能Gate仍609项。
