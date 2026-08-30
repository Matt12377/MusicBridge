# TASK-079：真实环境就绪与最终 Owner 验收

基线 `fac7363b4a6481591e207dda7cca77f0ae8d3cd4`，分支 `codex/task-079-v3-final-acceptance`，独立树 `worktree/task-079-v3-final-acceptance`。TASK-078 的本地自动软件子范围已经封版；本任务承接尚未运行的真实输入、真实 Logic/Roon、真实设备、实体打印和 Owner 产品验收，不重写 TASK-078 的软件证据。

当前没有设备连接。Owner 后续计划使用 RME 或 Apogee 声卡与 Sony 卡座，但具体型号、连接、采样率、声道、缓冲、时钟、测量方法和故障注入范围尚未冻结。本阶段禁止枚举、打开、配置或发声，禁止读取真实音乐、库存、照片、Excel、Logic 工程、Roon/Provider 账号或凭据。验证清洁的`codex/task-079-v3-final-acceptance`评审检查点`b3df42ada9e798d8fb67396648bdc5599ef83eb3`已push并核对远端SHA；没有授权`main`/PR合并、签名、公证、安装或发布。

## 无设备阶段范围

1. 建立机器可读、fail-closed 的真实环境就绪清单。所有外部类别初始为 `not-run`，Owner 决策初始为 `pending`；缺少证据、身份不匹配、未知字段、敏感路径或凭据形态时必须拒绝。
2. 校验清单与 `project/V3_ACCEPTANCE.json` 的 103 条范围一致，保持 B-13、B-15 及全部外部条件未升级。TASK-078 的 `101 passed + 2 pending` 只作为软件基线，不自动转换为真实 Gate 或 Owner 接受。
3. 固定真实阶段的执行顺序、证据类型、匿名化要求和停止条件。实际设备信息与真实资料路径只进入 Owner 控制的本地证据，不进入 Git、聊天、命令参数或公开报告。
4. 形成可见 TODO 面板和 readiness 报告。文档、验证器或模板通过只说明“准备流程可执行”，不说明设备兼容、音质、实录、纸张成品或产品验收通过。

## 真实阶段顺序

只有 Owner 提供对应条件并明确设备操作范围后，才按以下顺序推进；任一前置失败都停止后续步骤：

1. 冻结真实资料授权范围与匿名样本身份，确认 Source Roots、照片、Excel、Logic/Roon 的读取边界。
2. 冻结声卡、卡座、线缆、路由、采样率、声道、缓冲、时钟、输出电平、测量时基、无声判据、样本量、超时和故障矩阵。
3. 仅在新鲜 Plan/Preflight 下执行 Gate B；禁止自动切换设备、系统扬声器、Roon Zone、来源或当前 Attempt。
4. 分别记录 `T_detect`、`T_engine_cutoff`、`T_backend_tail`、`T_total` 与实体停止时间；ACK、EOF、进程退出或 FakeDriver 不能代替输出端测量。
5. 真实资料、库存守恒、版本谱系、归档恢复、可听 Replica、正式录音、J-Card 实体打印和视觉/产品体验分别验收，不用单项通过推导完整 V3。
6. Owner 对 103 条逐项作出接受、拒绝或延期决定；未提供决定的条目保持 pending，完整 Gate A～E 和 Owner 接受均通过后才允许 `formalReady=true`。

## 允许文件

- `tasks/TASK-079-v3-final-acceptance.md`
- `project/V3_OWNER_ACCEPTANCE.json`
- `project/STATUS.json`
- `project/V3_TODO.md`
- `project/WAVE-5.yaml`
- `tasks/00_TASK_INDEX.md`
- `scripts/ci/verify-v3-owner-readiness.mjs`
- `scripts/ci/test/verify-v3-owner-readiness.test.mjs`
- `project/V3_OWNER_EVIDENCE_TEMPLATE.json`
- `scripts/ci/verify-v3-owner-evidence.mjs`
- `scripts/ci/test/verify-v3-owner-evidence.test.mjs`
- `scripts/ci/issue-v3-capacity-window.py`
- `scripts/ci/test/issue-v3-capacity-window.test.mjs`
- `scripts/ci/issue-v3-capacity-measure-window.py`
- `scripts/ci/test/issue-v3-capacity-measure-window.test.mjs`
- `scripts/ci/issue-v3-capacity-queued-stop-window.py`
- `scripts/ci/test/issue-v3-capacity-queued-stop-window.test.mjs`
- `scripts/ci/capacity-phase-supervisor-v2.py`
- `scripts/ci/test/capacity-phase-supervisor-v2.test.mjs`
- `packages/bridge-core/test/benchmarks/recording-capacity.ts`
- `packages/bridge-core/test/helpers/recording-capacity-fixture.ts`
- `packages/bridge-core/test/recording-capacity.test.ts`
- `reports/TASK-079_REAL_GATE_RUNBOOK.md`
- `reports/TASK-079_READINESS.md`

