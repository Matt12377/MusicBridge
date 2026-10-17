# MBF 本地专辑 SQL 性能只读复核

状态快照：2026-10-11 03:25 UTC。主代理已按调度要求停止旧 300k 长测，实际 Node PID 69089 与 wrapper PID 69082 已退出，session 82336 退出码为 1。原 log、DB 与 WAL 完整保留；[停止收据](/Volumes/LifeWeave/Developer/CommandLine/tmp/mbf-002-003-7tvk_82n/checks/ALBUM_CAPACITY_300K_STOPPED.json) 标记为 `TEST_STOPPED_PERFORMANCE_NOT_PASSED`。首段五个 gallery 请求确实完成并通过其断言，但整段耗时 1,005,059 ms，末 RSS 3,136,143,360 B，累计 max RSS 3,773,056 KiB。这是性能未通过的原始记录，不是新资格通过。

三项有效 RED 已由主代理实跑并保留：一次请求重复聚合（2 !== 1）、缺少 `setScope`，以及版本 fixture 修正后真实失败的 album memo 复用断言。版本 RED 的实际窗口为 03:12:52.350681–03:12:53.035450 UTC、退出 1，详见 [有效版本 RED 收据](/Volumes/LifeWeave/Developer/CommandLine/tmp/mbf-002-003-7tvk_82n/checks/album-version-memo-v2-red-valid-fixture.json)。原错误硬编码标签产生的失败日志也保留，不能算作优化根因 RED。

已按下列设计落地独占 SQL、私有 envelope 类型/预算、Renderer `setScope` 与行为测试，03:21 UTC 通知主代理源码稳定后冻结。主代理已统一执行受影响小型 Gate、类型检查和新的600轨真实Owner小例，本作者已读回原日志和收据；结果见本文末尾。作者没有运行测试/构建或新的容量查询，没有修改原容量脚本、原 store/guard、公开 DTO、关系域或扫描上限。新代码取得本轮小型行为与类型绿色，仍没有新300k资格。

实际文件是 `packages/bridge-core/src/collection/local-album-browser/sql-read.ts`，下文只读 EXPLAIN 对应旧快照 SHA-256 `9e3c0ebdfef6abbeec29d214ac963149e9cb35fdff51b0707cf59f4c254d640d`。本工作树没有 `sql-read-model.ts`。base/HEAD 仍为 `479e746bb7106a4dac158fe616290220de03a53a`，本次产品是未提交 WIP；HEAD 不能替代文件 seal。新快照见本文末尾，旧 EXPLAIN 与小例绿色不能覆盖它。

## 已取得的证据与边界

- [原查询 EXPLAIN QUERY PLAN](/Volumes/LifeWeave/Developer/CommandLine/tmp/mbf-002-003-7tvk_82n/checks/ALBUM_SQL_EXPLAIN_600.json)：只读打开已完成 small-v2 的 600 轨库，SQLite 3.51.3，Node 22.23.2，实际分析 PID 76767。在 SQL 准备入口只执行 EXPLAIN，原 counts/items SELECT 未执行，codec 事实读取被显式拒绝。原私有 `libraryProjection` 逐字段表达式按当前源码复现，scope 为两个 ONLINE 自有 root、真实样例 AI 失败上下文；没有 source-write journal，所以原 sourceLookup anchor 为空。
- [仅内存 SQL 字符串的计划变体](/Volumes/LifeWeave/Developer/CommandLine/tmp/mbf-002-003-7tvk_82n/checks/ALBUM_SQL_EXPLAIN_VARIANTS_600.json)：PID 78165，同一 600 轨库只读 EXPLAIN。没有修改源文件，没有执行变体 SELECT；计划变化不能写成修复或性能通过。
- [原版本 codec 64-token 边界实算](/Volumes/LifeWeave/Developer/CommandLine/tmp/mbf-002-003-7tvk_82n/checks/ALBUM_VERSION_CACHE_REVIEW.json)：实际执行原 `extractVersionTokens` 纯函数，wrapper 与原 `libraryVersionTokens` 的 title/artist/album 顺序及全局 `.slice(0,64)` 相同，只使用四个内存合成字符串，不读库或运行 Gate。
- 300k 原日志：[album-capacity-300k.log](/Volumes/LifeWeave/Developer/CommandLine/tmp/mbf-002-003-7tvk_82n/checks/album-capacity-300k.log)。完整 counts/稳定分页阶段于 02:46:25.890 UTC 开始，五个请求整段耗时 1,005,059 ms，停止收据时间为 03:04:27 UTC；此前原 Owner 冷开 47,782.89 ms、阶段末 RSS 645,529,600 B。没有阶段内 heap/SQLite 分配栈证据，不能把末 RSS 或累计峰值全部归于某一个 CTE 或 JS 对象。

