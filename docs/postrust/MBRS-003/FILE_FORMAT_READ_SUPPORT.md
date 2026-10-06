最终交付补充：首个CI暴露的构建顺序与旧Preload测试表已修正；当前T原124项和新鲜编译再次实际通过，定向安全测试29/29通过。当前软件记录为 evidence/final-ci-corrected-software-manifest.json，早期记录保留。

当前交付补充（2026-10-06）：当前T正式软件Gate再次实际覆盖原33叶124项及新鲜编译，124 PASS/0 FAIL；34项验收运行器测试通过。Owner接受历史规模结果作为阶段放行，本轮没有新100k/300k；该决定不增加格式支持、真实曲库或播放声明。精确记录见 evidence/final-local-software-manifest.json。

# MBRS-003 文件读取能力矩阵

当前适用范围：当前源码的独立O副本已完成原33测试文件/124项功能测试，其中compiled-reader28、core-unit65和priority-integration13全部通过；这些是原124中的分组，不另加验收计数。当前Reader固定期限及fixed Worker bundle采用v2 fresh绑定。原22项、Snapshot05及早期App证据保留为历史；不拿旧运行时替当前bundle补未跑的边界。

实际记录：[当前O124结果](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-postrust-v12-j0tjux6s/mbrs003-root-current-original124-software-results-55-01/ORIGINAL124_CURRENT_O_SOFTWARE_RESULT_01.json)（699444B，SHA256 `cf4cb44adcfa16ecbad72cc2ce07df45b2eeeef1f29c1c095c896d3685bf229c`）、[54/55外层执行闭合](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-postrust-v12-j0tjux6s/mbrs003-root-current-original124-software-53-01/ROOT_DIRECT_TOOL_O_INSTALL54_ORIGINAL12455_EXECUTION_CLOSURE_ACTUAL.json)；[当前Reader v2声明](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-postrust-v12-j0tjux6s/mbrs003-root-current-original124-software-results-55-01/reader-build-binding.json)（65690B，SHA256 `9b1daa84803ea9acf7ffa777e8bb085e03cd7e44faa08bfb3e7c7bcf5f3ab0aa`）。证据只用于软件行为，不升级整体Gate、规模、播放或Owner验收。

## 当前已验证支持与明确边界

| 格式/目标 | 标签 | 技术/读取 | 封面 | CUE/片段与播放 |
| --- | --- | --- | --- | --- |
| FLAC | 合成title/artist/album正样本通过 | 容器、codec、rate、channels、lossless及有限duration通过；错扩展和坏/截断负控通过 | 内嵌PNG681B精确bytes/mime/SHA通过；可信64KiB边界通过、默认接受65537B | 不据此声明精确音频帧、CUE片段或播放 |
| MP3 | 合成三标签通过 | MPEG、lossy及有限技术事实通过 | 正样本未嵌图，实际空coverEvidence；内嵌封面未验证 | 当前真实MP3的CUE sidecar持久关联通过；非片段播放 |
| M4A ALAC/AAC | 各自合成三标签通过 | MP4及ALAC lossless/AAC lossy技术事实通过 | 两样本未嵌图，实际空coverEvidence；内嵌封面未验证 | 未验证片段/播放 |
| WAV/AIFF | 各自合成三标签通过 | PCM及有限技术事实通过 | 两样本未嵌图，实际空coverEvidence；内嵌封面未验证 | WAV可信CUE关联通过；非精确音频帧/播放 |
| APE | 当前Reader明确UNSUPPORTED，不作标签支持 | 完整174B作者合成fixture已评估，当前Reader正确拒绝；Worker实际退出、FD关闭、许可归还通过 | 无产品封面支持结果 | 独立probe/有限decode不等产品支持或播放 |
| DSF/DFF | 无标签正样本，当前Reader明确UNSUPPORTED | 两完整有限1bit载荷已评估，正确拒绝与Worker/FD/源守恒通过；DSD clock与解码率分开 | 无封面样本、未验证 | 不作播放支持 |
| CUE | TITLE/PERFORMER文本声明通过 | 75fps整数INDEX、资源/UTF8/歧义/路径负控通过 | 无封面读取声明 | 当前可信持久关联、MP3关联、raw/manual冷恢复及备份恢复通过；endFrames仍null、音频sampleFrames/timebaseHz与公开segment仍null，playback NOT_VERIFIED |

