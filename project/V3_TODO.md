# V3 剩余任务 TODO

当前进度：TASK-078本地自动软件子范围已在最终HEAD `fac7363b4a6481591e207dda7cca77f0ae8d3cd4` 封版；TASK-079继续在独立分支。当前无设备，只开发fail-closed就绪控制面，不枚举、不打开、不配置设备。objects-limit generation window-03与measure window-06已软件PASS。queued-stop window-06以`PROCESS_EXIT`形成零样本终态；window-07已唯一签发并只消费一次，但installed supervisor在authority admission前以`CAPACITY_SUPERVISOR_INPUT`拒绝，未启动supervision/child/benchmark、未创建output或样本。旧runtime在磁盘迁移后由`/Users/yihe/VSCode/...`规范化为`/Volumes/LifeWeave/VSCode/...`，TASK-084新增exact75-v3显式prefix relocation收据：63个live root逐项绑定旧/新身份并重新核验marker，7个LOST root与全部历史JSON保持只读；issuer、installed supervisor与TypeScript consumer只在内存中投影历史事实。旧window-07仍禁止重放，新窗口尚未签发或消费。后继正式链唯一化为新的objects-limit queued-stop PASS后依次运行joint generation、joint measure与joint queued-stop；三条joint exclusive issuer均已实现但尚未签发。可听Replica、TASK073真实HAL/Gate B、实体纸张与最终Owner仍为`NOT_RUN`或待验。`main`/PR合并、签名、公证和发布未授权；智能体统一GPT-5.6 Sol / High。

本表是任务拆分与依赖计划，不是完成声明。后续任务沿上一任务最终 HEAD 创建独立分支；当前已展开 TASK-064～078，其余任务开始前补详细范围和允许路径。具体子任务可根据已验证结果细分，不删减 PRD 范围。

## 实时进度面板

> **当前执行：** `TASK-084 / runtime relocation软件封板与新authority准入`。从TASK-083最终HEAD `b606784…`建立独立分支；历史证据不改写，63个live root通过显式旧/新身份映射恢复规范路径，7个LOST root继续保持LOST。当前尚未签发、消费或运行新窗口。

- [x] TASK-084 / recovery RED→GREEN：提交`90b15e8…`与`1f0a41c…`，exact75-v3收据冻结`historicalRuntime → currentRuntime`及63项marker一致映射。
- [x] TASK-084 / issuer与消费者 RED→GREEN：提交`de4f637…`、`c542ecc…`、`509a496…`、`e630aa7…`与`c54ca45…`；issuer/prechild/PROCESS_EXIT事实只做内存投影，Python/TypeScript消费者重新核验当前device/inode/marker。
- [x] TASK-084 / 聚焦全量：recovery 27/27、issuer 73/73、supervisor 59/59、Bridge容量139/139及typecheck通过。
- [ ] TASK-084 / 软件封板：readiness、标准verify、control-plane、boundaries、cycles、报告提交、远端Draft PR与CI待完成。
- [ ] R023 / 新objects-limit queued-stop：仅在TASK-084 clean+pushed HEAD后签发一个新窗口并只消费一次；旧window-07永久不重放。
- [ ] R023 / joint线性链：仅当前驱PASS时依次签发generation → measure → queued-stop；任一非PASS立即终止后续签发。

> **当前执行：** `TASK-083 / 软件封板，等待Draft PR外部评审`。从TASK-082最终HEAD `bb41b96…`建立独立分支；专用joint queued-stop issuer与profile消费合同已完成并通过本地Gate。本任务未签发、未消费、未运行正式窗口。

- [x] TASK-083 / 最小RED：提交`eae86c4…`证明专用joint queued-stop issuer缺失，且共享supervisor/benchmark仍固定objects-limit。
- [x] TASK-083 / 合同GREEN：提交`ab7e020…`精确绑定joint measure PASS、候选/toolchain/source/owned/seed与105轮计划；`f015fde…`进一步把复用helper纳入先验Git/blob身份，非PASS、漂移、重放或空间不足均在发布前停止。
- [x] TASK-083 / 软件封板：joint专项2/2、Bridge容量138/138、objects历史supervisor58/58、readiness17/17、标准verify与静态Gate全部新鲜通过；正式窗口仍未签发或消费。

> **当前执行：** `TASK-082 / joint measure专用issuer TDD`。从TASK-081最终HEAD `f018cc9…`建立独立分支。既有measure issuer是objects-limit历史失败恢复路径，不能通过放宽profile枚举冒充joint第二阶段；本任务新增专用入口，只消费完整`joint:generate:PASS`并签发一次性joint measure authority。本任务不签发、不消费、不运行正式窗口。

- [x] TASK-082 / 最小RED：提交`c487406…`证明专用joint measure issuer缺失，且既有objects-limit measure issuer仍拒绝joint。
- [x] TASK-082 / 合同GREEN：精确绑定joint generation close/supervision/seed、候选身份、source/owned/toolchain与measure plan；补齐generation terminal close，任一非PASS、漂移、重放或空间不足均在发布前停止。
- [x] TASK-082 / 软件封板：报告记录专项6/6、objects measure issuer 25/25、TASK-081回归6/6、supervisor58/58、readiness17/17、标准verify与三项静态Gate全部PASS；正式窗口仍未签发或消费。

> **当前执行：** `TASK-081 / joint generation专用issuer TDD`。TASK-080 Draft PR #22 的GitHub Verify、Security、dependency audit与Electron/Playwright Gate全部GREEN，仍未Ready或merge。现有generation issuer是objects-limit失败恢复专用路径，不能只扩展profile枚举后冒充joint首阶段；TASK-081新增专用入口，必须精确消费`objects-limit:queued-stop:PASS`并输出一次性joint generation authority。本任务不签发、不消费、不运行任何正式窗口。

- [x] TASK-081 / 最小RED：提交`afa6c4f…`证明专用joint generation issuer缺失，且不能从objects-limit恢复issuer或readiness路线文字推导签发能力。
- [x] TASK-081 / 合同GREEN：实现`f78ae86…`精确绑定前驱close、候选身份、source/owned/toolchain、joint 2,701,131,776字节计划与一次性窗口；任一非PASS、漂移、重放或空间不足均在发布前停止，真实installed supervisor合成preflight通过。
- [x] TASK-081 / 软件封板：报告`19db39a…`记录joint 6/6、objects issuer 19/19、相邻supervisor 5/5、readiness 17/17、标准verify与三项静态Gate全部PASS；joint measure/queued-stop继续后续线性任务，正式窗口仍未签发或消费。