## 具体热点

`limit<=200` 约束最终返回页，没有约束上游 SQL 工作集。当前为每个请求分别执行 counts 和 items，每次都构造同一套成员、事件及完整 group 聚合。分页避免了新的 JS 全库 DTO 数组，却没有避免 SQLite 物化全库宽行及临时索引。

| 冻结源码位置 | 实际计划与影响 |
| --- | --- |
| sql-read.ts:119–135；原 local-catalog-store.ts:190–195 | candidates/source_rows/prepared 被展开。counts 和 gallery 的计划各有 **39** 处 `SEARCH o USING INDEX local_catalog_observations_track (track_id=?)`；原六字段 raw/effective 共十二个表达式，又因 packed、版本及其他引用重复展开。每成员做多次索引探测与 JSON 字段读取。 |
| sql-read.ts:127–136 | `members` 使用 `SELECT *` 并 MATERIALIZE：track JSON、asset JSON、十二个 metadata 列、再重复编码的 packed_json、关系、扫描、版本及顺序同时驻留。全域 ROW_NUMBER 另建 ORDER BY B-tree；最终 LIMIT 尚未发生。 |
| sql-read.ts:136、149–152 | 计划至少三次 `SCAN members`，用于 seeds、目录统计和 member_summary；另有 GROUP BY、count(DISTINCT)、艺人/版本/hash 各自的 aggregate ORDER BY B-tree。多个面向 root、目录及 album_key 的自动覆盖索引进一步增加工作集。 |
| sql-read.ts:140–141 | CUE join 顺序实际为 cue→按 root 找 members→json_each 过滤 asset。自动索引只含 `(root_id=?)`，最坏可为 CUE 数量乘以该 root 的成员数量。CUE fallback 的 anti-join 已有 payload 自动索引，不支持把它描述成无索引全表二次循环。 |
| sql-read.ts:160 | gallery 代表轨相关子查询有 `(album_key=?)` 自动索引，加组内 ORDER BY。不是当前计划中的每组全表 N×G 扫描；仍可在同一次成员聚合选出 sequence=1，减少额外索引和排序。counts 计划已裁掉该代表轨输出。 |
| sql-read.ts:83–86 | version 小缓存 key 包含通常每轨唯一的 raw_title 及 artist；常见同专辑难以复用，仍执行三个字段的原解析。结果虽然只保留 album edition/format，却受全局 64-token 截断影响，不能直接改 album-only key。 |
| sql-read.ts:179–186 | counts 和 items 两套完整 CTE。主资格第一段五次 queryAlbums，合计十遍全域处理；阶段未完成不能直接解释为单条首页查询已运行九分钟。 |

两个 EXPLAIN 都物化 members、events、fallback_events、cue_members、directories、name_events、member_summary 和 event_summary。当前普通无 anchor 样例的 observation 探测按 track_id 有索引，整体更接近重复的 N 级探测、N log N 排序/索引构造及全域字节处理；没有证据把整段统一定性为 O(N²)。

原 `libraryRaw` 内另有 source-write anchor 条件下的 ledger `rowid>sf.ordinal` 相关范围探测，计划展示 39 个这样的节点，但本样例没有源写 anchor，`sf.ordinal IS NULL` 会先成立。因此它是合法 source-write 域的额外成本风险，不能拿来当当前合成 300k 耗时的已证根因。不能绕过或丢掉 anchor/部分标签观察的原语义来提速。

### 不能错误削减 counts 的依赖

counts 的 where 与 items 相同，调用 `mb_album_match(title,artists,year,version_label,source_label,query)`。非空搜索必须读取完整 group 的这些结果：

| 搜索/统计字段 | 必须保留的原事实 |
| --- | --- |
| title | 真 edition title；普通目录全组 effective album 一致性，或 raw album/原目录 fallback；根直属散落/零轨名称规则。 |
| artists / year | 全组 effective artist 汇总、effective year 一致性；超过32艺人的既定卡片摘要规则。 |
| version_label | 真 edition label，或按原 codec 总 cap 派生的完整 raw album 版本汇总。 |
| source_label / root | 当前原 root view 和 availability，不把 authorized 视为 ONLINE。 |
| 七类完整 counts | 成员封面/track-named/散落事实；全部真实 rejected 元数据失败、CUE 和 AI 结果；实际按需封面观察和当前来源 lease。 |

