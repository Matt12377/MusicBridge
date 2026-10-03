# RUST-012 候选包内可信只读 Rust 路由

本地 Gate 与两轮独审已完成，第二轮通过，未解决 P1/P2 为 0。四份独立 arm64 ad-hoc 候选包现在证明原 Main 的固定 CoreSupervisor→包内 Core→最终 Resources Rust 只读路径。写入仍由唯一 Node Owner 执行；写后回退 Node、重复 commandId 不增加库存，可信显式刷新恢复 Rust。默认生产构建仍使用 Node，没有真实数据迁移、安装替换、push 或发布。

基线 `13b2a14f03831ed7a98bdc5d1b9ab288644fc502`，实现 `697763759704789460c72e733e42321a71046ac5`，分支 `codex/rust-core-012-packaged-readonly-route`。构建时实际 HEAD 是基线；全部 1,086 受测程序输入随后与实现 Git blob 逐项匹配，不能把构建时提交改写为实现提交。报告提交由 `git log -1 --format=%H -- reports/RUST-012_PACKAGED_READONLY_ROUTE.md` 解析，最终 HEAD、清洁与下一分支基线由外置 `FINAL_IDENTITY.json` 绑定。详细机器证据：[RUST-012_EVIDENCE.json](RUST-012_EVIDENCE.json)。

四包分别验证默认 Node、同流程 Node 参照、可信 Rust 和错误 pin 拒绝。正常两份诊断各有 25 个实际 Main/Core 请求及回复；Rust 包 16 次收藏查询中 14 次由 Rust 返回、2 次写后由 Node 返回（router为stale，实际Node请求身份已核对），完整 DTO 依照该合成库实际随机 ID 比较。3 次原子快照分别含 0、3、4 个型号，23 个 native 请求及经过原验证的 ACK；三个 Rust 子进程均自然退出 0、close 已确认、pending 为零，无 kill。Node Worker、Core、Main 均自然退出 0。错误 pin 在原 supervisor 一次重启后实际失败退出，无 Node、Rust 或 ready；默认包只证明原启动 ready、Main 自然退出和静态 Node 入口，不独证其 Worker 退出。

当前验证结果：

- 最终四包 Gate 退出 0；171/171 专项，含 71 项严格证据准入与深入改写拒绝，零 fail/skip/cancel。
- 同一 1,086 程序输入完整软件六步退出 0，3,973 项通过，仅原两项 native 条件 skip；新增嵌套 Rust 专项由独立候选 Gate 执行，不冒称普通 unit 通配符包含它们。
- 新鲜离线 Rust 单元 43/43；最终 Resources 二进制旧生命周期/主机/刷新 26/26，零 skip；既有受控 SIGKILL 负例保留，不冒称负例 child 全自然退出。
- 两个关闭后的合成 SQLite profile 以 immutable 只读连接核对 10 条实际写回执，每库 4 条领域命令、4 型号/4 批次/0 实体，重复提交未加库存，库字节前后相同；这不是运行中数据库只读纯度或 Main 持久 outbox 恢复证据。
- 四个完整签名包树、最终 native/manifest/ASAR/header integrity/9 位 Fuse、29 个生产 dist、275 个 Electron 缓存项及原 12 工作树/7 个 WIP 文件身份保持。专用 TS 类型与三项 JS 语法、实际执行分别记录。

第二轮独审确认第一轮 5 项 P2 全部闭合：非法 factory 配置先于 Node Owner 拒绝；观察 sink 同步异常和异步拒绝不改变写回执/关闭；从实际 spawn 捕获 Core PID；读取原固定 stderr 失败标记；最终 Gate 纳入两个此前遗漏的行为测试。有效 RED 23 项失败与随后 GREEN 23 项保留，最终 171 项覆盖新增异步 sink 与启动夹具。旧 candidate-01 FAIL、软件 7 项 VM 夹具失败、关闭后库存表预期错误均保留原现场；只补齐默认关闭编译常量并保持全部原断言，未改写失败收据。

Main 诊断编译字节与生产不同，候选专用 Core stdout pipe、第二私有刷新端口与外置临时环境已在合同公开；不开放运行期 Rust/path/pin 选择器，不使用外部 JavaScript wrapper、调试参数或弱化 Fuse。原 preload、Vue、生产 Core 入口、桌面打包配置和音频 beforePack 不改。此候选不认证生产音频资源、Developer ID、公证、x64/universal、大快照 wire3 或真实账号/Roon/播放/录音。Renderer/Owner 使用固定 NOT_RUN，Owner 不承担中间开发测试；历史 MBR-004 与真实 Gate B carryover 继续保留。

合同：[RUST-012_PACKAGED_READONLY_ROUTE_V1](../docs/contracts/RUST-012_PACKAGED_READONLY_ROUTE_V1.md)。任务：[RUST-012](../tasks/RUST-012-packaged-readonly-route.md)。证据根：`/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-012-912_vagt`。下一任务从最终报告 HEAD 建立，不从实现提交或构建时基线直接接续。
