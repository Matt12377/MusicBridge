# MBRS-007 正式只读 R1

结论：需修订，0 个新增 P1，3 个 P2。先修具体入口/恢复缺口，再以新冻结进行最后 R2；不扩第三轮。此轮没有运行构建、产品测试或真实服务，发现依据冻结源码数据流，未把静态推演称为已执行 RED。

源码根：`/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-mbrs007-4w1zusen/checkout`。base/HEAD `b464dd2066346121a26824da516969b726f0cfe0`，分支 `codex/mbrs-007-queue-prefetch-control`。FREEZE_01 声明 STOPPED/inflight=false，2026-10-06T09:43:05.931444Z；66/66 bytes+SHA256 匹配。freeze SHA256 `7966a8247648716c3fc0e17abe46d5dd5b0891cb47fc67c7b21d0ee1ccd17709`。Root 的文档/Gate 仍在更新，不将它们未填中间计数当产品缺陷。

## P2-1：稳定 entry 在等待执行时降为 index，可错播重排后的另一条目

精确位置：`packages/bridge-core/src/application/bridge-controller.ts:755–757`、`:1482–1489`、`:2668–2675`。

新 playQueueEntry 在受理时一次核 queueId/revision，然后将 entryId 转为 index 交给旧 playQueueIndex。无 native context 时 acceptedTarget 为 undefined；等待 playbackCommandTail 后才从 this.queue[index] 取目标。并行编辑的 ACK 可以先将 queue 安装为重排/删除后的列表（:769–770），而 queueContextGeneration 没变，新命令也不重核 queue/revision/member。因此受理 B 的稳定 entry 请求可能读取同槽 C，随后停止/播放 C。新 Renderer 已优先走该入口（usePlaybackSession.ts:902–903），是实际公开链缺陷。

修复边界：保留旧数字 index 接口的既有语义，专门为稳定 entry 命令捕获并在实际执行、stop 与保存 await 后重核 queueId/revision/entry membership；过期明确拒绝，或仅在明确定义的语义下跟随同一 entry，不能读相同 index 的不同对象。有效回归：held playback tail → 接受 B entry → REORDER/REMOVE ACK → 放行，必须零 C 派发；另测正在 stop/save 时的成员失效。现有 controller-queue 测了提交前已过期 revision，未覆盖该等待交错。

## P2-2：恢复本地队列绕过 legacy 的本地播放协议限制

精确位置：`packages/bridge-core/src/runtime.ts:1309–1312`、`:1371–1382`；Controller `:712–716`、`:755–757`、`:893–916`。既有约定：`docs/postrust/MBRS-006/API_BEHAVIOR_MAPPING.md:7` 与 `test/mbrs006/runtime-local.test.ts:11–22` 明确 legacy 实际入口 unsupported/零 capture/send，compact-v1 才支持 local。

新 runtime.playbackPlayQueueEntry 无协议核验，而相邻 queueLocalEdition/playLocal 仍强制 compact-v1。Boot 会恢复合法本地 sourceSnapshot 到 Controller；legacy 调用新具名 entry（或旧 index/navigation）可直接进入 startLocalItem 捕获并派发。这条路由以前没有恢复本地逻辑条目，现在实际连通；不会经过 guarded playbackPlayLocal。

修复边界：把本地 route 的协议能力授权放在所有实际本地 entry 启动/准备可达的共同边界，不能仅再加一个新 wrapper 让旧 index/next/previous 留旁路；旧云/native 继续兼容。有效回归：实际 legacy runtime load 合法本地队列，恢复 idle 零捕获；entry/index/next/previous 对本地目标明确拒绝、零 Owner capture/FD/SDK，cloud/native 正常；compact 相同路径成功。本轮未执行该 probe，旧 runtime-local 仅测直接 playLocal，不足覆盖恢复后入口。

## P2-3：恢复后的整发行条目丢明确 edition 版本，且不重核已保存 edition revision

精确位置：Controller `:712–716`、`:844–850`、`:924`；`packages/bridge-core/src/application/mb-queue.ts:6–7`；`packages/bridge-core/src/collection/local-source-tickets.ts:31–33`；`packages/contracts/src/mb-queue.ts:8`。

