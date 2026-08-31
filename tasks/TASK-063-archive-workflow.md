# TASK-063：归档授权、执行谱系与桌面确认

基线 `4cdffc25cae80aa80003d1b331025d1a9b5fbcd3`，分支 `codex/task-063-archive-workflow`。承接持续开发到最终 Owner 验收授权；0 子代理，无 push/main 集成/发布，不访问真实账号或实际输出设备。

## 目标

把 TASK-062 的内部事务基础接成可实际使用的归档流程。原生选择目录只建立候选，明确确认后初始化独立 Root；预览内容、源政策与容量不写文件，明确归档确认后才执行。

## 范围与验收

1. 严格公共合同：Root 候选/初始化/撤权、归档预览、后台操作/取消/恢复、历史和当前完整性核验；不允许 Renderer 指定绝对路径、任意文件、执行谱系或伪正式录音。
2. 归档实际执行音频、转换中间证据、原 Manifest、Master/Layout/执行参数 JSON；Prepared 必须同时保留原始 Render 与其 Manifest，Derivative 不覆盖原件。精确源复制必须独立明确选择，只复制实际使用的冻结 Hash/长度，不按同名猜测或扫描整库。
3. 持久命令、Root 初始化中断/回执幂等、总体期限、Source/Preparation/Archive 撤权、取消、关闭与重启恢复；原操作不重复归档，已提交状态不能伪撤销，历史归档不冒充当前可用。
4. 接入正常和测试 runtime、utility、Main 原生选择、preload 和既有录音上下文；保留 V2 入口。无新永久导航，不以 placeholder 成功替代未接入能力。
5. 合同、真实合成文件/SQLite、IPC、桌面行为与 V2 全回归；先 RED 后实现、SPEC → QUALITY 自查、本地三提交。

## 政策边界

F-01 仍待 Owner 明确回复，不承诺永久保留、不冻结正式 RecordingPlan/Attempt。归档操作成功不改实体库存或录音完成状态。完整备份/恢复、Replica、J-Card、正式预检与录音状态机继续后续任务，不从完整 V3 范围删去。

## 允许路径

Contracts 新归档合同、IPC/index/validator；Core archive 文件/事务/存储/协调器、repository schema、runtime/utility；Desktop Main/supervisor/preload 与录音上下文组件；对应合同、Core、迁移、Main/preload、IPC/E2E 测试与复用夹具；任务/索引、WAVE-5/STATUS/执行计划、ADR/结果报告及忽略运行证据。

窄范围配套：prepared-store/prepared-coordinator 提取既有原件 Manifest 纯函数，保持原字节格式不变供归档复用；source-evidence 增加授权前只读路径护栏，防止 Source Root 与已初始化 Archive Root 互相覆盖。对应夹具可提取复用，不改既有功能含义。

## 本地自动验收结果

后台归档、四类执行/PREP/精确源谱系、持久确认/取消/恢复、Source/Preparation/Archive 撤权与关闭、初始化生命周期、后台恢复不阻塞读取取消均已接入。Root schema14 与迁移回滚保留。正常/合成 runtime、正式 utility IPC、Main 原生选择、preload 和执行资产内联归档页面已接通；未增加永久导航或嵌套弹窗。

新鲜验证：根 verify 退出0，Contracts 71、Core 704、Desktop 179 全部通过；安全22、Electron4、边界/Control Plane/155文件依赖环通过。Control Plane 仍只核验既有 WAVE-3，不冒充 V3 验收。定向桌面归档（含回执丢失、窄窗/axe和冷启动）通过；完整49项 E2E（含固定原生 bundle）退出0。35个代码/测试文件与最终测试候选的Git blob一致。主代理按SPEC→QUALITY自查，不冒充独立审查。实现/报告/最终状态的提交身份分别记录。

F-01 未决；正式预检/Plan/Attempt、完整备份/恢复、Replica/J-Card、全真实 Gate 和 Owner 验收继续后续任务。没有 push/main 集成/发布。
