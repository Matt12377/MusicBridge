# RUST-013 签名包原控件验证合同 v1

基线 `822594bcccff302c011121ce0a813ee74d5756cc`，适用任务 RUST-013。三份只读审计逐项核输入后冻结本期最小范围；审计中的 100/2000、完整 Renderer DTO/分段成本及未知结果故障建议不自动纳入本合同。

## 静态包与原流程

包键仅 `default-node`、`node-renderer`、`rust-renderer`、`pin-rejected`。default 使用原生产 Node Core 入口和两个诊断编译常量 false；原 mock startup 仅证明默认启动。三个候选旧 `__MUSIC_BRIDGE_PACKAGED_ROUTE_DIAGNOSTICS__` 必须 false，新 `__MUSIC_BRIDGE_PACKAGED_RENDERER_DIAGNOSTICS__` true。Node/Rust Core 入口和 Resources 清单 pin 都是编译字面量，Main 继续固定包内 core.js、原空 args、公有父消息合同；诊断额外第二端口与 stdout pipe 明确记证。原 preload、全部 Renderer 资产、outbox service/store/ipc/executor 原文件保持；候选 Main 诊断字节、可见 regular 窗口及 offline 凭据恢复跳过是披露的差异。生产默认不能出现 probe 副作用。

候选完整经过原 registerIpcHandlers、createWindow 与 createTray。原 requireTrustedRenderer 的当前主窗口、sender/frame URL 验证保持；诊断不得替代验证或通过伪造 event 调 handler。原 IPC listener 恰调用一次，原返回、异常及持久业务结果保持；观测同步/异步异常不得逸出或改变业务返回。候选在首开与 onReady 重启均跳过凭据恢复；原 UI_E2E/Core test-mode/Renderer 网络隔离和净化环境并列记录。

四包保持原 ASAR 与实际九位 Fuse：0:0、1:1、2:0、3:0、4:1、5:1、6:0、7:0、8:1。签前确定 ASAR/Fuse，签后不改包；全包树、Main/Core 编译输入、native 清单/pin/签名与默认原 preload/Renderer 全资产 SHA 独立核对。不使用 inspect/CDP、RunAsNode、外部 JavaScript、private wrapper 或替换 fork。

## A/B 固定接口

B 导出 `assertPackagedRendererDiagnosticEnvironment(env)` 和 `createPackagedRendererMainProbe(options?: {sink?})`；probe 返回 `emit(event,data?)`、`observePublicPort(port)`、`observeChild(child,entryPath,args,diagnosticChannel)`、`observeMainEvent(event,data)`、`run(window):Promise<void>`。没有 mode、pin、任意 JS、selector、业务 supervisor 输入。A 在 channel/fork 接点安装前两项，原可信 IPC 的闭集旁路用 observeMainEvent。原建窗后固定 run 只访问实际 BrowserWindow，完成后 A 调原 app.quit；window.close 的 tray hide 不算退出。原 lifecycle 观察保留，关闭 timeout/kill 不能通过。

A 导出 `installPackagedRendererCoreObserver(mode:'node'|'rust')` 返回原可信 hooks 形状；Rust 复用原 resource factory，Node 复用原默认 Core。仅候选私有端口接受 `{schemaVersion:1,type:'rust013.refresh',ordinal:1|2}`。fresh 顺序两次、单在途，固定 30 秒期限；cold 不发。回执为 `{schemaVersion:1,type:'rust013.refreshed',ordinal,mode,status?}` 或 `{schemaVersion:1,type:'rust013.rejected',ordinal,code:'INVALID_REQUEST'|'NOT_READY'}`；额外字段/重放/迟到/并发请求拒绝，不能转成任意业务命令。Node 固定 no-op 回执，Rust 调原 controller.refresh。Renderer 不获得 controller 或新公共 IPC。

## 合成身份与控件流程

runner 只直接启动 actual app binary 与 `--use-mock-keychain`。运行时仅固定离线 UI、外置 TMP/DEV 与合成 profile 环境；不传入 route、pin、Core entry、JS、动作或 launch 选择器。首次创建唯一外置真实目录和闭集 `rust013-profile.json`：schemaVersion 1、kind `rust013-synthetic-profile`、UUID nonce；权限 0600/0700、同外置 dev、无 symlink、无真实用户目录查询。候选在原启动 profile 验证之后还检查 marker。首次 probe 用原稳定空列表确认 fresh；固定完整 fixture 后写私有完成 marker，cold 必须同时满足既存 marker、26 型号和保护结果，第三种状态拒绝。

fresh 固定通过原 DOM 入库 26 个独立型号，每次原 form/input/change/button 事件和原 handler，数量均已拆空白 1，其余 0。B 在源码冻结具体品牌/型号/年份/类型矩阵、目标保护设置（collector、minimumSealedReserve=2）和独立 actionId。原列表 limit24、详情 limit20 不改。26 次 receive 后私有 refresh1，原品牌/关键词/年代/库存状态、清除、第一页和第二页读取；原详情保护表单仅提交一次，Main 原持久 outbox → Core → Node 后自动重读必须是 stale Node；私有 refresh2 后原控件读取恢复 Rust。Node 包执行同原控件流程并接受两次 no-op refresh。

