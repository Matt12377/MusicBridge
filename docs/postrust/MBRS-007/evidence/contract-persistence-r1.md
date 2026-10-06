# MBRS-007 合同与持久化正式 R1

结论：**CHANGES_REQUIRED，1 个实际 P2，未发现本审查范围内新增 P1**。这不是产品通过或真实播放验收结论。Root 将另一个审查角色的发现合并修复，本报告不代替其证据。

## 身份和只读边界

树为 `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-mbrs007-4w1zusen/checkout`，分支 `codex/mbrs-007-queue-prefetch-control`，HEAD/base 为 `b464dd2066346121a26824da516969b726f0cfe0`。writer 的 `FREEZE_01.json` 于 2026-10-06 09:43:05.931444 UTC 冻结，STOPPED、inflight:false。报告落盘前重新逐字节核对 66/66 路径，bytes/SHA256 全部吻合；冻结清单 SHA256 为 `7966a8247648716c3fc0e17abe46d5dd5b0891cb47fc67c7b21d0ee1ccd17709`。精确文件、日志与 Gate 版本见同目录 `CONTRACT_PERSISTENCE_R1_IDENTITY.json`。

本轮仅静态读源码、测试、原任务/交接和已有日志、核验哈希；没有改产品、测试、台账或 Gate，没有构建、运行测试、重放真实扫描、账号、Roon 或音频。外置这两份审查文件是唯一新增写入。

## P2：明确版本事实在冷恢复后丢失

路径 `packages/bridge-core/src/application/bridge-controller.ts:713–714` 从保存的 local_file source 恢复 entry/local identity，却没有重建 `item.edition`。持久 DTO `packages/contracts/src/mb-queue.ts:9` 合理地只保存 edition ID/revision；播放元数据在 Controller 第 924 行仅通过 `item.edition?.edition` 注入 `version`。capture 的 track metadata 没有同版的明确 edition 文本。因此当次专辑播放展示的明确版，冷恢复后用户再次播放时丢失；队列投影的 edition 也丢失。ID/revision 没有解决这个显示事实链路。

可复现路径：创建 title=`1989`、edition=`日本版 混音` 的 edition 并关联曲目 → `queueLocalEdition(APPEND)` 保存 → 用同一数据集依赖构造新 Controller → `restoreLogicalQueue()` → 检查队列投影并由用户显式 `playQueueEntry(queueId, expectedRevision, entryId)` → 受控 SessionBegan 后检查 currentTrack.version。首次当次路径有 `日本版 混音`，冷恢复路径为 undefined。这里是静态复现描述，没有自跑测试。已有 edition 测试只覆盖当次版本，冷恢复测试未断言版本，31/31 绿灯不能覆盖此缺口。

最小建议：沿同一 SQLite Owner 已有 edition ID/revision 读取、核对确切同版事实，再用于投影和显式播放元数据；可复用 materializeMBEdition 或现有只读 catalog 接缝。不要为此保存任意显示元数据，不打开 FD、不建立 ticket、不调用 SDK、不启动播放。edition 缺失或 revision 不匹配必须明确需要重验，不能猜版本或采用新版文本。补有明确版本的冷恢复正例、同版修订变化负例与恢复零 capture/FD/SDK 断言，再冻结供 R2。

## 合同、Owner 和提交闭合

闭合 DTO 限制 5000 条、UTF-8 序列化 16MiB、唯一稳定 entryId、有限正 revision 和 exact expectedRevision+1；provider trackId 使用实际公开边界的至多 128 位数字字符串，不做 Number 转换。最大合法 provider ID 的 5000 项有测试；超过项数/预算、私有字段、URL、非数字、重复 ID 都被拒绝。entry_id 与运行期 native queue_id 分离；native 持久 source 只留下 UNSUPPORTED_NATIVE_RESTORE，不保存 oid/reference。没有 secret、临时媒体 URL、lane、SAB、FD 或票据进入逻辑 row。

队列通过普通 Owner Worker 的结构化消息与该 DTO 字节预算传输，没有扩大 006 私有 64KiB 帧，也没有第二个 SQLite Owner。客户端分别只有一个 save、一个 load 在途；prepare identity、dataset、requestId/operation、epoch/current、closing/fatal 都有围栏。Worker 在既有 repository 同连接同步执行 load/save，没有事务内 await。save 使用 BEGIN IMMEDIATE → 读取校验旧 row → CAS → 写入 → COMMIT。COMMIT 不确定或 ROLLBACK 失败进入 fatal/UNKNOWN，不盲重试；失败不会先安装候选队列或发布伪成功。

