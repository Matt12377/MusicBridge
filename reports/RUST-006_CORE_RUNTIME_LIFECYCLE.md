# RUST-006：Core 显式可选只读路由与生命周期

状态：可选运行时组合完成，最终 Rust/完整软件 Gate 与两轮独立审查通过。生产默认继续 Node；没有真实用户数据、账号、Roon、播放、录音、安装或发布操作。

## 身份

- base SHA：`babce9ad7f933743e1ab23c4edbe6187e83840c7`，RUST-005 最终报告提交。
- 分支：`codex/rust-core-006-runtime-integration`；工作树：`/Volumes/LifeWeave/VSCode/MusicBridge/worktree/rust-core-006`。
- 实现提交：`72d5691196391fe13538150431c6a75b14992cce`。
- 报告提交由 `git log -1 --format=%H -- reports/RUST-006_CORE_RUNTIME_LIFECYCLE.md` 解析；下一分支基线为最终报告 HEAD，不写自引用 SHA。
- 对应远端分支开始检查退出 2、无引用；未 push。报告提交后再核 HEAD、清洁、远端与其他工作树，证据根为 `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-006-zmfuqlfd`，最终收据为 `FINAL_IDENTITY.json`。
- 四个显式 gpt-6.1-sol/high 子代理分别完成组合端点、Core 启动接入、实际进程和独立审查；三个实现并行，第四个按槽位接续，未进一步派生。主代理整合、最终验证和提交。

## 行为变化

旧 Core 只包装 Dataset Owner 的四个生命周期/分派方法，独立 Rust 路由不拥有 Node boot/close。本期增加内部组合端点，拥有 Node 生命周期，内部 router 继续借用 Node；同步创建零 RPC/零 child。Node prepare/boot/close 并发调用合并，原身份复制并冻结。Node boot 后才建立 router 并显式刷新，完整 Rust ACK、TS 事实核验和后置版本验证结束后才发 `core.ready` 事件。初始 boot 与整段 close 各自受单一单调期限约束，未确认关闭保留失败状态；迟到操作被消费，不能重新 ready 或启动 child。

`runCoreUtilityProcess` 第七参数仅供可信主机显式传入固定二进制配置，必须提供 DatasetOwnerFactory。raw source 在能力准入前登记，避免同步拒绝后漏关 Node；外层 prepare 保留 projection 身份，close finally 封闭 gateway。旧六参数、桌面 core-entry、环境和 Renderer/父 port 消息无启用权限，默认不探测/导出/启动 Rust。内部状态不进入公开诊断合同。

领域请求在组合 ready 前封闭。`collection.list` 可走 Rust，其余领域命令仍交 Node；Provider/Roon/凭据/播放/录音控制面保留原分派。写入失效后回 Node，原成功、失败和 unknown 回执保留，不自动刷新、重放或新增写入作者。保留 worker 1、公开 208 命令、sidecar v1/v2/v3、默认 2,000/4 MiB、显式 5,000/8 MiB、完整 DTO/total/顺序、版本/代次和单 child。Native 本期无源码变化，重新构建的 binary 与 RUST-005 摘要相同。

提前 shutdown 会中断未完成的 boot。原始 catch 曾同时安排退出 1 与正常退出 0，仅读取 stopped 又不足以判断生产 runtime 的 cleanup 是否成功。本期只对显式路径记录/复用原 runtime.shutdown Promise；Owner 清理和原 shutdown 均成功且状态为 stopped 时沿原 attach 正常退出。失败仍退出 1，未改通用 attach 或默认路径。内部 Rust 请求错误继续既有安全 INTERNAL_ERROR 投影，不扩展公开错误合同。

决策：[ADR-043](../docs/adr/ADR-043-rust-core-runtime-lifecycle.md)，内部合同：[运行时 v1](../docs/contracts/rust-core-runtime-v1.md)，冻结范围：[RUST-006](../tasks/RUST-006-runtime-lifecycle.md)，进度：[TODO](../project/RUST_CORE_TODO.md)，机器证据：[JSON](RUST-006_EVIDENCE.json)。

## 验证

每次构建前核实 LifeWeave 为已挂载可写外置卷。Node 22.23.2 / pnpm 10.17.1 / rustc 与 cargo 1.95.0；构建、缓存、合成两库和日志均在外置卷，不安装工具链。

| 检查 | 最终结果 |
|---|---|
| Rust fmt/clippy/locked test/build、固定依赖边界 | 各退出 0；原 43 项 Rust 通过 |
| 旧 Sidecar / Node 原子 / 版本 / 路由 / 大快照 / TS 大快照 / 索引 | 35 / 9 / 11 / 36 / 13 / 21 / 6 通过 |
| 组合端点生命周期 | 23 项通过；冻结身份、整体 boot/close 期限、并发/迟到、领域闭集、unknown 原回执与失败关闭 |
| Core 启动接入 | 新 18 项通过，连同旧 utility IPC 共 72 项；默认/注入/能力/gateway/安全响应/提前关闭 |
| 旧实际 Node 两库 → Rust 集成 | 24 项保持通过 |
| 新实际 Core worker → Node 两库 → Rust | 11 项、10 场景、128 个筛选分页深比较通过，无跳过 |
| 完整软件 typecheck / unit / 生产 build | 全部退出 0；contracts 254、core 2,179、desktop 1,239，合计 3,672 通过 |
| control-plane / boundaries / cycles | 全部退出 0；cycles 382 份文件 |
| 独立审查 | 两轮，剩余 P1/P2 为 0；第二轮只核证据与身份，未重跑 Gate |

