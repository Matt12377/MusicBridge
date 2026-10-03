# 换届授权与动作边界

本记录是权限范围的定位记录，不是凭据，也不能单独给后续动作授权。

<a id="owner-current-session-explicit-phase-handoff"></a>

主控转交的当前 Owner 指令为：连续执行 PostRust v1.2，先 MBRS-000，再依准入推进；从 RUST-015 最终报告 HEAD 建独立隔离树。主代理 gpt-6.1-sol/max，三个子代理 gpt-6.1-sol/high；本轮当前指令覆盖旧 AGENTS 的子代理 max 记录。只有本角色写 MBRS-000 正文 / 台账 / 结构 Gate，不派生代理。当前会话身份和子代理参数由主控核验，改本文档不会自动切换模型。

允许动作：读源码 / Git / 既有报告及冻结原件；隔离基线盘点；合同 / 纯规则 / 合成 HTTP / 安全离线修复。生产接入仍须关闭 R15-C06 并重新记录 G0。当前 `mode=EXPLICIT_PHASE_HANDOFF` 只说明阶段授权，`decision=NOT_ADMITTED` 说明整体产品接入未开放，两者不可混写成 PASS。

不扩大动作：不真实全库扫描、连接账号 / Roon、发声、抢占 Zone、改 DSP / 音量、写源文件、Core 重启、main 合并、正式 App 替换 / 安装或发布。源文件操作需具体 Organizer 计划和精确文件 / 字段 / Hash 权限；包合法、客户端 approval 或本 ADR 都不能代替。

当前写范围：`docs/postrust/MBRS-000/*`、`docs/adr/ADR-MBRS-001*` 及 002/003 有限规则、`tasks/MBRS-000*`、`project/POSTRUST_TODO.md`、`project/POSTRUST_PLAN.json`、新的 MBRS-000 结构 Gate。主控独占最后的 STATUS / 原 Rust TODO 整合、验证排班、提交和 push；本角色不运行 App / 构建 / 性能实验，也不 commit / push。

旧 015 树封存，其它 WIP 保留；不 reset / clean / stash，不拷贝 WIP 作验收基线。结构验证结束后仍须由主控核实当前 Owner 原始请求与本范围一致；此文件不是授权真实性自动判断器。

本轮模型核实收据为外置 `MODEL_AND_ROLES.json`，其字节/SHA256在 `BASELINE_INPUTS.json`；主控JSONL与三个角色turn_context分别证实主gpt-6.1-sol/max、子gpt-6.1-sol/high。
