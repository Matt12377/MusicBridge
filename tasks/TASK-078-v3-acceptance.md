# TASK-078：V3全链路自动验收与容量/退出收口

基线 `c54cf8b71b493482d8ad061d38123c444d718ad0`，分支 `codex/task-078-v3-acceptance`，独立树 `worktree/task-078-v3-acceptance`。Owner已授权持续软件开发至079，Sol/High并行。077本地软件已封版；不push、不合并main、不安装发布，不读取真实音乐/库存/账号，不枚举或操作声卡/打印机。真实Gate B、可听Replica、Logic及Owner接受继续独立保留。

## 范围和退出口径

1. 对照PRD§75的30项、Development Pack A～E共63条及U01～10，共103条建立可验证证据索引。每条区分自动软件、受控合成、真实原生但无设备、未覆盖和Owner/硬件待验；不能把测试文件存在或总测试数当逐条PASS。新增索引校验覆盖ID完整性、来源/证据路径、状态与外部缺口，不更改权威PRD范围。
2. R020：普通Core启动完整历史审计与2秒ready策略分离；冻结有界启动期限与短控制请求期限，实际合成规模测冷开/ready/onReady/UI阶段，不跳过冷开/恢复审计，不把收到ready消息冒全程可交互。
3. R023：先冻结合法联合预算的规模/样本/阈值计划并测量，再针对Stop安全信号被同步全历史工作排队、Attempt/Record/Print验证及搜索成本写真实RED。必要局部/增量校验不得削弱外部篡改拒绝、SQL触发器、幂等、库存与恢复全量审计。记录请求、abort、driver.stop/close、持久回执分别的时间；软件数值不冒输出端无声或真实100/2000ms认证。
4. R021：保留旧CDP执行后Quit FAIL，在全新合成userData和新候选包上有界定位退出阶段；实际包由root串行运行，不降低Fuses/sender，不删除用户目录，不用SIGKILL、窗口关闭或启动自退出代替正常code0/无signal退出。未修复时如实保留风险，不能宣称发布准备完成。
5. 贯通同一个合成数据集的U03→U05→Record→Replica历史核验→J-Card→完整备份/隔离恢复/冷启，核库存7守恒与历史对象原字节；原版关系、自录谱系与型号身份不混。复用已有fixtures和自然测试位置，补真实缺口，不造重复103套测试。
6. 077预览滚动条只修未来生成：真实Electron先复现屏幕viewport/页边框，再隔离screen样式；实际PDF的几何/内容不变，renderer版本记录变化，旧Artifact/PDF不重写。此项不借机重做视觉设计。
7. 全verify/security/Electron/E2E/控制/边界/循环与16固定native SHA重新验证；保留失败/超时/慢样本。报告明确规模、平台、缓存状态、P50/P95/P99/max/N及测量限制。没有设备时可完成软件证据与079就绪清单，不能勾选真实整门或Owner接受。

## 单作者范围

- A（task071_picker）：`apps/desktop/src/main/core-supervisor.ts`及其自然test；R021先只读阶段诊断和runtime方案，确需改`main/index.ts`/shutdown模块须先向root列最小路径冻结。不得自行build/运行App/包。
- B（task070_store）：Core Attempt/Record/Print相关store/coordinator/integrity及相邻tests；合成容量fixture/benchmark只在明确新路径，先提交测量计划和生成策略，root分配独占测量窗口后运行重负载。不得改合同/public API/runtime.ts/repository.ts或删减审计，确需扩围先报告root。小focused可独立运行，所有生产先RED。
- C（restore_index_details）：`project/V3_ACCEPTANCE.json`、`reports/TASK-078_ACCEPTANCE_MATRIX.md`、`scripts/ci/verify-v3-acceptance.mjs`及其新自然测试入口；先明确schema/状态口径与TDD。只写本片，不把缺口自动PASS，不改PRD/Development Pack/STATUS。
- root：控制面/task/result报告、整体Gate/实际App/包/最终PDF视觉、Main PDF template/renderer与相邻测试、必要单数据集E2E。共享dist仅root写，build不与App/E2E并行。所有新测试及runtime脚本避免读取本机.env或启用真实provider。

