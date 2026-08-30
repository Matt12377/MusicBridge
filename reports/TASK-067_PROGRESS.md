# TASK-067 实施与故障证据

日期：2026-08-28。基线 `a64a31a6f7fca9ae34ea112faba1f9c7a2c530e2`，分支 `codex/task-067-command-outbox`。Owner授权按GPT-5.6 Sol / High互斥范围并行，完整V3队列不变；不push/main合并/发布，不读取真实Provider/Roon/用户文件或设备。

## 初始实现与行为RED

主任务负责Main/preload/监督器/E2E，智能体分别负责合同与Core数据集边界、SQLite私有outbox、恢复面板与原生专用executor。所有领域写命令均使用有限白名单，52个稳定commandId入口逐一接线，旧无scope领域写handler删除。

Contracts、Core身份/文件替换、独立存储/排他/冷开、显式重试、跨库激活回执、Main IPC、preload上下文与原DTO捕获、监督器scope/长任务timeout、UI生命周期均保留对应RED/GREEN日志。目录为本机 `reports/runtime/task-067-command-outbox/`。日志不包含用户内容或凭据。

首次IPC用例的SourceRoot合成返回值误用 `{revoked:true}`，严格结果validator拒绝；按真实合同修正fixture后通过，没有放松生产校验。

## 首轮Electron故障与修复

初次三个专项用例未通过：preload已定义outbox API但漏传createPreloadApi的四个恢复方法，导致冷启查询入口不可用；这是实际接线缺口，已补齐。另一个测试在Electron evaluate VM动态import node:sqlite缺少回调，改用已有进程的getBuiltinModule，没有添加生产fault hook。

第二次专项3/3通过，覆盖结果写盘失败后Renderer刷新、真实Main SIGKILL后应用冷启，以及备份恢复激活后的旧命令隔离和只读激活回执恢复。故障发生在Core已提交而Main尚未持久成功回执的窄窗口，Core库存账本每个原commandId仍仅一条。跨库激活回执恢复前后Core PID不变；旧Renderer新写被scope拒绝，完整reload后新scope才能写。原生选择与目录全部为临时合成数据。

旧E2E的13处回执丢失注入改到新outbox入口，按固定request.command过滤，只丢首次目标成功回执。原业务expect表达式逐条对比保留。

第一候选完整Gate：Contracts82/Core827/Desktop263、安全25、Electron4、完整E2E53（无skip）、E2E types/control/boundaries/cycles/diff全部exit0。它不是最终批次修复候选的验证，证据保留在 `final-*`。主任务查看720截图，未确认及跨库提示没有横向溢出；初始两类outbox流程axe serious/critical为0。

## SPEC第一轮与有界修复

第一轮有限SPEC静态核验初始41文件候选，52命令与52个单项preload路由一致；发现P2：PREP一次停止核对会在Renderer闭包逐个await撤权，第一项回执未返回时刷新可丢后续已确认意图。该项属于原任务范围，不能以单API覆盖代替复合流程。修复为专用1～3项同scope撤权批次，先一个事务保存全部，再开始任何执行。每项独立幂等、结果未知可人工恢复；不自动投递、不删除源文件。

另外主动复现合法可选physicalId显式undefined与JSON省略语义不一致导致指纹读回失败：RED为OUTBOX_UNAVAILABLE，最小归一修复后省略/undefined等价，未知undefined字段仍被validator拒绝，存储/服务30例通过。容量边界已补充：只在容量不足时清理已确认成功或明确放弃跟踪的outbox记录；未确认记录、业务账本和文件保持，清理与新请求事务一起回滚；不改变F-01。

第二轮只核对上述有界修复、接线与最终冻结候选；不安排第三轮。当前最终结果与提交身份以TASK-067_RESULT和STATUS为准，本文保留中间失败，不将中间exit0冒充最终完成。

## 最终候选E2E夹具修正

批次候选44文件verify 82/827/279、安全27、Electron4和类型检查exit0；完整E2E为53pass/1fail。唯一失败发生在新增批次用例的故障注入前：它只预置合成prepared_selections，却调用listPreparedSelections；Core要求完整Logic preparation job上下文而拒绝。数据库证明outbox为空，尚未发起批次。

主任务追踪selections→preparationContext后，仅修正该测试的读取oracle：通过独立SQLite只读连接逐ID核对两条public/root授权；记录缺失直接失败，不放松生产校验，不伪造完整音频准备流程。另43文件blob未变。专项真实SIGKILL用例1/1通过（13.7秒），断言冷启两项pending、不自动撤权、人工恢复原commandId各一条ledger、源文件字节不变。证据batch-oracle-e2e.log；旧失败保留在batch-final-e2e.log。

第二轮有限SPEC通过，范围内P0/P1/P2=0；结论覆盖继续冻结的43项，单个E2E oracle由主任务另行验证。未安排第三轮SPEC。新candidate-release-final.json为44文件最终验证候选，release-final-*仅为本机日志前缀，不执行发布。最终结果报告将记录该候选全量Gate及QUALITY裁决。

## 最终自动验证

release-final完整顺序Gate全部exit0：Contracts82/Core827/Desktop279、安全27、Electron4、完整E2E54无skip、E2E types/control/boundaries/cycles178/diff。每个Gate前及结束后核对44文件blob一致；固定原生bundle13文件SHA256复核一致。主任务查看最终720未确认操作截图；SPEC第二轮与QUALITY限定审查/主任务裁决通过。提交及clean身份另由结果报告、STATUS和final-closeout.json锁定。
