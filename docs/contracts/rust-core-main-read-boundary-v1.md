# Rust Core 正式宿主读写边界 v1（内部）

扩展 [可信主机控制 v1](rust-core-host-control-v1.md)，仅供可信源码；默认 Node 与公开 IPC 不变。

## 精确纯读

已 boot 的固定 Owner 新增 `commandOutbox.context`、`collectionProgress.modelLengths`；加上旧六条，共八条。原 Node 结果和错误保持，generation/closing/scope 围栏继续执行。其他命令仍保守失效，包括未审定的 `collectionProgress.current`。

## 有条件领取和完成屏障

`recordingPrintWorker.claim` 单次到 Node。只有非 Proxy 的精确 plain own-data `lease:null`、前后完整 version 一致当前同对象候选、同 generation 且未关闭时保留。反射检查不调用 getter；Proxy 在检查属性描述符前保守拒绝。条件窗口同步计入 writes，辅助探测不能覆盖原 Node 回执/unknown/错误；不重新挂回对象、不自动刷新/重放。其他回执、错误、版本变化、探测失败先撤销，迟到判定不伤新代次。

所有读取的成功和错误在条件窗口归零前暂停交付，再核原围栏。多个窗口不能提前放行；唤醒后有新窗口须重新等待。撤销和 close 立即唤醒并拒绝旧读，不能等挂起 claim。真实写入仍使旧读取失效，空轮询证明成立则保留候选和原读行为。

## 桌面共享入口

生产 `runDesktopCoreHost` 复用原 Worker 环境/身份/workerData、Owner factory 和 Core 生命周期。零选项入口仍 Node；显式 options/controller 只来自同进程可信源码。没有 Rust env/启动数据/public IPC/Renderer 选择器。测试第二私有端口不进入生产公开合同；二进制 pin/profile 在隔离测试编译源码固定。

实际 Electron/受控组件/真实账号设备验收分别记录。见 [RUST-008](../../tasks/RUST-008-main-read-boundary.md)。
