# RUST-015 普通可选查询的规模边界与全链成本

Owner 已授权持续开发，全部决策和测试由代理完成。仅从 RUST-014 最终报告 `906a3841df3424fff05b6071f4342f312d0c7de9` 接续。分支 `codex/rust-core-015-capacity-cost-validation`，工作树 `worktree/rust-core-015`，外置证据 `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-015-i0qxwbi7`；保护15个原工作树与7个未提交文件。

本期补齐普通固定 v2-2000/4MiB 入口的容量拒绝、完整 Node 回退、边缘帧与全链成本证据。默认OFF、正常Core入口/空args/原Node先boot、Node唯一业务库作者、原Main唯一outbox作者保持。显式可信v3-5000/8MiB仅为已有对照，不扩大普通入口能力。本期不得凭旧warm数据宣称通用加速或迁移完成。

## 文件范围与四个角色

- A：`packages/bridge-core/src/rust-core/optional-readonly-manager.ts`、`readonly-router.ts`、`readonly-sidecar.ts`，以及新 `packages/bridge-core/test/rust-core/optional-scale-*.test.ts` 和对应测试 helper；规模/精确UTF8帧/实际native生命周期与同clock Core计时。仅有行为证据后修容量或收口违约，不降低原guards或回执标准。
- B：新 `apps/desktop/src/main/collection-scale-main-probe.ts`、`collection-scale-core-observer.ts`、`apps/desktop/e2e/collection-scale-dom-driver.ts`、Renderer `collection-scale-observation.ts` 与必要 `useCollection.ts` / `components/settings/collection-readonly-preference.ts` 钩子；原Main/Core接线、诊断编译定义和新增 `collection-scale.vite.config.mjs/.d.mts`；只被动计时与固定诊断动作，生产定义false，不增加公开selector/controller或改变原业务IPC。
- C：新 `apps/desktop/scripts/collection-scale-runtime.mjs/.d.mts`、`collection-scale-seed.ts`、`collection-scale-sqlite.py`、`apps/desktop/test/helpers/collection-scale-evidence.ts`、相应行为/串改拒绝测试和新E2E类型配置；全新合成profile、完整原库事实参照与严格成本准入。规模seed仅在App启动前由Node测试工具准备新合成库，区别于原Main/outbox实际策略写入。
- 主代理：合同/ADR/STATUS/TODO/索引、自动Gate `scripts/ci/verify-rust-collection-scale.mjs`、构建/签名/默认包身份、实际包/普通CUA/软件验证、实现和报告提交。第四sol6.1/high角色随后独审，最多两轮；不再派生代理。三作者同时活动遵守平台并发上限。

文件交叉修改先通过主代理分配。新观察合同以 [固定合同](../docs/contracts/RUST-015_COLLECTION_SCALE_V1.md) 为准。旧014驱动和验证保留，不改其准入规则。

Source07实际5,000项证明普通容量失败后的空打印领取误撤销并发Node查询。A原冻结后由主代理唯一接管 `readonly-router.ts` 与新增 `optional-scale-node-fallback.test.ts` 的两文件修复；B/C冻结内容不改。保留通用写入和关闭代际fence，补同完整版本空领取窗口、非空/异常/版本变/多窗口/OFF/close行为证据，并重新核匹配Core/native测试，再冻结Source08。

Source07冷设置初态取样竞态和Source08最终UI查询未排空即quit分别保留失败。Source09由B仅改Main probe及原观察测试，C仅改evidence helper/evidence测试、runtime事件闭集和必要runtime形状负例（四个既有文件）；主代理仅改逐轮Gate和相应32行为检查。固定同action原status commit/tick/paint与最终动态原UI IPC排空声明，计数从原件独立重算。A10的Source08字节不再变，原业务关闭fence不改；各作者重新冻结当前输入后才进行新实际签包。

Source09成本首拒绝已由唯一只读重放定位。Source10由B仅改Core observer与原观察测试，使routerDispatch成本范围复用原六命令观察闭集；C仅改evidence helper与成本测试，在一次derive/run内复用完整验证的Renderer局部视图。其他B11/C8、A10和Root Gate/32专项的Source09字节保持；不放宽C的原关联断言，不删辅助业务调用，不增加跨调用cache或新字段，当前原件/失败与检查分别保留。

