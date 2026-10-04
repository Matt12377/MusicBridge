# MBRS-002 模型与状态映射

基线为 MBRS-001 最终报告 `f34dd904a473893f213a2a894b858c4ddfbf4423`。原任务与11条AT的 id/kind/requirement/断言不变。原 `13_MODEL_AND_STATE_MAPPING.md` SHA256 `0a8ccb718473c9dc2e5aecffb37eeb7754fcbc72eaf09f335d308fd270b966b5` 的第一张表实际为8个语义行；下表逐项保留，并明确本次追加域。

当前实际证据：最终自动Gate实际重新编译56份合同源码，生成168份产物，完成三包类型检查及contracts16/core41/desktop10共67项行为，全部通过、无fail/skip/cancel/todo。1040声明输入与新产物前后一致；154公开请求向量和新增编译出口另经root验证。B1/B2/B3/B4及ScanJob/本地队列结构合同包含在该次实际执行中。单次首日志EIO验证了编译exit0/实际close、Gate exit1、失败收据与脱敏捕获保留，严格后验exit0。完整工作区回归已通过：4144总/4142通过/2既有native条件跳过；两路正式审查已封存，状态文档P2同轮闭合；初始49d9d8a3自然CI旧schema断言失败保留；三条完整合成Electron流程修正后全部通过，修正实现8a1d3f6c已push并核远端HEAD，新SHA源自然CI实际4workflow/6job全success，新exactHost归档82/82字节核验通过；新GateZIP超时及跨Gate身份未知、宽ElectronZIP未下载/Main未核，归档整体PARTIAL；独立报告身份按报告Git历史解析，报告自然CI另行取证。单LF格式修正后完整回归精确复用、未再次full执行；本段仍为有限合成软件证据。

| 原语义 / 本次追加域 | 实际模型与身份 | 权威、关系与证据层级 | 继续关闭的边界 |
|---|---|---|---|
| LibraryRoot | UUID、sourceRootId、role、正十进制revision | 逻辑根仅引用SourceStore许可；重关联提高root revision，同库唯一catalog | 物理路径/dev/ino/许可仍以SourceStore为准；普通扫描与多根实际工作流003 |
| AudioAsset / LocalTrack | 独立asset/track UUID；root/file/location/selection修订；segment为真实LocalTrackSegment或null | 同名同Hash不合并，位置/内容分修订；多曲目和片段独立；精确半开帧范围/时间基，raw整数不用Number | 私有locator不是主键或公开DTO；CUE实际解析003，固定FD/片段能力005/007未取证 |
| AlbumEdition | 独立edition与关系UUID、disc/trackNumber/sequence/active | 同名同描述不自动并版；解除一个关系不删除共享track/asset | 扫描发行版判别与展示003/004后续 |
| PlaybackAttempt | 原BridgeController intent/attempt/generation/ownership | 新公开九字段只提供稳定ID/revision/target/action；内部intent guard只验证结构，不分配计数器 | 006实际Controller创建/校验，不能由typed origin字段或合成authority判真实性PASS |
| MBQueueEntry | LocalMBQueueEntryRecord，明确local-only MBQueueEntry/LocalMBQueueEntry别名；schemaVersion1.2、dataset/entry/queue独立UUID、entry/queue修订和精确orderIndex | localSourceSnapshot显式保存track/asset/root/sourceRoot、四类修订及实际segment|null；Core/Zone仅目标意图；restart固定reResolve=true/autoplay=false | 仅DTO/闭集guard，6refs case已在最终Gate通过；没有生产表/保存API/queue生命周期，JSON往返不等SQLite持久化；旧内存队列迁移证据空缺，007实现重启解析/禁自动播放，006权威目标 |
| PlaybackObservation | 原Adapter回调、PlaybackSnapshot和compact链；新增独立LocalPlaybackObservationLeaf | legacy/compact-v1保留roon/netease与原safe integer位置；未知local明确unsupported，未知position=null只在新叶合同，不伪0 | B4源/10测试已在最终Gate通过，兼容接点只在测试调用；leaf不注册全局IPC事件或替换snapshot；006/007生产投影/协商 |
| AssetLease | 原token、录音只读租期与同一写锁经验 | 本次resolver只读私有descriptor，不openFD/HTTP/Playing/queue | 005固定FD租约/身份围栏/跨pause和seek，真实媒体NOT_RUN |
| OrganizerPlan | 原outbox/幂等/恢复模型 | 本次实际两DB UNKNOWN/回执查询/显式同command retry；不新建协调器 | 011/012/014准确文件计划、资源全集、journal与撤销；不承诺跨文件/跨库全局原子 |
| 追加：raw / override | raw观察独立UUID/track/source/parserVersion/revision；人工override独立revision | raw历史不可变，新raw不抹人工值；公开读最多200行，LIMIT201 sentinel在解析/聚合前拒绝 | 全域数据不因读预算削减；源文件写入OFF，004实际元数据/歌词规则后续 |
| 追加：ScanJob | ScanJobRecord与ScanJob别名；schemaVersion1.2、job/dataset/root/sourceRoot UUID、root/job修订、opaque checkpointRef、精确progress/phase/failureCode | 合理新字段实现选择，原包没有两份记录JSON schema；复用catalog guard；不保存私有path/secret/session | 仅DTO/guard，JSON case已执行；未建实际表/命令/worker/counter；003实现持久checkpoint/取消恢复且重核root权限/修订 |
| 追加：SourceBinding / Frozen / 录音与收藏旧事实 | 保留全部旧ID、SQL、完整列、typed cells、行序与账本；103旧表、13实际API×2，升级后111表冷开稳定 | 非空record/plan/attempt/master/layout、SourceBinding3及收藏关联已造数并实际迁移；原VersionStore/SourceStore/RecordingRecordStore保持权威 | prepared_versions与legacy_recording_content空，不能称全部Frozen非空覆盖；旧队列无持久表，AT02仍PARTIAL |

