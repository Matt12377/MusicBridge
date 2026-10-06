# MBRS-008 原样音质、格式与边界证据

本地播放现在保留当前 accepted 解析报告的文件参数，并在原播放器区分文件参数、来源返回与 Roon 实际输入/处理/输出未知。新增有界 Q1 原样字节审计和 Q2/Q3/Q4 私有证据消费者：不能用文件 24/96、Hash、Playing、顺序切歌或可复制自报结果代签设备音质；任何已证边界失败都保留，不被其他测次未知覆盖。

交付只关闭有限软件范围，真实 Roon/格式 AudioInput/数字设备/gapless/relock/普通App/Owner仍未测，不能声明CORE_READY、端到端位精确或DSD直通。

- 基线：8140124adbf71f09d4cc27dd0a295b42ff3827c8（007最终独立报告）。
- 首次实现：4796598a9ee19b1aeba1d2f474ef76e3948fa939；最终补修实现：186694e105f8ace61d33b48cfc25710dff419632，独立分支 codex/mbrs-008-audio-transparency。
- 报告：以本文件首次正常提交的Git历史解析，是实现直接子提交；最终远端与CI收据另行核验。
- 下一任务：MBRS-009；从本任务最终报告HEAD接续。后续009/010/011→014→012/013→015可选→016/017，原017之后MBM-000～004。

370项定向软件全通过（36新、334回归），Core263、Contracts58、Desktop49；11阶段最终Gate退出0，1226声明输入、38新编译产物、2实际Vue SSR、3私有Reader/CUE/UI绑定全部匹配。最终补修Gate耗时59.04s，360s/180s限额未改；22项入口/Gate规则测试与生产build退出0。声明输入已逐项绑定到实现Git blob及当前磁盘；这不认证完整传递依赖闭包。严格Core/Vue/E2E类型退出0，原23回归路径未改。最终精确Source自然CI实际4workflow/6job attempt1全部success；Report自然CI在报告提交时待执行，终态收据分开核验，未重跑或取消CI。

有效RED：原实际Reader/Scanner/SQLite捕获参数缺口1case失败；R1七个行为case全失败后在实际Core组内八个R1 case全通过。初次R1目录因sandbox准备失败、首次Core263中A/B fixture按捕获次数误删A参数、初次SSR额外WS监听失败诊断及早期编译失败均独立保存；不改成正常通过记录。A/B fixture修为B稳定assetId条件，全部A/B/晚A/native断言保留。Q1品牌与冻结原先有效，不误报成可篡改缺陷。

R1去重4个P2由唯一产品writer集中修：平台私有证据路径准入；混合边界测次失败优先且全部issues保留；Q2～Q4轴专属工厂身份/闭合结果/深冻结与clone拒绝；14×12默认状态。Q2 native/direct分别同scope及comparison自身scope与消费scope再次绑定。最后R2两路无剩余P1/P2，不触发第三轮。主控实际sol/max，既有三代理实际sol/high；AGENTS第13行有当轮high文档覆盖，Owner原聊天本轮未重新核出，不以文档冒充实际max。

Q1主case：自有非静音WAVE8236字节、16bit/44100/双声道；真实新鲜Reader、Scanner、SQLite accepted观察、production tickets、固定FD/Registry/Gateway、14个真实完整/HEAD/Range/If-Range/错误请求与独立oracle逐字节一致。DatasetOwnerEndpoint与SDK回调为受控接点，不是实际Roon或出声。源替换/截断、短read、取消quiet及低位差异负例通过；Q1审计每源8MiB，不收窄原播放资源上限。NAS不可观察原地变更仍未知。

Q2语义比较原件并绑定build/Core/Zone/output/source/revision/settings；未知响度/增益/ReplayGain/DSP/DSD不猜关闭，无虚构SDK输出接口。Q3离线16/24/32位、2声道、65536帧有效激励及明确整数偏移逐样本比较；Q4唯一锚点、native基线、3～16测次、零帧阈值，已证失败优先与逐trial问题/最坏值可见。三层真实设备仍NOT_TESTED。注入边界失败是软件方法负例，不是实际产品音频失败。

