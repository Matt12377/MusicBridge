# Mousa 4.1 第四项：播放优先、稳定播放下的有限扫描

## 身份和结论

- 独立分支：`codex/mousa-4-1-progressive-library-playback`。
- 基线：`cba4f540dc45eaff4e280a3a05aa94758680fd8f`，从第三项最终报告 HEAD 接续。
- 实现提交：`9465b97f34a15e54d742bb9c3b87bdcbad81b6ec`。
- 本报告提交身份：`git log -1 -- reports/MOUSA_4_1_PROGRESSIVE_LIBRARY_PLAYBACK_2026-11-15.md`，不写自引用 SHA。
- 本项完成隔离的软件开发、实际 Rust/FD 与受控 SDK 的原 Runtime 集成验证、官方 Electron 双模式 mock-keychain 启动；**不部署、不替换当前用户 App，不接真实资料库、账号、Roon、设备或实际音频，不操作 iOS**。
- 标准 Core 与桌面集通过；扩展深层集中保留第三项已复现的同一可选 MPC8 失败，未降低原期望、未跳过、未改 Rust parser，不能称作所有 Gate 全绿。

## 1. 用户行为与资格

1. 起播、切歌、seek 等原前台关键期先把扫描预算收为 0，原在途读沿原撤权与实际 quiet 收口；不等待扫描尾部才受理播放。
2. 同一原播放代确有合格所有权、没有 NEXT 准备在途、媒体请求归属可证，并连续稳定至少 **2000ms** 后，扫描调度上限最多 **1 槽**。这是资格下限，不承诺两秒整自动恢复；恢复仍沿原探针和资源准入。
3. 明确空闲保留原上限，生产组合为 2 或 8。首次没有媒体活动、也没有可用 Zone 连接时仍可空闲扫描，不要求先连接设备；已有活动后失联、未知、非本会话所有的暂停或不明媒体读保守封闭。
4. 多个实际网关请求、仅响应头、preflight 或不明 token 不借用旧 playing 状态。即便多个请求属于同一 token，也不冒充唯一流资格。因此不是无条件边播边扫。
5. 手动暂停或取消**扫描任务**不被自动恢复覆盖。已确认的播放暂停与扫描任务手动暂停不是同一状态；前者仍须原所有权和完整稳定窗。

独立壳、最多 100 张的渐进页面、已提交事实才可播放、唯一原队列和源写默认 OFF 均保持。没有自动播放或把新扫描曲目追加进当前队列。

## 2. 内部服务边界

- [纯预算模块](../packages/bridge-core/src/library/scan-playback-budget.ts)只消费原事实并返回上限，没有定时器、队列、Source 能力或数据库 writer。观察异常、无效代次和时钟异常返回 0。
- [Runtime 组合](../packages/bridge-core/src/runtime.ts)只从原 Controller、所选 Zone、原播放代和网关活动组合资格；不信任 Renderer 的播放字段。[Controller](../packages/bridge-core/src/application/bridge-controller.ts)为原云端/本地 NEXT 实际准备加独立标记；标记随自己的工作/清理退出，未知关闭不归零，不改变原播放 Promise 或队列。
- [网关](../packages/bridge-core/src/stream/gateway.ts)最多保留 8 条私有在途绑定，溢出 fail closed，不记录 token。唯一当前请求须实际观察到首批 pipeline 字节，开始/首字节/结束均重建稳定窗。pipeline 字节不等于设备已接收或实际发声。
- [原扫描准入](../packages/bridge-core/src/library/scan-read-admission.ts)同时执行原总容量和动态 scan 上限；撤销票据仍占槽，直到调用方确认实际读退出和 FD 关闭才 release。显示目的沿原准入，不改原 status/acquire/watch/release 结果形状。
- 唯一 Core↔Owner 私有投影新增 `scanReadBudget` 空请求，闭集结果 `{ concurrency: 0|1|2|8 }`，沿[原协议](../packages/bridge-core/src/collection/dataset-owner-protocol.ts)和[Utility readiness/epoch/dataset 守卫](../packages/bridge-core/src/utility-main.ts)。它不是公开 dataset/IPC 命令、Source 授权或 iOS HTTP 能力。
- **提示是最大窗口，不是剩余空槽，更不是许可。** 不从提示里扣除自己的在途读，避免原部分提交 revalidation 把自己的占槽误判为预算收缩而反复自取消。真正逐读仍必须取得原 Core 票据和统一 Source claims。
- [原 Coordinator](../packages/bridge-core/src/collection/local-scan-coordinator.ts)在发现窗口、原 revalidation 和恢复前取冻结设置/提示的较小值；不改持久冻结设置，低于八槽时不启用原 CUE 八槽预读。非法回执封闭，不猜预算；0 预算先暂缓，不触碰来源探针或周期性 resume→pause 改 job revision。
- 不增加前台控制的异步 quiet 屏障，不 kill 共享 Rust pool 伪造关闭，不增加 recording 仲裁器。原 recording 的 `yieldForMedia`、来源许可、恢复/COMMIT/readiness、唯一 Owner/writer/队列及 `roon_audio_input` 保留。

