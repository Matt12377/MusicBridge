# TASK-057：Logic Preparation Workspace

## 身份与结论

基线 `385e1433f7f5a18b0467e0d90e51cfa5d5798b4e`；分支 `codex/task-057-v3-logic-preparation`；实现提交 `5b84f15d9ae170d181929079605c67bd29835bf6`。报告独立提交，报告 SHA 由下一 STATUS 锁定提交记录。TASK-058 从本任务最终锁定 HEAD 建立独立分支。

本地自动验证通过。未使用真实音乐目录、Provider/Roon 账号、Logic 项目或录音设备；不代表完整 Gate A～E、输出认证或 Owner 产品验收。没有 push、main 集成、签名、公证或发布。远端 main 核验为 `90d0aa8aa7f156c6ecfc6f366eea698f8e4d6098`，未发现 TASK-057 远端分支。

## 实现与规格核对

| TASK-057 范围 | 实现与证据 |
|---|---|
| 冻结版本提案 | 从 Master/Layout 及布局逐曲 sourceBindingId 构造导出；当前草稿改序后仍按冻结内容复制。提案不写盘，确认绑定摘要与稳定 commandId。 |
| 明确目标授权 | Main 原生目录选择，Core 保存私有目录 capability；公开 API 只返回编号与标签。排除 Source Roots、符号链接及目录身份变更；已有工作目录不覆盖。 |
| 源只读、独立副本 | 原件只读句柄、逐块完整 Hash、源前后身份复核；目标独立文件、同步与重读 Hash。修改副本不会修改原件；实际目标权限失效、磁盘满、取消和撤权均不发布完成回执。 |
| 持久化与恢复 | Schema 9 保存任务/进度/归属/清单意图/幂等账本。发布后数据库失败可冷启动验证全部对象后补回执；文件编辑、归属改变、撤权或复制中退出不重放复制。快照和账本禁止 SQL 覆写/删除。 |
| 工作区交接文件 | Sources、Tracklist.tsv、SourceLineage.json、README.txt、Manifest.json，以及 Cassette A/B 或 DAT Program Bounce Targets。清单无原库私有路径，保留版本/绑定与 Planned Timeline。 |
| 桌面流程 | 录音页及冻结布局入口；目标选择、预览、明确确认、后台进度/取消、原命令重试、工作区历史与用户主动打开 Finder。没有自动启动、脚本控制或修改 Logic。 |

“完成”只证明导出时工作副本及清单核验通过，所有工作区仍为 `executionReady=false`。工作副本允许编辑；导入 PREP 必须重新验证，不能信任文件名或旧导出回执。

## 最终验证

环境：Node 22.23.2、Corepack pnpm 10.17.1。全部账号状态、库存、Roon 元数据与音频文件均为隔离合成数据。

| Gate | 结果 |
|---|---|
| `corepack pnpm@10.17.1 verify` | exit 0；最终补充权限与不可变账本断言后完整重跑 |
| Contracts / Core / Desktop | 42/42、555/555、168/168；无失败、取消或跳过；typecheck/build 通过 |
| `test:security` | exit 0，22/22 |
| `test:electron` | exit 0，4/4 |
| 完整 Playwright | exit 0，45/45，4.7 分钟 |
| 新工作区 E2E | 正式 Preload/Main/utility Core/SQLite，原生选择的合成路径、取消选择、拒绝源目录、确认前不写盘、实际独立副本、回执丢失重试、原件不变及冷启动历史一致 |
| 工作区局部视觉与可访问性 | 1440×900 / 720×480 无横向溢出；axe critical/serious 为 0；关闭恢复入口焦点；最终截图已查看 |
| control-plane / boundaries / cycles | PASS/PASS/PASS，127 files；control-plane 仍检查旧 WAVE-3，WAVE-5 身份单独核验 |
| `git diff --check` | exit 0 |

Finder 的 E2E 在 Main 接管 `shell.openPath`，验证收到的确切目录并返回合成成功，不冒充真实 Finder/Logic 操作。ENOSPC、数据库提交失败及回执丢失使用受控故障；实际文件复制、Hash、权限失效、SQLite 重开与目录置换使用真实隔离文件。

## RED 与诊断

1. 初始 Preparation 仓库及请求合同不存在；新增失败测试后建立 schema 与窄请求。
2. 只读复制器不存在；实际字节/Hash、源属性、独立 inode、取消、符号链接、磁盘满与输出篡改测试转绿。
3. 工作目录/发布器不存在；独占目录、越界拒绝、身份置换、清单与全部输出核验后转绿。
4. 正式协调器不存在；冻结历史导出、草稿变化、幂等、源撤权/取消/磁盘故障测试转绿。
5. 冷启动原本不会补发布回执，未完成任务仍显示 running；增加按确切归属/Hash 恢复及明确 interrupted，不重放源读取。
6. 目标撤权、发布后输出变化、导出中目标变成 Source Root、数据库失败回写、恢复核验中撤权均先由失败测试定位，再补阻断/abort/待回写机制。
7. 私有 Finder 上下文和 Preload 允许列表缺失、正式 IPC 返回 undefined、UI 工作区按钮缺失均取得失败证据。原生目录/过期源在提交前已拒绝时，明确返回未接受，避免陷入模糊回执重试。
8. 旧迁移夹具包含新增 preparation 表，模拟旧 schema 时导致重建冲突；修正夹具而不放宽原数据/账本保留与事务回滚断言。
9. 测试辅助目录缺失、Preload 单测从错误 cwd 启动、E2E 标题未启用合成 Roon、严格 preview 校验误收 start 全请求均分别定位并修正。前述环境/夹具错误不当作产品行为 RED。
10. Contracts 无 verify 脚本，早期 pnpm 返回 0 但未运行验证；最终明确运行 typecheck/test/build，并完成根 verify。原始日志保留，未把空执行列为 Gate。

## 两阶段自查

先按 TASK-057 六项范围及 PRD §15 检查交接内容、确认边界、源只读与恢复语义，再检查事务、文件身份、撤权时序、迟到结果、合同、生命周期清理与 UI。

| Before | After | Why |
|---|---|---|
| 冻结版本后缺少 Logic 交接入口 | 版本/录音上下文均可进入工作区面板 | 保持 Master/Layout 选择上下文，不靠文件名推断版本 |
| 无目标与复制确认流程 | 原生选目标、提案与独立确认、后台状态及取消 | 写盘前明确授权，回执不明时只重试原命令 |

0 子代理；以上为自查，不替代独立审查或 Owner 验收。

## 承接与限制

下一任务继续原始 Render 导入、用户实际 Marker、RenderTimeline、Conformance 五态和 Frozen PREP。执行派生、RecordingPlan、设备输出、正式录音、归档/J-Card/备份、参考目录/导入、多介质布局及完整 A～E 保留在完整 V3 目标内。F-01、TASK-047 真实验收与已有视觉 carryover 不由本任务关闭。

失败、中断、取消目录不自动清理；目录存在不是成功证据。此实现不承诺同用户恶意并发文件系统操作的原子沙箱隔离，详见 ADR-017。原件内容/标签/权限/修改时间不改写，不承诺操作系统访问时间不变。每草稿最多 100 个工作区和 1000 个任务、最多 100 个目标、最多 2 个并发复制。

后台状态与已完成历史支持冷启动；面板只保证会话内未确认命令重试，通用跨应用重启 outbox 仍待后续。

证据保留在 `reports/runtime/task-057-final-6puqk7hp/`，包含最终与 RED 日志及完整 test-results。它是忽略的本地证据目录，不纳入 Git。