三个原代理沿用Sol/High，阶段冻结后非作者SPEC→QUALITY，修复重审最多两轮。测量重负载与共享构建/App串行；读代码、文档与小focused可并行。新生产路径超出上述范围先由root做本任务内裁决，不要求Owner逐次决策。

## 开发中确认的最小扩围

- 同7盘App到激活后，旧窗口scope严格拒绝是原有正确保护。补真实UI显式重载入口：RecordingView/BackupRestorePanel及自然recording-workflow-integration.test；状态必须跨本窗口导航卸载保留，必要App.vue局部父状态/事件，不能自动重绑scope或重放。
- R021实际包发现默认持久session在合成userData晚设置前已创建。授权index.ts/startup-test-config.ts及自然测试：测试路径在app.ready/protocol/defaultSession之前同步严格验证并绑定userData与sessionData；生产普通路径不变，旧校验不放松。修复前停止实际App；不能把mock-keychain当目录隔离修复。
- R023首片增量仅Plan解析和完整原始事件tuple前缀纯计算缓存；公开完整verify、回执、Record/Print、冷开/恢复仍全审。同步SQL篡改/第二连接/schema/rollback拒绝不削弱。
- R023窗口03的25Record、照片/Print各32MiB完整采样确认三项性能FAIL后，授权B第二片只在Attempt已BEGIN IMMEDIATE的单次审计中复用已验对象与base64。局部保留上限128MiB、最多1024项，计Buffer及字符串保守字节，满则完整原计算；返回/抛错即丢弃，不跨事务/修改/数据库，不以SHA列代替真实raw字节比较。公开verify、冷开/恢复、原canonical、全部行集/孤儿/引用/receipt校验保持。Record附件关联可先只取长度/尺寸，后续实际BLOB全验不删。允许print-integrity/record-integrity/attempt-store与自然Print/Attempt测试，先真实重复计算RED，完整回归与非作者审查后用原种子/阈值复测；128MiB不是RSS承诺。

- 最终软件回归的钥匙串模式必须显式：测试专用test-keychain helper与startup/cold-start脚本允许严格mock/system选择，默认system保留；功能E2E所有launch/relaunch统一经helper。mock测试名/marker/命令明确区分真实Keychain未验，不改Main/Fuses。旧cold-start脚本复用既有runStartupProcess等待真实close，失败保留合成证据且不启动下一段。A单写script/helper/electron-gate与自然startup-gate.test；root单写E2E args，C只审查/同步映射行号。

- R023第三片由实际CPU归因驱动：B可新增Core私有object-format-integrity.ts，对自身标准编码的真实raw使用严格等价格式谓词，保留完整SHA、metadata、引用/孤儿及原canonical指纹。合同collection.ts、recording-artwork.ts、recording-prints.ts仅窄拆原尺寸/严格字段谓词，未验payload保持unknown，原公开完整guard继续组合且接受集合不改。不得传占位payload、trusted开关或顺带跨事务cache；自然行为RED与格式边界/篡改回归先行。
- A可新增独立capacity-process benchmark与私有phase helper，接prepare-backup/cold/full-recovery，现有generate/measure语义不改。每profile冷开与恢复各10个新Node/独立目的目录，完整archive-content与保护根、50秒至真实close0、原seed只读、全局16GiB自建预算与写后10GiB余量。root显式window/SHA/sourcepins/只计费owned-root清单授权后才真实采样；成功clone持久raw/receipt/hash后按既有owner清理，所有恢复及失败树保留。