完整合同见[四阶段 ADR](../docs/adr/ADR-MOUSA-4-1-PROGRESSIVE-LIBRARY.md)。

## 3. 实际 Rust 与原 Runtime 的合成链路

### 3.1 原冻结八槽在一槽预算下持续提交

[自动集成测试](../packages/bridge-core/test/mbrs003/playback-priority-scan.test.ts)使用 128 份自有 FLAC 副本、实际 fresh compiled Rust Reader、原 Coordinator/repository/准入及真实只读 FD。独立 Reader 自身容量为 8，原冻结设置仍为 8，而最大调度/实际源 FD 都为 1。

在第 96 次读前受控停住尾部时，至少 64 条事实已经真实提交并可查询；放开后 128 accepted、0 rejected、128 次原解析调用，无 deferred acquire 或自取消。每份源文件前后内容哈希一致；读出的事实不是手写 metadata 假回执。

### 3.2 真正 Native 在途撤权与 FD quiet

`metadata-phase parse/start` 发生在原 Native 调用之前，**不能单凭它宣称 Rust 已经在途**。本 Gate 转发原实际 pool 的请求/结果，只在真正 Rust 发出有界字节请求、原 FD 已实际读出 **13496 B** 后触发预算 0。

原 Native 操作 settle、同源 FD close/真实 `fstat EBADF`、Core release 的先后保护通过；该次取消没有变成坏媒体或迟到事实，accepted/rejected 仍为 0。忙时恢复前后 job/revision 不变；恢复预算后原 12 项实际重读完成。原扫描手动暂停/取消保护分别通过。共享进程只由对应测试根按匹配 compiled 模块关闭，不要求逐文件 worker exit。

### 3.3 首条合格起播不等待尾部，随后原播放下继续扫完

测试启动真正 `createBridgeRuntime`、Controller、RoonAudioInputAdapter、Source tickets/fences、固定 FD 与 loopback Gateway；只替代 SDK 设备及 Owner 外进程传输。SDK 只能 fetch 本任务自有 loopback origin，禁重定向；不连接真实 Provider/Roon，也不发声。

| 本次标准 Core 主集的受控记录 | 结果 |
|---|---:|
| `playbackRequested` | true |
| 自有扫描输入 | 128 项 |
| 请求前/合格受理时已 accepted | 64 / 64 |
| 首条 accepted + 原 PLAYING 确认 + 完整 loopback 响应 | 17.398ms |
| 完整响应字节数（与来源文件长度一致） | 13496 B |
| 合格请求后确认的原扫描收口状态 | media 暂缓，尾部未完成 |
| 原稳定资格后实际续扫的最大调度窗口 | 1 |
| 续扫后 | 128 accepted / 0 rejected |
| 续扫完成时原播放 session 数/状态 | 1 / PLAYING |

