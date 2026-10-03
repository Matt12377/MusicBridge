# RUST-014 — 普通用户可选 Rust 查询与刷新

Owner 已授权持续开发、全部决策和测试由代理完成。从 RUST-013 最终报告 `e35ad579ef276075d09d0b52fc6bb8158c418b26` 接续，分支 `codex/rust-core-014-user-optional-readonly-controls`，工作树 `worktree/rust-core-014`，外置证据 `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-014-w08_nmgh`。14 个原工作树、7 个未提交文件保留。本期由三个 sol6.1/high 作者并行、第四角色随后独审，主代理整合；用户规则覆盖旧三/max，平台最多三个同时活动的子代理，不再派生。

普通应用提供“设置 → 应用 → Rust 收藏查询”可选开关（默认关闭）和始终可见的“刷新库存”。正常 Main、固定 core.js、空 args、原公有 bootstrap、preload 和业务控件接入新闭集 API；用户只选择 boolean，不接收或提供资源路径、pin、profile、dataset/epoch、端口或内部状态。

唯一原 Node Owner 先完成 prepare/boot，再借用只读 router。开关启用失败不关闭 Node；库存仍由原持久 outbox 和唯一 Node 作者保存。关闭/失效先撤销旧读发布权，再等待真实 Rust 收口。失败请求不透明重投，异常/未知 Rust 关闭后本 Core 不再创建新 Rust，确认整 Core 退出后的新代际才解除。默认关闭零资源解析、快照导出和 Rust 创建。冻结细节见 [合同](../docs/contracts/RUST-014_USER_OPTIONAL_READONLY_V1.md) 与 ADR-051。

## 文件分工

- A（Core）：新增 `packages/bridge-core/src/rust-core/optional-readonly-manager.ts` 和生命周期/实际进程测试；`apps/desktop/src/main/core-entry.ts`、`core-host.ts`、新 `collection-readonly-core-bridge.ts` / `collection-readonly-control-protocol.ts` 及对应测试。仅必要时修改原 router/sidecar/utility，先报告具体依据；保留强启动组合与原 Node 作者实现。为 C 被动观察保留可信同进程 hooks，不从 IPC 选择能力。
- B（Main/界面）：新 `collection-readonly-settings.ts`、`collection-readonly-control-client.ts`，`src/main/index.ts` 原可信 IPC/生命周期最小接点；新公共类型/验证器、preload 固定绑定、`useCollection.ts`、`CollectionView.vue`、`settings/SettingsView.vue` 和新设置组件及对应行为/安全测试。Main boolean 原子持久化和代际围栏；不修改原四个 outbox 业务源文件。不修改 Core/A 协议文件。
- C（受控验证）：新 `collection-readonly-core-observer.ts`、`collection-readonly-main-probe.ts`、`collection-readonly-dom-driver.ts`、`scripts/collection-readonly-runtime.mjs/.d.mts`、严格证据助手及对应测试。只在编译诊断 true 且原合成环境准入后生效；原 DOM 驱动仅点击普通开关/刷新/入库/保护控件，不调用 API/store/handler/controller。无私有诊断刷新，无凭据恢复新旁路。
- 主代理：任务/合同/ADR/STATUS/TODO/索引，固定 Rust 资源构建捕获与签前准入、正常 Vite 和打包配置、默认 false 诊断定义/旧配置兼容、新 Gate；实际签名包/SQLite/普通 CUA、完整软件、适当 Rust 回归和双提交/最终身份。
- 第四角色：最多两轮独审，不改源码，不重复构建/App；审查原问题与最终证据，主代理闭合。

## 门禁与边界

1. 原 Node 作者 boot/close 恰一次，默认 OFF 零 Rust 工厂/探测/导出/spawn；实际 Rust 启停、写后失效、刷新、并发迟到围栏与原回执通过。
2. 公共/私有闭集、可信主窗口、boolean 持久化坏文件/失败/连续切换、旧 Core/nonce/回复拒绝及 UI 原分页/筛选/详情不回跳。
3. 四份静态签名包 default-node / node-controls / rust-controls / pin-rejected，正常固定入口，实际原控件与普通 API。原 outbox 单写、独立关闭 SQLite 与持久 ON/OFF 同包冷启；错误 pin 本期是可选失败，Node 保持可用，不能套用013“无作者”的旧预期。
4. 诊断被动观察、固定 DOM 工程驱动和普通 CUA 分层。代理完成适当真实 UI 操作；不冒称 Owner、真实账号/Roon/音频/录音验收。
5. 新鲜源/包/清单/ASAR/Fuse/签名及完整软件六步、必要旧故障/真实二进制回归。Rust 源码未变可复用013实际 unsigned 编译输入，重新签包并如实绑定，不声称新编译。
6. 独立实现、报告提交及自动 Gate；最终 source/Git/blob、clean/remote、原14worktree/7WIP保持，下一任务从本期最终报告HEAD开始。

本期不迁移真实库或更改业务库写入所有权、不安装替换、不 push/发布、不连接真实账号/Roon或操作真实播放/录音。范围和热点/相邻领域/持久化兼容及其他架构继续按各自证据推进，本期完成不代表总迁移完成。
