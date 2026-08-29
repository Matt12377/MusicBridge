# V3 剩余任务 TODO

当前进度：TASK-078本地自动软件子范围已通过并完成独立复审，报告提交 `93824b6ea9246fbd5c5c08b4c56d92ed62588ef0`；正在锁定最终身份，随后只从最终HEAD建立TASK-079独立分支。objects-limit/joint正式容量、可听Replica、TASK073真实HAL/Gate B、实体纸张与最终Owner仍待验；旧系统钥匙串退出FAIL与R020～023保持追踪。仅本地开发至079，不push、不合并main、不发布；智能体统一GPT-5.6 Sol / High。

本表是任务拆分与依赖计划，不是完成声明。后续任务沿上一任务最终 HEAD 创建独立分支；当前已展开 TASK-064～078，其余任务开始前补详细范围和允许路径。具体子任务可根据已验证结果细分，不删减 PRD 范围。

## 实时进度面板

> **当前执行：** `TASK-078 / 报告已提交，正在锁定最终身份并接续TASK-079`。冻结候选620文件、SHA256=`9d53a971…`，fresh verify/E2E前后四次身份一致；verify为Contracts 186/186、Bridge Core 1242/1242、Desktop 643/643，全部0 skip且构建PASS，E2E为91/91，既有7份证据逐字节未变；Security 29/29、Electron mock 4/4、矩阵规则19/19、native pin 16/16均PASS。正式矩阵经独立审查P0/P1/P2=0与`--require-fresh`确认：101 mapped passed、2 unmapped/pending、0 failed、外部门`NOT_RUN`、`formalReady=false`；最终独立审查回执SHA256=`a550c5cd…`。objects-limit 正式window-02仍因存储准入不足未创建。设备未打开，Gate B=`NOT_RUN`。