cold 复用同签后包和上次自然关闭的同 profile，不补种子、不写、不刷新；按原 DOM 与原完整 Main/Core 回执核持久保护策略/revision/库存，并核没有 commandOutbox.execute。Core 原 boot Rust 快照即可用于读取。runner cold 只接受自己先前实际自然退出收据的 path/SHA、同包可执行 SHA、profile dev/ino/marker/nonce，拒绝任意 profile、并发或不完整前次。Options 闭集 executable、expectedExecutableSha256、evidenceDirectory、kind、launch；launch fresh 仅 type，cold 仅 type/priorReceiptPath/priorReceiptSha256。默认/错误 pin 仅 fresh。

DOM 表达式必须为包内源码固定控件操作/观测，不允许 window.musicBridge 调用、Vue refs/store、Main handler、supervisor 业务请求或外部字符串。元素唯一、可见、enabled，固定每步与总预算；失败保存原证据并关闭，不重投不确定写或改走 API。机制固定 DOM、isTrusted=false；普通 computer use 如执行，另有真实输入/截图，不能冒称 Owner 验收。本期不为了观察完整 Renderer DTO 修改原 preload；证据上限是实际 Main 完整结果、原资产一致及原 DOM/像素，`rendererFullDtoObservation=NOT_INDEPENDENTLY_OBSERVED`。

## 实际收据与独立参照

实际诊断修订（2026-10-03）：公共 IPC 的 `request.id` 与 Rust 帧传输 `requestId` 是两个独立身份。先以 dispatch 帧内 `payload.request.id` 关联实际公共请求，再以该帧传输 ID、同 Rust PID 关联唯一 validated ACK；完整请求与回执均核对。原 router 仅在请求缺省作用域时补充已准备 Node Owner 的 `expectedDatasetId`，补值、wire 身份与实际 Owner 必须一致。

候选 Core 的被动证据同步完整写到 stdout，避免原 Core `postMessage` 后的自然 `process.exit(0)` 截断观察尾部。原公开 ACK、业务数据与退出逻辑沿用既有实现；缺少真实事件仍拒绝，不根据退出码补造事件。数据库复验从实际不可变副本的完整行重建全部型号的数量与时长，不能仅复用参照 JSON 的 DTO。

事件前缀固定 `RUST013_EVIDENCE `；共用字段 schemaVersion 1、actor main|core、sequence、elapsedMs、pid、event、data；闭集事件/数据由新 parser 验实际输入。每个 actor 单调时钟只在本 actor 比较，不相减跨进程时间。窗口记录 actual webContents/Renderer PID、可信 frame URL、可见/bounds；原控件 actionId 对实际 IPC invoke、Core request.id、commandId/outboxId、完整 DTO、Node dispatch/结果与 Rust 实际写帧/validated ACK。只有实际截图文件 SHA/大小/尺寸匹配才计为像素证据。

报告固定四 packages、六 runs：default-node、node-fresh、node-cold、rust-fresh、rust-cold、pin-rejected。真实 artifact 的 path/SHA/bytes、actual 启动 argv/env 闭集、raw 合成事件/安全 lifecycle、Core stdout 摘要、截图、关闭 SQLite 参照绑定独立 expectedIdentity，不将报告自称 expected 或成功布尔当证明。只保留白名单合成 DTO 与公共错误码，凭据/私有栈/任意页面内容拒绝。

正常 Main/Core/Node Worker code0、Rust close ACK/pending0/natural code0、原 Main outbox-close-end 且无 timeout/kill/forced-cleanup。原窗口 hide 不算退出。错误 pin 必须无作者创建、Rust spawn、ready 或可用窗口；错误场景真实失败清理单列，不套正常自然退出结论。default 仅默认启动；无独立默认 Worker 观察时不编造 Worker 退出。

关闭后仅对 runner 创建的合成库读取，固定实际文件/WAL 身份、读连接前后 SHA、integrity/fk。原 Core inventory 与 Main command-outbox 分别列数据库所有者：businessDatabaseWriter=Node、mainOutboxWriter=Main。核 26 receive+1 setPolicy 的实际命令、结果、ACK 与请求 fingerprint，领域命令唯一、型号/批次/数量/保护策略/revision 恰变；cold 读结果与账本请求/结果/ACK保持，领域事实未新增。cold boot 元数据 epoch 可变化，不能要求整个库文件字节相同。独立 list/detail oracle 保留实际 UUID、完整 DTO/total/order，不能剥离 ID；每个 profile 自身对照，不将两 profile 随机 UUID 当同数据。

## 成本与验收声明

Main 往返计时包含候选被动观察与同步 Core 日志输送开销；结果不是关闭诊断后的生产时延。日志输送、Rust 计算与 TS 校验未独立分解。

成本策略固定 `MAIN_REQUEST_REPLY_ROUNDTRIP_ONLY`，fixture26，记录真实 Main 同 PID/clock 的 request/reply 对、request ID/command/page/filter、实际 JSON 字节、DTO SHA、route 与 duration；按 workload 重新计算样本/中位/范围，不捏造配对大规模数据。DOM driver 轮询、脚本等待和代理等待另列，不计产品延迟。禁止从这组数据宣称完整 Renderer 分段成本、5000/large 准入、所有路径加速或完整 Rust 迁移。

严格 parser 对缺控件/原文件漂移/错 request/ACK/DTO/库/退出/成本，以及报告和 actual artifact 同时重新计算 SHA 的串改都要拒绝。测试、actual app、普通 CUA、Owner、真实服务、安装/push 分别声明；Owner/realServices/installation/push 本期均 NOT_RUN。生产默认与唯一业务写入保持。本期完成后总目标继续，不将本期围栏当永久缩小范围。
