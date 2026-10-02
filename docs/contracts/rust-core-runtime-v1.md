# Rust Core 运行时组合 v1（内部）

本合同约束显式可选的 Core Dataset Owner 组合，不扩展公开 IPC、worker 协议或 sidecar v1/v2/v3。生产默认 Node。

## 创建与权限

`createRustReadonlyCoreDatasetOwner(owner, options)` 同步返回内部端点，创建本身零 RPC/零 child。options 为既有 RustReadonlyCollectionRouterOptions 去掉 owner，固定 binary 绝对路径/SHA、可选 v2-2000/v3-5000 与既有期限。来源必须拥有所需版本/原子快照能力；v3 还要求 large 能力。默认预算保持 2,000/4 MiB，显式 large 保持 5,000/8 MiB。

`runCoreUtilityProcess` 第七参数是该 options；缺省时执行原 Node 包装，兼容 legacy DatasetOwnerEndpoint。启用时必须配合 DatasetOwnerFactory。raw Node client 在任何可能失败的组合创建前登记，确保启动失败收口；外层 prepare 继续更新 Roon projection 的 ownerIdentity，close finally 继续封闭 projection gateway。配置不来自环境、公共请求、父 port 消息或 Renderer。

## 生命周期

内部 getStatus 的组合 phase 为 new/prepared/booting/ready/failed/closing/closed，附可选 router 状态和安全 errorCode。状态只供可信主机与合成测试读取，不进入公开健康/诊断响应。

prepare/commitBoot/close 合并并发调用；Node prepare/boot/close 各执行一次。初始 boot 成功顺序为 Node boot → 版本探测 → 原子完整导出 → Rust prepare/分块或单帧上传 → 完整 commitBoot ACK → TS 索引/事实核验 → 后置版本核验 → ready。Node boot 至最终 ready 使用单一 performance.now 期限，等待耗时不能通过每步重置获得额外预算。

领域 dispatch 在 ready 前或关闭后失败，不触达 Node/Rust；只接受已有领域命令闭集。ready 后 collection.list 可交给只读 router，其余领域命令交给 Node。Provider/Roon/凭据/播放/录音控制面仍使用现有 Core 分派，不进入该端点。公开端点失败继续现有安全 IPC 投影，内部错误不成为新公开错误合同。

写入、scope/版本变化、显式 invalidate、刷新和关闭继续采用旧 router 围栏。Node 原回执及 unknown 保留，不自动重放；失效后的读取回到 Node。refresh/invalidate 仅为内部可信操作，本任务不新增公共刷新命令或正式应用启用入口。

close 即刻撤销派发权限，登记所有已知候选及 Node close；迟到操作始终被消费、不能重新公布 ready 或 Rust。清理合并但不吞掉失败；固定期限内无法确认关闭的资源须记录为未确认。普通 Rust close 必须 ACK 加自然退出，Node owner 也要自然退出。强制信号/错误不能写成正常关闭。

## 证据边界

实际 Node worker 中适配 process.parentPort、MessagePort，仅是受控测试宿主；它运行真实 runCoreUtilityProcess、Node Dataset Owner 与 Rust binary。测试父通道可观察合成库与资源，不获得产品公开配置权限。普通进程成功、负面故障、Electron/真实服务/签名安装验收分别记载。
