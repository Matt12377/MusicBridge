# MBF 本地专辑 SQL 容量证据

旧 SQL 快照的定向测试 **11/11、退出 0**，以及 **600 轨小规模样例退出 0**。300,000 轨窗口因读取过慢已按调度要求停止，两个自有测试进程均已物理退出，收据退出 **1**。完整 300k 资格 **未通过**；正在修订的 SQL 需要独立的新证据，不能沿用旧快照的小例绿色结果。

全部库、来源、元数据和扫描/CUE 声明均为任务自有合成物，采用真实原 Repository、guarded read、重定位 availability 和本地封面只读端口。没有读取用户曲库、启动 Scanner/Reader/Worker、重放旧 scan Gate、打开真实账号或验证播放；本证据不代表 Owner 验收。

## 身份与原始材料

- 工作树：`/Volumes/LifeWeave/Developer/CommandLine/tmp/mbf-002-003-7tvk_82n/workspace`
- 分支：`codex/mbf-002-003-local-library`
- base/HEAD：`479e746bb7106a4dac158fe616290220de03a53a`，产品改动为未提交 WIP。
- Node：`v22.23.2`；Corepack pnpm：`10.17.1`。
- SQL 测试：[运行收据](/Volumes/LifeWeave/Developer/CommandLine/tmp/mbf-002-003-7tvk_82n/checks/album-sql-guard-fixture-current.json)、[完整日志](/Volumes/LifeWeave/Developer/CommandLine/tmp/mbf-002-003-7tvk_82n/checks/album-sql-guard-fixture-current.log)，2026-10-11 02:43:10–02:43:11 UTC，11 通过、0 失败、退出 0。
- 600 轨小例：[脚本结果](/Volumes/LifeWeave/Developer/CommandLine/tmp/mbf-002-003-7tvk_82n/checks/mbf-album-capacity-small-v2.json)、[进程收据](/Volumes/LifeWeave/Developer/CommandLine/tmp/mbf-002-003-7tvk_82n/checks/album-capacity-small-v2.json)、[完整日志](/Volumes/LifeWeave/Developer/CommandLine/tmp/mbf-002-003-7tvk_82n/checks/album-capacity-small-v2.log)。实际 Node PID 68111，02:43:23.917–02:43:29.332 UTC，退出 0。
- 旧失败的 `album-capacity-small.log`、`mbf-album-capacity-small.json` 与自有运行目录完整保留。其末尾失败是闭集 `SNAPSHOT_CHANGED` 被原 guard 映射成不可用；当前只在原 guard 内封送实际 `LocalAlbumReadError` 的四个安全业务码，原完整性、预算及未知错误继续由原 guard 处理，未修改原 guard 规则。
- 表示预算分析：[ALBUM_CAPACITY_REVIEW.md](/Volumes/LifeWeave/Developer/CommandLine/tmp/mbf-002-003-7tvk_82n/checks/ALBUM_CAPACITY_REVIEW.md)。它只测量少量对象再作标量外推，不能替代本次 SQLite 运行。

## 600 轨实际结果

`requestedTracks=600`、`full300kQualification=false`。阶段标题中的“300k”是复用脚本阶段名，不能覆盖这两个实际规模字段。301k 负例明确未运行。

| 独立数据检查 | 实际结果 |
| --- | ---: |
| root / asset / track / observation | 2 / 600 / 600 / 600 |
| edition / active edition relation | 2 / 3 |
| 独立核验 ledger | 1,807 |
| entity 加 ledger 行数 | 3,614 |
| 原目录各表 JSON 文本合计 | 1,667,028 B |
| scan job / batch / checkpoint / file | 3 / 3 / 3 / 6 |
| scan receipt / CUE source / CUE track | 12 / 2 / 2 |
| SQLite integrity / 外键错误数 | ok / 0 |

