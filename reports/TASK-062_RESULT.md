# TASK-062：归档内容对象与事务恢复基础

## 身份与结论

- 基线：`e785308b3ccf31cd01f4947f88c9942330b15d07`（TASK-061 最终状态）。
- 分支：`codex/task-062-archive-foundation`。
- 实现提交：`62a20a6db58c5a94a537f84032931e89da20a5b4`。
- 报告提交：包含本文件的独立提交；精确 SHA 写入下一状态锁定提交的 `project/STATUS.json`。
- 结论：本任务限定的 Core 归档事务基础本地自动验证通过。完整 V3、完整 Gate E、真实输出和 Owner 验收未完成。0 子代理；未 push、未合并 main、未发布。

## 实现

独立归档 Root 必须明确初始化，预览不写盘，并拒绝与源目录重叠、符号链接和目录身份变化。只读源完整复制、Hash/长度回读与音频容器或 JSON 解析之后，以同卷原子 no-replace 发布内容寻址对象；同 Hash 的不同角色/操作共享字节，已有对象不覆盖。

稳定 operation_id 依次经过 INTENT_WRITTEN、STAGED、VERIFIED、PROMOTED、DB_COMMITTED、FINALIZED；数据库可先保留无对象引用的 REQUESTED。私有 Intent 和公开谱系 Manifest 分开，目录有 owner/dev/ino 证据。schema 13 的对象、引用和阶段提交在同一 SQLite 事务完成，历史对象/引用不可改写。仅在 DB 已提交后清理本次已验证的暂存副本；失败半成品、内容对象和原件不自动删除。

STAGED 之后可在源执行目录离线时恢复；PROMOTED 之后只核验补交，不重读源。重复恢复不新增库存或实体记录。历史 FINALIZED 不替代当前完整性检查；对象缺失、变化、目录失效和撤权记录恢复要求。提交前取消不自动重放，提交后取消只能中止本次运行，恢复仍需完成已提交对象的收尾。

内核暂未开放 Renderer IPC；完整的执行/PREP/源谱系选择、原生授权确认、总体期限和实时撤权服务接线进入 TASK-063。不能把私有内核 API 或部分对象归档当作产品归档已完成。设计与限制见 [ADR-022](../docs/adr/ADR-022-recording-archive-transactions.md)。

## 新鲜验证

Node 22.23.2 / pnpm 10.17.1。实现包含 15 个代码/测试文件与 6 个控制/设计文件；明确路径暂存，未纳入运行产物。

| 验证 | 结果 | 退出码 |
|---|---|---|
| 最终完整 verify | Contracts 66、Core 678、Desktop 175；类型/测试/构建通过 | 0 |
| 归档聚焦 | 24/24；实际文件、SQLite 与阶段故障 | 0 |
| Security | 22/22 | 0 |
| Electron 生命周期 | 4/4 | 0 |
| Playwright | 49/49，显式启用固定原生转换器用例 | 0 |
| Control / Boundaries / Cycles | PASS，151 个源文件；Control 仅覆盖旧 WAVE-3 | 0 |
| 独立 Python | hashlib / wave / sqlite3 完整复核 | 0 |
| 分支/base/允许路径/暂存 diff | 21 文件范围一致；远端无对应分支 | 0 |

两次真实 Node 子进程在 PROMOTED 和 DB_COMMITTED 检查点收到 SIGKILL，随后冷连接恢复，未重新复制源。其他阶段用受控异常覆盖，五个中断点各重复恢复十次；这不是实体断电或实际外置磁盘拔除测试。

独立合成归档包含 2 份 WAV 与 1 份执行清单：3 对象、3 引用、1 操作；重复运行 10 次数量不变。A 面 396902 帧，B 面 132301 帧，均为 44100 Hz/stereo/16-bit；Hash、文件大小、数字零及 SQLite integrity/foreign-key 检查通过。源 Hash、inode、mtime、ctime 不变；实体副本仍为 reserved，没有录音完成状态。

本机完整证据：`reports/runtime/task-062-archive-foundation`。最终主日志为 `verify-eof-final.log`、`security-final.log`、`electron-final.log`、`e2e-final.log` 与控制检查日志；包含两轮 E2E 产物、独立复核脚本/回执和最终 Git blob 清单。未提交生成文件或合成私有目录。

## 失败记录与自查

缺少新 API 的首次失败只算接线 RED。随后行为 RED 发现并修复：DB_COMMITTED 前允许 Finalize、link 成功后暂存别名恢复、Root 撤权的错误记录，以及已提交取消无法收尾。失败日志原样保留。

最终整库首轮曾出现既有 CoreSupervisor 测试的 20ms 模拟启动期限与 setImmediate 调度竞争，Core 678 项通过、Desktop 174/175。只把该项测试改为可控时钟，生产超时未变；初次 mock clock 因 shutdown 时钟未恢复而取消，修正后该文件 13/13。独立短期限 core.ping 负例仍按预期 TIMEOUT 失败，未削弱超时断言。最终所有 Gate 已重跑通过。

暂存 diff 检查另发现新复用夹具末尾多余空行；仅规范化 EOF 后，再次完整 verify 通过。生产文件与最终 E2E 候选保持相同 Git blob，夹具的 EOF 前后身份单独记录。

先 SPEC 后 QUALITY 主代理自查通过；不是独立审查。未开放任意路径 IPC、未扩大网络或输出权限、未使用假录音完成状态；源码/库存保护和文件/数据库边界有行为验证。

## 后续与验收边界

本任务三提交之后，TASK-063 必须从最终状态锁定 HEAD 建立独立分支。精确最终 SHA 与下一分支基线记录在本机 `final-closeout.json`，并由 TASK-063 的 STATUS/base 再次锁定；不得从本实现提交跳接。

F-01 长期保留政策仍需 Owner 明确回复，不冻结正式 RecordingPlan/Attempt。成功事务暂存副本的收尾不代表已决定永久保留或失败产物清理政策。本阶段只验证支持硬链接/fsync 的本地文件系统，不宣称多应用实例共写或任意 NAS/FAT 支持。

归档桌面接线、正式预检和输出认证、录音状态机/确认、同一 Physical Copy 完成同步、完整备份/恢复、Replica、J-Card、参考目录/导入、Want List、全部 PRD 与真实 Gate A–E 均继续保留。TASK-047 真实歌词、跨 Renderer/应用重启 outbox、已有视觉 carryover 和 TASK-061 分发准入不自动关闭。自动验证与本地提交不构成 Owner 接受、GitHub 交付或公开发布。
