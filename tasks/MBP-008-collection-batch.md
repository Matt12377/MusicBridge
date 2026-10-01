# MBP-008：收藏批量读取与操作内索引

正式任务合同：从007最终报告8253bc19c2f473943b304ac9418ad22f71a65f79建立codex/mbp-008-collection-batch。先取得固定源码合成基线，Root明确作者启动后实施。本轮Owner已授权连续推进，保留Electron/Vue/Node TS，最多三名gpt-6.1-sol high作者，必要时独立审计最多两轮；不使用gpt-6-sol。

## 范围与文件所有权

Repository作者独占packages/bridge-core/src/collection/repository.ts和新增test/collection-repository-batch.test.ts。保留现有SQL筛选/rowid倒序/分页，页面型号一次取完整row，页内ID每50块批取SKU、池、实体和照片元数据；恢复原页顺序逐项DTO校验。pool与physical分别聚合，不JOIN倍增；reserved/unavailable仍held；NULL分钟、featured照片优先与rowid fallback、revision/未确认描述原样。单型号路径不改，可作交叉对照且新增手写数量/顺序保护。

Progress作者独占packages/bridge-core/src/collection/collection-progress-store.ts与test/collection-progress-store.test.ts。每次operation新建局部上下文，distinct revision完整解析/guard一次及reference索引；批wants、historic(id,version)、model evidence，保留旧revision labels/currentHead/JSON原次序。current entry按catalog顺序、active wants按id、matches按原JSON；aggregate单遍，brand和canonical series排序原样。指纹输入、不可变历史/ledger、CAS、BEGIN IMMEDIATE/beforeCommit/ROLLBACK、损坏拒绝、未知和额外长度及库存守恒不改。预算每次读前、写后仍检查，不持久缓存；合并同表count/sum/max不删除任何UTF8/数量/JSON/当前目标上限保护。reference-catalog生产文件、contracts、migration与其他业务不属作者写范围。

Root独占任务/进度/报告、合法合成baseline、源码身份与实际退出、Utility控制组合/worker裁决、最终原全量Gate和Git。测量作者仅外置工具，不写生产文件。作者禁止共享pretypecheck/pretest/build；只direct tsx及外置隔离strict noEmit。源码修改须Root明确开始消息；先取得原固定baseline，不能把未知工具失败或超时当代码RED/性能数字。

## 测量与验收

50/500/2000单书、5000总库拆2000+2000+1000；progress limit25，不改变生产上限。通过公开receive/materialize/catalog publish/setMatch/want/capture创建外置合成WAL DB，准备成本与测量分开。read/warm/cold新owner/cross-secondary实际读取、首中末合法页、实际SQL/完整catalog parse bytes、操作与DTO、unpatched 5原样本/median/p95、输出canonical一致、受保护facts/hash分列。cold激活含真实open/recovery/verify与公开空页SQL，不称OS冷磁盘。计数不覆盖SQLite内部扫描、显式for/Map lookup，另需局部结构行为证据，不能将filter0写总工作0。

默认60秒父进程截止，真实exit/signal/partial保留；容量/超时不自动重试、不删历史凑规模。源码和contracts实际dist在运行前后核一致；基线失败或工具不完整要准确保留，Root据原因调整而不是缩小产品合同。故障检查使用独立合成副本，避免修改用于前后对照的固定读夹具。

Node MessagePort + 生产attachCoreRuntimePort、合成runtime暂停/恢复测量读取与控制同时排队；不是纯timer代理，也不称真实Electron/Roon/听感。关停回执/资源关闭与owner关闭需核实。先做局部优化，若仍有影响控制的同步重工作，根据新鲜测量决定完整owner worker或进一步优化；worker不能拆半个DB/coordinator/activation generation/lease/barrier/shutdown，也不能绕准入或凭空假定读可取消。

原progress/catalog/repository/migration/状态与库存测试保留；新增缺陷或结构RED/GREEN、严格类型、独立审计最多两轮，最后固定原verify/mockElectron/全108E2E/control-plane/boundaries/cycles/diff；不新增skip或删保护。只有完整软件证据与报告才计10/11，从最终报告HEAD接009。真实账号/Provider/Roon/硬件录音/GateB/Owner/main/App替换/发布保持NOT_RUN。

## 实测后补充的局部范围（2026-10-01）

R1四文件及50/500同库90phase源码与产物独立冻结，未覆盖后续补丁。原2000/current/首warm真实4035 SQL、2001次完整目录parse约1GB、5样本中位15910.800ms；lazy activation约1655.698ms。R1局部优化后500 current中位17.183ms、snapshot28.457ms，Utility合成同线程read→pause p95分别16.099/23.978ms，所有输出与持久事实一致。首次activation仍慢，静态追踪至referenceCatalog verifier：每ref过滤全部matches、每ledger公共detail guard对items反复some、相同revision/source/snapshot多次完整解析。

