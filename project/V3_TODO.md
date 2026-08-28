# V3 剩余任务 TODO

当前进度：TASK-077本地软件Gate通过（184/1088/601、安全29、Electron4、完整E2E90，双native零skip），实现与报告身份已锁定，见STATUS；TASK-078只从本任务最终HEAD启动。可听Replica、TASK073真实HAL/Gate B、实体纸张与最终Owner仍待验；旧CDP退出FAIL与R020～023保留。仅本地开发至079，不push、不合并main、不发布；智能体统一GPT-5.6 Sol / High。

本表是任务拆分与依赖计划，不是完成声明。后续任务沿上一任务最终 HEAD 创建独立分支；当前已展开 TASK-064～077，其余任务开始前补详细范围和允许路径。具体子任务可根据已验证结果细分，不删减 PRD 范围。

## 开发队列

- [x] **TASK-064：一致性快照与归档内容备份基础** — 本地自动 Gate 通过，Owner 未验收。SQLite Backup API、快照内引用闭包、内容字节完整校验、无覆盖发布。
- [x] **TASK-065：隔离恢复与基本索引重建** — 本地自动 Gate 通过，激活/UI 与 Owner 未完成。隔离目录恢复、重复恢复冲突、Manifest 重建、Quarantine；不覆盖当前用户数据。
- [x] **TASK-066：桌面备份与恢复工作流** — 本地自动 Gate 通过：77/818/186、安全22、Electron4、完整E2E50。独立维护库、内容位置绑定、显式激活/回滚与后台窗口；Owner未验收，大库冷启容量风险转TASK-078/Gate E。见 [TASK-066结果](../reports/TASK-066_RESULT.md)。
- [x] **TASK-067：持久命令 outbox** — 本地自动 Gate 通过：82/827/279、安全27、Electron4、完整E2E54。Main持久账本、Core工作库身份隔离、人工恢复和PREP整批撤权；Owner未验收。见 [TASK-067结果](../reports/TASK-067_RESULT.md)。
- [x] **TASK-068：参考目录与版次修订** — 本地自动 Gate 通过：95/847/291、安全27、Electron4；常规E2E56通过，固定native另跑1通过。来源原包、不可变目录、合并拆分审核与历史快照；Owner未验收。见 [TASK-068结果](../reports/TASK-068_RESULT.md)。
- [x] **TASK-069：Excel 非破坏导入** — 本地自动Gate通过：107/881/316、安全27、Electron4、完整E2E60（固定native开启，零skip）。原始字节与源行、显式来源关系、非破坏修订、独立数量账本及备份恢复；Owner未验收。见 [TASK-069结果](../reports/TASK-069_RESULT.md)。
- [x] **TASK-070：Want List 与收藏完成度** — 本地自动Gate通过：118/897/337、安全27、Electron4、完整E2E66（固定native开启，零skip）。Wanted与Owned正交、实际持有长度、不可变历史和预算分页；Owner未验收。见 [TASK-070结果](../reports/TASK-070_RESULT.md)。
- [x] **TASK-071：Source Picker 与双库交互补齐** — 本地自动Gate通过：118/897/395、安全27、Electron4、完整E2E73（固定native开启，零skip）。关系选曲、明确历史上下文、下一步指引、按需照片/单图重试与焦点返回；Owner及既有视觉carryover保留。见 [TASK-071结果](../reports/TASK-071_RESULT.md)。
- [x] **TASK-072：正式 Profile Snapshot / RecordingPlan / Preflight** — 本地自动Gate通过：127/922/414、安全27、Electron4、完整E2E75（固定native开启，零skip）。不可变计划/当前参数快照、八类预检、schema18备份恢复；F01已确认，Gate B未认证仍阻断，Owner未验收。见 [TASK-072结果](../reports/TASK-072_RESULT.md)。
- [ ] **TASK-073：输出后端与 Gate B** — 无设备底座、面板和隔离生命周期内核已交付；第四阶段修复启动退出验证及合成旧配置隔离，当前本地Gate为134/957/461、安全28、Electron4、完整E2E80。新包启动自退出通过；旧调试连接退出FAIL保留。真实HAL接入、设备生命周期/配置认证与Gate B仍待实机，不标完整任务完成。Owner已授权后续软件阶段继续，见[本轮结果](../reports/TASK-073_EXIT_LIFECYCLE_RESULT.md)。
- [x] **TASK-074：正式录音 Attempt 状态机** — 本地Gate通过：147/1005/483、安全29、Electron4、完整E2E83，双native、零skip。Cassette显式翻面/BeginB、DAT Program、中断不续播、三层完成、schema19及可能写入介质保护；真实准入仍受Gate B阻断，R023容量风险待078。见[TASK-074结果](../reports/TASK-074_RESULT.md)。
- [x] **TASK-075：录音档案、检索与双库同步** — 本地Gate通过：162/1035/505、安全29、Electron4、完整E2E86，双native零skip。首次Completed幂等不可变登记、当前内容认知、明确重录/擦除声明与检索；同一Physical Copy双库同步且不增加库存，历史快照不重写；真实播放/实机与Owner待验，见[TASK-075结果](../reports/TASK-075_RESULT.md)。
- [x] **TASK-076：Digital Replica（本地软件阶段）** — 本地Gate通过：174/1066/532、安全29、Electron4、完整E2E88，双native零skip。历史归档执行音频/原Render核验、恢复binding、有限只读会话与取消收口；生产播放保持blocked，可听Replica及正式provider仍待073/079，不冒称真实播放，见[TASK-076结果](../reports/TASK-076_RESULT.md)。
- [x] **TASK-077：J-Card 与 Printed Artifact（本地软件阶段）** — 本地Gate通过：184/1088/601、安全29、Electron4、完整E2E90，双native零skip。完成事务自动打印请求、Master Artwork版本、不可变PDF/预览、原生无覆盖导出与schema21恢复；实际PDF23页独立几何/内容/视觉通过，纸张/盒型与Owner待验，见[TASK-077结果](../reports/TASK-077_RESULT.md)。
- [ ] **TASK-078：V3 全链路自动验收** — 待前置。逐项PRD30、A～E、U-01～U-10、V2回归、故障矩阵、TASK066大库冷启容量/超时策略、TASK074全历史校验与停止延迟R023、TASK073包正常退出FAIL定位和证据差距清单；TASK077未来预览去浏览器滚动条，不改历史Artifact。TASK072版本分类P3已在TASK073第二阶段修复，不再列为待修。
- [ ] **TASK-079：真实环境与最终 Owner 验收** — 待 Owner。授权实物/库存表/Source Roots/Logic/设备实录；Owner 明确逐项接受。

