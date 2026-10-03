# ADR-048 — 可选 Rust 候选资源与默认路由分层

日期：2026-10-03；状态：本地实施范围冻结。

RUST-010 已证明原控件与可选只读路由，但使用外置开发 pin。下一步先冻结最终 .app 原生资源准入：固定 darwin-arm64 路径、签后清单 SHA、实际 Mach-O 与 ad-hoc CDHash，原 ASAR 与安全 fuses 保持。既有 Node Owner→Rust 协议使用最终 Resources 可执行，原默认 Node App 单独实际启动。

生产 Main/Core 不读取 runtime env 或 Renderer 提供的 Rust 路径；新可信 bootstrap 只接受构建 pin，默认不调用。Node 继续为唯一数据库作者。资源层验证不冒称包内 Main→Core→Rust 路由；可信包内可选路由与生产启用另立任务。独立候选不弱化 FFmpeg/output/output-device 生产 beforePack，不安装替换、不迁移真实数据、不发布。

签名与清单顺序固定：native ad-hoc → manifest/pin → package/fuses → 最终 native/pin复验 → 外层 ad-hoc seal → deep/strict verify与再次内容身份核验。最终产物及自然运行证据以新鲜机器报告为准，Owner只负责最终成品使用反馈。

资源manifest schema为1，但protocolVersion=2准确标记当前默认快照进程协议；Node公开IPC v1保持。large-wire3候选接入后续冻结，不把资源schema当进程wire版本。
