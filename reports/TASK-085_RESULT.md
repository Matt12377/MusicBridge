# TASK-085 进行中增量外审检查点：V3 全功能正式产品

> 截至 2026-09-28，首推实现 `bbc2f7b…` 与首份报告 `5edd878…` 已推送，七文件增量代码 `2ab45fa…` 已本地提交、增量报告提交仍为 `null`。本检查点不是 TASK-085 完成、正式输出可用或 Owner 验收声明。代码接线、定向测试、正式 Electron 合成流程、真实源/设备与交付 Gate 分层判断；逐项范围见 [63＋30 覆盖台账](TASK-085_COVERAGE.md)。

## 身份与证据位置

- 基线 HEAD：`05256eb867e37574e16f23eab877026a229a1703`；分支：`codex/task-085-v3-full-product`；首推实现提交：`bbc2f7baa40fd671f603aa37817ba6f9018d6ebf`（308 文件＝177 个既有文件改动＋131 个新增实现文件）；首份报告提交：`5edd878010594c7daabc3e5f9eeb1c9d2b87a237`。七文件增量代码提交：`2ab45fa919513f512edc9cf3c5800c23779ad0f9`，其父提交为首份报告。增量报告提交：`null`（文件不自引用）；提交后以 `git log -1 --format=%H -- reports/TASK-085_RESULT.md reports/TASK-085_COVERAGE.md` 解析并核对实际文件列表。下一任务基线须取最终增量报告提交 HEAD，不能预填 `2ab45fa…`。
- 阶段外置 `MANIFEST.md`（路径见下）SHA-256 为 `552f7f48a17d462fd69496214b0a8638a5f0170ff2d6a8ac8f61781187fd307d`。修正版 `SOURCE_PATHS_IMPL.json` 定位 177 个已跟踪修改和 131 个未跟踪实现文件，逐文件 Hash 见 `SOURCE_FILE_SHA256_IMPL.md`；验证后采样 tracked diff Hash 为 `16137fa69ec3a793ab9a9a373570d3455e46ff1491f5a867a85b46db9cb62c82`（含 `.gitignore`），未跟踪实现文件 Hash 聚合为 `980a960b3b6b6b50f7c88cdafd1ea0ec2e854e5a17c6f5c823a0f1ebc4b0da81`。旧无 `_IMPL` 的清单误含 6 个 `apps/desktop/test-results/` 测试产物（含 `.last-run.json`），已作废；文件保留、未暂存或提交。这不是测试开始/结束或提交产物 Hash。
- 远端规范 URL：`https://github.com/Matt12377/MusicBridge`（本轮只修报告表述，不改 Git remote 配置）。2026-09-28 增量报告编写时只读 `git ls-remote`：任务远端仍为 `5edd878…`、`main` 仍为 `05256eb…`；七文件增量 `2ab45fa…` 未推送，增量报告提交、远端 CI、最终工作区清洁和下一分支基线分别待核验。首推已推送不等于增量已推送。
- 开发包原 63 项和 MVP 30 项的输入 Hash 见 [任务定义](../tasks/TASK-085-v3-full-product.md)。覆盖台账保留全部 63＋30 行；“已有接线”或旧快照通过均不自动改成当前正式验收。
- 首推外置原始日志位于 `/Volumes/LifeWeave/Developer/CommandLine/tmp/task085-evidence-AcHUQA/`；增量日志分布于 `task085-j11-QHipt8/`、`task085-legacy-8tjSD6/`、`task085-ui-v88PoC/`。更早历史取证另见 `mb-task085-evidence-17UWuD/`、`mb-task085-j09-NfCIMY/`。这些目录均在本机外置卷，**未上传为外审附件**；外审须取得原始日志/截图及可复跑入口。只有下文逐项列明的 Hash、argv 和退出码可用，不能只凭文件名证明最终快照。

## 当前结论

