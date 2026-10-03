# RUST-014 用户可选只读查询合同 v1

基线 `e35ad579ef276075d09d0b52fc6bb8158c418b26`。013 证明合成原控件与私有刷新；本期增加普通用户入口，不能复用自动种子/两 ordinal 私有刷新作为生产能力。

## 默认、能力与 Node 所有权

正常 Core 仍由原 Main/CoreSupervisor 固定 `core.js`、空 args 和原公有 `{type:'musicbridge.core.port', playbackEventProtocol?}` 启动。原 `runDesktopCoreHost` 六参数 Node 路径保持。唯一原 Node prepare/commitBoot 完成后，新 optional manager 装饰并借用原 endpoint；不调用强启动组合来 catch 后重开作者。关闭 OFF 与可选资源失败均不关闭 Node。原 Domain IpcCommand、DATASET_COMMANDS、四个 Main outbox 源和 Node 业务库作者不扩展。

默认意图 false。默认关闭不调用资源工厂/解析/清单验证、版本探测/导出/router/Rust 创建；Node 原 boot、读写、恢复和关闭保持。正常构建仅捕获固定 `apps/desktop/native/rust-core/darwin-arm64` 的构建清单，包内固定 `Resources/rust-core/darwin-arm64`，pin 为编译字面量。没有本机构建资源时构建可保留 null pin，OFF 正常；ON 返回安全不可用状态。正式候选必须先准备有效签后资源再捕获、编译、签包。profile 固定 `v2-2000`，不从 boolean/环境/Renderer/父公有消息扩大到 large。旧 Rust env/入口/path/pin/profile 注入拒绝保持。

## 公共 API

`getCollectionReadonlySettings()`，`setCollectionReadonlyEnabled(enabled:boolean)`，`refreshCollection()` 是新增桌面方法；不走业务 outbox，不增加领域写命令。固定 IPC：`collection:readonly-settings`（零参数）、`collection:set-readonly-enabled`（恰一个boolean）、`collection:refresh`（零参数）。原 requireTrustedRenderer 当前主窗口/sender/frame/URL 验证先于读取/保存或控制副作用；多余参数、字符串bool、对象/getter/资源 selector 拒绝。

设置精确形状：`{schemaVersion:1, enabled:boolean, mode:'node'|'rust', state, errorCode?}`。state 仅 `off|enabling|ready|stale|refreshing|failed|blocked|closing`。errorCode 仅 `RUST_UNAVAILABLE|RUST_STALE|RUST_BLOCKED`；允许不带。enabled 为 Main 已保存意图，mode 为实际可用读取路线，state 为本 Core 受控状态；保存 true 不等于 Rust ready。不得增加 pid、路径、pin/profile、epoch/datasetId/snapshotId/revision、资源细节或 stack。

刷新结果精确 `{schemaVersion:1, refreshed:boolean, settings}`。Node/OFF 为 false；Rust 只有本次真实 refresh 完成且当前发布代际仍 ready/rust 时 true。可选失败仍允许标准查询；返回状态不能伪装快照成功。首次已发 Rust 读取失败保留该失败，后续 Node 可继续，不能把同一未确认请求透明重发到 Node。

Main 新设置文件只含 `{schemaVersion:1, enabled:boolean}`，默认 false、4KiB 上限、普通文件、原子唯一临时文件/rename、0600；不记录用户内容或能力。读取缺失/坏字段/非boolean/超大/损坏按安全默认，错误提示使用固定公共码。保存串行，当前有效意图有单调序号；保存失败不谎称成功。控制与 UI 回答用代际围栏，旧保存/旧 Core/旧请求不得覆盖更新意图。Core 控制可并发接收 OFF 以立即撤销 ON 的迟到发布权，Main 不能把开关串行等待旧 ON 完成后才接受 OFF；最终持久与有效意图对应最后成功保存的请求。

## 可信私有控制桥

A 定义 `OptionalReadonlyStatus`（与上面安全设置字段一致）、`OptionalReadonlyRefreshResult={refreshed:boolean,status}` 与 `createOptionalRustReadonlyManager({createOptions,...trustedHooks})`，公开同进程方法 `decorate(owner)`, `setEnabled(boolean)`, `refresh()`, `getStatus()`。decorate 的返回 endpoint 保持 prepare/commitBoot/dispatch/close 及来源私有快照能力；来源 Node生命周期仍只由原 utility 调用。manager 的资源关闭在 endpoint.close 的缓存一次 Promise 内，任何 Rust/Node 收口失败不能被第二次 close 改写为成功。

`collection-readonly-control-protocol.ts` 由 A 独占，B 消费。Main 在原 Core ready 后才发送第二条父消息 `{type:'musicbridge.collection-readonly.port',schemaVersion:1,generationNonce:<UUID>}` 及恰一个新私有 port；不得先于原公有首消息。每 Core 代际唯一私有 port，迟到/第二次/额外字段拒绝。A bridge 只处理这个受控类型，不改变原 utility 首监听。