- 原字节片复测P95=297.789ms仍超50ms，进入架构片而非继续叠加微优化：B可新增私有object-audit-certificate.ts，接Attempt/Record/Print integrity与自然tests。首片仅Begin全raw锚点和精确progress续签；最多16MiB轻量证明、有限条目，满则全审，不保留GiB内容，不缓存整份闭包。SQLite锁/提交协议内本连接、外连接、未知写、DDL/temp/PRAGMA和回滚变化均必须失效；beforeCommit配置禁复用。token在COMMIT前捕获，成功后仅发布，不读取提交后新计数洗白外写。公开读取/冷开/备份/恢复全raw与坏字节测试不变；不扩展承诺识别绕SQLite协议且被pager cache遮蔽的活库裸页恶意覆写。每次metadata行集、关联/孤儿、预算、lease/event照旧核验，禁止占位payload。Stop/cleanup另片，不据连续progress加速宣称停止达标。

- Receipt immutable raw-prefix候选 `bad5a62baa7b8472ab7ff59844659730640c83d18989d492f510f5cf803340c2` 已获独立SPEC/QUALITY PASS；每txn仍fresh完整六字段raw行集，精确旧prefix只跳旧JSON/DTO/fingerprint/relation replay，新增尾部全审，public verify全审。Attempt40/40、相邻Print17/17、types通过。固定窗口100/100业务成功，P50=48.326875ms、P95=50.709208ms、P99=52.153042ms、max=54.535917ms；max门槛通过，但P95≤50仍差0.709208ms，窗口自然exit1且失败输出保留。
- Attempt预算凭证候选 `61f68c9c2da53e0a075bcc94a9002bb8e8ec662b2ca5d13ff11f7861bf10031d` 已完成重复预算读、跨空事务token与负增量三轮RED→GREEN，并获独立SPEC/QUALITY PASS；三表count+SUM仍每txn fresh，token一次性绑定DB/epoch/savepoint/data_version/total_changes/maximum，任一不确定状态回退原fresh预算。Attempt42/42、Print17/17、types通过。新固定窗口100/100业务成功，P50=47.595000ms、P95=51.181458ms、P99=56.159208ms、max=80.159084ms；max门槛通过但P95≤50仍差1.181458ms，自然exit1，321 pins/window/source/seed/audit均unchanged，失败输出保留且不重跑同候选。
- queued Stop正式phase已完成真实父子IPC 5+100：105/105样本自然成功，无timeout/业务失败；abort最大0.848917ms、driver Stop invoke最大0.922375ms、ACK最大1.046416ms，证明同步停止派发边界通过。完整性能仍FAIL：child progress P95=67.642541ms/max145.345875ms；Stop receipt P95=1011.018625ms/max2246.085583ms；父进程发Stop到receipt最大2367.230167ms；driver close resolved最大2767.688875ms。241 source pins、window/source/seed均unchanged，正式证据已封存；不能用快速abort替代持久回执/关闭阈值。
- Attempt statement单次verify复用候选 `02909979a8b9f4e337f6a644fb5d9e62c6c8b8a96ea6c1ddd5c687b452527a0b` 已获独立SPEC/QUALITY PASS；statement不跨verify/txn/DB，唯一Plan仍每次fresh，公开verify全审。完整Attempt39/39、相邻Print17/17、types通过。新固定窗口自然exit1且100/100业务成功，P50=67.708583ms、P95=72.653875ms、P99=102.705792ms、max=107.700667ms，较82.591707ms继续改善但50/100ms仍FAIL；321 pins、window/source/seed/audit均unchanged，失败输出77038890字节/9文件保留。下一步为receipt原始tuple前缀优化，不削弱fresh关系/预算/orphan或公开全审。
- object-certificate首片固定objects-small窗口04已测：窗口 `r023-progress-window-04.json` SHA256 `4797f3e7ce59ae3738b538f02e3fc1ab3460513a23b670158c4a10fb3d3ab431`，自然exit1；105 raw中5预热、100正式且100/100业务成功，P50=74.855167ms、P95=82.591707ms、P99=110.116917ms、max=112.051958ms，50/100ms阈值仍FAIL。相对上一轮P95=297.789ms仅可记为改善，不能记为性能GREEN。audit/window/source/seed均unchanged，321 source pins，峰值RSS 483262464字节，失败输出77038873字节/9文件保留；原close不覆盖，`r023-progress-window-04-close-addendum.json`澄清`sourcePinsUnchanged=true`/`sourcePinCount=321`，`r023-owned-inventory-progress-certificate-addendum.json`登记保留输出。完整证据SHA256：summary `1c3d959162bfa2c3bb5bc476da83ddf54249ca7f2d3002e95bdda8333cffbd8f`、samples `365f1ef5a9644deb6e112a6931cbab43e8c793777aafb4c27fe210a553e1b130`、receipt `376fd90d10616f6d1922b0fad6f2089ba7e7e5890ce95e0cfde02624c3eb279a`、gate log `e64221663a1cde895ff281bb31edd2cc9fd1479f03440ad55427b6e418a79897`、gate exit `4355a46b19d348dc2f57c046f8ef63d4538ebb936000f3c9ee954a27460dd865`、close addendum `da7a82345dd91563a057e398954fbf0778a28d1dcd48923fcfd993a573ffb3be`、owned inventory addendum `fbf2e6e74b7c9f31f1b2a65554f8bb20b19dc417fe97df301b095d50799e71e3`。本结果不关闭R023整体、Stop/cleanup、容量phase、Gate B或Owner验收。


