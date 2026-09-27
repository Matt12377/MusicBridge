# TASK-085 进行中外审检查点：V3 全功能正式产品

> 截至 2026-09-28，实现已提交、报告尚待提交；这是阶段外审检查点，不是 TASK-085 完成、正式输出可用或 Owner 验收声明。代码接线、定向测试、正式 Electron 合成流程、真实源/设备与交付 Gate 分层判断；逐项范围见 [63＋30 覆盖台账](TASK-085_COVERAGE.md)。

## 身份与证据位置

- 基线 HEAD：`05256eb867e37574e16f23eab877026a229a1703`；分支：`codex/task-085-v3-full-product`；实现提交：`bbc2f7baa40fd671f603aa37817ba6f9018d6ebf`（308 文件＝177 个既有文件改动＋131 个新增实现文件，报告编写时本地 HEAD）。主代理已逐文件核对工作树、暂存内容和实现清单 SHA 一致，提交前 `git diff --cached --check` 退出 0。报告提交：`null`（文件不自引用）；完成报告提交后，以 `git log -1 --format=%H -- reports/TASK-085_RESULT.md reports/TASK-085_COVERAGE.md` 解析包含两文件的报告提交完整 SHA，并核对该提交实际文件列表。
- 阶段外置 `MANIFEST.md`（路径见下）SHA-256 为 `552f7f48a17d462fd69496214b0a8638a5f0170ff2d6a8ac8f61781187fd307d`。修正版 `SOURCE_PATHS_IMPL.json` 定位 177 个已跟踪修改和 131 个未跟踪实现文件，逐文件 Hash 见 `SOURCE_FILE_SHA256_IMPL.md`；验证后采样 tracked diff Hash 为 `16137fa69ec3a793ab9a9a373570d3455e46ff1491f5a867a85b46db9cb62c82`（含 `.gitignore`），未跟踪实现文件 Hash 聚合为 `980a960b3b6b6b50f7c88cdafd1ea0ec2e854e5a17c6f5c823a0f1ebc4b0da81`。旧无 `_IMPL` 的清单误含 6 个 `apps/desktop/test-results/` 测试产物（含 `.last-run.json`），已作废；文件保留、未暂存或提交。这不是测试开始/结束或提交产物 Hash。
- 远端规范 URL：`https://github.com/Matt12377/music-bridge-for-roon`。实现已本地提交；远端 HEAD／push、CI 状态、报告身份、最终工作区清洁及下一分支基线均待主代理核验，不以本地提交推定已推送或 CI 通过。
- 开发包原 63 项和 MVP 30 项的输入 Hash 见 [任务定义](../tasks/TASK-085-v3-full-product.md)。覆盖台账保留全部 63＋30 行；“已有接线”或旧快照通过均不自动改成当前正式验收。
- 当前外置原始日志：`/Volumes/LifeWeave/Developer/CommandLine/tmp/task085-evidence-AcHUQA/`。历史取证另见 `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-task085-evidence-17UWuD/`、`mb-task085-j09-NfCIMY/` 和下表所列路径。它们仅在本机外置卷留存，**未上传为外审附件**；外审须取得原始日志/截图及可复跑入口。部分日志未自行记录完整 argv、起止源码指纹和退出码，不能只凭文件名证明最终快照。

## 当前结论

- 正式仓库已出现收藏单盘/预留、录音工作库、源候选、Logic ZIP、J-Card、多页打印、备份恢复等代码路径，但从源码存在到完整用户任务通过仍有距离。J03 Excel 导入/更正、J04 参考目录来源生命周期和普通表单合并/拆分、完整 Direct/Logic/PREP、执行/档案/恢复全链，在当前整合快照尚无一条覆盖入口、失败/返回、冷启持久性的正式 Electron 证据。J04 的资料参考图普通表单选择/移除已接线，不能再概称整段未接线。
- 数据库当前目标为 schema 30（`packages/bridge-core/src/collection/repository.ts`）。Record 普通分页已采用 SQL 搜索投影、只解析本页；冷开完整性审计仍核对投影（`packages/bridge-core/src/recording/record-page-index.ts`）。旧报告中的“schema 23”和“普通分页逐条解析全表”为过时判断；真实大库性能仍未测。
- 正式 runtime 已条件接入受信 Gate B 准入、原生设备 Attempt provider，以及只读核验/本机设备 Replica 输出（`packages/bridge-core/src/runtime.ts`）。未认证默认拒绝，合成默认拒绝不等于 Gate B 实证、设备录制或可听验收；不得再写成“admissionProvider 未注入／HAL 软件缺失／Replica 只有 synthetic”。Core `execute()` 的 `store.capture()` 位于后续资源收口 `try` 之外；preflight→Begin 库存漂移时 UI 保守保留 `pendingBegin`，typed 未受理与原命令恢复的活性问题仍是软件 carryover。
- 现有旧快照 Electron 切片覆盖过 J02/J06/J08 指定单盘、J05 商业逐件/关系、J09 ZIP 和 J13 PDF 的部分操作，但没有一项自动覆盖实现提交 `bbc2f7b…`。J13 固定失败 DB 的原请求重试是**测试 API 调用**，不是页面“重试”按钮证据；旧 schema 24/25 用例也不是当前 schema 30 验收。
- 未授权真实源、真实账号/Roon、Gate B、真实设备输出/听感、实体试印、安装/发布及 Owner 验收均为 `NOT_RUN`。旧冻结 078～084 容量窗口及 authority 不在本轮重放范围。

