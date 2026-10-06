# MBRS-006 最后正式只读 R2

结论：**PASS（有限软件候选只读复审）**。R1的4个根因全部闭合；没有剩余可操作 P1/P2。本轮不重跑构建/测试，不新增代理，不开始R3。最终Root Gate、提交/CI、真实Roon和Owner验收分别成立，不能由本PASS代签。

## 冻结身份

工作树 `/Volumes/LifeWeave/Developer/CommandLine/worktrees/musicbridge-mbrs-006-local-audio-input`，分支 `codex/mbrs-006-local-audio-input`，base/HEAD `cce8594f4b6e9872afd576bb1b032f526c93af72`。`writer/FREEZE_03.json` SHA256 `40eb968e389e1667e16f5b78c330ce170803095c37e09fa1a4beb6de37dd8b45`，实际54文件哈希全部相符。与FREEZE_02比较只有6个声明增量（5修改+1新增），其余48文件不变；按实际逐文件比较，不把继承的旧supplement字段当此次不变数量。完整实际哈希、Root文件读取快照、RED/GREEN日志哈希在R2_IDENTITY.json。

## 四个根因闭合

| R1根因 | R2源码与行为证据 | 结论 |
|---|---|---|
| P1 shutdown二次调用提前resolve/exit | `runtime.ts:1166–1182` 所有调用返回同一flight；先登记Promise再同步seal，cleanup/拒绝由同一flight承载。`test/mbrs006/runtime-shutdown.test.ts` 走实际默认Node utility fatal handler和原runtime，故意阻塞实际已打开FD read；fatal未越过quiet，FD关闭才记录受控exit72，Owner.close拒绝变体及后续shutdown仍失败。有效RED `writer-r1-shutdown-red-04` 0/1，修正后同聚合两变体通过。 | 闭合；未把受控exit当真实进程退出证据 |
| P2旧native分页context侵入本地三动作 | `bridge-controller.ts:684` PLAY_NOW受理同步cancel原context/pending lease；`:692–706` APPEND/NEXT在原mailbox捕获后退出mailbox，沿原queueEditTail/contextTask/readQueueContext/final enqueue物化。`:950–1005` 每await后和最终commit核原intent/target/fence，保留容量/排序，避免自己等待自己。`controller-local.test.ts:105–119` 实际原native lease held-page→三动作，PLAY_NOW旧页不覆盖；APPEND/NEXT待完整物化才承诺，位置分别尾部/下一首；不产生native新play。有效RED三case失败，最终通过。 | 闭合 |
| P2确定终态仍local Playing | `bridge-controller.ts:488–494` 同owner terminal先有限FAILED/CANCELLED/ENDED/OWNERSHIP_LOST，再cleanup；`:727–730` 写有限error_code，`:788–793` 预派发或确定媒体错误失败，丢回应仍UNKNOWN；`:2335–2340` 主动取消补有限终态。`controller-local.test.ts:86–94` MediaError/StoppedUser/主动Stop及actual fixedFD signature不符分别核叶、ownership、error、quiet和公开validator。非local startItem仍先清local叶，实际旧native入口不继承本地身份；迟到A guard不放宽。有效RED四终态失败，最终通过。 | 闭合 |
| P2target ABA复活 | `adapter.ts:705–710` capture绑定单调localTargetEpoch；`:1529` 当前Zone删除、`:1586–1613` 实际相关输出组/选中目标结构变更不可逆增代际。current恢复同指纹仍旧epoch无权。普通state/seek及无关Zone不增长资格。`controller-local.test.ts:95–103` 延迟capture跨删除恢复/改组恢复零begin/send，无关Zone+state/seek正例仍可派发。有效RED两ABA失败，最终通过。 | 闭合 |

三个产品修正仍在原Controller/Adapter/runtime；没有第二播放器、第二队列或新SQLite作者。原Owner accepted signature/修订、不可逆SAB票据/短claim、005固定FD及真实quiet合同不变。真实core_id仍来自锁定SDK，公开target只作约束。Main/preload九字段、legacy capture/send前unsupported、compact-v1安全身份与实际consumer、云收藏/云歌词/最近数字重播隔离未漂移。主动停止依然只定向自有AudioInput session，不增加全局Transport stop。

## 已有证据的只读核对

`FREEZE_03.r1Checks`六项日志SHA256均匹配，各声明退出码0。最终新Core聚合41/41、旧context/callback/runtime-compact/Rust utility组合128/128、最后flight登记顺序后runtime/Rust utility86/86，均fail/cancelled/skipped/todo=0。Core构建、含test类型和cycles为0。contracts2、Desktop3未受这6增量影响，保留原冻结证据，因此本任务新增总46；128和86有重叠，不能相加成独立回归总数。

失败证据保留：有效shutdown RED 0pass/1fail；terminal+target RED 12pass/6fail；context RED 0pass/3fail。Gateway未监听、fixture计时和类型故障不冒称行为RED。复审未执行这些命令，只读日志和源码。

Root Gate读取版本已增加原context/callback/runtime-compact三文件为25个mandatory回归；仍沿有限360秒总/180秒阶段、完整TAP、fresh编译/worker/types及输入/28fresh输出绑定，不改变原真实AT kind。最后读取的Scope已冻结为41/349/58/92四组、共540项；该数字是最终Gate声明范围，不冒称本复审实际执行540项。具体冻结状态在R2_IDENTITY。Root最终Gate运行及source/output drift另由它的收据确认，本复审不宣称Gate已通过。

真实Roon/live AT-01/04/07、20真值样本、真实pause/seek/接管、音频/信号/数字输出/gapless、LAN/NAS部署、普通App和Owner验收均维持未验证；没有003新规模、源文件写入或main安装发布。此PASS仅表示冻结有限软件候选与四个已确认修正可接受。