## R023 Record／Print结构锚点与queued Stop window-05

objects-small window-04确认105/105业务成功但child progress P95=58.137ms，唯一仍超50ms门槛。归因显示每次progress虽已跳过未变对象BLOB的SHA/base64，仍完整遍历Record／Print schema、预算、记录、视觉对象、打印任务、事件和回执。新切片只在Begin已完成完整结构核验后建立同DatabaseSync证书；`progress`、有限终止事实及Stop仅在`data_version`、`total_changes`、完整schema/关键PRAGMA/temp/database list均不变、写入delta精确且无`beforeCommit`时复用。公开verify、冷开、备份、恢复及非白名单动作继续全审。

两个确定性RED分别证明结构快照原本每次重扫，以及普通Begin的5次合法写可被额外未知写错误冒充许可分支6次。GREEN后Begin由生产路径精确声明0/5/6，额外写令候选失效。root新鲜Attempt 55/55、Print 17/17、queued Stop 7/7、类型和diff-check通过；独立SPEC→QUALITY最终均PASS，P0/P1/P2为0。

冻结候选`62cfdfe76bbf8d57c0c07e698c8702a9175d9f7ba17d9079a9b23ad952d71dd2`后，window-05自然exit0：5预热+100正式共105/105成功、0失败、0超时，105个child均closed且managed process group empty。正式child progress P50=9.175ms、P95=9.864ms、P99=11.219ms、max=22.314ms，通过P95≤50/max≤100；Stop回执P95=9.570ms/max=24.383ms，abort max=0.878ms，driver stop max=0.942ms，driver close resolved max=40.165ms，父进程发Stop至receipt max=40.293ms，均通过原门槛。241 source pins、window、owned manifest与原seed SHA保持，seed无sidecar。正式入口未采集RSS，不将未观测项写成PASS。

证据SHA256：window `08946e6fca6b033fb217656759d6f6b4a5ef7815462a6271f179b5496409e2a3`；source manifest `25e393ce2236ec5af4e9b9f7ab5ae0881ea9af29c102b4410bebb963c00068f7`；summary `32d7d42109676fa0662c8d9f6e744cf35a949f94a46d1736f52e274c92e0c5cb`；samples `a241c982550abb7e83f4d5f937d95d6fb1ff1c2a199c564de094aece12707c74`；close `04249d1f4cafdd4d0e6b8b27067d67f80cc1a669d3dc17ba062f4dfb5b95d615`；seed `8b3b626da0ac4ebd3809f978ac4928ef34525587f126db422564b64711f601d1`。本窗口关闭objects-small queued Stop软件阈值，不关闭limit/joint、cold、完整恢复、真实Print文件写、Gate B、实体纸张或Owner验收。