核心六格式加错扩展的实际持久化来自 `scanner-core-formats-persistence.test.ts`（core65中1case）：真实Reader读取、七组独立asset/track、raw/technical/cover持久化、冷恢复、未变重扫零Reader及源SHA守恒。错扩展仍是FLAC字节，不算另一MP3正例。当前Reader28中包含原Reader行为、APE1、DSD2、CUE sidecar行为；CUE纯解析与持久/恢复叶在core65，未新增或重复计入124。

APE历史完整评估见[实际收口](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-postrust-v12-j0tjux6s/mbrs003-root-scope-addendum-24/APE_DEFAULT_COMPLETE_AUTHOR_FIXTURE_UNSUPPORTED_READER_ACTUAL_CLOSURE_01.json)；CUE历史11项见[实际收口](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-postrust-v12-j0tjux6s/mbrs003-root-scope-addendum-24/CUE_ELEVEN_SAME_THREE_P2_GREEN_AND_SAFE_FAULT_ROLLBACK_ACTUAL_CLOSURE_01.json)。二者只解释历史演进；当前适用性以O55中的对应原测试及fresh绑定为准，不把“正确拒绝”写为格式正向支持。

技术事实仍是 `bounded-parser-reported`；封面事实是 `encoded-bytes-magic-and-digest`，没有图像解码或绘制证据。JPEG分支、其它五格式内嵌封面、year/disc/track正标签以及多封面累计预算，没有本矩阵对应的已封真实正样本，明确未验证，不以源码分支存在或上游支持补PASS。

## 默认4MiB封面：当前固定Worker两项补充通过

[旧默认两case实际收口](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-postrust-v12-j0tjux6s/mbrs003-root-default-cover-four-mib-actual-01/ROOT_DEFAULT_COVER_TWO_CASES_ACTUAL_CLOSURE_01.json)实际通过4194304B合法PNG保留与4194305B整项BUDGET_EXCEEDED，源/Worker/FD守恒；该记录绑定Snapshot05旧653运行时，不覆盖当前fixed Worker bundle。当前O124只有可信64KiB边界与默认接受65537B，不据此推出当前4MiB边界已经验证。

当前补充：**2 项通过、0 失败，实际读取 2 次**。Root只读取两份独立FLAC字节副本，使用当前v2 fresh Reader与固定Worker bundle；4194304B合法PNG完整保留并返回精确mime/bytes/SHA，4194305B整项返回BUDGET_EXCEEDED。两Reader真实Worker退出0，FD在释放及read返回后为EBADF；许可归还发生在FD关闭后，Reader.close完成且admission资源全0/closed。默认3000ms、4MiB与0retry保持，没有编码媒体或重跑124；这两项独立补充，不增加原13/124或8AT。

实际记录：[两项结果](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-postrust-v12-j0tjux6s/mbrs003-root-current-fixed-reader-default-cover-tests-88-01/CURRENT_FIXED_BUNDLE_DEFAULT_COVER_TWO_CASE_RESULT_ACTUAL_01.json)（8046B，SHA256 `44ca3ec25e45484327dce3c617793cd38fdf962076490ceca190f30d6c17ff8f`）、[Root90后核](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-postrust-v12-j0tjux6s/mbrs003-root-current-fixed-reader-default-cover-tests-88-01/ROOT_CURRENT_FIXED_COVER_TWO_CASE_POSTCHECK_ACTUAL_90.json)（5249B，SHA256 `521ef01e72be176919136945f8f064dcd5d14bd3dfdaa10291bb1ce6e5f8c074`）及[89/90实际工具收口](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-postrust-v12-j0tjux6s/mbrs003-root-current-fixed-reader-default-cover-tests-88-01/ROOT_DIRECT_TOOL_FIXED_COVER89_AND_POSTCHECK90_CLOSURE_ACTUAL.json)（48379B，SHA256 `eb24d6d5b836ea06a9cf38c962d28d282b7a32765a6e33c20737f5074d47c49a`）。实际Node／外层／归档退出0，外层0.650588秒，无超时或信号；后核首轮重复匹配元数据路径的工程失败保留，修正为明确路径后退出0，没有Reader重试。仅证明当前绑定的这两个PNG边界，不外推JPEG、其它容器、多封面累计、图像绘制或真实播放。