## 外审优先入口（代码路径，不替代行为证据）

| 问题 | 从哪里读起 |
| --- | --- |
| Begin/Stop、typed `ATTEMPT_NOT_ACCEPTED` 与回执不明边界 | `packages/bridge-core/src/recording/attempt-coordinator.ts`、`attempt-integrity.ts`、`apps/desktop/src/renderer/src/components/recording/recording-attempt-controller.ts`；IPC 映射在 `packages/bridge-core/src/utility-main.ts` |
| Replica 每段输入租期、末验及优先安全 Stop | `packages/bridge-core/src/recording/replica-device-session.ts`、`replica-device-output-provider.ts`；正式输出租期身份与撤销在 `output-run-lease.ts` |
| 冷启精确 revoke、持久软件静止事实与拒绝新输出 | `packages/bridge-core/src/recording/output-run-recovery.ts`、`output-run-barrier.ts`、`output-run-lease.ts`；缺 sidecar 不能单独证明静止 |
| 正式 App 两入口离开保护 | `apps/desktop/src/renderer/src/App.vue`、`composables/application/usePageJourney.ts`、`components/recording/RecordingView.vue`、`components/collection/CollectionView.vue` |
| 私有 E2E 注入与生产入口隔离 | `apps/desktop/e2e/private-core-main-wrapper.mjs`、`private-core.vite.config.ts`、`private-test-core-entry.ts`；生产入口 `apps/desktop/src/main/core-entry.ts`，测试 wrapper 不在正式 Main bundle 中 |

## 当前验证台账：实现提交与阶段证据边界

外置 `MANIFEST.md` 记录 Node `v22.23.2`、外置 `TMPDIR`、实际执行 argv、结果/退出码和各日志 SHA-256；实现 Hash 是验证后采样，未在每轮测试开始/结束时封存，不能倒推测试全程源码不变。提交前逐文件身份已核对到 `bbc2f7b…`，但提交本身不会让先前失败变绿，也不等于同一提交的完整构建/正式 App 回归。

