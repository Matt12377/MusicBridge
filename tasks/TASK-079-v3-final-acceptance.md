# TASK-079：真实环境就绪与最终 Owner 验收

基线 `fac7363b4a6481591e207dda7cca77f0ae8d3cd4`，分支 `codex/task-079-v3-final-acceptance`，独立树 `worktree/task-079-v3-final-acceptance`。TASK-078 的本地自动软件子范围已经封版；本任务承接尚未运行的真实输入、真实 Logic/Roon、真实设备、实体打印和 Owner 产品验收，不重写 TASK-078 的软件证据。

当前没有设备连接。Owner 后续计划使用 RME 或 Apogee 声卡与 Sony 卡座，但具体型号、连接、采样率、声道、缓冲、时钟、测量方法和故障注入范围尚未冻结。本阶段禁止枚举、打开、配置或发声，禁止读取真实音乐、库存、照片、Excel、Logic 工程、Roon/Provider 账号或凭据；不 push、不合并 `main`、不签名、公证、安装或发布。

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
- `reports/TASK-079_REAL_GATE_RUNBOOK.md`
- `reports/TASK-079_READINESS.md`

除非后续真实 RED 明确证明需要生产修复，否则本无设备阶段不修改应用、Core、合同、数据库或原生输出代码。任何生产修复必须先单独冻结允许路径并执行 RED→GREEN；不能为了让清单变绿而放宽真实 Gate。

## 自动验证

```bash
node --test scripts/ci/test/verify-v3-owner-readiness.test.mjs
node scripts/ci/verify-v3-owner-readiness.mjs
node --test scripts/ci/test/verify-v3-owner-evidence.test.mjs
node scripts/ci/verify-v3-owner-evidence.mjs
git diff --check
```

就绪验证器的正常无设备结果必须是 `READY=false`、所有外部类别 `not-run`、Owner 103 条全部 `pending`。只有显式的后续本地证据录入模式才允许改变这些状态；本阶段不提供自动升级开关。

真实证据使用独立收据验证器，不能给现有 readiness 验证器增加放宽分支。Git 只跟踪 `template=true`、`ready=false`、`receipt=null` 的空模板；实际收据按不透明 ID 分别写入已忽略的 `reports/runtime/task-079-v3-final-acceptance/receipts/<receipt-id>.json`，该收据的全部附件只允许位于 `receipts/<receipt-id>/` 独占目录，并用 `--receipt-id <receipt-id>` 校验，不覆盖历史窗口。逐 case 事实、失败终态、Owner 技术引用、配置证书、候选身份和授权链必须由实际附件与 seal 交叉验证；正式 CLI 还必须从精确候选提交逐文件读取 Git blob 重算 manifest SHA-256，并拒绝非规范 UTC ISO 时间。单份技术收据、Owner 观察或模板通过都不能自动改写 `project/V3_OWNER_ACCEPTANCE.json`、Gate 状态或 `formalReady`。

TASK-078 的严格 fresh validator 已在其原工作树以完整、未跟踪的 runtime 日志与收据通过并由最终报告锁定。TASK-079 新工作树不复制这些大体积 runtime 证据，因此不重放该入口；本任务以固定矩阵 SHA256 `12f15170…`、最终基线 `fac7363…` 与103/101/2实际内容复核继承软件封条。缺少旧 runtime 文件时的 `PATH_UNAVAILABLE` 不是新的验收失败，也不能被改写成重跑授权。

## 停止条件

- 需要设备枚举、打开、路由修改、测试音、录音、拔插、时钟/缓冲变化或故障注入，而 Owner 尚未明确该次操作范围。
- 需要读取真实 Source Root、照片、Excel、Logic、Roon/Provider 或凭据，而授权范围未建立。
- 设备或资料身份、测量计划、共同时基、无声判据、证据保存位置未冻结。
- 任一 Gate 失败、超时、证据哈希漂移，或出现自动回退、外放、未预期写入、设备残留占用。
- 同一问题三次修复仍失败，转为架构裁决，不做第四次试修。

## 完成口径

无设备阶段完成只表示 readiness 控制面、测试、报告模板和 TODO 已准备并保持 fail-closed。TASK-079 以及完整 V3 只有在真实资料、Gate A～E、真实录音/打印/Replica 和 Owner 逐项接受全部留下可审计证据后才完成。
