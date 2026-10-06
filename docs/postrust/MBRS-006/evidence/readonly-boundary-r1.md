# MBRS-006 正式只读 R1

结果：**CHANGES_REQUIRED**。本审查新增3项 P2；主控已确认的另一路 shutdown P1 作为关联项纳入，合计 **4个根因（1 P1 + 3 P2）**，没有重复计算 shutdown 根因。修正后等新冻结候选进入正式 R2，最多两轮。

审查身份：工作树 `/Volumes/LifeWeave/Developer/CommandLine/worktrees/musicbridge-mbrs-006-local-audio-input`，base/当前提交 `cce8594f4b6e9872afd576bb1b032f526c93af72`。开始时实际逐项核 `writer/FREEZE_01.json` 的52文件，零哈希差异；manifest SHA256 `5d181466804161973a6a31ab9af643e90f75409108230f3f435b819ef89926a4`。补充 FREEZE_02 的旧52哈希保持，新添旧合同测试一文件；只改原case兼容期待，不加case，58/58日志及哈希已只读核。源码行号以下均为 R1冻结版本；Root随后授权唯一writer修正，不将修正途中状态算已通过。

## P2：本地三动作遗留旧 native 分页上下文

`packages/bridge-core/src/application/bridge-controller.ts:673–700` 的 playLocal，特别691–694：PLAY_NOW只stopActive然后替换queue，没有像原 replaceQueue/replaceRoonQueue那样调用 cancelQueueContext；APPEND/PLAY_NEXT直接applyQueueEdit，绕开 editContextQueue 的分页物化与排队准入。

触发：先用既有 replaceRoonContext 建立未读完的 native 上下文，再点本地 PLAY_NOW。旧 queueContext、before/after 游标、在途read/lease仍关联新本地队列。旧expandQueueContext返回可继续插入native项；next/previous在1161/1181优先 navigateQueueContext而非新本地队列。用户的本地新意图会被旧native上下文重新控制。原 cancelQueueContext:821–831已提供取消/代际/release接点，replaceRoonQueue:993/replaceQueue:1028可作复用参照。

最小修复与有效验证：PLAY_NOW退休旧context及pending context并阻止迟到页提交；APPEND/PLAY_NEXT复用现有context编辑/物化语义和容量/意图guard，避免第二队列。测试需真实原Controller native上下文→本地三动作与迟到page，不能只测无context空队列。对应原AT-09/10/11。

## P2：确定终态清资源后仍出版本地 Playing

`roon/adapter.ts:909–914` StoppedUser、`:924–928` MediaError只走通用terminal，未传本地确定终态；`bridge-controller.ts:488–499` 清资源再设置idle/error，`:2314–2335` clearActiveResources不更新/清localObservation。startLocalItem:771–775的预派发异常只dispose/throw，亦无FAILED/CANCELLED投影。

触发：本地已Playing，SDK回MediaError；terminal排队完成后FD/ticket已收口，公开 snapshot.state=error且无source/currentTrack，但leaf仍 phase=PLAYING、ownership=MB_OWNED、error_code=null。StoppedUser/主动stop可同样残留Playing；FD准备失败仍停在PREPARING。这使机器可读本地状态继续宣称已播放，与确定观察相矛盾。不是HTTP完成推断不足，也不是UNKNOWN晚回报问题。

最小修复与有效验证：同attempt确定终态在cleanup前投影有限FAILED/ENDED/CANCELLED及适当ownership/error_code；旧A不得改B。仅递交回报丢失保UNKNOWN。补 actual Controller Playing→MediaError/StoppedUser、主动取消和prepare失败投影；验证资源quiet及公开validator接受一致状态。对应原AT-03/06/11。

## P2：Zone/group恢复同指纹会复活旧捕获

`roon/adapter.ts:704–709` captureLocalTarget只捕获connectionEpoch与当前 `[zone_id, outputs排序]` 指纹，isCurrent比较当前相等；connectionEpoch仅在pair/unpair增，Zone/group结构转换没有单调epoch。`bridge-controller.ts:681–688` 首个Owner.capture存在await；此时尚无activePlayback，`:1444` syncRoonTransportState先return，runtime同步通知不能退休这个旧target。

触发：延迟Owner.capture，Zone删除→同ID/outputs重加，或组G1→G2→G1。旧target.isCurrent由false回true，晚capture可继续替换queue/begin_session。对已Playing目标变化，runtime确有同步失效，不把所有路径误报成250ms轮询；缺口是尚未激活/排队captured target的ABA。

最小修复与有效验证：绑定不可逆单调selected Zone/group结构代际；真正selected目标消失、变组/变Zone时增长，普通进度/state或无关Zone变化不增长。补延迟capture下delete/readd、group change/restore，旧意图SDK零发送，重新显式请求可捕获新代际。对应原AT-06/07软件部分。

## 关联 P1：重复shutdown短路绕过已有quiet flight

另一路正式R1及Root已确认，**不重复发现**：`runtime.ts:1165–1168` 用shutdownStarted布尔值对二次shutdown立即return；`utility-main.ts:627–632` Owner fatal等待这次返回后exit72。若第一次正常shutdown仍阻塞在真实FD/IO join，第二次fatal即获resolve并退出，破坏先封→join→退出合同。Root已授权共享同一shutdown Promise及阻塞IO/并发fatal RED→GREEN修复。默认Node Owner受影响，Rust OFF不构成豁免。对应原AT-08/06。修复证明归正式R2。

## 已核边界与本轮证据限制

Main/preload实际九字段闭合集经localLibrary:request→localCatalog.prepare；隐藏键/私有locator字段发送前拒绝。utility-main在通用dataset路由前送同一Controller；实际runtime legacy在capture/send前unsupported。compact-v1身份、队列/stamp/snapshot validator和Renderer显式来源匹配已接线；预调查指出的云收藏/云歌词/最近数字重播问题已修，当前local没有sidecar歌词，明确unavailable。

Owner使用原唯一SQLite连接与accepted扫描signature，005强制observation/expectedSignature/固定FD未放宽。私有16字节SAB及短claim、最终COMMIT资格检查、已确认ROLLBACK后事务外有限quiet均有实际源码与受控Worker测试；票据不会被revalidate续活。实际SDK core_id来自锁定node-roon-api/core.js:5，TS私有类型已补；公开target不是权威。UNKNOWN保留独立attempt，晚SessionBegan/Playing调和本attempt；旧SDKgeneration拒迟到A；SessionEnded本地不自动下一首，HTTPdone不推进。stop仅end自有AudioInput session，不新增全局Transport stop。

Gate脚本声明有限总360秒/每阶段180秒、完整TAP计数、fresh两包编译+worker bundle及类型、声明输入和28fresh输出绑定，复用已有离线runner辅助；workflow只在非report-only运行。Scope正在冻结，不以未填数本身制造产品缺陷。最终Gate是否通过由Root新候选证据确认。

本轮没有执行构建或产品测试，只读检查writer记录的11项命令日志+合同补充日志，其SHA256均与收据匹配；TAP计数详见R1_IDENTITY。记录的新Core29+contracts2+Desktop3=34、旧定向Core313及Desktop组合57均为writer当时命令范围，不冒称后续修复覆盖或Root Gate数量。没有真实Roon、音频、LAN、20样本、003规模或Owner验收。原live AT-01/04/07保持NOT_RUN，软件故障测试不改变其kind。3个P2均已交Root与唯一writer，无额外正式轮次。
