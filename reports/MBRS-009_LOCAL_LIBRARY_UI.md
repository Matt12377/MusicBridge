# MBRS-009 本地音乐库界面结果

正式本地入口沿用原侧栏、共享TrackTable、队列与播放栏，完成目录加入、分页搜索、版本选择、MB展示更正和原文件找回。目标只取原播放器的可信Roon Zone；无目标时准确失败，受理、实际播放、未知及原生外部播放分别投影。默认Node与唯一数据库作者保持，原音频写入关闭。

本次为有限软件与受控普通App交付，真实Roon/音频/当前十万首/旧真实收藏及根迁移/Owner仍待。Base `418389708ca9400dbe347da448a829b9481dbb84`，实现 `9b930bc555b130b739abe9f8ff7bfb13c81b5730`，分支 `codex/mbrs-009-local-library-ui`；原产品实现 `bb121676a63c489656c4155b4e81e6615a50c7fe` 后只补CI准备修复，本独立报告直接接最终修复源码提交，自身SHA按报告Git历史解析。报告自身自然CI与最终远端身份在实际完成后另行封存，私有归档标识为 `MBRS009_FINAL_DELIVERY_RECEIPT`，文件名 `FINAL_DELIVERY_RECEIPT.json`；该标识不是本机路径或公开下载链接，当前最终收据尚未生成。详细分层证据见[机器报告](MBRS-009_EVIDENCE.json)。

## 实现与复用

本报告所述Root是MusicBridge V3.9主控对话内的根代理，负责产品实施、正式整合和普通App操作。统一调度对话负责只读核对和基线派发；011、014由各自既有对话接续自有模块。

候选02有28产品文件和10允许测试文件。查询经固定dataset闭集与原Main/preload路径、有界100条页和至多6页缓存，原导航保存搜索、选择和滚动。raw/override/effective及文件解析/Roon实际输入处理输出分开；参数修订失配降为未知。异步查询、详情、当前播放和原outbox终态均有身份/代际护栏；离页匹配的原终态只缓存，重入核原dataset后消费，不自动派发或重试不确定写。原009八验收、其他17任务/148验收及18/156总数保持，原任务文件字节未改。

R1七项P2已修，R2无新P0/P1/P2，两轮已消耗，不开第三轮。详情Escape焦点返回有SFC和Root普通CUA实证；继承的更多菜单完整键盘模型保留P3。R2当时STATE_MATRIX原字节另封存，后续Root仅更新当前证据状态，产品38文件未变。原25回归路径、220实际case和360000/180000ms预算不变；Gate声明输入由1234到1236，另纳入旧键盘spec和修复范围记录。

## 实际验证

Root精确实现HEAD的11阶段Gate退出0，实际Core87/contracts54/Desktop79，合计220，0失败/取消/skip/todo；1236输入逐项与提交Git blob及当前文件匹配，38 fresh输出、2份当前Vue SSR HTML与3份私有绑定另核。53/167为专项新文件/既有路径套件分组，167中含在旧page-journey文件增加的一条009导航守卫；相对base新增行为case实际54，原base case166。源阶段旧“53新增/167原回归”措辞据此澄清，实际TAP数量、测试范围及Gate未改，不重新运行旧验证。Writer本轮79 fresh Desktop，另141为未改源码的此前运行；Root完整220是独立新鲜运行。

当前production02构建和依赖检查退出0，声明554输入及20输出；一条原生产UI/Core/Node Scanner工程E2E通过，无skip，仅native picker结果用自有fixture。五宽度720/780/800/801/1024核84行高、142动作栏和44按钮无重叠，原队列键盘/焦点、页面返回及MB_ONLY更正有实际操作，3份合成音频SHA保持。六张工程PNG不冒充Root原生CUA截图；不声称完整传递依赖或安装包。