每条实体、闭集 ledger 请求、指纹、结果及原投影分别验证；scan 检查父批、checkpoint、当前文件事实和真实 CUE 引用。完成独立检查后另经原 Owner 完整冷开，不用自行构造的 SQL 表绕过原作者校验。

| 完整统计 | all | missing-artwork | has-artwork | cue-unsplit | metadata-issue | parse-failed | loose-audio | track-named-audio |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 初次全域 | 50 | 0 | 1 | 2 | 2 | 1 | 1 | 2 |

七类各自筛选返回精确总数与相同全域 counts；两根分别 29、21 组，相加为 50。相同名称的独立发行保留三个条目和两个 root，跨根同 edition 的 albumKey 不同；同轨多发行关系保留。首两页没有重复，非首页重读 ID/revision 相同，尾页七项且 `hasMore=false`，空搜索为明确空结果。

205 轨混合专辑读 offset=200 返回五条原成员及原 ID，前页 200 条、尾页五条合成完整范围。第 202 位使用真实 CUE asset 引用与 scan 文件参数，第 204 位保留真实 segment，不能把 CUE 禁用扩大到整张混合专辑。完整 inspect 返回 205 成员、两个真实 rejected 文件和三个 issues；零轨普通拒收组保留 null 代表轨与一个 rejected，普通拒收不冒充 AI 名称失败或元数据读取失败。

owned 零轨空目录由真实原封面端口读出 `ready/null`；本次回复仍绑定旧修订，下一 query 才确认缺图并计入一组。旧修订读图请求返回 `SNAPSHOT_CHANGED`。随后原 metadata 观察水位改变，缺图降回 0、状态为 unknown；自有来源实际移到离线位置后原 availability 为 `SOURCE_ROOT_OFFLINE`，不保留缺图，恢复 `ONLINE` 后也重新为 unknown。固定合成 PNG 的 scan 描述符仅用于 has-artwork 统计，不能冒充真实音频内嵌封面解析。

## 物化、缓存与内存字段的准确含义

| 记录字段 | 小例实际值 | 能支持的结论 |
| --- | ---: | --- |
| gallery `projectionStatements` | 2 | 一次全域统计加一次当页摘要；没有每卡片重跑全部 CTE。 |
| gallery `projectionRows` | 51 | 50 卡片加一行完整统计物化到 JS；不是 SQL 内部扫描行数。 |
| gallery `iterateRows` / `fullIntegrityRuns` | 0 / 0 | 已冷开后的这次 gallery 操作没有通过 iterate 拉取全集，也未重放完整 integrity_check。 |
| 非首成员页 `projectionStatements` / `projectionRows` | 2 / 6 | 一次组核对加一次当页成员/CUE 关系，五成员加一组摘要；没有每成员跑完整 CTE。 |
| 非首成员页 `iterateRows` / `fullIntegrityRuns` | 1 / 0 | 另有原作者有界读取；不能把整个详情操作描述成零 iterate。 |
| `cache.mode` / `observationCount` / `bytes` | sql-paged / 0 / 2 | 仅 Owner 封面观察摘要 JSON 的字节，空数组为两字节；不是总缓存或进程内存。 |

SQL 11 项小型真实 SQLite 测试另对 codec 计数：gallery 的 `trackDecodes=0`、`assetDecodes=0`；205 轨尾页只解码五个当页轨道，保持两次 SQL。300k 资格脚本计的是 SQL 实际返回行，没有对原 Owner 所有 codec 加计数。最终只能结合分页源码、小例 codec 与大规模实际返回行说明新专辑浏览没有全库 `LocalAlbumTrackFact` 数组/clone，不能宣称原 Owner 冷开没有全库审计、没有原 raw 投影或整个进程零全库读取。

128 MiB 不再是全库合法轨数的 JSON 拒绝门槛。新 Owner 不缓存完整 grouping graph；封面观察只留有限摘要，committed 与 pending 各最多 512 条；SQL 单次小缓存最多 32 条/1 MiB，执行结束清除。组内 hash、艺人及版本汇总有界，超过 32 位艺人显示“多位艺人”、版本摘要过长显示“多个版本”，详情仍保留原 facts。工作台 capture 独立限制为最多 10,000 成员（含 rejected）/32 MiB，超限整组明确拒绝，不给普通 browse 降低 300k 域或截断成员。

