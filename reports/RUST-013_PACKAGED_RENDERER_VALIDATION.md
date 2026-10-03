# RUST-013 签名包原控件与持久 outbox 验证

最终签名包、完整软件门禁与两轮独审已通过，未解决 P1/P2 为 0。四份 arm64 ad-hoc 包、六次实际运行证明原窗口、preload、Vue 控件、可信 Main IPC、持久 outbox、唯一 Node 作者与可选只读 Rust 列表路径。默认生产构建继续使用 Node；本期未安装替换、迁移真实库、push 或发布。

基线 `822594bcccff302c011121ce0a813ee74d5756cc`，实现 `dec447f49905be112969586dc08cd1be0812a5e5`，分支 `codex/rust-core-013-packaged-renderer-validation`。构建时实际 HEAD 是基线；随后全部 1,110 程序输入与实现 Git blob 一一匹配。报告提交由 `git log -1 --format=%H -- reports/RUST-013_PACKAGED_RENDERER_VALIDATION.md` 解析，下一分支使用最终报告 HEAD；外置 `FINAL_IDENTITY.json` 绑定最终 HEAD 与清洁状态。机器证据：[RUST-013_EVIDENCE.json](RUST-013_EVIDENCE.json)。

每个 Node/Rust fresh 合成 profile 均经原表单入库 26 型号，再经原保护表单执行一次写入。各有 27 次 Main outbox 提交和 ACK；领域库存/revision、请求 fingerprint 与实际结果由关闭后的独立只读 SQLite 参照核对。原 limit24 分页、品牌/年代/待核筛选、详情、写后 stale Node 回退和显式私有刷新后恢复 Rust 均通过。同包同 profile cold 保留 26 型号、保护策略和 27 条账本，零提交、零 ACK、零私有刷新；允许原 boot 元数据 epoch 变化。

最终验证：

- `candidate-03`：四包最终签名、Resources pin、ASAR/header 与九位 Fuse 保持，131/131 专项通过，零失败/跳过。四份关闭后 SQLite 参照与 200 次完整 list/detail 对照通过；原 preload、Renderer 与四个 Main outbox 源文件保持基线字节，四包原资产一致。
- 完整软件六步全部退出 0：类型、3,983 单元通过、生产构建、control-plane、boundaries、cycles。仅原有两条条件 native skip，未把它们写成通过或消失。
- Rust 单元 43/43、release 退出 0；最终签后包内 binary 的原生命周期/主机/刷新集成 26/26，零 skip。原受控 SIGKILL 负例单列，不混入正常自然退出。
- 两 fresh 各 74 个固定 DOM 动作/4 张截图，两 cold 各 5 动作/1 张截图。四个正例 Main/Core/Node 自然退出 0；Rust fresh 43 个请求/validated ACK、3 次自然关闭，cold 11 个请求/ACK、1 次自然关闭；关闭 ACK、pending0 与 Main outbox-close-end 均观察完整，无 timeout/强制清理。默认包仅原 mock startup 通过；错误 pin 真实失败且无 Node/Rust 创建或 ready。

固定 DOM 工程驱动的 `isTrusted=false`；本期没有普通 computer use 或 Owner 验收。证据覆盖实际 Main 完整结果、原资产与 DOM/像素，没有独立观察完整 Renderer DTO。原“刷新库存”仅错误态重读，私有刷新不等于已有普通用户刷新按钮，下一期继续实现。

成本记录 88 个实际 Main 同进程 request/reply 样本，范围为 26 型号、含候选观察及同步 Core 日志的往返时延。真实 native 帧传输 ID 与公共请求 ID 分别关联，不跨进程相减时钟；DOM 等待单列。结果不足以证明稳定生产加速，默认保持 Node。

失败记录保留：首轮真实运行完成但公共/native 双 ID 关联拒绝，随后发现原自然退出截断候选观察 stdout 尾部；补齐实际关联和候选同步完整写，不补造 ACK 或改原退出逻辑。独审两项 P2 的拒绝依赖图及全 26 型号 SQL 重建问题已由真实 unchanged 对照和串改负例验证闭合，第二轮独审收据 `d646254266d2a9b63369009bb19458910a2b2f8687f31002d73a153623df2e39` 绑定最终输入与实现。完整类型首跑另因新 MJS 缺模块声明退出 2；新增精确声明并保留原非法输入断言后，新冻结、完整软件和签名包重新验证。

真实账号、Roon、播放/录音、设备、安装、其他架构与历史 MBR-004 现场恢复分别未验收。正式用户刷新/可选启用、规模/热点和相邻领域/持久化兼容合同从本期最终报告 HEAD 接续；本期通过不等于完整 Rust 迁移。