> **当前执行：** `TASK-080 / clean-clone authority接线软件GREEN，等待外部评审`。PR #21 已以merge commit `d98eff24c0085ad8a340457f58dc3334709ca241` 合入 `v3-integration`。实现 `bb421f55ddc8c0c5b7d3b1986e4e53a74624c290` 允许clean clone完成固定setup与空间预检；没有issuer产生的一次性收据时返回`AUTHORITY_REQUIRED`，合法收据也只能消费其中固定的installed supervisor命令。直接benchmark生产入口已移除，聚焦测试、标准verify、control/boundaries/cycles均GREEN。当前未签发/消费窗口，formal capacity、设备Gate B和Owner验收仍为`NOT_RUN`。

- [x] TASK-080 / authority fail-closed接线：RED提交=`85398f7…`，实现=`bb421f5…`；无收据真实Node 22 CLI退出4并输出`CAPACITY_GATE=AUTHORITY_REQUIRED`，0 benchmark。
- [x] TASK-080 / 直接入口关闭：Bridge Core benchmark仅保留纯编排测试缝，生产CLI不再自行拼接worker/window/authority或映射正式容量PASS。
- [x] TASK-080 / 软件验证：专项9/9、相邻benchmark 5/5、标准`pnpm verify`、`CONTROL_PLANE`、`BOUNDARIES`、`CYCLES files=259`与`git diff --check`全部exit 0。
- [ ] TASK-080 / 外部评审与集成：建立Draft PR后等待检查；Ready/merge、任何新authority/window、105轮正式容量、设备Gate B和Owner验收均保持独立。

> **当前执行：** `TASK-079 / 最终自动软件门已GREEN；正式容量准入分类为HARNESS_BUG`。Security、标准Verify与Electron E2E均在冻结HEAD `fab807b8f77974ca772f3adcb49d578bbf46d9fb`新鲜通过。全新远端clone的静态准入确认正式入口强制消费新issuer产生的authority/window，而冻结状态为`currentWindow=NOT_ISSUED`，旧window全部nonreplay；Owner同时要求不得创建新authority/window。因此没有可构造的权威消费命令，正式supervisor/child/benchmark保持`NOT_STARTED`、样本数为0，没有用占位参数失败或绕过总控冒充正式运行。该HARNESS_BUG移交独立任务；Gate E软件容量部分不标记PASS。正式四阶段、设备Gate B和Owner验收均未升级。

> **window-04 后 successor recovery v3：** window-04 的历史 `plannedBytes=4,249,378,816`、失败终态和保留证据不改写。后继按历史联集68个根闭包为 `existing=70`、`future=1`、`authorized=71`；冻结snapshot=`1,990,471,680`字节，`serial-single-clone-plus-bounded-growth-v1 plannedBytes=2,258,907,136`。window-06已按output全树hard cap与`measure-aggregate-budget.jsonl`闭合并软件PASS；这不升级queued-stop、joint、设备Gate B或Owner验收。

> **queued-stop first-class控制面：** window-06把最新`PROCESS_EXIT` head作为单一直接carryover并递归闭合旧链；window-07以71个冻结measure roots + 1 issuer + 1 prechild + 1 process head + authority parent + issuer identity形成`exactDirect=76`，递归计费根为78。新合同固定`processFailureCarryoverCount=direct head count=1`，每个linked authority的`processFailureCount=predecessor reachable depth`，billing roots覆盖head→leaf全链。window-07保持terminal/nonreplay；新一代参数仍为5 warmup + 100 formal、50秒单次、900秒窗口、单active clone，但必须先绑定新远端HEAD做fresh audit，再取得显式新窗口授权，不能从本架构GREEN自动推导执行权。

