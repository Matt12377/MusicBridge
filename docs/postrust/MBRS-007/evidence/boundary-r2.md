# MBRS-007 最后正式 R2

R1 三个 P2 已闭合；本轮0新增 P1，剩余1个 P2：cursor COMMIT ACK 与 Stop 交错后，公开逻辑cursor未安装，与durable记录不同。没有第三轮；主控依据以下精确边界集中处理并以自己的最终Gate收口。此轮只读源码/已存日志，未运行产品测试、构建或真实服务。

源码根 `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-mbrs007-4w1zusen/checkout`，base/HEAD `b464dd2066346121a26824da516969b726f0cfe0`。FREEZE_02 SHA256与指定 `e732970717411338a7b7ea5b8a8debd337559ae61e7702734a769928838f7b7f` 一致，69/69 bytes与SHA256匹配；STOPPED/inflight=false，冻结2026-10-06T10:07:39.972147Z。对FREEZE_01为5条修改+3条新增，原61条不变；身份及逐条结果见 BOUNDARY_R2_IDENTITY.json。

## 三项R1闭合

1. **稳定entry不降index：已解决。** Controller:758–772独立捕获QueueItem、queueId、revision、context代次，实际playback tail执行/stop await/本次cursor CAS后重核；只认本次revision+1。准备过程queueAdmission进入guardOwner/localCurrent与真正SDK dispatch（:830–833,2642–2655）；捕获await后修改身份时FD prepare/SDK被拒。正常启动完成退休admission（:2094–2096），不使后续合法编辑误撤当前流。legacy数字index语义保留。r1-regressions.test.ts held REORDER/REMOVE、stop wait、capture wait真实Controller行为覆盖；旧候选对应3项有效RED，最终GREEN。
2. **legacy共同本地route限制：已解决。** runtime.ts:436注入实际publisher协议权威；Controller:869–870、881–885、895、907–909、924–927及localCurrent共同核compact。实际legacy runtime恢复后entry/index/next/previous均零capture/register/SDK，compact同组完成真实SQLite、固定FD及loopback Gateway注册与受控Adapter会话回报。runtime-queue-protocol.test.ts两case确实走createBridgeRuntime，非mock wrapper判空；旧runtime-local云入口与native/context回归保留。runtime RED中legacy确已走到FD注册，compact首次准备错误不假称有效RED；最终2/2与closure通过。
3. **恢复edition版本：已解决。** Controller:872–879通过唯一Owner现有localCatalog.edition只读请求，isAlbumEdition闭合校验+已保存ID/revision相等才安装明确title/edition。显式启动与仅紧邻NEXT都重取（:907,:927）；metadata.version从明确edition而来（:955）。真实SQLite关开+新Controller restore→显式entry正例证明公开currentTrack/queue.edition及Adapter metadata保持“日本版 混音”；Boot仍idle/零FD/SDK。changed/missing负例是受控Owner回报不一致/不可用，零capture/FD/SDK；未伪称当前不存在的真实update/removeEdition写API。旧候选该3项RED，修正6项GREEN并入最终组。

## 剩余P2：自己的cursor ACK遇Stop未安装对应公开逻辑cursor

精确位置：`packages/bridge-core/src/application/bridge-controller.ts:768–771`、`:729–735`、`:2063–2071`；新增case `packages/bridge-core/test/mbrs007/r1-regressions.test.ts:52–58`。

playQueueEntry先保存currentEntryId为目标B；ACK后persistQueue只更新logicalRevision/persistence，queueIndex要等startQueueIndex:2071才更新。若Stop在已COMMIT但ACK等待时递增commandEpoch，ACK会被接收、revision被安装，但随后guardCommand拒绝进入startQueueIndex。结果durable.currentEntryId=B，公开queue.index仍A或-1，而revision已是B cursor那次COMMIT的revision。这是可定位的数据投影差异，SDK封口本身正确；不能升级为晚派发问题。

最小处理：仅在确认本次cursor ACK成功且仍能对应当前队列的条件下，于意图guard前安装其inactive逻辑cursor/投影；之后Stop/target/entry围栏仍禁止capture/register/SDK。不能把未知/失败ACK当成功，不能因安装cursor自动启动。扩展同一现有Stop交错case：旧候选在初始queue.index=-1，保存后saved.currentEntryId是首entry；释放ACK后核公开所选entryId==saved.currentEntryId且revision相同、状态idle、零capture/FD/SDK。这是R1修复边界尚留的cursor安装，主控不必扩大正式审查轮次。

## 定点保留核验

- 只增Controller/runtime准入与edition只读重取，无Owner表/schema/hash、源锁、FD/票据上限漂移。双lane/attempt/promotion、实际quiet后复用、PREPARED30s仍保持原R1已核数据流。
- 原unpair测试已补pair→Subscribed/selectZone→Controller同步与tick，随后begin/play计数不增（controller-queue.test.ts:102–106）；确实受控重新配对回报，不是真实Roon。自然终态/旧A/UNKNOWN与target不可逆epoch沿006回归，不恢复global stop。
- Root scope尚未填完整计数，不作为产品缺陷；contracts/Desktop冻结内容本轮无变化。主控仍需自己的fresh编译、53文件旧回归和完整Gate；本审查不与dist竞争。

## 已存证据

R1_CHECK_LEDGER全部20个result/log哈希及完整TAP已核一致。最终新Core41/41、closure207/207=新41+旧166，均exit0、fail/cancel/skip/todo=0；不能再把独立166或重复41累计。Core含test types/build/cycles最新closure各退出0。有效stable/edition旧候选RED6/6失败→同caseGREEN6/6，新增cursorStop/captureREORDER补充后最终组8项通过。runtime legacyRED与compact夹具准备错误分列，最终2项通过。Root先前contracts66/Desktop123不是本轮新执行结果。git diff --check静态退出0。

真实AT01/04的Roon排序/逐格式控制、AT05同格式静音/丢样/重复、AT06跨格式间隔/设备重锁、真实接管/重连与AT11实际控制结果仍未测；合成SDK、HTTP原字节、FD quiet不代签gapless或Owner。CUE片段继续unsupported，不隐式整文件。账号/LAN/NAS/audio/普通App/Owner/移动MBM/003新规模均未运行。

主控最终处置：Root已确认cursor属于ACK已持久逻辑状态，本P2需最小修订；将授权唯一writer补同case public/saved cursor一致性RED→GREEN与inactive cursor安装，再由Root独立定点复核/Gate。本报告不签总PASS，不启动第三正式轮。
