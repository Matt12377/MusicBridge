# RUST-002：原子收藏快照与 Rust 只读筛选

状态：本地软件门禁与两轮独立审查通过，显式只读原型已完成；生产默认仍为 Node。

## 身份

- base SHA：`abc716686061811cd708eeb733e81ec82a1e93b9`，RUST-001 最终报告提交。
- 分支：`codex/rust-core-002-atomic-snapshot`；独立工作树：`/Volumes/LifeWeave/VSCode/MusicBridge/worktree/rust-core-002`。
- 实现提交：`a93c912951cc1e402e905c082942644dbf3bcd2c`。
- 报告提交：由 `git log -1 -- reports/RUST-002_ATOMIC_SNAPSHOT_QUERY.md` 解析最终报告提交，避免自引用 SHA。
- 下一分支基线：本报告最终提交 HEAD。
- 主代理：gpt-6.1-sol/max；本期 4 个子代理均显式 gpt-6.1-sol/high，按平台槽位分批执行，未派生更多代理。

## 行为变化

RUST-001 的完整公开页帮助函数受每页 100 型号限制。本期增加 Node Owner 私有原子导出：成功 boot 后，在一次同步 SQLite 读事务内捕获全部型号、库存与照片元数据，保持 rowid DESC、null、缺省字段和 DTO；最多 2,000 型号与 4 MiB，超限/损坏/身份变化整体拒绝，不截断或拼接公开分页。公开 208 命令和生产 Node 唯一作者保持。

Rust v2 支持 query/brand/decade/stockState 及组合条件，先筛选后分页，返回真实 total 并保持原顺序。TS 使用现有 NFKC、JS trim/空白合并/Unicode toLowerCase 生成投影；Rust 模型文本仅作 SQLite 一致的 ASCII lower。百分号/下划线按字面处理，现有 Unicode 大小写不对称行为保留。Native v1 无筛选合同继续兼容，同一进程成功 prepare 后不能切换版本。

异步 `createRustReadonlyDatasetEndpointFromOwner` 取得一次原子快照，核对来源身份，在整体单调期限内完成复制、固定二进制核验、启动、prepare 和 commitBoot，返回显式已就绪端点。过期和迟到结果不发布、不重试、不清除源 RPC、不 boot 或 close 源 Owner；只清理自己的原生进程。旧快照不会因 Node 后续写入改变，新建端点才刷新。没有接入默认应用路由。

协议：[v2](../docs/contracts/rust-readonly-sidecar-v2.md)；架构：[ADR-039](../docs/adr/ADR-039-atomic-readonly-collection-query.md)；进度：[TODO](../project/RUST_CORE_TODO.md)。

## 独立审查与回归

Node/Native 与 TS facade/Gate 分别由独立子代理审查。发现并修复两项 P2：

1. Node 已有合法持久 datasetId 允许 UUID v1～v8，新 TS/Native 校验误收窄为 v4。v2 改为沿用合法工作库规则，其他身份及 v1 保持 v4。新增 TS、Native 全版本和实际两库冷重启 v7 回归。
2. 新测试无条件要求 Darwin 使用本机 LifeWeave TMPDIR，误拒 macOS hosted CI 的 RUNNER_TEMP。两处测试使用与 Gate 一致的 hosted 判据；本机外置要求保持。只读模拟核对本机外置准入、本机本地拒绝、hosted Mac/Linux 准入，不等于实际远端 CI。

第二轮复审无剩余 P1/P2。原子读事务另有跨水合块 WAL 写入故障测试，证明旧快照不混入后续状态；异常回滚后正常 Node 入口仍可用。

## 验证

证据根：`/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-002-kupkidlt`。所有本机编译、缓存、临时数据及日志在已核实挂载且可写的 LifeWeave 外置卷。