- [x] TASK-064～072：本地软件阶段完成；真实账号、真实数据和 Owner 验收仍按各任务报告保留。
- [ ] TASK-073：软件底座完成；真实 HAL、RME/Apogee 设备配置及 Gate B 等设备连接后执行，当前 `NOT_RUN`。
- [x] TASK-074～077：本地软件阶段完成；可听 Replica、实体打印和 Owner 验收未冒充自动通过。
- [x] TASK-078 / 同数据集与 App 冷开：7 条库存路径、PDF、两个 App 冷开场景已通过受控软件验证。
- [x] TASK-078 / R023 progress 性能：P95 已从 666.707ms → 491.685ms → 297.789ms → 82.592ms → 72.654ms → 50.709ms → 51.181ms，组合候选新正式窗口100/100成功，P50=45.604ms、P95=48.182ms、P99=49.817ms、max=50.855ms，首次同时通过P95≤50与max≤100；window/source/seed未变化、资源关闭。
- [x] TASK-078 / Attempt 热路径：receipt raw-prefix、预算凭证、对象证书与Begin完整Record/Print结构锚点均完成RED→GREEN及独立SPEC/QUALITY审查；最终root为Attempt 55/55、Print 17/17、queued Stop 7/7、类型与diff-check全通过。旧候选P95=51.181ms的失败证据保留；新候选 `62cfdfe7…` 不修改测量口径，依靠已提交结构证明消除重复全遍历。
- [x] TASK-078 / 父子 IPC queued Stop：独立objects-small seed的window-05正式5+100自然exit0，105/105业务成功、0失败、0超时，105个child全部closed且PG empty。child progress P50=9.175ms、P95=9.864ms、P99=11.219ms、max=22.314ms，已通过P95≤50/max≤100；Stop回执P95=9.570ms/max=24.383ms、abort max=0.878ms、driver stop max=0.942ms、driver close resolved max=40.165ms、父进程回执max=40.293ms均PASS。window/source/seed哈希未变、seed无sidecar；RSS本正式入口未观测，不冒充已验。close证据 `r023-queued-stop-window-05-close.json` SHA256=`04249d1f…`。
- [x] TASK-078 / history-small 新 Node cold N10：独立window-01自然exit0，10/10成功、0失败/超时，10个不同child PID均closed且PG empty；fork→close min=405.216ms、median=415.286ms、max=445.518ms。source 241 pins、seed/window/inventory哈希未变且seed无sidecar；OS cache未清，不冒充物理冷盘。
- [x] TASK-078 / history-small 完整备份：独立prepare-backup window-01自然exit0并进入`prepared`；数据库3,485,696B、7个对象2,366,074B、manifest 3,698B均验证通过，receipt的seed/source身份与当前窗口精确一致。
- [x] TASK-078 / history-small 完整恢复 N10：独立full-recovery window-01自然exit0，10/10成功、0失败/超时，10个不同child PID均closed且PG empty；fork→close min=1,206.449ms、median=1,224.522ms、max=1,281.569ms。10棵隔离恢复树全部保留且未激活，backup receipt的source manifest与本窗精确相等。
- [x] TASK-078 / objects-small 新 Node cold N10：独立window-01自然exit0，10/10成功、0失败/超时，10个不同child PID均closed且PG empty；fork→close min=1,629.071ms、median=1,649.084ms、max=1,687.062ms。source 241 pins、seed/window/inventory哈希未变且seed无sidecar；OS cache未清，不冒充物理冷盘。
- [x] TASK-078 / objects-small 完整备份：独立prepare-backup window-01自然exit0并进入`prepared`；数据库76,865,536B、55个对象3,242,826B、manifest 48,074B均验证通过，receipt的seed/source身份与当前窗口精确一致。
- [x] TASK-078 / objects-small 完整恢复 N10：独立full-recovery window-01自然exit0，10/10成功、0失败/超时，10个不同child PID均closed且PG empty；fork→close min=5,990.912ms、median=6,055.205ms、max=6,312.736ms。10棵隔离恢复树全部保留且未激活，backup receipt的source manifest与本窗精确相等。
- [x] TASK-078 / Print真实Main持久链E2E：自然RED因缺`same-dataset-print-chain.json`失败；GREEN后显式证明Main启动前唯一pending/create且无artifact/complete，启动后同一job形成create→claim→complete、lease/receipt/artifact/PDF/preview对象与原生导出文件闭环。desktop types exit0、目标E2E 1/1通过，独立SPEC/QUALITY P0/P1/P2=0；新PDF 3页、292.5×288pt、文本/144DPI逐页检查通过，不冒充R023计时或实体纸张。
- [x] TASK-078 / Print claim/write正式窗口：先后封存formal-window-01（99/100）与window-02（98/100）两次截止不足，不覆盖失败证据；25s执行/1s终止/2s关闭与28s准入经RED→GREEN后，window-03自然exit0，105/105成功、0失败/超时，105个PID唯一且PG empty。正式100次claim P95=552.461ms/max=667.666ms、complete P95=508.639ms/max=716.780ms，均通过max≤2000ms；候选/source/seed未漂移，独立SPEC/QUALITY P0/P1/P2=0。只证明私有Fake的软件持久链，不冒充实体打印或Owner验收。
- [x] TASK-078 / Joint 50%元数据：六个真实轴固定为Attempt events 50,000、Attempt/Record/Print metadata各64MiB、Record photo/Print object各512MiB；records仅为结构前提。Joint要求两个Attempt轴AND，history-limit保留OR；任一轴少1继续，非目标90%硬边界优先停止。缩小joint probe以同键targets/actual/reached封存且明确non-performance；完整capacity 82/82、typecheck/diff-check及独立SPEC/QUALITY全PASS。
- [x] TASK-078 / large queued-stop与生成监督器：queued-stop精确开放objects-small/history-limit/objects-limit/joint，保持N105与900秒；大档强制target-reached，joint强制六轴。生成监督器独立1200秒scope，绑定243 pins、owned/空间、fixture/checkpoint、自然退出与PG empty；两轮审查关闭3个P1，最终23/23、py_compile/diff-check及SPEC/QUALITY全PASS。
- [x] TASK-078 / objects-limit object-audit certificate：window-01的部分fixture继续原样保留且不重放。共享凭证已完成RED→GREEN：Attempt/Record/Print合法增量提交精确复用，未知触发器、beforeCommit、外连接写、rollback/COMMIT失败回退完整审计；Repository自然接线证明next Begin对历史4MiB PDF为0次hash读取。新鲜99/99回归、容量聚焦3/3、typecheck/diff-check均PASS。
- [x] TASK-078 / objects-limit 非正式扩展阶梯：10/25/50 records分别6.485s/16.586s/36.006s，print object分别41,945,600/104,864,000/209,728,000B，全部target-reached；每条约0.649/0.663/0.720s，呈近线性增长。该结果仅用于验证优化方向，不替代正式objects-limit容量PASS。原始阶梯日志已保留；最终源码哈希逐项复核一致，证据 `r023-objects-ladder-02.json` SHA256=`79919f73…`，验证日志SHA256=`9dc1bb50…`、exit收据SHA256=`e3c57c92…`。
- [ ] TASK-078 / objects-limit 正式window-02：`NOT_ISSUED_STORAGE_ADMISSION`。2026-08-29T13:01:27.099079Z准入快照可用13,353,312,256B（12.44GiB），正式入口保守投影需20,360,829,340B（计划9,623,411,100B + 10GiB余量），短缺7,007,517,084B（约6.53GiB）；未创建window、未签发authority、未运行、不可重放。安全阈值保持不变，先继续低空间Gate。
- [ ] TASK-078 / 剩余容量：history-limit generation/measure/large queued-stop均已正式PASS；objects-limit证书与非正式阶梯PASS，正式generation因磁盘安全准入尚未签发，后续measure/queued-stop及joint仍按线性顺序等待。当前继续执行不需要大容量fixture的自动Gate。
- [x] TASK-078 / 本地软件最终收口：完整双native verify为Contracts 186/186、Bridge Core 1242/1242、Desktop 643/643，全部0 fail/0 skip且构建PASS；security 29/29、Electron mock 4/4、fresh E2E 91/91，均0 skip；101条mapped fresh已正式写入并通过矩阵及结果报告两轮独立审查（均P0/P1/P2=0），2条真实设备缺口保持pending。报告提交已锁定；实机、Owner与容量carryover未因此完成。
- [ ] TASK-079：真实环境与 Owner 最终验收；当前没有设备连接，不枚举、不打开、不配置设备。

