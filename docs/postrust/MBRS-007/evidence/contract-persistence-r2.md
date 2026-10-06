# MBRS-007 合同与持久化最后正式 R2

结论：**CHANGES_REQUIRED，剩余 1 个实际 P2，未见新增 P1**。R1 明确 edition 冷恢复版本丢失 P2 已闭合；稳定 entry 派发资格与 compact 门禁修正有效，但 cursor COMMIT ACK 与 Stop 交错仍造成 durable/公开选择不一致。本报告撤回补充发现前写入的 PASS 草稿，不开启第三轮。Root 已决定在本轮最小修复，再用最终 Gate 取证；下述身份绑定修复前 FREEZE_02，不提前认证后续改动。

## 冻结身份

工作树 `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-mbrs007-4w1zusen/checkout`，branch `codex/mbrs-007-queue-prefetch-control`，HEAD/base `b464dd2066346121a26824da516969b726f0cfe0`。FREEZE_02 于 2026-10-06 10:07:39.972147 UTC 冻结，STOPPED/inflight:false；原件 SHA256 `e732970717411338a7b7ea5b8a8debd337559ae61e7702734a769928838f7b7f`。开始及落盘前逐字节核对 69/69 路径均吻合；相对 R1 为 61 不变、5 修改、3 新路径。身份 JSON 包含全部文件和已有证据哈希。

仅读源码、测试及已有日志，没有构建、运行测试或 Gate；没有改仓库。此次只写两份外置审查文件。

## R1 版次 P2 闭合

`packages/bridge-core/src/application/bridge-controller.ts:872–879` 新 `resolveQueueEdition` 使用原 Owner `dispatch` 的闭合 `localCatalog.edition` 只读命令，payload 仅保存的 editionId；返回先经 `isAlbumEdition` 再严格核对保存 ID/revision，只复制明确 title/edition 形成内存投影。Owner 客户端原 envelope/IPC 验证及 Worker 同连接 catalog 读取不变，没有新修改 API、第二 Owner 或任意 SDK 字段。

`startLocalItem:927` 在用户实际播放准备时读取，Owner guard 在 await 两侧；`scheduleLocalNext:906` 仅紧邻 NEXT 预备时读取。`restoreLogicalQueue:706–719` 仍只加载逻辑 row，Boot 不全队列物化、不读版次、不 capture/开 FD/建 ticket/调用 SDK。持久 DTO 原哈希完全不变，edition 仍只有 ID/revision。读取失败、缺失或 revision 不一致返回 LOCAL_EDITION_NEEDS_REVALIDATION，不能采用新版文本或猜版本；成功后第 955 行把原明确 edition 注入 version。

新增 `r1-regressions.test.ts:30–50` 是真实 SQLite 文件关闭后重开、新 Controller 恢复，用户点击后受控 Adapter 收到 `日本版 混音`，currentTrack.version 与 queue.edition 同值；Boot idle、零新会话/FD。revision/missing 负例通过受控 Owner 读回，不伪造不存在的 update/removeEdition 产品 API，断言零 capture/FD/SDK。正例不是实际 Roon 硬件证据。

## 稳定 entry 与协议授权

`playQueueEntry:758–772` 受理时锁定对象、queueId/revision/context 代次，在命令等待、stop await、自己的 cursor CAS ACK 后重验，自己的 ACK 只接受一个精确 revision 增量。资格作为 `queueAdmission` 传入 startQueueIndex/guardOwner/localCurrent/ownerOptions，SDK `assertCurrent`、fence dispatch 和 onDispatch 共同检查，准备 await 期间的 REORDER/REMOVE 或 Stop 不能改投另一个 entry 或晚派发。实际启动完成后退休该准备资格，合法编辑不因旧 revision 永久切断正在播放的当前资源。

8 项集中行为测试覆盖 held playback tail 上 REORDER/REMOVE、stop await、edition 冷恢复正/两负例、真实 SQLite 已提交 cursor 而 ACK 等待时 Stop、capture await 时 REORDER ACK；都检查实际会话/发送或 FD 副作用，而不是只比较实现字段。

`runtime.ts:436` 用真实 publisher.getProtocol 的 compact-v1 权威注入 Controller。localRequest、startLocalItem、localCurrent 与 NEXT 共用该门禁；恢复队列经 entry/index/next/previous 不再绕过。runtime 两项测试用实际 runtime、真实 SQLite/fixed FD/loopback Gateway和受控 Adapter：legacy 四入口均拒绝且 capture/register/play 为 0，compact 对应入口成功并通过公开快照 validator。门禁限定 local 路径，没有扩大 native 冷恢复；旧云、native、上下文回归仍执行。协议在运行时固定，此结论不是 live AT。

