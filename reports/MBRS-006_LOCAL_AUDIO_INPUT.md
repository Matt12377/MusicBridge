# MBRS-006 · 原播放器本地Audio Input与会话保护

本地点播通过固定九字段公开入口进入原BridgeController/RoonAdapter、原队列和唯一SQLite Owner。局部来源保持local_file身份，不再被Renderer当成网易云收藏、云歌词或数字ID最近重播；实际legacy入口明确unsupported，compact-v1才受理。基线是005最终报告`cce8594f4b6e9872afd576bb1b032f526c93af72`，最终源提交`9c8d48a25505de372b23f80605dfcd27fd07ebbf`（初始实现`b50261ee942bb0d88f6cb2fae0377547846e0234`）；独立分支`codex/mbrs-006-local-audio-input`。

46项新行为与563项受影响回归共609项最终Gate通过，11阶段覆盖Contracts/Core/固定metadata worker新鲜编译、三包和Desktop E2E类型及四组完整TAP。28份新鲜产物在Gate内保持；1186份声明输入随后逐项与实现提交Git blob及磁盘匹配。另32项Gate/报告准入脚本、桌面production/preload、control-plane、boundaries与cycles均退出0。本机按风险进行定向验证，没有重跑100k/300k或全workspace；远端完整workspace另由实际CI记录。声明输入与所选产物不冒充全部传递依赖闭集。

Owner私有capture/revalidate/release按扫描accepted、track/asset/root/location/file/selection/sourceRoot当前事实发16字节SAB票据。三处原SQLite提交口在COMMIT前同步不可逆撤销相关票据；无关asset/元数据/库存提交不误断当前播放。SDK发送持短同步CAS claim，无await；相关提交须等claim quiet，Busy只有已确认ROLLBACK后事务外两轮有限重核，COMMIT或ROLLBACK未知会封Owner，不重放SDK/队列。005固定FD、物理读guard与取消IO join保持，不新增第二作者或第二播放器。

真正SessionBegan才能确认租约，Playing/Paused来自受控SDK观察；HTTP完成不推进队列、不撤ACTIVE租约。已发送且丢回报保持UNKNOWN与本attempt，晚回报只调和该attempt，重复request_id不重复begin/play或入队，旧A不能覆盖或清B。当前session终态不会自动抢回外部会话；选中Zone/group变化、接管和断连只收自有资源，不发全局stop。默认Node退出先封派发，所有正常/fatal调用共用先登记的shutdown完成/拒绝flight，join真实读取/响应/FD后才可退出。

正式R1发现1项P1和3项P2：并发shutdown短路、旧native分页上下文、本地确定终态残留、Zone/group指纹恢复复活旧目标。实际utility fatal出口/生产runtime/阻塞005 FD、原native分页三动作、MediaError/StoppedUser/主动stop/stat准备失败及两种目标ABA均有有效行为RED，修后同case GREEN；最后两路R2无剩余P1/P2。原fixture准备失败、TSC/循环及计数预跑失败均保留，不当有效RED。R1的RED阶段未独立冻结完整源码，原日志和先前产品冻结身份分列；最终58文件（其中54审查覆盖字节保持）及本次Gate输入有新鲜逐项绑定。FREEZE03继承的unchangedPriorHashes=52为旧补充描述，实际增量48不变/5改变/1新增，审查采用逐文件比较。没有第三轮。

原11AT文字/kind不变：02/03/05/06/09/10/11限定软件PASS，08保留普通App/真实退出与提示未操作的PARTIAL，01/04/07维持live_roon NOT_TESTED。20真值样本仍全部未执行，受控MetadataReader/SDK不是真实音频解析或Roon播放。实际Roon/Core build/Zone、LAN/NAS、听感、Signal Path、数字输出、gapless、普通App及最终Owner验收均未跑。CUE非null segment明确拒绝，不当整文件；本地歌词目前unavailable，不隐式换云或native。

本次Owner票据上限16，本地回执上限256，容量满拒绝新请求；007需评估长期回执/队列恢复策略。SDK递交后的HTTP观测保持UNKNOWN，四轴质量NOT_TESTED。005不可观察第三方原地字节修改的能力界限、001/002真实验收、004真实播放、003历史25拒绝（20读取TIMEOUT、5WORKER_START_TIMEOUT，物理原因UNKNOWN）、iOS合同采用与上游许可UNKNOWN继续独立保留。

[API与状态映射](../docs/postrust/MBRS-006/API_BEHAVIOR_MAPPING.md)、[本地验证](../docs/postrust/MBRS-006/evidence/local-software-checks.json)、[审查处置](../docs/postrust/MBRS-006/evidence/review-disposition.json)和机器证据报告记录分层结论。

