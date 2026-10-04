# MBRS-002 数据与资源权威登记

实际基线 `f34dd904a473893f213a2a894b858c4ddfbf4423`。默认Node；可选Rust收藏只读默认OFF，library_write_enabled及source files写入OFF。B1/B2/B3/B4与新refs在最终自动Gate中实际67项通过，三包类型检查、新编译56合同源/168产物及声明输入身份通过；完整工作区回归已通过：4144总/4142通过/2既有native条件跳过；独立审查和提交待。真实用户DB、媒体、Roon、Provider帐号及Owner验收未运行。

| 领域/库 | 实际进程/唯一writer与逻辑权威 | 命令、事务和读者边界 | 已有证据及后续职责 |
|---|---|---|---|
| 收藏、实物关联、录音与本地目录，激活业务库 | TypeScript/Node，Core既有DatasetOwner worker；同CollectionRepository与SourceStore，同连接local catalog | 原私有port→scope/epoch→dispatcher；UI/Main/扫描器不能直接写SQL。entity与完整body fingerprint receipt同一短BEGIN IMMEDIATE | 自然30→31新增8表，不迁Rust writer；旧103全事实/13API×2保持、111全事实冷开稳定；失败回滚、默认和激活备份恢复保留31新增实体与override |
| 根许可与私有定位 | 同Node owner；SourceStore是path/dev/ino/authorized唯一权威，LibraryRoot引用sourceRootId | 普通client/validator/outbox/Main拒六trusted root/asset观察及locator/权限代际注入；internal入口也核原scope；公开DTO无private relative/path | 真实worker/旧epoch/closing/两库scope已测；trusted internal register/move观察不是Renderer第二许可；恢复撤销source_roots.authorized；003扫描、005真实FD后续 |
| 备份维护库 | 既有DatasetOwner的createBackupWorkflowStore/restore-dataset-runtime | 私有backup-maintenance.v1.sqlite；独立维护journal与短事务 | 文件/业务DB/维护DB分阶段对账；维护失败不称业务COMMIT回滚；实际备份核验→隔离恢复→激活→冷开已有合成证据 |
| Main命令outbox | Electron Main原createCommandOutboxStore/service/executor，Core不写此库 | 私有command-outbox.v1.sqlite；confirmation/sending/uncertain/ACK为Main自己的事务 | 实际业务commit后断回复及Main成功ACK落盘失败均UNKNOWN；独立冷恢复零自动发送/执行，显式retry保留原commandId/完整body/scope并查业务receipt，不制造第二业务写 |
| catalog实体/raw/override/账本 | 同激活业务库的localCatalog唯一writer | local_catalog_roots/assets/tracks/editions/edition_tracks/observations/overrides/ledger；raw/ledger不可变，完整body冲突拒 | 同库transaction不跨库；热写只相关事实/receipt，外部提交使冷核凭证失效；公开列表最多200返回、201 sentinel拒绝，不剪除域内已有事实 |
| 本地只读来源准备 | Core私有prepareLocalSourceReadonly，仍读同Repository/SourceStore | 不写库/文件，不openFD/HTTP，不入队或生成Playing；服务端captureTarget不接受payload参数，double capture/currentness/许可与关联重核 | 真实合成Repo加合成server authority的descriptor仅unit；普通owner三动作真实unsupported，不能公开prepared；006接真实selectedCore/Zone与原Controller，005固定FD |
| ScanJob / 本地MBQueueEntry持久记录合同 | 新DTO与闭集guard；没有新增实际表、服务或writer | ScanJobRecord/ScanJob：root/job修订和opaque checkpoint；LocalMBQueueEntryRecord/local-only MBQueueEntry：独立entry/queue、来源精确快照、目标意图及reResolve=true/autoplay=false | 已应用、6refs行为case在最终Gate通过；JSON往返不证明SQLite持久化。003沿原owner实现scan/checkpoint/恢复，007沿原协调者实现实际队列保存/重启解析与禁自动播放，不能从DTO注册第二资产权威 |
| PlaybackSnapshot/compact与attempt/队列状态 | 原Node BridgeController唯一协调者；UI仅观察，Adapter回调是播放观测来源 | attempt/generation/session/queueRevision由原coordinator；公开请求不控制时序；legacy/compact-v1仍roon/netease | B4兼容guard与10项测试已在最终Gate通过，测试接点未接生产Controller；独立local observation leaf不是第二全局状态。AT04/09/10与006/007继续PARTIAL |
| Rust收藏快照 | Rust sidecar只读，默认OFF；Node保留此业务库writer | 仅借Node已核revision快照，原2k/5k型号协议与回退 | 不作为数字曲目索引，schema31和新增DTO不代表Rust交接、双写或第二作者 |
| FD lease/源写锁/Organizer文件journal | 后续沿既有owner/coordinator的授权接点 | 文件与两个DB没有共同COMMIT，扫描器/UI/sidecar不另写同库 | 005/011/012/014固定FD/相同资源锁/准确文件计划与撤销；真实文件操作未运行 |

原完整body fingerprint、expectedDatasetId、旧epoch与closing围栏继续绑定到同command receipt。UNKNOWN不自动重播；Main账本与Core业务receipt各自有界恢复，保留实际故障结果，不能把不同库的COMMIT称全局原子。

业务库schema31可冷开核验/备份/恢复；旧二进制不能直接打开未来schema，降版需在独立候选保留新数据。旧103全表facts覆盖非空master/plan/record/attempt/SourceBinding/收藏关联，但prepared_versions与legacy_recording_content为空；旧逻辑队列仅内存、无旧持久表。这些缺口不能由新记录DTO或JSON往返升级，AT02保留PARTIAL。

最终Gate实际16/41/10项TAP全部通过，所有16个适用nested测试文件均在冻结名单并执行，56合同源/168新产物和1040声明输入前后保持。完整旧回归类型/构建exit0，4144总/4142通过/2既有native条件跳过；正式审查与实现/报告提交身份由root继续取得并记录。本文件不改原001封存或R16/000结论。

最终根证据：ROOT=`/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-postrust-v12-j0tjux6s`，`mbrs002-final-gate-normal-01/manifest.json` SHA256 `985b55df484ea204b3fc112c83497e98e227823fe62b415bdd146874b432a6d8`；最终编译出口与单次EIO后验各退出0。输入身份为声明范围，不是完整传递依赖闭包。refs segment隐藏键问题在原第4case实际RED后，只修本叶闭集，原6case在最终Gate通过；旧catalog/旧协议生产guard保持。
