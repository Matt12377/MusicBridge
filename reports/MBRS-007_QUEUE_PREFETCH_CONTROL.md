# MBRS-007 · 稳定队列、下一项预备与持久恢复

原播放器现在按独立queueId、稳定entryId和精确revision编辑队列；重复曲目仍是独立条目，追加、下一项、移除和重排只在唯一SQLite Owner真实ACK后发布。整发行仅物化ACTIVE关联，按来源提供的数值盘轨与明确edition ID/revision排列，有界5000项、5001明确拒绝，坏曲不默默跳过。基线是006最终独立报告`b464dd2066346121a26824da516969b726f0cfe0`，实现提交`3e171ec487278e9ebae4006fa4c739c609f00f59`，分支`codex/mbrs-007-queue-prefetch-control`。

有限本地Gate真实963/963（45新行为、918受影响回归）、11阶段全部退出0；Core新41、受影响Core733、Contracts66、Desktop123四组均无fail/cancel/skip/todo。Contracts/Core/固定metadata Worker新鲜编译、三包及Desktop E2E类型通过；44份声明新鲜产物与2份真实fresh Reader/CUE绑定保持。1210份声明输入逐项与最终实现提交Git blob和磁盘一致，声明输入和所选产物不冒充全部传递依赖闭集。另32项Gate/报告准入测试、初轮production构建与preload以及control-plane、boundaries、cycles447文件和diff检查通过；三项schema补修完整E2E使用新鲜--mode development构建和隔离Core测试bundle，3/3通过零跳过。它们保留库存、历史、J-Card、完整备份恢复与冷启的全部原尾部断言；最终production构建由精确源CI单列证明。本机没有重跑完整workspace或100k/300k。旧50k合成SQLite行容量回归不能称新的大曲库扫描。

固定两个资源lane只准备紧邻NEXT，保留30s PREPARED、16历史owner、8FD、16票据与256回执限制；准备零begin/play/stop当前，真实IO quiet后才复用lane，提升复核entry/source/target/fence后保留同lease/ticket/attempt。SDK生产仍使用slot=play，不假设next-slot。只有同owner/entry/generation的EndedNaturally一次推进，普通SessionEnded、重复/旧回报、UNKNOWN、外部接管和重连均不触发无授权自动重放。原网易云/native入口与具名preload消费者继续兼容，本地启动和NEXT准备共同核compact-v1，不把恢复legacy入口当授权。

schema32→33沿原SQLite Owner/连接新增STRICT逻辑队列表，备份与恢复同步验证。闭合快照只存逻辑ID、来源/revision、顺序和必要偏好，上限5000/16MiB UTF8、1 save/1 load；006 capture的64KiB合同不变。路径、URL、secret、内部oid和IO句柄不落库。合法最长provider ID与5000项实际保存、旧002最大Unicode意图的保守上界分别记录，不把Unicode当合法网易云ID。冷启只恢复idle，零票据/FD/SDK，显式用户点击才重新解析；明确发行版本按同Owner当前edition ID/revision重新核对，变更/缺失拒绝。版次冷恢复正例用真实SQLite和固定FD，变更/缺失反例是受控Owner读取，不声称新的发行编辑API或SDK独立版次字段。

恢复到不同dataset只保留私有需核对摘要和原字节；显式新意图以新queueId、当前dataset及准确旧revision CAS替换，无自动重绑。仅闭合逻辑row内容损坏返回无revision的UNAVAILABLE，Boot空idle、新save固定失败；DDL/IO/integrity或其它业务损坏保留原fatal，备份包仍严格拒绝损坏内容。保存UNKNOWN不盲重试，只核对准确revision或封口；队列保存不撤销无关SourceFacts。

两轮正式审查：R1发现3个唯一P2（稳定entry在await后失效、恢复legacy共同授权缺口、恢复发行身份丢失）；R2确认原三项闭合，另发现1个cursor ACK与Stop交错P2，原报告为CHANGES_REQUIRED。Root做最小同case修复：匹配queueId/本次revision/同候选数组与成员的真实ACK先安装inactive cursor，再核用户意图；Stop后仍零迟到SDK，新快照不被回滚。有效RED/GREEN与最终963 Gate闭合这4项，无R3。前置fixture/类型/Owner cleanup及沙盒EPERM/ps失败，旧schema当前32/116期待修为33/117的兼容断言遗漏，均保留完整原件且不冒充产品RED；固定旧输入hash、checkpoint/路径/回执/201真实Reader负例未改。