合法 foreign row 只返回 NEEDS_REVIEW 的 queueId/revision 头，保留原始 bytes，不返回全部旧 entries。新用户意图用新 queueId、精确旧 revision 替换。逻辑 row 损坏返回 UNAVAILABLE 且无 revision，后续 save 仍校验旧 row并拒绝覆盖；坏 DDL、表缺失及其他数据库 I/O 继续 fatal。冷恢复保持 idle，native restore 明确不支持，local 必须用户动作再解析；启动路径无 capture/FD/SDK。

## schema 与备份恢复

schema32→33 只新增严格单槽 mb_playback_queue。repository、backup-index、restore-database、restore-dataset-runtime 的最大 schema 一致到 33；future-schema 负例从 33 改为 34，仍拒绝。原旧表内容比较仅排除合法新增 queue 表；非空 catalog 的旧 103 表身份、类型/单元格比较和 cold reopen 负例仍在，没有用变更号掩盖数据丢失。

启动校验允许逻辑 row 损坏由 load 转成 UNAVAILABLE，但仍验证 DDL；备份/恢复严格内容校验拒绝损坏逻辑 row。dataset 恢复不会改写队列来源 bytes，foreign 数据集继续受头部隔离。5000 项真实 Worker save/load/cold restart、schema 迁移、CAS、rollback、foreign 替换、corrupt row 和坏 DDL 均有可归因测试。

## 排序、预备、接线和回归

同版专辑 materialize 读取 active 链接，按数字盘号/轨号/sequence/ID 排序，内部限 5001 后明确拒绝超 5000；公开 200 读取预算保持。损坏/不可播放本地曲目和不支持 segment 明确失败，不暗中跳曲。edition source 快照含 track/asset/root/selection/revision，用户动作重新校验；明确版本冷恢复是上面的缺陷。

Controller 使用两个有限稳定 lane，NEXT 的 lease 与 A 区分；测试覆盖 30 秒预备过期重 capture、promotion 身份、实际阻塞 I/O quiet 后复用、超过 16 次顺序播放、late 回报/外部 takeover、save ACK 阻塞和显式混排。三个 queue IPC 经 main payload guard、preload scoped invoke 和闭合响应 guard 接入；Renderer 使用稳定 entryId 作为操作身份，已有网易云/native、播放上下文、旧 preload 回归保留。这里只说明接线与被覆盖范围，不声称另一角色报告的 REORDER/REMOVE 竞态或 compact 兼容缺口已闭合。

## 已有证据核验与 Gate 静态边界

读取并核对 writer 的 result.json 与 output.log SHA256、退出码：Core 新行为 31/31、上下文 184/184、schema 回归 178/178、合同新行为 2/2、Desktop 11/11（2 新 queue client + 9 旧 preload）。日志均 fail/cancelled/skipped/todo 为 0；Core build/test types、fixed metadata worker bundle、Desktop types、cycles 的已有记录退出 0。详细命令、时间、日志哈希在身份 JSON；这些是 writer 已执行证据，不是审查者重跑结果。

Root Gate 静态读版本已单独绑定。强制旧回归清单 76 个；新 mbrs007 nested 测试递归发现，遗漏/重复/非法路径或包缺失拒绝。fresh 输出检查 44 个，绑定 003 两份真实严格 Reader/CUE 证据及 worker build 元数据；stage 子进程/输出预算、完整 TAP 与精确计数、source/HEAD/output 末端身份漂移均有拒绝条件。四组 scope 完成后对应 11 阶段、总 360 秒预算。审查读取时 scope 仍 implementationComplete:false/countsConfirmed:false、0 计数，依 Root 指示视为尚待填充的元数据；它目前不能准入通过，不是产品缺陷。Root 必须填确认计数并实际运行统一 fresh Gate 后再形成 Gate 结论，本报告未宣称它通过。

真实 Roon/LAN/音频/App/Owner、20 样本及新增 100k/300k 扫描仍 **NOT_RUN**。已有容量回归不升级为新规模真实扫描，受控 SDK/HTTP/Worker/SQLite 测试不升级为真实听感验收。