- 增量快照 `2ab45fa…` 已完成 J11 四新例 4/4、Attempt 整文件 78/78、旧 schema 7/8 定向 2/2 及两文件完整 36/36、显式 `--lease-revoke` 无设备原生租约 1/1；同一新构建产物的 074 Electron 合成三例 3/3、受影响 072/073 合成组 4 pass＋3 原生 Gate 条件 skip。正式构建、Preload 门禁和最终 E2E TypeScript 检查退出 0。上述是本地增量证据，不是全套 `verify`、Gate B、HAL/真实设备或 Owner 验收。
- 首推 `5edd878…` 的远端 `verify` run `36333174562` 已失败：Contracts 208/208，Core 1543 项中 1497 pass、44 fail、2 skip，Desktop 未运行。44 项按首个可见症状分为旧目标 schema 断言 17、`INVENTORY_UNAVAILABLE` 13、Formal 拒绝预期 3、旧迁移/回滚 fixture 3、旧事实比较 2、Attempt 备份 `IO_ERROR` 1、容量 3、Replica `INVALID_TRANSITION` 2；这只是日志诊断，不是根因裁定，不能从本地聚焦通过自动扣减。增量 `2ab45fa…` 在报告编写时尚未远端验证。首推安全 run `36333174547` 通过。Electron run `36333174505` 在 2026-09-28 00:48（上海）只读查询仍为 `in_progress`，随后完成为 `failure`：启动/崩溃恢复/safeStorage Gate 步骤成功，失败步骤是生产构建的 Playwright E2E，摘要为 51 pass、48 fail、4 skip；这些是首推 SHA 的远端结果，不能套到增量代码。
- 正式仓库已出现收藏单盘/预留、录音工作库、源候选、Logic ZIP、J-Card、多页打印、备份恢复等代码路径，但从源码存在到完整用户任务通过仍有距离。J03 Excel 导入/更正、J04 参考目录来源生命周期和普通表单合并/拆分、完整 Direct/Logic/PREP、执行/档案/恢复全链，在当前整合快照尚无一条覆盖入口、失败/返回、冷启持久性的正式 Electron 证据。J04 的资料参考图普通表单选择/移除已接线，不能再概称整段未接线。
- 数据库当前目标为 schema 30（`packages/bridge-core/src/collection/repository.ts`）。Record 普通分页已采用 SQL 搜索投影、只解析本页；冷开完整性审计仍核对投影（`packages/bridge-core/src/recording/record-page-index.ts`）。旧报告中的“schema 23”和“普通分页逐条解析全表”为过时判断；真实大库性能仍未测。
- 正式 runtime 已条件接入受信 Gate B 准入、原生设备 Attempt provider，以及只读核验/本机设备 Replica 输出（`packages/bridge-core/src/runtime.ts`）。未认证默认拒绝，合成默认拒绝不等于 Gate B 实证、设备录制或可听验收；不得再写成“admissionProvider 未注入／HAL 软件缺失／Replica 只有 synthetic”。七文件增量已为 Core 首次 `store.capture()` 失败增加 fresh receipt 复核：只有可信零受理且资源已收口时才明确释放 Begin 身份；读取不明保留原命令未知态，迟到持久回执返回最新事实，B 面不冒充首面未受理。四新例及 Attempt 整文件已通过；这只收口该可复现活性分支，不代替其他 Begin/Stop 竞态、正式设备或 Gate B 验收。
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

## 首推阶段验证台账：实现提交与当时证据边界

下表保留首推 `5edd878…` 报告写成时的状态，后续红转绿与新增证据单列在下一节；不可把旧表的 074 1/3 或迁移失败当成增量最新结论，也不可删去失败历史。外置 `MANIFEST.md` 记录 Node `v22.23.2`、外置 `TMPDIR`、实际执行 argv、结果/退出码和各日志 SHA-256；实现 Hash 是验证后采样，未在每轮测试开始/结束时封存，不能倒推测试全程源码不变。提交前逐文件身份已核对到 `bbc2f7b…`，但提交本身不会让先前失败变绿，也不等于同一提交的完整构建/正式 App 回归。

