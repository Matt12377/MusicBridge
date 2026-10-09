# MBM-001 配对与只读曲库结果

本任务实现默认关闭的私有HTTPS、桌面配对和撤销入口、持久配对与轮换回执、唯一Dataset Owner的只读曲库分页和当前封面。最终Source为`cef70a57aa1f4b495e6babb4cc7c0b65f7297742`，唯一父为原官方安装器网络失败Source `80ce5aa3717785ad796cfbd29b1ba0e4d2165ac9`，此前首次普通推送Source为 `a99da1518c05f1833f24d1e4ffc5bdb9d28efafc`；完整任务基线为000最终R `c6c4745dfc7fe4242b8a2682798e00605649b12e`。iOS正式共享SDK实际消费Source为`b82049825e9e9058fe4a70186da70f5a267543ea`，其独立R为`c53ed3e4850f60b203d4773446db74789e2814d7`。

## 已验证的行为

- 精确Source的8个阶段自然退出0：49个Core用例和38个桌面用例全部通过，零失败、跳过、取消或todo。1686份声明输入逐份匹配Git对象；fresh reader的1502份源码、1009份产物及4份直接编译器文件完整核对。156项CLI准入检查和23项原生命周期用例另计，不叠加为业务验收数。
- Source首次自然push的四个workflow、六个job全部成功。完整六份日志和五份实际制品ZIP均已消费，整包digest与每个条目的CRC和完整字节均通过；详细范围见`source-ci-readback.json`与`source-artifact-readback.json`。标准工作区4721项声明、4719通过、原有2项条件跳过；Electron启动12项（其中4项system）通过，生产Electron E2E 116项中111通过、原有5项跳过，零重试、失败或flaky。012的426项、013的529项及000的33项分别记录。
- 本机原生产App两项用例通过，4次原App自然关闭；实际桌面OFF/ON、配对、轮换、撤销、登出和冷重开回执受控验证通过。两张实际选图产生6份原生JPEG，96/256/512三种尺寸完整核对。该组使用受控AES，不冒充真实Keychain；原两项App场景只有单曲或空库。
- 另一个真实生产Mac候选使用系统safeStorage、Main和原唯一Owner，自有103个原始音频、103首曲目、103个独立发行已实际扫描/登记。正式共享iOS SDK在macOS中实际执行22项用例：103专辑和103曲目各7页，重读、搜索、详情、矩形封面解码、双设备领取、原key/body轮换回执和登出隔离通过。恰好两个原可信Renderer显式许可，未自动补发。原App和父进程自然退出0，1693份源码/产物及104份自有源文件均保持，关闭数据库的assets/tracks/editions各103，sourceBindings为0。
- 上述候选的655份产品源码与最终Source整份Git字节相同，因此复用原实际运行证据，没有重放候选。SDK只使用RAM令牌存储；它在macOS运行，不能替代iOS原生页面、客户端Keychain、手机或音频验收。SDK结果只有三种解码尺寸，未报告响应图像格式；实际JPEG格式由独立App证据证明。
- iOS原149项软件用例、41项受控原生HTTPS以及Mock/Production两次未签名generic Simulator构建已逐份核对；最终实际SDK分支产品树保持相同输入，原测试不重跑。123份新驱动源码、32项离线驱动测试、22项实际消费及独立Source/R/普通私有远端已核。19项iOS验收按13项软件、2项实际Mac SDK和4项原生UI/设备/音频/Owner未跑分层；iOS没有workflow，CI未运行。

## 依赖审计缺口

本Source实际dependency-audit首次自然作业按既定`--prod --audit-level high`门槛通过，但原始作业明确报告8项moderate，不能写成零已知漏洞。精确Source镜像独立读取官方registry完整JSON，同样为moderate 8 / high 0 / critical 0，分别是现有qs 6.15.3两项、ip-address 10.5.0四项、music-metadata 11.15.0两项公告；完整原CI日志和独立JSON身份及8条公告链接保留于`source-ci-readback.json`。本机全等级audit自然退出1，符合发现中等风险的结果，不能冒充CI高危门槛失败或漏洞已修复。