| 检查 | 当前结果 |
|---|---|
| 固定 rustc/cargo 1.95.0、fmt、clippy -D warnings、locked build | PASS，退出 0 |
| Rust v1/v2 行为 | 26 通过，0 失败 |
| TS 故障与 Owner 工厂 | 35 通过，0 失败，0 跳过 |
| Node 原子快照 | 9 通过，0 失败，0 跳过 |
| 实际 Node 两库/Rust 进程集成 | 9 通过，0 失败，0 跳过；其中 2,000 型号 × 27 种筛选 × 4 页 = 108 个 SQLite 差分页 |
| 全工作区 typecheck / 生产 build / control-plane / boundaries / cycles | PASS，各退出 0；cycles 380 文件 |
| 全量 Node 单元回归 | Contracts 254 / Core 2,051 / Desktop 1,239，共 3,544 通过；0 失败，原有 2 项 native 条件跳过，无新增跳过；退出 0 |
| diff / JSON / 远端分支身份 | PASS；远端同名分支不存在（ls-remote 退出 2），未推送；报告提交后复核工作树清洁 |

最终 Rust manifest：`rust-gate/run-CGkIjH/manifest.json`，覆盖 281 份源码及 11 条运行日志；源码、日志、成本与二进制摘要均已核对。正式候选 binary：`cargo-target/release/musicbridge-rust-core`，SHA-256 `55043d477e44ce62ead4bca264e7d7fce89bb90f1d312973ae23e89f2075f6ac`。原 RUST-001 工作树与二进制未覆盖。

完整软件 manifest 为 `software-final/software-manifest.json`，覆盖 1,042 份代码、测试、构建/锁文件；开始/结束指纹相同，所有日志退出 0。后续仅更新任务文档、TODO、STATUS 和结果报告，不修改受测代码。

首次阶段证据保留：Native 新 v2 测试 RED 为 1 通过/8 失败；UUID 回归修复前 TS 退出 1、Native 退出 101。Node 首试因合成 fixture 违反 acquired 不可变规则失败，改用合法 quantity_adjustment；随后测试 wrapper 的 StatementSync.all 重载类型问题已修正。CI 路径问题的合成复现退出 1。最终相同目标门禁均通过，无扩大超时或增加跳过。

首次完整软件回归中 Contracts 254、Core 2,051 通过（原有 2 项 native 跳过），Desktop 1,238 通过/1 失败；失败来自已有边界测试构造的临时仓库没有复制 Rust CI 工作流，Gate 读取 `.github/workflows/rust-core.yml` 时 ENOENT。补齐 fixture 的这一个文件，保留所有拒绝断言，相关 3 项通过；完整软件门禁以 `software-final/` 新日志重跑，不覆盖首次失败记录。

## 完整调用成本

最终 Gate 的 2,000 型号、808,802 字节快照，warm Node Owner，OS 缓存未控制：一次导出 roundtrip 57.984 ms；从 Owner 到就绪 Rust 的完整启动 124.255 ms，包含导出后复制/序列化、二进制摘要、进程建立及准备，剩余部分 66.271 ms；ACK 加自然退出 2.495 ms。

重复 10 次固定品牌加空白库存查询，Node 与 Rust 均包含进程往返，Rust 包含 TS 完整筛选页核验；中位分别为 3.963 ms 与 1.950 ms。原始逐次数据在 `rust-gate/run-CGkIjH/atomic-snapshot-cost.json`。这是单一合成规模、单一查询、既有缓存状态下的成本记录，不是冷盘测量，不代表生产加速，也不能忽略每次快照刷新所需的 124 ms 启动成本。

## Carryover 与交接

生产默认 Node、唯一数据库写入所有者保持；没有用户数据迁移、真实账号/Provider/Roon、播放、录音、Owner 验收、全量 Electron E2E、安装替换、remote CI、push 或 main merge。MBR-004 真实 Roon 根因/恢复及 Gate B/P4/P5 的原 carryover 未提升状态。

下一阶段从本期最终报告 HEAD 接续，根据完整成本选择实际热点、规模预算与刷新失效合同，再定义可验证范围。大于 2,000 型号、Rust 数据库写入、默认路由、签名分发和真实设备分别保留为后续事项。
