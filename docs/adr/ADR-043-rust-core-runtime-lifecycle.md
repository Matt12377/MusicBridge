# ADR-043：Core 显式只读路由的生命周期组合

状态：RUST-006 显式可选运行时原型，本地 Gate 已通过；生产默认 Node。

RUST-003～005 的独立路由借用已 boot 的 Node Dataset Owner，不拥有来源生命周期。现有 Core 启动包装只转发 prepare/dispatch/commitBoot/close，尚未把私有快照能力、Rust 候选与 Core ready/shutdown 组合起来。直接用借用路由替换端点会遗漏 Node boot/close，或提前公布未完成的 Rust 能力。

选择一个同步创建的内部组合端点：它拥有 Node，内部 router 仍借用 Node。端点的 prepare/commitBoot/close 合并并发调用；一次 Node boot 后创建 router，再显式刷新。初始 boot 的单一单调期限包括 Node boot、版本探测、原子导出、完整 Rust ACK 与后置版本核验。组合成功前不派发领域请求，也不允许 Core ready。独立 router 的 scope、版本、generation、unknown 原回执、最多一个 child 与显式刷新合同继续复用。

可信主机可通过 `runCoreUtilityProcess` 第七参数提供固定路径/SHA 与旧预算选项。必须同时提供 DatasetOwnerFactory，并把 raw client 的私有能力交给组合端点；来源缺能力时明确失败并关闭已登记 Node。旧六参数、桌面 core-entry、环境变量及 Renderer/父 port 消息不获得此权限。默认不创建组合、不导出、不启动 Rust。Node 保留生产数据库写入以及 Provider/Roon/凭据/播放/录音控制面。

现有 attachCoreRuntimePort 会在 beforeReady 结束前注册监听；新组合在内部封闭未就绪领域请求。控制面依照现有启动链处理。内部 Rust 错误继续经现有安全失败投影，公开合同不增加路径、pin、私有 code 或诊断字段。写入和潜在 unknown 使用 Node 原回执；失效后复用既有 Node 路由，不自动刷新或重放。

关闭先封闭请求并登记候选与 Node 清理，消费迟到创建/导出/boot 的结果。来源只关闭一次；普通成功必须取得 Rust ACK 与自然退出、Node owner 自然退出。错误、超时或强制信号单独记录，不能用 pid 消失代替成功。组合拥有 Node 与内部 router 借用 Node 是两个边界，不改变旧路由的 borrowed 规则。

验证使用真实 Node Core worker 运行原始启动函数、真实两库 owner 和固定 Rust 二进制，数据均为新建合成库。完整公共请求/响应、原子快照差分、启动失败与关闭资源证据独立于受控单元故障记录。此验证不代表 Electron utilityProcess、应用签名安装、真实账号/Roon/设备或 Owner 验收。

任务见 [RUST-006](../../tasks/RUST-006-runtime-lifecycle.md)，内部合同见 [运行时组合](../contracts/rust-core-runtime-v1.md)。后续默认启用、可信主机刷新入口、打包签名和持久化迁移另立范围。