Source10十三轮退出与十二SQL阶段已完成，成本文件已生成，但首次完整准入误将Main在首动作前的唯一页面就绪等待作为动作查找。Source11仅由C改evidence helper及既有evidence测试两文件：初始等待必须是唯一且首个domSettled，先于所有domAction，actionId和settingsStatusSelection均为null、readyState为complete且完整快照合同保持；重复、晚到或带选择的null记录拒绝，不能遮蔽任何已动作的settings-open。其他C8、B13、A10与Root三文件保持Source10字节，不改实际producer或业务动作，也不新增历史10原件的无条件测试依赖。保留原首次准入拒绝与有效RED/GREEN，重新冻结后执行新实际Gate。

Source11初始化85项专项通过，修后consumer对保留Source10完整原件的唯一预检仍拒绝：原后台needs-review汇总回复可晚于目录domSettled，最终drain前已有完整成功回执。Source11未执行新实际App Gate。Source12仍仅C上述两文件，保留初始化修复；既有controlsFor动作检查集合（workload、clear、target、next、previous、detail-open、policy-save、refresh、readonly-on/off）的回复边界只对精确原collection:list、page={offset:0,limit:1}、filter={stockState:'needs-review'}、catalogOrdinal=null及完整唯一invoke/public关联的后台读允许晚回复，request须先于该动作settled、成功回复须先于最终drain。此既有集合内其它目录24/详情/刷新/控制回复仍逐条先于settled，要求目录和刷新的动作必须有真正24limit/正ordinal的原成功前景回执，不能只用后台回执满足。原完整DTO、SQL、路由、warm/status选择及所有UI最终drain不变；不增加producer字段或新的历史10测试依赖。新有效RED/GREEN和唯一修后完整预检分别保留，随后冻结新输入进行最终实际验证。

## 自动验收

Source12新鲜七签包/十三run/十二闭库SQL、完整consumer准入与专用类型已完成，但继承014通用`runCheck`的180秒总预算终止了大型完整证据串改测试。原实际12整轮保持FAIL、部分测试不升级PASS。Source13仅主代理改既有Gate、类型声明与Root门禁测试三文件，新增本任务完整证据测试进程的有限40分钟预算及真实子进程成功/超时/非零/失败取消跳过/不完整TAP负例；通用014 helper、构建/编译/SQL/类型检查以及App600秒、原请求/关闭/30秒UI排空期限均不变。只`collection-scale-behavior`使用新预算，保留原全部测试、单进程并发1、严格零失败/取消/跳过和完整TAP准入；超时保存真实收据且失败，不自动重试。A10/B13/C10源字节保持Source12，重新冻结并进行新的完整实际Gate。

Source13新鲜完整Gate自然退出0，264/264行为、十三run和十二闭库SQL通过；独立标准软件回归有一项旧隔离Main测试因VM上下文缺少新增`collectionScaleProbe`变量而失败。Source14只由主代理为该既有测试添加`collectionScaleProbe: undefined`，两项原测试局部通过；不改变生产Main、三作者33文件、Root Gate三文件或业务生命周期。保留Source13完整Gate、软件失败和旧测试字节，重新冻结1,170程序输入后重跑完整软件六步与新鲜实际Gate。

普通CUA在两份全新100/2001合成profile中使用最终默认诊断关闭包，经原Window菜单显示离线测试窗口。必需11步顺序保持：默认OFF、Node总量、翻页、目标过滤、开启状态、原保护设置写前/写后、写后Node回退、刷新、OFF/ON和原Cmd-Q退出。一次原“保存保护设置”将最低保留数量0改为2，收藏策略保持“正常使用”；闭库SQL须完整验证revision2、唯一领域ledger与原Main outbox成功ACK及全部模型/SKU/库存事实。工程十二run的collector/2策略验证不变。native其它策略选择未取得证据，单列NOT_VERIFIED并留待独立UI可操作性任务；不以修改生产控件帮助自动化，不冒称下拉策略选择通过。此前collector期待工具、误保存normal/0的失败窗口与未保存normal/2的校准窗口原件保持，新的普通准入工具只对上述已声明的数量变更固定预期，不能降低其它来源、完整SQL、关闭或步骤断言。

