# MBP-007：封面墙窗口、图片租期与资源预算

固定最终实现 `c948c1e14ba87ebdbde95c868ce55dff515c3509` 的原完整本地软件Gate已通过，软件完成9/11。基线 `4ac88f5a9a3a3ae8ae36d1da14c02a284dd098c3`，分支 `codex/mbp-007-virtual-artwork`。首实现aae59d1包含冻结前修正与005 Linux测试产物路径修复；457e32e修复独立R1唯一P2。报告提交以包含本文件的提交解析，下一任务008从报告最终HEAD创建。真实账号、Provider、Roon、音频、设备录音/GateB、main合并、App替换、Owner验收及发布均未执行。

## 行为与范围

Roon专辑/艺人、收藏、展开搜索专辑/艺人、网易歌单墙使用实际content-scroll的有限虚拟窗口，响应式列数/列宽按原CSS测量。不同页面offset、长标题、年份和收藏匹配状态按逐行最大自然高度计算；滚动复用布局前缀和状态代表，不在每次scroll重扫5000profiles。窗口之外只允许额外保留一个焦点行，Tab/Shift-Tab可越过窗口边缘继续逻辑顺序。原选择/来源/移除/重试/分页与返回scroll保留，all搜索原2艺人/6专辑preview维持；歌曲84px、队列80px、Session及线性窗口合同未变。测量副本不会克隆IMG/SOURCE，有限测量不额外派发图片请求。

收藏引用只解析窗口和overscan，保留原串行语义。128entries/2MiB UTF8短租期结果池按完整record、kind与scope绑定，15秒/负年龄不fresh；离窗/离页/换record/作用域后迟到结果不暖池。App原身份失效链同步轮转本地opaque epoch并clear图片；不持久化跨Core reference。首次解析初始化使用响应式holder，waiting/missing/error/ready都能建立测量依赖；副本同步真正条件按钮，不能借ready布局测missing。

Renderer图片共享flight有独立订阅者取消、generation与迟到finally保护。所有cache-owned资源含preparing和leased uncached计128/32MiB压缩Blob、96MiB自然RGBA估计、单图4MiB；PNG IHDR/JPEG SOF有界预检后才准入Blob，decode再核自然尺寸。该估计不是RSS，也不包含所有SafeArtwork远程img的原生内存。逻辑flight32、subscriber256、negative128/3秒，实际getImage/decode各32直到对应Promise真实settlement才归还，本地timeout不能伪称底层关闭。Renderer本地playing保留2槽；Core原SDK32通用，未引入DTO/IPC/ALS priority，不声称Core端到端优先级。

图片忙时仅150/450ms两次自动重试并受10秒总意图约束，随后显式手动重试。Core公开ROON_LIBRARY_REQUEST_FAILED只保守视为可重试临时失败，不证明其唯一原因是busy；控制取消/期限也不negative。网格将重试按钮放在卡片主按钮同层，避免嵌套interactive；闭包离busy/clear/unmount即失效。旧DOM error不能破坏新URL。256/384/768档位与900ms正常淡出保持；A→B→A通过独立frameToken精确释放，当前自身10秒超时回默认，supersede不会覆盖新帧，忽略signal的晚资源也恰好释放。强scope clear回fallback且不重放旧reference。

Core跨aliases同imageKey共享仍有独立owned ALS/currentness/固定10秒总deadline，最后取消/clear不late warm或negative新代。原actual SDK32约束、页缓存、播放owned与runtime合同未改，合法cache命中仍经过权限/作用域检查，数据clone保留。

## 验证结果

| 原完整范围 | 实际结果 | 退出码 |
| --- | --- | --- |
| verify：三包类型、测试、生产构建 | Contracts250 / Core1904+原2skip / Desktop1214，三包构建通过 | 0 |
| mock Electron 启动与恢复 | 4/4；系统钥匙串未验证 | 0 |
| 原完整 Electron E2E | 104通过+原4条件skip，0失败/0flaky | 0 |
| control-plane / boundaries / cycles / diff | 原范围均通过 | 各0 |

第四轮Gate前与verify后、第五轮Gate前与全部Gate后876源码指纹均为 `cd178bf637f5fb3000c0f8246b10615e87bb18da7233faccf712e79e4780c114`。

35个R2冻结源码/测试及1个Root后审E2E调整、876全范围源码身份及所有实际退出码/产物SHA见reports/MBP-007_EVIDENCE.json。作者相关Core149、Artwork54（原8+新46）、Grid56（原22+新34）、Root53（原49cache+4ambient parity）与各隔离严格检查通过；有重叠，不累计为全量数量。独立R1/R2与Chrome也不代替标准Gate或真实设备。

## 实际Chrome与结构观测

基线Renderer166文件由固定4ac的git show逐项保存并哈希核验。旧网易歌单网格只抽原App markup并加props/events glue，不改变原CSS。36case覆盖6墙×1400/680×50/500/5000，各首/中/末；新窗口最多42DOM，旧DOM随50/500/5000全量增长。每组总滚动高度/末索引/末入口和分层图片预算均核对；高度容差仅2px+每行1/16 CSS px量化，不能用百分比吞没布局回归。另7case实际Tab边缘、保留焦点、resize、offset420、稳定items条件晚挂/重新挂根、返回scroll、原manual/auto more、unmount/clear与900ms背景租期通过。最终12case用原missing/error消息×1400/680/420×50/5000核自然高；50全部失败状态与旧全量高度相同，5000只解析可见窗口/overscan，未截当前卡片。

