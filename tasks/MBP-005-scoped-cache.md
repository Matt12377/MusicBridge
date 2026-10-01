# MBP-005：作用域页缓存、歌单快照与渐进搜索

Owner已授权连续实施。基线a0c9cd7c1030c380263fa4394f73c5b802ec5f23，分支codex/mbp-005-scoped-cache。006本地完整Gate通过，报告已push且远端HEAD一致；此合同与文件所有权现在冻结并开始实施。技术栈、视觉、业务数据与真实账号/设备边界保持。

## 最小公开合同

- PlaylistDetail新增response-only optional snapshotVersion UUID。只来自严格完整header/ordered IDs base。完整有序IDs和所有已公开header字段组成版本事实。TTL命中保持版本；真实重读若与仍受预算保留的last-good base逐项完全相同可复用UUID，变化/无可比较base则生成新UUID。比较仅在真实base采样提交处，不在每页/tick；不可按count/title猜同版本。它证明header/成员顺序的本地完整采样，不证明song_detail跨请求是上游事务。无full IDs旧fallback不给强版本，损坏字段不可降级成空完整列表。
- LibraryReadRequest、Ipc.LibraryReadContext、LibraryReadLifetime新增optional cacheMode:'reload'，只允许此literal与read allowlist。默认旧请求字节不变；不改9个Browse payload、PageRequest、写命令或scope setter。
- Main broker严格允许额外字段，解析context并传Supervisor fourth read options；Supervisor复制mode进入Utility request。Registry key加入mode/default，owned ALS携带mode。同payload normal/reload不能合并，reload同意图可合并；deadline/独立subscriber/cancel/实际未返回预算不改。
- Renderer libraryReadScope read options加入cacheMode，具名legacy fallback只调用一次；缺协议旧环境的reload没有等价强制刷新保证，报告保留兼容边界，不能捕获新协议失败后自动重放。
- Public Roon options受信getPageCacheScope():string由runtime闭包注入，含service/reference scope/Zone/credential epoch与shutdown。不得在public library构造阶段执行尚未初始化的controller闭包。

## 预算与材质

Core Roon128页/16MiB/单页1MiB；普通TTL15s、search5s、惰性保留最长5min。命中须同步origin currentness/注册current，过期/reload走真实targeted UI origin refresh；不能全局撤销owned，不能touch权限TTL。超缓存预算合法页正常返回但不缓存。
Netease base32条/16MiB/单条4MiB、account1条、TTL30s。header/page逻辑flight32、subscriber256、共享fixed10s；真实Proxy32 read与8 other直到actual settlement不提前归还。完整IDs浏览不套5000播放上限，至少6000尾页夹具；超过本缓存准入预算明确失败、不截断。
Renderer生命周期pool64单窗口页/8MiB/dataset最多8页、fresh30s/最长可重用5min；无Promise/IPC/第二状态owner，peek失败不续TTL；超budget响应交UI但不缓存。私有scope epoch保守账户事件轮转，不公开真实账户id。

允许既有白名单public artworkUrl作为安全metadata保留；禁止音频或签名URL、Cookie、Token及raw responses进入缓存/日志/Renderer。图片binary资源预算为007，005不扩大。

## 文件所有权

Root独占Contracts library/read/ipc/validator及新增test，Main library-read-ipc/core-supervisor，Core shared lifetime/registry/utility-main/runtime与mode接线tests，Renderer libraryReadScope及薄transport test，project/task/report。三个作者不能改这些文件，不跑共享build/typecheck/pretest。
Roon作者独占library.ts/public-library.ts及可选局部cache helper、相关新旧Roon tests；只增加最小readonly getReadCacheStamp selector与最后参数RoonBrowseReadOptions{refresh?:true}。页cache不能独立管理SDKflight。
Netease作者独占client.ts/parse.ts/types.ts及private helper、相关new/old tests；重读header真实完整采样、按选中IDs还原顺序，flight自己可信ALS所有权，不能复用first subscriber ALS Promise或脱离read预算。
Renderer作者独占App.vue、纯值page helper、playlist version helper、query/collection/browse/NET/journey owners、SearchEntities、LibraryRefreshNotice及其tests。没有TrackTable occurrence、Session/006 reducer或样式重设计；默认去重120和5000播放容量原合同保留。App三个getPlaylist→tracks loader同version验证，换版只停止后续追加、保持当前播放。

## 搜索与恢复

五分区独立发布/加载/错误；传统loader load最终summary及same-query Promise/fresh缓存默认合同保留，不把allSettled当UI发布barrier。新query立刻清旧显示并cancel；背景刷新失败继续显示旧当前identity内容且可见retry。旧Roon epoch/有无混合拒拼，只一次可见rebase；owned当前音频不受UI刷新影响。
Playlist非空版本精确匹配才能续强snapshot；不同版本或有/无版本混合停止旧追加/有界rebase。双方都缺版本保留旧接口原分页append与后台队列合同，并明确提示未能确认整份歌单版本；不把legacy分页当强一致快照，不按count/title猜版本。这样不把旧Core或旧API长歌单静默削成一页，1197与默认去重120原保护保留。三个后台播放loader同一策略，换版/混合只停后续追加，不restart音频。

作者冻结交付需实际RED/GREEN、原保护说明、严格production及test typecheck、源码manifest和退出码。Root固定后串行原verify/mockElectron/fullE2E/statics，不缩范围不新增skip。005需要时独立复审最多两轮，指定真实假边界，不进入真实账号/Roon/音频。

## 必采校准

版本UUID可在真实重读且所有header/完整有序IDs与保留base逐项相同时复用，不能只因TTL到期制造变化；若数据变或旧base已丢则new UUID。缺版本legacy纯链继续原合同并显示无法核实一致性的提示；有版本与无版本混合拒拼。这两个决定优先于三个只读候选文档中的每采样new UUID/无版本替换窗口建议。仍严格保持新Core损坏full IDs不能伪空/伪强版本。

一次背景refresh或显式refresh的Roon reader，只在该操作第一次实际读中附reload；readRoonDatasetPage若见new epoch重读0，使用普通新origin读取，不能在同rebase closure再次reload造成第二次换代。rebase有/无版本和反复换代保护仍原样，最多一次自动。正在失效的旧normal flight若由另一订阅者保持，不伪成功；按原owner/固定期限等待或明确失败/可见重试，不撤别人的取消权。

## 目标刷新会话校准

反复刷新若每次旋转SDK key，会耗尽既有4个alias，使仍保留的父引用第5次刷新失效。允许仅在原UI session尾、已静止且实际未返回RPC为0时复用其SDK key，reset checkpoints/path/count并真实pop_all重采样，同时换本地cache/sourceEpoch。取消、超时、失效或仍有实际callback未返回的session继续原retirement/physical预算。owned独立session、action generation与权限TTL不变；连续6次刷新与旧未返回保护须绑定行为验证。此校准不宣称上游事务snapshot。