原18任务156AT文本/kind/version不变，其他17任务148AT不改。008原8AT：01/05限定软件PASS；07/08 PARTIAL（实际音量/DSP未操作，普通App/Owner未跑）；02/03/04/06原live kind与NOT_TESTED保留。14格式×12轴显式；仅FMT03真实解析/原样HTTP软件验证，不认证其他实际AudioInput格式；FMT14精确片段unsupported，整文件不能抵扣。

私有源oracle/PCM/测量原件仅在外置任务私有根，macOS/Hosted沿原buildStoragePolicy并核realpath/owner0700/非symlink/批准专用树。CI配置明确排除run/tmp；不下载公共artifact内容作泛验收。本任务新增测量素材没有进入Git或报告。实际音量/DSP未变，授权/安全/恢复只读记录检查通过。

待办和机器状态随本独立报告同步。任务索引旧首行006已随必要的标准Core入口补修同步至008，历史正文逐字保持；独立报告只含正常报告/证据/待办/机器状态路径，严格核精确父源四条CI、语义范围与原AT层级后判定是否复用。准入白名单、任务预算和真实验收均不降低，Source证据与报告自然CI继续分层记录。

保留003历史25超时UNKNOWN、256回执容量与HTTP观测UNKNOWN、来源许可UNKNOWN、Rust未完事项、旧录音Gate B/P4/P5和旧真实设备carryover。未新增100k/300k扫描，未合并main、安装、签名/公证或发布；主工作区原WIP保持。移动11候选operation/位深/完整专辑与独立收藏规则仅登记；本任务观察到的iOS已提交后继已独立核对Git/远端身份，Mac正式后端/持久化/同步/真实回执/FLAC播放仍待原017之后MBM采纳。