- [x] TASK-079 / 真实证据 JSON 模板：只跟踪 `template=true`、`ready=false`、`receipt=null` 空模板；实际收据固定留在忽略目录且一份只覆盖一个B项。
- [x] TASK-079 / 收据校验器复审修复TDD：复审后RED为17/19，扩展后25/25专项GREEN；覆盖逐case事实、失败/超时/停止/不确定终态、Owner与证书闭包、独占窗口、完整配置/授权/环境seal、dirty候选、隐私解码与receipt seal。
- [x] TASK-079 / 第二轮最终复审P0-A：逐case JSON附件成为事实源；完整PASS事实不能只改verdict伪装失败；每类非PASS reason受Gate白名单约束。
- [x] TASK-079 / 第二轮最终复审P0-B：Owner accepted校验技术receipt seal及同候选/tree/矩阵/时间；rejected/deferred不强制技术PASS；技术附件固定在receipt独占窗口。
- [x] TASK-079 / 第二轮最终复审P0-C：配置指纹覆盖完整匿名路由/驱动/固件/电平/测量身份；授权→Plan→Preflight形成同run显式Hash链。
- [x] TASK-079 / 第二轮最终复审P0-D：B-13输出捕获、B-14三层事件与B-15前后证书解析实际附件并交叉验证；B-14非PASS允许如实缺层且不得声明Completed。
- [x] TASK-079 / 第二轮最终复审P1收口：匿名环境seal、CLI dirty/index/untracked拒绝、candidate manifest受控文件摘要、fatal UTF-8/JSON解码后敏感扫描、路径组件前后身份复核已加入；WAV/PNG/PDF在安全解析器建立前不准入。
- [x] TASK-079 / 追加候选闭包：正式CLI从精确`candidateCommit:<relativePath>`逐文件重算candidate manifest受控文件Hash，并要求关键时间为规范UTC ISO；伪摘要与宽松时间RED均已关闭。
- [x] TASK-079 / STATUS机器状态同步：锁定收据基础设施与candidate closure两段base/实现/报告/最终SHA及25→26专项计数；删除、错SHA或错计数均由readiness拒绝。
- [x] TASK-079 / Readiness Gate计数一致性：STATUS先关闭旧`PASS_13...`漂移，并随Git可达性新增专项同步为`PASS_15...`；验证器精确锁定当前计数，不再静默落后。
- [x] TASK-079 / Git检查点可达性：readiness确认仓库根、TASK-079分支、七个真实commit对象、两段线性祖先关系及最终closure到HEAD可达；交换顺序或复制状态文本均拒绝。
- [x] TASK-079 / Owner-only scope闭包：非B scope仅当TASK-078矩阵`mapped + fresh passed`且外部门精确只有owner时允许零技术引用accepted；U-01等仍需real-roon/hardware的条目保持阻断。
- [x] TASK-079 / Real-input技术收据：固定七角色窗口、矩阵criterion SHA、候选/授权链、匿名source alias+内容SHA、授权读取/Hash核验/原字节不变；多外部门scope按集合精确覆盖。
- [x] TASK-079 / Real-logic技术收据：覆盖MVP-08/09/10与D-05～D-08；真实Workspace、工程/导出Hash、Marker/Timeline、criterion、环境别名与逐scope固定结论形成闭包，不由普通文件存在或Owner单份观察替代。
- [x] TASK-079 / Real-roon技术收据：9个声明real-roon的scope已完成逐项事实闭包，并与A-02 real-input、B-09 real-output/hardware形成精确组合边界；专项、readiness、CLI和静态Gate均GREEN。
- [x] TASK-079 / Hardware技术收据主任务实现：非B四scope与Gate B输出测量已分层；旧实现完成28/28专项GREEN。配置身份不冒充完整Gate B，可听Replica、实体完成和库存结果仍待实机。
- [x] TASK-079 / Hardware evidence contract v2 主任务加固：新增配置前后观察、observer execution、四scope typed evidence、三层授权绑定、B-15 identity有效期/适用scope与U-10同事件依赖；实现=`7f373784…`，报告=`fde4f6cb…`，专项33/33。
- [ ] TASK-079 / Hardware独立复审终态carryover：第二轮最终复审仍为RED，按两轮上限不启动第三轮；contract v2主任务GREEN不改写独立结论。等待新的独立复审授权或Owner裁决，真实hardware与Gate B仍为`NOT_RUN`。
- [x] TASK-079 / objects-limit重新准入与安全停止：fresh空间门已从不足变为通过；window-02因owned authority漏计两个旧保留根而在30.351秒由控制面停止，child=`SIGTERM`、PG empty、78个partial checkpoint与fixture原样保留，结论为`CONTROL_FAILURE_NOT_A_SEED_NOT_A_CAPACITY_PASS`。
- [x] TASK-079 / Capacity authority issuer：初始RED为脚本不存在、3/3失败；两轮独立规格复审分别退回4项与3项P1，按上限不做第三轮。主任务关闭approved窗口末步发布、失败authority owned继承和损坏/漂移/symlink重放审计，最终专项12/12、py_compile、readiness 15/15、evidence 28/28、标准verify与静态Gate均PASS。实现=`a167eba9…`，报告=`cf6de5a…`；签发器不执行benchmark、不清理证据，也不授予新窗口。
- [x] TASK-079 / Gate B 运行手册：逐项覆盖 B-01～B-15、共同测量时基、无声判据、P50/P95/P99/max、失败/超时保留、停止条件和 RME/Apogee + Sony 待冻结配置。
- [x] TASK-079 / 两轮独立规格与质量复审流程：第二轮已完成并退回（规格复审7项P0，隐私复审1项P0/5项P1）；按两轮上限不启动第三轮，最终意见如实保留。
- [x] TASK-079 / Capacity issuer生成物候选闭包：合法生成物RED已复现；固定候选src/tsconfig/package、nested issuer identity闭包、私有Node/libnode/TypeScript工具链与Git超时已收口。实现=`ecf253ed…`、加固=`089994d…`、状态=`e51c01d…`，专项17/17；R1规格/质量RED，R2最终规格PASS、质量2项P2由主任务裁决关闭，按上限未做第三轮。
- [x] TASK-079 / window-03 pre-authority失败闭包：issuer在创建authority目录前遇到历史phase close字符串`window`并返回`ISSUER_INTERNAL`；没有window/seed/generation。新增primitive replay与carryover嵌套形状TDD，稳定映射`REPLAY_AUDIT`/`CARRYOVER_TERMINAL`/`CARRYOVER_COVERAGE`，专项19/19；修复提交=`6009b3c…`、`751146c…`、`5879c92…`。
- [x] TASK-079 / objects-limit window-03 fresh authority重取：第二次独立审计绑定HEAD `4f94ee5…`与issuer SHA `49246d9c…`并PASS；一次性签发window UUID `2a30115c…`、SHA `4068c068…`，随后只消费回执中的唯一supervisor命令。
- [x] TASK-079 / objects-limit generation window-03：自然exit 0，supervisor `passed=true`、child exit 0、targetReached/verifiedPassed=true、557 checkpoints、authority/source stable、PG empty、0 zombie、无sidecar；seed为non-performance，不冒充measure。
- [x] TASK-079 / objects-limit measure issuer：初始RED为生产脚本缺失、7/7失败；最终11/11专项GREEN。完整绑定generation PASS、243 pins、59+4 existing roots、唯一future output、seed/fixture/sidecar、dead PG、replay与原子发布；实现=`fc23f55…`。R1退回2项P1/3项P2，R2最终SPEC PASS、QUALITY限定PASS，P0/P1=0、3项P2按两轮上限封存。
- [x] TASK-079 / objects-limit measure fresh authority：只读审计绑定HEAD `e891446…`、issuer SHA `caab03df…`及完整generation链并PASS；一次性签发window UUID `1bcbe626…`、SHA `5c646834…`，只消费回执中的唯一命令。
- [x] TASK-079 / objects-limit measure window-01终态封存：`EXECUTION_TIMEOUT`，879,259.255ms；29 receipts、273 samples，sample-30 clone与partial保留；PG empty、0 zombie、authority stable；close SHA=`c88e1461…`。同UUID/label禁止重放，不是measure PASS。
- [x] TASK-079 / objects-limit measure timeout根因与TDD：阶段回执证明105个Stop指标回合自身总耗时不足1秒，约99.89%时间消耗在107次完整clone/open-audit/hash；保持1575样本、105回合和900秒门槛不变，最小RED已固定并改为progress/stop/read三个长生命周期group。
- [x] TASK-079 / objects-limit measure v2集成：实现提交=`1086dedb…`。SPEC R1=`FAIL (P0=2/P1=2)`、SPEC R2=`FAIL (P0=1)`的全部缺口均完成RED→GREEN；按两轮上限未开启第三轮复审，主任务以真实issuer↔tracked supervisor互操作和issuer 21/21裁决R2 P0已关闭。capacity 86/86、supervisor 11/11、`pnpm verify`、typecheck/build/static gates/diff-check全部exit 0；新authority仍须fresh audit后另行唯一签发。
- [x] TASK-079 / objects-limit measure window-04终态封存：一次性window UUID=`02f6042a…`、window SHA=`afdd51b4…`；105个progress样本完成后，Stop第2轮尝试重用同一Physical Copy而触发`COPY_UNAVAILABLE`，child exit 1，supervisor在terminal authority复核收敛为`AUTHORITY_DRIFT`，close SHA=`1baf8d8b…`。111 samples、progress receipt与Stop round-001 receipt保留，group-stop partial保留；PG empty、0 zombie、设备未打开、Gate B=`NOT_RUN`。window-dir/UUID/label永久禁止重放，不是measure PASS。
- [x] TASK-079 / Stop重入、terminal space/tree/fixture authority闭包：实现提交=`54b6353e…`。Stop measure预置105个不同的合法Physical Copy与冻结Plan，保持真实SQLite commit/fsync、105个durable round receipt、1575样本及3-group/3-full-hash口径；同Plan重放仍返回`COPY_UNAVAILABLE`。terminal复核在future output已存在时不再重复扣完整计划空间，公开`plannedBytes`合同保持固定；supervisor校验clone-owned workspace tree receipt、generation fixture before/after相等、目录/符号链接/多余项与成功清理，失败partial只在受控clone内保留。capacity 88/88、supervisor 16/16、issuer 23/23及Bridge Core typecheck全部exit 0。
- [x] TASK-079 / window-04后 successor recovery v3：保留window-04历史`plannedBytes=4,249,378,816`与失败事实；后继口径为历史联集68、当前`existing=70`/`future=1`/`authorized=71`，snapshot=`1,990,471,680`，`serial-single-clone-plus-bounded-growth-v1 plannedBytes=2,258,907,136`。output全树hard cap、aggregate audit、单active clone、terminal stable stop及terminal carryover均已进入正式window-06并通过软件measure。
- [x] TASK-079 / 新HEAD fresh audit与唯一后继window-06：fresh audit精确绑定`a457414f…`与supervisor `18ef840f…`；05 consumer identity前置拒绝未创建路径/UUID/authority并永久不复用。06使用全新UUID唯一签发、只消费一次并自然exit 0；1575 samples、3 group、105 Stop、18 stages、aggregate 2383行，阈值PASS、PG empty、0 zombie。
- [x] TASK-079 / objects-limit queued-stop first-class控制面：提交`7d67f506…`完成首次exact73 roots、5+100、单active clone、50s/900s、S+256MiB aggregate预算、843行审计与636文件成功闭包；提交`33d8856c…`绑定固定重建helper、Node/libnode、TypeScript compiler/标准库manifest、42个派生输出与Git输入。
- [x] TASK-079 / queued-stop prior issuer failure carryover：提交`f285bf3…`要求声明失败集合与runtime direct-child queued failure精确相等，并把window-01 failure、issuer fact、owner、installed supervisor的目录和文件身份带入issue/admission/terminal；window-02历史闭包为exact74 roots。capacity 92/92、历史supervisor 28/28、issuer 9/9、四套控制面81/81及全量软件Gate GREEN；历史证据保留。
- [x] TASK-079 / window-02 prechild故障终态与successor exact75控制面：window-02 UUID=`c7528bf4…`在admission/child前触发旧replay `unhashable dict`，零样本且无benchmark/output。提交`ab5f339…`关闭严格类型、pre-spawn二次authority、终态carryover、TS exact75及可恢复发布；一次性收据SHA=`0b372f0c…`、0400单链接、nonreplay。window-02历史owned=74不回写；successor才是71+1 issuer+1 prechild+parent+issuer identity=`exact75`。
- [x] TASK-079 / queued-stop PROCESS_EXIT统一谱系合同：实现`ed73b59fca177cc1804d4010fe863f8fb57001a0`增加版本化JSON合同、共享Python evaluator、TS evaluator与单一golden corpus；issuer、installed supervisor、TS consumer同时消费direct/recursive/billing/time/PID/identity语义。issuer 71/71、supervisor 58/58、Bridge capacity+conformance与typecheck、标准verify、control/boundaries/cycles/readiness/diff-check全部GREEN。原三位置架构语义阻塞解除。
- [x] TASK-079 / 最终自动软件门与一次性容量准入分类：冻结HEAD `fab807b…`上的Security、标准Verify、Electron与E2E均exit 0；全新remote clone为clean、无`node_modules`且无TASK078 runtime。静态准入证明正式queued-stop只能消费新issuer回执中的installed supervisor、window/owned manifest路径及SHA，但当前`NOT_ISSUED`且禁止新authority/window，故分类为`HARNESS_BUG`并在正式进程启动前停止。没有消费窗口、没有运行supervisor/child/benchmark、没有样本或容量PASS；后续只在独立任务修复。
- [ ] TASK-079 / objects-limit queued-stop正式窗口（等待fresh audit与显式授权）：window-06和window-07均保持历史terminal/nonreplay；window-07没有supervision、child、benchmark、output或样本。下一窗口只能使用全新UUID/window-dir/label，绑定包含统一合同的精确远端HEAD与243 source pins，按5 warmup + 100 formal、50秒单次、900秒总窗口、单active clone执行；本架构检查点不构成签发或运行授权。
- [x] TASK-079 / window-08授权前只读审计：`9ea344ba…`身份、合同/helper、toolchain、243 source集合、window-06/07 nonreplay、76 direct/78 billing roots通过；空间曾短缺约202～242MiB，随后只读快照回升并当次PASS。空间会波动，最终远端HEAD签发前仍须fresh复核；recovery07/window08未创建、未授权。
- [x] TASK-079 / 谱系深度上限覆盖：实现`fefbea78…`先以verdict完整性断言RED固定缺失`DEPTH_LIMIT`，再加入65层共同corpus GREEN；三消费者2/2、issuer71/71、supervisor58/58、Bridge capacity+conformance139/139及diff-check通过，SPEC后QUALITY审查均PASS。仅测试增强，不改变243 source pins或窗口权限。
- [x] TASK-079 / 覆盖增强机器真相同步：实现`df624b4…`以独立RED→GREEN把STATUS、readiness validator与测试fixture同步到coverage commit=`fefbea78…`、corpus 2/2、`DEPTH_LIMIT`、139/139、Bridge Core 1297+1 conditional skip和readiness 16/16，并锁定joint→architecture→coverage→HEAD可达性；SPEC复审与QUALITY审查PASS，窗口/设备/Owner状态不升级。
- [x] TASK-079 / Hardware contract v2 R2 RED裁决：原R2的dependency order与subject binding技术缺口已由`7f373784…`及既有负例关闭；当前`independentPass=false`表示独立审查身份未重签，保持RED而非已知未修生产缺陷。作为bounded carryover不阻挡无设备软件封板、objects-limit/joint或未来window08；任何真实Hardware/Gate B收据前必须新鲜独立只读复审，或Owner明确承担不复审风险。本阶段不启动第三轮修复/复审循环。
- [x] TASK-079 / joint软件容量预算：提交`5464ae06…`将Plan改为逐Record串行创建/消费，封存`preparedBeforeFirstAttempt=1`、`activePlanMaximum=1`、`unconsumedAtSeal=1`；写snapshot前拒绝超出冻结计划的投影，generation artifacts与measure seed共用严格消费合同。这只关闭软件预算重构，正式generation/measure/queued-stop仍未运行。
- [x] TASK-079 / objects-limit后继与joint正式路线机器锁：R-023 schema、phase/supervisor和测试唯一支持large queued-stop含joint，但三条exclusive issuer当前均只接受objects-limit。提交`1acf77c3…`以17/17 readiness TDD固定objects-limit queued-stop PASS → joint generate → joint measure → joint queued-stop，逐阶段隔离process/clock/receipt并禁止authority继承、receipt复用、旧窗口重放或跳级；SPEC后QUALITY审查均PASS。
- [ ] TASK-079 / joint三条exclusive issuer支持：只有objects-limit queued-stop取得正式PASS后，才可用TDD把generation、measure、queued-stop issuer扩展为joint；实现本身不构成任何joint授权。
- [ ] TASK-079 / joint正式generation：须绑定最终远端HEAD通过fresh身份/空间审计，取得独立唯一authority、一次性window与Owner明确授权；非PASS立即停止，不进入measure。
- [ ] TASK-079 / joint正式measure：只消费同链joint generation PASS，使用新的process、clock、receipt和独立授权；不得继承generation窗口或回执。
- [ ] TASK-079 / joint正式queued-stop：只消费同链joint measure PASS，使用新的process、clock、receipt和独立授权；不得以schema支持或measure PASS冒充queued-stop PASS。
- [x] TASK-079 / 架构评审分支检查点：实现`ed73b59fca177cc1804d4010fe863f8fb57001a0`、状态报告`e9416cb7e2510da327598798bff6f448be19c8a9`、远端回执`886cc19e…`与身份检查点`9ea344ba…`均为已push历史锚；当前运行身份必须fresh核验，不从TODO措辞继承。`5464ae…`保留为joint历史实现锚。只开放分支评审，`main`/PR合并、签名、公证、安装和发布仍未授权。
- [x] TASK-079 / 上一检查点回归：hardware contract v2为33/33专项、readiness 15/15，证据校验、标准verify、控制/边界/循环和diff-check全部exit 0；这些结果只证明主任务测试GREEN，不关闭hardware独立R2最终RED。最终closure HEAD=`123420cbd8b5b8c83cf1c4df1a3c614944cd5f0d`；软件包回归为Contracts 186/186、Bridge Core 1242/1242、Desktop 643/643及三包构建PASS。
- [x] TASK-079 / 本地与远端评审检查点：证据基础设施实现`e43f39f1…`、报告`23da9a12…`；candidate closure实现`04b77e45…`、报告`98bce05e…`；STATUS同步实现`9a991a6f…`、报告`ea257111…`；计数修正实现`4ec0711c…`、报告`9a93bc13…`；Git可达性实现`5bd46e10…`、报告`932fb71b…`；Owner-only闭包实现`a8b1d762…`、报告`9011701a…`；real-input实现`d9c795de…`、报告`6d0b93a0…`；real-logic实现`2f1bbdc8…`、报告`bbabb34d…`；real-roon实现`03c8b790…`、报告`b9fbf2f4…`；hardware v1实现`a6d3c798…`、报告`cf6d570f…`；capacity issuer v1实现`a167eba9…`、报告`cf6de5a…`；hardware v2实现`7f373784…`、报告`fde4f6cb…`、封存`123420cb…`；capacity issuer derived closure实现`ecf253ed…`、加固`089994d…`、状态`e51c01d…`；Stop/authority闭包实现`54b6353e…`；queued-stop issuer failure carryover实现`f285bf3…`；prechild终态与successor exact75实现`ab5f339…`已push并核对。未合并main、未发布。
- [ ] TASK-079 / 真实 Gate A～E、U-01～U-10、实体录音/打印/Replica 与 Owner 103 项决定：等待相应设备、资料及逐次授权，当前不运行。

