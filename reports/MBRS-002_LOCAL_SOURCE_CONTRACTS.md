# MBRS-002 本地对象、音源合同与存储增量：有限软件结果报告

有限软件与最终源自然CI GREEN；原11AT为7项 PASS_LIMITED_SOFTWARE、02/04/09/10 PARTIAL。远端归档为PARTIAL，报告交付身份待实际提交。R1/R2首封保持，不新增第三正式审查。合成Electron工程结果不等于普通用户真实App或Owner接受。

准确任务base为001最终报告 `f34dd904a473893f213a2a894b858c4ddfbf4423`。初始实现 `49d9d8a3e9264587b171ec96965a0317b034ce35`，72任务文件；最终实现 `8a1d3f6c65e194bee8beab6dfd6d9db373ae8a84`，唯一parent为49d，仅069/070/078三个E2E当前schema断言各1字节30→31。生产/metadata没有纠正提交delta。普通commit/push均exit0，root实际ls-remote核8a1d。报告提交SHA由本文 `git log -1 --format=%H -- reports/MBRS-002_LOCAL_SOURCE_CONTRACTS.md` 在root提交后解析，不自引用或猜未来SHA；实际报告提交身份按上述Git命令解析；提交后的push、clean、remote及报告自然CI记录在独立交付收据。报告CI与8a1d源CI分别取证。

## 实现与实际验证

沿原唯一Node业务owner增加本地root/asset/track/segment/edition、raw与人工override、schema31表及receipt，复用DatasetOwner scope/epoch/close、完整body fingerprint与Main outbox。SourceStore独占权限/path/dev/ino权威；业务库、维护库与outbox各原writer，不承诺跨库/文件全局COMMIT。默认Node，可选Rust收藏只读OFF，library_write_enabled/源文件写入OFF。

| 范围 | 实际结果 | 限定 |
| --- | --- | --- |
| 本机最终专用Gate03 | 7阶段exit0；contracts16/core41/desktop10，共67PASS；零fail/cancel/skip/todo | 16适用nested叶与显式runtime名单相同 |
| 本机来源/编译身份 | 1040声明输入、56源码/168 fresh输出逐bytes/SHA绑定 | 额外3E2E在1040集合外单独Gitblob绑定；不是完整传递依赖闭包 |
| 本机全量verify | exit0；contracts254/254、core2468总/2466PASS/2既有native条件skip、desktop1422/1422；4144总/4142PASS/2skip | nested67单列；单LF及三E2E修正后按root精确适用性复用，未重跑full/67 |
| 类型/生产构建/Preload | exit0 | verify不证明真实用户App运行 |
| CI本地边界/guard出口 | 21/21、154实际编译公开向量、control-plane/boundaries0 | 不替全部ABI或真实Controller |
| 单次私有日志EIO | compiler0/actual close、Gate1、严格post0 | 故障组0行为；预算kill未测 |
| 本机定向合成Electron | 三条完整流程3PASS，零FAIL/SKIP/FLAKY/RETRY | 不是全108 E2E；官方Electron43.4.0、隔离profile/mock keychain |
| 最终8a1d源自然CI | push attempt1：4workflow/6job全success；严格raw identity后验通过 | 两API首失败与下载超时仍保留，非all-transport0 |
| 最终源Electron | 108总＝104PASS/4既有SKIP/0FAIL；startup12/12 | 合成工程，不是Provider/Roon/Owner |

非空自然30→31迁移验证103旧表SQL、全部列、BigInt/BLOB typed cells、行序/账本EXACT，13实际API两次冷开同对象同ID，111表全事实冷开稳定。合法50k容量/热写9行控制及三集合单次200/LIMIT201 sentinel通过；不是003的100k/300k扫描、SQLite VM/时延/heap承诺。

## 原始失败与修正链

原owner4PASS/2cancelled、TS6059/TS2740与迁移前PRAGMA对象原型差异均为类型/支架准备失败，原件保留，非产品RED。读取预算固定3case实际RED后相同3caseGREEN；refs同6case5PASS/1FAIL隐藏键有效RED后仅新refs叶修复，6GREEN，非真实IPC/持久路径泄露。B4首6桌面FAIL只修两处合成ID为旧非零十进制1001，7case断言保留并GREEN。

首次cached diff-check2来自owner nested EOF多1LF，writer只删1LF；其它1039及168产物不变，Gate03重新实际67PASS。Gate02参数parse拒绝零stage，不是产品RED。R1/R2原封通过root精确格式复核引用，不新增第三轮。

