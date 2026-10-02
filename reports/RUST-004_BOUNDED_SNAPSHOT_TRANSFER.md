# RUST-004：5,000 型号完整快照与有界分块传输

状态：本地 Rust Gate、完整软件 Gate 与两轮独立审查通过。可选原型完成；生产默认仍为 Node，Node 继续拥有数据库写入和控制职责。

## 身份

- base SHA：`f3b398f7f872d5776ab8a65f3eb3ec5d7894c0af`，RUST-003 最终报告提交。
- 分支：`codex/rust-core-004-bounded-transfer`；工作树：`/Volumes/LifeWeave/VSCode/MusicBridge/worktree/rust-core-004`。
- 实现提交：`1d3046b752c89c9aeed369906505d2c3978ddcc0`。
- 报告提交：由 `git log -1 --format=%H -- reports/RUST-004_BOUNDED_SNAPSHOT_TRANSFER.md` 解析，避免自引用 SHA。下一分支从最终报告 HEAD 创建。
- 远端复核：对应 `git ls-remote --exit-code --heads origin refs/heads/codex/rust-core-004-bounded-transfer` 退出 2、无匹配引用；本期未 push。提交后最终身份另存证据根 `FINAL_IDENTITY.json`。
- 4 个显式 gpt-6.1-sol/high 子代理分别承担 Node、Native、TS 与独立审查，按平台槽位分批运行；主代理负责真实进程集成、整合、Gate 和报告。没有继续派生代理。

## 行为与边界

旧 v1/v2 原型限制完整快照最多 2,000 型号。Node 已有合法的 5,000 型号合成总库证据，本期增加显式 `snapshotProfile: 'v3-5000'`，一次导出完整事实再有界上传。缺省及 `'v2-2000'` 保持原 2,000 型号 / 4 MiB；v3 允许 5,000 型号 / 8 MiB，超过预算整体拒绝，不截断、不拼接跨时刻实时分页、不自动降级。

Node 新独立 guards、repository 大快照导出和私有 `exportLargeVersionedCollectionSnapshot`。全部型号、库存、照片与稳定顺序在同一同步 SQLite 读事务内水合；身份和版本 stamp 前后配对。三种导出 API 共享一项在途预算与 snapshotId 防重复集合。旧 mock 缺少新能力可继续旧 API，显式 v3 则拒绝。公开 208 命令、worker 协议版本 1、schema 与唯一作者没有变更。

Rust v3 先 prepare manifest，再逐块 appendSnapshot，完整 commitBoot 后才接受查询。非末块恰为 128 型号，5,000 型号是 39×128＋末块 8，共 40 块；空快照不发块。跨块重复 ID、错序、缺块、超量、非法 DTO、身份或协议变化均启动失败。每块帧最多 1 MiB，普通帧最多 4 MiB，两端单帧预算均不计行尾 LF；append 累计输入预算 `8 MiB＋64 KiB` 计入所有 LF，完整规范快照最多 8 MiB。Native 采用增量规范字节计数，不在每块重复编码整个集合；无新增 Cargo 依赖。

TS 精确核验每块 ACK，顺序发送单块，不预存全部编码帧、不重发；从 Node 导出到复制、pin、prepare、全部分块和 commitBoot 共用整体单调期限。v3 部分启动关闭消耗当前块 ACK 后停止发下一块，通过 close ACK 和实际自然退出判断成功。路由登记尚未完成上传的候选，失效和 close 立即撤销发布并收口；旧 v2 失败候选退役规则保留。版本前后探测、代次围栏、最多一个 child、借用来源 Owner，以及 Node 写入 unknown 原回执和单次执行保持。

协议：[v3](../docs/contracts/rust-readonly-sidecar-v3.md)；决策：[ADR-041](../docs/adr/ADR-041-bounded-snapshot-transfer.md)；冻结范围：[RUST-004](../tasks/RUST-004-bounded-snapshot-transfer.md)；进度：[TODO](../project/RUST_CORE_TODO.md)；机器证据：[JSON](RUST-004_EVIDENCE.json)。

## 验证与审查

构建、缓存、临时两库和日志均在已确认挂载且可写的外置 LifeWeave 卷。证据根：`/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-004-6uwdvhva`。

| 检查 | 最终结果 |
|---|---|
| rustc/cargo 1.95.0，fmt、clippy -D warnings、locked test/build、依赖边界 | 全部退出 0；Rust 旧 26＋新 14＝40 通过 |
| 原 Sidecar / 原子快照 / 版本 / 路由 | 35 / 9 / 11 / 36 通过，无失败或跳过 |
| 新 Node 大快照 / TS 大快照 | 13 / 21 通过，无失败或跳过 |
| 实际 Node 两库 → 固定 Rust 进程 | 原 16＋新 7＝23 通过；5,000 型号完整 50 页、108 个筛选差分页与 SQLite 一致 |
| 全工作区类型 / 生产 build | 各退出 0 |
| 全量单元 | Contracts 254 / Core 2,132 / Desktop 1,239，共 3,625 通过，0 失败；原 2 项 native 条件跳过保留，名称未变，无新增跳过 |
| control-plane / boundaries / cycles | 各退出 0，cycles 381 文件 |
| diff / JSON | 各退出 0；实现与报告分别提交，随后核对最终 HEAD、工作树与远端 |

