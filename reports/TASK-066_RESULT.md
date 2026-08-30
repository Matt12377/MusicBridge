# TASK-066：桌面备份恢复、位置绑定与显式工作库切换

## 身份与授权

- 基线：`abbd2fc230956103a2a22c3c9555e65f9c653a81`（TASK-065 最终锁定）。
- 分支：`codex/task-066-backup-restore-workflow`。
- 实现提交：`5b5dad2abd9116673f4c8883649c6c693dc6f3d3`；报告提交由最终 STATUS 锁定，最终 HEAD 由本机 final-closeout.json 与 TASK-067 base 双重锚定。
- Owner 持续开发授权，允许 GPT-5.6 Sol / High 在互斥文件范围并行。无 push、main 合并、发布；没有真实 Provider/Roon、用户音乐或录音设备访问。

## 交付

1. 录音页原生目录选择、明确范围确认、备份/校验/隔离恢复/基本索引后台工作流。只公开不透明ID与有界摘要；独立维护库持久保存命令、任务、授权及激活账本，不随旧备份恢复回滚。
2. 相同 commandId 相同请求返回原回执，改参拒绝。取消、撤权、超时、冷启动中断保留已有文件，不自动覆盖或重新执行。维护库 v1→v2 迁移保留旧回执，未知文件不接管；同进程与跨进程使用 SQLite 排他所有权，真实 SIGKILL 后由系统释放锁。
3. 恢复绑定已核验的原包ID与清单字节 Hash；复制前重新检查。基本索引给出有界问题明细、真实省略数及五类无法重建的历史事实，不伪造库存、录音完成或历史确认。
4. 已恢复内容以独立新位置绑定解析，不改不可变历史或恢复旧授权。完整再次备份逐对象复核授权，活动源撤权立即中止正在复制的内容任务；元数据工作库仍可使用。
5. 激活单独确认停止播放、重启 Core、丢弃未保存录音编辑。准备时复制新私有工作库并保留旧库/隔离恢复包；preparing→prepared→activating→active，在 Runtime 启动成功后、Core ready 前事务切换指针。中断或失败有界回滚，冷启动不自动重试、不播放。
6. E2E 窗口默认后台隐藏且持续渲染；专项窗口恢复使用 showInactive。仅测试环境生效，不改变正式应用前台行为。

架构细节见 ADR-026。维护记录和应用数据均保留于本机私有目录；报告不包含用户内容、凭据或真实源路径。

## 自动验证

| 检查 | 结果 | 退出码 |
|---|---|---|
| verify：类型、Contracts、Core、Desktop、生产构建 | 77/77、818/818、186/186 | 0 |
| E2E 工作流模块类型 | tsc tsconfig.e2e.json | 0 |
| 安全 | 22/22 | 0 |
| Electron | 4/4 | 0 |
| 完整 E2E | 50/50，无跳过，含固定原生转换器 | 0 |
| Control / Boundaries / Cycles | PASS / PASS / 170 files PASS | 0 |
| diff-check / 冻结候选 | 40/40代码与测试blob一致；额外typecheck接线复核通过 | 0 |

最终仅追加 package.json 将上述 E2E 模块 tsc 接入标准 typecheck，实际新入口重跑 exit0；40个已测生产/测试blob未变，封版清单为41文件。

全量日志为本机 `reports/runtime/task-066-backup-restore-workflow/final-*`，逐项命令和退出码见 final-gate-results.json。固定原生包从前任务既有忽略产物复制，13文件逐 SHA-256 一致；manifest SHA-256 为 `d552121ea60fdc4d86e7e697503e6208152679f1fad58d1ed48a59a79af597cc`，并通过实际 package verifier。这不是分发签名或输出设备认证。

实际合成 Electron 覆盖原生目录选择、未确认不写文件、成功备份和验证、同命令回执丢失重试、隔离恢复、冷启动、两项库存切到备份的一项库存、旧库字节和两项 SQL 记录保留、Core PID 仅切换一次、激活重试不再次重启、active 跨冷启动保持及 playback idle。主任务核对两张720×800截图；相关流程 axe serious/critical=0，无横向溢出。真实子进程 SIGKILL 覆盖 ready 提交前回旧库和提交后保持新库，两例通过；不是实际断电、拔盘、真实用户恢复或硬件录音验收。

## TDD 与审查

各层保留 RED/GREEN。SPEC 第一轮发现激活独立ID关联、恢复包确认身份和活动源撤权缺口并修复；第二轮剩余逐对象授权 P1 由主任务亲自新增两个 RED 复现后裁决：备份每对象重新解析绑定，协调器撤权立即 abort 活动内容任务，61/61 回归通过。另以原 JSON 加空白但旧 Complete marker 的 RED 修复清单原始字节匹配。没有开启第三轮 SPEC；结论为 SPEC_PASS_BY_ROOT_ADJUDICATION，不声称第三轮独立审查通过。

QUALITY：有限子审查未发现已确认阻塞，但未完成全40文件审查；主任务复核DTO、路径能力、事务/撤权、启动与ready、单飞和UI生命周期后裁决 QUALITY_PASS_WITH_BOUNDED_CAPACITY_CARRYOVER。参与者做过实现，不能称全新独立审查。旧三处 E2E 接线失败证据保留在 PROGRESS 和本机日志中，Owner 新授权后才继续；最终50/50不抹除旧失败。

## 接续及未完成

下一任务 TASK-067 必须从本任务最终锁定提交建立独立分支，处理跨 Renderer/应用重启未确认命令 outbox；恢复切库后的旧数据集命令必须隔离，不能自动误发到新库。当前后台任务账本、会话内重试和冷启动读取本身不替代 outbox。

完整 V3、PRD30、A～E、U-01～U-10、真实数据/Logic/输出后端、F-01 执行资产保留政策与 Owner 验收仍未关闭。无自动清理或正式 Plan/Attempt 解锁；TASK-047 真实歌词、TASK-061 发布准入及旧视觉/Beta carryover保留。基本索引仅提供 Quarantine 问题列表，不能凭字节包还原丢失的历史确认。

P2 容量 carryover：普通冷启仍使用2秒ready，已有库同步完整性扫描及prepared内容核验在大库/慢盘可能触发有界失败或回滚。未做规模实测，不阻塞当前合成范围本地封版；TASK-078/Gate E必须建立大库合成矩阵并统一启动超时策略，未关闭前不通过容量/发布验收。
