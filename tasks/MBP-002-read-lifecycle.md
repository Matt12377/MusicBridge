# MBP-002 — 只读请求生命周期

基线：37fe2d22168d20b5defa336d679c8c8d7dc5d06a；分支：codex/mbp-002-read-lifecycle。Owner 已授权连续实施，保留 Electron/Vue/Node/TS。

明确只读白名单；Renderer 本地 Signal 不跨 contextBridge；Main 验证可信窗口、ID、原参数与截止期限；Core 在读预算内共享 flight，各订阅者独立取消，最后订阅者离开才结束底层生命周期。期限只能缩短当前预算。写操作、outbox、录音 Begin 及未知回执不进入取消协议。

Provider 不支持实际撤销时，不再派发后续页并拒绝迟到写回；Roon 状态不明会话不能复用，替换 key 后按稳定路径重新核对实体。账户、Core、Zone/服务作用域换代隔离旧数据，资源数量有界。

Renderer 修复离页抢回、加载标志跨代停滞与隐藏防抖派发；保留搜索、父详情、滚动与已完成数据。本阶段不实现 MBP-005 TTL/渐进搜索或 MBP-004 真分页。

定向行为 RED/GREEN 后，固定实现 SHA 跑原完整 verify、Electron 门禁和完整 E2E。独立实现/报告提交，再 push 开发分支；真实账号、Roon、设备、main 和正式 App 不在软件 Gate 中。