公开 localCatalog.prepare 仍沿原scope/owner入口。真实普通worker的PLAY_NOW、APPEND_MB_QUEUE、PLAY_NEXT_MB_QUEUE全部返回TARGET_AUTHORITY_UNAVAILABLE unsupported；没有把payload目标自报成服务端权威。`prepareLocalSourceReadonly`在真实合成Repository/SourceStore与合成server authority下校验当前许可、root关联及修订，产出私有descriptor；local分支零remote/cloud/Roon mapping调用，remote正控制保持原stream。该私有unit不是公开prepared或播放成功，也未证明真实文件存在/可读。

AT02旧队列/空Prepared与legacyManual、AT04播放观察、AT09内部coordinator origin、AT10真实Controller投影均保持PARTIAL/carryover；有限002合同/存储证据不代替006/007、App/live或最终Owner测试。

B1合法50000曲目、100004实体与回执行、29501588字节目录TEXT合计可冷开分页；1024既有历史中whole-track热写返回SQLite Statement行9、完整integrity运行0。此度量不是VM扫描量、真实库延迟或003的100k/300k全负载。三个公开列表单次200/201 sentinel限制不削减501项的全域合法事实。资源预算是有限策略；内部预算域错误仍映射INVENTORY_UNAVAILABLE，用户域级扩容提示后续处理。

schema31迁移/冷开/备份恢复执行完整SQL、不可变历史、关系/FK/integrity；热写仅相关事实与同事务receipt，外部提交使完整冷核凭证失效。旧二进制不直接打开未知schema31；回退必须保留新库并在独立候选恢复，不覆盖新数据。

历史首轮根证据（由本文最终Gate03覆盖）：ROOT=`/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-postrust-v12-j0tjux6s`，`mbrs002-final-gate-normal-01/manifest.json` SHA256 `985b55df484ea204b3fc112c83497e98e227823fe62b415bdd146874b432a6d8`；最终编译出口与单次EIO后验各退出0。输入身份为声明范围，不是完整传递依赖闭包。refs segment隐藏键问题在原第4case实际RED后，只修本叶闭集，原6case在最终Gate通过；旧catalog/旧协议生产guard保持。