- [x] TASK-064～072：本地软件阶段完成；真实账号、真实数据和 Owner 验收仍按各任务报告保留。
- [ ] TASK-073：软件底座完成；真实 HAL、RME/Apogee 设备配置及 Gate B 等设备连接后执行，当前 `NOT_RUN`。
- [x] TASK-074～077：本地软件阶段完成；可听 Replica、实体打印和 Owner 验收未冒充自动通过。
- [x] TASK-078 / 同数据集与 App 冷开：7 条库存路径、PDF、两个 App 冷开场景已通过受控软件验证。
- [x] TASK-078 / R023 progress 性能：P95 已从 666.707ms → 491.685ms → 297.789ms → 82.592ms → 72.654ms → 50.709ms → 51.181ms，组合候选新正式窗口100/100成功，P50=45.604ms、P95=48.182ms、P99=49.817ms、max=50.855ms，首次同时通过P95≤50与max≤100；window/source/seed未变化、资源关闭。
- [x] TASK-078 / Attempt 热路径：receipt raw-prefix、预算凭证、对象证书与Begin完整Record/Print结构锚点均完成RED→GREEN及独立SPEC/QUALITY审查；最终root为Attempt 55/55、Print 17/17、queued Stop 7/7、类型与diff-check全通过。旧候选P95=51.181ms的失败证据保留；新候选 `62cfdfe7…` 不修改测量口径，依靠已提交结构证明消除重复全遍历。
- [x] TASK-078 / 父子 IPC queued Stop：独立objects-small seed的window-05正式5+100自然exit0，105/105业务成功、0失败、0超时，105个child全部closed且PG empty。child progress P50=9.175ms、P95=9.864ms、P99=11.219ms、max=22.314ms，已通过P95≤50/max≤100；Stop回执P95=9.570ms/max=24.383ms、abort max=0.878ms、driver stop max=0.942ms、driver close resolved max=40.165ms、父进程回执max=40.293ms均PASS。window/source/seed哈希未变、seed无sidecar；RSS本正式入口未观测，不冒充已验。close证据 `r023-queued-stop-window-05-close.json` SHA256=`04249d1f…`。
- [x] TASK-078 / history-small 新 Node cold N10：独立window-01自然exit0，10/10成功、0失败/超时，10个不同child PID均closed且PG empty；fork→close min=405.216ms、median=415.286ms、max=445.518ms。source 241 pins、seed/window/inventory哈希未变且seed无sidecar；OS cache未清，不冒充物理冷盘。
- [x] TASK-078 / history-small 完整备份：独立prepare-backup window-01自然exit0并进入`prepared`；数据库3,485,696B、7个对象2,366,074B、manifest 3,698B均验证通过，receipt的seed/source身份与当前窗口精确一致。
- [x] TASK-078 / history-small 完整恢复 N10：独立full-recovery window-01自然exit0，10/10成功、0失败/超时，10个不同child PID均closed且PG empty；fork→close min=1,206.449ms、median=1,224.522ms、max=1,281.569ms。10棵隔离恢复树全部保留且未激活，backup receipt的source manifest与本窗精确相等。
- [x] TASK-078 / objects-small 新 Node cold N10：独立window-01自然exit0，10/10成功、0失败/超时，10个不同child PID均closed且PG empty；fork→close min=1,629.071ms、median=1,649.084ms、max=1,687.062ms。source 241 pins、seed/window/inventory哈希未变且seed无sidecar；OS cache未清，不冒充物理冷盘。
- [x] TASK-078 / objects-small 完整备份：独立prepare-backup window-01自然exit0并进入`prepared`；数据库76,865,536B、55个对象3,242,826B、manifest 48,074B均验证通过，receipt的seed/source身份与当前窗口精确一致。
- [x] TASK-078 / objects-small 完整恢复 N10：独立full-recovery window-01自然exit0，10/10成功、0失败/超时，10个不同child PID均closed且PG empty；fork→close min=5,990.912ms、median=6,055.205ms、max=6,312.736ms。10棵隔离恢复树全部保留且未激活，backup receipt的source manifest与本窗精确相等。
- [x] TASK-078 / Print真实Main持久链E2E：自然RED因缺`same-dataset-print-chain.json`失败；GREEN后显式证明Main启动前唯一pending/create且无artifact/complete，启动后同一job形成create→claim→complete、lease/receipt/artifact/PDF/preview对象与原生导出文件闭环。desktop types exit0、目标E2E 1/1通过，独立SPEC/QUALITY P0/P1/P2=0；新PDF 3页、292.5×288pt、文本/144DPI逐页检查通过，不冒充R023计时或实体纸张。
- [x] TASK-078 / Print claim/write正式窗口：先后封存formal-window-01（99/100）与window-02（98/100）两次截止不足，不覆盖失败证据；25s执行/1s终止/2s关闭与28s准入经RED→GREEN后，window-03自然exit0，105/105成功、0失败/超时，105个PID唯一且PG empty。正式100次claim P95=552.461ms/max=667.666ms、complete P95=508.639ms/max=716.780ms，均通过max≤2000ms；候选/source/seed未漂移，独立SPEC/QUALITY P0/P1/P2=0。只证明私有Fake的软件持久链，不冒充实体打印或Owner验收。
- [x] TASK-078 / Joint 50%元数据：六个真实轴固定为Attempt events 50,000、Attempt/Record/Print metadata各64MiB、Record photo/Print object各512MiB；records仅为结构前提。Joint要求两个Attempt轴AND，history-limit保留OR；任一轴少1继续，非目标90%硬边界优先停止。缩小joint probe以同键targets/actual/reached封存且明确non-performance；完整capacity 82/82、typecheck/diff-check及独立SPEC/QUALITY全PASS。
- [x] TASK-078 / large queued-stop与生成监督器：queued-stop精确开放objects-small/history-limit/objects-limit/joint，保持N105与900秒；大档强制target-reached，joint强制六轴。生成监督器独立1200秒scope，绑定243 pins、owned/空间、fixture/checkpoint、自然退出与PG empty；两轮审查关闭3个P1，最终23/23、py_compile/diff-check及SPEC/QUALITY全PASS。
- [x] TASK-078 / objects-limit object-audit certificate：window-01的部分fixture继续原样保留且不重放。共享凭证已完成RED→GREEN：Attempt/Record/Print合法增量提交精确复用，未知触发器、beforeCommit、外连接写、rollback/COMMIT失败回退完整审计；Repository自然接线证明next Begin对历史4MiB PDF为0次hash读取。新鲜99/99回归、容量聚焦3/3、typecheck/diff-check均PASS。
- [x] TASK-078 / objects-limit 非正式扩展阶梯：10/25/50 records分别6.485s/16.586s/36.006s，print object分别41,945,600/104,864,000/209,728,000B，全部target-reached；每条约0.649/0.663/0.720s，呈近线性增长。该结果仅用于验证优化方向，不替代正式objects-limit容量PASS。原始阶梯日志已保留；最终源码哈希逐项复核一致，证据 `r023-objects-ladder-02.json` SHA256=`79919f73…`，验证日志SHA256=`9dc1bb50…`、exit收据SHA256=`e3c57c92…`。
- [ ] TASK-078 / objects-limit 正式window-02：空间已重新准入，但本次authority漏计旧window-01 partial output与fixture；运行在独立审计发现后终止并永久封存，未形成seed或容量PASS，window/UUID/label不得重放。失败close SHA256=`294d639c…`，完整carryover inventory SHA256=`d9b4e840…`。
- [ ] TASK-078→079 / 剩余容量接续：history-limit generation/measure/large queued-stop已正式PASS；objects-limit generation window-03与TASK-079 measure window-06已软件PASS。旧window-02/03/04及05前置拒绝均按各自终态永久禁用；objects-limit large queued-stop与joint继续待运行，设备Gate B与Owner验收不随容量软件结果升级。
- [x] TASK-078 / 本地软件最终收口：完整双native verify为Contracts 186/186、Bridge Core 1242/1242、Desktop 643/643，全部0 fail/0 skip且构建PASS；security 29/29、Electron mock 4/4、fresh E2E 91/91，均0 skip；101条mapped fresh已正式写入并通过矩阵及结果报告两轮独立审查（均P0/P1/P2=0），2条真实设备缺口保持pending。报告提交已锁定；实机、Owner与容量carryover未因此完成。
- [x] TASK-079 / 独立工作树：从TASK-078最终HEAD `fac7363b…`建立 `codex/task-079-v3-final-acceptance`，工作树初始清洁。
- [x] TASK-079 / readiness TDD：首个RED为验证模块不存在；首轮GREEN后继续关闭冻结矩阵双改、STATUS外部门矛盾、symlink和错误码缺口，最终13/13；默认清单校验PASS且明确`READY=false`，严格ready模式按预期拒绝。
- [x] TASK-079 / fail-closed清单：103条Owner决定全部pending，real-input/real-logic/real-roon/hardware/owner五类全部not-run；RME/Apogee与Sony仅记录品牌意向，型号、配置、测量计划为空。
- [x] TASK-079 / readiness独立审查与提交：两轮后P0=0/P1=0，唯一P2为TODO计数落后且已修正；标准verify与控制/边界/循环通过，实现`1f102fba…`、报告`93feee20…`已锁定。
- [x] TASK-079 / objects-limit measure v2预检身份修复：window/label-02与03终态不可重放；production RED证明tracked-source模块不能校验installed supervisor路径，改由安装副本自校验并补source/owned/facts/candidate/window五阶段安全诊断。issuer完整23/23及定向五场景通过，提交=`bf2ae144…`；新authority仍未签发。
- [ ] TASK-079 / 真实环境与 Owner 最终验收：当前没有设备连接，不枚举、不打开、不配置设备；等待精确设备、资料和操作授权。

