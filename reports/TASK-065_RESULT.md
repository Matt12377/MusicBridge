# TASK-065：隔离恢复候选与基本索引重建

## 身份

- 基线：`7dab2bfdaa37d7dcb56e09f66e61f25a14e22420`（TASK-064 最终锁定）。
- 分支：`codex/task-065-archive-restore`。
- 实现提交：`2aa79d23a87f41ad2daacbd063d80ba535a98e98`。
- 报告提交由最终 STATUS 记录；最终 HEAD 由本机 final-closeout.json 与下一任务 base 双重锚定。
- Owner 持续开发授权；0 子代理，无 push/main 合并/发布，不读取真实用户音乐、账号或设备。

## 交付

1. 已验证备份复制为新目录下的隔离恢复候选，保留库存、照片、母版、PREP、执行与归档关系；旧 Source/工作目录/Render 导入根/Archive 授权全部撤销，未结束后台任务恢复为 interrupted。
2. 不覆盖当前数据、源备份、已有候选。恢复收据绑定原包与归一化后 SQLite/Manifest/内容字节；相同回执可复核，候选新写入后重试拒绝并保留新数据。候选不自动激活 Runtime。
3. 支持备份包和原生归档 Root 的 Manifest 基本索引重建，严格检查描述及内容 Hash。字节有效只是候选证据；缺失/损坏返回 Quarantine 问题清单，不移动或删除文件，不生成库存、Frozen 或已完成 Recording。
4. 共享受限文本读取与归档合成 fixture，TASK-064 原14项备份行为继续保留。

架构边界见 [ADR-025](../docs/adr/ADR-025-isolated-archive-restore.md)。TASK-066 仍须处理实际根位置重新绑定、明确激活、原生授权及桌面持久后台任务；完整 E-12/E-13 未关闭，基本索引也不是完整历史恢复。

## 验证

| 检查 | 结果 | 退出码 |
|---|---|---|
| verify：类型 / Contracts / Core / Desktop / build | EOF规范后71/71、735/735、179/179全部通过 | 0 |
| 安全 | 22/22 | 0 |
| Electron | 4/4 | 0 |
| 完整 E2E | 49/49，同生产文件候选，固定原生bundle | 0 |
| Control / Boundaries / Cycles | PASS / PASS / 162 files PASS | 0 |
| 独立 Python PREP 恢复 | 7表相同、6对象、1PREP、0旧授权 | 0 |
| 候选与暂存 | 15允许路径、8代码/测试blob一致、diff通过 | 0 |

独立 Python 对 PREP 合成恢复包检查：7 张不可变事实/库存表逐行与原快照相同，6 个内容对象 SHA-256/字节数一致，1 个 PREP 保留，旧目录授权为0，SQLite integrity_check 和 foreign_key_check 通过。原始备份与隔离候选均保留在本机证据目录，没有提交到 Git。

核心覆盖：隔离与权限撤销、重复恢复、新写冲突、元数据包、确认/重叠/损坏拒绝、复制异常、取消、PREP/执行版本不变、运行任务变中断、缺 DB 重建、重复检查不写入、缺失/损坏 Quarantine、非法 Manifest、原生 Root 布局和嵌套收据描述验证。故障为受控合成异常，不是实际拔盘/断电或真实用户恢复验收。

固定原生 bundle 来自 TASK-064，manifest SHA-256 `d552121ea60fdc4d86e7e697503e6208152679f1fad58d1ed48a59a79af597cc`，复制前后逐文件 Hash 一致；E2E 显式启用它。没有因此关闭真实输出认证或分发准入。

## 审查与证据

SPEC 后 QUALITY 主代理自查，不是独立子代理审查。首次 RED 证明恢复/重建生产接口缺失；自查新增两个行为 RED：原生 Root 布局尚不支持，以及无效 originalDatabase 描述重算收据 Hash 后仍被接受。已实现原生 Root 读取和严格嵌套描述校验，再运行最终完整 Gate。

本机证据：`reports/runtime/task-065-archive-restore`，最终日志 final-*，候选 final-candidate.json 记录8个代码/测试blob；暂存发现共享夹具EOF多空行后仅规范该夹具并重跑完整verify。生产与E2E文件blob未变，其余Gate沿用同生产候选结果，旧/新夹具blob另有记录。保存截图/Playwright产物、独立Python脚本、合成源备份与隔离恢复候选。没有将运行产物或真实路径写入报告正文。首次暂存未通过时尚无TASK-065提交；后续生成的临时报告身份已撤回并重新锚定，实现/报告/锁定提交按顺序分别检查后生成。

## 接续与未完成

TASK-066 必须从本任务最终锁定提交接续。隔离候选仅用于核验；正式仓库打开后 journal/数据改变将触发原收据冲突，不能以自动重试覆盖。根位置映射必须独立于不可变历史，不能删除触发器改写历史路径。Quarantine目前是只读问题清单，持久审核/UI尚未接入。

F-01仍待明确回复，不自动清理、不冻结正式 Plan/Attempt。完整V3、A～E、U-01～U-10、PRD30、真实数据/Logic/硬件与Owner验收全部保留。TASK-047真实歌词、TASK-061发布准入及旧视觉/Beta carryover不因本任务关闭。