counts 的返回列不包含代表轨或 revision digest，优化器已经裁掉相应最终表达式，但 member_summary 被物化，仍会计算其 fingerprint 和有序 aggregate B-tree。不能因此把完整 search counts 改为简单 albumKey count、采样、只计当前页、跳过扫描/CUE 组，或裁掉后续 items、详情、封面、inspect 的身份和修订输入。

## 最小修订设计：旧长测停止后实施

保持同一原 guarded DatabaseSync、原 catalog/scan/source codec、公开 DTO、300k/1.2M/600k 域及原预算；不引入第二 DB、持久化读模型、TEMP 表或全库 JS DTO。下面是已落源码、仍待主代理验证的设计；执行计划预期与运行结果分开记录。

1. **以紧凑成员屏障控制 SQL 工作集。** 原私有投影仍按原规则解析六个 raw 和六个 effective 字段，保留 source-write anchor、最后一次存在值和原 override 语义。将重复使用的十二个字段在窄 raw 投影中计算一次；避免把 track/asset JSON 和重复 packed_json 带过所有排序/自动索引。紧凑层只携带真实 track/asset/root 身份、规范目录、albumKey、排序标量、卡片确实需要的标签/版本、状态及完整事实 digest。事实 digest 的输入仍包括原 sourceColumns 全部字段、原 track/asset JSON及所有修订、十二字段、真实 relation、选择封面和 scan 事实；不得以仅 ID、标题或旧 revision 替代。若采用每成员 digest 再有序聚合，属于确定性的分层哈希：所有旧输入必须继续参与，opaque revision 可以随新算法变化，albumKey 和身份不得变化。详情/封面代表行按当页原 ID 再关联原投影及关系，最多200；捕获仍分页读取全部成员并按原计划预算整组拒绝。

   计划变体已经证明 candidates 物化屏障可把39处标签探测降到12，source_rows屏障可降到15；但它们额外保留宽行，**不能直接把加 MATERIALIZED 当成内存修复**。实际采用不改原投影工厂的 `source_metadata AS MATERIALIZED`：只输出原 ID 和十二字段，再由原 track/asset 行生成完整编码 digest；`source_rows` 与 `members` 输出紧凑标量和 hash。`members` 不保存 track/asset/edition JSON、十二字段包或 scan JSON；详情按当页真实 ID 再关联同一标签屏障与原行。

2. **counts 与 page 在一次完整 group 聚合上派生。** 同一 guarded read 内构造完整 `groups AS MATERIALIZED(...)`，从相同 scoped/search groups 派生全部七类 counts、filtered total 与 limit/offset 页。最终一条 SELECT、一个物理 row，返回仅含 `counts/total/items` 的 envelope。先 `page_rows` 的 limit≤200 屏障，再调用原 summary 校验的受控 scalar；不会聚合全库公开卡片、私有目录或 asset_data。JS 在 JSON.parse 前核验精确 UTF-8 **2 MiB** 独立 API 包预算，超限抛实际 `CONTENT_LIMIT_EXCEEDED` 固定中文错误，整页拒绝，不截断。完整 group 身份、成员/事件指纹及当前观察/online 事实继续参与，原64KiB源行限制不套用于此派生包。超尾空页仍保留完整 counts 和 total；公开 LocalAlbumPage 和分页预算不变。

3. **CUE 先展开资产，再精确关联成员。** 使用 cue→json_each(audioAssetIds)→members 的固定顺序或等价有界 cue_assets 关系，以 `(root_id,asset_record_id)` 做闭集匹配；fallback 仍按同目录是否只有一个非 edition group 的原归属规则生成。仅内存字符串变体 `CROSS JOIN` 的 EXPLAIN 已由 `(root_id=?)` 变为 `(root_id=? AND asset_record_id=?)`，无需新 schema 或漏掉多发行/跨目录真实引用。保留 current signature/parser/root/file/location 校验与零轨/CUE-only组。实施后要测真实SQLite语义及非首页详情，计划索引改善不能替代行为通过。