除非后续真实 RED 明确证明需要生产修复，否则本无设备阶段不修改应用、Core、合同、数据库或原生输出代码。任何生产修复必须先单独冻结允许路径并执行 RED→GREEN；不能为了让清单变绿而放宽真实 Gate。

TASK-078 的 `objects-limit` 重新准入在 2026-08-30 暴露出独立控制面 RED：仓库只有 capacity window 消费器，没有可测试的 exclusive-create authority 签发器；临时签发遗漏已封存的旧 partial output 与 fixture，运行在独立审计发现后立即终止。新增的 generation issuer 只负责从显式旧 owned manifest、终态 carryover close 和当前 source pins 构造 fail-closed generation authority，不运行 benchmark、不清理证据、不自动重试。window-03 generation 正式 PASS 后，measure 又暴露出独立 issuer 缺口；新 measure issuer 继承59个既有受控根，加入seed、fixture、新authority与issuer identity，并仅预授权一个future output，形成63+1精确闭包。它同样只写authority，不执行measure；下一步仍需独立fresh审计后才可一次性签发。

第一次objects-limit measure在fresh authority下运行至29个完整回执后，以`EXECUTION_TIMEOUT`终态停止并保留第30个clone和全部partial。只读根因复核证明107次约1.99GB clone/open-audit/full-hash生命周期与固定900秒窗口数学不闭合；该失败不是受测Stop指标、身份或空间漂移。后续生产改动只允许在上述冻结路径内以RED→GREEN把1575个样本重构为3个group clone、105个durable Stop round receipt，并让新issuer显式继承旧measure window与partial根。旧UUID/window/label禁止重放，旧partial禁止删除、移动或吸收；不通过新独立复审与fresh authority审计不得签发下一窗口。

measure v2第一次新签发名称`window/label-02`在exclusive-create前以`GENERATION_PROOF`停止；修复42个contracts dist的固定工具链派生证明后，fresh audit对提交`3836db3f…`给出PASS。第二个唯一名称`window/label-03`在写入owner、installed supervisor、issuer identity、source pins与owned roots后以`AUTHORITY_PREFLIGHT`终态关闭，failure UUID=`57f2d338-357f-43db-9cb4-e21dbfe619d5`且`replayAllowed=false`；没有approved window、consume或measure。只读重建稳定证明根因是issuer用tracked-source位置加载的supervisor模块校验指向per-window安装副本的`window.supervisor.path`。生产修复提交`bf2ae144…`改由安装副本模块执行自身identity、candidate与window校验，并把预检终态拆为source、owned、facts、candidate、window五阶段安全诊断；异常文本、仓库路径和runtime路径不得进入receipt。02/03名称均永久禁止重放，新HEAD未通过fresh audit前不得签发后继窗口。

measure window-04在绑定候选HEAD `cfca7be9b7adc42045c371fe3648f3db6e9c4c8d`的fresh audit后一次性签发并消费。UUID=`02f6042a-b797-437d-a8da-45eafa2dd1f4`、window SHA256=`afdd51b40e412265eac85a000132168df83bf4a5b42f65150651a5b6dca3006b`、label=`r023-objects-limit-measure-04`。progress group完成105个样本，Stop第1轮写入durable receipt后，第2轮因复用同一Physical Copy而由正式Attempt链返回`COPY_UNAVAILABLE`；child自然exit 1，supervisor在terminal authority复核将终态收敛为`AUTHORITY_DRIFT`。close SHA256=`1baf8d8ba6d02d524a2368f4d5ce4e4854dba5d866d4dfcfbaac46e0666704f1`，elapsed=`62295.937791ms`，共111 samples、1个group receipt、1个Stop round receipt；group-stop clone与partial保留，PG empty、zombie=`[]`、`deviceOpened=false`、Gate B=`NOT_RUN`。该UUID、window-dir和label永久禁止重放，不能写成measure PASS。

