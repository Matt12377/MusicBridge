# MBP-005：作用域缓存、歌单快照与渐进搜索

固定实现 `f9e7616982ec3e67d30aa058fafa9148f9accba8` 通过原完整本地软件Gate。软件进度8/11，随后从最终报告HEAD连续接续007、008、009。真实账号、Roon、音频、设备录音、main合并、正式App替换与发布未执行。

- 基线：a0c9cd7c1030c380263fa4394f73c5b802ec5f23（006最终报告）。
- 分支：codex/mbp-005-scoped-cache。
- 首次统一冻结/独立R2审计：ceb7ccb1e089233b53437f4dcdf33f43c34e01c6。
- 最终实现：`f9e7616982ec3e67d30aa058fafa9148f9accba8`；R2后的静态测试与描述符修复由Root自查和重新固定的全量Gate覆盖。
- 报告提交：包含本文件的提交，以git log -1 --format=%H -- reports/MBP-005_SCOPED_CACHE.md解析；下一任务由最终报告HEAD创建。

## 最终行为与范围

readLibrary追加可选cacheMode:'reload'，经过Main/Supervisor/Utility/Registry及独立owned ALS；旧默认四字段不变。normal/reload不共享同flight，同意图可共享；独立订阅者取消、固定截止期限与实际未返回预算保留。旧环境缺协议仍只调用一次具名API，不承诺reload等价强制刷新，也不在新协议失败后重放旧请求。

Roon缓存由受信service、reference scope、credential epoch与Zone组成身份，128页/16MiB/每页1MiB，普通15s/search5s、最长惰性保留5min。命中核当前origin/epoch而不touch权限TTL。定向reload只采当前UI origin；静止且没有实际在途RPC时复用原SDK key并真实pop_all，换本地sourceEpoch、路径与checkpoints；旧取消/超时/仍在途session继续既有retirement与真实预算。连续6次reload不再耗尽四alias，owned播放上下文不被UI刷新撤销。相同强epoch尾页可以保留，换epoch只一次有界rebase，rebase首读不再重复reload。

网易云歌单base严格取得真实id/name/count与完整ordered IDs，32条/16MiB/单条4MiB、account1、TTL30s。完整事实逐项比较仍受预算保留的lastgood base；真实重采完全相同时复用response-only UUID，有变化或无法比较时新UUID。缺完整IDs但header合法时走旧无版本分页；损坏header/IDs明确失败，不能补成空强版本。全部6000有序成员尾页继续可浏览，song_detail按IDs恢复顺序与重复位置，不套5000播放容量。版本证明完整header/成员本地采样，不证明分次song_detail是上游事务。

缓存和共享读取有独立逻辑flight32/subscriber256/fixed10s，Proxy原32read/8other直到实际settlement释放。base/account负年龄不fresh。page在途读取组有界256，latest accepted pageScope不依赖completed LRU；即使新版base被驱逐，旧页迟到也不能污染metadata。其他歌单普通LRU驱逐不误取消合法页。

Renderer生命周期纯值LRU为64页/8MiB/每dataset8页、fresh30s/最长重用5min。只存公开值JSON，无Promise/IPC/raw response/第二owner；读取clone，命中不延长时间。Core/Zone/auth/account保守轮转opaque epoch；取消/旧回执不warm，也不清新loading。页面保留已有内容并后台刷新；失败保留歌曲、显示提示与真实retry。account.changed在可信当前账户事件后恢复原授权读取，避免重复getAccountState/profile反馈与重复daily刷新。

NET songs/artists/albums与Roon albums/artists五分区分别发布/加载/失败，快分区不等待慢分区。保留原最终summary Promise、same-query singleflight/fresh默认合同；新query即时清旧并cancel。搜索详情实际App模板在refresh pending/failed时保留歌曲，retry明确同target/新generation/reload，旧more迟到不覆盖，父搜索scroll仍保留。

Provider强版本必须完全相同才追加；mixed/changed只一次可见rebase，再变化明确失败。双方缺版本继续原legacy分页并提示无法确认完整版本。App三个后台播放loader同规则；换版只停止后续追加，不重启当前音频。原1197长歌单、默认unique-track/120、TrackTable/Session/006及当前视觉保护保持。

## 原范围验证

| 原检查 | 结果 | 退出码 |
| --- | --- | --- |
| pnpm verify：Contracts / Core / Desktop | 250 / 1877+原2skip / 1134，三包类型与生产构建通过 | 0 |
| pnpm test:electron | mock软件集成4/4，系统钥匙串未验收 | 0 |
| pnpm test:e2e | 原108项：104pass+原4条件skip，0fail/0flaky | 0 |
| Control plane / boundaries / cycles / diff | 原静态检查与差异检查全部通过 | 0 |

858源码的Gate前、verify后、全部Gate后指纹均为`d44c510eecbba7f5ec74392843fdd06809ad1c869168decf0e9d167369bdf8c3`，HEAD均为`f9e7616982ec3e67d30aa058fafa9148f9accba8`。36个本任务源码/测试文件与最终冻结Hash一致；367份外置文件、124项实际退出记录已列入证据JSON。先固定实现后运行Gate，验证中没有改源码。