## 媒体优先级及验收适用性

当前O55的priority-integration13通过，覆盖真实Reader/admission/coordinator与受控媒体busy服务的有限交接；不是实际Roon/播放负载或Owner体验。普通metadata不执行全音频Hash/全解码，旧严格录音probe与SourceLock资格行为仍由原测试独立覆盖。源SHA仅为测试围栏，不变成扫描必经全Hash。

原8AT分别按任务核对，当前100k/300k源码规模合同尚无通过结果；旧300k失败、第四/第五阶段未跑保持，新300k必须另次明确授权。whole003 Gate仍未通过，本文不扩大格式/播放范围、不代替正常App、发布或Owner验收。

## 历史原22项与早期追加证据（保留原文）

下面表格及描述是其当时封存结论；其中“APE未知”“CUE持久未接”“4MiB未执行”不作当前结论。当前状态以本文上半部与上述最新exact refs为准，历史失败、预算、原夹具与source身份不改写。

当前结论：原20个合成行为case通过；新增两个故障case先实际RED，修复后同两个case及原20个case在fresh编译下合计22PASS、0FAIL/CANCEL/SKIP/TODO。原失败事实与日志保留。以下结论限于已执行合成样本与有限保护行为，不宣称整个格式或MBRS-003完成。

## 实际样本读取

以下六样本均由已有FFmpeg 8.1.2真实编码，Reader经root fresh core build后调用实际dist Reader及固定JS Worker。每项实际返回独立title/artist/album、44100 Hz、双声道、有限正时长；技术事实为`bounded-parser-reported`，不是逐帧解码或音质认证。样本完整bytes/SHA见`packages/bridge-core/test/fixtures/mbrs003/audio/manifest.json`。

| 格式 | 实际编码 | 标签读取 | 技术参数读取 | 封面读取 | CUE/片段 | 播放能力 |
| --- | --- | --- | --- | --- | --- | --- |
| FLAC | flac | PASS，合成正样本 | PASS，合成正样本；两sync截断负例修复后拒绝 | PASS，实际内嵌PNG681B及digest | 未测 | 未测 |
| MP3 | mp3，libmp3lame实际编码 | PASS，合成正样本 | PASS，合成正样本、lossy | 未嵌图，空coverEvidence通过 | 未测 | 未测 |
| M4A ALAC | alac | PASS，合成正样本 | PASS，合成正样本、lossless | 未嵌图，空coverEvidence通过 | 未测 | 未测 |
| M4A AAC | aac | PASS，合成正样本 | PASS，合成正样本、lossy | 未嵌图，空coverEvidence通过 | 未测 | 未测 |
| WAV | pcm_s16le | PASS，合成正样本 | PASS，合成正样本、lossless | 未嵌图，空coverEvidence通过 | 未测 | 未测 |
| AIFF | pcm_s16be，含ID3标签 | PASS，合成正样本 | PASS，合成正样本、lossless | 未嵌图，空coverEvidence通过 | 未测 | 未测 |
| APE | 无真实正向编码夹具 | UNKNOWN_NOT_VERIFIED | UNKNOWN_NOT_VERIFIED | UNKNOWN_NOT_VERIFIED | 未测 | 未测 |
| DSF | 完整有限合成1bit载荷，实际probe/短decode通过 | 无标签样本；当前Reader UNSUPPORTED | 当前Reader明确UNSUPPORTED | 无封面样本，未验证 | 未测 | 未测 |
| DFF | 完整有限合成1bit载荷，实际probe/短decode通过 | 无标签样本；当前Reader UNSUPPORTED | 当前Reader明确UNSUPPORTED | 无封面样本，未验证 | 未测 | 未测 |
| CUE | 合成文本，实际23个纯解析行为PASS | TITLE/PERFORMER文本事实通过 | 75fps整数INDEX文本事实通过 | 未测 | 稳定可信关联与歧义拒绝通过；持久关联未接 | 未测 |

FLAC的681B内嵌PNG证据SHA为`243ddd560483dfae4f0ac0cce1e922a7828baab254b6df5d3402d0fec4f06e45`；生成时提取字节与原PNG相同，实际Reader返回相同encoded-bytes digest和mime。本证据没有图像解码、绘制或其它五格式封面支持结论。

