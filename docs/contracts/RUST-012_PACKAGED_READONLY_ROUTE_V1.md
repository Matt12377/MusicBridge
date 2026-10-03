# RUST-012 包内只读路由合同 v1

基线为 RUST-011 最终报告 `13b2a14f03831ed7a98bdc5d1b9ab288644fc502`。本合同限定离线合成候选包；默认应用仍使用 Node，数据库只有 Node 一个作者。公开 IPC 版本 1、资源清单 schema 1 与 Rust snapshot wire 2 分别计证，不混用版本编号。

## 启动能力

`runDesktopCoreHost` 新增同进程可信 `createRustReadonlyCollection` 选项，精确转交 `runUtilityCore` 的第九参数。原默认六参数、原第七配置对象和第八同步 controller 回调保持；第七与第九参数互斥。父端口监听同步登记，收到原闭集 `musicbridge.core.port` 消息后，先验消息和可信参数，再调用 factory 一次。

factory 整体期限五秒；非法返回、同步异常、拒绝或超时都不能创建 Node Owner、Rust child 或发送 ready。迟到 Promise 被消费，不恢复启动。准入结果在创建唯一 Node Owner 前验证，之后沿用原 prepare/boot、写失效、刷新、关闭和清理合同。Owner 装饰器失败时仍关闭原 Owner。

Rust 专用静态入口只用编译常量 `__MUSIC_BRIDGE_RUST_MANIFEST_SHA256__`，通过 `process.resourcesPath` 与原资源 resolver 定位固定 `rust-core/darwin-arm64`；profile 固定 `v2-2000`。无运行期 env、CLI、Renderer、父消息提供入口、二进制、pin 或模式的能力。第八 controller 保持原冻结三项 `refresh/invalidate/getStatus`，只在同进程可信源码交付。

## 四份静态候选

| 包身份 | 编译诊断 | Core 源入口 | 清单 pin | 验证作用 |
| --- | --- | --- | --- | --- |
| default-node | false | core-entry.ts | 无 | 原默认启动流程与 Main 自然关闭 |
| node-diagnostic | true | packaged-node-core-entry.ts | 无 | 同固定 Main 流程的 Node 参照 |
| rust-diagnostic | true | packaged-rust-core-entry.ts | 最终资源清单 SHA256 | 包内 Main/Core/Node/Rust 全链 |
| pin-rejected | true | packaged-rust-core-entry.ts | 固定错误 SHA256 | 真实准入失败且不创建来源 |

每份包都是独立 arm64 ad-hoc 签名 `.app`，保留原七项 Fuse 策略和实际第 6/8 位，ASAR header integrity 与整个包树逐项绑定。三个诊断编译配置的入口、pin、输出目录写为构建期字面量；这些配置只参与编译，不被应用加载。不使用外部 JavaScript 启动、调试参数、私有 fork 替换或削弱 Fuse。

Main 实际诊断编译字节与生产不同，这一差异必须披露。Main 仍使用原 CoreSupervisor、固定包内 `core.js` 和空 args；诊断专用 stdout pipe、额外私有第二端口，以及外置 TMPDIR/DEV_BUILD_ROOT/DEV_CACHE_ROOT 为明确候选差异。公有 bootstrap data 保留原字段。原 preload/Vue 源、生产 Core 入口、生产打包配置与音频 beforePack 不改。候选资源门禁不代表生产音频资源已验收。

## 固定行为和观察

诊断 Main 在原 supervisor ready 后、真实 Roon/凭据初始化前运行；只准入全新外置空合成 profile。所有三型号种子与第四型号追加通过 Main typed 请求进入 Node `commandOutbox.execute` 领域。可信刷新 ordinal 1 后运行 12 个固定筛选/分页请求；追加写后读取必须回退 Node，同 commandId 重投不得增加型号或库存；ordinal 2 刷新后完整 DTO 必须恢复 Rust 且等于 Node 回退结果。完成后使用原 app.quit / Core.shutdown 收口。

私有端口只接受 `{schemaVersion:1,type:'rust012.refresh',ordinal:1|2}`，固定顺序、一次在途，无任意操作或选择器。默认生产 Core 没有这个监听器。

观察事件前缀 `RUST012_EVIDENCE `，闭集 `{schemaVersion:1,actor,sequence,elapsedMs,pid,event,data}`。序号和时间按 actor+pid 单调；Core stdout 与 Main port 跨通道可以交错，以实际 requestId/commandId/native requestId/snapshot 绑定因果，不以合并日志邻接推断全局时序。Node Worker 的 threadId/exit、Rust spawn/实际 stdin 帧/经过原验证的 reply/实际 close、Main utility spawn/exit 必须真实观察。可选 sidecar observer 的异常或异步拒绝不能改变原结果和生命周期。

每个 profile 用自己的随机 ID，与该 profile 的 Node 完整结果和只读快照线性参照比较；不剥离 ID 后冒称完整 DTO 相同。正例所有 Main/Core/Node/Rust 自然退出、无 kill/timeout/force cleanup，每个 Rust close 有 ACK；错误 pin 允许原 supervisor 一次重启，但两次都无 Node/Rust/ready，实际失败退出记录不能伪称成功。

## 证据准入

`report` 闭集为 schemaVersion/task/state/sourceCommit/sourceSha256/packages/runs/productionDefault/soleDatabaseWriter/candidateDiagnostics/ownerAcceptance/rendererAcceptance/realServices/installation/push。四键 packages 分别含 candidateIdentity、verification、compile；身份沿用 RUST-011 完整最终 native/ASAR/Fuse/InfoPlist/签名/包树 shape。四键 runs 分别含 receipt 与 evidence(path,sha256)。

`expectedIdentity` 为 sourceCommit/sourceSha256/packages/runs，由主代理独立回读最终磁盘、codesign/lipo/资源/ASAR/header/Fuse/源与运行 JSON 生成；不从报告复制期望身份。准入同步只读，拒绝 Proxy/getter/隐藏字段/循环/非有限数值/身份漂移、缺 ACK/DTO 或退出/路由错配。实际 runtime-evidence.json 字节与摘要回读；stdout/stderr 仅运行 helper 当时的摘要，原字节未保留，不宣称可独立重读。深入拒绝测试改写运行 JSON 并重算独立摘要，仍须被语义校验拒绝。

原默认包只验证 startupReady/startupFailed 与 Main 自然退出和静态默认入口，不独证其 Worker 退出。诊断包分别独证实际 Main→Core→Node/Rust 请求；这不代表 Renderer 控件、Owner 使用、Main CommandOutboxService 持久恢复、真实 Provider/Roon、播放/录音、真实数据迁移、安装或发布。ownerAcceptance/rendererAcceptance/realServices/installation/push 固定 NOT_RUN。程序 SHA 绑定当次源，sourceCommit 为构建时实际 HEAD（本次是上述基线）；实现提交后另以 Git blob 核对，不能虚构构建时提交。后续同任务 Gate 可在该基线后代的明确任务分支重放，使用新的实际 HEAD/独立 expected，保留旧失败目录。
