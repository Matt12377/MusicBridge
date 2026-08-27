# TASK-049：库存领域、账本与录入结果

## 结论与边界

库存基础与正式录入闭环通过本地自动验证。录入、型号/时长归组、批次数量、单盘编号、旧录音登记、预留/取消、不可用状态与封存保护已接入真实 Main → Core → SQLite 通路。

使用合成数据验证，不等同真实库存验收、完整 Gate C、V3 完成或 Owner 接受。照片、原版 CD/磁带与 Roon 关系、录音选曲、音频引擎、归档和参考目录仍待后续任务。不操作真实账号、Roon、音乐文件或声卡；无 push、main 合并或发布。

## 身份

- 分支：`codex/task-049-v3-inventory`。
- 基线：`5ed814a7f65bc02c200039379006929f4aced112`，TASK-048 最终状态提交。
- 实现提交：`88693078df507b1f6893e26c48ca0a366dba6491`。
- 本报告独立提交；报告 SHA 由后续只修改 STATUS 的锁定提交记录。
- 下一任务 TASK-050 从最终 STATUS 锁定 HEAD 建立，范围为照片、代表图与收藏墙，不从旧 main 绕过依赖。
- 复核时远端 main 为 `90d0aa8aa7f156c6ecfc6f366eea698f8e4d6098`；远端无本任务分支。

## 实现与约束

1. 私有 data 目录中的 `collection.v1.sqlite`，Node/Electron 内置 SQLite，无新增依赖。严格 schema、外键、WAL、版本检查；未知版本/损坏返回不可用而不清库。
2. 型号、时长 SKU、批次池、实体副本与不可修改账本分开管理。编号按 Cassette/DAT 独立序列，录入不批量预分配编号。
3. 池转单盘的数量、ID 和账本在同一事务提交。重复 UUID 返回原结果，内容冲突拒绝，旧 revision 拒绝。两个独立进程并发提交同命令仍只计一笔。
4. 未分类不转成空白；旧录音登记只保留“旧录音”来源，不创建录音成功证据。已录、未知或不可用不能预留；保护策略与保留线在 Core 校验。
5. 公开合同有界分页、枚举与数量校验；不向 Renderer 暴露数据库路径、SQL 或内部异常。库存延迟打开，不依赖 Provider/Roon 登录。
6. 正式 UI 使用原有双入口。录入弹窗、型号卡片、批次与单盘详情、保护设置、错误/重试及分页均走业务 API。保存回执未知时锁定表单并保留原命令重试，不把异常当作成功。

## 验证证据

本轮可确认的行为 RED：正式 Electron 成功启动，新增库存 E2E 在“添加磁带”`toBeEnabled()` 失败，实际按钮为 disabled，exit 1。随后实现录入 UI 与通路，最终该流程 GREEN。模块不存在/编译失败不作为行为 RED。

最终验证显式将 PATH 固定到 Node **22.23.2**，使用 Corepack pnpm **10.17.1**。早期 Shell 误用了 Homebrew Node 25.6.1，结果不作为下表的最终版本依据；以下完整 Gate 已在 Node 22 下顺序重跑。

| 命令 / 范围 | 最终结果 |
|---|---|
| `corepack pnpm@10.17.1 verify` | exit 0，类型、单元、生产构建通过 |
| Contracts / Core / Desktop | 30/30、441/441、163/163 |
| 库存仓库 / 新增库存 IPC | 17/17、2/2（已包含在 Core 总数中） |
| `corepack pnpm@10.17.1 test:security` | exit 0，22/22 |
| `corepack pnpm@10.17.1 test:electron` | exit 0，4/4 |
| Desktop `playwright test` | exit 0，28/28；其中 V3 6 项 |
| control-plane / boundaries / cycles | PASS / PASS / PASS，101 files；旧 control-plane 仍检查 WAVE-3 |
| WAVE-5/STATUS/分支/基线/文件范围 | 一致 |
| `git diff --check` / 暂存差异检查 | exit 0 |

### 关键行为

- 8 盘未拆库存 → 7 盘池 + `MB-C-00001` 已拆单盘，总数仍为 8；预留/取消不改变总量和 ID。
- 完全退出 Electron，使用同一个隔离测试目录重新启动后，库存、实体编号与封存设置仍在。
- 旧录音 3 + 未分类 7：登记一盘旧录音后为 2 + 已录副本 1 + 未分类 7，总数 10；未知副本不显示“预留”。
- 数据库已提交但 Main 回执被测试注入故障：UI 保留原命令重试，最终只录入一次。
- 读取失败显示故障，不能显示空库；读取恢复后可以正常录入。
- 提交前异常及独立子进程退出后，重开保留旧余额与序列；未知 schema 和符号链接目标不被覆盖。
- 720×480 下表单与详情无横向溢出；新增页面/弹窗 axe critical/serious 为 0。主代理查看了真实 Electron 截图，不代表 Owner 认可美观。

最终日志：`/tmp/musicbridge-task-049-final-{verify,security,electron,e2e}.log`。本地快照、截图及 Playwright 产物保存在忽略提交的 `reports/runtime/task-049-final-8wxge9gw/`。任务未删除用户原有产物；本轮生成的 test-results 移入证据目录。

## 两阶段自查与调试记录

先按任务范围核对数量守恒、未知状态、保护规则、持久化、独立测试目录及 V2 不回归；再检查 IPC 白名单、请求校验、异常脱敏、事务边界、分页和组件职责。未使用子代理，不宣称独立外部审查。

桌面接线期间修正了 Vue 模板直接引用 `window` 的作用域问题。保护策略测试的 exact 标签定位包含 select 内文本，改为页面已暴露的 `combobox` 角色和准确名称；未放松保护效果断言。Preload 白名单测试同步增加了六个明确业务方法。最终 Gate 另行串行执行，避免 Electron 启动测试的构建与 E2E 共享 dist 发生干扰。

## 保留事项

- 保存回执未知的重试 UI 当前限于现有页面会话；账本幂等结果已跨重启持久化。跨 Renderer/应用重启自动恢复未确认表单操作的 outbox 尚未实现，后续恢复任务必须覆盖，不宣称完整事务交互恢复已完成。
- 当前 schema 为首次版本初始化与未知版本保护；后续照片/音乐关系扩展必须新增旧版本迁移测试。
- 已录旧磁带的标题、曲目、J-Card 和双库内容展示待后续实现；现阶段不虚构内容。
- V2 闲置播放器提示对比度 carryover、TASK-047 真实验收、F-01 执行资产保留策略、签名/公证/分发与 Owner 验收全部保留。
- PRD 仍 `FREEZE_PENDING`，A～E 完整 Gate 不因本任务通过而标 PASS。
