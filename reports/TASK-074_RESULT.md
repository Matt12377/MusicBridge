# TASK-074：正式录音 Attempt 状态机

## 身份与授权

- 基线：`017dfef43d615b26db770c206dec2e38105bd1e5`，分支`codex/task-074-recording-attempts`。
- 实现提交：`5a322b603b6072a549f100189ab977da8d4b73c7`。报告提交由最终STATUS锁定；下一任务从本任务最终HEAD建立独立分支。
- Owner授权持续软件开发至079，GPT-5.6 Sol / High并行按路径分工；只本地提交，不push、不合并main、不安装/发布。实机与Owner验收单独保留。

## 交付范围

1. 固定Plan/contentHash/physicalId/Execution及每个非空A、A/B或DAT Program的帧数、recipeHash、音频与PCM hash。源EOF、提交/消费、后端排空、引擎停止提交、停止ACK、清理静止与实体停止分别保存。三层完成必须全部成立且无未解中断；迟到成功不覆盖首终因。
2. A面软件排空后明确确认实体停止，再确认翻面、单独请求BeginB；不存在自动续录。DAT仅Program，空B不制造执行。崩溃/重启只将未结束Attempt增加一次Interrupted，绝不自动重播。
3. schema19不可变事件/commandId回执与头投影原子提交，严格预算、25条分页、真实18→19迁移与回滚。打开/备份/恢复验证完整事件链、命令与投影；损坏副本在journal变更之前拒绝，原文件字节不变。恢复不以Interrupted修复被篡改的头。
4. 可能写入的实体保留占用，不由旧规划释放或一般手工更正变回blank/erased；数量、实体编号和旧历史不变。同实体再次Begin须等待075明确处置；其他实体的规划不受历史锁死。
5. 六个有限IPC不进入可自动重放的outbox。Preload固定窗口加载时库身份并先clone请求，Main先可信来源与严格信封，Core要求并验证scope，异步准入后/driver前复核。Stop不带易变revision，且写入失败也停止自建driver。close先到的晚句柄仍关闭；超时不伪造静止事实。
6. 明确Plan下的Attempt面板分开显示空历史、读取失败、状态/三层事实/各侧独立证据；不默认选历史、不自动刷新或操作。刷新失败保留仅供停止的明确身份，不允许旧事实人工确认。迟到读取不能覆盖新命令回执；键盘焦点不抢回已移开的用户。

**生产准入没有变化：Gate B NOT_RUN / formalReady=false。** 正常和合成应用Runtime均不注入正式provider，Begin拒绝且零新增；构造器受控driver仅在专用测试库使用。没有设备枚举、打开、测试音、录音、真实Source/账号操作。

## 最终自动验证

| Gate | 本轮结果 | exit |
| --- | --- | --- |
| canonical verify：类型、单元、生产build | Contracts147 / Core1005 / Desktop483，全部通过，零skip | 0 |
| 安全 | 29/29 | 0 |
| Electron启动/crash/保险库/冷启恢复 | 4/4 | 0 |
| 完整E2E | 83/83，双native开启，零skip，179.43秒 | 0 |
| control / boundaries / cycles | PASS / PASS / 224文件PASS | 0 |
| 固定原生资源 | 16/16原SHA256不变，无重新生成 | 0 |

候选49个代码/测试文件，指纹`cdf60ab56579ac0ca259f79b8fd9a6fbbe6683d5b180c2101d3ef72dfe678230`；16个原生pin全部保留。最终verify后仅新增两处旧E2E版本断言18→19和截图取景，生产与单元文件不变，E2E类型重新通过。

所有命令、退出码、原失败输出及截图在`reports/runtime/task-074-recording-attempts/`。运行目录独立，不覆盖旧test-results或073证据。

## RED/GREEN与审查

- 合同：模块缺失/有限API RED→13新合同场景GREEN，联合34focused；终态与跨字段一致性另有真实RED。纯状态机最初缺模块RED，行为18PASS/2FAIL→20/20，root重跑20/20。
- Store/coordinator：停止写失败仍停driver、start/close竞态、首终因/事务回滚、预算保留、终态copy拒blank和损坏恢复原字节保护均保留RED/GREEN。最终新focused46/46、旧schema回归253/253；root整体Core1005通过。
- Main/Preload/Core：scope缺口RED→Main1/1、Preload9/9、Core2/2，完整utility41/41。测试tuple类型由6个TS2322真实RED，经单行修复到types0。
- UI：Attempt19+既有Output19+Plan5，共43focused通过；刷新期间停止消失、迟到读取回退修订的两条RED已修。Main受控历史E2E fixture的面名验证和实体停止事实断言经非作者审查补齐；它不是Core录音运行证据。
- 非作者SPEC先QUALITY：合同/IPC最终PASS，Runtime PASS，state由root审查PASS，UI代码由root审查PASS；Core PASS附R023 P3规模风险，已纳入078，不因Minor开启新循环。E2E与ADR SPEC PASS/QUALITY2关闭唯一测试假阳性P2。各新增delta最多两轮。

完整E2E首轮81/83，两处失败均为旧TASK069/070测试期待schema18而实际19。仅各改一个版本终点；库存数量、源行、账本、外键与冷启动断言不变。新增三场景首轮即通过；随后完整复跑保留原全部失败产物。root已查看空态/错误及720三层事实/侧面证据、1440事实取景，未见横向溢出，指定区域axe serious/critical为零；仍不等同Owner视觉验收。

## Carryover与接续

R023：每次Attempt写入同步全历史重演存在规模风险，目前没有耗时测量或实时保证。TASK078必须测量并优化进度/Stop/冷启，真实driver接入前解除；当前生产无provider，不据本地行为通过启用正式输出。

R020大库冷启、R021旧包CDP正常退出FAIL、R022实际HAL静止/无声测量均保留。TASK073完整实机验收、真实RME/Apogee具体型号与Sony卡座接线/测量、Source Roots、Logic、Provider/Roon及最终Owner接受均未执行。F01保守永久保留已确认。

TASK075接续同一实体的不可变正式档案、检索与双库幂等登记，并提供明确内容处置/重录边界；不新增库存、不改旧Attempt。075只读准备已完成，实际实现须在074最终HEAD新分支。076/077/078/079完整队列保留。