## 开发队列

- [x] **TASK-064：一致性快照与归档内容备份基础** — 本地自动 Gate 通过，Owner 未验收。SQLite Backup API、快照内引用闭包、内容字节完整校验、无覆盖发布。
- [x] **TASK-065：隔离恢复与基本索引重建** — 本地自动 Gate 通过，激活/UI 与 Owner 未完成。隔离目录恢复、重复恢复冲突、Manifest 重建、Quarantine；不覆盖当前用户数据。
- [x] **TASK-066：桌面备份与恢复工作流** — 本地自动 Gate 通过：77/818/186、安全22、Electron4、完整E2E50。独立维护库、内容位置绑定、显式激活/回滚与后台窗口；Owner未验收，大库冷启容量风险转TASK-078/Gate E。见 [TASK-066结果](../reports/TASK-066_RESULT.md)。
- [x] **TASK-067：持久命令 outbox** — 本地自动 Gate 通过：82/827/279、安全27、Electron4、完整E2E54。Main持久账本、Core工作库身份隔离、人工恢复和PREP整批撤权；Owner未验收。见 [TASK-067结果](../reports/TASK-067_RESULT.md)。
- [x] **TASK-068：参考目录与版次修订** — 本地自动 Gate 通过：95/847/291、安全27、Electron4；常规E2E56通过，固定native另跑1通过。来源原包、不可变目录、合并拆分审核与历史快照；Owner未验收。见 [TASK-068结果](../reports/TASK-068_RESULT.md)。
- [x] **TASK-069：Excel 非破坏导入** — 本地自动Gate通过：107/881/316、安全27、Electron4、完整E2E60（固定native开启，零skip）。原始字节与源行、显式来源关系、非破坏修订、独立数量账本及备份恢复；Owner未验收。见 [TASK-069结果](../reports/TASK-069_RESULT.md)。
- [x] **TASK-070：Want List 与收藏完成度** — 本地自动Gate通过：118/897/337、安全27、Electron4、完整E2E66（固定native开启，零skip）。Wanted与Owned正交、实际持有长度、不可变历史和预算分页；Owner未验收。见 [TASK-070结果](../reports/TASK-070_RESULT.md)。
- [x] **TASK-071：Source Picker 与双库交互补齐** — 本地自动Gate通过：118/897/395、安全27、Electron4、完整E2E73（固定native开启，零skip）。关系选曲、明确历史上下文、下一步指引、按需照片/单图重试与焦点返回；Owner及既有视觉carryover保留。见 [TASK-071结果](../reports/TASK-071_RESULT.md)。
- [x] **TASK-072：正式 Profile Snapshot / RecordingPlan / Preflight** — 本地自动Gate通过：127/922/414、安全27、Electron4、完整E2E75（固定native开启，零skip）。不可变计划/当前参数快照、八类预检、schema18备份恢复；F01已确认，Gate B未认证仍阻断，Owner未验收。见 [TASK-072结果](../reports/TASK-072_RESULT.md)。
- [ ] **TASK-073：输出后端与 Gate B** — 无设备底座、面板和隔离生命周期内核已交付；第四阶段修复启动退出验证及合成旧配置隔离，当前本地Gate为134/957/461、安全28、Electron4、完整E2E80。新包启动自退出通过；旧调试连接退出FAIL保留。真实HAL接入、设备生命周期/配置认证与Gate B仍待实机，不标完整任务完成。Owner已授权后续软件阶段继续，见[本轮结果](../reports/TASK-073_EXIT_LIFECYCLE_RESULT.md)。
- [x] **TASK-074：正式录音 Attempt 状态机** — 本地Gate通过：147/1005/483、安全29、Electron4、完整E2E83，双native、零skip。Cassette显式翻面/BeginB、DAT Program、中断不续播、三层完成、schema19及可能写入介质保护；真实准入仍受Gate B阻断，R023容量风险待078。见[TASK-074结果](../reports/TASK-074_RESULT.md)。
- [x] **TASK-075：录音档案、检索与双库同步** — 本地Gate通过：162/1035/505、安全29、Electron4、完整E2E86，双native零skip。首次Completed幂等不可变登记、当前内容认知、明确重录/擦除声明与检索；同一Physical Copy双库同步且不增加库存，历史快照不重写；真实播放/实机与Owner待验，见[TASK-075结果](../reports/TASK-075_RESULT.md)。
- [x] **TASK-076：Digital Replica（本地软件阶段）** — 本地Gate通过：174/1066/532、安全29、Electron4、完整E2E88，双native零skip。历史归档执行音频/原Render核验、恢复binding、有限只读会话与取消收口；生产播放保持blocked，可听Replica及正式provider仍待073/079，不冒称真实播放，见[TASK-076结果](../reports/TASK-076_RESULT.md)。
- [x] **TASK-077：J-Card 与 Printed Artifact（本地软件阶段）** — 本地Gate通过：184/1088/601、安全29、Electron4、完整E2E90，双native零skip。完成事务自动打印请求、Master Artwork版本、不可变PDF/预览、原生无覆盖导出与schema21恢复；实际PDF23页独立几何/内容/视觉通过，纸张/盒型与Owner待验，见[TASK-077结果](../reports/TASK-077_RESULT.md)。
- [x] **TASK-078：V3 全链路自动验收（本地软件子范围）** — 101条mapped fresh证据与完整自动Gate通过，结果报告和独立审查已提交；B-13/B-15、objects-limit/joint正式容量、系统钥匙串旧FAIL、实机与Owner保持carryover，不把局部封版写成V3整门通过。
- [ ] **TASK-079：真实环境与最终 Owner 验收** — 待 Owner。授权实物/库存表/Source Roots/Logic/设备实录；Owner 明确逐项接受。

