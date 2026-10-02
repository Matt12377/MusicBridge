# RUST-007：可信主机显式控制与混合纯读取

状态：可选只读组合完成本地实现、最终 Rust/软件 Gate 和两轮独立审查。生产默认仍为 Node；完整 Main/Electron、真实用户库、服务和设备验收未执行。

## 身份

- base SHA：`61df0b33f087823920042f3bcebe4743961c9b74`，RUST-006 最终报告提交。
- 分支：`codex/rust-core-007-host-refresh`；工作树：`/Volumes/LifeWeave/VSCode/MusicBridge/worktree/rust-core-007`。
- 实现提交：`3c8af2d7d1ce97850e1b23ba890eb5f56e2c6e33`。报告提交由 `git log -1 --format=%H -- reports/RUST-007_HOST_CONTROL_MIXED_READS.md` 解析，下一分支基线为最终报告 HEAD；不写自引用 SHA。
- 证据根：`/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-007-iufy2wwd`；报告提交后的最终 HEAD、清洁、父提交、远端及原工作树身份写入 `FINAL_IDENTITY.json`。
- 四个显式 gpt-6.1-sol/high 子代理分别完成混合纯读、可信主机控制、实际进程和独审。三个实现并行，第四个按平台槽位接续；未进一步派生。主代理整合、验证、元数据和两个提交。

## 行为变化

原 router 在辨认 Node 纯读取前撤销 Rust，参考目录初始化、型号详情等会使可选路径立即失效。本期先审实际领域实现与 SQL 辅助链，仅保留 collection.detail/copy/photo、referenceCatalog.sources/history/revision 六条精确纯读。它们继续由 Node 执行、保持原回执和错误，不改变有效 Rust generation/child；并发写入、refresh、invalidate 和 close 仍撤销迟到读取。collection.list 的原 scope、前后版本探测、完整 DTO/total/顺序校验保持。其他领域命令保守失效，Node 写入成功/失败/unknown 原回执保留，不自动刷新、重放或增加数据库作者。

内部新 controller 是冻结闭包，仅有 refresh/invalidate/getStatus。runCoreUtilityProcess 第八参数由可信源码传入同步 callback，必须同时提供显式 Rust options 与 DatasetOwnerFactory。组合清理端点先登记，能力只交付一次且早于 prepare/boot；callback 返回必须为 undefined，抛错/非空/异步返回阻断启动，意外 Promise 拒绝被消费且不等待。捕获的能力在 close 后不能复活端点；公开 IPC、父 port、环境、Renderer、ready/健康/诊断无新入口。原六/七参数与默认桌面 core-entry 保持。

Node 保留 Provider、Roon、凭据、播放、录音及生产数据写入所有权。v1/v2/v3、默认 2,000/4 MiB、显式 5,000/8 MiB、二进制 pin 与单 child 合同不变；Native 源码未改，新构建 binary 与 RUST-006 摘要相同。纯读审计只适用于 ready 后已 boot 的连接，不推广到冷迁移、未知命令或跨命令一致快照。

冻结任务：[RUST-007](../tasks/RUST-007-host-control-mixed-reads.md)，合同：[主机控制 v1](../docs/contracts/rust-core-host-control-v1.md)，决策：[ADR-044](../docs/adr/ADR-044-rust-core-host-control-mixed-reads.md)，进度：[TODO](../project/RUST_CORE_TODO.md)，机器证据：[JSON](RUST-007_EVIDENCE.json)。

## 最终验证

每次构建前核实 LifeWeave 为已挂载可写外置卷。固定 Node 22.23.2 / pnpm 10.17.1，使用已安装 rustc/cargo 1.95.0；构建、缓存、临时库和日志均在外置卷。依赖安装 frozen-lockfile/ignore-scripts 退出 0，未安装工具链。

| 检查 | 最终结果 |
|---|---|
| Rust fmt/clippy/locked test/release build 与固定依赖边界 | 43 Rust 通过，各步退出 0 |
| 旧 sidecar / Node 原子 / 版本 / 路由 / 大快照 / TS 大快照 / 索引 | 35 / 9 / 11 / 36 / 13 / 21 / 6 通过 |
| 旧 Core owner 生命周期 / utility options | 23 / 18 通过 |
| 旧实际 Node/Rust / RUST-006 Core 运行时 | 24 / 11 通过，原场景保留 |
| 新混合 Node 纯读 / 主机控制 | 83 / 20 通过；连同旧专项 119 / 38 通过 |
| 新实际 Core/Node/Rust 主机组合 | 8 项、7 场景通过，无条件跳过 |
| 完整软件 typecheck / unit / build | 全部退出 0；contracts 254 / core 2,282 / desktop 1,239，共 3,775 通过 |
| control-plane / boundaries / cycles | 全部退出 0；cycles 383 份文件 |
| 独立审查 | 两轮，剩余 P1/P2 为 0；未重复运行全部 Gate |

最终 Rust v2 Gate `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-007-iufy2wwd/rust-gate/run-YdhVLS/manifest.json`：22 步退出 0、signal=null，303 份受测源码、每步日志与七份产物（含 binary）匹配，43 Rust / 318 JS；SHA-256 `dc13246aa83f79813223237761d876abacf8a216589ef1049619f8a5b5a43549`。原 19 步完整保留，新增两套单元和实际主机 Gate。

最终软件 v2 Gate `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-007-iufy2wwd/software-final-v2/software-manifest.json`：六步全部退出 0，1,064 份程序/测试/构建源码 before=after=当前；SHA-256 `22b5a9cb823beaee7e21e34205ca9f7112b47c60e337a60d823e03091ce4659e`。三包总失败与 cancelled 均为 0，原两条 native 条件 skip 名称及原测试源码与 RUST-006 相同，没有新增跳过。软件前三步与根 verify 脚本顺序一致，另执行三个静态 Gate。

