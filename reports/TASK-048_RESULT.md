# TASK-048：V3 收藏与录音导航基础

## 结论

首段正式 Renderer 实现及本地自动验证通过。当前只提供导航、双收藏视图和录音准备页面；库存录入、照片管理、Roon 录音选曲与录音引擎均未接入，页面明确说明并禁用相关操作。

Owner 认可的是 Preview 02 的设计方向及开始开发，不等于已验收本次正式 Electron 页面或完整 V3。无真实 Provider/Roon/声卡/磁带机操作，无 push、main 合并或发布。

## 代码与报告身份

- 基线：`b0e1ff8ec83ac9aaebbe90e8ecb14c4a5832e7f4`（最新需求与开发授权文档基线）。
- 任务分支：`codex/task-048-v3-navigation`。
- 实现提交：`7ca3423841a595116d6dc7b5ffe1d18c60ca792b`。
- 本报告独立提交；其精确 SHA 由后续仅修改 STATUS 的锁定提交写入 `v3Development.reportCommit`。
- 下一任务从本任务最终 STATUS 锁定 HEAD 创建；当前未创建下一任务分支，不从实现提交或旧 main 绕过报告。
- `codex/v3` 保留文档基线；本地与远端 main 均为 `90d0aa8aa7f156c6ecfc6f366eea698f8e4d6098`。
- 旧 V3 worktree 的 `prototypes/` 未纳入提交，原型服务器和第三方参考图未改动。

## 实现范围

1. 单一应用侧栏新增“收藏”“录音”；原有数字音乐收藏明确为“Roon 收藏”。V2 入口与底部播放器保留。
2. 收藏支持空白磁带收藏、实体音乐库两个页内视图；箭头/Home/End 键切换、焦点与 ARIA 关系、离开再返回和搜索取消恢复。
3. 录音独立页面，呈现选曲、磁带、确认与预检顺序；母版与录音记录为次级位置。不存在 V3 概览页、设备页或第二套永久侧栏。
4. 仅保留本次会话的视图选择，不持久化假库存，不读取用户音乐、照片或设备。线稿是空状态插图，不冒充实物照片。
5. 没有修改 Main、Preload、公开合同、Provider/Roon 适配器、数据库、音频路径、包版本或锁文件。

## TDD 与新鲜证据

- RED：在未增加入口的正式构建上运行新增 E2E；生产页面成功启动，`[data-sidebar-source="collection"]` 不存在，`toBeVisible` 断言失败，exit 1。不是导入/环境错误。
- GREEN：新增 3 项 E2E，最终 3/3，exit 0；覆盖真实 Renderer 导航和键盘操作。
- 播放隔离：先通过现有合成播放进入 playing，再监听全部相关播放/队列/Zone 变更 IPC；切换新页面及返回主页后调用次数为 0，曲目、队列和 Zone 不变。
- 布局：1440×900、720×480 的内容区无横向溢出；新增 V3 页面 axe critical/serious 为 0。最小窗口允许正常纵向滚动，不要求所有内容同时显示。
- 主代理查看了正式 Electron 合成截图，确认照片占位、视图层级和最小窗口滚动布局；此项不是 Owner 视觉认可。

### 最终本地验证

环境：Node 22.23.2 / pnpm 10.17.1，全部使用项目既有合成测试路径。

| 命令 / Gate | 结果 |
|---|---|
| `corepack pnpm@10.17.1 verify` | exit 0；类型检查、单元测试和生产构建通过 |
| Contracts / Core / Desktop 单元测试 | 27/27、422/422、162/162，共 611 项 |
| `corepack pnpm@10.17.1 test:security` | exit 0，22/22 |
| `corepack pnpm@10.17.1 test:electron` | exit 0，4/4；启动、崩溃、合成凭据恢复 |
| 桌面 `playwright test` | exit 0，25/25，包括原 22 项及新增 3 项 |
| 既有整页 axe 测试 | 默认测试场景通过；不代表所有闲置设备状态都无问题，见下方 carryover |
| control-plane / boundaries / cycles | PASS / PASS / PASS，cycles=98 files |
| WAVE-5 / STATUS 身份核对 | task、branch、base 一致；旧 control-plane 仍只校验 WAVE-3 |
| `git diff --check` | exit 0 |

本地日志：`/tmp/musicbridge-task-048-red.log`、`/tmp/musicbridge-task-048-focused-green.log`、`/tmp/musicbridge-task-048-verify.log`、`/tmp/musicbridge-task-048-security.log`、`/tmp/musicbridge-task-048-electron.log`、`/tmp/musicbridge-task-048-e2e.log`。失败上下文保留于忽略提交的 `reports/runtime/task-048-*`，没有丢弃原始失败证据。

## 调试记录与 carryover

1. 最初布局测试用文本定位同时命中两个 tabpanel 的说明，其中一个隐藏。将定位收窄到当前可见的语义 tabpanel，没有放松可见性断言。
2. 1440px 全文档 axe 发现旧底部播放器“尚未选择播放设备”提示对比度 4.01:1，低于规则的 4.5:1。返回 V2 Home 的同尺寸对照也命中同一 `.player-zone-button > span > small`；相关生产 CSS 未修改。诊断日志为 `/tmp/musicbridge-task-048-contrast-diagnostic.log`。新增页面的 axe 验证范围明确限定到各页面根节点，既有全文档 E2E 保留且通过。此已知 V2 状态问题需要另行处理，不能声称整套应用全状态无无障碍问题。
3. Execution Asset 保留策略 F-01 仍未决定，PRD 为 `FREEZE_PENDING`；技术 Gate A～E 均 `NOT_RUN`。
4. TASK-047 真实歌词验收、Developer ID/公证/安装与 Beta 分发遗留状态不因本任务通过而改变。
5. 正式页面 Owner 体验验收未执行；未连接真实账号、Roon、音乐目录、声卡或录音设备。

## 两阶段自查

先按任务条款核对双入口、无额外页面、无虚构库存与播放隔离；再检查导航类型完整性、组件职责、可访问的 tab 语义、响应式布局和实际 diff allowlist。未派发子代理，不宣称外部独立审查。

## 下一阶段

先做库存领域、持久化与最小录入闭环，再做照片收藏墙与实体音乐库。下一任务需明确 Schema、迁移、Lot/Pool 到 Physical Copy 的幂等转移、照片安全访问和测试边界；不得直接移植原型内存数据。后续 Roon 选曲、源文件验证、推荐、母版、录音、归档与参考目录按各自 Gate 推进。

开发 TODO 面板是当前任务之外的会话可视化快照，不是生产应用页面，不自动同步 Git，也不替代 STATUS 或任务报告。
