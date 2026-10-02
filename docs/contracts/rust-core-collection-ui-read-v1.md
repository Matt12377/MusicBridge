# Rust Core 磁带收藏页面读取与刷新领取合同 v1

内部合同对应 RUST-009，不新增公开 IPC/Renderer 配置或生产默认启用。Node 继续负责数据库作者、Provider/Roon/凭据/播放/录音。Rust 只读取原不可变完整收藏型号快照；进度、求购、历史、来源及图片辅助阅读仍由已 boot 的固定 Node Owner 连接返回。

## 精确 Node 纯读集合

原八条：collection.detail/copy/photo；referenceCatalog.sources/history/revision；commandOutbox.context；collectionProgress.modelLengths。

新增八条：collectionProgress.current/wants/wantHistory/snapshots/snapshot；referenceCatalog.snapshot/source/sourceZipReceipts。仅成功 boot 且连接已打开后准入。首次连接 open 的迁移/恢复不能冒充纯读。请求验证/预算、SELECT、解析、原错误、scope/generation 与读取完成屏障保持；操作 Map 不跨调用。不存在 collectionProgress.* 或 referenceCatalog.* 通配准入。

collection.list 保留原可选 Rust 查询及前后版本检查、完整结果验证、readContext 的 Node 路径。写/未经审定操作保守 revoke，不自动导出、刷新、重放或重新发布旧对象。

## 条件领取及刷新发布

recordingPrintWorker.claim 永远交唯一 Node 作者执行一次。准入窗口在首个 await 前同时登记写计数与完成屏障。精确 non-Proxy plain own-data lease:null 只是必要条件，还须前后探测完整 epoch/datasetId/revision 一致。

活动候选要求同候选对象/同 generation 且版本等候选。刷新中没有 active 的阶段要求本次 refresh 自己拥有的 generation/certificate；已取得的导出版本须与领取证明一致。导出、上传、boot 后的发布及同代 Node/Rust 读成功和错误均不能越过未闭合窗口；等待受原整体单调期限约束，不重置期限。

非空/异常/unknown/探测失败/版本或身份变化撤销自己仍拥有的代次并唤醒旧读，保留原 Node 结果或错误。close/invalidate/fatal 即时唤醒；旧窗口迟到不能撤销新代次、重新发布旧 child 或遮蔽原错误。多个窗口、resolved latch 后的新窗口、发布前最后检查须在行为测试中证明。后台打印 interval 仍为 1,500 ms。

## 隔离实际页面证据

静态固定测试 entry/profile/pin，原 Main/Owner/preload/Vue 页面与 mock-keychain/test Bridge 新合成 profile；不替换安装应用或默认 dist。实际 UI 读写操作来自 locator 交互，直接 window.musicBridge 调用只能另记 API 证据。每个动作绑定真实 DOM/截图、公开 request/reply、完整合成 DTO/SQLite oracle、候选状态/child ACK/PID 与自然退出。

默认 Node 与显式 100/2,000/5,000 分层记录，不把访问两页说成遍历所有 UI 页。至少包含非空求购、两版目录和现有历史/图片辅助链。受控刷新等待必须覆盖真实后台空领取，保持单次显式 refresh 与最多一个 child；原保护设置表单验证 Node outbox 单写及回退。造假导航、缺关键请求、缺 ACK/自然退出、强制清理、源/产物/binary 漂移必须拒绝。

预算与旧公开合同不变。真实服务、用户库、系统钥匙串、真实音频/设备、Owner、安装发布和远端 CI 均另列 NOT_RUN。