错扩展名夹具是与FLAC原件逐字节相同的`.mp3`，实际Reader按FLAC读取，并返回相同标签、技术和封面事实；这不是第二份MP3编码。48B截断FLAC与42B假`.flac`均由Reader实际拒绝；后者旧ffprobe虽exit0但技术参数为0，产品没有将其判成成功。坏项后同一Reader仍能读取合法FLAC。

## 预算、原件保护与生命周期

原20case实际证明：trusted textFieldBytes=4096时原始4096 UTF8字节完整保留，4097返回BUDGET_EXCEEDED。这是Node私有raw字段边界；超过公开catalog 512字符的raw标签可读，不证明LocalMetadata已导入、公开合同准入或真实catalog接线。

trusted coverBytes=65536时实际嵌图65536B通过、65537B整项BUDGET_EXCEEDED；默认4MiB参数下同65537B样本通过。64KiB只是trusted test profile，未缩小生产默认。未执行4MiB/4MiB+1封面边界；两个FLAC边界文件整体长度相同，断言使用真实封面bytes和SHA。totalReadBytes=64时真实reader拒绝并报告不超过64B的有限read计数，同源正常预算成功。

成功、Worker online/start取消、online后1ms超时及close取消active/queued等原case已实际证明Worker exit先于FD release和read-complete，返回时原FD经fstatSync为EBADF。并发1/2正控制与全部Worker退出通过。合成readAdmission被持有时不取FD、取消不抢许可、释放后读取并归还通过；这只证明permit端口行为，不能称已经接入生产当前媒体读取优先级。

19份固定合成原件及各测试私有副本，before/after逐SHA守恒。普通metadata路径是有界读取，不执行整音频Hash或全解码；测试保护用SHA不属于扫描算法必经全Hash。旧probeReadonlySource对MP3仍实际UNSUPPORTED，FLAC仍产生完整原件Hash与container-declared帧证据。planVersions在缺SourceBinding/未经确认时仍拒绝冻结，同实际严格证据加合成确认正控制通过；此处SourceLock是原录音资格，不是虚构全局共享锁，也不证明真实确认UI或用户操作。

## 两项实际故障：RED保留，同case GREEN

新增独立fault叶在相同fresh编译绑定下实际2FAIL、0PASS。第一case保留FLAC完整metadata，音频区只留FF F8/F9同步两字节，Reader实际返回ok，目标断言failure失败；完整标签头不能证明存在完整音频frame。第二case定向注入父FileHandle.close关闭前EIO，实际命中1次，read返回LEASE_RELEASE_FAILED，Worker已exit且fstatSync证明原FD仍有效，但reader.close错误地成功，fatal关闭断言失败。测试finally调用原realClose并核EBADF、恢复mock，未留下合成FD泄漏。

两项是目标行为RED，均已到达对应业务断言；不是缺symbol、import、fixture或编译准备失败。parent/worker修复后，root实际fresh build03及全core/test noEmit02均退出0，同两个fault case GREEN，原20case也保持通过，合计22PASS。原RED没有改写成成功。

新FLAC guard只读取不超过32B的首header，检查header CRC8及有限最小载荷/帧大小；实际拒绝metadata加两sync字节的夹具，不证明CRC16、完整帧解码、全音频解码或全Hash。父lease关闭失败现在使reader.close拒绝，测试仍由finally调用预存realClose后核EBADF；这不证明生产FD能自动恢复或自动重试关闭。

## 证据身份与范围

原20case：`ROOT/gates/mbrs003-compiled-reader-twenty-cases-01/result.json`退出0，20PASS、0FAIL/CANCEL/SKIP/TODO；result SHA `0ea06bb8cb943239490dc5d32be7396e7d979519aec42868a79c3bc02b750a5f`，raw log4835B SHA `7031b29da4628beb6366a75a93a5330762307f917b35aa79b9442af110d75961`。

新增fault：`ROOT/gates/mbrs003-reader-two-faults-meaningful-red-01/result.json`退出1，2FAIL、0PASS/CANCEL/SKIP/TODO；result SHA `71863713c9e10b0356e6ac881ca2c59745d3f0f128084703217bacd2f4b82733`，raw log2205B SHA `bda41463573ccae8487b114e8a0d71e621b033a975ec938b8dd223cb98fb2d44`。两个Gate均无timeout/signal。

