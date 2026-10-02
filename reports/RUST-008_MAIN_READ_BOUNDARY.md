# RUST-008：正式 Main 读写边界与隔离 Electron 宿主

状态：完成可选只读路径的本地实现和最终验证。生产默认继续 Node；真实账号、服务、音频、用户数据和 Owner 验收另列。

## 身份

- base SHA：`50d2e8573dfdaea4cd97fee09ac1c85effe3f2da`，RUST-007 最终报告提交。
- 分支：`codex/rust-core-008-main-read-boundary`；工作树：`/Volumes/LifeWeave/VSCode/MusicBridge/worktree/rust-core-008`。
- 实现提交：`90823099d2f49ca6bbc7d1190c9a93767014d47f`。报告提交由 `git log -1 --format=%H -- reports/RUST-008_MAIN_READ_BOUNDARY.md` 解析；下一分支从最终报告 HEAD 接续，不写自引用 SHA。
- 外置证据根：`/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-008-_or91fh6`；报告提交后的父提交、清洁、远端和原工作树身份写入 `FINAL_IDENTITY.json`。
- 四个明确 gpt-6.1-sol/high 子代理分别负责并发边界、共享 adapter、实际宿主和独审；三个作者并行，第四个按平台槽位接续，未进一步派生。

## 行为变化

Main 初始化的 outbox 身份读取与每 1.5 秒空打印领取原先会终止 Rust 候选。纯 Node 闭集增加 commandOutbox.context、collectionProgress.modelLengths，连同旧六条共八条；保持固定已 boot 的 Owner、原结果/错误和代次围栏。

recordingPrintWorker.claim 仍是潜在写操作，恰一次到 Node。只有非 Proxy 的精确 own-data lease:null、前后完整 scope/version 一致同一活动候选、同 generation 且未关闭时保留。真假租约、原错误/unknown、探测失败或版本变化均保守撤销；辅助判定不覆盖原 Node 回执，不自动刷新或重放。同步条件窗口阻止并发 Node/Rust 读取的成功和错误提前交付；撤销和 close 立即唤醒并拒绝旧读，迟到窗口不能复活旧候选或撤销新代次。

core-host 抽取原 Worker 创建、有限环境和 Owner client 生命周期。默认 core-entry 调用零选项、utility 仍六参数；第七/八参数只由可信同进程源码传入。没有公开 IPC、Renderer、环境或父启动消息的 Rust 开关。Node 继续拥有生产数据库写入和 Provider/Roon/凭据/播放/录音控制面，Rust Native 源码未改。

隔离测试以静态编译 pin/profile 的私有入口及 wrapper 调用生产 Main、CoreSupervisor、utilityProcess、共享 adapter、生产 Owner、原 preload/outbox 与实际后台打印 worker；第二端口仅供可信测试控制/观察，不向 Renderer 交付。隔离产物/profile 采用独立外置目录，默认运行入口仍为 Node，未替换已安装应用。

范围：[任务](../tasks/RUST-008-main-read-boundary.md)，[内部合同](../docs/contracts/rust-core-main-read-boundary-v1.md)，[ADR-045](../docs/adr/ADR-045-main-read-boundary-and-isolated-electron-host.md)，[TODO](../project/RUST_CORE_TODO.md)，[机器证据](RUST-008_EVIDENCE.json)。

## 最终验证

| 检查 | 最终结果 |
|---|---|
| Rust v2 Gate | 27 步全部退出 0；43 Rust、406 JS 通过，无新增跳过 |
| 新并发边界 / adapter / 证据拒绝 | 67 / 11 / 5 项通过；旧 RUST-006/007 生命周期和实际场景保留 |
| 受控生产 Main 组件 | 5 项、4 场景通过；100/2,000/5,000 每规模 34 个完整 SQLite 差分页，实际租约写失效 |
| 同产物真实 Electron/Main | 3 项、2 场景通过；默认 Node、outbox 单次写、显式刷新后实际空轮询保持 |
| 默认入口 Electron startup | development / production mock-keychain 均退出 0 |
| 完整软件 typecheck / unit / build | 全部退出 0；254 contracts + 2,349 core + 1,250 desktop = 3,853 通过 |
| control-plane / boundaries / cycles | 全部退出 0，cycles 384 文件 |
| 独立审查 | 两轮，剩余 P1/P2 为 0；不重复运行全部 Gate |

最终 Rust manifest：`rust-gate/run-qvtn4O/manifest.json`，SHA-256 `bb10e62e1439661bda4ac95c983a6cedade538b89b18cfa7a7ade17e147da4fa`；569 份受测输入、每步日志和八份产物身份匹配，旧 RUST-004 完整成本路径对照 RUN。新鲜 release binary SHA-256 `03624a10a1c9314842907142fd0cfb3931dd68edcb88a5dff6ea645832124a14`，darwin arm64，与 RUST-007 一致。

软件 manifest：`software-final-v2/software-manifest.json`，SHA-256 `ccb275605310b3cc177280d6b61fc26d9584b22a364b15d7446c98f2035ab4b0`。1,084 份程序/测试/构建/锁文件 before=after=当前=FREEZE_IDENTITY_V2，原两条 native 条件 skip 的名称保持，没有新增跳过。冻结 SHA-256 `d52b17f618f8bf730093779c800243cdc3ad8eb4555e545479f2cb11dc4ec276`。最后仅更新文档、状态和报告元数据。

