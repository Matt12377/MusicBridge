# TASK-072 开发进度

基线：`6323b3431ec7beeaba851155c062f9fae4bf41ea`。分支：`codex/task-072-recording-plan`。Owner已明确确认F01保守保留政策并授权继续全速开发，Sol / High三路并行，本地不push/不合并/不发布。

## 已实际验证的阶段证据

- 合同初始RED 1/9→GREEN 9/9，全合同127/127；后补源/RawRender谱系RED→GREEN，不改旧事实。
- 桌面控制器/SFC合计38/38 focused；root Main/Preload/outbox/文件时限48/48。
- Core计划首轮16/16；root真实计划完整备份/篡改/IPC等78/78；尚有审查修正待最终复跑。
- 首次Electron新场景拒绝合成fixture输出目录与源Root重叠，既有源保护正确执行；仅分离合成目录后2/2通过。内容包括真实链路、原命令回执丢失重试、旧快照冷开、释放预留后阻断、取消读取和错误脱敏。
- 首次完整verify Core918项902通过16失败：历史迁移fixture尚存schema18新增表或期待旧终点17。只修旧测试前置与版本终点，原回滚/逐列守恒断言保留，focused176/176。
- SPEC1桌面/接线PASS，Core发现唯一P2：同spec更新规划后旧资产与当前内容可能不一致。已真实复现并修复，SPEC2最终PASS，Core计划20/20；SPEC不进行第三轮。

这些均为中间候选证据，不是最终完整Gate或Owner验收。最终候选、实现/报告提交将在收口报告记录。技术Gate B、真实设备、真实录音与Owner验收仍NOT_RUN。

## 保留的证据

所有日志及失败产物在 `reports/runtime/task-072-recording-plan/`。固定schema17 SQL来自TASK071代码真实迁移，用于验证14～17历史备份升级；native 13文件从TASK071复制并逐SHA256核对。完整TASK064～079 TODO保持。

第二次canonical verify已实际退出0：Contracts127/Core922/Desktop414全部通过，类型与生产build通过。面板包装/预留中文标签另有实际SFC 2/3 RED→3/3 GREEN；最终Gate仍需覆盖该文案候选。安全27/27通过，Electron与完整E2E收口中。

QUALITY的非阻断P3静态观察：同一mediaPlan只增加revision而内容不变时，旧计划预检会保守阻断并将原因归为COPY_UNAVAILABLE。没有改写旧数据或放行输出，但归因应细化为versions/VERSION_MISMATCH；root决定有界carryover，后续补实际行为测试，本任务不为Minor追加循环。

最终canonical verify127/922/414、安全27、Electron4、完整E2E75（native开启零skip）、类型/控制/边界/205文件循环全部退出0。最终55代码/13native一致；完整E2E首轮两个旧schema断言失败已仅修终点，focused2/2和最终75/75，SPEC2→QUALITY2追加有界复核通过。root逐张查看最终6张截图；详见结果报告，真实Gate B与Owner未完成。