同Chrome/相同合成1ms任务yield服务，另9组各20次交替滚动。最终5000专辑/歌单最大40DOM、收藏42；计时器延迟p95旧专辑24.1ms→5.2ms、旧收藏299ms→6.9ms、旧歌单24.7ms→6.5ms。保存全部原始20样本，不将墙钟观察作为硬实时门禁，也不称真实Roon、Electron wire、听感或RSS收益。确定结构证据：纯网格5000×20scroll曾100000次profile→修后0；窗口挂载/图片/解析有限、状态/布局变化仍重测。各原始DTO bytes/压缩Blob/RGBA估计计数分列。

## 审计、实际失败与证据限制

独立R1核35正式文件，冻结前发现并实际RED的根晚挂测量、背景自身timeout、Core忙误negative已独立GREEN。R1另确认唯一P2：Favorite初始resolution undefined使profile computed未订阅真实result version，DOM首次进入missing/error却仍借waiting高度。作者新增真实SFC三个结果case先3FAIL/exit1，补修响应式holder及真实retry probe，原52+新4为56GREEN；独立原bootstrap夹具未改GREEN，R2仅核四delta与必要邻域，不第三轮。最后窄R2原bootstrap夹具未改1/1、连续waiting→missing→retry→error→retry→ready的正式SFC/按钮夹具1/1、独立56/56及严格类型均actual0；其四delta与其余31身份前后相同，指定范围无未解决P1/P2。

首固定aae59d1原verify由Root在该P2确认后精确SIGTERM自有后代，wrapper实际143；三层type/Contracts到达，Core仅部分，Desktop与完整构建未到达，不计完整通过。修后重新固定457e32e并重跑原范围，未新增skip/缩范围/删失败断言。 第二轮同457源码全verify在对话中断后没有最终退出文件，原Core1904+原2skip已完成、Desktop只到pretest、构建未到；恢复时原handle和进程均不存在，实际退出码未知，保存VERIFY_R2_INTERRUPTION.json，不伪造143/1。随后第三轮同冻结源码verify及mock Electron通过；原完整E2E103pass/原4skip/1fail，旧用例要求26卡片全挂DOM而实际仅14窗口。Root保留原搜索、来源、offset24、详情和返回保护，把3处全DOM断言改为first/middle/end实际遍历精确核26条逻辑index/title次序与末index25，并显式回到顶部选第一条。原用例定向1/1actual0；此1文件test-only delta不新增第三轮独立审计，由Root自查后c948重新固定，第四轮verify和mock Electron退出0，原完整E2E为103pass/原4skip/1fail：case74在beforeEach electron.launch退出1，尚未进入页面断言，原退出原因未确定；相同代码原用例单次复跑1/1退出0。这不能代替完整范围。随后第五轮仅重跑原完整108项E2E和未到达的静态检查，取得上述退出0；verify/mock使用同c948第四轮有效证据，不无故重跑。R3与R4原日志/报告JSON/退出1均保留；R4、定向复跑、R5各用独立目录，不覆盖。

Root基线初次立即Promise响应时旧Favorite5000导致page.goto load超时，14已完成样本/实际exit1保留；改为基线与当前同1ms任务yield模拟跨进程服务后36case完成。数次Vite/模块/命令入口错误在TOOL_FAILURES.md，不算行为RED。几何候选真实抓到收藏状态刷新清全heights导致5000总高度缩小，已修为schedule保留profile；CSS三位小数列宽累计差另改原生grid列probe，保留原失败。

Root补修后误复用了final Chrome的r1产物名，旧final-r1同名原日志/JSON被新R2覆盖，不能声称旧final全部保留。旧candidate-expanded-r3、gestures-r1旧日志、scroll-candidate-r1、独立R1报告/RED与首verify143保留。本次新产物按r2归档，CHROME_R2_OUTPUT_IDENTITY.json与TOOL_FAILURES明确身份；这只是证据保留限制，不据覆盖文件回填旧通过数。新最终结果及Source_R2清单仍有可复核一致身份。

## 上一远端、carryover与接续

005固定4ac远端verify作业1133通过/1失败，新增测试固定本机产物路径在Linux ENOENT；构建未到达，不能说是旧生产缺陷。007移除写死路径，改TAP JSON diagnostic，原50/500/5000页/bytes/items断言全部保留。其workflow另dependency-audit仍失败11 moderate/7 high，独立保留009闭合；005 Electron E2E/security通过及原raw/artifacts已存外置。报告reports/MBP-005_REMOTE_CI_FOLLOWUP.md区分两项失败，不把日志下载0解释为CI0。

本地完整Gate已完成，计软件9/11；开发分支push与远端HEAD精确核验另记。后续008测量真实collection DB/合法page25后做批SQL/operation-local解析和索引；单catalog上限2000，5000总DB跨3book，不能用非法单catalog扩限。worker须依据优化后控制阻塞测量决定，不绕DB/coordinator/barrier。009仍收口依赖、旧v1 E2E类型、原全回归/远端结果。真实Provider/Roon/设备/GateB/Owner/main/App替换/发布均NOT_RUN，软件结果不升级为V3完成。