## TASK-078 本轮软件检查点

- [x] R020启动策略：60秒完整启动期限、2秒普通IPC、代际私有恢复client；48专项通过，非作者SPEC/QUALITY R1通过。固定app03包已测history-small与objects-small各10次新进程，首次界面可用最大0.782/2.498秒，全部无重试且正常退出/无持有PID残留；mock-keychain与OS缓存边界明确，limit/联合及完整恢复仍待下面整体Gate。
- [x] 未来PDF预览：真实Electron滚动条RED→GREEN，36专项通过；23页PDF绘制内容/文字/精确页盒不变，最终PDF视觉与非作者R1通过，旧Artifact不重写。
- [ ] R023容量：100/1000progress旧基线已记录；1000档progress P95=79.718ms超过50ms，真实失败保留。Stop同步abort监听缺口已修，24专项+34相邻与SPEC2/QUALITY通过；前缀缓存78专项与SPEC/QUALITY通过，原种子独占重测exit0，P95降为14.058ms、abort最大0.111ms；对象设施7专项与独立审查通过；objects-small窗口03完整1575样本、零业务失败/超时，但progress P95=666.707ms、回执P95=717.056ms、Fake close最大1486.072ms均未达标；同步abort/driver.stop调用均小于0.5ms。75 JPEG与25 PDF独立解析通过，原种子SHA不变；同次对象审计去重已通过root45专项、类型与SPEC/QUALITY审查，独占100正式progress样本P95降至491.685ms但仍超过50ms；等价raw校验root50专项、合同12专项及SPEC/QUALITY通过，独占100正式样本P95进一步降至297.789ms、max333.482ms仍未达标。Begin全raw锚点+精确progress对象凭证已完成两轮真实RED、作者55/55+相邻40/40、root新鲜55/55、types0，并获非作者SPEC R1→QUALITY限定PASS；冻结fingerprint `2b7c65930afadc9ad1aac374c1c63827377891753a0bf7fc1d058ca4a1f4e28c`。固定objects-small窗口04自然exit1，105 raw（5预热/100正式）且正式100/100业务成功：P50=74.855167ms、P95=82.591707ms、P99=110.116917ms、max=112.051958ms，较上一轮P95=297.789ms明显改善，但50/100ms门槛仍FAIL；audit/window/source/seed均unchanged，321 source pins，峰值RSS 483262464字节，失败输出77038873字节/9文件继续保留。证据SHA256：window `4797f3e7ce59ae3738b538f02e3fc1ab3460513a23b670158c4a10fb3d3ab431`，summary `1c3d959162bfa2c3bb5bc476da83ddf54249ca7f2d3002e95bdda8333cffbd8f`，samples `365f1ef5a9644deb6e112a6931cbab43e8c793777aafb4c27fe210a553e1b130`，receipt `376fd90d10616f6d1922b0fad6f2089ba7e7e5890ce95e0cfde02624c3eb279a`，gate log `e64221663a1cde895ff281bb31edd2cc9fd1479f03440ad55427b6e418a79897`，gate exit `4355a46b19d348dc2f57c046f8ef63d4538ebb936000f3c9ee954a27460dd865`；close addendum `da7a82345dd91563a057e398954fbf0778a28d1dcd48923fcfd993a573ffb3be`明确`sourcePinsUnchanged=true`/`sourcePinCount=321`，owned inventory addendum `fbf2e6e74b7c9f31f1b2a65554f8bb20b19dc417fe97df301b095d50799e71e3`。Stop/cleanup仍为后续独立片。Attempt statement单次verify复用已获独立SPEC/QUALITY PASS，完整Attempt39/39、相邻Print17/17、types通过；新固定窗口100/100业务成功，P95进一步降至72.654ms、max107.701ms，但50/100ms门槛仍FAIL，321 pins与window/source/seed/audit均unchanged，失败输出保留。receipt原始tuple前缀优化已进入RED→GREEN。新进程冷开/完整恢复设施27项及审查通过，外层接线唯一证据清理P2经RED修复，完整60项及SPEC2/QUALITY通过。runtime父监督器v3已补共享2秒close deadline与消失进程组竞态，最终8/8；候选fingerprint `df581c5c6b67ba6e338726d6b98fc5006cc594b8d79ae3d8fa146541581732ae`，非作者SPEC R2→QUALITY限定PASS，审查 `r023-phase-supervisor-review-r2.md`（blob `8852e65522bfa3d10839fc1ee09e222489413bc0`，SHA256 `4a03eaa7174438c40bdaf6972137aa0644de94b59661a72b266fdafbfc7d36aa`）；实际容量phase/N10仍NOT_RUN。limit/联合、冷恢复与排队Stop仍待测，最大规模不由pilot代替。
- [x] 103项证据索引：修复15处因新增测试导致的声明行号漂移后，最终索引校验PASS：101 mapped且fresh passed、2 unmapped且pending；校验器19/19、CONTROL_PLANE与BOUNDARIES均PASS。只关闭映射的软件子集，不把B-13/B-15、外部门或Owner验收升级为PASS。
- [x] 同7盘数据集：candidate-app03实际App全链通过，真实UI激活/跨导航提示/显式reload、完整备份/恢复/再次冷启，19业务表及历史文件字节保持；实际浏览器存储路径为本次合成根。成功链PDF另经独立3页精确页盒/内容/栅格视觉核验通过；使用内存mock-keychain，不冒真实钥匙串/设备/实体纸张验收。
- [ ] R021新包执行后正常Quit：有限阶段观测54专项与非作者SPEC/QUALITY通过；首包身份校验通过；实际无CDP普通Quit在will-quit后超时，钥匙串等待线索保留；合成session早绑定72专项+独立审查与实际App路径验证通过；新包两种mock-keychain普通Quit均code0/close、无信号且持有进程全退出；测试显式钥匙串模式和cold-start关闭收口25专项、独立审查及实际Electron mock4/4通过；真实钥匙串旧FAIL保留，未勾整体。
- [x] 最终自动软件Gate：双native verify、security、Electron mock、fresh E2E、101条mapped fresh矩阵、控制/边界/循环、16 native pin均PASS；最终独立矩阵与结果报告复审均PASS，报告提交为`93824b6e…`。三提交封版后从最终HEAD接TASK-079；外部门仍未完成。