真实进程测试还覆盖旧 v2 拒绝 5,000、v3 拒绝 5,001、空库及 UUID v7、写后失效/刷新、部分上传自然关闭、实际 SIGKILL 非成功，以及 unknown 写入单次账本与冷启回执。完整导出/查询前后校验五张收藏事实表（models/skus/lots/copies/photos）摘要不变；该摘要不是对所有数据库表的笼统证明。

Rust Gate `rust-gate/run-dCc7sr/manifest.json` 共 15 步退出 0、signal=null，291 份源码、所有日志及三份成本 JSON 摘要匹配。manifest SHA-256：`c2c00618a1815c71c02e4daace81bf5f3fac451cd8a6a78ad6a4f966c75cd36f`。release binary `cargo-target/release/musicbridge-rust-core` SHA-256：`1e2b5164591204772196f987009ae254bda2fcb807471f5ff917ec65b5c105ea`。

完整软件 `software-final/software-manifest.json` 六步退出 0，1,052 份代码/测试/构建文件开始、结束和当前摘要相同。manifest SHA-256：`38db8730929ee9c11270584b0c9a51ab19350beed283121afa3f5463fe05ace6`。报告整理没有修改受测实现；冻结后仅澄清 v3 合同 LF 文字，两端实现与测试未改，初始与最终冻结收据均保留（其余 1,220 份文件一致）。

两轮独立审查剩余 P1/P2 为 0。第二轮只核新增完整软件证据、原条件 skip 与 LF 文字，不重复测试、不追加第三轮。最终审查 `review-final.json` SHA-256：`0acf38abcf0584dc93fd281e9719770f8daa46e899140963b77b5e74347cee6d`；第一轮文件保留。

失败账本如实保留：Node 新能力缺失行为 RED 最终转绿；TS 初期两个测试类型错误修正，错误路径启动不冒称代码 RED；实际大快照首轮 6/7 的失败来自测试 payload 使用 descriptor/quantity，改为合法 model/quantities 并补清理后二轮 7/7，最终同目标 Gate 23/23。没有把测试构造问题写成生产缺陷，也没有宣称所有实现都先有 RED。

## 完整成本

以下为最终 Gate 的 5,000 型号合成 warm 数据，每种工作量 10 次。Node 包含线程 RPC 和响应验证；Rust 包含前后两次 Node 版本 RPC、真实进程往返与 TS 完整事实核验。差分 assert 在计时外，OS 缓存未控制。

| 工作量 | Node 中位 ms | Rust 完整路径中位 ms |
|---|---:|---:|
| 无筛选首屏 | 1.677 | 2.021 |
| 品牌＋库存筛选 | 6.807 | 3.219 |
| 字面百分号/下划线 | 5.906 | 4.989 |
| Unicode | 6.321 | 4.937 |
| 年代 | 3.686 | 2.479 |
| 空结果 | 4.393 | 1.482 |

大快照 Node 导出往返 **136.145 ms**、显式刷新 **365.439 ms**、关闭 ACK 加自然退出 **3.508 ms**。完整快照 2,021,759 字节，40 块实际上传共 2,033,779 字节，最大块 52,083 字节（观测值计入 LF）。刷新导出 1 次；60 次 warm Rust 查询包含 120 次 Node 版本 RPC；峰值 child 1，来源 Owner prepare/boot/close 均 0，自然退出 code=0、signal=null。

部分筛选有收益，无筛选首屏 Rust 略慢。因此本期结论是完整大快照和安全传输成立，不能宣称全路径加速、冷盘/真实库收益或硬内存上限。下一步应围绕已测筛选热点建设有界索引，保留完整调用成本与差分，而不是直接默认启用。

## Carryover 与交接

默认 Node、唯一作者与原公开合同保留。真实用户库/迁移、Provider/Roon、播放、录音、Owner 验收、全量 Electron E2E、系统 Keychain、安装替换、签名分发、remote CI、push 和 main merge均未执行。MBR-004 真实恢复与 Gate B/P4/P5 证据不提升。

超过 5,000 型号/8 MiB、后台失效推送、查询索引、默认启用、完整命令或持久化写入迁移仍分别待办。原工作树与产物保持，下一任务从本报告最终提交 HEAD 接续；阶段本地交付不等于真实产品验收。