## 剩余 P2：cursor 已提交后 Stop 使公开选择未安装

`packages/bridge-core/src/application/bridge-controller.ts:730–735` 的 persistQueue 将目标 B 的 entryId 作为 currentEntryId 提交，ACK 后推进 logicalRevision。`playQueueEntry:770` 随即执行 current()/guardCommand；如果 Stop 在 ACK 等待期间使 commandEpoch 失效，此处抛出，`startQueueIndex` 不再进入。queueIndex 只在后者第 2075 行设置，因此 durable currentEntryId 已为 B，而同一新 revision 的公开 queue.index 仍为 A 或 -1。SDK 零晚派发仍正确，但新的 durable 选择与公开选择不一致。已有 `r1-regressions.test.ts:52–57` 确实安排 SQLite 已提交/ACK 等待时 Stop，却只断言零 SDK/FD，未断言 cursor，因此绿色测试没有覆盖该差异。

静态复现：队列 A/B 当前为 A（或恢复后无活动选择），点击 B → SQLite cursor save 实际提交 B 但阻塞 ACK → Stop → 放行 ACK → 用户命令拒绝且零 SDK，读取 SQLite row 与公开 queue.index，两者选择不同。边界角色首先报告，Root 转交后本角色沿上述三个位置独立确认数据流；本角色没有运行新测试。

Root 已选最小处置：成功 ACK 后先安装 inactive 的逻辑 cursor，再检验 Stop/派发资格；保存选择不能产生 activePlayback/会话或自动播放，SDK guard 保持。扩充同一个有效 save-ACK Stop case 对 durable/public cursor、revision、idle、零 SDK/FD 的断言，并保留有效 RED→GREEN，再绑定修复后的最终 Gate。此处是已授权修复方案，尚非修复完成证据；Root 负责最后变更/冻结身份与 Gate，不要求第三轮审查。

## Owner、持久化与继承范围

R1 的合同、Owner client/worker/domain、mb-queue-store、schema33 repository 和三处 backup/restore 产品字节均在 61 个不变路径内。5000/16MiB、公共 provider 数字 ID、单 Owner/1save1load、CAS/dataset/epoch、UNKNOWN 不盲重试、foreign row 原 bytes 保留及 new queueId 精确旧 revision 替换、corrupt row UNAVAILABLE 无 revision/save 封闭、坏 DDL/I/O fatal、native 无 oid/reference、启动零自动播放政策没有漂移。双 lane、预备过期、实际 I/O quiet 后复用和 late 回报原测试仍在，新增 adapter pair helper 真正发受控 core_unpaired/core_paired 和 Zone 回调；不把重连当自动播放许可。旧 schema future 负例与数据完整性比较没有本轮再变。

## 证据身份与限制

19 条 R1_CHECK_LEDGER result/log 的 SHA256 与原件全部吻合，保留失败原件。stable-edition-red-03 为 6 项实际行为断言失败（含 undefined 与明确版本不同、缺失期待拒绝），对应 green-01 为同 6 项通过；最终新 Core 41/41 包含新增的 ACK/capture 竞态与 runtime 两项；behavior-closure 207/207 = 新 41 + 旧 166，fail/cancelled/skipped/todo 均 0。类型、Core build、cycles 的最终已有记录退出 0。

没有把 red01 root TSX 导入、red02 非规范 TMPDIR、fixture 类型/tick 故障算有效行为 RED。runtime-red-01 只证明 legacy 绕过准入到注册后的错误，compact 是准备失败；不称整组两个有效 RED。最终 runtime-green-02 为 2/2。日志是 writer 已执行证据，本审查未重跑；逐条命令、时间和 digest 见身份 JSON。

Root Gate/scope/test 另行记录读取哈希；本轮读取 scope 仍为计数尚未确认状态，依 Root 指令不当作产品缺陷，也未宣称 Gate 成功。Root 仍需填实际计数并完成统一 fresh 输出及受影响回归 Gate。

真实账号/Roon/LAN/NAS/音频/普通 App/Owner、20 样本与新增 100k/300k 仍 **NOT_RUN**。软件 compact 支持、合成 loopback 字节/SQLite/Worker 和受控 SDK 回调均不升级为真实音频、听感、gapless 或 live AT。