以上勾选只表示所列软件子范围，不表示TASK-078整体完成；所有实机及Owner项继续未勾选。

## 需要 Owner 的外部条件

- [x] F-01：2026-08-28 Owner 明确确认保守保留方案，见开发包 `f01-permanent-execution-v1`。批准不等于正式录音/设备或产品验收。
- [ ] 明确可读取的 Source Roots、实物照片、参考目录及真实 Excel 样本；自动 Gate 仅使用合成数据。
- [ ] 实机条件：2026-08-29 Owner说明目前没有设备连接，后续计划使用RME或Apogee声卡、Sony卡座；具体型号、连接方式、输出后端及测量配置待设备接入时确认，届时另行明确设备操作范围。真实Logic和实体录制未执行，Gate B保持NOT_RUN；不据品牌计划认定兼容或认证通过。
- [ ] Owner 逐项确认产品功能与视觉体验；自动通过不勾选人工验收。

## 不因 V3 开发自动关闭的历史项

- [ ] TASK-047：真实 Roon / NetEase 歌词验证。
- [ ] TASK-061：固定原生转换器发布准入。
- [ ] TASK-040/041：签名、公证、安装和 Beta 分发验收（若另行授权发布）。
- [ ] main 集成、GitHub push、签名、公证和发布分别授权；不属于当前自动执行范围。

## 完成判定

每项记录行为 RED/GREEN、SPEC 后 QUALITY 自查、验证退出码、实现/报告/最终提交。完整 Gate A～E 和 Owner 接受均保持未完成，直到各自证据齐备。