原11AT文字/kind与全部18任务、156AT保留；02/03/07/08/09/10仅软件PASS，11 PARTIAL，live_roon01/04及live_audio05/06仍NOT_TESTED。顺序提交与NEXT预备不是gapless证明。同格式静音/丢样/重复测量、跨格式间隔与设备重锁、声明格式的真实pause/seek/快切、CUE精确片段、普通App和Owner最终接受均未跑，真实账号/Roon/LAN/NAS/音频没有接入本轮。原001/002/004/005/006真实层、003历史25拒收物理根因UNKNOWN、旧录音Gate B/P4/P5、上游许可及Rust未完事项继续保留。

首次源提交`4622189ed36db5c15f7b82c50e77093220c12b22`的自然CI保留：verify因整个job的20分钟上限取消，取消后的artifact扫描遇到正在清理的tmp目录ENOENT；Electron实际101通过、3个当前schema旧32期待失败、4原条件skip。补修仅把verify整job有限上限调至25分钟、收集器排除临时tmp目录、三个旧当前schema期待改为33；原测试、每Gate8分钟step、007总360秒与单stage180秒预算、阈值、固定旧输入及负例不变。未重跑或主动取消旧CI。

本地Electron准备先核Desktop解析的官方43.4.0树，但Playwright默认require实际解析复用006依赖树，其index自动准备了忽略的依赖发行文件；原log的“Downloading Electron binary...”与这项共享依赖副作用完整保留，不声称整个运行链只读。运行后实际树也逐文件通过同一固定官方ZIP核验（275文件、树SHA c5e4bfd4a56e67e4fc0463606654101474ef86e965dc26615f204843f62b1041）。产品源码、用户数据与已封存006报告未改；后续没有再安装或清理共享依赖。这是本轮合成功能与依赖身份证据，不替代普通App。

最终精确源提交四条自然CI、六个job均attempt1成功：[security.yml](https://github.com/Matt12377/MusicBridge/actions/runs/37456044218)、[rust-core.yml](https://github.com/Matt12377/MusicBridge/actions/runs/37456044234)、[verify.yml](https://github.com/Matt12377/MusicBridge/actions/runs/37456044285)、[electron-e2e.yml](https://github.com/Matt12377/MusicBridge/actions/runs/37456044179)。verify实际完整workspace 4375总／4373通过／2原条件skip／0失败，本任务MBRS007 Gate、最终production构建、生产依赖审计及双平台Rust通过；Electron完整Playwright实际104通过／4原skip／0失败。最终log收集步骤成功，旧ENOENT原件保留。计数来自完整job日志，源artifact仅核producer/digest元数据，未下载归档内容；合成Electron不抵扣普通App或真实服务验收，旧CI没有rerun。

本报告是实现直接子提交，只在精确父源CI及实际语义报告范围核验后复用产品结果；控制面、边界、循环、报告准入及依赖审计仍运行。报告push/自然CI在提交时待执行，终态由外置[交付收据](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-mbrs007-4w1zusen/FINAL_DELIVERY_RECEIPT.json)封存。008从本任务最终独立报告HEAD接续，后续008～011→014→012/013→015可选→016/017；每独立任务更新待办并普通push，main合并、安装、发布未执行。

iOS后续身份在[只读衔接记录](../docs/postrust/MBRS-007/evidence/ios-successor-identity.json)登记：红心歌单实现6179f16、独立报告8de0f3、归档补充及观测远端3c357b12；三个合同在三提交共9次字节比较一致，基础0.1.0与UI候选1.1.0分开，Mac采纳仍PENDING_MBM000。本对话未重跑iOS构建/测试、未联调。MBM-000～004在原017之后；FLAC后续须有非静音、可区分双声道及有效低位的同轮无损证据，旧四份静音样本不能证明保真，HLS可选。没有新增原主线Gate或改写006已封存报告。

[本地检查](../docs/postrust/MBRS-007/evidence/local-software-checks.json)、[源码绑定](../docs/postrust/MBRS-007/evidence/source-input-blob-binding.json)、[审查处置](../docs/postrust/MBRS-007/evidence/review-disposition.json)、[API行为映射](../docs/postrust/MBRS-007/API_BEHAVIOR_MAPPING.md)与机器证据报告给出分层结论。