私有请求精确 `{schemaVersion:1, generationNonce, requestId:<UUID>, type:'status'|'setEnabled'|'refresh', enabled?}`；enabled 仅 setEnabled 必有boolean，另外两类不得有。回复精确绑定同 nonce/requestId/type 及安全 status/refresh result，固定错误，不回显任意输入。Main 总控制预算15秒，factory/router 建立/refresh各沿用5秒级有界预算；相同 refresh 单航班。关闭 port/旧 child 时拒绝 pending、忽略迟到并撤销本代 Rust，禁止经重连新port偷偷再创建 native；新整 Core 代际才重新绑定。Main客户端 close 仅结束通道，不提前关闭 Node；Node关闭仍属于原 runtime shutdown。

启用 true 在已 boot Node 上惰性准入固定能力并创建借用 router、首次 refresh；失败保留 Node可用、enabled意图与安全失败状态。OFF 在首次 await 前撤销 native/旧读取/刷新发布权，排空已登记 late factory/router/candidate，等真实 close ACK/pending0/natural exit后允许下一次创建。不能只以 invalidate、stopped、布尔、kill请求或观察输出来证明收口。非自然退出、坏帧/超时/close未确认后，本 Core 为 blocked，保留引用和错误，不吞掉 retirementError 重新创建；Node 原作者不重建。原 Owner fatal沿用Core监督/冷启，不在活Core重开。

所有写与潜在写入继续原 Node；原 router 对已确认或unknown写入的失效保持，批次只退休当前 native一次，不自动重放或逐写重建。16条已审纯Node读取和空claim既有例外保持。每个控制操作/await后复核代际、当前 intent和资源登记；旧 Node/Rust读不得越新 UI/快照发布。

## 原用户界面

设置应用页新增开关，默认关闭，区分请求意图与实际就绪/失效/失败；失败说明标准查询仍可用，blocked 提示重新打开应用。无需用户输入路径或调试信息，不以“加速”宣称成本收益。

收藏工具栏“刷新库存”正常态也可见，调用普通 refresh API 后重新读取最新页面/筛选与当前详情位置。等待 refresh 前撤销旧 list/detail发布代际；筛选、翻页、详情变化和unmount不得被旧结果回跳。现有错误重试/unknown保存的原命令重放仍保留；未确认写入时不借刷新隐藏待确认事实。按钮 loading/保存保护清楚，Node模式仍重新读取实际库存。

## 观察与验收

诊断常量 `__MUSIC_BRIDGE_COLLECTION_READONLY_DIAGNOSTICS__` 默认false；工程流程字面量 `__MUSIC_BRIDGE_COLLECTION_READONLY_PROBE_EXPECTATION__` 仅为 `null|node|rust|pin`，仅诊断guard内部选择固定DOM操作与证据期待，不流入普通API、manager或资源工厂。正常构建该值为null，四包compile分别绑定null/node/rust/pin。正常入口的manager/公共API真实实现与诊断开启无关。C 给 A/B 的固定接口：`installCollectionReadonlyCoreObserver({getStatus})` 返回 `dependencies`（createWorker/decorateDatasetOwner被动包装）、`onObservation`、`onResourceValidated`、`emit`；`createCollectionReadonlyMainProbe()` 返回 `emit`, `observePublicPort`, `observeChild`, `observeLifecycle`, `observeWindow`, `runWindowProbe`, `observeIpc`。允许按实际原接口补具体类型，不能增加业务controller/factoryselector。Core观察只旁路原公有首port，不新增诊断刷新控制；Main动作只固定原DOM开关/刷新/入库/保护，不调window API/Vue/handler/Core请求。

只有编译诊断true且原Core test-mode/UI_E2E和本runner新建外置合成profile/nonce准入后输出 `RUST014_EVIDENCE `；actor main|core、sequence、同actor elapsedMs/pid、闭集event/data。同步完整Core stdout观察不能影响业务回执，缺实际事件仍拒绝。原creds路径只沿用既有原测试隔离，不新增凭据恢复跳过或生产假状态。

四包固定 default-node/node-controls/rust-controls/pin-rejected；后两包相同正常功能，仅静态pin正/负。fresh各经26原入库+保护单写和普通公开接口；Node对照保持OFF，Rust实测ON/写后Node/普通刷新/可见OFF→ON，最后保存ON。cold复用同签后包和自然关闭profile，零业务submit/ACK，Node持久OFF/Rust持久ON并按普通启动惰性附加读取；错误pin实际开启失败但Node ready和读取/关闭正常。默认生产false包原mock startup单列，不编造其默认Worker观察。

每个actual包/入口/pin/ASAR/九Fuse/签名/源与artifact SHA/bytes绑定独立expected。原Main outbox四源、Node业务作者实现保持基线blob；新preload/Renderer变化是功能所需，不要求它们与013整资产字节相同。正常Node/Main/Core自然0、Rust ACK/pending0/natural0、outbox-close-end；负例和受控kill单列。关闭合成SQLite只读独立核26型号/27领域与Main账本、保护值/revision及冷启持久；实际完整Main DTO与DOM/像素分别记录，不冒称完整Renderer独立DTO。

严格拒绝必须有同一actual重封装未改对照，串改测试依赖图完整绑定；只改无关旧hash导致失败不能证明目标字段。默认OFF零能力、关闭未确认不再spawn、失败不重投、节点作者唯一由适当受控/实际测试证明。普通 CUA真实输入另记，不把固定DOM isTrustedfalse、工程Gate或代理操作写成Owner接受。完整软件/合成App/真实服务/安装/push各分层；本期真实服务、安装替换、迁移、push和Owner验收均NOT_RUN，后续从最终报告HEAD接续。