4. **版本 memo 保留总64-token语义。** 原 `extractVersionTokens(raw,source)` 只依赖该字段 raw 与 source；但原 codec 是 `Ttitle.concat(Tartist,Talbum).slice(0,64)`。先解析/缓存 album 的最多64个原 tokens，再按 `remaining=64-min(64,Ttitle.length+Tartist.length)` 取 album 前 remaining 个，最后才筛 source=album 且 kind=edition/format、去重排序。输出 memo key 至少为 `[album,remaining]`，输入字段 token 计数亦可按原 raw/source 有界缓存；不能把整个输出只按 album 缓存。详情原 versionTokens 继续原完整 codec，不改变 raw facts 或公开合同。

可一并在 member_summary 中以 sequence=1 选代表轨，免去 gallery 相关子查询的额外自动索引/组内排序。根范围、搜索或状态的下推必须先证明与全域 counts/零轨事件闭集等价；不靠减少覆盖范围处理本次容量问题。实施后再按新代码风险做必要行为/性能验证，不重放当前冻结资格来“凑绿色”。

## album-only 缓存的合法反例

| 样例（同 album=`同名专辑 SACD`） | title/artist已占token数（cap64） | 原输出 | 直接album-only | album+remaining |
| --- | ---: | --- | --- | --- |
| 普通标题/艺人 | 0 | SACD | SACD | SACD |
| title=Deluxe Remastered，artist=FLAC | 3 | SACD | SACD | SACD |
| 合法349字title：SACD重复70次 | 64 | 空 | SACD | 空 |
| 合法349字artist：SACD重复70次 | 64 | 空 | SACD | 空 |

这些字符串均低于512字段上限。反例不是正则跨字段解析，而是 title/artist 先消耗了总 token 预算。直接 album-only 会改变普通目录版本身份与分组；四个小样本中的 budget-aware 算法保持结果，实际实施仍须补 cap 边界、同名版本分组、artist/title字段变化及详情 facts 的行为检查。不能把纯函数样例写成 SQLite 性能资格。

## 实际请求次数与计时粒度

以下为旧脚本正常成功路径；旧运行只完成首段五次请求，其他阶段没有完成资格证据。

| 脚本阶段 | queryAlbums次数 | 当前完整CTE次数 | 其他公开读取 |
| --- | ---: | ---: | --- |
| 完整counts/稳定分页 | 5：首个200页、a七项、b七项、b重读、尾七项 | 10 | 无 |
| 七类筛选/根/搜索 | 11：七filters、空搜索、两root、同名edition搜索 | 22 | 无 |
| 205成员非首页 | 1 | 2 | queryAlbumTracks三次：尾、首、尾重读 |
| 完整inspect/零轨 | 2 | 4 | inspect两次：205成员组、零轨拒收组 |
| 实际缺图/raw水位 | 4 | 8 | 两次getArtwork（当前读取、旧修订拒绝）；原metadata读写 |
| owned来源离线/恢复 | 5 | 10 | 两次getArtwork（当前读取、旧修订拒绝）；原availability读取 |
| 合计 | **28** | **56** | members/inspect/artwork另有其必要CTE，不包括在56内 |

`observeSql` 只对首个 gallery 请求和 offset=200 的单个详情请求记录 SQL 实际返回行/statement计数，没有单次耗时字段。`phase.elapsedMs` 是整段 action 时间，涵盖该段所有 query、断言及其他原作者读取；phase before/after 内存是段界快照，`maxRssKiB` 为进程累计峰值。

例如 small-v2 的 686.56 ms 是第一段五次 gallery，524.29 ms 是205段的查组和三次成员页；不能称为一次 gallery 或一次非首详情延迟。300k 原冷开47.78秒是独立阶段，不属于首次 SQL gallery 时间；原 gallery 首段的 1,005,059 ms 也是五次请求整段时间，旧脚本没有单次计时，不能据此声称每次均花相同时间。新 V2 runner 由主代理独占准备逐请求计时、总600秒与单请求30秒外部超时，尚未运行新容量资格。

## 已落实现与验证边界

`setScope({query,rootId,filter})` 原子校验闭集三字段、trim 搜索并一次重置查询代际；旧 `search/setRoot/setFilter` 保留并委托它。实际 Browser 接线由对应作者/主代理完成。新增合并请求和无效条件/getter 用例；SQL 新用例核单 SELECT、超尾 counts、原64-token合法反例与 memo 复用、十二字段/track/asset/关系/scan 的修订输入、合法>64KiB派生页及 2MiB多字节包整体拒绝、parse前损坏超包拒绝。SQL 文件16项、Renderer模型18项均在以下新日志中实际通过，没有skip/only/todo或降低断言。

03:21 UTC 实读的本作者生产文件 SHA-256（主代理统一 Gate 仍须保存完整传递依赖 seal）：

