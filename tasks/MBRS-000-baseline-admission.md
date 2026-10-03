# MBRS-000：真实基线、唯一主责与有限准入记录

状态：PASS（仅基线记录交付）；完成条件是本轮基线记录交付，允许结论为 `BASELINE_DELIVERED_G0_NOT_ADMITTED`，不以 G0 解锁为任务000自身的环形依赖。版本 v1.2。基线 `044e6b24edf81b64030d4c96741082670532971c`，分支 `codex/mbrs-000-baseline-admission`；实现 / 报告身份由主控保存的提交后身份收据解析。

Owner 已明确换届并连续执行 v1.2，先做000，再按准入推进。当前产品 G0 仍 NOT_ADMITTED，R15-C06 强制前置未闭合；准入模式为明确阶段交接下的隔离基线 / 合同 / 纯规则 / 合成 HTTP / 安全离线准备。实际动作边界见 `docs/postrust/MBRS-000/AUTHORITY_SCOPE.md`。

本任务交付一次真实基线、各进程 / 库作者、12复用符号 / blob / SHA256、全部14未完框的唯一主责、18任务 / 156验收台账、有限源写与普通点播规则 ADR。全部未完框按原 source 行 / blob 冻结，转交仍 OPEN。RUST-016 等后续编号仅本轮拟登记任务，PLANNED / NOT_STARTED，不是历史已完成或已批准退出范围；C01 / C06 保留唯一原 Rust 基线修复主责，不挪给依赖 G0 的 MBRS-002～017。

允许修改：`docs/postrust/MBRS-000/*`、本任务文件、`project/POSTRUST_TODO.md` / `POSTRUST_PLAN.json`、ADR-MBRS-001/002/003、新的结构 Gate / 测试。生产源码保持 base 字节；主控最后整合 AGENTS / STATUS / 原 Rust TODO，并负责串行验证与提交。旧 015 树封存；其它工作树 / WIP 原样保护。

验收原文逐条见 `project/POSTRUST_PLAN.json` 的 MBRS-AT-000-01～10，最终八条基线记录PASS、000-02/03 PARTIAL；文档 / 历史证据不能写成新应用 PASS。需要主控新鲜 Gate、原始 Owner 范围与来源核实、独审后按相应层更新；任务000文档可交付而整体 G0 保持关闭。

结构验证命令（由主控串行执行并保存外置日志）：

```bash
node --test scripts/ci/verify-postrust-baseline.test.mjs
node scripts/ci/verify-postrust-baseline.mjs
git diff --check
```

新 Gate 不运行应用、不验证权限真实性；它校验包冻结断言、14原框完整覆盖、单一作者、12复用代码身份、任务依赖 DAG、未完前置阻断和五层证据区分。所有新临时 / 日志 / 缓存仅外置 LifeWeave。该角色未运行 Gate / 构建 / App；退出码由主控记录，不先填0。

继承失败与历史 Source15 原件见 `REGRESSION_LEDGER.json`。提交后主控绑定实现提交、独立报告提交、远端收据、受保护 WIP 前后与下一分支最终 HEAD；不沿用 push 前旧快照冒充最新远端。RUST-016 在新分支冻结自己的生产修复范围，当前000不抢先改生产。

回退本轮新文档 / Gate 不触碰任何用户数据库或文件。后续仍按代码、数据库、源文件和运行服务三层回退分别记录；真实扫描 / Roon / 发声 / 源写 / DSP / 音量 / Core / main / 安装 / 发布许可分别保留。