| 范围与可复跑入口 | 外置日志／结果 | 源码身份与边界 |
| --- | --- | --- |
| Desktop `typecheck`（含 Contracts 预构建；各包 `package.json` 脚本） | Manifest 中 `desktop-typecheck-final.log` 退出 0，含 E2E TypeScript | 绑定上述采样时实现范围 Hash；不证明 Electron 操作。`desktop-typecheck-v2.log` 的先前失败另列下节 |
| Contracts `build`、Core `typecheck`/`build`、Desktop `build` | 当前目录 `contracts-build.log`、`core-typecheck.log`、`core-build.log`、`desktop-build.log`；前阶段执行记录各退出 0，Desktop 构建含 Preload 静态门禁 | 这些日志早于 Manifest 采样，未独立封存起止源码 Hash；不并作采样时构建或最终产物证据 |
| Control-plane、Boundaries、Cycles、Preload 依赖与 `project/` JSON 静态门禁 | Manifest 中 `control-plane-final.log`、`boundaries-final.log`、`cycles-final.log`、`preload-final.log`、`project-json-final.log` 均退出 0；Cycles PASS 336 files（日志 SHA-256 `3b073edc80de96b211383e0f3ab95aa11129dc1192e40ba6051e80c7c103f967`），Preload 仅 `require('electron')`，四份 JSON 解析通过 | 静态检查，不等于登录、播放、设备或 App 验收；各日志完整 SHA 与实际 argv 见 Manifest |
| Core 原生 runner／Formal 租约与冷启恢复／输出屏障／Attempt 单进程定向 | Manifest 中 `guard-attempt-final.log` 退出 0：101 tests、100 pass、0 fail、1 skip；其中冷启恢复 5/5 为合成验证 | 被跳过的 Core→Native 精确 DB/Sidecar 撤销测试需要受控 helper `MB_NATIVE_OUTPUT_HELPER_TEST_BINARY`，本轮未提供；无原生撤销端到端或真实设备证据 |
| Core Attempt IPC typed 未受理映射 | Manifest 中 `attempt-ipc-final.log` 退出 0、1 pass | 仅精确 IPC 映射的合成定向，非正式 Begin/Stop 全链或 UI 恢复验收 |
| Desktop Recording guard／Attempt panel 五文件单进程定向 | Manifest 中 `desktop-guard-attempt-final.log` 退出 0、84 pass、0 fail/skip；日志 SHA-256 `3e263adb45383c4c8fe07a69fbd626aa300fe973a1049eedb885180e82d78648` | 包含 `recording-record-panel`、`recording-workflow-integration`、`collection-return-navigation`、`page-journey-session`、`recording-attempt-panel`；仅组件/集成测试，不替代 074 Electron 全组三例 |
| `apps/desktop/e2e/task-074.spec.ts` 的默认拒绝单例；使用私有 Core 构建产物 | `private-core-build.log` 构建退出 0；`playwright-074-smoke.log` 1/1：默认拒绝、零新增、Outbox 不变、冷启不续播 | 该早期 smoke 未单独封存源码/产物 Hash 和完整 Playwright argv；这是合成默认拒绝，不是已获正式准入 |
| 同文件的三例正式 Electron 合成组 | 最新 `playwright-074-final.log`：退出 1，**1 通过、2 失败**；两例都在共享 `task-072-workflows.ts` 的 `getByLabel('本次媒体规划', { exact: true })` 等待嵌套 `select` 超时，尚未抵达 Attempt 面板的产品断言 | 这轮失败定位在测试上下文选择步骤；不能据此判定 Attempt 产品行为失败或通过。较早 `playwright-074-full.log` 的两种不同超时位置保留为历史，不替代最新记录；须修复定位/流程并重跑 |
| 旧 schema 迁移回归 | `legacy-migration-final.log`：退出 1、两例失败。schema 7 fixture 从当前 schema 30 筛选复制 DDL 构造旧库时即报 `no such table: main.recording_records`，未进入目标迁移；Preparation schema 8 失败注入后 `user_version===8` 已通过，随后因降级 fixture 遗留新增 ZIP 相关对象，查询得到 9 个匹配 `preparation_%` 的残留 schema 对象而预期 0 | 两例应先修正确旧库 fixture 后复测；不能据此声称生产迁移/回滚损坏，也不能称旧 schema 兼容已通过 |
| Attempt 面板定向组与跨页守卫组 | 先前工具回显曾有 30/30、22/22、26/26、5/5、2/2；`recording-attempt-panel-v5.log` 的 SHA-256 为 `c75fb9269e85a76ddfd5c6542245551e89d0d47faa695e39d72a6cd219998ad0` | 这些不是上述 Manifest 的采样组；前者日志未自记实际 argv/退出码，其余当时尚无统一落盘日志，只作过程线索，不计最终 Gate |

### 外审可复跑的本批实际 argv

下列命令摘自外置 Manifest 的已执行记录，省略 `set -o pipefail` 与保存日志的 `2>&1 | tee` 包装；不是建议另行运行过的变体。执行环境为 Node `v22.23.2`、pnpm `10.17.1`、已挂载可写的外置 `LifeWeave` 卷，`TMPDIR=/Volumes/LifeWeave/Developer/CommandLine/tmp`。074 定向命令依赖先前构建的正式/私有 Core 产物；本批未用 `--config` 或自定义 `--output`，默认 `apps/desktop/test-results/` 只作本机测试产物、不进入实现提交。

仓库根目录：

```bash
corepack pnpm@10.17.1 --filter @music-bridge/desktop run typecheck
node scripts/ci/verify-control-plane.mjs
node scripts/ci/verify-boundaries.mjs
node scripts/ci/verify-cycles.mjs
node apps/desktop/scripts/verify-preload-dependencies.mjs
node -e 'const fs = require("node:fs"); for (const p of process.argv.slice(1)) { JSON.parse(fs.readFileSync(p, "utf8")); process.stdout.write(`${p}: JSON_OK\n`) }' project/STATUS.json project/V3_OWNER_EVIDENCE_TEMPLATE.json project/V3_OWNER_ACCEPTANCE.json project/V3_ACCEPTANCE.json
git diff --check
```

在 `packages/bridge-core` 目录：

```bash
node --import tsx --test --test-concurrency=1 test/device-output-runner.test.ts test/output-run-lease.test.ts test/output-run-recovery.test.ts test/recording-output-run-barrier.test.ts test/recording-attempt.test.ts
node --import tsx --test --test-name-pattern='Attempt专用IPC要求原工作库身份' test/utility-ipc.test.ts
node --import tsx --test --test-concurrency=1 --test-name-pattern='版本迁移失败回滚|Preparation schema 8 迁移失败完整回滚' test/master-versions.test.ts test/preparation.test.ts
```