MusicBridge V3.9主控对话内的根代理另用原生CUA经原选择器扫描自有245文件，实际收录243/拒绝2；完成两个版本搜索、无Zone明确失败、MB_ONLY展示更正、详情/原队列键盘与焦点、原生文件重定位、跨100条分页及主页返回保持滚动。Root只对自己fixture手工改名一次以准备找回，未声称产品Organizer能力。只读SQLite核同asset/track/override，fileRevision1保持、locationRevision1到2，总243；重新定位后原解析参数明确未知。244可读文件fresh完整SHA保持、1权限故障只核原mode/stat；原App正常退出0。短扫描暂停点击未赶上，暂停/取消保持未验。普通CUA使用合成服务，真实账号/Roon/NAS/LAN/发声/Owner均未验。

## GitHub 源码 CI

原99文件和本次8文件修复公开普通push分别核到直接Owner授权，实际退出0、远端精确HEAD一致；三次历史自动审批拒绝均在推送进程创建前发生，原证据保留。原bb首轮verify因25分钟外层时限被取消，Electron为104通过/4跳过/1旧键盘夹具CSS构建失败，未进入该case的键盘断言。定向同条件RED退出1、明确CSS文件名并加载真实组件CSS后GREEN1通过/0跳过；外层verify改30分钟，内层Gate预算不变。以下均为9b自己的新自然CI，原job未重跑或取消。源码四条自然workflow、六个job均success且attempt1：[verify](https://github.com/Matt12377/MusicBridge/actions/runs/37564545956)、[security](https://github.com/Matt12377/MusicBridge/actions/runs/37564545955)、[双平台Rust](https://github.com/Matt12377/MusicBridge/actions/runs/37564545943)、[Electron](https://github.com/Matt12377/MusicBridge/actions/runs/37564545980)。完整workspace实际4453总/4451通过/2原条件skip/0失败；完整Electron Playwright实际105通过/4原条件skip/0失败，009新spec在实际日志中出现。原始job日志私有外置归档；源码artifact仅核producer/digest元数据，不下载宽泛产物，不代替普通App或真实设备。

报告阶段按原严格精确parent成功CI与机器语义白名单复用。源码阶段validation、原AT各层级及索引逐字保留；本报告自身模式与结果须从新自然CI的实际job日志读取，不由本地classifier替代。未重跑或取消旧job。

## 待验与后继

原009总体为4项有限PASS、3项PARTIAL、1项NOT_TESTED：009-03仍kind=load、当前十万首未运行；软件有界规则与受控243分页不抵扣它。普通App所有离线/暂停/取消/不支持格式/外部接管状态、旧真实收藏/根迁移、真实Roon播放/音质/无缝与Owner继续单列。Gate01因Root SSR合成WAV枚举错误失败，只修fixture为WAVE；原失败、同SHA诊断、Writer71次原运行、准备失败及旧App01时点记录保留。

下一010从本009最终独立报告HEAD、报告CI和远端/clean封存后继续。正式实现恢复串行：010由MusicBridge V3.9主控对话完成，011既有对话等010最终报告HEAD，014既有对话等011最终报告HEAD，由调度逐次核派基线；共享合同/Owner/迁移/入口由MusicBridge V3.9主控对话整合，不重做独立模块。预检两线工作树和提议保留；提议未冻结、不构成源写权限。014先于012/013，015可选；安装/签名/公证/合main/发布没有执行。原017后MBM-000～004与iOS候选衔接保持，有效可读FLAC必须实际可播放，本轮不提前扩大手机或LAN授权。

本公开版本是私有证据的脱敏投影：仅将Gate04 manifest、两份完整CI日志和最终交付收据的本机定位替换为归档标识/文件名及GitHub run/job引用。JSON内 `publicProjection.privateOriginal` 的bytes/SHA标识保留的私有原始收据，不是公开投影的内容Hash；manifest及完整日志自身的bytes/SHA、源HEAD、1236输入绑定、38输出、CI计数和原权限/验收边界均未改变。原私有结果Markdown的6980字节/SHA256 `d246c2ebb1ef93ca608516004933ae5b45c2b55f35286801739dd1a8fcff3022` 单独保留，未纳入拟公开提交历史。
