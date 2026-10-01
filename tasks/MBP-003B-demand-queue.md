# MBP-003B：Core持有上下文与先播后补

Owner已授权连续11项计划；本步骤基线MBP-004最终报告02125604ab19a62f85a7b75d84b400f9d0e3f105，独立分支codex/mbp-003b-demand-queue。与003A共同组成MBP003，整任务验收后计数6/11。保留技术栈、收藏UI、真实数据、Source/action策略；不接真实账号/Roon/音响/SSH/录音，不认证GateB、不合并main/替换App/发布。

响应RoonLibraryPage新增可选playbackContextHandle(UUID)，由Core绑定scope/service/parent kind+ref/origin sourceEpoch，累计所有已公开valid位置，引用复用原ReferenceMap。初次播放只需selectedRef/Zone/contextHandle，旧queueReferences兼容但两者互斥，Renderer不伪造private cursor/sourceIndex。存在却无效/过期handle拒绝，不能静默降级；缺字段/开关旧模式仍旧全collect。后台曲目response-only roonItem保留可信公开metadata、收藏与重播，请求不得注入。

Core同步acquire只从已公开连续window投影initial，零额外SDK，selected尚未授权则停止旧播放前拒绝。从原Core检查点fork独立owned Browse session/context与新local epoch，pin至释放；UI离页取消不会退休owned session。origin epoch仅授权来历，owned epoch明确不同，不冒称上游不可变快照。每页仍原路径/索引/action重验证，scope/service/Zone撤销两者；上下文8MiB/64entry/每entry8192pos/idle5min，owned最多2，同既有缓存/实际RPC预算结合，不能以计数替代字节或声明RSS。

私有roon/playback-context.ts接口冻结：item={reference,zoneId,track,roonItem}；page={items仅track,offset,nextOffset完整valid位置,complete当前页到源EOF}；lease={initial:page+selectedIndex,isCurrent(),read({offset,limit},{signal,isCurrent}),release()}。read无Controller游标消费副作用，最多100valid/页，自有10sec期限与owned信号。Controller持visible before/after cursor及EOF，不能将genre过滤后的track数量当valid cursor；空track页可继续推进，不伪EOF。

Controller.replaceRoonContext先规范化initial及current，再停止旧播放。首次Native/Transport确认后最多一邻近页预取，边缘Next/Previous/自然结束按需加载，普通播放不灌满5000。读页不进入短mailbox、playbackCommandTail或deviceTail；只有短commit核context对象、独立queueGeneration、Zone/scope/epoch/abort。补prefix/suffix保留原QueueItem对象与当前项，不replace/restart或重复SDK queue。未读边缘能力、loading和可重试/过期/容量错误可观测，不把页末当源EOF；预取失败不停止当前曲。

Stop/replace/clear/shutdown接受即取消loader，迟到零commit/派发；未知Stop保留device owner锁。正常切歌不能在stopActive()统一撤销context。原生自然终态复用runtime handleRoonPlaybackState，核新鲜Zone、revision、now-playing身份和generation，不把旧stopped/外部停止/缺观测当自然结束；自动推进以QueueItem对象锚，不依赖prefix前的旧数字索引。003A实际SDKcompletion屏障、取消准备、Smart及Provider规则保留。

显式手动append/insert需完整保序：独立queueEditTail和单expansion gate在mailbox外事务drain，local cursor暂存before/after，普通失败可见queue/cursor不变，底层同owned epoch缓存可保留；成功一次短commit完整source+原编辑，按当前对象定位，5000容量包含新增reserved slots，不slice/静默detach。已loaded导航、pause/seek/Stop不等drain，未读边缘等待同gate后按对象定位。满额应明确拒绝不假成功。

Root独占contracts相关4文件与新行为tests、Main/Preload/utility/runtime薄适配、报告/进度/Gate。Core writer独占roon/library.ts、public-library.ts、playback-context.ts及各自tests；Controller writer独占application/bridge-controller.ts与Controller tests；Renderer writer独占roonLibraryPagination.ts/usePlaybackSession.ts及必要Renderer tests，App只有需要时经Root协商。不跨写；均gpt-6.1-sol high，不另spawn、不build共享dist、commit/push。接口变化先沟通后改。

先保留能复现首播前全量读/错代/边缘竞态的行为RED；不削旧断言、新skip或缩小Gate。作者定向GREEN与类型，独立集成复审最多两轮，固定实现后原完整verify、mock Electron4、完整E2E108与control-plane/boundaries/cycles/diff。报告绑定base/impl/reportSHA、原始退出码、源码前后指纹、结构而非真实毫秒证据；开发分支push精确核remoteHEAD，接续006/005/007/008/009。

动作快照补充：公开track引用在原ReferenceMap内持有有界稳定路径/action闭包；UI会话退休与Zone读取换代不撤销动作快照，显式public scope/service失效才撤销。每次动作使用独立actionSession并重验证路径、sourceIndex、hint与策略，实际派发处检查scope和目标Zone，不把owned lease的epoch冒充上游快照。

自然推进补充：Roon Native Transport没有权威ended原因。新增上下文仅在新鲜stopped、同Zone/曲目完整身份、无手动控制意图、2秒内同曲playing观测且最后可信位置距已知时长尾部不超过1秒时保守推断自然结束。缺时长、缺位置或外部中途停止不自动播下一首；保留手动Next及可观测状态。这是推断规则，不能写成设备级自然结束证明；旧非上下文终态逻辑保持本轮兼容范围。