## 开发队列

- [x] **TASK-064：一致性快照与归档内容备份基础** — 本地自动 Gate 通过，Owner 未验收。SQLite Backup API、快照内引用闭包、内容字节完整校验、无覆盖发布。
- [x] **TASK-065：隔离恢复与基本索引重建** — 本地自动 Gate 通过，激活/UI 与 Owner 未完成。隔离目录恢复、重复恢复冲突、Manifest 重建、Quarantine；不覆盖当前用户数据。
- [x] **TASK-066：桌面备份与恢复工作流** — 本地自动 Gate 通过：77/818/186、安全22、Electron4、完整E2E50。独立维护库、内容位置绑定、显式激活/回滚与后台窗口；Owner未验收，大库冷启容量风险转TASK-078/Gate E。见 [TASK-066结果](../reports/TASK-066_RESULT.md)。
- [x] **TASK-067：持久命令 outbox** — 本地自动 Gate 通过：82/827/279、安全27、Electron4、完整E2E54。Main持久账本、Core工作库身份隔离、人工恢复和PREP整批撤权；Owner未验收。见 [TASK-067结果](../reports/TASK-067_RESULT.md)。
- [x] **TASK-068：参考目录与版次修订** — 本地自动 Gate 通过：95/847/291、安全27、Electron4；常规E2E56通过，固定native另跑1通过。来源原包、不可变目录、合并拆分审核与历史快照；Owner未验收。见 [TASK-068结果](../reports/TASK-068_RESULT.md)。
- [x] **TASK-069：Excel 非破坏导入** — 本地自动Gate通过：107/881/316、安全27、Electron4、完整E2E60（固定native开启，零skip）。原始字节与源行、显式来源关系、非破坏修订、独立数量账本及备份恢复；Owner未验收。见 [TASK-069结果](../reports/TASK-069_RESULT.md)。
- [x] **TASK-070：Want List 与收藏完成度** — 本地自动Gate通过：118/897/337、安全27、Electron4、完整E2E66（固定native开启，零skip）。Wanted与Owned正交、实际持有长度、不可变历史和预算分页；Owner未验收。见 [TASK-070结果](../reports/TASK-070_RESULT.md)。
- [x] **TASK-071：Source Picker 与双库交互补齐** — 本地自动Gate通过：118/897/395、安全27、Electron4、完整E2E73（固定native开启，零skip）。关系选曲、明确历史上下文、下一步指引、按需照片/单图重试与焦点返回；Owner及既有视觉carryover保留。见 [TASK-071结果](../reports/TASK-071_RESULT.md)。
- [x] **TASK-072：正式 Profile Snapshot / RecordingPlan / Preflight** — 本地自动Gate通过：127/922/414、安全27、Electron4、完整E2E75（固定native开启，零skip）。不可变计划/当前参数快照、八类预检、schema18备份恢复；F01已确认，Gate B未认证仍阻断，Owner未验收。见 [TASK-072结果](../reports/TASK-072_RESULT.md)。
- [ ] **TASK-073：输出后端与 Gate B** — 无设备底座、面板和隔离生命周期内核已交付；第四阶段修复启动退出验证及合成旧配置隔离，当前本地Gate为134/957/461、安全28、Electron4、完整E2E80。新包启动自退出通过；旧调试连接退出FAIL保留。真实HAL接入、设备生命周期/配置认证与Gate B仍待实机，不标完整任务完成。Owner已授权后续软件阶段继续，见[本轮结果](../reports/TASK-073_EXIT_LIFECYCLE_RESULT.md)。
- [x] **TASK-074：正式录音 Attempt 状态机** — 本地Gate通过：147/1005/483、安全29、Electron4、完整E2E83，双native、零skip。Cassette显式翻面/BeginB、DAT Program、中断不续播、三层完成、schema19及可能写入介质保护；真实准入仍受Gate B阻断，R023容量风险待078。见[TASK-074结果](../reports/TASK-074_RESULT.md)。
- [x] **TASK-075：录音档案、检索与双库同步** — 本地Gate通过：162/1035/505、安全29、Electron4、完整E2E86，双native零skip。首次Completed幂等不可变登记、当前内容认知、明确重录/擦除声明与检索；同一Physical Copy双库同步且不增加库存，历史快照不重写；真实播放/实机与Owner待验，见[TASK-075结果](../reports/TASK-075_RESULT.md)。
- [x] **TASK-076：Digital Replica（本地软件阶段）** — 本地Gate通过：174/1066/532、安全29、Electron4、完整E2E88，双native零skip。历史归档执行音频/原Render核验、恢复binding、有限只读会话与取消收口；生产播放保持blocked，可听Replica及正式provider仍待073/079，不冒称真实播放，见[TASK-076结果](../reports/TASK-076_RESULT.md)。
- [x] **TASK-077：J-Card 与 Printed Artifact（本地软件阶段）** — 本地Gate通过：184/1088/601、安全29、Electron4、完整E2E90，双native零skip。完成事务自动打印请求、Master Artwork版本、不可变PDF/预览、原生无覆盖导出与schema21恢复；实际PDF23页独立几何/内容/视觉通过，纸张/盒型与Owner待验，见[TASK-077结果](../reports/TASK-077_RESULT.md)。
- [x] **TASK-078：V3 全链路自动验收（本地软件子范围）** — 101条mapped fresh证据与完整自动Gate通过，结果报告和独立审查已提交；B-13/B-15、objects-limit/joint正式容量、系统钥匙串旧FAIL、实机与Owner保持carryover，不把局部封版写成V3整门通过。
- [ ] **TASK-079：真实环境与最终 Owner 验收** — 无设备readiness控制面开发中；任务规格见[TASK-079](../tasks/TASK-079-v3-final-acceptance.md)。真实实物/库存表/Source Roots/Logic/Roon、设备实录、实体打印与Owner逐项接受仍待外部条件。