依据这些新鲜证据，下一步选择继续消除重复计算，暂不拆数据库所有者。Root独占packages/contracts/src/reference-catalog.ts及test/reference-catalog.test.ts，将合法字段guard之后的revision/detail reference成员检测改为操作内Set，不更改公共shape、数量/字节限制、顺序、坏输入拒绝和全部原断言。新xhigh作者独占packages/bridge-core/src/collection/reference-catalog-store.ts及新test/reference-catalog-activation.test.ts，仅完整verification调用内上下文复用source/revision/snapshot、matches单次分组与模型批量存在性；不得持久缓存、减少schema/triggers/容量/完整DTO/历史ledger/FK保护，写事务与公开业务读保持原语义。新代码独立审计R2计为本任务第二轮，最多两轮；Root保留R1数据为前一候选，最终候选重新绑定明确源码和输出。

Owner最新子代理许可gpt-6.1-sol xhigh，禁止gpt-6-sol；已派出的high只读测量/审查先完成，新增作者和R2使用xhigh。

Root复查远端task070的大品牌分组路径后，发现collection-progress公共guard也按每个品牌/系列重复扫描全部条目。Root范围补入packages/contracts/src/collection-progress.ts和test/collection-progress.test.ts：仅本次guard内线性归并/成员索引，保留全部counts逐字段一致、品牌/系列关系、零数量分组、未知candidate/needs-review、页分母/完整快照/8MiB保护。500品牌新行为测试原12pass1fail actual1；补修后两合同组合31/31退出0。最终候选共10生产/测试文件，R2统一审查；此前四文件R1和八文件中间证据不升级为最终候选覆盖。

## 同步控制实测后的完整所有者隔离

固定4d84的2000型号同线程Utility暂停p95为current61.014ms、snapshot157.653ms，未达20ms目标。只读CPU归因与完整事实守恒已确认；假设canonical完全免费仍不能证明达标。Root据本任务已有worker裁决授权，在外置detached4d84 checkout实施完整Dataset Owner，主checkout保持原5000基线/候选测量身份不变。008两轮独立审查已经结束；新实现由作者行为测试、Root自查与固定全量Gate验收，不追加第三轮独立审查。

所有者承载原20子域、两个长期连接、全部208领域命令及其coordinator、激活/身份/租约/quiet屏障和原生输入/输出资源。父Core保留播放、Roon SDK与PublicLibrary、Provider、Stream/Control与事件；不新开只读副本，不用逐store RPC拆散事务，不传函数、SDK、FD、真实凭据或设备资格。有限元数据投影保留scope/来源/epoch，owner内同步事务消费后释放许可。启动在owner prepare、父runtime成功及owner commitBoot之后发ready。

领域作者独占新增dataset-domain.ts/dataset-dispatch.ts及原physical-links-coordinator.ts/drafts-coordinator.ts和对应测试。协议作者独占新增dataset-owner-protocol.ts/client.ts/worker.ts与边界测试。Root独占runtime.ts、utility-main.ts、ipc-failure.ts、父Roon投影、桌面启动/recording bootstrap、Vite入口与编译后的spreadsheet worker路径适配，以及进度/报告/Git/完整Gate。所有生产改动先在隔离checkout整合，前后测量完成后才推进主checkout。

关闭先封新入口，原顺序尽力停止全部coordinator，等在途dispatch/启动提交与异步文件工作收口，再关闭两库并等待worker自然退出。任何清理错误不能发关闭成功ACK；继续尝试其他资源停止，保留两库，走现有Core监督/冷启动恢复。发送后断链仍为unknown，保留原请求/commandId，不自动重放或冒充ATTEMPT_NOT_ACCEPTED。完整原生资格与真实硬件验收仍未授权/NOT_RUN。

新门禁须证明：原Runtime/Utility合同保留；真实worker和持久两库的scope/epoch/未知回执/幂等/关闭与重启；正式编译owner嵌套CSV/XLSX worker可用；相同2000合法数据库下先read后pause完整DTO/事实对照；合成真实输入consumer/native协议/pump负载与Stop/quiet/关闭另列，不拿播放控制p95代替录音或设备证据。原全量verify/mockElectron/108E2E/静态Gate及原skip保持。

固定957远端Linux首次验证新增关闭故障消息竞态：close失败response与随后fatal帧之间可发生父端终止，使失败诊断变成worker-exit。Root重授协议作者在隔离checkout修client与原boundary test，须确定性RED/GREEN并保留close失败拒绝、exactly-once fatal和不terminate/replay；不第三审计、不放宽原断言。新源码重新冻结并跑原完整Gate，主4d84原5000对照继续冻结。