1. 实际固定普通factory：0/100/2000开启成功；2001/5000/5001保持enabled意图、failed/node与refresh false，后续原Node完整分页/filter/detail仍可用；超限原策略保存只写一次、刷新继续失败、OFF/ON及同profile冷启不截断或复写。
2. 精确snapshot 4MiB±1与编码prepare frame 4MiB±1分开验证；已知本地帧不可编码可在spawn前拒绝，但未知native退出/关闭失败仍blocked，不能重新开启洗掉故障。可信v3现有5000/5001、8MiB、1MiB chunk和总上传预算由单独原合同证明，不冒称普通支持5000。
3. 2000→2001及可信对照5000→5001原Node写后失效/refresh失败；恢复到预算、迟到导出OFF/newON、缓存close失败、第一次请求不重投均核。受控破坏性负例和正常自然关闭分层计数。
4. 同签后native身份、同原库事实/Node版本，六工作量各至少10warm样本，Node OFF/Rust ON交替；firstON、普通refresh、关闭和资源占用另列。产品总量使用Renderer同clock真实触发到最新结果提交及nextTick/paint；工程轮询等待另记。Main与Core各用自己clock，禁止跨进程时间戳相减。速度不作为易抖PASS阈值。
5. 独立闭库SQLite核每个边界全部型号/完整DTO/顺序/page/filter、策略与原持久outbox唯一写入；原件SHA/bytes、source/包完整树/native/pin/实际关闭与日志退出码绑定。正常默认包诊断false、不产生诊断能力。
6. 匹配范围专项、类型检查、完整软件六步、必要实际native回归、实际签包与普通CUA由代理完成；只运行能补缺口的检查。保存失败原件及有效RED/GREEN，两轮独审后独立实现/报告提交，最终Git/remote/WIP复核。

## 交付边界

不扩大5000/8MiB协议、不迁Rust持久化写库/schema/事务、不迁真实用户数据、不接管相邻领域、不替换安装包、不发布，不连接真实账号/Roon/播放/录音。Owner于2026-10-03授权在适当时候推送远端供外部审计：已交付014最终报告HEAD可先推对应分支，015在新鲜验证、独审、实现/报告双提交与清洁身份检查完成后推对应分支；不合并main、不推未提交候选、不重写历史报告的当时push状态。远端HEAD与本地提交必须再次核对。

完整媒体资源包、其他架构/Developer ID/公证与最终Owner使用分别保留。最终成本报告必须如实记录无筛选较慢、刷新摊销及测量限制，再选择维持v2、另任务固定v3准入或新证实热点的后续优化。


## Source15：退出后的原Core诊断输出收口

Source14完整软件六步均0，但新鲜实际Gate在5,000 fresh缺唯一node.exit，十轮Main自然0仍不能替代完整Core关闭证据；该失败及未执行的后续轮次全部保留。Electron官方v43.4.0 UtilityProcess实现会在exit回调的finally清除原stdout全部监听。B使用真实PassThrough复现exit→removeAllListeners→晚到四条原关闭帧，保留有效RED。原失败没有独立fd1写入错误旁证，不能据此宣称唯一根因。

Source15仅改B既有Main probe/观察测试与主代理原index接线三文件。原stdout在exit同步pause，microtask只恢复本观察器三个监听并resume；真正end/close才能完成排空，重复/已EOF保持幂等，不恢复其他监听，不填造缺失事件。原Core shutdown及原Main outbox关闭结束后，仅编译开启的诊断包等待缓存的flushCoreEvidence Promise，包含Main stdout队列flush及原stream EOF，整体固定最多5秒；超时/flush失败发原main.probeFailed并保持Gate失败。默认定义false不新增等待。关闭成本包括此诊断IO排空，不能冒称纯生产关闭时长。原Worker、close ACK、Core关闭Promise/utility exit与请求/业务关闭预算均不改。

A10、C10、Root Gate三文件、Source14旧VM fixture及其他B11输入保持。B重新绑定全部13文件收据，主代理冻结新的1,170程序输入与合同后，执行匹配完整软件与新的七签包/十三run/十二闭库SQL完整Gate；Source13通过不能替代Source15当前证据。随后完成两fresh默认包普通CUA、最终独审和双提交，再按Owner授权推送远端。后续执行包v1.2由新会话在本期最终报告HEAD上先做MBRS-000真实基线/复用/未完Rust主责与阶段准入，完整Rust迁移不因本期交付自动完成。