## TASK-078 本轮软件检查点

- [x] R020启动策略：60秒完整启动期限、2秒普通IPC、代际私有恢复client；48专项通过，非作者SPEC/QUALITY R1通过。固定app03包已测history-small与objects-small各10次新进程，首次界面可用最大0.782/2.498秒，全部无重试且正常退出/无持有PID残留；mock-keychain与OS缓存边界明确，limit/联合及完整恢复仍待下面整体Gate。
- [x] 未来PDF预览：真实Electron滚动条RED→GREEN，36专项通过；23页PDF绘制内容/文字/精确页盒不变，最终PDF视觉与非作者R1通过，旧Artifact不重写。
- [ ] R023容量：100/1000progress旧基线已记录；1000档progress P95=79.718ms超过50ms，真实失败保留。Stop同步abort监听缺口已修，24专项+34相邻与SPEC2/QUALITY通过；前缀缓存78专项与SPEC/QUALITY通过，原种子独占重测exit0，P95降为14.058ms、abort最大0.111ms；对象设施7专项与独立审查通过；objects-small窗口03完整1575样本、零业务失败/超时，但progress P95=666.707ms、回执P95=717.056ms、Fake close最大1486.072ms均未达标；同步abort/driver.stop调用均小于0.5ms。75 JPEG与25 PDF独立解析通过，原种子SHA不变；同次对象审计去重已通过root45专项、类型与SPEC/QUALITY审查，独占100正式progress样本P95降至491.685ms但仍超过50ms；等价raw校验root50专项、合同12专项及SPEC/QUALITY通过，独占100正式样本P95进一步降至297.789ms、max333.482ms仍未达标。Begin全raw锚点+精确progress对象凭证已完成两轮真实RED、作者55/55+相邻40/40、root新鲜55/55、types0，并获非作者SPEC R1→QUALITY限定PASS；冻结fingerprint `2b7c65930afadc9ad1aac374c1c63827377891753a0bf7fc1d058ca4a1f4e28c`。固定objects-small窗口04自然exit1，105 raw（5预热/100正式）且正式100/100业务成功：P50=74.855167ms、P95=82.591707ms、P99=110.116917ms、max=112.051958ms，较上一轮P95=297.789ms明显改善，但50/100ms门槛仍FAIL；audit/window/source/seed均unchanged，321 source pins，峰值RSS 483262464字节，失败输出77038873字节/9文件继续保留。证据SHA256：window `4797f3e7ce59ae3738b538f02e3fc1ab3460513a23b670158c4a10fb3d3ab431`，summary `1c3d959162bfa2c3bb5bc476da83ddf54249ca7f2d3002e95bdda8333cffbd8f`，samples `365f1ef5a9644deb6e112a6931cbab43e8c793777aafb4c27fe210a553e1b130`，receipt `376fd90d10616f6d1922b0fad6f2089ba7e7e5890ce95e0cfde02624c3eb279a`，gate log `e64221663a1cde895ff281bb31edd2cc9fd1479f03440ad55427b6e418a79897`，gate exit `4355a46b19d348dc2f57c046f8ef63d4538ebb936000f3c9ee954a27460dd865`；close addendum `da7a82345dd91563a057e398954fbf0778a28d1dcd48923fcfd993a573ffb3be`明确`sourcePinsUnchanged=true`/`sourcePinCount=321`，owned inventory addendum `fbf2e6e74b7c9f31f1b2a65554f8bb20b19dc417fe97df301b095d50799e71e3`。Stop/cleanup仍为后续独立片。Attempt statement单次verify复用已获独立SPEC/QUALITY PASS，完整Attempt39/39、相邻Print17/17、types通过；新固定窗口100/100业务成功，P95进一步降至72.654ms、max107.701ms，但50/100ms门槛仍FAIL，321 pins与window/source/seed/audit均unchanged，失败输出保留。receipt原始tuple前缀优化已进入RED→GREEN。新进程冷开/完整恢复设施27项及审查通过，外层接线唯一证据清理P2经RED修复，完整60项及SPEC2/QUALITY通过。runtime父监督器v3已补共享2秒close deadline与消失进程组竞态，最终8/8；候选fingerprint `df581c5c6b67ba6e338726d6b98fc5006cc594b8d79ae3d8fa146541581732ae`，非作者SPEC R2→QUALITY限定PASS，审查 `r023-phase-supervisor-review-r2.md`（blob `8852e65522bfa3d10839fc1ee09e222489413bc0`，SHA256 `4a03eaa7174438c40bdaf6972137aa0644de94b59661a72b266fdafbfc7d36aa`）；实际容量phase/N10仍NOT_RUN。limit/联合、冷恢复与排队Stop仍待测，最大规模不由pilot代替。
- [x] 103项证据索引：修复15处因新增测试导致的声明行号漂移后，最终索引校验PASS：101 mapped且fresh passed、2 unmapped且pending；校验器19/19、CONTROL_PLANE与BOUNDARIES均PASS。只关闭映射的软件子集，不把B-13/B-15、外部门或Owner验收升级为PASS。
- [x] 同7盘数据集：candidate-app03实际App全链通过，真实UI激活/跨导航提示/显式reload、完整备份/恢复/再次冷启，19业务表及历史文件字节保持；实际浏览器存储路径为本次合成根。成功链PDF另经独立3页精确页盒/内容/栅格视觉核验通过；使用内存mock-keychain，不冒真实钥匙串/设备/实体纸张验收。
- [ ] R021新包执行后正常Quit：有限阶段观测54专项与非作者SPEC/QUALITY通过；首包身份校验通过；实际无CDP普通Quit在will-quit后超时，钥匙串等待线索保留；合成session早绑定72专项+独立审查与实际App路径验证通过；新包两种mock-keychain普通Quit均code0/close、无信号且持有进程全退出；测试显式钥匙串模式和cold-start关闭收口25专项、独立审查及实际Electron mock4/4通过；真实钥匙串旧FAIL保留，未勾整体。
- [x] 最终自动软件Gate：双native verify、security、Electron mock、fresh E2E、101条mapped fresh矩阵、控制/边界/循环、16 native pin均PASS；最终独立矩阵与结果报告复审均PASS，报告提交为`93824b6e…`。三提交封版后从最终HEAD接TASK-079；外部门仍未完成。