存储的 local source 保留 edition.id/revision，但 restoreLogicalQueue 只安装 logicalSource/local 身份，没有恢复 item.edition；startLocalItem 只从 item.edition.edition 注入 metadata.version。Owner capture 的 metadata 自身仅含 title/artists/album。因此整发行保存→重启→显式点播会丢失先前明确发行版本，现有 assertLogicalLocalFacts 也没有核已保存 edition ID/revision。冷启前 edition test 的 version 正例不能证明恢复后版本保持。

修复边界：显式重解析时由唯一 Owner 按已保存 edition ID/revision 重核并补入明确版本；变化/移除需明确结果，不靠标题猜测，不自动更新旧逻辑 snapshot。有效回归：真实 SQLite save/cold reopen → Controller restore → 显式播放，SDK metadata 与公开 currentTrack 保持已核 edition.version；edition revision 改变/移除时拒绝旧资格或按冻结的明确复核流程处理，零错误版本派发。

## 其余定点核验与证据边界

- 两固定 lane 的历史 owner 数有界，各自 attempt；NEXT currentness 认 item/target/fence，promotion 保留 B lease/ticket/attempt。实际 close 完成后才 busy=false（Controller:834–842），未因 close 意图提前复用。PREPARED 30s 分支重新捕获、不借 A 会话；FD8/Owner票据16/请求回执256未扩大。
- 新组实际测试了 ACTIVE+NEXT 并存、A HTTP 字节继续、超过16次顺序轮转仅2 owner、NEXT真正 FileHandle.read 阻塞后取消/quiet、晚 capture 的 unpair、自然结束/重复旧终态、控制只作用当前、source selection 修改但 fileRevision 不变的拒绝、两个 local APPEND ACK 串行、Stop晚 ACK 先安装已提交逻辑而不晚派发。
- sourceSnapshot 的 track/asset/root/sourceRoot/file/root/location/selection/segment逐项对捕获核验（Controller:844–850）；固定观察 signature/FD与不可逆票据沿005/006保留。新显式版本恢复缺口另列P2-3。
- closed Owner DTO、独立5000/16MiB预算、单save/load、schema32→33、CAS、old dataset NEEDS_REVIEW与逻辑坏row UNAVAILABLE保原件、备份严格内容验证均有实际 SQLite/Worker 有限证据。private load/save未暴露Renderer通用dispatch；Main/preload闭合具名参数与回执校验有效。
- 发行5000/5001、active盘轨排序、旧公开200 API、CUE三动作零副作用 unsupported、新local/native显式混排均有实际组。现存网易云回归结果独立记录；不把同线程 fixture 中的受控 Owner port称为全链真实 Worker，独立 owner-queue组确实运行Worker/SQLite。
- 新“重连零自动派发”case 实际执行 unpair，未实际 re-pair；同NEXT存在的UNKNOWN、late open/register两处await、每个revision变更也未逐一新枚举。旧006 UNKNOWN/旧A/目标ABA保留回归，当前代码未因此另记P2；主控/写作者可把必要受影响行为纳入集中修复验证，不能把未执行交错称已测。

## writer 原件结果

全部10个 result/log 哈希核验一致、退出0；5个TAP完整终态与manifest一致，无skip/cancel/todo：Core新31/31、context回归184/184、schema回归178/178、contracts新2/2、Desktop新2+旧preload9=11/11。新行为合计35，不把184/178或Root待运行53文件组累计为不重叠总数。Core build、Core含test types、metadata bundle、Desktop types、cycles各自已有writer退出0记录；此审查不重跑，不代替Root新fresh Gate。

具体日志及哈希/冻结路径全收进 `BOUNDARY_R1_IDENTITY.json`。git diff --check 静态检查退出0。源码冻结候选尚未提交，不能把base SHA 当实现提交身份。

## 原11AT责任

AT02/03/07/08/09/10/11可由上述受控软件行为分别形成证据，但本轮存在入口/恢复缺口，不能签最终软件PASS。AT01/04真实Roon排序与逐格式控制、AT05同格式静音/丢样/重复测量、AT06跨格式间隔与设备重锁均 NOT_TESTED。AT09真实外部接管/重连及AT11真实控制结果另列，合成SDK回报不能代签。CUE精确片段仍unsupported；顺序提交不是gapless。真实账号/Roon/LAN/NAS/audio/普通App/Owner、003新规模均未运行。