小例最终 RSS 为 **198,131,712 B，约 188.953 MiB**，进程累计 maxRSS 为 **193,520 KiB，约 188.984 MiB**，最终 heapUsed 为 49,360,008 B。`rss`、`heapUsed`、`external`、`arrayBuffers` 是每阶段前后快照；`maxRssKiB` 是累计峰值，不能称为某次 query 独占新增内存。小例原 Owner 冷开阶段 101.18 ms；gallery 阶段 686.56 ms 包含首、连续、重读和尾页多次 query；非首详情阶段 524.29 ms 包含查组和三次详情页，不是单请求延迟。

以上旧快照中，gallery 每个请求运行两次 SQL 全域聚合，members 两次，issue/rejected 捕获每页约五次 CTE；分页解决的是 JS 全库物化回归，没有将 SQL 处理成本变为与全库规模无关。旧 300k 时间与 RSS 见后面的停止记录，新 SQL 结果独立登记如下。

## SQL V2 新快照：214 项行为与 600 轨小例通过

当前 SQL `0971ad36c9264d47d2fc445b9d29672e4b5c2aa7bcca55198169d82fceb3f97e`、sql-types `b95088c9694d853d3591f07bea4f2890e0f300fb2a1dbfd3333be031185e2c06` 与 Renderer model `048dc8a31fb5b48d76657fb8936ba085f6362423e8817727adb52539f9858d28` 在生产/测试冻结后完成以下统一验证。原有效 RED 与全部旧失败保持原样。

| 新鲜检查 | 实际 UTC 起止 | 结果 |
| --- | --- | --- |
| `mbf-core-affected-final-v2` | 03:22:01.484–03:22:08.375 | 97/97，fail/skip/cancel 0，exit 0。包括 SQL 16 项、Owner/修订/协议、纯分组及工作台行为。 |
| `mbf-desktop-affected-final-v2` | 03:22:01.484–03:22:04.480 | 117/117，fail/skip/cancel 0，exit 0。包括 Renderer 18 项、实际 SFC、Main IPC/service、图片导入与来源边界。 |
| `mbf-core-types-final-v2` | 03:22:10.614–03:22:15.961 | 原 Core tsc `--noEmit` exit 0。 |
| `mbf-desktop-types-final-v2` | 03:22:10.613–03:22:25.333 | 原 desktop vue-tsc `--noEmit` exit 0。 |
| `mbf-capacity-600-final-v2` | 03:22:33.540–03:22:36.737 | 600 轨真实原 Owner 小例 exit 0；37 次请求中 35 次成功、2 次旧修订封面请求按预期拒绝。 |

每项同名 `.json/.log` 在外置 `checks` 目录中，收据逐文件封印 Core/合同源码与合同产物，`sourceChanges=[]`，真实进程组均已退出。600 轨完整结果另为 [mbf-capacity-600-final-v2-result.json](/Volumes/LifeWeave/Developer/CommandLine/tmp/mbf-002-003-7tvk_82n/checks/mbf-capacity-600-final-v2-result.json)。行为总数 **214** 只表示本次统一局部检查，不能换算成 CoverDrop 功能数或正式产品完成率。

新 SQL 图库实测一次投影 SELECT、一个公开 JSON envelope 返回行；counts 和当页在同一次 groups 聚合中产生，公开包在 JSON.parse 前按精确 UTF-8 核 2 MiB。源行的旧 64 KiB 预算保持原样，不套到派生公开包。完整修订仍包含十二个 raw/effective 字段、原轨道/资产、发行关系、已选封面与 scan 证据，顺序/身份沿原规则。版本解析缓存保留 title/artist 占用后的原 64 token 剩余预算；CUE 使用 root+asset 精确关联。合并的 Renderer `setScope` 一次建立新代际并发一个请求，迟到旧回复仍丢弃。

