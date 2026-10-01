# MBP-006：紧凑播放事件与有界重同步

基线78502a338b8c59a6160c1cba3f1b7d3497c18fe7，分支codex/mbp-006-compact-events；003B原全量Gate通过、报告已push并核远端HEAD。以下合同冻结开始实施；不换语言、UI、业务数据或播放所有权，不追加真实账号/设备授权。

- 子协议名 compact-v1；IPC_VERSION仍1。Core默认legacy；Main默认显式请求compact-v1，MUSIC_BRIDGE_COMPACT_PLAYBACK_EVENTS=0使Main不请求。一个Core实例仅一个publisher。
- 初始private transfer消息 {type:'musicbridge.core.port', playbackEventProtocol?:'compact-v1'}。没有请求时Core不加ack、不改legacy事件/结果。新Main收到无ack的旧Core明确同child使用legacy，不再重复协商。
- core.ready保留state，响应可选 playbackEvents:{protocol:'compact-v1',coreInstanceId:UUID}；只在请求且支持时出现。未知protocol/多余/private字段拒绝。Main trusted startup client保留ack，旧child/route/lifecycle守卫保持。
- compact ready前丢弃播放delta；先完成原onReady凭据/worker恢复，最后一个await用当前startup client读取原子full seed。其回复之后同步发布ready与seed，不在两者之间再await。若ACK成立后seed失败，不在同child伪降级；按现Supervisor失败/唯一重试预算收尾，旧child确认退出才可能legacy重启。不新增无限重试/第二恢复循环。

## 公共合同

PlaybackStreamStamp={coreInstanceId:UUID,generation:非负safeInteger,sequence:正safeInteger,queueRevision:正safeInteger,selectedZoneId:string|null,trackId:string|null,source:'roon'|'netease'|null}。

generation取实际Controller owner代；同曲重播仍新代，prefix不改代。sequence在同实例跨generation单调且只计compact播放出版；队列revision含items/index/能力/context标志/metadata，纯progress不增。只读snapshot不凭空消费sequence。安全整数耗尽不wrap，不产生看似合法旧序号；需明确失败/重建Core基准。未知实例只能经可信ready或Main当前route的bootstrap读取授权，不能由普通event自授。

PlaybackSnapshot仅响应新增 stream?:PlaybackStreamStamp；请求不许注入。compact命令回执由同publisher给实际返回snapshot stamp，legacy不加。旧回执仍原ACK，compact下缺stamp不直接替换UI。

PlaybackStreamSnapshot={stamp,snapshot:Omit<PlaybackSnapshot,'stream'>}，snapshot和stamp须同一同步采样点，身份精确匹配；不嵌套重复stream。PlaybackStateProjection=Omit<PlaybackSnapshot,'queue'|'stream'>。

新增event：
- playback.snapshot: PlaybackStreamSnapshot（全基准）；
- playback.state:{stamp,state:PlaybackStateProjection,queue?:PlaybackQueueSnapshot}（低频完整state；新revision附queue，一次原子提交）；
- playback.progress:{stamp,positionMs}（O(1)字段；禁止queue/完整track/私有字段）。
compact不再发legacy playback.changed/queue.changed。legacy原publisher两测试和old契约不改。metadata/source/能力/error/owner/seek/queue改变不能误判为progress；合法seek允许回退。

新增IPC playback.getStreamSnapshot:{} -> PlaybackStreamSnapshot|null；同步只读，无SDK/播放/源分页。Main/Preload getPlaybackStreamSnapshot():Promise<...|null>。Main legacy路由/旧Core返回null，不公开任意mode setter；已ACK compact时null或不同instance均协议错误，不悄悄降级。Mainawait后再次核当前route/child，防已resolve的旧回复跨restart返回。

## 私有publisher

factory保留默认可调用legacy形状，compact增加单一canonical出版与capture/stamp接口。Controller subscribe传实际getPlaybackGeneration。纯position走canonical queue引用快路径，不读getPlaybackState clone来推queue变更，不每tick deep-scan或JSON5000项。低频read/命令若有clone可比真实内容；capture同步观察当前facts且不把新facts贴旧序号。emit失败不能假称已送达；下一出版full恢复，缺序号客户端仍有有界readonly恢复。

真实与synthetic runtime必须共用publisher/protocol语义；synthetic有明确模拟generation，不伪称真实owner。原003B lease/对象锚、device completion、Stop未知与录音保护零改动。

## 接收与恢复

Renderer单一stream reducer。可信ready/启动读取授权instance；bootstrap listener-before-read。snapshot可跳gap建基准；state/progress旧/重复seq丢弃，progress必须generation/Zone/track/source/queueRev匹配并连续，否则一次只读重同步。state有queue原子应用，没有queue不能猜未知revision。命令full含stream走相同reducer；同序号只作幂等ACK，不倒退位置。