## R023 small-profile新Node cold与完整恢复

当前容量设施在集成候选上新鲜通过67/67。root随后按独立窗口、独立source/owned/seed身份串行执行，不复用历史窗口；每条恢复均先做同seed的全量`archive-content`备份，并在恢复窗口签发前强制比较`backupReceipt.sourceManifestSha256`与当前241-pin source manifest。两者不等即拒绝运行；本轮两档均精确相等。所有窗口自然exit0、无signal、父监督器PG empty，seed SHA未变且无WAL/SHM/journal。

- history-small cold N10：10/10成功、10个唯一child PID，min/median/max为405.216/415.286/445.518ms。
- history-small备份：数据库3,485,696B、7对象2,366,074B、manifest 3,698B，完整核验后`prepared`。
- history-small full-recovery N10：10/10成功、10个唯一child PID，min/median/max为1,206.449/1,224.522/1,281.569ms；10棵`isolated-pending-activation`恢复树全部保留且未激活。
- objects-small cold N10：10/10成功、10个唯一child PID，min/median/max为1,629.071/1,649.084/1,687.062ms。
- objects-small备份：数据库76,865,536B、55对象3,242,826B、manifest 48,074B，完整核验后`prepared`。
- objects-small full-recovery N10：10/10成功、10个唯一child PID，min/median/max为5,990.912/6,055.205/6,312.736ms；10棵隔离恢复树全部保留且未激活。

首轮非作者SPEC审查确认history运行内容、hash、进程与设备边界均正确，但指出prepare-backup缺独立close receipt。root未重跑窗口，只补当前不可变身份的静态`closed-prepared`收据，并同步补齐objects cold/backup同类收据。复审另发现objects seed在正式窗口结束后被普通只读SQLite检查生成0B WAL与32KiB SHM；确认无持有、主seed SHA未变后只移除空sidecar，并以addendum `cb74dccd6bd2529058f698e194d13c18f880a5660e0c3a0efa72090d8dc56cc8`记录before/after、时间与三份close身份。最终history/objects两条链的独立SPEC/QUALITY均PASS，P0/P1/P2为0。六个close SHA256依次为history cold `25a8d10333c2239c7947c4a76de93140b536633b8fc78e30045437238a20d962`、history backup `b5e9e8b64240d73ceacba5f8c5b48459fc4daf333286c03a8bbf9cee7f20795c`、history recovery `8d0201e943d7e5365dfd8ee7d098d66f9285828a14e816f8e1a6e9a90cbe6bca`、objects cold `d29d71af2420a59d3165d725a06cf792879961a8d1ed8bf1ddc9c57cc997779d`、objects backup `1f96c684954cf638b3f96678f3501b7a9bf031cb99fc359b0e47d8b8747f1703`、objects recovery `f00c3852c3c25c3d327193eba8bb8ccf83c32a47b9b538cbaf20b82dcacf54e2`。

上述cold是新Node进程但OS cache未清，不能称物理冷盘；完整恢复只证明软件隔离恢复，不关闭limit/joint大档、Gate B、真实设备或Owner验收。

## Print持久身份E2E直接证据（功能GREEN）

现有同7盘自然E2E已通过真实Main worker生成Electron PDF并经原生保存对话框替身写入测试自建新路径，但历史输出只间接推断claim。本轮先增加对`same-dataset-print-chain.json`的要求，真实RED因文件不存在而exit1；GREEN只增加测试侧只读SQLite证据提取，不改生产Print Store。非作者SPEC R1指出缺Main启动前边界及若干显式关系断言；修复后证据先证明同一job在launch前为唯一pending/create、lease NULL、零artifact/complete，再绑定launch后的`create→claim→complete` revisions 1/2/3、claim五字段lease、complete receipt、最终artifact、PDF/preview对象SHA/大小/MIME及实际导出PDF字节。desktop types exit0，目标E2E 1/1 exit0；最终SPEC→QUALITY PASS，P0/P1/P2为0。