| 范围与可复跑入口 | 外置日志／结果 | 源码身份与边界 |
| --- | --- | --- |
| Desktop `typecheck`（含 Contracts 预构建；各包 `package.json` 脚本） | Manifest 中 `desktop-typecheck-final.log` 退出 0，含 E2E TypeScript | 绑定上述采样时实现范围 Hash；不证明 Electron 操作。`desktop-typecheck-v2.log` 的先前失败另列下节 |
| Contracts `build`、Core `typecheck`/`build`、Desktop `build` | 当前目录 `contracts-build.log`、`core-typecheck.log`、`core-build.log`、`desktop-build.log`；前阶段执行记录各退出 0，Desktop 构建含 Preload 静态门禁 | 这些日志早于 Manifest 采样，未独立封存起止源码 Hash；不并作采样时构建或最终产物证据 |
| Control-plane、Boundaries、Cycles、Preload 依赖与 `project/` JSON 静态门禁 | Manifest 中 `control-plane-final.log`、`boundaries-final.log`、`cycles-final.log`、`preload-final.log`、`project-json-final.log` 均退出 0；Cycles PASS 336 files（日志 SHA-256 `3b073edc80de96b211383e0f3ab95aa11129dc1192e40ba6051e80c7c103f967`），Preload 仅 `require('electron')`，四份 JSON 解析通过 | 静态检查，不等于登录、播放、设备或 App 验收；各日志完整 SHA 与实际 argv 见 Manifest |
| Core 原生 runner／Formal 租约与冷启恢复／输出屏障／Attempt 单进程定向 | Manifest 中 `guard-attempt-final.log` 退出 0：101 tests、100 pass、0 fail、1 skip；其中冷启恢复 5/5 为合成验证 | 被跳过的 Core→Native 精确 DB/Sidecar 撤销测试需要受控 helper `MB_NATIVE_OUTPUT_HELPER_TEST_BINARY`，本轮未提供；无原生撤销端到端或真实设备证据 |
| Core Attempt IPC typed 未受理映射 | Manifest 中 `attempt-ipc-final.log` 退出 0、1 pass | 仅精确 IPC 映射的合成定向，非正式 Begin/Stop 全链或 UI 恢复验收 |
| Desktop Recording guard／Attempt panel 五文件单进程定向 | Manifest 中 `desktop-guard-attempt-final.log` 退出 0、84 pass、0 fail/skip；日志 SHA-256 `3e263adb45383c4c8fe07a69fbd626aa300fe973a1049eedb885180e82d78648` | 包含 `recording-record-panel`、`recording-workflow-integration`、`collection-return-navigation`、`page-journey-session`、`recording-attempt-panel`；仅组件/集成测试，不替代 074 Electron 全组三例 |
| `apps/desktop/e2e/task-074.spec.ts` 的默认拒绝单例；使用私有 Core 构建产物 | `private-core-build.log` 构建退出 0；`playwright-074-smoke.log` 1/1：默认拒绝、零新增、Outbox 不变、冷启不续播 | 该早期 smoke 未单独封存源码/产物 Hash 和完整 Playwright argv；这是合成默认拒绝，不是已获正式准入 |
| 同文件的三例正式 Electron 合成组 | 当时最后一轮 `playwright-074-final.log`：退出 1，**1 通过、2 失败**；两例都在共享 `task-072-workflows.ts` 的 `getByLabel('本次媒体规划', { exact: true })` 等待嵌套 `select` 超时，尚未抵达 Attempt 面板的产品断言 | 该轮失败定位在测试上下文选择步骤；不能据此判定 Attempt 产品行为失败或通过。较早 `playwright-074-full.log` 的两种不同超时位置保留为历史；后续修复和 3/3 见增量节 |
| 旧 schema 迁移回归 | `legacy-migration-final.log`：退出 1、两例失败。schema 7 fixture 从当前 schema 30 筛选复制 DDL 构造旧库时即报 `no such table: main.recording_records`，未进入目标迁移；Preparation schema 8 失败注入后 `user_version===8` 已通过，随后因降级 fixture 遗留新增 ZIP 相关对象，查询得到 9 个匹配 `preparation_%` 的残留 schema 对象而预期 0 | 当时不能据此声称生产迁移/回滚损坏，也不能称旧 schema 兼容已通过；修正历史 fixture 后的 2/2 与 36/36 另见增量节 |
| Attempt 面板定向组与跨页守卫组 | 先前工具回显曾有 30/30、22/22、26/26、5/5、2/2；`recording-attempt-panel-v5.log` 的 SHA-256 为 `c75fb9269e85a76ddfd5c6542245551e89d0d47faa695e39d72a6cd219998ad0` | 这些不是上述 Manifest 的采样组；前者日志未自记实际 argv/退出码，其余当时尚无统一落盘日志，只作过程线索，不计最终 Gate |