在 `apps/desktop` 目录：

```bash
node --import tsx --test --test-concurrency=1 test/recording-record-panel.test.ts test/recording-workflow-integration.test.ts test/collection-return-navigation.test.ts test/page-journey-session.test.ts test/recording-attempt-panel.test.ts
corepack pnpm@10.17.1 exec playwright test e2e/task-074.spec.ts --workers=1
```

## 历史失败与旧快照：保留但不外推

| 证据身份 | 当时结论 | 当前使用边界 |
| --- | --- | --- |
| 首条 J02/J06/J08 正式 Electron 合成切片 `e2e-first-07`，源码指纹 `e5f070c6…` | 1/1 通过；库存和两份草稿由公开 API seed，页面选目标、A/B 规划、预留、返回同盘与释放 | 只证指定实体预留闭环；入库/新建 UI、照片、Excel、真实源/设备及当前整合快照未证。此前 `-01`～`-06` 失败保留 |
| J05 `task085-j05-formal-electron-02`，源码指纹 `295754a4…` | 1/1、退出 0；页面发行/逐件、照片、关系更正/撤销及冷启；`-01` 失败保留 | 固定合成库，不是当前 schema 30 整合、真实账号或完整收藏验收 |
| J09 `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-task085-j09-NfCIMY/electron-01.log` | 1/1、退出 0；原生 ZIP 另存/预览/批准/拒写、原 WAV 字节比对、冷启历史、720 宽末尾真实点击及焦点。早先 `-06` 焦点失败、`-07` 窄窗点击超时均保留 | 前置草稿/源/库存/布局由 API seed；未知回执跨冷启、拒绝后恢复、完整 Logic WAV 导回/PREP 与当前整合快照未证 |
| J13 `task085-print-electron-01`、`task085-print-fixed-e2e-02`，以及 `task085-print-current-default-02`／`-fixed-01`，源码指纹 `0ad589f2…` | 原 `RENDER_FAILED` 固定 DB 与首次默认库失败未删除；修后 schema 24 复制库和 schema 25 默认库各 1/1，110×110／240×150 mm 各 3 页 PDF，共 12 页合成素材渲染目检 | 固定失败 DB 原请求经测试 API 重试，非页面按钮。两组各拦截合成封面请求 1 次，不称零网络/console；当前 schema 30、真实素材与实体试印未证 |
| 多盘及旧库迁移阶段 `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-task085-v3-PPqkgJ/` | 新行为/旧导出定向 7/7；较宽组 65/67，旧 schema 7 回归两处失败；另有路径工具退出 127 | 不删断言、不把当前 schema 号动态替换旧 fixture 后冒充兼容通过；后续状态须以新快照结果更新 |
| 当前证据目录 `desktop-typecheck-v2.log` | 先前退出 2：073/074 E2E fixture 缺 `outputSelection`；随后 `desktop-typecheck.log` 阶段退出 0 | 保留修复前失败；提交前 `desktop-typecheck-final.log` 另有退出 0，但不代替同提交全套回归 |
| 当前证据目录 `playwright-074-full.log` | 较早三例 1 通过、2 失败：当时分别等不到 Attempt panel 与“查看计划第 1 版”按钮 | 与最新 `playwright-074-final.log` 的共享上下文 `select` 超时不是同一失败位置；两轮均保留，不能合并成产品断言失败或全绿 |

## 尚未关闭的交付 Gate

1. 冻结同一源码快照和产物，补可外审的命令/环境/Hash/退出码/截图索引；修复并重跑 074 全组三例、受影响 071～077、完整类型/构建/静态 Gate 和必要的正式 Electron 合成链。历史通过不能替代该批回归。
2. 补 J03/J04/J09–J14 的完整页面入口、错误/返回、冷启与持久结果；尤其 J04 来源生命周期、J09 未知回执与拒绝恢复、J11 `pendingBegin` 活性、J13 页面重试按钮、J14 隔离恢复→明确激活及真实大库性能。对应未闭合项在覆盖台账维持“待证”。
3. Gate B、真实源/Roon、设备/听感、实体打印和 Owner 验收继续分别记 `NOT_RUN`，不得由合成数据或按钮状态推定。未确认回执只允许原命令明确重试，不新建绕过身份、不自动选 latest 或自动续录。
4. 实现提交已完成；报告提交仍为 `null`，须在提交后按上述 Git 命令解析。报告文件空白字符检查、最终工作区清洁、远端 HEAD／push、CI 状态和下一分支基线仍待分别核验；无关未跟踪 `worktree/` 原样保留。
