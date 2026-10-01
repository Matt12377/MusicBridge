# MBP-007：封面虚拟窗口、图片租期与资源预算

已从005最终报告4ac88f5a9a3a3ae8ae36d1da14c02a284dd098c3创建分支codex/mbp-007-virtual-artwork，本合同冻结并开始实施。Owner已连续授权，保留Electron/Vue/Node TS、当前视觉与业务数据，最多三名gpt-6.1-sol high作者；必要独立审计最多两轮。

## 范围与所有权

Root拥有App薄接线、任务/进度/报告、实际Chromium几何与50/500/5000观测、固定原全量Gate。只改本任务必要文件，保留无关未跟踪目录。
网格作者拥有RoonAlbumGrid/RoonEntityGrid/FavoriteEntityGrid、SearchEntities展开专辑/艺人分区、新NeteasePlaylistGrid、favoriteResolution最小真实游标/epoch消费、新的网格窗口composable/复用小组件与相关测试；不改App、artwork、原TrackTable/Queue/Session、virtualWindow线性合同与既有CSS视觉。统一真实content-scroll祖先位置、响应列数、不同网格offset、scroll/resize/overscan/焦点/页末sentinel；总滚动高度与长标题/年份/收藏状态实际高度一致。保留所有选择/移除/retry/loadMore，禁止v-show5000或把整个list仍挂DOM。收藏只对窗口内及overscan解析，有限结果池和cancel/current scope；离页、record改变/同favoriteId新事实、Core/Zone变化不能复用旧reference或迟到写回。原解析串行语义继续保护Roon资料库通道。
图片作者拥有renderer/src/roon-artwork-cache.ts、RoonArtwork.vue、SafeArtwork.vue、ambientArtwork.ts与其相关新旧测试。修generation/catch/finally/old DOM error竞态、stale URL双revoke、leased uncached漏clear；一订阅者取消不结束其他，最后取消/clear防warm及失败negative写新代。正常900ms淡出保留lease至releaseFrame；cache驱逐不提前revoke活跃lease；真正scope invalidation废弃旧代。default API向后兼容，只增加私有依赖与optional acquire signal，不改公开DTO。
Core作者拥有roon/public-library.ts、新的private image共享读取helper及相关新旧测试；必要时roon/library.ts仅保留/验证现有实际SDK image32预算，不触页缓存、owned播放、runtime/Contracts。跨公开aliases同imageKey共享必须独立owned ALS，不能绑定第一个subscriber。取消一个不取消另一个，最后取消/timeout防warm，旧scope failure不negative新代；原Service actual image32直到真正SDK callback settlement归还，不能把本地Promise超时当真正资源归还。禁止Roon→Netease跨模块依赖。

## 预算合同

Renderer压缩blob实际保留32MiB/128entries（包括leased uncached），decoded RGBA估计96MiB（估计不是RSS），pending logical32/subscriber256/negative128/TTL3s且负年龄不fresh；非法/超单图片4MiB/不满足预算明确error不截断，已有合法活跃leases不被cache驱逐。生产decode必须有有界本地等待且实际未结算decode工作计数到settlement；getImage promise等待预算与Core真实SDK32分别记录，不能把Renderer本地超时声明为SDK已关闭。prepare预算在分配新blob前保守预留，失败/迟到释放恰好一次。忙时可有限排队或明确可重试忙，不能无限队列/缓存。可配置小预算仅供行为夹具，默认数字须合成校准，现有player eager封面与淡出在同预算内。
Core保留原图片128/32MiB/单4MiB、实际SDK32；新共享逻辑flight32/subscriber256/固定10s，currentness包括service与referenceScope，不能延长旧authorityTTL。合法结果clone、不暴露raw SDK key或私密身份。

## 验证

每作者先实际可复現缺陷RED再补修、原保护说明、direct tsx和隔离production+new/changedtests strict noEmit、文件Hash manifest、实际退出码，所有产物外置。不能跑共享pretypecheck/build/test脚本。Root原verify/mockElectron/fullE2E/control/boundaries/cycles/diff保持范围，不新增skip。50/500/5000对比DOM window、image/resolve调用与保留压缩bytes/decoded估计；真实Chromium核window totalheight、首中末、窄宽/resize、不同offset、长文字/状态、键盘焦点、加载更多与返回scroll。结果是合成软件证据，不是真实媒体/听感或Owner视觉验收。仅已验证任务计9/11，真实账号/Roon/设备/GateB/main/App替换/发布保持NOT_RUN。

## 只读预检补充合同

搜索all模式现有2艺人/6专辑preview本已有限，保留；expanded分区与网易歌单墙纳入统一window，Root替换App歌单v-for为作者新组件。五分区加载/失败/重试/来源按钮不动，保留选择与原current clicked descriptor接线。图片只允许现有PNG/JPEG，不新增WebP；decoded估计使用编码自然尺寸而非请求尺寸，Blob前预算及decode后核对。cache私有subscribeInvalidation通知强scope clear、同props旧图即回fallback不重放旧reference。Root拥有AlbumAmbientBackground：传load signal与cache clear订阅，按frame token精确after-leave release，正常900ms淡出仍保留。Favorite结果以完整record+scopeKey+kind绑定，Root新增opaque响应epoch作为薄接线，真实Core/Zone/credentials invalidation原恢复链继续。

收藏局部纯值结果池冻结128entries/2MiB/TTL15s，负年龄不fresh；逻辑串行pump只保当前窗口待解析集合。Root独占App.vue/AlbumAmbientBackground.vue接线，作者不写这些。私有playing priority仅在Renderer实际getImage/decode的32工作预算内保留2槽；Core的原SDK32保持通用槽位，不增加DTO/IPC/ALS priority字段，也不声称Core端到端优先级；有限2次自动忙重试150/450ms、10s总意图后明确手动retry，忙不negative；现256/384/768档位保留。RGB自然尺寸估计非RSS，不新增WebP/图片下载代理。Root已固定4ac88f5的166个Renderer基线文件和哈希用于Chrome对照，三作者已收到正式启动消息。