600 轨新例的统计仍为 all **50**，七类 **0/1/2/2/1/1/2**，两个根 **29/21**，三个独立发行；205 成员尾页仍是 **2 SQL / 6 行**，完整 inspect 保留 **205 成员/2 rejected/3 issues**。缺图 null→下次确认、raw 水位失效、真实自有来源离线/恢复全部通过。普通零轨拒收、CUE 与元数据失败仍各按原事实保留。

此次记录的是单请求实际时间：28 次图库读取为 **35.99–129.02 ms**，首请求 **55.09 ms**、公开回复 **26,905 B**；3 次成员读取为 **61.61–113.85 ms**，2 次 inspect 为 **189.45–261.35 ms**，4 次封面读取为 **31.12–60.99 ms**。这只是 600 轨小例，不外推 300k。最终 RSS **187,842,560 B**、heapUsed **44,750,248 B**、累计 maxRSS **183,472 KiB**，不能称为整个程序的专辑缓存大小。

新例 `requestedTracks=600`、`full300kQualification=false`。原 300k writer 拒绝与 301k 独立冷开负例尚未运行。正式 App、原 Worker/共享 journal 注册、Main/native 解码、真实曲库/音频、CUE 产物与 Owner 验收均不在该小例通过范围。

## 小例源码 seal

以下值逐项取自 `mbf-album-capacity-small-v2.json`，不是仅依据当前 HEAD 推定。最后的统一验证必须再次核对这些未提交产品文件，变更后旧绿色结果不能覆盖新快照。这是资格脚本所记的关键文件集合，尚不是完整传递依赖 seal；主代理统一 gate 还需保存实际采用的 contracts、sql-types、Owner runtime、封面只读端口、原 guard/metadata 规则等源码快照及测试文件身份。

| 文件 | SHA-256 |
| --- | --- |
| checks/mbf-album-capacity.mts | 9f9a217309828c9e76cb3caa02440e7f41799beac786709fae5973e0c88c2aa4 |
| packages/bridge-core/src/collection/local-album-browser/sql-read.ts | 9e3c0ebdfef6abbeec29d214ac963149e9cb35fdff51b0707cf59f4c254d640d |
| packages/bridge-core/src/collection/local-album-browser/owner-port.ts | 85471c6f59882ea12c2f2697066389b95f9dc0c0805635504e8033237f7b2f3e |
| packages/bridge-core/src/collection/local-album-browser/owner-store.ts | d31fd575d9e8f18236ac971a708ebeafac495a1c1ee45b0d580010f51503184f |
| packages/bridge-core/src/collection/local-catalog-store.ts | bc6437c90b3dde653d3eb0c6edc4dcb46cf5c8c13834c8e40b16a039f807d531 |
| packages/bridge-core/src/collection/local-scan-store.ts | 79871706ebb0e1ee2dd5f4bd6221262387f3e364991a2480efe90999b86d6051 |
| packages/bridge-core/test/mbrs002/local-catalog-capacity.test.ts（只作方法参考/身份记录，未重放） | 9d028c46353669f64e3f14992826f665705103c3088480d1cfcd052f9992dc67 |

## 旧 300k 窗口：已停止，性能资格未通过

窗口启动于 2026-10-11 02:44:36 UTC，真实 Node PID **69089**、pnpm PID **69082**。调度要求停止慢测试后，主代理先核对两个进程均属于本次脚本及自有数据库，向 Node 发送 SIGTERM，再核实两者均不存在。包装器自然结束于 **03:04:27.753387 UTC、退出 1**。完整日志、数据库、WAL/SHM、源码身份均已保留，没有删除或重新构库。详见 [停止记录](/Volumes/LifeWeave/Developer/CommandLine/tmp/mbf-002-003-7tvk_82n/checks/ALBUM_CAPACITY_300K_STOPPED.json)、[进程收据](/Volumes/LifeWeave/Developer/CommandLine/tmp/mbf-002-003-7tvk_82n/checks/album-capacity-300k.json) 和 [原始日志](/Volumes/LifeWeave/Developer/CommandLine/tmp/mbf-002-003-7tvk_82n/checks/album-capacity-300k.log)。状态为 `TEST_STOPPED_PERFORMANCE_NOT_PASSED`，`full300kQualification=false`。