作者最终定向：Contracts250、Registry21、Transport21、真实软件跨层3；Roon128（原111+新17）；NET62（原29+新33）；Renderer164（原111+前轮新增33+本轮新增20）。各隔离production/new-or-changedtests strict退出0。范围有重叠，不能累计成独立总数；原完整Gate另列。没有缩小原范围、删保护断言或新增skip。

50/500/5000 Renderer公开值页池逐页夹具实际保留3/8/8页、50/188/176条、3710/14221/13713 UTF8 bytes；单dataset8页及总64页/8MiB行为另有保护。Roon同规模冷首屏limit4各SDK raw5行，warm root不新增SDK读取；原detail增量机制本来已零新增SDK，新增页缓存减少的是Core mapping，不冒称再次减少SDK。该观测不是RSS、真实Electron wire或真实Roon毫秒。

## 独立审计与失败归因

两轮独立审计覆盖35源码/测试文件。R1确认6个P2：NET负时钟伪fresh、LRU后旧页metadata回写、缺真实header伪强版本；Renderer负年龄恢复绕过校验、账户事件清页未重载、实际模板隐藏保留歌曲。原独立RED12个case（header-count有重叠）保留；作者只补指定原因与直接保护，R2全部12GREEN、NET62与Renderer144回归及严格noEmit、35Hash稳定，未剩确认P1/P2。R2是指定范围复审，不宣称整分支无严重缺陷或真实设备已可靠。

005独立direct Fake R2实际设置了工程不识别的旧MUSIC_BRIDGE_KEYCHAIN_MODE变量，未触真实钥匙串；报告已撤回mock-mode验收表述。Root原Electron Gate实际使用MUSIC_BRIDGE_TEST_KEYCHAIN_MODE并输出mock软件集成标签，两个证据边界分别保留。

NET现有library规格只调整两处合同：response-only UUID单独检查、其余旧返回值deepEqual；owned有限期限替代Infinity、Provider body/args deepEqual仍保留。其他Roon旧测试仅两个可信cache stamp夹具字段；Renderer原10规格逐字未改。

首个ceb7ccb原完整verify退出1：Contracts250/Core1877+原2skip通过，Desktop1112pass/2旧静态case失败，未到最终构建。cachedArtists被不带词边界的Dart禁入正则误匹配，旧query调用和Promise.allSettled文字断言与已确认渐进发布合同不符。Root仅修一旧test文件：完整运行时禁入词及四个禁止import样本保留、query仍为首参数、分区catch/publish保护继续，35/35通过。da05269原完整verify与mockElectron随后通过，其来源指纹1e41b1be…单列，不作为最终固定HEAD证据。

da05269首个完整E2E真实退出1：103pass/1fail/原4skip/0flaky，最后原本地搜索case同reference的新艺人标题被旧缓存描述符覆盖。未改原3668父标题断言；Root自查发现旧根列表也会覆盖当前seed，四detail owner统一当前点击优先、仅缺当前target描述符才回填，App沿原导航/父页顺序同步seed。新20行为case的实际基线为4pass/16fail，最终20全部通过；Renderer相关164/164，原111保护保留。85562ce原失败Electron定向case1/1通过、0skip/flaky，完整原JSON和失败目录另名保存。该三文件生产/测试delta发生在R2之后，由Root自查及新固定原完整Gate覆盖，未增加第三审计轮。

85562ce第三轮原完整verify退出1：250/1877+原2skip/1133通过，1旧P1-D静态case仍要求genre/playlist导航内联在@select。Root只校正同一旧静态test以核统一点击入口、seed在前、原type/reference导航在后，原case35/35通过；其余原断言未删。最终固定f9e7616原完整verify、mockElectron、完整108项E2E与静态Gate均exit0。所有早期失败日志、退出码与身份保留；不通过缩小范围或新增skip获得通过。

入口/ESM/CWD/外置typeRoots与.ts import配置、错误监控id/非法错误文本夹具等日志分别保留，不算生产行为RED。R2模板首轮外置fixture缺新的search.retrySearchDetail binding，单补外部fixture后原可见歌曲断言通过；仓库源码未改，不把fixture错误定为新产品缺陷。原始日志、actual exits、manifest及所有Hash详见MBP-005_EVIDENCE.json。

## 上一报告远端与后续边界

006报告a0c9cd7远端：verify job110236979885、security、Electron E2E均PASS；verify工作流仍因dependency-audit FAIL（11moderate/7high）。原始日志外置封存，009继续闭合。005报告创建时远端CI尚未执行，push与精确HEAD核对单列。

图片binary/decoded预算与虚拟网格属于007；收藏批量SQL/进度扫描属于008；旧v1-ui整文件30条类型诊断、依赖审计与最终接口收口属于009。压缩/公开值缓存预算不等于进程RSS。真实账号/Provider/Roon/音频、真实录音/Gate B、Owner验收、main/App替换/发布保持NOT_RUN。

## 回滚

旧接口可以不发送cacheMode、无snapshotVersion时继续legacy原分页；不具有强刷新或版本一致性保证。需要撤回本任务实现时由后续显式回滚提交恢复006最终源码，保留业务数据库和用户数据；不通过reset/删除数据回滚。
