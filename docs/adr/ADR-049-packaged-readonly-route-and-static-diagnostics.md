# ADR-049：固定候选包的可信 Rust 路由与编译诊断

状态：RUST-012 实施，生产默认仍为 Node。

RUST-011 只验证最终资源、外部 Node→Rust 协议与默认包启动，尚未证明 Main 固定 Core 入口会使用包内 Rust。若在 Core 登记父端口监听前异步验资源，Main 已转移的启动端口可能丢失；只跑 ping/health 也不能证明收藏路由。

选择同步登记监听、闭集父消息后才执行五秒有界可信资源 factory，作为 utility 第九参数；保留原六参数与第七/八合同。资源目录固定 process.resourcesPath、pin 固化编译、profile 为现有 wire2。Node 继续唯一写入，Rust 只读。

候选 Gate 使用四份独立静态签名包。诊断流程编译进入候选 Main，直接使用原 Supervisor typed 请求，串联合成写入、筛选、写后 Node 回退、固定可信刷新和自然关闭。额外观察端口及 stdout pipe 明确披露；默认编译为 false。此方案避免依赖外部私有 fork wrapper 或 inspect，并使签后全链行为可复核。诊断 Main 字节与生产不同，不能称原 Main 字节不变。

完整签名、ASAR/Fuse、运行回执、各进程身份与程序/Git 身份由独立证据准入绑定。该工程 Gate 与 Renderer、Owner、真实服务和生产默认启用分开验收。详情见 [合同](../contracts/RUST-012_PACKAGED_READONLY_ROUTE_V1.md)。