同输入独立专项的单次合格起播为 16.347ms；两者都是合成 SDK/小文件的软件观测，不是基线对照收益或真实起声延迟指标。计时夹具将尾部停在**新 FD 之前**，不能把这个计时当成解析中的前台抢占；在途撤权是上一个独立 Gate 的证明。

计时夹具为隔离 FD 编号复用使用实际 Reader 容量 1；原 Core 空闲/冻结窗口仍为 8，Core 资格来自原 Runtime，禁止测试 busy 布尔覆盖。稳定后原恢复探针按真实 Core 提示读完剩余 64 项，最大调度 1，未重开播放或变更原两项队列。seek/NEXT 即步收为 0、撤权票据不提前扣槽、零票据期间重建稳定窗，以及停止无确认/失观测封闭均通过。

新[标准 Core Root 入口](../packages/bridge-core/test/scan-playback-integration.test.ts)已包含上述五项实际集成保护，不仅留在私有专项脚本中。实际 Utility/Client/Worker/MessageChannel 的反向预算帧、空 payload、signal、过期 epoch/dataset、0/2 回执及不发票保护另经[原私有链路测试](../packages/bridge-core/test/v4/local-album-background-admission.test.ts)验证。

## 4. 最终软件与隔离 Gate

各组存在交叠，不累加为唯一测试总数。

| Gate | 结果 | 退出码/边界 |
|---|---|---|
| 标准外置 build-only，及实现提交后重新构建 | 通过 | 各 0 |
| Core 标准主集，已含新增实际集成入口 | 3868 通过，0 失败，0 取消，2 原有显式原生 opt-in skip；共 3870 | 0 |
| 原 queued-Stop 隔离集 | 8/8，无 skip/cancel | 0 |
| 预算/协议/网关/Controller/显示与私有帧相关集 | 254/254，无 skip/cancel | 0 |
| 名称/Owner 投影与原许可接点 | 111/111，无 skip/cancel | 0 |
| 实际 Rust/原 Runtime/原扫描许可专项 | 16/16，无 skip/cancel | 0 |
| 扩展历史核验、持久扫描/恢复、搬迁/快照保护 | 208 通过，1 原有可选 MPC8 失败；共 209，无 skip/cancel | **1，不标绿** |
| 桌面完整集（含真实 Owner 冷恢复/重启许可） | 3120/3120，无 skip/cancel | 0 |
| 80,000 条克隆冷/暖容量专项 | 1/1，无 skip/cancel | 0 |
| Core 测试类型、桌面 Vue 类型、E2E 测试类型 | 均通过 | 各 0 |
| boundaries / 源 Git control-plane / diff 格式 | 均通过 | 各 0 |
| 官方 Electron 43.4.0 archive + 当前执行树身份 | 本项实际外置工作区新官方收据 | 0，无身份 override |
| production 隔离 mock-keychain App 启动 | 通过 | 0 |
| development 隔离 mock-keychain App 启动 | 通过 | 0 |

Core 各阶段使用官方 fresh 编译准备和真实固定 Worker 资格收据，在阶段前后核对源/产物未变。Native 从实现提交重新构建后签发本工作区新官方身份，不借用前阶段收据，不使用真实 Keychain/profile。

原两项 unit skip 属于 OutputNative 显式 opt-in，不冒充该子系统硬件或原生资格通过；这里实际媒体 Rust 读/取消与 Electron mock 启动是另行真实执行的软件 Gate。

### 回归中补齐的原测试接点

旧投影夹具只实现 acquire/watch/release，新私有预算查询被其拒绝。修为转发**真实原 admission.budget**，不让生产代码对未知回执猜 8 或回退放行；保留原 completed、真实 FD/撤权、重启收口及来源保护断言。名称组使用原 canonical Root 关闭匹配 fresh-dist pool，不能把 Reader.close 当共享进程 exit。