初始49d自然4workflow/6job为5success/1failure，Electron101PASS/3FAIL/4SKIP，三个旧schema30断言实际收到31；旧失败不回写成功。三处各1字节修正后，本机先有身份preflight缺失和binary缺失两次准备失败，均未进入测试。仅隔离worktree安装已锁SHA官方Electron后，身份prepare02实际0、三条完整合成流程实际3PASS，随后新8a1d自然104PASS/4SKIP；三组身份独立，不拼成一次运行。

## 新源归档和传输边界

新8a1d exactHost artifact11301000305实际ZIP完整，82/82、missing/extra/hashMismatch均0；RUST008 compiled38/38、RUST00940/40及4份manifest/receipt闭集字节全核。新Host跨新Gate生成输入链UNKNOWN_NOT_VERIFIED；ZIP无target binary，不是Main原运行收据或完整传递依赖闭包。

新Gate artifact11300485981声明24599135B，原请求600.029s超时：exit-9/signal9/close true，保留13991936B partial（SHA071866c61e6db53c55c17939dc2d874c609435f70bd8c8f5d792ddb826bc667d）。digest没有匹配，67-case manifest及1040/56/168远端ZIP字节后验、Host跨Gate链均UNKNOWN_NOT_VERIFIED。实际CI Gate step/log成功与本机67仍各自有效；不用旧49d GateZIP或本机Gate顶替新ZIP后验。root明确不增加下载/恢复预算。

新宽Electron artifact11300821176声明197707193B，仅actual metadata/digest/upload ID有界绑定，NOT_DOWNLOADED_BOUNDED_CARRY，Main未核。整体artifactVerificationComplete=false。两个API首失败加一次下载超时共3次，原raw/错误保留；最终enriched capture引用闭合终态原件和此前未发的job logs，严格identity通过不抹掉失败，也不消除归档超时。

旧49d专属GateZIP与Host82/82后验成功仅绑定旧SHA。旧宽196308044B请求600秒超时、52953088B partial/Main未核不改。原001 Host只归档1/40与1/38，39/37缺口继续保留，旧Main收据不抵扣；6 moderate与原skip/live/Owner carry全部保留。

原15_VERIFICATION要求一次明确源码/产物身份关联及分层原失败/结果/限制，未规定全部远端归档成功才可继续产品；本报告据实际有限交付，不因此把任何归档未知升级PASS。

## 正式审查与验收剩余范围

R1无需修复的实质P1/P2；R2发现root状态待用语P2，经仅三文档/状态叶同轮修复、显式历史superseded快照及精确SHA定点复核闭合。未闭P1/P2为0，正式轮次保持2。原18任务/156身份不变，非002其它17任务/145AT完整对象保持；11条原id/kind/introduced_in/完整断言保留。01/03/05/06/07/08/11有限软件PASS；02/04/09/10 PARTIAL。

Prepared/legacyManual旧表为空，旧queue只有内存，不能称全部Frozen/队列旧持久事实覆盖。ScanJobRecord/LocalMBQueueEntryRecord仅DTO/closed guard/JSON往返，无保存API或实际003/007生命周期。普通worker三个动作仍TARGET_AUTHORITY_UNAVAILABLE unsupported；private descriptor不是公开prepared、媒体存在、FD/HTTP、Playing或入队。公开命令为localCatalog.prepare。B4合成publisher→validateIpcEvent→原consumer保持legacy/compact-v1只roon/netease、旧safe整数position，local未知null只新叶；006真实Controller接线未完成。

003扫描/分页/冷恢复/取消关闭及100k/300k、005FD/Gateway、006实际播放、007队列持久化及014旧来源保护继续carry。真实用户App/DB/音乐/Provider/Roon/设备/音频/Owner未运行，合成Electron不代签接受。

落盘allowlist日志及完整workspace原日志bytes/SHA可重算；normal67日志只保留脱敏case序号/六计数，原raw内存摘要不是可独立重算的落盘raw或逐name完整TAP。成员由冻结源码/显式argv/nested inventory绑定。

## 报告交付和下一任务

报告提交由本文Git历史解析；push/clean/remote身份及该报告HEAD的自然CI由root独立实际交付收据记录，不能沿用源8a1dCI代替。当前root报告/metadata是有意WIP，不声称当前clean。下一003仍NOT_STARTED，只从002实际最终报告HEAD解析基线，不提前把源8a1d当报告final。机读身份与精确原件引用见[MBRS-002_EVIDENCE.json](MBRS-002_EVIDENCE.json)。