实际完成的合法实体构造为 **36,286.87 ms**，逐实体/ledger 独立校验为 **25,096.28 ms**，原 Owner 完整冷开为 **47,782.89 ms**。首次完整统计与稳定分页阶段自然完成，包含 **5 次 queryAlbums / 10 次 CTE**，合计 **1,005,059.09 ms（约 16 分 45 秒）**；这是阶段总时间，没有单请求测量，不能称为首页延迟。完整统计为 all **29,990**，其余七类 **0/1/2/2/1/1/2**；分页身份、修订和统计断言在该阶段通过。

该阶段结束 RSS **3,136,143,360 B**、heapUsed **2,479,390,560 B**，累计 maxRSS **3,773,056 KiB（约 3.60 GiB）**。这些是进程快照及累计峰值，不能归因成某个请求新增内存，也不能用封面摘要的两字节缓存记录代替它们。七类筛选/根/搜索阶段刚开始时测试被停止；205 成员详情、完整 inspect、缺图/raw 失效、来源离线恢复、300k writer 拒绝与 301k 冷开负例均未完成，不能登记通过。

## 新窗口的执行条件

新入口是任务外置检查目录中的 `mbf-album-capacity-v2.mts`，原入口及旧证据保持原样。新入口记录每次真实 Owner 请求的起止时间、耗时、回复字节和内存，并由 `run-bounded-check.py` 同时限制总运行时间与单请求时间。超时只结束本次自有进程组，必须确认整个进程组退出，收据不能写成通过。运行前后保存实际传递依赖源码/合同编译产物 SHA，期间发生源码变化同样不能通过。

包装器总时间与请求时间停止机制各用一个自有合成进程核验过，实际均退出 124、Node 收到 SIGTERM 后进程组消失；这只证明测试工具能停止进程，不是 SQL 或容量结果。最终使用的包装器版本仍须绑定新运行收据 SHA。完整容量窗口由调度统一安排，V3.9 的重型验证窗口未释放前不启动。

正式结果须同时满足 `requestedTracks=300000`、`full300kQualification=true`、全部阶段通过、结果为“合成300k SQL容量资格通过”且进程退出 0；核对实读 script/source hashes 和物理退出记录。初始完整统计应为 all **29,990**，其余七类为 **0/1/2/2/1/1/2**；新 gallery 目标为一次分组聚合、只返回一行闭集公开 JSON 包，其中为当页不超过 200 卡片及完整 counts，并在 JSON 解析前核验 2 MiB UTF-8 预算。205 成员尾页仍为两次 SQL、六返回行。缺图确认、raw 水位变化、真实 owned 来源离线/恢复与完整 inspect 均需在这次大域内完成。这里的目标不是已通过结果。

原 Writer 在 300k 边界应拒绝新增且不追加实体/ledger。同 owned 副本的合法 301k 实体与 ledger 另经逐行独立校验、FK/integrity，再由原 `LocalCatalogBudgetError` 精确拒绝：domain=`local_catalog_tracks`、actual=301000、limit=300000，原 Owner 冷开也必须拒绝。该负例不能因“小例已通过”省略或放宽。

该窗口只覆盖普通合法六字段 300k、有限 scan/CUE 和三个发行关系，没有实测 1.2M 关系、600k scan、最大标签或所有合法域组合。闭集关系上限维持原 1.2M，纯分组小域 4x 边界测试与源码审查分别记录，不能把本窗口扩写成所有最差输入资格。