GREEN-02 PDF SHA256 `a5014b91ec69d17c3fc16a991d1a8d8971e6d0fd8eae32b9d3031fdd5b1a82d2`、157,937B。独立pypdf重开确认3页，全部MediaBox/CropBox为292.5×288pt、rotation 0且每页存在文本；Poppler 144DPI渲染3/3，逐页视觉核无裁切、重叠、黑块或不可读字形。QA receipt SHA256 `695affe148f2633d22df486427dc8b246244b7575c0ebc6c58b5c270d979a17e`。

这项只把真实Main worker链从推论升级为直接持久证据，不提供R023 claim/complete的2秒计时。独立Core `print-write` pilot/formal phase仍是limit/joint前置；实体纸张、裁切、折线、100%缩放与Owner验收继续待外部条件。

## R023 Print claim/write 正式窗口

独立`print-write` phase以每样本新clone和新Node进程执行同一pending Print的`claim→complete→同请求回放`，逐项核对job/request/inputHash、lease、receipt、artifact、PDF/preview对象、原seed只读、无base64持久证据及清理前首错保留。retention证据碰撞最初会先删clone，真实RED已复现；GREEN改为先持久化retention再清理，完整capacity、queued Stop、Print Store与类型检查均通过，非作者SPEC→QUALITY最终P0/P1/P2为0。

pilot-window-01 10/10通过，但原50秒执行/55秒准入口径下formal-window-01只完成99/100，封存为`SEALED_INCOMPLETE_DEADLINE`；将准入缩至53秒后，formal-window-02仍只完成98/100，同样封存且不可重放。随后以TDD冻结Print专属25秒执行、1秒终止、2秒关闭、28秒准入，其他phase保持50/1/2/53秒；边界测试覆盖28,001ms允许、28,000ms拒绝，以及自然回执25,001ms不得伪装成功。pilot-window-02 10/10通过后才签发新正式窗口。

formal-window-03自然exit0：105/105成功、0失败/超时/未运行，5 warmup+100 formal；105个PID唯一、全部自然关闭且PG empty，无TERM/KILL，raw hash全通过且成功clone清理完毕。fork→close min/median/max为7,142.589/7,329.101/12,136.012ms；正式claim P50/P95/P99/max为466.466/552.461/629.375/667.666ms，complete为471.364/508.639/624.020/716.780ms，均通过2,000ms上限。window、source pins、candidate与seed未漂移，独立最终SPEC/QUALITY PASS。证据SHA256：window `a120b4798a8d311baafedbe9dc25322e4924d4473097714118c1b4b0f830ab1f`；source `9d961fa807209671ecedcad115080da3a1c24be0e46a1155c538bad9ece87e52`；summary `3ea8bfd803b95a2d836f3e78bb42b67e1c2f8883891c126a33b9a8d9a3d0219c`；samples `5cfad0adf9c2a93d769679238abc99b50ceef1d6ec00adbdba32ab95df18a7a0`；verification `cb09a1cd5018d6264bce6bcdd10f50fa1c488416f8ad7737d6819cfb47d00098`；close `78d49cd6bd3719ca61b852ea623b10108cad989cb252c859a200f29d4cf2f4d0`。

本结果限定为`formal-software-only/private-immediate-fake`；`deviceOpened=false`、`formalReady=false`、Gate B=`NOT_RUN`，不提供真实声卡、录音机、实体纸张或Owner接受证据。下一片为Joint `recordBytes`与`printBytes`各64MiB的50%元数据目标及硬边界。

## R023 Joint 六轴元数据

原joint只显式覆盖Attempt history、照片和Print对象，Record／Print metadata可能明显不足却被误判达标。第一轮RED证明`recordBytes`与`printBytes`均不存在，且缺少joint manifest probe；初版GREEN后并行只读复核进一步澄清六轴必须是Attempt events、Attempt metadata、Record metadata、Print metadata、Record photo object与Print object，records只是结构前提。第二轮RED复现了Joint仅凭Attempt bytes或events任一到达就错误`target-reached`，并证明manifest缺少同键的targets/actual/reached视图。

