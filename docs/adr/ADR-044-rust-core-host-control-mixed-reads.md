# ADR-044：可信宿主控制和不撤销快照的纯 Node 读取

状态：RUST-007 显式可选主机控制与混合纯读取；生产默认 Node。

RUST-006 的组合在 Core ready 前完成 Rust 启动，但外层包装隐藏 refresh 等内部方法；写后退回 Node 后宿主无法显式恢复。router 在任何非 list 命令前撤销 Rust，收藏页的 sources/history/revision 和 detail 读取也会终止该路径。

选用源码内可信 callback 能力交付。第八参数要求第七 Rust options 与 DatasetOwnerFactory，组合登记后在 prepare 前同步交付一次冻结 narrow controller。只有 refresh/invalidate/getStatus；默认入口、环境、父 port、public IPC 和 Renderer 不获得配置权限。同步/异步异常由启动失败清理处理，不把未完成回调当 ready 或延长启动预算。关闭所有权留 Core，捕获能力受组合 closing/closed 规则约束。

只保留六条经 SQL/辅助链审计的纯 Node 读取命令：collection.detail/copy/photo 和 referenceCatalog.sources/history/revision。它们保留当前 Rust generation 和 child，原 Node 错误及结果保持且 generation 围栏仍执行。潜在写入以及其他领域命令继续保守撤销；不是依据 get/list 名称猜测副作用。列表仍经前后版本探测/完整回执校验，因此保留 pure Node 并不承诺多命令事务或绕过版本检测。

实际证据使用新合成库、真实已发布参考版本和原 Core/Node/Rust 链，验证初始化、混合读、写后显式刷新、并发刷新及关闭竞态。默认 Node、生产唯一写入者、Provider/Roon/凭据/音频控制职责不变；平台分发、安装签名、真实服务/Owner 和持久化迁移另验。

任务见 [RUST-007](../../tasks/RUST-007-host-control-mixed-reads.md)，合同见 [可信主机控制](../contracts/rust-core-host-control-v1.md)。