以上原20GREEN与两fault RED共同fresh绑定为`ROOT/mbrs003-first-source-validation-01/READER_FRESH_BUILD_BINDING_02.json`2494B SHA `85dafb54ca666c3a6d57796f6f6e1c978bf2a26ae4e8b2540d0b69052cebf305`，对应历史源source-files f2eba5ff、reader 3f42e2fa、worker 1735ea25、types 167542c6。

修复后实际Gate为`ROOT/gates/mbrs003-compiled-reader-twenty-two-cases-green-01/result.json`退出0，22PASS、0FAIL/CANCEL/SKIP/TODO；raw log5282B SHA `124f08a1d010808b68135d63559a7186db8dd076e067171002bf0c78d8c5453f`。fresh binding03为2492B SHA `f054932cb6429755f5d7335e939a36a7038111ddb58c1dae809e185d0e8003e2`，4源为reader 2fc9d579、worker c7c22433、source-files f2eba5ff、types 167542c6。root compile pre/post424声明输入及8个对应Reader JS/map身份一致。Reader最小4源/8输出绑定不冒全部传递依赖closure。ROOT为本次外置任务证据根，详细路径由任务结果报告绑定。

原验收对应：003-03的样本读取矩阵与非扩展名判断、003-04的reader局部源守恒、003-07的普通reader/旧严格录音资格分离取得上述有限软件证据。003-02/06的全扫描故障隔离与生产媒体优先级、003-01/05/08的持久扫描/恢复/重定位/多候选/100k与300k、真实Renderer分页和统一writer仍须各自scanner/coordinator证据，不由本文代替。CUE当前已取得下文23个有界纯解析行为，关联恢复与片段播放仍无结果；DSF/DFF已用完整有限载荷逐项实际评估为当前Reader UNSUPPORTED，APE仍没有合法正样本，不以错扩展、上游支持或伪header冒充。

全部读取使用短合成媒体及私有测试副本，没有真实用户媒体库、Provider账号、Roon、发声、真实App使用或Owner验收。本矩阵不宣称任务完成或发布通过。原33条生成/探测/提图命令原stdout/stderr继续保留外置封存引用；runtime manifest仅relative路径/bytes/SHA和构造目标，不搬入外置私有路径或argv。

## DSF/DFF与CUE新增实际评估

DSF8284B与DFF8310B各含双声道、每声道4096B/32768个完整1bit样本，平衡交替模式不作听感认证。已有FFprobe识别dsd_lsbf_planar/dsd_msbf、2ch和0.011610s；已有FFmpeg实际短decode均退出0。DSD clock2822400Hz与FFprobe解码率352800Hz分开保留。原件及portable副本精确SHA见 `packages/bridge-core/test/fixtures/mbrs003/dsd/manifest.json`。无标签/封面，probe/解码不作完整规范符合认证或产品播放证明。

当前Reader对两份真实有限载荷各读64B后明确返回UNSUPPORTED；外置2项和新portable2项行为分别实际全过，Worker实际exit→父FDrelease→complete，fstat为EBADF，源原件/私有副本SHA不变。这里2PASS的含义是正确拒绝，不是DSF/DFF支持PASS。portable raw639B SHA `40b0203add7e40de1eb8b852851b7e12a7cf781ae3ea281b010b1ed300c69e20`，root评估/新范围身份由当前003状态绑定。

CUE新生产纯解析叶及23行为实际全过，raw4959B SHA `bf18d977cad80aa36b6297f84fd8c8a56536719a8bb31e0580b0d167362afe13`；fresh Core编译/全测试类型检查退出0。UTF8、字节/行/字段/FILE/track上限、75fps INDEX00/01整数、零起点与倒序/重复拒绝、可信资产六字段修订及0/多候选拒绝已覆盖。FILE仅查表key，不拼路径或打开FD；末端endFrames保持null，不由duration或下一INDEX推精确音频帧。纯文本解析没有持久sidecar状态、真正SourceRoot关联读取、恢复或实际片段点播；playback继续NOT_VERIFIED。
