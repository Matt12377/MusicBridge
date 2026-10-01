# MBP-003A：短状态处理与有序播放控制

基线 `a838a00486d113ea086e4edbe229cafe528a9bf7`；分支 `codex/mbp-003a-priority-controls`。首实现 `a6abd4c621a8d7f22ff9aeb705690e69169d9f0c`，准备取消快照补修 `d30bfdb0049e993ef09e424d6ce90f994d5320a8`，最终实现 `c2038e6807f8bccdd12b75366ffcd8dc3c62c25d`。报告提交由包含本报告的独立提交解析。本步骤只完成 MBP-003 的控制部分，A/B 均验收前总计仍为4/11。

播放元数据、URL、Preflight 与 Transport 确认离开长状态串行链。短状态处理以返回句柄隔离外部 Promise，完整 owner/queue-item/Zone/source/token/generation 在实际派发前和迟到结算处核对。Stop 撤销准备和旧确认；未派发取消零注册流、零播放写入，Smart 取消不回退到另一来源。公开同步登记的 pending intent 覆盖同一事件轮中换 Zone 的竞态。

设备写入仍按真实 SDK 回执或原期限有序执行。Transport 确认可以先于 Browse 返回，但独立 completion barrier 保留设备写所有权；取消等待不能宣称在途 SDK 已结束。Stop 使用独立信号和捕获 Zone，未知关闭保留 owner、token 和重试能力，不能开始新的播放或换 Zone。pause/resume/seek/next/previous 与自动推进保留顺序和身份；HTTP seek 保留无 MB owner 时的外部 Roon 控制能力，并接入同设备写链。音量继续使用独立设备路径。

## 失败复现、审计与补修

Controller 慢 metadata/URL/preflight/小批插入四项行为 RED 实际 exit1；runtime 组合中准备/派发所有权、真实 SDK completion 与 HTTP seek 的十一项 RED 实际 exit1，音量原独立路径通过。Adapter 初始九项、同步 hook Stop 一项及最终捕获 Zone 三项有实际 RED 记录。未在修复前执行的新 case 仅记 GREEN，不把全部新增测试概括为 RED。

Agent 最终 Controller105/105、Adapter/helper100/100、runtime25/25 定向通过，各自证据绑定作者源码；runtime定向早于最后Controller补修。独立只读集成审计检查设备 barrier、未知 Stop、迟到身份、自动推进与监听清理。Agent不共享构建、提交或push；均为 gpt-6.1-sol high。

Root补查发现准备取消后 pending command 已结算但公开快照仍 canStop=true；独立内存复现和新增行为case实际 RED exit1。最后 intent 清零后按差异发布，Controller106+runtime25=131项通过。随后独立窄审又定位普通已确认播放成功Stop的同类通知遗漏：idle发布时 stopFlight 尚占停止能力，清 flight 未再发布。Provider/Native 两个订阅快照case实际 RED exit1，matching flight结算后发布释放；失败继续保留未知关闭锁，旧flight不清新flight。Controller108+runtime25=133项最终GREEN exit0。原89个Controller行为断言保留，Fake仅补实际派发hook与外部任务drain；没有删断言或新增skip。

首固定 a6abd4c 原完整 verify exit0：Contracts224/Core1697+原2skip/Desktop975；第二固定 d30bfdb exit0：224/1698+原2skip/975，三层类型与三包构建通过。两轮均有827文件源码前后相同指纹，不能覆盖后续补修。最终 Gate 结果见后表。

执行入口错误单列：cycles-r1使用不存在的verify-import-cycles.mjs，exit1，未执行真实循环Gate；正确verify-cycles.mjs随后通过。首次普通Stop RED在仓库根找不到tsx，exit1，属于命令入口失败；修正bridge-core工作目录后的两项真实断言失败为 stop-publication-red-r2。原始日志均保留，不用入口失败冒充产品RED。

## 最终固定软件验证

| 检查 | 结果 | 退出码 |
| --- | --- | --- |
| 原完整 verify | Contracts224、Core1700+原2skip、Desktop975；三层类型、三包生产构建及Preload边界通过 | 0 |
| Electron 原启动/恢复门禁 | 明确mock，4/4，0skip | 0 |
| 原完整 Electron E2E | 104通过+原4条件跳过（108），0失败/0flaky | 0 |
| control-plane / boundaries / cycles | 全通过；cycles348文件 | 各0 |
| git diff --check | 通过 | 0 |


Node22.23.2、pnpm10.17.1；所有临时、缓存、结果和日志在已确认可写外置LifeWeave。标准verify范围未变，Node --test-concurrency=1及Playwright原worker1避免并发资源竞争。Electron明确mock钥匙串，不使用真实账户。源码定义为git跟踪apps/packages/scripts相关源码与根依赖文件，排序path NUL bytes NUL：827文件SHA256 `cff7fa957c77619b82106a4be9e31bfe988b105f743d14b53142f56ee72ab42d`，最终Gate前后须一致。完整原始退出码、源码身份、审计与文件Hash见 `reports/MBP-003A_EVIDENCE.json`。

## 远端与保留范围

MBR-002 报告 a838a00 后续远端事实：security和Electron E2E通过，verify作业通过；verify工作流因独立dependency-audit失败（11 moderate/7 high）。三项run为36796796364/36796796243/36796796221，原始只读日志保留。依赖修复纳入MBP-009，不把verify作业通过写成整个CI通过。

本任务远端 提交报告后推送开发分支并核对HEAD；报告创建时尚未执行push，CI不计为已通过；以实际远端HEAD与CI状态独立记录。真实Mac/Roon、听感、Provider账号、硬件录音、系统钥匙串Owner验收均未执行；GateB、main、安装App、发布没有改动。当前软件测试为合成I/O与隔离库，不能替代实机目标毫秒或用户验收。

MBP-003B 的 Core持有上下文/先播后补仍未实施；完整队列5000容量和原顺序保留。接续MBP-004真详情分页，后续003B/006/005/007/008/009按原计划继续。下一分支从本报告最终HEAD创建；无关未跟踪apps/desktop/test-results/与worktree/完整保留。
