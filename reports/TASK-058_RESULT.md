# TASK-058：原始 Render、实际 Marker 与 Frozen PREP

## 身份与当前结论

基线 `9262dfd9a2338c5502a7d4c9328d18ee3fa89218`；分支 `codex/task-058-v3-prepared-render-conformance`。实现提交 `ece85f27e2739a4447334a06801a983749d9e17a`；报告 SHA 由后续 STATUS 锁定提交记录。

本地自动验证通过。未 push、main 集成、签名、公证或发布。远端 main 核验为 `90d0aa8aa7f156c6ecfc6f366eea698f8e4d6098`，未发现 TASK-058 远端分支。全部文件、目录、库存及 Roon 元数据均为隔离合成数据；没有使用真实音乐库、账号、Logic 项目或录音设备。本任务不代表完整 Gate D/E、输出认证或 Owner 产品验收。

## 实现与规格核对

| 范围 | 实现与证据 |
|---|---|
| 原始 Render 选择与身份 | Main 原生单文件选择；Core 只授权确切文件，不注册或扫描整个 Source Root。完整 SHA-256、WAV 规格、采样率、声道、总帧和带证据类型的创建时间独立记录。选择后文件变化须重新选择。 |
| 独立原始副本 | 用户确认目标、字节容量和复制边界后，新建 `MusicBridge-OriginalRender-*`。原件只读，不覆盖；工作副本与原始 Render 使用分开的路径白名单。目标逐份重读 Hash、操作归属与 fsync。 |
| 实际曲目标记 | 显示 Planned Timeline 与实际帧时间线，支持逐曲开始/结束帧校正。候选初始未确认；每次编辑撤销该曲确认。保存 trackId、Exact Source Hash、实际 Gap、确认方法与用户确认。 |
| 五态 Conformance | BigInt 跨采样率比较；`one-render-frame-v1` 最多一 Render 帧匹配容差，容量严格不放宽。换曲/源/全局顺序要求新 Master；换面/结构/超容量要求新 Layout；差异须明确接受并填写原因。 |
| Frozen PREP | 永久绑定 Master/Layout、Planned/Render Timeline 及 Hash、Preparation、导入任务、原始 Render、DAW、处理谱系和 Conformance。仅 MATCHED/ACCEPTED_VARIANCE 可冻结，固定 `Baked Into Render`，禁止再插 Gap。 |
| Cassette / DAT | A/B 与 DAT Program 使用独立原始文件。空 B 面保存零帧、空 Marker、空文件身份和 none 声道事实，不要求虚构占位 WAV；A 面原件正常独立保存。 |
| 回执、故障与恢复 | Schema 10 的持久化导入意图、进度、Manifest 发布和完成回执。完整发布后数据库失败可冷启动只校验副本并补写回执；未完成复制不重放。取消、文件/目标撤权、磁盘满、SQL 回滚与输出篡改均有断言。 |
| 历史有效性与桌面 | 旧 PREP 对原 M/L 继续有效，当前版本兼容性单独显示。窄 Main/Preload/utility API、预览与保存确认、逐曲人工确认、后台取消、会话内原命令重试及冷启动历史。 |

`executionReady` 始终为 false。原始 Render 的独立保存不等于完整归档事务或可认证的执行输出。容器声明帧数和 Hash 不代替逐帧解码、声学内容或实际听感验收；曲目内容仍须用户对最终 WAV 人工确认。

## 验证记录

环境：Node 22.23.2、Corepack pnpm 10.17.1。

| Gate | 当前结果 |
|---|---|
| 根 `verify` | exit 0；包括空 B 面与新增 schema 迁移断言后的完整重跑 |
| Contracts / Core / Desktop | 44/44、583/583、169/169；typecheck/build 均通过 |
| 原始 Render / Conformance 聚焦 | exit 0，28/28 |
| `test:security` | exit 0，22/22 |
| `test:electron` | exit 0，4/4 |
| 完整 Playwright | exit 0，47/47，5.2 分钟 |
| 新 PREP 桌面流程 | A/B 与空 B 面两例均通过：正式 Main/Core/SQLite、取消选择、确认前不复制、实际文件保存、未确认/未接受差异拒绝、明确接受、冻结回执丢失重试、冷启动历史 |
| 局部视觉与可访问性 | 最终 1440×900 / 720×480 无横向溢出，axe critical/serious 为 0，关闭恢复入口焦点；最终 Marker、导入及历史截图已查看 |
| control-plane / boundaries / cycles | PASS / PASS / PASS，131 files；control-plane 仍检查旧 WAVE-3，WAVE-5 身份单独核验 |
| `git diff --check` | exit 0，提交前再核 |

