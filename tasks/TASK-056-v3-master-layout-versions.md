# TASK-056：源帧证据、不可变母版与布局版本

## 身份与授权

沿用 Owner 对完整 V3 的持续开发授权。基线 `d64f2b2979b580b2771efea4cb6b935806f17dea`，分支 `codex/task-056-v3-master-layout-versions`。只使用隔离合成文件和库存；真实目录、账号、设备和发布另行授权。

## 范围

1. 保存源容器声明的精确采样帧数及采样率，不从舍入后的毫秒反推。WAV/AIFF/FLAC 有界头部证据与逐帧解码分开；旧绑定缺帧证据时要求重新校验。
2. 预览 Master/Layout 版本提案。Master 锁定曲目、全局顺序、Exact Source 内容身份与 Transition Rules；Layout 独立锁定物理映射、起止帧、静音、容量和显式输出采样率时基。Cassette A/B 与 DAT Program 分开。
3. 只改分面时复用 MasterVersion、新建 LayoutVersion；改内容/曲序/源/Transition 明确创建新 Master 提案并要求确认。冻结对象不可原地改写或删除，历史不随当前草稿变化。
4. 冻结前通过可查询、可取消、稳定 commandId 的后台任务完整复核授权源 Hash、技术/帧证据、人工映射、规划和库存；提交前再次核对输入与预留并原子保存。变化、撤权、取消、冲突均拒绝冻结，重启未完成任务中断且不重播。
5. 持久化版本、源快照、时间线、谱系及 Hash。重试不重复创建版本。内容/布局冻结不是录音执行 Plan Freeze、Compiled Asset 或 Output Certified；不自行决定 F-01。
6. 在既有录音上下文提供提案确认、后台任务和历史查看。覆盖迁移、回滚、身份独立性、幂等、重启、权限与 Main→Core→SQLite 正式 E2E。

## Gate 与承接

TDD；子毫秒源帧数、显式采样率换算、静音边界、D-02/D-03、不可变引用、完整源复核期间的取消/变化、事务和重启。全量 verify/security/Electron/E2E 与静态 Gate。

完整 Gate D 仍包括后续 Logic/PREP/RenderTimeline/Conformance、Profile/Artwork 历史快照。多介质扩展、Source Picker 关联、通用 outbox、F-01 与真实录音仍保留。不得用本次内容版本宣称正式录音可用。

## 允许修改

Contracts source-evidence/新版本合同、index/ipc/validator；Core recording、collection/repository、runtime/utility-main；Desktop Main/Preload/录音组件及必要 composable；对应既有测试、新版本测试与既有 E2E；本任务、索引、WAVE-5、STATUS、执行计划、ADR-016、报告及本地证据。不添加远程访问或新音频依赖。

## 本地结果

最终 verify（39/526/168）、security 22、Electron 4、完整 Playwright 44 全部通过；静态 Gate 与 diff 检查通过。详细证据与限制见 `reports/TASK-056_RESULT.md`。后续 TASK-057 从本分支最终状态锁定 HEAD 接续 Logic Preparation Workspace；未 push 或合并 main，完整 Gate D 与 Owner 仍未完成。