missing revision/gap只有一个singleflight，自动每incident最多1次；失败保留旧显示并清flight，后续tick不自动无限重拉，显式retry或新ready再尝试。事件保留至多一个最新state+一个同域progress，明确字节上限；若覆盖必要依赖，保留需重同步标记而不猜。更简单可不buffer，seed时序已安全时消费future事件；有损gap明示恢复。readonly失败不给虚假成功。实例/lifecycle换代与dispose废弃旧flight及晚回执。

progress直接更新position，复用queue/currentTrack，不扫描descriptor、favorite、recent。先接受Core协议事实，再决定optimistic preparing视觉，不能因视觉屏蔽丢queueRevision。seek继续草稿/捕获owner与operation，不把旧seek回执写新曲。

Main不为compact progress刷新tray（否则现每event全量getState两RPC仍在）。低频event/full/health仍更新能力和失败恢复。诊断只统计小payload，队列gauge由附queue的state/full更新，不为tick序列化全queue。

## 文件所有权

- Root：Contracts全部新增字段/validator/names/export/测试；Preload API/实现；utility dispatch/initial transfer传mode；Formal task/进度/报告/Gate与结构benchmark。
- Corewriter：publisher与tests、runtime生产+synthetic唯一接线/capture/stamp、必要Controller只读canonical出口（不改业务）和runtime协议tests。
- Mainwriter：core-supervisor.ts/Main index.ts与其tests，启动ack/seed/barrier、route回执守卫、tray过滤。与Root先冻结public types，Main register只调用new typed command。
- Rendererwriter：独立reducer/helper+tests，Session统一应用入口/App lifecycle初始化，progress O(1)/bounded recovery、现有clock/seek/optimism。

所有author不build共享dist/commit/push；RootContracts初次build后只直接tsx行为与隔离noEmit。标准typecheck存在pretypecheck共享Contracts build，不并发执行。作者freeze后独立指定范围复审最多两轮；固定源码原全量verify、mockElectron4、完整E2E108、静态Gate。无删断言/新skip/缩小范围。

## 窄核后必采补充

1. Controller.subscribe给第二optional只读metadata {kind:'full'|'position'}，初始full、原notify kind原样透出；既有单参数listener兼容。publisher.publish接受generation+kind，seek/full不能仅凭position相似被分类progress。Controller owner/mailbox/device/自然终态业务零变化。
2. Utility在getStreamSnapshot成功reply真正postMessage前做最后同步runtime capture与结果验证，此后直到post无await；不能只靠generic awaitdispatch后保留早采样。其余命令原dispatch不改。
3. Supervisor先完成原onReady恢复，再建立专用final seed pending。受信当前port的seed response handler内同步核ACK/instance、置ready、broadcast ready+seed并resolve启动，而不把最后提交放在onReady Promise续体；每次可再入回调后复核当前startup身份，旧route撤销不能继续发seed。legacy startup与现唯一retry/退出屏障保持。
4. Renderer stage至多一个state+同域progress，8MiB只限暂存而不削合法full/UI5000。另保存O(1)连续覆盖区间/真gap及已观察highwater；完整收到的一串同identity纯progress可只重放最后position，不将主动合并误当丢包。被覆盖的必要queue/owner转移、预算溢出或真实gap必须desync，有界singleflight失败不靠下一tick无限重试。seed落后于已丢静止Stop/Pause时不能谎称ready。

## 精确接口名称与授权

CoreRuntime新增getPlaybackStreamSnapshot():PlaybackStreamSnapshot|null与getPlaybackEventProtocol():PlaybackEventProtocolAck|null；BridgeRuntimeOptions/TestBridgeRuntimeOptions新增playbackEventProtocol?:PlaybackEventProtocol，默认legacy。PlaybackEventProtocol是字面量compact-v1；PlaybackEventProtocolAck={protocol:PlaybackEventProtocol,coreInstanceId:string}。Main/Preload方法getPlaybackStreamSnapshot，typed命令playback.getStreamSnapshot。Root只写Utility transfer/dispatch和Preload；runtime生产/synthetic由Core writer独占。

沿用三名gpt-6.1-sol high作者。Owner另允许必要时增加一名审计/测试代理；只在实际收益与并发槽允许时启用，禁止gpt-6-sol。原完整Gate和证据边界不变。

## 审计与远端失败收口

独立R1复现旧恢复flight失败撤销已接纳新full的P2。Renderer用恢复令牌废弃被权威基准取代的读取，迟到成功/失败和finally不得影响新基准或后一incident；原测试保护保留，新加五个竞态用例，R2直接复核。

上一报告78502a3远端verify作业另出现首录音测试等待provider entered未结算、后27项连带取消。Root额外只改recording-attempt.test.ts目标夹具：mock setTimeout，真实FS/FD/provider entered后推进原100/20ms；提前结算必须直接失败，清理始终观察假驱动拒绝。所有资源关闭断言与生产coordinator/input实现保持。独立受控复现说明start前耗尽期限的机制，不声称已量得Linux具体慢步骤。此精确测试delta并入同一R2；完整Gate覆盖最终源码。