最终实现固定Joint目标为50,000 events、Attempt/Record/Print metadata各64MiB、photo/print object各512MiB。Joint的两个Attempt轴必须AND，history-limit继续保持原有OR先到者语义；Record或Print metadata少1 byte、Attempt任一轴少1均保持`continue`。records只写入`structural`。所有目标已达但非目标planBytes触及90%时优先`joint-boundary`；objects-limit未选择recordBytes时，其达到90%仍不得被零target豁免。生成循环复用同一Attempt判定，避免bytes先到后提前截断Joint events；空间投影显式计入Record／Print metadata。

缩小joint probe的manifest以完全相同的六轴键封存`axes.targets/actual/reached`，分类固定`functional-joint-probe/non-performance`，并保留`formalReady=false`、`deviceOpened=false`、Gate B=`NOT_RUN`。最终新鲜capacity 82/82 PASS、bridge-core typecheck exit0、限定diff-check exit0；独立SPEC与QUALITY均PASS，P0/P1/P2为0。审查候选SHA256为fixture `af2ed1ee77ef771d5be517b095432b04674dcab5e8c113e9a9e44c35940d08d1`、test `6082c4540bce94326005ea030c3bfe4fe97a4ee9215e6a6debcba174fb67e251`。本片只关闭目标、增长、生成停止与manifest口径，不证明正式大种子能在1200秒内生成。

## R023 large queued-stop schema 与 1200秒生成监督器

queued-stop现精确允许`objects-small/history-limit/objects-limit/joint`，统一N105（5 warmup+100 formal）和900秒正式窗口；print-write仍仅objects-small，cold/backup/recovery仍仅两个small profile。三个大档缺`growth.state=target-reached`时在operation前拒绝，joint另要求六轴targets/actual/reached与当前profile精确一致。完整capacity 82/82、bridge-core typecheck与限定diff-check均exit0，独立SPEC/QUALITY PASS，P0/P1/P2=0。

生成监督器保留旧phase最多900秒路径，新增独立generation scope、N1、精确1200秒与五键limits，只接受history-limit/objects-limit/joint。首候选17/17虽绿，独立SPEC审查仍发现parent manifest只回显、checkpoint未绑定fixture、zombie被误当PG empty三个P1；第二轮以真实RED关闭，并由root追加planned公式与symlink path两个RED。最终23/23、py_compile与diff-check均exit0，243项source pins包含完整phase集合及两份Python监督候选；window/owner/source/owned、磁盘、checkpoint/fixture/marker、seed、child evidence、自然exit0/no-signal/PG empty共同决定PASS。最终独立SPEC/QUALITY PASS，P0/P1/P2=0；候选SHA256为supervisor `2f7a9d83c0ab9eee4682cbb57b2873d990fe158662d7b51edced85bd31469ab8`、test `0bb7620e4e41c2c804ba4c9b8c48187f69ee9ef3727b7135a04a7c76f3c27fbe`。本片未运行大种子，不接触设备。

## R023 history-limit generation window-01 封存与性能修复入口

正式窗口UUID `243831c2-9e4c-4a8e-b7f7-eebd4319138f`、label `r023-history-limit-seed-01` 在固定243项source pins、37项owned roots及计划空间513,382,812B下运行。监督器于1,194,812.375ms发出SIGTERM并自然封存为`EXECUTION_TIMEOUT`；process group empty、无zombie、无SQLite sidecar，authorityStable且243/243 pins当前哈希精确一致。最后checkpoint 73为7,200 / 99,700 progress、generation 1,156,392.146ms、Attempt 12,777,441B；仅保留partial，未形成seed/exit/source-after，`verifiedPassed=false`，不得恢复、续跑或复用本UUID/label/window。close receipt SHA256=`4c18479e33b6392ff511a09b057d3e296dc3873d1c9be09d7d5f67c38eff39be`。

