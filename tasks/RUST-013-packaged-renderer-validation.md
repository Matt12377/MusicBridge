# RUST-013 — 签名包原控件、持久 outbox 与冷启动验证

Owner 持续开发及代理承担全部测试的授权下，从 RUST-012 最终报告 `822594bcccff302c011121ce0a813ee74d5756cc` 接续。分支 `codex/rust-core-013-packaged-renderer-validation`；工作树 `worktree/rust-core-013`；外置证据 `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-013-okq8m8xs`。13 个原工作树和 7 个未提交文件均保护，旧报告、失败和签名包保持原身份。三作者 41/36/51 项审计输入已逐项核验；审计不算运行通过。

RUST-012 的 Main 探针在创建原窗口、IPC 和持久 outbox 前退出；009/010 的原控件证据使用包外 fork wrapper。本期补实际签名包内的原窗口、preload、Vue、可信 Main IPC、Main 持久请求账本、Core、唯一 Node 业务作者和只读 Rust 列表路径。详情与其他辅助读取仍由 Node 承担。

实施合同见 [RUST-013_PACKAGED_RENDERER_VALIDATION_V1](../docs/contracts/RUST-013_PACKAGED_RENDERER_VALIDATION_V1.md)，选择见 ADR-050。固定四静态包：default-node、node-renderer、rust-renderer、pin-rejected。两个正例各自 fresh → 自然关闭 → 同包同 profile cold；总六次运行。fresh 经原入库控件建立 26 型号，再测原 limit24 分页/筛选、原保护表单单写、stale Node 回退和两次可信私有刷新；cold 只读，零 execute、零私有刷新。

原“刷新库存”仅错误态重读，不能宣称它已有 Rust 快照刷新功能。固定 DOM 控件驱动 isTrusted=false，普通 computer use、Main 完整回执、Renderer 像素与独立完整 Renderer DTO 分别记录。成本仅 26 型号实际 Main request/reply 往返，不冒称大规模加速。

## 文件分工

用户四个 sol6.1/high 要求覆盖旧三/max。平台含主代理四活动槽，三个作者并行，第四角色随后两轮独审，不派生更多代理。

- A：`src/main/index.ts`、新 `packaged-renderer-core-observer.ts`、新 Node/Rust 两个 Core 入口、新 `packaged-renderer-ipc-observer.ts`（如需）及相应测试。原安全验证、完整 bootstrap、固定 core.js、原业务 listener 单次执行及自然关闭接点；不修改原 outbox/preload/Vue。
- B：新 `packaged-renderer-main-probe.ts`、新 `packaged-renderer-dom-driver.ts`（如需）、新 `rust-packaged-renderer-runtime.mjs/.d.mts`、新 `rust-packaged-renderer.vite.config.mjs` 及对应行为测试。固定原控件、被动公共端口、闭集私有刷新、合成 profile marker 与 cold 收据准入。
- C：新 `test/helpers/rust-packaged-renderer-evidence.ts`、`rust-packaged-renderer-cost.ts` 与对应两个拒绝/计算测试。独立 actual artifacts 准入，Main 完整 DTO、关闭 SQLite 对照、回执关联和真实计时；不能靠构造成功样例通过实际 Gate。
- 主代理：默认 false 编译定义与旧 VM 夹具常量、专用类型覆盖、任务/合同/ADR/STATUS/TODO/索引、候选 Gate、实际构建/签名/运行及关闭后 SQLite 独立对照、适当回归、Git 实现/报告提交与身份。
- 第四角色：最多两轮独立审查，外置收据，不能修改作者源码。

## 门禁

1. 冻结合同与源文件范围；有效 RED、准备错误与运行失败分别保留，不覆盖旧日志。
2. 新鲜离线 arm64 Rust/生产构建；四包最终签名、Resources pin、ASAR/header、九位 Fuse 与全部原 Renderer/preload 资产一致。
3. 六次直接 app binary 运行，不使用 inspect/CDP、RunAsNode、外部 JS wrapper 或替换 Core fork。原 26 入库及一次保护写经原持久 outbox，关闭后独立只读验证请求、结果、ACK、唯一领域命令与实际库存。
4. fresh 固定两次私有刷新、原分页/筛选、写后 Node 与恢复 Rust；cold 数据集/型号/策略/revision/请求账本保持，无自动执行。生命周期包括 outbox-close-end、无 timeout、所有实际资源 ACK 与自然退出。
5. 严格证据拒绝缺控件/错身份/错回执/错 DTO/错数据库/伪造成本及生命周期；专用类型、相应旧回归、完整软件门禁全由代理执行。
6. 两轮独审后独立实现/报告提交；核 diffcheck/clean/remote、源/Git blob/当前包和所有保护 WIP。下一任务从本期最终报告 HEAD 开始。

生产默认 Node 和 Node 唯一业务库作者保持。本期不安装替换、不 push/发布、不迁移真实用户库，不访问真实账号、Roon、播放/录音。正式用户刷新/启用、规模/热点/相邻领域、持久化兼容合同与跨架构/真实验收继续推进各自范围；本期通过不等于总目标完成。
