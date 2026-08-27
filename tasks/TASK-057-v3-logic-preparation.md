# TASK-057：Logic Preparation Workspace

## 身份与授权

沿用 Owner 对完整 V3 的持续开发授权。基线 `385e1433f7f5a18b0467e0d90e51cfa5d5798b4e`，分支 `codex/task-057-v3-logic-preparation`。只使用隔离合成源、目标目录及库存；真实 Source Roots 和目标目录由 Owner 通过 Main 原生选择显式授权，不默认读取音乐库或写入用户目录。

## 范围

1. 从 Frozen Master/Layout 建立 Preparation 提案与后台任务。固定版本、Source Lineage 和 Planned Timeline，不从当前草稿推断旧内容。
2. Main 原生选择目标目录，Core 保存有界目录能力；Renderer 无私有路径。每次只创建本操作拥有的独立工作目录，不覆盖已存在目录，不写入 Source Roots。检查 realpath、符号链接和目录身份变化。
3. 只读取授权且匹配冻结身份的源，重新验证后生成独立 working copies；保留原件字节与属性。逐份验证副本 Hash、同步完成才可发布。撤权/取消立即中止读取，空间不足、文件变化或权限失效不产生 Ready 工作区。
4. 持久化操作意图、进度、输出清单和幂等回执。崩溃后验证操作归属与对象 Hash，明确恢复或中断；禁止仅凭文件名补成成功。相同 commandId 不重复导出；失败清理不触及已发布目录或非本操作文件。
5. 工作区包含 Source working copies、Tracklist、Source Lineage、Manifest、Cassette A/B 或 DAT Bounce target folders。清单保存版本与源绑定引用，不含私有音乐库路径。标识工作副本可供用户在 Logic 编辑，但再导入必须重新验证。
6. 在版本/录音上下文提供确认、状态/取消、工作区历史，以及用户主动打开 Finder。只生成交接素材，不自动启动、脚本控制或修改 Logic 项目。

## 验证

TDD；正式 IPC、源到独立工作副本的实际合成文件验证、路径/符号链接/容量/撤权、发布前后故障、幂等重试与冷启动。通过 verify、security、Electron、完整 E2E、静态 Gate 和视觉检查后独立提交实现、报告与状态锁定。

## 承接边界

后续任务继续 PREP 导入、用户实际 Marker 校正、RenderTimeline 与 Conformance 五态、Frozen PREP 及版本兼容性。不得把 Preparation 工作副本当作已验证 Logic Render、归档、Execution Asset 或正式录音。F-01、真实设备/账号/目录、完整 Gate A～E 和 Owner 验收保持独立；不采用本任务来完成长期执行音频清理策略。

## 允许修改

Contracts 新 Preparation 合同与 index/ipc/validator；Core recording（含安全只读复制）、collection/repository、runtime/utility-main；Desktop Main/Preload/录音版本组件及必要 composable；相关测试与既有 E2E；本任务、任务索引、WAVE-5、STATUS、V3 执行计划、ADR-017、结果报告及忽略的本地证据。无新远程访问、无真实源路径配置、无自动控制 Logic。

## 本地结果

Contracts 42/42、Core 555/555、Desktop 168/168；verify、security 22/22、Electron 4/4、完整 Playwright 45/45 与静态 Gate 通过。详细身份、合成证据及承接边界见 `reports/TASK-057_RESULT.md`。没有真实目录/Logic/录音验收，没有 push。
