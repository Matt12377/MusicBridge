# V3 剩余任务 TODO

当前进度：TASK-072 已从最终HEAD `6c94350575ab2a21f7aeef36713b9a3d868e4bdf` 封版；TASK-073无设备阶段已通过134/956/427、安全28、Electron4、完整E2E77，实际应用包检查也通过；真实Gate B待专门授权；F-01已确认。Owner 已授权持续开发到最终验收；当前为本地开发，不 push、不合并 main、不发布。2026-08-28 Owner 新授权按独立文件范围并行，智能体统一 GPT-5.6 Sol / High，原任务队列不变。

本表是任务拆分与依赖计划，不是完成声明。后续任务沿上一任务最终 HEAD 创建独立分支；当前已展开 TASK-064～073，其余任务开始前补详细范围和允许路径。具体子任务可根据已验证结果细分，不删减 PRD 范围。

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
- [ ] **TASK-073：输出后端与 Gate B** — 无设备自动验证通过（134/956/427、安全28、Electron4、完整E2E77）；实际应用包检查通过（正常包退出未验证）。共享帧泵/固定helper/只读Plan链路已接入，HAL仅单独编译适配；完整设备生命周期、配置认证和Gate B未完成，需确定设备与测量授权。
- [ ] **TASK-074：正式录音 Attempt 状态机** — 待前置。Cassette 翻面、DAT Program、中断不续播、三层结束与人工完成确认。
- [ ] **TASK-075：录音档案、检索与双库同步** — 待前置。完成后同一 Physical Copy 幂等登记，归档搜索和版本事实不重写。
- [ ] **TASK-076：Digital Replica** — 待前置。按历史执行事实精确重播，缺失/变更/恢复异常阻断，不替换来源。
- [ ] **TASK-077：J-Card 与 Printed Artifact** — 待前置。封面/曲目/模板快照、打印导出、旧印刷品不随模板变化。
- [ ] **TASK-078：V3 全链路自动验收** — 待前置。逐项 PRD30、A～E、U-01～U-10、V2 回归、故障矩阵、TASK-066大库冷启容量/超时策略、TASK072版本变化预检误归因P3、TASK073正常包退出复核和证据差距清单。
- [ ] **TASK-079：真实环境与最终 Owner 验收** — 待 Owner。授权实物/库存表/Source Roots/Logic/设备实录；Owner 明确逐项接受。

## 需要 Owner 的外部条件

- [x] F-01：2026-08-28 Owner 明确确认保守保留方案，见开发包 `f01-permanent-execution-v1`。批准不等于正式录音/设备或产品验收。
- [ ] 明确可读取的 Source Roots、实物照片、参考目录及真实 Excel 样本；自动 Gate 仅使用合成数据。
- [ ] 选择声卡/录音机/DAT 与输出后端，锁定测量配置，安排真实 Logic 和实体录制。
- [ ] Owner 逐项确认产品功能与视觉体验；自动通过不勾选人工验收。

## 不因 V3 开发自动关闭的历史项

- [ ] TASK-047：真实 Roon / NetEase 歌词验证。
- [ ] TASK-061：固定原生转换器发布准入。
- [ ] TASK-040/041：签名、公证、安装和 Beta 分发验收（若另行授权发布）。
- [ ] main 集成、GitHub push、签名、公证和发布分别授权；不属于当前自动执行范围。

## 完成判定

每项记录行为 RED/GREEN、SPEC 后 QUALITY 自查、验证退出码、实现/报告/最终提交。完整 Gate A～E 和 Owner 接受均保持未完成，直到各自证据齐备。