| 文件 | SHA-256 |
| --- | --- |
| packages/bridge-core/src/collection/local-album-browser/sql-read.ts | 0971ad36c9264d47d2fc445b9d29672e4b5c2aa7bcca55198169d82fceb3f97e |
| packages/bridge-core/src/collection/local-album-browser/sql-types.ts | b95088c9694d853d3591f07bea4f2890e0f300fb2a1dbfd3333be031185e2c06 |
| apps/desktop/src/renderer/src/composables/application/local-library-browser/model.ts | 048dc8a31fb5b48d76657fb8936ba085f6362423e8817727adb52539f9858d28 |

新测试与类型证据（均由主代理实际执行，本作者读回）：

| 层次 | 实际结果与窗口UTC | 原日志/收据 |
| --- | --- | --- |
| Core受影响集合，含pure/Owner/修订/SQL/工作台 | 97/97，fail0、skip0、cancelled0；03:22:01.485–03:22:08.376；退出0、物理进程组退出 | [日志](/Volumes/LifeWeave/Developer/CommandLine/tmp/mbf-002-003-7tvk_82n/checks/mbf-core-affected-final-v2.log)、[收据](/Volumes/LifeWeave/Developer/CommandLine/tmp/mbf-002-003-7tvk_82n/checks/mbf-core-affected-final-v2.json) |
| Desktop受影响集合，含Renderer模型/组件/IPC/工作台 | 117/117，fail0、skip0、cancelled0；03:22:01.485–03:22:04.480；退出0、物理进程组退出 | [日志](/Volumes/LifeWeave/Developer/CommandLine/tmp/mbf-002-003-7tvk_82n/checks/mbf-desktop-affected-final-v2.log)、[收据](/Volumes/LifeWeave/Developer/CommandLine/tmp/mbf-002-003-7tvk_82n/checks/mbf-desktop-affected-final-v2.json) |
| Core tsc --noEmit | 03:22:10.615–03:22:15.961；退出0 | [收据](/Volumes/LifeWeave/Developer/CommandLine/tmp/mbf-002-003-7tvk_82n/checks/mbf-core-types-final-v2.json) |
| Desktop vue-tsc --noEmit | 03:22:10.613–03:22:25.333；退出0 | [收据](/Volumes/LifeWeave/Developer/CommandLine/tmp/mbf-002-003-7tvk_82n/checks/mbf-desktop-types-final-v2.json) |
| 新V2真实Owner 600轨小例 | 03:22:33.540–03:22:36.737；退出0、无超时、物理进程组退出；requestedTracks=600、full300kQualification=false | [完整结果](/Volumes/LifeWeave/Developer/CommandLine/tmp/mbf-002-003-7tvk_82n/checks/mbf-capacity-600-final-v2-result.json)、[收据](/Volumes/LifeWeave/Developer/CommandLine/tmp/mbf-002-003-7tvk_82n/checks/mbf-capacity-600-final-v2.json) |

以上统一收据的 `sourceChanges=[]`，所含SQL/types SHA与本文新快照一致。本作者在测试后回读Renderer model（048dc8…）、Renderer测试（e4618c4abe96f955e02abd9d58d3da356f82c59785ec3c52c89205ab663a7144）及SQL测试（fef5c7223469e571677ccc3e92a47bd78a97a1a201e1fe1b546eb9882f8362ff），均与03:21封印相符。当前runner的source集合没有包含Renderer这片目录与测试，已向主代理报告补充封印材料；不能把集合内无变化扩写成自动监测了全部Renderer文件。

600轨实际返回完整all50与七类0/1/2/2/1/1/2、两个root29/21、三个独立edition组；图库 `projectionStatements=1/projectionRows=1`，一包只含50张当页卡片与完整counts，首请求公开回复26,905 B。205成员尾页仍为2SQL/6行，只解码当页5成员；完整inspect、零轨rejected、真实空owned目录缺图确认、原raw水位失效及availability离线恢复全部完成。总37次请求中28次queryAlbums、3次tracks、2次inspect、4次artwork；两次旧修订artwork请求按预期被拒绝，其余35次成功。28次gallery的单次实测范围35.99–129.02 ms，首请求55.09 ms；这是600轨样例，不外推300k。最终RSS187,842,560 B、累计max183,472 KiB，属于进程指标，不能解释为某次请求新增或总缓存预算。

旧 300k 停止证据和原失败日志持续保留。本阶段没有新 300k 性能结果，也没有普通真实曲库、播放或 Owner 接受结果。