首次源码CI保留：[verify](https://github.com/Matt12377/MusicBridge/actions/runs/37471103770)只出现1个未通过项，新增真实WAVE用例在读取新鲜Reader声明前停止；标准Core入口未准备该声明，不是已到达文件参数业务断言后的失败。补修只在原Core runner添加新鲜编译准备屏障、给全部原阶段传递私有v2声明与当前性校验，加入准备失败零测试等行为检查。真实Reader断言、全部原测试、独立排队Stop、固定Worker、Node22、平台私有存储及Gate预算保持；首次Electron继续自然结束，未取消或rerun。

首次[Electron](https://github.com/Matt12377/MusicBridge/actions/runs/37471103983)实际102通过/2失败/4原条件skip；两处旧E2E可访问名称期待“当前实际音质”，与正确的新“来源返回音质”分层不一致。只更新定位并验证Roon实际输入/处理/输出仍未知，原Standard/Lossless、偏好不冒充当前值、码率展开与所有交互保留。编写阶段还在执行前纠正了把定向180/360秒复制给整个Core回归的限制；真实旧Core约397秒。准备预算仍360/180秒，完整Core阶段及准备结束后的身份复核沿原整体job边界，不新增阶段超时或删减测试。首次两路失败原件及中间未运行候选均保留。

第一补修源8d981431的[verify](https://github.com/Matt12377/MusicBridge/actions/runs/37475813479)实际完整Core主阶段2709通过/2原skip、独立Stop8通过，fresh Reader遗漏已经修复；唯一失败在旧Renderer歌词静态guard，它把整个NowPlaying源码的音质区内部evidence字段误判为歌词工程信息泄漏。Root定向真实RED为35总/34通过/1失败，随后只改既有test：SFC AST精确提取歌词区与匹配抽屉，解析失败/目标缺失必须拒绝；原禁词、可访问性、焦点、空态、来源和交互断言保持。新增负控确认歌词score/抽屉evidence绑定仍被拒绝，合法音质区内部字段不会误判；最终Renderer36/36和原370冻结Gate通过。产品21路径在首次入口补修中均与CAND03保持；最终同批补修中20路径保持，NowPlaying仅给音质详情加专属class与scoped紧凑段落排布，全部字段和业务条件保持。未通过换变量名或删guard避开检查，旧8d CI不rerun。

第一补修源8d981431的[Electron](https://github.com/Matt12377/MusicBridge/actions/runs/37475813525)实际103通过/1失败/4原条件skip；原音质定位与Roon未知断言已经通过，唯一现有几何断言发现展开音质详情后控制区底部629.125px超出608px视口允许609px。四段证据沿用默认段落margin增加固有高度；Root只添加音质详情scoped grid与段落margin0，字段/可访问标签/显示条件及原几何阈值全部不改。本轮固定官方Electron、production真实渲染及原单流程定向复验通过后才交源CI；属于合成软件UI，不是普通App/Owner。

第二补修源dbcfa7bb的[verify](https://github.com/Matt12377/MusicBridge/actions/runs/37480719922)完整workspace4412总/4410通过/2原skip，Electron104通过/4原skip及Rust/安全通过，但007 Gate的原733项串行回归组在180秒预算触发SIGKILL，最终TAP缺失；不把未闭合项计作通过，008 CI步骤实际跳过。7个编译/类型阶段及41项队列组已通过，源/产物/绑定未漂移。Root仅读取该失败产物的ZIP目录元数据与10项日志/manifest文字，保留逐段范围、长度、CRC和SHA；未保存整个归档或提取音频/媒体，其他产物继续仅核producer元数据。

本次执行补修仅把007 core-affected-regression的独立Node文件进程上限设为2，53文件、41+733+66+123=963项、11阶段、180/360秒、超时进程组清理、4MiB输出捕获与完整TAP计数均保持；其他组仍1，标准Core入口Stop单独阶段未改。静态夹具核验单独记录，不冒充并行安全证明；真实双进程屏障验证了第三进程等待、环境/cwd/全局状态隔离与三个文件完整闭合，原串行有效RED 7通过/1失败，修复后相关规则30/30。首次探针继承NODE_TEST_CONTEXT造成的准备失败也保留，不算有效RED。原963实际全部通过、无skip，733组83.781秒/整套132.953秒；该007 Gate在提交前执行，manifest HEAD仍为dbc父源，1222声明输入已逐项匹配最终源Git blob及当前磁盘；007产物仅声明运行内保持，不冒充008重编译后的当前产物；全部21产品路径与dbc父源一致，008仅补齐两项受改CI源码的声明身份，原370功能范围不变。Root自查并用新自然CI验证，没有第三轮正式评审。

最终精确源码自然CI：[security.yml](https://github.com/Matt12377/MusicBridge/actions/runs/37492861402)、[rust-core.yml](https://github.com/Matt12377/MusicBridge/actions/runs/37492861758)、[verify.yml](https://github.com/Matt12377/MusicBridge/actions/runs/37492861368)、[electron-e2e.yml](https://github.com/Matt12377/MusicBridge/actions/runs/37492861659)；完整workspace实际4412总/4410通过/2原条件skip/0失败，Electron完整Playwright实际104通过/4原条件skip/0失败。任务008 Gate、完整production构建、依赖审计与安全/双平台Rust各自通过。最终成功源artifact仅核producer/digest元数据；上述失败产物的定点文字读取不用于泛化产品验收。合成Electron不抵扣普通App或真实服务验收。

本报告直接接最终补修实现，仅核原白名单正常报告语义和精确父源CI后才允许复用；报告自身自然CI与push在提交时待执行，最终身份见[外置交付收据](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-mbrs008-952vpgg9/FINAL_DELIVERY_RECEIPT.json)。下一009从本任务最终独立报告HEAD接续。

最新iOS只读后继已核：源558f3456794e9e208195528a6a0fd7d154275662、独立报告及远端2991df3eb1989519260dc0411179afaa1de2d57c；UI1.2.0候选50478字节SHA256 cb970a8017908058b9fefb18324261723b5dfd42622697540af50fe6291b43a4，在两提交字节一致。11 operation、完整专辑与独立收藏规则只登记，Mac正式后端/持久化/同步/真实回执与FLAC无损未接入；MBM-000～004仍在原017之后。Root没有重跑iOS build/XCTest或真实联调。原源阶段移动快照保持为历史。