本地 NEXT 夹具原来把 APPEND 自身的正常 capture 也堵住，现按实际 capture 次序只持住独立 NEXT；原调用次数、队列和预备资产断言保留。SDK seek 夹具补发原权威 Zone 的位置/revision 回报，不放松真实 transport confirmation。没有靠 timeout 增长、skip 或降低期望取绿。

### 80,000 条专项的范围

本次仍只克隆原自有合成 SQLite：80,000 条事实、8,000 张专辑、401 个 batch；原件完整 SHA-256 不变。逻辑冷 repository 15408.614ms，**之后**首 100 张查询 6279.332ms；暖 repository 1742.357ms，**之后**首 100 张 270.691ms。暖开不重放两域历史，两次当前第一专辑详情各 10 曲。

这是第三项同一保护的重复回归，不把运行间波动称为本项新性能优化。OS 页缓存未清；此专项不执行 Parser、播放或实际 DatasetOwner/Electron 跨进程。它与 128 项真实 Rust/原 Runtime 合成起播是不同场景，**不能拼接宣称已验收 8 万首真实扫描到实际音频的端到端体验**。

## 5. 保留事项与安全边界

- 原严格五族测试仍期望 10 accepted/0 rejected；本轮相同固定 Native 二进制继续复现 MPC8 导致的 8 accepted/2 rejected。第三项已在未改优化基线和候选上成对复现；本项没有改断言、skip 或 parser，不签发新的 MPC8/完整五族资格，见[原证据报告](MOUSA_4_1_PROGRESSIVE_LIBRARY_AUDIT_2026-11-15.md)。
- 未实测真实资料库、慢盘/网络存储、实际 Roon/账号/输出设备音频、录音负载或 HAL 时限；2000ms 稳定窗是调度规则，不是听感认证。软件 ACK、完整 loopback body、官方 Electron 或 mock-keychain 启动均不等同于真实音频或 Owner 接受。
- 没有迁移/删除历史、提前放行未完成的关键审计、增加第二 Owner/writer/队列，源写默认 OFF；没有修改、构建、安装或部署 iOS。
- 原用户 App、Core、配置/账号、资料库与播放队列不作测试对象，也未被替换。本轮不是 main 合并、安装、发布、签名分发或真实文件写回许可。

## 6. 四项串联与交付身份

| 项目 | 实现提交 | 最终报告提交/身份 |
|---|---|---|
| [独立壳与设置](MOUSA_4_1_PROGRESSIVE_LIBRARY_SHELL_2026-11-15.md) | `966445257469ff1a4e3250f5f6c9cc725e73609a` | `815311e3efd29621e378c5ad8cb6c5118795f2fe` |
| [渐进专辑加载](MOUSA_4_1_PROGRESSIVE_LIBRARY_BATCHES_2026-11-15.md) | `92bf6bd35184ed60029beb687c418dda6633b326` | `ad52961f7064ec731d868e1330fcedc751be08bc` |
| [安全冷启动审计](MOUSA_4_1_PROGRESSIVE_LIBRARY_AUDIT_2026-11-15.md) | `f077b65c82086245209d974977a70c78364e2a93` | `cba4f540dc45eaff4e280a3a05aa94758680fd8f` |
| 本项播放优先扫描 | `9465b97f34a15e54d742bb9c3b87bdcbad81b6ec` | 本报告 `git log -1 --` 身份 |

各项独立分支、实现/报告两次提交线性接续；仅普通推送对应分支，不合并 main、不强推。最终交付另核本地 HEAD、远端对应 HEAD、报告提交一致与干净工作区；不在报告内自填未来 SHA。若后续任务获准，只从本项**最终报告 HEAD**创建新分支，本轮不擅自开始第五项或部署。

机器当前记录见[STATUS](../project/STATUS.json)，有界风险见[风险登记](../project/RISK_REGISTER.md)，iOS 独立会话见[兼容交接](../docs/PROGRESSIVE_LIBRARY_IOS_HANDOFF_2026-11-15.md)。