## 七文件增量检查点：新鲜本地验证与失败保留

增量代码提交为 `2ab45fa919513f512edc9cf3c5800c23779ad0f9`，相对首推报告 `5edd878…` 仅修改七个源码/测试文件。运行 Node `v22.23.2`、pnpm `10.17.1`，外置卷已确认挂载可写；E2E/构建与旧迁移测试的 `TMPDIR=/Volumes/LifeWeave/Developer/CommandLine/tmp`，J11 Core 的 `TMPDIR=/Volumes/LifeWeave/Developer/CommandLine/tmp/task085-j11-QHipt8`，均在外置卷；`DEV_BUILD_ROOT=/Volumes/LifeWeave/Developer/CommandLine`、`DEV_CACHE_ROOT`／`XDG_CACHE_HOME=/Volumes/LifeWeave/Developer/CommandLine/Caches` 在适用命令中显式设置。J11 日志由 shell 重定向保存，其余本代理日志由 `set -o pipefail` 加 `2>&1 | tee` 保存；列出的退出码来自对应工具记录。命令按目录说明实际 argv，不把旧 `dist` 或未执行的建议命令算作本批结果。

| 工作目录、实际 argv | 退出码与结果 | 原始日志及 SHA-256 |
| --- | --- | --- |
| `packages/bridge-core`：`node --import tsx --test --test-name-pattern='J11：' test/recording-attempt.test.ts`；随后 `node --import tsx --test test/recording-attempt.test.ts`；`./node_modules/.bin/tsc -p tsconfig.test.json --noEmit` | 依次 0、四新例 4/4；0、Attempt 整文件 78/78；0、测试类型检查。执行时显式 `env TMPDIR=/Volumes/LifeWeave/Developer/CommandLine/tmp/task085-j11-QHipt8 DEV_BUILD_ROOT=/Volumes/LifeWeave/Developer/CommandLine DEV_CACHE_ROOT=/Volumes/LifeWeave/Developer/CommandLine/Caches` | `/Volumes/LifeWeave/Developer/CommandLine/tmp/task085-j11-QHipt8/j11-green-negative.log`：`309a444bb6c4f5cd28b4316aae12e2bfb291016654976c502d4026758738eac7`；`j11-full-attempt.log`：`d9a1478d46be8ad1bf3f4a66c4a8fb8a21e096bd76491bf2bf1eab2f991e6b59`；`j11-typecheck.log`：空文件 SHA `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `packages/bridge-core`：`node --import tsx --test --test-name-pattern='版本迁移失败\|Preparation schema 8 迁移失败' test/master-versions.test.ts test/preparation.test.ts`；随后 `node --import tsx --test test/master-versions.test.ts test/preparation.test.ts`；`node_modules/.bin/tsc -p tsconfig.test.json --noEmit` | 依次 0、2/2；0、36/36；0、测试类型检查。首推旧 fixture 两失败保留为原快照历史 | `/Volumes/LifeWeave/Developer/CommandLine/tmp/task085-legacy-8tjSD6/focused-verified.log`：`e7ddb230e9f112ee84dd49d5ea9af53672be78f2c719f3caaaf3a8bb50d1126d`；`/Volumes/LifeWeave/Developer/CommandLine/tmp/task085-ui-v88PoC/legacy-two-files.log`：`00366d4e88211b2510b2ec2567b854983f515710080f816c459f5186b9dae27d`；`task085-legacy-8tjSD6/typecheck.log`：空文件 SHA `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `packages/bridge-core`：`MB_NATIVE_OUTPUT_HELPER_TEST_BINARY=/Volumes/LifeWeave/VSCode/MusicBridge/apps/desktop/native/output-device/darwin-arm64/bin/output-device-helper node --import tsx --test test/output-run-lease.test.ts` | 0；1/1、0 skip。只调用 `--lease-revoke`，在 HAL 构造前返回；仅精确 DB/Sidecar 身份与不可逆墓碑，不枚举/驱动设备 | `/Volumes/LifeWeave/Developer/CommandLine/tmp/task085-ui-v88PoC/native-lease-verified.log`：`06d2fcf469b9b326a034e07049f34fa3ca10526d9c7a3cf537fe836ca74b1062` |
| 仓库根：`corepack pnpm@10.17.1 run build`；`corepack pnpm@10.17.1 --filter @music-bridge/desktop run typecheck` | 各 0；Contracts→Core→Desktop 顺序重建，Desktop postbuild Preload 仅静态 `require('electron')` 1 处；Desktop 含 Vue 与 E2E TypeScript。构建不证明 App 操作 | `/Volumes/LifeWeave/Developer/CommandLine/tmp/task085-ui-v88PoC/unified-build.log`：`268ddbec6e2c5a415a488a8b49d604e1682d3e82a2b6657cec5633bd19bb1696`；`desktop-typecheck.log`：`c78efddca48282cf8df696055f825fb0297de8ade8591861f8c4865f5e6047db` |
| `apps/desktop`：`corepack pnpm@10.17.1 exec electron-vite build --config e2e/private-core.vite.config.ts --mode development`；最终测试源码后 `./node_modules/.bin/tsc --noEmit -p tsconfig.e2e.json` | 各 0；私有 Core 单独产出于 `.tmp-test/private-core`，不写正式 `dist/main`；最终 E2E 类型检查空输出但退出 0 | `/Volumes/LifeWeave/Developer/CommandLine/tmp/task085-ui-v88PoC/private-core-build.log`：`6957da1749e164908f252253588ed4740991bb7776ab20df120ba1f48eee4950`；`e2e-final-typecheck.log`：空文件 SHA `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `apps/desktop`：`corepack pnpm@10.17.1 exec playwright test e2e/task-074.spec.ts --workers=1 --output=/Volumes/LifeWeave/Developer/CommandLine/tmp/task085-ui-v88PoC/e2e-074-results`；修复测试可见性/精确 checkbox 后相同 argv，仅输出改为 `e2e-074-rerun-results` | 依次 1（1 pass、2 新断言失败），0（3/3）。首次新失败是未选 Plan 时按钮不存在、两个 checkbox 定位歧义；未改生产 Vue/controller，也未削弱后续三层事实断言。首推时更早的共享 `select` 超时同样保留 | `/Volumes/LifeWeave/Developer/CommandLine/tmp/task085-ui-v88PoC/e2e-074.log`：`aa45c4ae809b07c7f4e7f3a5f1b1e26cab12276e9bc3369e0a3c11fa397a0fff`；`e2e-074-rerun.log`：`9560755cf9164354e8f579549baecbce285b2abb1b1e11f370af0bd5c2e53980` |
| `apps/desktop`：`corepack pnpm@10.17.1 exec playwright test e2e/task-072.spec.ts e2e/task-073.spec.ts --workers=1 --output=/Volumes/LifeWeave/Developer/CommandLine/tmp/task085-ui-v88PoC/e2e-072-073-results` | 0；7 项中 4 pass、3 因 `MUSIC_BRIDGE_OUTPUT_NATIVE_GATE` 未启用按原条件 skip；不等于原生 Gate 通过 | `/Volumes/LifeWeave/Developer/CommandLine/tmp/task085-ui-v88PoC/e2e-072-073.log`：`51b37c9b6d8ae64355846a7cd4374ed53772a8fdc3627b47287a38a0cf07408e` |

起止身份的边界：J11 `attempt-coordinator.ts` SHA-256 `2ab947147b91d88b572e803fbccb55a5fb6146939d61694de1df2ada93baac7e`、`recording-attempt.test.ts` `2dda11e874bbb91742665c627d8f4cc592fb7ecc4bd6a95847a4cb6319bac468`，原执行者在四例聚焦测试前后采样相同；78 项整文件没有独立起止全树或两文件 Hash 记录，不能从四例外推。旧 schema helper／两测试的定向测试起止分别为 `3bd793f82d50414d92b513c6dc377047e2a5b10ad3fdf9849fd0996d9e09bca7`、`5bf051ab706ff422f2ad51ebf5a2cae78442f87b8c53d5ff081ff3044529879c`、`6bf1b4c26e71603a60af77ddb439bacb695c2de8ce5e637a52097948be43dca0`，对应 `task085-legacy-8tjSD6/source-start.sha256`／`source-end.sha256` 比较相同；36 项整文件前后另在本代理工作中采样到相同三文件 SHA，但不代表起止全树身份。原生测试前后 helper `07c05fe9ee06260f3cf5da380f08c3bf2f41eec344028dd3d6eba6dcaccee020`、`output-run-lease.ts` `41e1bcf2e832a0337b71f5e5c53da3adc97cf3b3c5d20967f8aa67f317ce4162`、测试 `a332ddd4fe4fb011c487e948f0de3337384df30c6699cd262896372a3a1dbd6c` 相同。只读包检查的 22 源文件汇总 SHA `3728ce0d9dc4f5a29e837e6674f5858da84c7fdf1102cb5f91a14b426f45a411`、manifest `2c51f3ef77d61194424391ce1d4f9f8886e9a3f325088ea7ccd372d426264a20` 与 helper 匹配，`candidate:null` 是脏工作树不授予正式设备候选，并非包哈希失败。

J11 的可归因 RED→GREEN 另保留：`packages/bridge-core` 中 `node --import tsx --test --test-name-pattern='J11：预检后库存漂移' test/recording-attempt.test.ts` 初始退出 1、0/1，`j11-red.log` SHA `619974972e37156fbdd9f7028a757973175e04d9a725d5067aa936bdd69b8171`；修复后同 argv 退出 0、1/1，`j11-green-focused.log` SHA `4a2c7eba82308438ca215a2324077a96c99f5708813347809896804479bcfbcd`。RED 的 coordinator/test 两文件起止 SHA 分别为 `ae5b840976ac565bf4c346e573bc184fde8fa48e149e468c455ef4a4673fa89a`／`53ff95b8ff02de04a5acda72579a42c30dec9be6b48373ba4a0f372bea67e24b`；GREEN 同例为 coordinator `2ab947…`、test `53ff95…`；再补三例后的 4/4 才使用上段 `2ab947…`／`2dda11e…`。这些都是对应两文件的起止取样，没有记录整树起止 Hash，不能将后来的 Git 提交号倒写成 RED 当时的工作树身份。

E2E 共用 helper `task-072-workflows.ts` 在重建及测试前后 SHA `d965c957d57cde0c3dce184379f6bc26166b5492e37ccb2364dba25ac13056f2`；074 测试首次复跑时 SHA `ee02c8d91e895fd6da8b326720b94e2585639fbb497554e04e17cff4b1b2e211`，受控修正后为 `caa6d13685d593b0214ef454d3e9d5fe82f6a70547ce8254fe90be74406f77b0`。本轮重建后的正式 Main `797077a52bd4b088c491a096bcee55111156cbe5406361cbf4b236a7950985b7`、Preload `ea3da968f24062954f7e4390156ecc50ef36af36e7c55a7981029d44bdcc5958`、私有 `full-core.js` `0dc7f1c5b47eb841fb7fd76c6b85598f5ac06d48ca36126942988e116c026a91`、`plan-core.js` `2d7db49b6014b3744cda5894f690385aa6c8f70d67e66503eac77c1c282841d0` 均在构建后、074 测试前及各 E2E 结束后采样一致；这些是**构建后至测试后**身份，不冒称构建前后全树 Hash。最终当前源码与七文件增量提交经主代理另行核对，不倒填为首推 CI 的身份。

074 最新截图位于 `/Volumes/LifeWeave/Developer/CommandLine/tmp/task085-ui-v88PoC/e2e-074-rerun-results/`：`task-074-V3正式Attempt面板明确Plan后才读历史，窄窗与错误不伪造空历史或正式准入/` 下有 `attempt-empty-720.png`、`attempt-error-720.png`；`task-074-V3受控历史显示保留中断与三层事实，人工实体停止不伪造软件成功/` 下有 `attempt-interrupted-720.png`、`attempt-facts-720.png`、`attempt-side-720.png`、`attempt-facts-1440.png` 和 `synthetic-history-evidence.json`。074 首例经正式 IPC 验证未认证默认拒绝、零新增/Outbox 不变与冷启不续播；另两例只证 Main 注入下的 UI 历史/错误和三层事实。截图中的 720px 下半部被浮动播放器覆盖；overflow/axe 与所见视口不能证明所有末尾动作可点击，完整窄窗交互与 V2 回归仍待证。

首推 Electron 远端最终身份：run [`36333174505`](https://github.com/Matt12377/MusicBridge/actions/runs/36333174505)、job `108658904499` 均 `completed/failure`，提交 `5edd878010594c7daabc3e5f9eeb1c9d2b87a237`。只读下载的失败步骤日志 `/Volumes/LifeWeave/Developer/CommandLine/tmp/task085-ui-v88PoC/remote-electron-failed.log`，SHA-256 `c10312eee010564b8268f3c7cb6850470890a85664e681170563f03d6ac75f16`；可见的 Playwright 汇总为 48 failed、4 skipped、51 passed（22.3 分钟）。失败输出含多处控件定位/页面关闭错误及 `TASK-085 E2E 必须显式使用外置 LifeWeave TMPDIR`、外置路径 `mkdtemp` 的 `ENOENT`；仅列日志症状，不把混合失败归为单一根因，也未在远端重跑、取消或修改 CI。当前本地增量通过与该首推远端失败并列保留。

### 首推外审可复跑的当时实际 argv

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
| 首推证据目录 `playwright-074-full.log` | 较早三例 1 通过、2 失败：当时分别等不到 Attempt panel 与“查看计划第 1 版”按钮 | 与当时最后一轮 `playwright-074-final.log` 的共享上下文 `select` 超时不是同一失败位置；两轮均保留，不能合并成产品断言失败或全绿 |

## 尚未关闭的交付 Gate

1. 增量已冻结受影响源码与同一 E2E 产物、补命令/环境/局部起止 Hash/退出码/截图索引，074 全组三例及 072/073 合成切片已复跑；但未跑完 071、075～077、完整 `verify`、全套静态 Gate 与正式 Electron 业务链。首推远端 `verify` 的 44 fail 仍待逐类新鲜验证，不因本地聚焦通过自动清零；增量提交也尚未远端 CI。
2. 补 J03/J04/J09–J14 的完整页面入口、错误/返回、冷启与持久结果；尤其 J04 来源生命周期、J09 未知回执与拒绝恢复、J11 除可信零受理/资源静止以外的 Begin/Stop 竞态、J13 页面重试按钮、J14 隔离恢复→明确激活及真实大库性能。对应未闭合项在覆盖台账维持“待证”。
3. Gate B、真实源/Roon、设备/听感、实体打印和 Owner 验收继续分别记 `NOT_RUN`，不得由合成数据或按钮状态推定。未确认回执只允许原命令明确重试，不新建绕过身份、不自动选 latest 或自动续录。
4. 首推实现与报告已提交/推送；七文件增量代码已本地提交，增量报告提交仍为 `null`，须在提交后按上述 Git 命令解析。六文件的 `project/STATUS.json` JSON、`project/WAVE-5.yaml` YAML、63＋30 原编号、Markdown 表格列数、control-plane 与 `git diff --check` 均已静态检查通过；这些不代替构建或全套测试。报告编写时增量报告提交、最终工作区清洁、增量远端 HEAD／push、增量 CI 状态和下一分支基线仍待主代理提交后分别核验；无关未跟踪 `apps/desktop/test-results/`、`worktree/` 原样保留。未合并 `main`，未安装或发布。
