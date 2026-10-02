# RUST-008 — 正式 Main 初始化读写边界与隔离 Electron 宿主

Owner 持续开发授权，从 RUST-007 最终报告 HEAD `50d2e8573dfdaea4cd97fee09ac1c85effe3f2da` 接续。分支 `codex/rust-core-008-main-read-boundary`，工作树 `worktree/rust-core-008`，证据目录 `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-008-_or91fh6`。

## 问题与冻结范围

正式 Main 的 outbox 身份读取以及打印工作器每 1.5 秒的空队列领取均会撤销现有 Rust 候选。RUST-007 的实际 Core/Node/Rust 证据使用 Node Worker 适配宿主，尚未覆盖真实 Electron Main 初始化链。

1. 只向纯 Node 闭集增加 `commandOutbox.context` 与 `collectionProgress.modelLengths` 两条已审计命令；旧六条保留。仅限已经 boot 的固定 Owner 连接，保留原结果/错误和代次围栏。`collectionProgress.current` 已列实际 Renderer 调用事实，尚未审定为本期纯读，不按名称或前缀扩大闭集；本期不得宣称整个收藏 UI 已获 Rust 准入。
2. `recordingPrintWorker.claim` 不进入纯读闭集。仅在同一活动候选、同一 generation、未关闭且前后完整 scope/version 都等当前候选、原回执为精确 own-data `lease:null` 时保留该候选。准入同步增加 writes 与条件窗口计数，直到后置探测、判定和 finally 收口；任何真租约、原错误/unknown、版本变化/探测失败均保守撤销，原 Node dispatch 只执行一次且原结果/错误不被辅助检查覆盖。不得重新挂回已撤销的对象、自动 refresh 或重放；迟到判定不能撤销新的候选。
3. 条件窗口必须有读取完成屏障：所有 Node 纯读和列表成功/错误在窗口收口前不得交付。空领取证明收口且没有其他窗口后，可保留原 generation 并交付；潜在写、失败或变化先 revoke 再释放，旧读由原 fence 拒绝。close/invalidate/其他 revoke 必须立即唤醒等待读，即使 claim 挂起。多个窗口、新窗口越过 resolved latch、原错误、Node readContext 与 Rust list 都须覆盖。旧列表前后探测、完整 DTO 与 scope 校验保持。
4. 新内部 `apps/desktop/src/main/core-host.ts` 抽取原 Core 入口的 Worker 创建和有限环境规则，默认入口仅调用零选项路径。可信同进程参数可转交已有 utility 第 7/8 参数；保持 Node 默认、Owner workerData 两键和原生命周期。无 env/父 startup/public IPC/Renderer 配置选择器，不改变公开合同。
5. 新隔离 Electron 私有入口和 wrapper 静态固定本轮二进制 pin/profile，使用同一生产 adapter、真实 Main/CoreSupervisor/utilityProcess、生产 Owner、原 preload/outbox 和实际打印 worker。配置来自可信编译源码；第二私有端口只供 narrow 控制/安全观察，不向 Renderer 交付能力或配置。外置独立构建输出与新合成 profile，不覆写默认 dist/安装应用/用户数据。
6. 真实 Electron 至少证明默认 Node 零 Rust/零私有导出，以及显式 Rust 的完整 Main 初始化、至少两次真实空 claim、原 preload 的 outbox 写入单次执行、写后 Node 回退、可信显式刷新、刷新后两次空 claim仍保留与 SQLite 列表深比较。补充受控生产 Main 组件场景：有效合成 pending print job、真实 claim 写租约使候选失效；renderer 可停在 render 边界，不能伪造 claim 或关闭后台轮询以取得绿灯。受控 Core 100/2,000/5,000 差分与真实 Electron 层分别记录。

## 并行文件范围

4 个子代理均明确 `gpt-6.1-sol/high`，不再派生。平台包括主代理最多四个活动槽，因此三个实现代理并行，第四个在释放名额后独审。

- 子代理 1（复用 rust007_mixed_reads）：`packages/bridge-core/src/rust-core/readonly-router.ts`、新 `packages/bridge-core/test/rust-readonly-main-boundary.test.ts`。并发屏障与条件空 claim 行为 RED/GREEN；旧 RUST-006/007 生命周期及实际测试原文保留；旧混合纯读闭集外样例仅将 context 替换为未准入的 current，原测试数/成功及 unknown/关闭后原回执和不重放断言不变。
- 子代理 2（新 rust008_desktop_adapter）：新 `apps/desktop/src/main/core-host.ts`、`core-entry.ts`、新 `apps/desktop/test/rust-core-host.test.ts`。共享 adapter、默认/可信准入和有限 Worker 规则。
- 子代理 3（复用 rust007_real_host）：新隔离 `apps/desktop/e2e/private-rust-*`、`e2e/rust-main-host.vite.config.ts`、`electron-gate/rust-main-host.test.ts`、`scripts/rust-main-host-gate.mjs` 及新 `apps/desktop/test/rust-core/runtime-main-background.test.ts`、`test/helpers/rust-main-background-utility.ts`、`test/helpers/rust-main-background-evidence.ts`。实际 Electron 和真实租约写验证，不修改生产 adapter/router；与子代理 2 协调窄类型。
- 子代理 4（rust007_independent_review）：只读独审与外置证据，不修改源码、不重复完整 Gate。

主代理负责 CI Gate、任务/合同/ADR、STATUS/TODO、外置环境、整合及完整验证、实现/报告独立提交。原 `native-output-device-package.test.ts` 的静态 Worker 断言由主代理跟随抽取移动至 core-host；保持原资源/入口保护含义，旧 RUST-006/007 生命周期及实际测试仍原文保留；主代理将 rust-readonly-node-reads 的闭集外 context 样例改为 collectionProgress.current，旧断言和两用例数不变，首次失败保留。

## 验证与交付

并发测试必须先在旧实现证明：claim 调用期间读不能提前公布，null 双版本一致后保留；真写/unknown/探测失败后拒绝旧读；invalidate/close 即时唤醒、多个窗口及迟到窗口不伤新代次。适当验证默认 adapter/非法准入；原 Node 回执/错误 identity、dispatch=1、计数平衡和零自动重放必须证明。

保留已有 22 步 Rust Gate 及 RUST-004 完整路径成本基线 RUN，增加本期行为与宿主步骤；真实 Electron 单列严格 Gate，不能把 Worker harness 或构建通过代替 Electron PASS。正常软件 typecheck/unit/build/control-plane/boundaries/cycles 及必要 mock-keychain 默认 Electron startup Gate。冻结源码后检查每步退出、完整日志、源/产物/二进制摘要和两轮必要审查；首个失败不得覆盖。所有构建、缓存、临时目录、日志在已确认外置卷，Node 22.x/pnpm 10.17.1/Rust 已安装固定版本。

Node 仍是唯一生产数据库作者和控制面；不接真实 Provider/Roon/凭据/播放/录音、真实用户库/迁移、系统钥匙串、安装签名/应用替换、远端 CI/push/发布/main merge。MBR-004 与 Gate B P4/P5 原 carryover 保留。报告分别记录 fake、实际 Core、受控 Main 组件、实际 Electron 与未执行验收，下一任务从最终报告 HEAD 接续。