初始源b50261e的安全与workspace实际仅旧preload严格方法清单期待失败；完整4330总/4327通过/1失败/2原条件skip及29安全case28通过/1失败原日志保留。仅在原断言列入已审固定入口playLocalLibraryTrack，不改产品或其它私有/未知方法负例；7个原安全文件29通过后并入有限Gate。后继源的实际CI另记录，旧CI没有手动rerun。

第二源5dd13d2完整workspace4330总/4328通过/2原条件skip成功，随后旧001离线Gate失败。旧001 RED绑定已提交的5dd13d2，原Gate声明输入保持；同源本机复现nested32总/31通过/1失败：旧SessionEnded通知缺口期待已经被006实际修复。只调整旧case与合成POC同根因期待，原32case和118回归保持，完整001 Gate实际通过，两个FD/请求refs及SDK callback/observer/订阅/计时器归零且关闭stat探针true。该32项及八个直接输入纳入当时601 Gate；prior55字节保持。旧001历史报告不重写、真实AT不升级；失败CI的108652961字节artifact只核producer/digest元数据，未下载内容。

第三源a940c34远端Core2648总/2645通过/1失败/2原条件skip，失败在旧排队Stop的progressMs≤100ms断言；实际progress值未打印，整条case2803ms不能代替该值。Contracts256通过，Desktop未到达。产品src与第二源完整workspace通过时相同，单文件原8项本机通过，跨文件争用仍属推断。Root增加两阶段测试入口：全部其它Core文件按原默认并行运行，自然成功后单独执行原8项；清单恰好一次、阈值、case、原容量窗口及产品源码保持。389项定向回归与5个阶段传播/不漏用例检查通过，旧CI不重跑。

第三源的Electron UI流另有103通过/1失败/4原skip：旧TASK-085文案定位同时命中成功status及静态hint，严格匹配失败。仅将原一行断言限定成功role=status和完整回执前缀，不使用first/nth、不改其余case/阈值/产品；prior57保持、冻结58。本机原单case因官方Electron身份/可执行前置缺失未进入测试，exit1单列准备失败，不称本机GREEN。新自然CI实际Electron结果见终态证据。

最终源提交的四条自然CI／六个job均实际完成success：[security.yml](https://github.com/Matt12377/MusicBridge/actions/runs/37432815229)、[rust-core.yml](https://github.com/Matt12377/MusicBridge/actions/runs/37432815276)、[verify.yml](https://github.com/Matt12377/MusicBridge/actions/runs/37432814992)、[electron-e2e.yml](https://github.com/Matt12377/MusicBridge/actions/runs/37432815088)。verify完整workspace实际4330总／4328通过／2原条件跳过／0失败，当前MBRS006 Gate、生产依赖审计、双平台Rust、Electron启动/恢复均成功；完整Playwright实际104通过／4原skip／0失败。计数来自实际job日志；初始失败提交的四条CI终态原样保留，旧CI未rerun。本机仍采用609项定向Gate，不以远端合成Electron冒充普通App、真实Roon或Owner验收。

本报告为实现的直接子提交；报告身份按Git历史解析，报告push及自然CI提交时待执行，最终封存于外置[交付收据](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-mbrs006-tdh6dag6/FINAL_DELIVERY_RECEIPT.json)。只有精确父源四条工作流、六个job及本任务Gate实际成功且报告语义范围不变，报告才复用产品结果；控制面、边界、循环、准入和生产依赖审计仍运行。源artifact只核producer/digest元数据，未下载内容，不称归档字节验收。007必须从006最终独立报告HEAD接续；当前尚未开始。Owner连续到017、每独立任务更新待办并push；main合并、安装和发布未执行。

后续移动五阶段见[衔接计划](MBRS-006_SUCCESSOR_PLAN.md)。iOS客户端交接源码`e7d4218b32f615f1e5d910a0d0a8e697ee04ad9e`、最终报告及观测远端HEAD`2e7d5ec4aacc1c1ae266d6262cc405fb8b4c7f17`已只读核对；基础合同、UI提案、控件盘点的三个SHA256已在衔接计划登记，源码与报告字节一致。本对话没有重跑iOS测试/构建；Mac采纳仍为PENDING_MBM000，没有实现移动门面或完成联调。原MBRS主线完成后再按独立MBM-000～004接续；FLAC可播/受控无损转换为后续必做，HLS可选。旧家庭原样直送、原任务/WIP和验收责任保持。
