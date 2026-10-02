# RUST-001 — Rust Core 只读快照原型

Owner 于 2026-10-02 明确把本会话从只读技术分析升级为实际开发；等待 MusicBridge V3.7 完成后接续。基线为 MBR-004 最终报告 HEAD `2392b8f69836f02e39ce58f6e6e6e2563c6cc5d4`，分支 `codex/rust-core-001-readonly-sidecar`。

主代理使用 gpt-6.1-sol/max；Owner 后续将子代理上限放宽至 4 个，本期 4 个开发与审查子代理均明确使用 gpt-6.1-sol/high。平台并发额度不足时分批运行，不派生更多代理；此轮次用户明确设置优先于 AGENTS.md 中子代理数量及 max 的历史设置，不修改全局模型配置。

## 已放行范围

- 冻结 [私有进程协议](../docs/contracts/rust-readonly-sidecar-v1.md) 与现有 DatasetOwnerEndpoint 的适配边界。
- 实现无 SQLite、网络、凭据和音频依赖的 Rust 只读快照进程。
- 实现显式调用的 TS facade，复用 collection.list 公开请求/结果验证、身份、期限和关闭纪律；正常生产 Core 入口保持当前 Node 实现。
- 合成库存差分、坏输入、身份围栏、超限、背压、迟到回执、崩溃和关闭测试；工具链、锁文件、Gate、CI 和结果报告。

## 本任务不准入

现有两库作者切换、真实用户数据迁移、208 命令完整替换、音频/录音/Provider/Roon 迁移、生产默认开启、App 安装替换、签名、推送或发布。MBR-004 真实账号/Roon 现场复测、原 Gate B/P4/P5/Owner carryover 继续保留。

## 退出 Gate

Rust fmt/clippy/test 与锁定构建；TS/Rust 实际二进制差分和异常生命周期测试；现有工作区 typecheck、完整单元、build、控制面/安全边界/循环 Gate。固定源码和二进制摘要，独立实现与报告提交，机器状态只新增本任务事实，不覆盖 MBR-004 证据。仅在所执行的验证范围内作完成结论，未执行的真实设备、Electron 全量 E2E、远端 CI 和发布明确记为 NOT_RUN。