修复提交`54b6353e9b12a2bdfdecf3c9bb452a53d34a00f5`为105个Stop回合预置105个不同、合法且冻结的Physical Copy/Plan，仍走正式receive→source authorization→media reservation→layout freeze→execution→archive→recording plan链，并保持105个SQLite commit/fsync、105个durable round receipt、1575样本、3个group clone与3次full hash；同Plan重放负例仍必须返回`COPY_UNAVAILABLE`。terminal authority复核在future output已经存在时只扣尚未形成的remaining plan，避免现有output与完整planned bytes重复计数，同时保持公开`plannedBytes=4249378816`合同。clone-owned workspace的文件树receipt、generation fixture before/after相等、tree digest、父目录、符号链接、多余项、成功清理和失败partial保留全部进入supervisor fail-closed闭包；不读取或哈希旧legacy carryover的大型SQLite。该修复提交时的新鲜结果为capacity 88/88、supervisor 16/16、issuer 23/23和Bridge Core typecheck全部exit 0；当时必须等待文档/STATUS同步及当前HEAD独立fresh audit，实际后继结果见window-06章节。02/03/04不重放。

### Window-04 后 successor recovery v3

本节只定义window-04之后的后继恢复候选，不重写历史。window-04公开合同继续保留`plannedBytes=4,249,378,816`及其`COPY_UNAVAILABLE`、child exit 1、supervisor `AUTHORITY_DRIFT`、partial保留事实；旧UUID、window-dir和label仍永久禁止重放。successor recovery v3把window-03/04 terminal carryover继续纳入owned闭包，历史联集为68个根，当前精确口径为`existing=70`、`future=1`、`authorized=71`。

后继冻结snapshot为`1,990,471,680`字节，使用`serial-single-clone-plus-bounded-growth-v1`，`plannedBytes=2,258,907,136`。该预算只适用于尚未签发的新窗口，不替换旧window的合同。运行期以整个output树的逻辑字节总和为hard cap，写前和阶段后事实持久化到`measure-aggregate-budget.jsonl`；任一时刻只能有一个active clone。超额、第二clone或身份漂移必须进入terminal stable stop，停止新增输出并保留失败现场。

后继issuer在发布authority前必须完成第二次验证，并重新确认window-03/04 carryover、70个existing roots、唯一future output、候选身份和空间事实；任何失败或漂移都不得发布。该前置现已由下述window-06结果关闭；没有设备、Roon或真实资料操作，Gate B=`NOT_RUN`、`formalReady=false`。TASK-079、queued-stop、joint和Owner验收继续保持未完成。

### Objects-limit measure window-06 软件PASS

fresh audit精确绑定候选HEAD `a457414fffd141390ec2ff4536452a0f654b1370`。序号05在consumer identity前置条件拒绝，未创建路径、UUID或authority；05永久不复用。window-06以全新UUID `afc81a99-d15d-4179-8326-5774a5c40b62`唯一签发并只消费一次；window SHA256=`cfac8e19336a181de00c68d458d046065cd821a0dca48cc4fc78af0e15c15227`、close SHA256=`1c93f6c6ec1a0b58619f87127d3e2c7d11a1cfcce1c155b3576a84eda2af84b7`、supervisor SHA256=`18ef840fe99b861ca8881c7c7be09b70c13431df02d88ddf282e29f2169cdc92`。

supervisor在`320,039.741875ms`自然exit 0，1575个samples、3个group receipts、105个Stop round receipts与18个stages全部形成；managed process group empty，zombie列表为空。aggregate预算审计共2383行，snapshot=`1,990,471,680`字节、limit/planned=`2,258,907,136`字节、最终output logical=`5,544,090`字节，`thresholdPassed=true`。这只关闭objects-limit软件measure；`deviceOpened=false`、`formalReady=false`、Gate B=`NOT_RUN`，large queued-stop、joint、整个TASK-079及Owner验收不得因此标记完成。

### Objects-limit queued-stop first-class控制面GREEN

