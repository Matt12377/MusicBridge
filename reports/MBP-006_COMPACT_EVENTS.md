# MBP-006：紧凑播放事件与有界状态重同步

固定实现 `794e59ca8f5077c66a1375b1e6a17cc33c5bffdf` 通过原完整本地软件 Gate。软件进度7/11，随后从本报告HEAD连续接续005、007、008、009。真实账号、Roon、音频、设备录音、main合并、正式App替换/发布均未执行。

- 基线：`78502a338b8c59a6160c1cba3f1b7d3497c18fe7`，MBP-003B最终报告。
- 分支：`codex/mbp-006-compact-events`。
- 首实现：`bdbba037cca1f59c941f95c4f64f5cbf6498afe4`。
- 独立两轮审计补修：`9af9ed81d582f7d1869b70027d23ff9571ab6627`。
- 后续三个提交仅修测试：旧Utility fake补两个null接口；两处seek静态正则新增ready保护且保留Zone能力断言；四项旧E2E注入改合法compact夹具。生产文件未再变。
- 报告提交：包含本文件的提交，以 `git log -1 --format=%H -- reports/MBP-006_COMPACT_EVENTS.md` 解析；下一分支基线为本报告最终HEAD。

## 最终行为

Core只有一个publisher，compact-v1通过私有初始Port握手协商；未请求/未ACK继续原legacy。stamp绑定Core instance、实际Controller owner generation、跨generation sequence、queueRevision、Zone和曲目来源。full/state为低频事实；progress只有stamp与positionMs，不携带队列或曲目元数据。协议严格拒绝非法字段、private身份和伪枚举，不双发旧事件。

Utility seed在发送前最后同步采样、验证；Main必须完成原worker/credential恢复并在当前route同步接收seed后才能ready。旧child回执不得确认新child，compact progress不再触发tray全状态读取。缺ACK使用既有旧协议；已ACK但seed失败不能无限回退或装成ready，保留原重启预算和确认旧child退出屏障。

Renderer单reducer接受合法事实。旧序号/旧owner回执不覆盖新事实；gap/未知queue revision触发有界一次只读恢复，失败不在每个tick重试。ready允许新instance bootstrap，普通delta不能自行授权换instance。恢复阶段最多保存两条可合并记录与连续覆盖元数据，stage上限8MiB；合法5000条full仍完整接受，不以该stage预算截断正式队列。

position tick只更新位置，队列/track引用保持，不触发收藏、匹配、最近或descriptor扫描。clock identity加入instance与实际owner，同ID新owner可以重置；同owner旧seek ACK不把目标伪写成设备位置。拖动期间显示草稿，收到同owner设备位置才结算；失败、新owner或5秒观察期限解除等待并提示。legacy恢复清掉compact旧队列。

## 原范围验证

| 检查 | 最终结果 | 退出码 |
| --- | --- | --- |
| 完整verify | Contracts247；Core1824通过+原2跳过；Desktop1078；三包类型/生产构建通过 | 0 |
| 原mock Electron启动/恢复 | 4/4 | 0 |
| 原完整Electron E2E | 108项：104通过、原4条件跳过，零失败/零flaky | 0 |
| control-plane / boundaries | 通过 | 各0 |
| cycles | 351文件，无新增循环 | 0 |
| 整批git diff --check | 通过 | 0 |

847源码文件，Gate前、verify后和全部Gate后SHA均为 `868efd15caebc17a92628f0ebdcde7fa8a4291b8777f979e058aa344dd332827`。每次原始实际退出码、源码身份、37个本任务源码/测试文件以及作者/审计日志Hash见 `reports/MBP-006_EVIDENCE.json`。没有缩小原范围、删保护断言或新增skip。

作者最终定向：Contracts247、Core188、Main81、Renderer87、Utility58、实际Preload9、Attempt原整份96、两seek原规格38。隔离production类型检查不覆盖旧test fake，首轮原全量暴露了该缺口；最终标准verify覆盖三包production与test类型。

50/500/5000条稳定队列各100tick，实际production publisher+typed validator+JSON合成结构检查：compact每组25152字节、最大单事件253字节、源queue字段读取0。当前legacy单full/tick同夹具总字节965158/9370358/94320558。该测试首次GREEN，不伪称RED；不混用001历史双tick基线，也不冒称真实Electron wire、Roon毫秒或RSS收益。

