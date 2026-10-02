# ADR-038：Rust Core 从只读快照端点开始

状态：RUST-001 原型决定；不准入生产默认切换。

Owner 在 MBR-004 完成后明确授权实际开发。现有 Node 控制面已经把完整两库、208 个领域命令交给单一 Dataset Owner；Rust 第一阶段复用四方法端点接缝，先证明进程、数据合同和生命周期成立。

Rust 仅持有 Node 导出的不可变 CollectionModel 数组，提供 collection.list 无筛选分页。调用方必须确认一次导出完整，不能拼接正在变化的多页。现有 Node Owner 继续是唯一数据库作者；Rust 不收文件路径或打开 SQLite。完整协议见 [只读协议 v1](../contracts/rust-readonly-sidecar-v1.md)，TypeScript factory 位于 packages/bridge-core/src/rust-core/readonly-sidecar.ts。

库存顺序、ID、null、缺省字段、数量及代表图元数据保留；不重新执行 localeCompare 或历史 hash。协议只接受严格 JSON 子集，collectorPolicy 须为字符串，孤立 UTF-16 代理项拒绝，数值 -0 按 JSON 语义归一化为 0；不写回生产库或重算历史。wire unit 使用 null，由 TS 恢复成既有 undefined。显式可选端点不注入主应用默认启动，也不声称完整 owner 的208命令已迁移。

二进制用调用方提供的绝对路径与摘要固定，启动/正常关闭前后复核；不查 PATH、shell 或用户配置替代程序。原型只验证构建出来的可执行文件，不等于包内签名和正式资源准入。子进程只得到 LANG 环境，不继承账号或凭据变量。帧、模型数、在途及历史请求均有预算；损坏信封或回执、超时和崩溃撤销端点，不重放。关闭必须先等已接受操作，再拿到 ACK 和自然退出；强制终止只报告失败。

自动 Gate 使用固定 Rust 工具链/Cargo.lock，fmt、clippy、Rust 单元及实际进程测试，TS fake 故障测试、真正的 Node 两库 Owner 到 Rust 差分、2000型号、真实 child 崩溃；记录源码与二进制摘要。新增 CI 独立执行此 Gate。Node 原有 typecheck/unit/build 和控制面/安全/循环门禁保持原范围。

本期结果证明可复用跨进程只读边界，不证明 Rust 加速、不证明实时库视图。后续扩展筛选/查询须先冻结排序及完整事实来源；迁移写入须覆盖两库原子事务、幂等回执、unknown、不可变历史、激活/关闭和旧库兼容。新 Local Library/Resolver、录音调度、默认启用和分发分别定义任务，不借本原型自动放行。MBR-004 真实 Roon 归因、Gate B/P4/P5 与 Owner carryover 保持原状态。