提交`7d67f5069233fbbc5b00a9170c2639b9e237edf2`新增独立queued-stop issuer、supervisor校验路径与容量fixture aggregate guard，并只绑定冻结的measure window-06身份。successor authority schema固定为exact 73 roots：71个既有受控根、1个authority parent和1个issuer identity；输出嵌套在authority parent中。正式计划固定105 samples（5 warmup + 100 formal）、单active clone、单次执行上限50秒、总窗口900秒，snapshot=`1,990,471,680`、evidence allowance=`268,435,456`、planned=`2,258,907,136`字节；aggregate预期843行，成功终态预期636个输出文件。

TDD与回归结果为capacity `92/92`、supervisor `25/25`、issuer `5/5`，`corepack pnpm@10.17.1 verify` exit 0，control plane、boundaries与cycles均PASS，cycles扫描259个文件。issuer只负责exclusive authority发布，不执行benchmark；supervisor拒绝透传参数，并精确复核候选、工具链、issuer fact、window-06 carryover、105个唯一进程/请求/Attempt/marker、50秒闭包、PG/zombie、分布阈值、aggregate序列和输出集合。

上述结果只证明控制面GREEN。正式authority尚未签发，`authority.state=NOT_ISSUED`、`formalRun=NOT_RUN`，未创建新窗口、未分配新UUID/window-dir/label，也没有正式运行或PASS收据。下一步是形成稳定评审检查点并在该精确HEAD上做新鲜只读预检，满足后才可唯一签发。joint不得复用objects seed，且现有joint计划超过单活动输出预算，须先重构；设备、Gate B、Owner 103项、可听Replica、实体录音与打印均保持`NOT_RUN`或pending。

## 自动验证

```bash
node --test scripts/ci/test/verify-v3-owner-readiness.test.mjs
node scripts/ci/verify-v3-owner-readiness.mjs
node --test scripts/ci/test/verify-v3-owner-evidence.test.mjs
node scripts/ci/verify-v3-owner-evidence.mjs
/usr/bin/python3 -m py_compile scripts/ci/issue-v3-capacity-window.py
node --test scripts/ci/test/issue-v3-capacity-window.test.mjs
/usr/bin/python3 -m py_compile scripts/ci/issue-v3-capacity-measure-window.py
node --test scripts/ci/test/issue-v3-capacity-measure-window.test.mjs
/opt/homebrew/bin/python3 -m py_compile scripts/ci/issue-v3-capacity-queued-stop-window.py
node --test scripts/ci/test/issue-v3-capacity-queued-stop-window.test.mjs
node --test --import tsx packages/bridge-core/test/recording-capacity.test.ts
node --test scripts/ci/test/capacity-phase-supervisor-v2.test.mjs
corepack pnpm@10.17.1 --filter @music-bridge/bridge-core typecheck
git diff --check
```

就绪验证器的正常无设备结果必须是 `READY=false`、所有外部类别 `not-run`、Owner 103 条全部 `pending`。只有显式的后续本地证据录入模式才允许改变这些状态；本阶段不提供自动升级开关。

真实证据使用独立收据验证器，不能给现有 readiness 验证器增加放宽分支。Git 只跟踪 `template=true`、`ready=false`、`receipt=null` 的空模板；实际收据按不透明 ID 分别写入已忽略的 `reports/runtime/task-079-v3-final-acceptance/receipts/<receipt-id>.json`，该收据的全部附件只允许位于 `receipts/<receipt-id>/` 独占目录，并用 `--receipt-id <receipt-id>` 校验，不覆盖历史窗口。逐 case 事实、失败终态、Owner 技术引用、配置证书、候选身份和授权链必须由实际附件与 seal 交叉验证；正式 CLI 还必须从精确候选提交逐文件读取 Git blob 重算 manifest SHA-256，并拒绝非规范 UTC ISO 时间。单份技术收据、Owner 观察或模板通过都不能自动改写 `project/V3_OWNER_ACCEPTANCE.json`、Gate 状态或 `formalReady`。

Readiness 的机器状态不能只比较提交 SHA 字符串；默认 CLI 必须确认当前 TASK-079 仓库与分支，并验证两段证据基础设施检查点的 commit 对象、线性祖先关系以及 candidate closure 到当前 HEAD 的可达性。

Owner accepted 的前置按 scope 分层：B-01～B-15 必须引用同 scope 的技术 PASS；非 B scope 只有在冻结 TASK-078 矩阵 fresh 已通过且外部门仅为 `owner` 时，才允许零技术引用的 Owner 观察。任何还要求真实输入、Logic、Roon 或硬件的条目继续 fail-closed，不能由 Owner 单份观察替代缺失技术证据。