宿主产物 manifest：`rust-gate/run-qvtn4O/isolated-host/artifact-manifest.json`，SHA-256 `b2b2b30970a0c74c0cdcd2e31f23c8af1d9055c299c134bf869c36543487f40e`。组件与 Electron 共用 875 输入/36 编译文件；软件重建后仍匹配。manifest.sourceSha 表示构建时 Git base，完整未提交源码另由 sourceAggregateSha256 绑定。最终审查 SHA-256 `8d3742edb799fc98a6a7a2f86cab647579e3748bf3421c4fcf530b82fc51b4a2`。

CLI/受控 Worker 为 Node 22.23.2；实际 Electron 43.4.0 内嵌 Node 24.18.1，不能统称全部 Node 22。pnpm 固定 10.17.1，rustc/cargo 1.95.0。每次构建先核对 LifeWeave 已挂载可写；缓存偏差另列如下。

## 实际宿主证据与边界

受控组件使用真实 Supervisor、outbox 和生产 1.5 秒打印 worker，传输适配为 Node Worker，不是完整 Electron Main。三个规模各 34 Rust list ACK、1 次写后 Node list 回退、至少 5 次公开空 claim 回执；outbox execute 各一次，仅可信显式刷新再次导出。5,000 型号每个候选有 40 个 appendSnapshot ACK。有效合成 pending print job 的真实领取写 jobs/events，并使旧候选失效；renderer 停在受控 render 边界，没有实际 PDF 或设备输出。

真实 Electron 在全新合成 profile、离线 test Bridge 和 mock keychain 下运行原 Main。默认场景零 Rust/零私有导出；显式 100 型号场景通过原 preload 写单个 durable outbox 命令，SQLite 中 succeeded/acknowledged 各一条，公开 Node execute 一次；写后 stale/Node 回退，可信刷新后恢复 Rust且再完成至少两次空 claim，三次完整 SQLite 深比较。后台 worker 未暂停或隐藏，刷新只执行一次、不自动重放。

新组件四场景的四个 Owner 线程、七个 Rust child，以及 Electron 两场景的两个 Owner 线程/Core utilityProcess、两个 Rust child 均有完整自然退出证据，forcedCleanup=false，Rust 峰值一。此计数仅指新 RUST-008 宿主报告；旧 RUST-006 故障场景仍含受控 SIGKILL，不能统称所有历史进程自然退出。

本期实际 Main 主要覆盖 context/空 claim/outbox/list；modelLengths 与旧六条的其他行为由专项和原实际 Gate 覆盖，未声称八条都在新 Main 场景实跑。collectionProgress.current 仍保守失效，实际 Renderer 的收藏初始化尚未整体准入；完整产品 UI E2E 未运行。refresh 期间无活动候选的 claim 仍保守失效，不承诺慢来源下必然刷新成功。观测耗时包含装载、oracle 和轮询，不作为精确 Core 延迟或生产收益。

## 失败与修补账本

新窗口行为先确认有效 RED；第一轮审查增加 Proxy 反射伪造回执的局部拒绝，最终 186 项混合专项通过。Proxy 发现属于可信端点 Fake 的准入硬化，没有证据表明真实 Worker 可传递 Proxy 或发生实际数据库陈旧读取。旧闭集外样例只将新获准 context 替换为未准入 current，旧两用例和成功/unknown/原回执/不重放断言保持；静态 Worker 资源断言跟随 adapter 抽取移动，4 项回归保持。

首轮软件 typecheck 退出 2：新 Node 测试引用旧夹具的 toReversed，而桌面默认 ES2022 声明不足。仅新测试补充 es2023.array 类型引用和说明，未修改旧夹具、生产 target、预算或断言。桌面完整类型专项退出 0 后重新冻结，最终 v2 Rust、Electron 和软件 Gate 都重新执行；首轮 27 步 PASS/真实 Electron PASS 只覆盖旧冻结，不替代 v2。

早期私有 Rollup 共享 chunk 的 Owner 相对 URL、过短测试轮询和合成数据格式/类型准备失败分别修补；采用生产 1.5 秒轮询并观察真实公开 claim 完成后单次刷新，没有停后台工作器。全部首个失败、准备失败与中间日志保留；`VALIDATION_LEDGER.json` 记录 54 条命令尝试、两套 27 步 Rust Gate、首次软件失败和最终六步，不把重复运行相加为独立用例总数。

首次探索 Electron 在依赖 path.txt 缺失时触发 npm 隐式安装并向外置 node_modules 解压，当时未固定 Electron 缓存目录。默认本机缓存中观察到旧 zip，时间戳为 8 月 30 日；缺少启动前快照和缓存 I/O 轨迹，不能证明本轮不存在本机缓存临时写入，未清理该缓存。偏差详见 electron-cache-deviation.json。后续改为显式现有 executable、禁止隐式下载，并固定 ELECTRON_CACHE、electron_config_cache、XDG 和 Node/npm/Corepack/Cargo 缓存于外置路径；不能将后续准入写成首次全过程完全合规。

## Carryover 与下一步

Node 默认/生产数据库唯一作者保持。真实用户库/迁移、账号/Provider/Roon、播放听感/录音、PDF/设备、系统钥匙串、签名/安装替换、远端 CI、Owner 验收、push/发布/main merge 均未执行。MBR-004 真实 Roon 根因/恢复与 Gate B P4/P5 真实设备/Owner carryover 原样保留。

下一任务从本报告最终 HEAD 建独立分支，先审实际收藏初始化与 collectionProgress.current 的完整副作用链，再冻结可选只读 UI 场景；不按名称扩大白名单。正式用户启用、平台打包分发、持久化及超过 5,000/8 MiB 均另列范围。本期完成不代表整个 Rust 升级完成。