锁文件整字节与000最终R相同，前两种来自网易云传递依赖，music-metadata用于既有桌面扫描。001直接模块检查使用内建IPv4/HTTPS及只读目录逻辑；这是源码检查推论，不能证明完整传递调用图无风险。依赖升级、公告适用性与已发布补丁版本的资格化列入016安全交付；本R不改变依赖、CI门槛或范围，不宣称PoC通过，也不把公告标题里的补丁范围当作已发布版本证明。尤其music-metadata两份上游公告正文与版本范围存在需要进一步核实的发布边界，详见[MP4公告](https://github.com/advisories/GHSA-f94x-6692-553q)及[EBML公告](https://github.com/advisories/GHSA-5gfj-9q3v-qfp3)。这项缺口保留至安全交付和发布前核验。

## 原始失败与修复边界

Source `a99da1518c05f1833f24d1e4ffc5bdb9d28efafc` 的首次自然Electron CI在host准备阶段失败：原23项生命周期中22通过、1失败，后续真正Electron步骤全部跳过。完整作业日志及完整失败条目的CRC/producer SHA已核；失败ZIP只读取选定条目，未宣称整份失败ZIP digest通过。该失败保留在Source的`first-source-ci-failure.json`和R的终态快照，未CI重跑。

修复只调整测试时钟：仍保留原500ms整体期限和23个原用例/断言，先确认末次探测已到达，再受控推进相同期限；生产代码未改。最终Source本机23项及自然CI成功。旧preload探针使用精确两处字节窗口适配，原49项冻结清单、013原断言、四个Gate的冻结范围和预算不变，未知版本拒绝。

首次Source的综合verify另在七项CLI准入通过后因`MBM001_SOURCE_NOT_CLEAN`停止，87项业务Gate尚未开始；该完整失败作业和原步骤保留于`first-source-verify-failure.json`。两个独立镜像复现前置Python导入生成3个未跟踪字节码文件；`PYTHONDONTWRITEBYTECODE=1`阻止生成，原干净工作区Gate原样保持。CI没有输出原dirty文件清单，本地复现与此前制品的3个缓存输入行是另两份证据，不冒充原CI完整dirty清单。受控时钟修复Source `cb7ef068ceec0b69b54d40f96c342c13ab249da6` 的首次自然CI也在相同干净工作区Gate停止，其Electron完整通过；CI环境修复Source `8cf0c970b0739fbf7712cd504e9a1e70085c867b` 又在标准Core测试出现16项取消，完整失败作业和各轮自然CI终态均保留。单独受控复现证明某些浮点起点使定时器延迟成为500.00000000000006ms，推进原500ms后仍待定；改为整数零点后原23项全部通过。原CI没有记录时钟起点，这一复现不冒充CI实际起点。整数时钟Source `9d95703ffe4192218ceb7ef6fbe94da238de7a5e` 将测试时钟起点设为0并记录证据；本轮最终Source继续保留该修复；保留原500ms、23项断言、CI环境修复及原干净工作区Gate，没有人工取消、重跑、忽略dirty、清理原文件或放宽测试范围。

整数时钟Source `9d95703ffe4192218ceb7ef6fbe94da238de7a5e` 的首次自然verify完整通过（包括001的87项），Rust两个平台与security也通过；Electron的12项startup通过，但完整作业被GitHub以“超过45分钟”取消，E2E116项只打印71项（67通过、4原跳过），没有完整套件结论。完整失败作业、GitHub原注释和原终态保留，未重跑CI。该作业的host准备约15分钟、startup约9分钟；后续Source `80ce5aa3717785ad796cfbd29b1ba0e4d2165ac9` 只将Electron整作业总时限由45改为60分钟，不改变命令、用例、断言、单项期限或冻结Gate的180秒阶段/480秒总预算。最终Source首次自然CI完整成功才用于本次R资格化，不能把前一轮局部通过当作完整通过。

整作业时限修复Source `80ce5aa3717785ad796cfbd29b1ba0e4d2165ac9` 的首次自然Electron作业在两套Rust host准备完成后，原锁定官方安装器报`TypeError: fetch failed`，两种制品CreateArtifact各在五次内置尝试后超时。官方归档/执行树校验、startup和E2E均跳过，零项实际Electron用例，失败ZIP未创建且没有整包资格化。完整原作业和终态保留。它呈现该runner的外部传输失败，原日志未给出fetch底层cause，具体根因未确认；读取时[GitHub官方状态页](https://www.githubstatus.com/)报告正常，不能据此证明该runner连通。

最终Source只给同一锁定官方安装器增加最多三次调用、相邻15秒等待。每次仍调用原`node node_modules/electron/install.js`，任何成功须其自然退出0，三次均失败则仍非零退出；三个受控shell场景分别验证首次成功、两败后成功、三败停止，它们只证明控制流，不冒充实际下载或Electron运行。60分钟整作业、原强制官方归档与实际执行树验证、所有业务测试命令/断言/期限保持，未更换来源或依赖。Source首次自然CI的实际安装器调用次数单独记入`official-installer-network-readback.json`；传输尝试不混作E2E重试。最终完整Source结果须六份日志与五份整包全部通过，前一轮部分结果不移作新SHA资格化。

候选58/59/60准备失败、61的`run-a3koFn`输入变化撤回、首轮iOS编译和Darwin管道阻塞失败均保留。撤回候选不计通过；最终运行证明只使用`run-TNbvog`。下载制品的超时部分文件同样保留，分段读取是同一制品传输，不是CI重跑。

## 独立报告与后续

本R唯一父必须为上述最终Source，自身SHA只在实际提交后解析。R首次自然push的两workflow/三job、普通远端exact/clean和成对最终封存尚待执行，最终结果由外置私有收据给出；不制造第三个封存提交。Source中的pending状态属于当时准备快照，R只改记账，九项验收和机器状态保持冻结。

下一顺序为002手机资源播放、003 FLAC无损、004内容与多设备、016性能安全及旧功能回归、017打包/说明/恢复交付。002只从本R最终封存HEAD开始；现有连续授权有效，不需要逐项常规审批。

真实LAN、iPhone原生UI、客户端Keychain、设备音频、真实Provider/Roon/NAS、用户媒体库、非空sourceBindings历史、自然TTL长时间等待、自动恢复和Owner试用未运行。移动001证明只读能力，不提前宣称播放或FLAC能力。原18任务/156AT、有效17/150不变，013八项继续PARTIAL、015六项继续取消N_A；历史真实层缺口不由本次软件或SDK结果抵扣。远端上传规则排除部分raw和编译正文，制品证明只涵盖实际上传内容，本机精确Source Gate另有完整raw/产物证据；没有宣称完整传递工具链闭包。
