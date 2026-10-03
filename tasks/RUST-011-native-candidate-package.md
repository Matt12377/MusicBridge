# RUST-011 — macOS arm64 离线候选包原生资源准入

Owner 已授权继续剩余待办，开发验证全部由代理承担。继承 RUST-010 最终 HEAD `ed40e39c39db908200e946c0c13dcfc1ddc0a206`；分支 `codex/rust-core-011-native-candidate-package`，工作树 `worktree/rust-core-011`，外置证据 `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-011-3samm9m1`。旧010手册WIP只读保留，不复制进本任务提交。

冻结目标：把外置 Rust 开发二进制改为独立候选 .app 内可验证资源，实际证明签后 Mach-O arm64、固定路径/清单/pin/CDHash、最终 bundle 签名、实际 ASAR/Fuses；从最终 Resources 运行原 Node→Rust 只读协议；直接启动同一候选包的原默认 Node Main，观察原 readiness 和 app.quit 自然收口。默认应用运行路径、Node控制面与唯一数据库作者保持不变。**本任务不证明候选 Main/Core 的 Rust 路由**，该阶段另立任务。

私有合同：[RUST-011_NATIVE_RESOURCE_V1](../docs/contracts/RUST-011_NATIVE_RESOURCE_V1.md)，ADR-048。每个源与产物都绑定新鲜 SHA；最终签名前的检查不能作为最终产物身份。

## 四角色与文件范围

最新用户四个 sol6.1/high 优先于旧 AGENTS 三个 max；含主代理四活动槽，三作者后第四独审，不再派生。主代理按 sol6.1/max 会话约定整合。

- A：新 `apps/desktop/scripts/rust-native-package.mjs` / `.d.mts`，`apps/desktop/test/rust-core/rust-native-package.test.ts`；严格清单/资源/签名和复制准入。
- B：新 `apps/desktop/src/main/rust-core-resource.ts`，`apps/desktop/test/rust-core/rust-core-resource.test.ts`；可信固定资源定位，无默认调用。
- C：新 `apps/desktop/test/helpers/rust-offline-candidate-evidence.ts` / `rust-offline-candidate-protocol.ts`，对应 `test/rust-core/*.test.ts`；实际 Node 两库与包内 Rust 协议、独立严格报告与拒绝。
- 第四角色：独审至多两轮，外置收据，不写生产源码。
- 主代理：本任务/合同/ADR/索引/STATUS/TODO/风险，`scripts/ci/verify-rust-offline-candidate.mjs`、新专用 tsconfig、可选根 package Gate 入口、构建/最终签名/实际运行/身份，独立实现与报告提交。

## Gate

1. 外置挂载且可写、base/分支/远端/工作区/其他任务核验，三份审计实际输入与摘要核验；审计不是测试。
2. 有意义的新资源/路由/收据/真实协议行为测试，先保留有效 RED；专用 typecheck 覆盖全部新文件；任何准备错误单列。
3. 新鲜 Rust arm64 构建和签名，独立候选打包，生产 beforePack/resources 配置逐字节保留；无隐式下载和真实 native 音频验收。
4. 最终 Resources 协议真实完整 DTO/ACK/写拒绝，Node/Rust自然退出0；直接候选可执行默认Node startup ready、Core/Electron自然0，无强制清理。
5. 最终 ASAR 主入口/完整SHA/header integrity/所有原fuses/native/bundle签名与源和产物保持，严格证据helper真实准入与拒绝，零新增skip。
6. 程序冻结后的完整软件六步与匹配的必要旧回归；两轮独审；diff check/明确路径实现提交和报告提交/最终HEAD与remote和原WIP身份。所有失败尝试保留，不累加重试计数。

本地候选资源成功、打包内协议、默认Node启动、正式Rust路由、Owner最终使用、真实服务/音频、安装/发布分别记结论。x64/universal/Developer ID/notarization、生产默认启用、真实用户迁移/持久化均未授权本期；MBR-004和Gate B carryover保留。

冻结校准：资源清单schema v1、实际默认快照wire v2，manifest protocolVersion=2；Node公开IPC v1保持。large wire v3候选准入另列。原Rust/Sidecar协议没有改动；签名资源准入与实际wire一致。