## 独立审计与失败保留

两轮独立审计结束，指定33文件内无未解决P1/P2。唯一真实P2是：较新full已恢复ready，旧恢复flight随后失败会撤销新基准、禁用控制并再发read。原独立RED保留；修复通过request token废弃旧成功/失败/null/older/finally，同时保留真正失败的一次自动恢复与显式重试。R2窄行为35/35，包括真实Utility+Supervisor+Session合成跨层和实际Vue mounted进度组件；不等于完整软件Gate或真实设备验证。额外CI夹具窄因果3/3，完整Attempt96由Root执行。

最终三次测试兼容delta发生在审计提交之后，由Root自查并最终原全量Gate覆盖；没有声称独立审计已覆盖这些后来变化，也未开启第三轮审计。

首个固定9af9ed8原verify退出2：旧Utility typed fake缺两个新增接口，在Core test types停止，测试/完整build未到达。补null后的b03dd1f原verify退出1：Contracts247、Core1824+原2skip通过，Desktop1076通过/2静态seek断言失败；生产已新增“Zone能力且同步ready”保护，旧正则只允许旧文字。两断言更新为双条件，其他保护不变，38/38通过；最终新SHA重新跑原完整Gate，前两失败原始日志保留。

固定889a00e原verify247/1824+原2skip/1078与三构建、mockElectron4通过，但首次完整E2E退出1：100通过、4失败、原4条件跳过、0flaky。四项直接注入旧playback.changed，compact合同明确忽略；作者仅修同文件helper和四夹具，先读实际Main trusted seed保留同instance，full/owner、queueRevision、单调sequence、100+100 progress及低频state按协议发送，get-state/get-stream/控制ACK共用同一原子stamp。46条原断言和两循环逐字保留；Root实际定向四项4/4退出0。首次JSON与完整失败产物另名保留，不被后续结果覆盖。最终794e59c重新跑原完整Gate。

旧tsconfig.e2e.json没有包含v1-ui.spec.ts。新增helper和四精确block隔离noEmit退出0；显式全文件检查退出2，与原文件30条旧诊断完全相同，全部在原470–3202行、本次修改外。该旧类型债务未在本步修掉，标准完整verify和实际Electron通过不能冒称该文件全量类型通过；009接口收口继续评估。初次外置基线副本漏两个动态路径的4附加错误日志也保留，不当源文件错误。

新增真实RED还包括严格合同枚举、Utility/Preload缺协议、Core compact缺方法、Main foreign/旧route、Renderer重连和实际mounted拖动位置。入口、ESM、类型、非法监控引用/夹具失败分别记录，不把它们当生产行为RED。

## 上一快照远端与边界

003B报告78502a3远端已结束：security/Electron E2E通过；verify作业失败，Core1772通过、28取消、原2跳过，没有assertion fail。首项pre-spawn超时测试等待entered未结算，后续被父取消；不能说是28个生产缺陷或已确认历史问题。独立受控复现确认100ms可能在authorize/FS/输入阶段先到，provider start尚未进入；无法据远端日志定位Linux实际慢的具体步骤。

本批将该目标测试确定性化：只mock setTimeout，等待真实provider entered后推进原100ms操作和20ms关闭期限，并用Promise.race使提前结算立即失败；cleanup消费从未使用的startGate拒绝，先reset计时器。所有原资源/状态断言逐字保留，生产Attempt及输入协调文件等于基线。该变化是测试阶段对齐，不是设备关闭生产修复或真实录音证明。

上一快照dependency-audit仍失败11moderate/7high；009继续闭合，当前不标全CI绿。本分支报告创建时远端CI未执行，push与HEAD核对单列。

实际SDK不可撤销工作预算直到实际settlement才释放；合成保留字节不等于RSS。旧协议回退不具有compact等价性能。真实Provider/账号/Roon/音频、设备录音/GateB、Owner验收和发布未执行。

## 回滚

受信环境 `MUSIC_BRIDGE_COMPACT_PLAYBACK_EVENTS=0` 禁用Main compact请求，Core无请求保持原legacy。IPC_VERSION仍1；响应only新stream字段旧请求不可注入。回滚不增新Owner、不清业务数据、不承诺等价性能。