外部门技术收据按类别独立实现，不使用宽松的通用 PASS。首个 `real-input-observation` 只覆盖矩阵声明的 real-input 子门，固定七类附件、criterion SHA、候选和授权链，并由匿名 source alias/内容 SHA、只读不改原件事实共同支持。多外部门 scope 必须由 Owner 引用的技术收据集合精确覆盖全部非 owner requirements；A-02 只有 real-input 收据时仍拒绝。

`real-logic-observation` 只覆盖 MVP-08/09/10 与 D-05～D-08，固定匿名工作区、工程 Hash、导出 Hash、Marker 数和 Timeline Hash，并把环境 workspace alias 与观察附件交叉绑定。七个 scope 各自具有唯一允许结论，不能用其他 Logic case 的结论、普通文件存在或 Owner 单份观察替代。Owner accepted 必须引用同 scope、同候选且已 seal 的 real-logic PASS；真实 Logic 尚未授权或运行时继续保持 `NOT_RUN`。

`real-roon-observation` 只覆盖矩阵声明的九个 real-roon 子门，并以九套精确事实 schema 从匿名受控观察附件重算结论。observer 路径/Hash 必须存在于候选 manifest，窗口 correlation 必须贯穿授权、Plan、Preflight 和观察附件。A-02 只有在 real-input 与 real-roon 的 source alias/SHA 相同后才闭包；B-09 只有在 real-output/hardware 与 real-roon 同时 PASS，且窗口 correlation、事件 correlation、action kind 相同时才允许 Owner accepted。真实 Roon 尚未连接或授权时，收据验证器准备完成也不改变 `realRoon=NOT_RUN`。

`hardware-observation` 仅覆盖非 B 的 MVP-16、MVP-18、U-05 与 U-10；B-09～B-15 的 hardware 子门继续由同 scope `real-output-measurement` 承担，禁止跨 scope 借 B-14 或普通输出收据冒充完整 A/B 实录、Replica、库存守恒或实体中断。四个 scope 分别重算 A/B 人工翻面与实体确认、冻结历史 Replica 到真实输出端、5/1/1→5/0/2 且重启/重复完成不增殖、以及中断后实体介质与历史保留。每份 hardware 观察还必须引用同候选、同 manifest、同配置指纹且能递归验证其源 B-15 技术 PASS 的配置身份收据；该身份收据不等于完整 Gate B 已认证。MVP-16 依赖 B-07+B-14、U-05 依赖 B-14、U-10 依赖 B-09，依赖集合摘要进入授权→Plan→Preflight，并通过独立 subject-binding 对齐窗口、Attempt、实体副本、Side/完成/事件 correlation，且必须早于 hardware 授权。U-10 还与 real-roon 交叉匹配事件类型和状态事实。验证器准备完成不等于设备已连接、配置已认证、Replica 已可听、实体已录制或 Owner 已接受。

TASK-078 的严格 fresh validator 已在其原工作树以完整、未跟踪的 runtime 日志与收据通过并由最终报告锁定。TASK-079 新工作树不复制这些大体积 runtime 证据，因此不重放该入口；本任务以固定矩阵 SHA256 `12f15170…`、最终基线 `fac7363…` 与103/101/2实际内容复核继承软件封条。缺少旧 runtime 文件时的 `PATH_UNAVAILABLE` 不是新的验收失败，也不能被改写成重跑授权。

## 停止条件

- 需要设备枚举、打开、路由修改、测试音、录音、拔插、时钟/缓冲变化或故障注入，而 Owner 尚未明确该次操作范围。
- 需要读取真实 Source Root、照片、Excel、Logic、Roon/Provider 或凭据，而授权范围未建立。
- 设备或资料身份、测量计划、共同时基、无声判据、证据保存位置未冻结。
- 任一 Gate 失败、超时、证据哈希漂移，或出现自动回退、外放、未预期写入、设备残留占用。
- 同一问题三次修复仍失败，转为架构裁决，不做第四次试修。

## 完成口径

无设备阶段完成只表示 readiness 控制面、测试、报告模板和 TODO 已准备并保持 fail-closed。TASK-079 以及完整 V3 只有在真实资料、Gate A～E、真实录音/打印/Replica 和 Owner 逐项接受全部留下可审计证据后才完成。
