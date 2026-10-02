# ADR-045：Main 初始化读写边界和隔离 Electron 宿主

状态：RUST-008 已实施并通过本地 Gate 与两轮独审；生产默认 Node，正式用户启用另验。

实际 Main 的 outbox 身份读取和 1.5 秒空打印领取会终止 Rust 候选。领取并非纯读：有效 pending job 会在同一 Node 连接写 jobs/events，改变快照版本。只按名字白名单或延后 revoke 会使并发读取在写后探测前发布旧结果。

选用八条精确纯 Node 读取和有限条件领取证明。只在 strict null、同候选/代次、前后 scope/version 一致时保留；真实租约或任何不确定性撤销。条件窗口登记 writes 并建立读取完成屏障，判定先于放行，撤销立即唤醒；原 Node 回执只执行一次且不被辅助检查覆盖。旧列表完整探测和 DTO 深校验保留。未审定的 collectionProgress.current 仍保守撤销，本期不据此宣称完整收藏 UI 准入。

将原 core-entry Owner 创建抽取到同进程共享 adapter，默认零选项继续 Node。隔离 Electron 私有编译入口固定 Rust pin/profile，共享生产 adapter、Main/Supervisor/Owner/preload/outbox 和实际后台 worker；窄测试端口只提供可信 control/观察，不增加公开开关。真实 Electron 与 Worker/受控组件证据分开，生产默认启用、数据迁移、真实服务及签名分发另验。

任务见 [RUST-008](../../tasks/RUST-008-main-read-boundary.md)，合同见 [宿主读写边界](../contracts/rust-core-main-read-boundary-v1.md)。