最终 Rust Gate `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-006-zmfuqlfd/rust-gate/run-nQMWkI/manifest.json`：19 步退出 0/signal=null，299 份源码稳定，43 Rust / 207 JS（旧实际 24＋新实际 11）。SHA-256 `02bf37684d6eeacd9e1b68919a619574bbd86763e93d17e461c79ca181a6403a`。软件六步 manifest SHA-256 `919c6402516c74c9be0dbc9064a0987c4e6aa47269e7498a5efd67a6ffaf6cec`，1,060 份程序/测试/构建源码 before/after/提交时一致。两项 skip 与 RUST-005 名称及原 native 测试文件一致，没有新增跳过。

Native binary SHA-256 `03624a10a1c9314842907142fd0cfb3931dd68edcb88a5dff6ea645832124a14`，平台/宿主 darwin arm64。25 步日志、五份结果/成本报告及源码和 binary 摘要全部逐项核对。1,234 份全冻结文件在最终 Gate 与独审期间未变；整理时只补项目元数据/报告与 ADR 状态文案，ADR 前后摘要单独保存在 `POST_GATE_DOCUMENT_METADATA.json`，技术合同和受测程序不变。最终独审 `review-final.json` SHA-256 `db6726107cb5b1ea995a94247ed165c5ce6c9fb6c95b1501116c393e0081823e`。

## 实际进程与结果边界

测试线程只适配父端口形状，调用真实 runCoreUtilityProcess、真实 createDatasetOwnerClient/两库 domain 和原 child_process.spawn 的固定 Rust binary。控制面明确使用 createTestBridgeRuntime；全部数据为新建合成 SQLite，规模 seeder 在 Node boot 后、Rust 导出前装入，不触碰真实用户库。

默认 100 型号场景无版本探测、导出或 Rust child。显式 0/100/2,000/5,000 各覆盖八种筛选乘四种分页，共 128 页；完整 DTO、total 与 SQLite oracle 深比较。ready 前领域请求安全失败且零 Node dispatch，Core ping 仍按原控制面处理。5,000 完整 40 个 appendSnapshot ACK 均早于 commitBoot ACK 与 core.ready。各规模一次真实 collection.receive 后模型数加一，后续 list 回 Node，原 Rust 快照不再交付，没有重新导出或自动 child。

10 个 Node owner 均 close 一次并自然退出 0。五个真实 Rust child 峰值 1：四个普通场景全部 ACK/自然 code 0、signal=null；一个受控 SIGKILL 为 code=null/signal=SIGKILL。后者 shutdown 回复失败，Core 随后由测试 terminate 返回 1，显式 forcedTestCleanup，不能称 Core 或 Rust 正常关闭。坏 pin、缺能力和超容量三场景无 ready/child，Node 自然关闭、Core 拒绝退出 1；真实提前关闭场景不释放暂挂 boot，Node 与 Core 自然退出 0，无 ready/导出/Rust。

结果报告 SHA-256 `627d4bad1b4bf07ed9f3713710b1d0df0e62f17440570b7bc56a896db8145cc2`。queryRoundtripMs 包含测试父线程 **5 ms 轮询观测**、公共 IPC、两次版本 RPC、Rust 与 TS 校验；它是测试观测耗时，不是精确 Core 延迟，不用于声明生产收益。保留旧四份成本与真实 RUST-004 完整路径对照（RUN），其 warm/缓存/调度限制延续，不据此默认启用。

## 失败记录

初期生命周期测试预算/断言及 extra-property 类型问题、utility fake-child/退出回调观察时机失败全部保留。owner-targeted-v4-red 先证实身份可变和 Node close 无界（1 fail/2 cancelled），修正后 v5 的 23 项通过。utility v4 先复现退出序列 [1,0]；v5 证明仅等待 Owner close 后读状态不足，最终 v6 72 项通过，正常提前退出仅 [0]、失败仅 [1]。首次/冻结/修订实际集成报告分开保留；最终正式 Gate 重新执行冻结源码，没有把旧 PASS 用作最终证据。

## Carryover 与交接

Electron utilityProcess、真实账号/Provider/Roon、播放听感、录音、真实用户迁移、签名打包/安装替换、系统钥匙串、远端 CI、Owner 验收、push 与 main merge 均 NOT_RUN。MBR-004 的真实 Roon 根因/恢复与 Gate B P4/P5 真实设备/Owner carryover 保持。

下一任务从本期最终报告 HEAD 创建独立分支，依据实际启动/初始化请求评估可选路由的使用与可信刷新需求。正式用户入口、应用默认启用、平台分发、持久化迁移与超过 5,000/8 MiB 的范围分别冻结和验证。本期完成不代表整个 Rust 升级或生产切换完成。
