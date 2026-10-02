# Rust Core 可信主机控制 v1（内部）

扩展内部 [Core 组合 v1](rust-core-runtime-v1.md)，不扩展公开 IPC/worker/sidecar。默认 Node 和原六/七参数保持。

## 同步能力交付

`runCoreUtilityProcess` 的第八参数仅为可信源码传入的 `onRustReadonlyCoreController` 函数，要求显式 Rust options 和 DatasetOwnerFactory。组合端点先登记，再同步交付一次，再 prepare/boot；callback 只允许返回 undefined。异常或异步返回不得等待或延长启动预算，Promise 拒绝必须消费，启动失败关闭组合和 Node，不能 ready。无环境/Renderer/父 port/public RPC 启用通道。

`RustReadonlyCoreController` 是冻结闭包，只有 `refresh(): Promise<void>`、`invalidate(): void`、`getStatus(): RustReadonlyCoreDatasetOwnerStatus`。不交付原端点、数据库、配置、pin 或 dispatch/prepare/boot/close。私有安全状态只供可信宿主；公开健康/诊断/ready 不增加字段。调用方不能通过修改对象增加能力。

refresh/invalidate/status 复用组合原行为：未 ready refresh 失败；写入/unknown 后不自动建立 child；显式 refresh 按单一期限、完整原子快照及 boot ACK/后置探测更新；并发 refresh 合并。invalidate 撤销当前候选/读取代次。close 由 Core 负责，外部保留的 controller 在关闭后拒绝 refresh，不能复活 Node/Rust。

## 混合读取

仅以下六条已审定纯读命令由 Node 执行且不撤销有效 Rust：collection.detail/copy/photo、referenceCatalog.sources/history/revision。只读辅助链限 SELECT、读事务、验证与内存投影，不调用参考快照 INSERT 或迁移。Node 原结果/错误不被改写，迟到结果必须通过原 generation/close 围栏；并发潜在写入、刷新、失效或关闭使旧读取失败。

collection.list 保持旧版本前后探测、scope 和全部 DTO 校验。其他领域命令继续保守失效；写结果和 unknown 不被 generation 错误覆盖、不自动重放。跨源 Node 纯读与 Rust 返回不承诺一次多命令快照；外部数据库版本变化由既有探测识别。预算保持 v2-2000/4 MiB 和显式 v3-5000/8 MiB。

## 证据边界

实际测试父通道是合成宿主专用，不属于产品公开控制协议。普通 child 自然退出、在途关闭、回调失败单独记录；不以轮询耗时冒称精确 Core 性能，不以 Node worker Gate 冒称 Electron/签名安装/真实账号设备验收。