只读根因确认每个progress事务重新执行Attempt三表聚合、foreign key check及旧event/receipt prefix枚举，总工作量为Θ(N²)；99,700 events约触发99.4亿次旧事件row pass下界。独立安全审查允许以committed append certificate消除旧prefix重复枚举，但证书必须由完整审计建立，绑定同一DatabaseSync/environment/预算/active Attempt锚点；`data_version`和`total_changes`仅作保守失效戳，新tail/head/receipt必须fresh回读验证，candidate只能COMMIT成功后发布。公开full verify、冷开、备份、恢复、beforeCommit、未知写、rollback和tamper边界保持全审。下一步先写结构计数RED，再实现最小progress热路径；通过定向全量与独立审查后，使用新source identity、新UUID、新label和window-02，不重放window-01。

## R023 Attempt committed append certificate 最终审查

窗口01的二次复杂度根因经两轮结构RED关闭：热progress不再执行全库`PRAGMA foreign_key_check`，也不再执行`recording_attempt_receipts`的`count(*)+max(rowid)`覆盖索引扫描。最终GREEN只读取fresh head、Plan、最多2条新增event、最多1条新增receipt，并点查draft、physical copy与reservation；首次锚定、public verify、rollback、COMMIT失败、beforeCommit、未知写、环境变化与第二数据库继续完整审计。

候选四文件联合SHA256为`9ff91beb07643320f0e4095dc328cd97948a33145c494e7b9a15ba97e8f4dfe6`。最新root验证为Attempt 57/57、Capacity 82/82、bridge-core typecheck及限定diff-check全部exit0；独立SPEC与QUALITY最终PASS，P0/P1/P2均为0。下一执行仅允许以全新source manifest、UUID、label与generation window-02启动，不恢复或复用window-01 partial。

## R023 history-limit generation window-02 证据封口失败

window-02子生成在367,164.550ms自然exit0，67,900 progress时以Attempt 120,968,788B达到120,795,956B字节轴目标，最终seed.sqlite 144,556,032B且growth.state为target-reached。父监督器仍正确返回exit1/`GENERATION_EVIDENCE_FAILED`：benchmark `command.cwd`带一个末尾分隔符，而监督器按无分隔符字符串精确比较；父Python继承用户TMPDIR，但受控Node环境未传TMPDIR，导致fixture生成在`/private/tmp`而终态验证按另一个临时根拒绝。

窗口、UUID、label、source identity、seed与fixture全部封存，不回填为PASS、不重用。close receipt SHA256=`26ec8cc09efc38a1258d1fafe35c7fb1e5501e3e49942c70be331d0f5cae6543`。TDD已锁住canonical cwd仅允许精确根或单个末尾`os.sep`，并将父监督器canonical TMPDIR显式传入受控Node；聚焦2/2、完整监督器23/23、py_compile及diff-check均PASS，独立SPEC/QUALITY最终PASS（P0/P1/P2=0）；监督器完整24/24、py_compile及diff-check均PASS。下一步签发全新window-03。

## R023 history-limit generation window-03 PASS

全新UUID `6bd55c4f-83c4-47e3-812a-90880485f9c8`、label `r023-history-limit-seed-03`、243项source pins与43项owned roots下，父监督器359,293.802ms自然exit0，无signal、PG empty、zombie 0。683个checkpoint最终生成67,900 progress；Attempt 120,968,788B超过120,795,956B字节目标，history-limit按OR规则合法target-reached。seed.sqlite 144,556,032B，SHA256=`4336cd03f8b059e512d60dfec376cfd260f7a915aaf274038f33489c74f0b336`；seed metadata SHA256=`52e96e9e87ee365976875811bcb3697beca6cf0f24c04b077317fd923d67b082`。command、fixture、source before/after、source pins、owned roots与authority全部一致，无SQLite sidecar或unexpected entry，`verifiedPassed=true`。close SHA256=`26c25e9b2c993ccc254aad00a0069a5e494b794ea04059536d3a4c98afcd0973`。本结果为software-only synthetic capacity seed，不是性能phase、设备、Gate B或Owner验收。