以上勾选只表示所列软件子范围，不表示TASK-078整体完成；所有实机及Owner项继续未勾选。

## 需要 Owner 的外部条件

- [x] F-01：2026-08-28 Owner 明确确认保守保留方案，见开发包 `f01-permanent-execution-v1`。批准不等于正式录音/设备或产品验收。
- [ ] 明确可读取的 Source Roots、实物照片、参考目录及真实 Excel 样本；自动 Gate 仅使用合成数据。
- [ ] 实机条件：2026-08-29 Owner说明目前没有设备连接，后续计划使用RME或Apogee声卡、Sony卡座；具体型号、连接方式、输出后端及测量配置待设备接入时确认，届时另行明确设备操作范围。真实Logic和实体录制未执行，Gate B保持NOT_RUN；不据品牌计划认定兼容或认证通过。
- [ ] Owner 逐项确认产品功能与视觉体验；自动通过不勾选人工验收。

## 不因 V3 开发自动关闭的历史项

- [ ] TASK-047：真实 Roon / NetEase 歌词验证。
- [ ] TASK-061：固定原生转换器发布准入。
- [ ] TASK-040/041：签名、公证、安装和 Beta 分发验收（若另行授权发布）。
- [x] 验证清洁的`codex/task-079-v3-final-acceptance`最新代码评审检查点`f285bf3…`已push并由远端SHA确认。`main`/PR合并、签名、公证、安装和发布仍须分别授权，不属于当前自动执行范围。

## 完成判定

每项记录行为 RED/GREEN、SPEC 后 QUALITY 自查、验证退出码、实现/报告/最终提交。完整 Gate A～E 和 Owner 接受均保持未完成，直到各自证据齐备。