## 需要 Owner 的外部条件

- [x] F-01：2026-08-28 Owner 明确确认保守保留方案，见开发包 `f01-permanent-execution-v1`。批准不等于正式录音/设备或产品验收。
- [ ] 明确可读取的 Source Roots、实物照片、参考目录及真实 Excel 样本；自动 Gate 仅使用合成数据。
- [ ] 实机条件：2026-08-29 Owner说明目前没有设备连接，后续计划使用RME或Apogee声卡、Sony卡座；具体型号、连接方式、输出后端及测量配置待设备接入时确认，届时另行明确设备操作范围。真实Logic和实体录制未执行，Gate B保持NOT_RUN；不据品牌计划认定兼容或认证通过。
- [ ] Owner 逐项确认产品功能与视觉体验；自动通过不勾选人工验收。

## 不因 V3 开发自动关闭的历史项

- [ ] TASK-047：真实 Roon / NetEase 歌词验证。
- [ ] TASK-061：固定原生转换器发布准入。
- [ ] TASK-040/041：签名、公证、安装和 Beta 分发验收（若另行授权发布）。
- [ ] main 集成、GitHub push、签名、公证和发布分别授权；不属于当前自动执行范围。

## 完成判定

每项记录行为 RED/GREEN、SPEC 后 QUALITY 自查、验证退出码、实现/报告/最终提交。完整 Gate A～E 和 Owner 接受均保持未完成，直到各自证据齐备。