全冻结 1,241 文件在最终 Gate 和独审期间未变；后续仅更新项目状态/TODO/风险与结果报告元数据。二进制 SHA-256 `03624a10a1c9314842907142fd0cfb3931dd68edcb88a5dff6ea645832124a14`，宿主 darwin arm64。独审 `review-final.json` SHA-256 `cf27fa10791260fc031b91443bf4167e52561422af3bd136f5b3d48efcd0128c`；审查时 HEAD 仍为 base，之后提交和报告身份由主代理另核。

## 实际进程证据与限制

测试父通道调用真实 runCoreUtilityProcess、真实 Node Dataset Owner/两库领域实现及原 child_process.spawn 的固定 Rust binary；控制面明确使用 createTestBridgeRuntime，数据全为新建合成 SQLite。测试专用私有 host 通道不进入产品协议，不执行 Electron Main 或真实服务。

100/2,000/5,000 型号各有一份来源与已发布参考版本；按页面请求 sources→history(limit=1)→revision→list/待复核→detail/copy。六种纯 Node 调用每规模各一次，共 18 次，前后 Rust 状态/代次相同，零额外 child；缺失照片验证原 Node 安全错误，未冒称真实照片成功。每规模 38 个初始分页，共 114 次完整 SQLite 差分；每规模另四次写后/refresh/invalidate/refresh 分页，共 12 次。每规模实际 Rust dispatch ACK 为 40，Node 公开分派为 9，参照查询不混入公开计数。

每规模单次真实 setPolicy 写入后 list 回 Node；没有自动导出/child 或写重放。两个并发显式 refresh 合并为同一 generation/snapshot，旧 child 自然退出先于新 child 创建，完整 boot ACK 后才交付成功；invalidate 后再次显式 refresh 恢复。5,000 每候选完整 40 个 appendSnapshot ACK。主机 ready 前 refresh 拒绝，关闭后捕获能力拒绝 CLOSING。

在途关闭场景只暂挂第二候选 commitBoot 的 stdin 写入，Core 开始 closing 后再释放给实际 Rust；不伪造 ACK。迟到原生 boot 成功也不能再公布 ready/refresh 成功，两个 child 与 Node 均自然退出。callback 抛错场景 Node 在 prepare 前被关闭，Core 正确退出 1；非法父 payload 场景零 Owner/Rust，Core 正确退出 1。默认场景零 Rust。

本期七场景共 6 个 Node Owner 和 11 个 Rust child 自然退出 0，峰值 1，强制清理 0；这只描述新主机报告。保留的 RUST-006 故障报告仍单独包含受控 SIGKILL，不能把所有历史场景概括为自然关闭。

主机结果 SHA-256 `00ae43d441b066cf7d4824aaac6dce6bab58173c38084e052808b5635a35c54e`。queryRoundtripMs 含 5ms 观察轮询与 SQLite oracle，refresh 含自然排空、导出、上传和校验；仅为测试观测耗时，不是精确 Core 延迟或生产收益。旧四份成本报告及固定 RUST-004 完整路径对照重新执行（RUN），缓存/调度/规模限制保留，不据此默认启用。

## 失败与修复账本

首轮 Rust Gate 22 步通过属于修订前测试源码，manifest 独立保留。首轮完整软件 unit 退出 1：contracts 254 通过，core 2,280 通过/2 失败/原 2 skip，desktop 因前包失败未运行。两失败分别是坏 prepare 回执场景的 25ms 预算先过期，以及挂起读取场景的 20ms 预算在正常 prepare/boot 阶段先过期，未到目标断言；首次日志和 failure manifest 均保留。

只修两条旧 fixture：坏回执采用正常 RPC 预算、刻意无回执仍保留 25ms；读取超时采用 1,000ms，先证实 prepare/boot 完成，再触发真 TIMEOUT，保留迟到/不重放/关闭断言并增加帧序列、单 spawn/kill 证明。生产预算与代码没有因此改变，测试数和 skip 不变。专项 71/71 通过后重新冻结，最终 Rust 与完整软件 v2 均重新执行；不以旧 PASS 覆盖新源码。

加载依赖/编译准备错误不记为行为 RED；早期 stdout 捕获遗漏 TAP 的 33 footer 不当作完整 38 项证据，host-controls-green-complete 与最终 Gate 的完整计数为准。全部尝试日志和 SHA 记录在 `VALIDATION_LEDGER.json`。

## Carryover 与交接

实际 Main 在后台打印工作器初始化、commandOutbox currentDataset/context 仍请求 commandOutbox.context，属于本期六条纯读闭集之外，会保守失效。`NEXT_HOST_BOUNDARY_AUDIT.json` 是只读源码事实，不是完整启动证据；本期受控初始化通过不能代表完整 Main/Electron 持续使用 Rust。

Electron utilityProcess/完整 Main、真实账号/Provider/Roon、播放听感、录音、用户迁移、系统钥匙串、签名/安装替换、远端 CI、Owner 验收、push/发布/main merge 均 NOT_RUN。MBR-004 真实 Roon 根因/恢复及 Gate B P4/P5 真实设备/Owner carryover 保持。默认 Node 与生产唯一写入者不变。

下一任务从本期最终报告 HEAD 建独立分支，先审完整 Main/outbox/后台初始化请求的实际副作用，再冻结受控集成范围。正式用户启用、平台分发、持久化和超过 5,000/8 MiB 均另列验证。本期完成不代表整个 Rust 升级完成。
