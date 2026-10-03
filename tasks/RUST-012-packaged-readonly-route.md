# RUST-012 — 候选包内可信可选只读Rust路由

Owner“继续推进剩余待办事项”授权下，从RUST-011最终报告HEAD `13b2a14f03831ed7a98bdc5d1b9ab288644fc502` 接续。分支 `codex/rust-core-012-packaged-readonly-route`，工作树 `worktree/rust-core-012`，外置证据 `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-012-912_vagt`。011源码/最终包和原010用户手册WIP保留。三作者73项源码审计已独立核对；合同 [RUST-012_PACKAGED_READONLY_ROUTE_V1](../docs/contracts/RUST-012_PACKAGED_READONLY_ROUTE_V1.md) 和 ADR-049 冻结当前实施边界；审计不算测试通过。

目标是实际候选.app内Main固定CoreSupervisor→包内Core→最终Resources Rust只读路径，具备可信固定清单pin。默认Node、Node诊断、Rust诊断与错误pin拒绝四份独立静态包；候选Main编译诊断字节不同，私有第二端口/stdout pipe/外置临时环境差异公开记录。原生产core-entry与默认build保留Node，不开放运行期env/CLI/Renderer/父payload选择Rust、二进制或pin。原preload、Vue控件、Node outbox和唯一数据库作者保持。snapshot wire2/v2-2000；三合成型号矩阵12请求、第四单写及同commandId重投、Node回退、可信refresh恢复Rust。不将旧large wire3回归自动视为新资源准入。

Owner只负责最终成品使用反馈；全程类型/行为/故障/实际合成应用及完整回归由代理验证，不安排Owner中间测试。无真实账号、Roon、播放/录音、真实用户数据迁移、安装替换、push/发布或main合并。

## 四角色

最新用户4个sol6.1/high覆盖旧AGENTS的3/max；主代理sol6.1/max负责整合。平台含主代理4活动槽，角色按槽位顺序接续，不再派生。

- A：core-host、utility-main、packaged-rust-core-bootstrap/entry 与三个对应测试（7文件）；九参数factory/默认路径/生命周期。
- B：Main/index、packaged-route-main-probe/core-observer、packaged-node-core-entry、runtime mjs/d.mts、sidecar observer与四测试（11文件）；固定Main请求/实际观察，默认关闭。
- C：严格实际包内路由收据与拒绝测试；不能把外部Node protocol或私有fork替换作为包内真实路由通过。
- 第四角色：两轮独立审查，外置收据，不写生产源。
- 主代理：任务/合同/ADR/STATUS/TODO/索引、候选离线编译/打包Gate、专用类型覆盖、新鲜构建/最终签名/Fuses/ASAR/源码与产物身份、完整软件六步、实现和报告独立提交。

## 验证门禁

1. 011最终Git/软件/产物收据、有效AGENTS、外置挂载可写、独立分支/remote/其他写入任务与所有原WIP身份。
2. 实际代码与边界审计后冻结合同/文件范围；可复现语义缺口优先保留有效RED，准备错误单列。
3. 新鲜离线arm64候选包，固定资源/native签后pin和源/编译定义/完整ASAR/Fuse/最终签名；生产配置/音频beforePack/默认入口保留。
4. 真实原Main/Core/Node与包内Rust，完整DTO/实际ACK、后台只读、Node唯一写/写后回退/可信refresh及资源自然退出；并列原默认Node和受控资源准入负例。外置入口或外部Node证明不代替此路径。
5. 完整实际证据严格准入与漂移/伪造拒绝，专用TS类型与JS语法/实跑分别记录，零新增skip；同程序冻结完整软件六步和匹配必要旧回归。
6. 两轮独审、独立实现/报告提交、diffcheck/clean/current和remoteHEAD、所有原工作树WIP、最终包/当前源与Git blob绑定；下一任务从最终报告HEAD创建。

跨架构、Developer ID/公证、生产默认启用、真实服务及Rust数据库写入迁移继续另列；MBR-004与真实Gate B carryover不关闭。

## 本地验证记录

最终 `candidate-03` 四份签名包、原Main/Core包内路由及171专项通过，零fail/skip；严格证据含71项。`software-final-02` 六步全0，3973通过、仅原2条native条件skip；Rust单元43及最终Resources二进制旧26回归全0。当前1086源码、29生产dist、275Electron缓存与四包树身份一致，原12工作树和7个WIP文件保持。两份关闭合成库以immutable只读连接独立核对10条回执及4条去重领域命令。

首份实际candidate-01 FAIL、软件7项VM夹具失败和错误库存表预期均保留原现场并单列分类。补齐原默认关闭编译常量后保留全部原断言；最终四包和六步软件使用新的独立目录与日志，不改写历史失败。最后独审与实现/报告Git身份由交付记录接续。