实际文件复制、原件/副本 Hash、原件 mtime/ctime、输出 0600、SQLite 冷重开和 SQL 不可变性使用隔离真实文件；磁盘满、提交失败、回执丢失与复制挂起采用受控故障注入。Main 原生选择器在 E2E 中返回合成路径，不能称为 Owner 真实文件授权或 Logic 实机验收。

## RED 与诊断

1. 初始 Prepared 仓库与窄请求合同不存在；测试失败后建立独立 schema 与 IPC。
2. Conformance 初始拒绝全部输入；同曲同源同面 MATCHED、超容差明确接受、换曲/源/顺序、新布局与跨采样率整数测试取得失败到通过证据。
3. 原文件底层最初只支持可编辑 Preparation 目录；新增测试证明路径错误后，增加独立原始 Render 目录与白名单。
4. 原始 Render 导入入口初始明确不可用；实现选择、完整 Hash、确认保存、实际 Marker、冻结和幂等后，正式 Core 流程通过。
5. Main-only 选择、公开路径隔离与 Preload 允许列表先取得失败证据；普通控制请求的短超时也被长文件核对测试证明不足，增设独立有界长窗口。
6. 桌面 E2E 首次在正式录音页找不到 PREP 入口，构成 UI 行为 RED；接入实际面板后同一流程通过。
7. 静态规格自查复现“空 B 面仍强求 WAV”，随后明确无文件的零帧空面；再补空面时间基准与预览/冻结一致性失败断言并修正。
8. 旧 schema 8 迁移夹具包含新增 prepared 表，导致模拟升级冲突；修正夹具的旧表集合，保留原历史/账本/回滚断言。新增 schema 9→10 回滚验证通过。
9. DAT 夹具首次缺少必需的 dat tapeType、一次 Preload 夹具编辑使用错误 cwd、增补 IPC list 时漏掉穷举响应分支，均单独定位并修正。此类夹具/类型检查错误不算产品行为 RED。

## 两阶段自查

先对 TASK-058 六项范围、PRD §17/附录 A3 检查确认语义与版本身份，再检查路径、事务、撤权时序、响应隔离、原始副本复核、精确帧边界、生命周期清理及 UI。空面处理已作为本次规格修正进入实现和验证。

| Before | After | Why |
|---|---|---|
| Logic 工作区之后没有原始 Render 验收入口 | 独立选择/保存原件，实际 Marker、Conformance 与冻结逐段展开 | 写盘确认与内容确认分开，防止导出回执冒充 PREP |
| 计划 Marker 没有人工确认状态 | 每曲显示计划/实际帧，候选未确认；编辑后必须重确认 | 自动候选不进入档案事实 |
| 空 B 面被要求提供文件 | 明确保存无 Render、零帧的空面 | 不制造无依据音频资产，不阻断既有空面布局 |

0 子代理；以上为自查，不代替独立审查或 Owner 验收。

## 承接、限制与未完成范围

下一段继续执行格式与执行资产、RecordingPlan、录音状态机和设备 Gate B。F-01 尚需 Owner 决定，不冻结相关保留/清理规则，不自动清理，不将编译资产称为永久归档。

实际输出后端、声卡/磁带机/DAT 设备、采样配置、转换器/版本与 dither、停止时间测量、真实 Source Roots 和最终听验仍需具体授权与配置。归档/双库同步/Replica/J-Card/备份、参考目录/Excel 导入、Want List、跨重启 outbox、完整 PRD 验收与既有 V2/WAVE-4 carryover 都保留在完整 V3 目标内。

每工作区最多100个原始文件选择；每草稿最多1000项导入及100个 Frozen PREP。最多两项并发预览读取、两项复制、两项保留副本核对。完整文件 Hash 循环具有15分钟期限，Main 文件请求具有35分钟超时；不声称对阻塞的操作系统调用提供硬实时保证。失败目录不自动删除，不承诺原文件 atime 不变，不声称同用户恶意文件系统竞态具有原子沙箱隔离。

最终证据保存于 `reports/runtime/task-058-final-2w3i47o4/`，含 RED/最终日志、完整 test-results 与 SHA-256 清单；忽略的 runtime 证据不进入 Git。
