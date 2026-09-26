# Renderer 解耦与 Core 高频事件收敛（2026-09-26）

## 身份与范围

- 工作树：`worktree/v3-ui`；分支：`codex/renderer-decoupling`。
- Base：`77d05886888d0b9e9a9a8b90605097e8d0259de4`。起步时远端无同名分支；仅有原先未跟踪的 `apps/desktop/test-results/` 和 `prototypes/metafine-study/`，均保留且不纳入本次提交。
- 实现提交：`96e05737368149c21b0a2432b59aa7818fa8615b`；报告提交：以包含本报告的提交为准，避免文件自引用；下一分支基线：以该报告提交的最终 HEAD 为准。
- 边界决定：`docs/adr/ADR-037-renderer-session-boundaries-and-core-event-projection.md`。

## 改动边界

Renderer 将播放、聚合搜索、Roon 浏览、网易云资料和页面路径分别交由领域模块持有，`App.vue` 保留既有 UI 结构、视觉及主要导航语义；公开 IPC 字段和业务数据合同不变。Core 优化内部队列投影和无变化事件，歌词先判定是否应发布再复制。`playback.changed` 仍携带完整队列，本轮不宣称跨进程快照为常数成本。Core 或 Remote 不稳定时，私有资料请求会等待恢复，加载时机因此可能晚于旧版；登出、歌单切换和卸载后的旧响应不可回填。旧收藏描述符跨 IPC 的 Vue Proxy 克隆问题也在本轮修复，不能将本轮描述为绝对零行为变化。普通切页后的同歌单导航语义沿用旧版，本轮不宣称消除了所有导航竞态。

基线 `App.vue` 为 3,450 行，本轮抽取后为 1,186 行；缩减来自领域状态和流程迁移，不代表模板或样式重做。合成 Electron E2E 还揭出旧收藏描述符跨 IPC 的 Vue Proxy 克隆隐患，播放域在查询和切换收藏前投影为合同内纯标量 DTO；未增加公开 IPC 字段。

## 起步基线

测试使用 Node 22.23.2、pnpm 10.17.1，`--test-concurrency=1`。`/Volumes/LifeWeave` 已核对为挂载、可写的外置 APFS；临时与日志目录为 `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-decoupling-wngGCE/`。没有连接真实账号或 Roon。

| 检查 | 命令（在对应包目录） | 结果与耗时 | 日志 |
|---|---|---|---|
| Renderer 原单文件 | `node --import tsx --test --test-concurrency=1 test/renderer.test.ts`，`apps/desktop/` | 34/35，exit 1，real 0.32s；第 502 行旧静态正则断言失败 | `renderer-base-correct-cwd.log` |
| Core 定向四文件 | `node --import tsx --test --test-concurrency=1 test/runtime.test.ts test/controller.test.ts test/lyrics.test.ts test/roon-display-lyrics.test.ts`，`packages/bridge-core/` | 115/115，exit 0，real 1.39s | `core-focused-base.log` |
| Contracts 全部单测 | `node --import tsx --test --test-concurrency=1 test/*.test.ts`，`packages/contracts/` | 191/191，exit 0，real 3.25s | `contracts-all.log` |
| Core 全部单测 | `node --import tsx --test --test-concurrency=1 test/*.test.ts`，`packages/bridge-core/` | 1367 pass、0 fail、1 skip，exit 0，real 335.69s | `core-all.log` |

第一次 Renderer 命令误从仓库根执行，因相对 `src/renderer` 路径错误出现 35 个 ENOENT；完整保留于 `renderer-base.log`。这是验证命令工作目录错误，已从正确目录重跑，不计为产品失败。

Core 唯一 skip 是“实际固定 native binary 读取真实只读 WAV，消费 hash/2051 帧与 Core receipt 完全一致”；该用例要求显式 `MUSIC_BRIDGE_OUTPUT_NATIVE_GATE=1` 及本地固定 native 构建。普通单测通过不代表此原生 Gate 通过。

## 实现中与小修后快照

Core 代理随后修正 `queue.changed` 发布器：只有事件成功发出才记录已发布队列身份，避免回调抛错后漏掉下次重试。小修后四文件定向重验 112/112、exit 0，日志 `/Volumes/LifeWeave/Developer/CommandLine/tmp/musicbridge-core-focused-after-publisher-20260926.log`；`tsc -p tsconfig.test.json --noEmit` exit 0，日志 `/Volumes/LifeWeave/Developer/CommandLine/tmp/musicbridge-core-typecheck-after-publisher-20260926.log`。上面的 Core 全量属于这处小修之前的源码快照；小修后仅定向重验，不将旧全量结果冒充新快照的完整回归。

Renderer 静态合同已按实际模块所有者迁移，保留 `App.vue` 装配和 UI 断言。当前 Node 22.23.2 定向执行 35/35、exit 0，日志 `renderer-migrated-first.log`。`useNeteaseLibrary` 的认证事件、登出旧响应、同/异歌单切换、Core/Remote 切换与卸载轮询定向 6/6、exit 0；当前日志 `netease-library-session-current.log`，交付方独立日志 `/Volumes/LifeWeave/Developer/CommandLine/tmp/musicbridge-netease-library-session-20260926.log` 也已核实为 6/6、exit 0。Desktop 的 `vue-tsc --noEmit -p tsconfig.json` 与 `tsc --noEmit -p tsconfig.e2e.json` 当前均 exit 0，日志分别为 `desktop-vue-typecheck-prebuild.log` 和 `desktop-e2e-typecheck-prebuild.log`。以上均是实现中的定向证据，不代替最终完整验证。

Renderer/网易云/页面路径/生命周期五文件定向 48/48、exit 0，日志 `desktop-focused-final.log`。Desktop 全量首跑 735 pass、4 fail、exit 1（`desktop-all-final.log`）：三处旧 `startup-readiness.test.ts` 静态断言仍假定认证与资料请求内联于 `App.vue`，一处 `recording-workflow-integration.test.ts` 夹具只提取简单 `currentView` 声明，无法识别新 `PageJourney` 解构。验证文件迁移后，录音夹具实例化真实 `usePageJourney` 并走 `navigateSource`；三文件定向 53/53、exit 0（`desktop-test-migrations-focused-r2.log`），Desktop 全量重验 739/739、exit 0（`desktop-all-final-r2.log`）。随后只收窄启动断言的函数截取边界，单文件 4/4、exit 0（`startup-readiness-final.log`）。未通过删除行为断言消除首次失败。

这一快照的最终 Desktop `vue-tsc` 与 E2E `tsc` 均 exit 0，日志 `desktop-vue-typecheck-final.log`、`desktop-e2e-typecheck-final.log`；`corepack pnpm@10.17.1 run build`（Desktop prebuild Contracts + Electron-Vite production）exit 0，日志 `desktop-production-build-final.log`。这些均在下面的旧收藏 IPC 边界最小修复之前，修复后仍须对相应门禁重验。

## 合成通知与负载计数

当前 Core 发布器的定向测试以初始队列加 100 次合成位置更新输入，观察到 `playback.changed` 共 101 次、`queue.changed` 共 1 次；再追加队列和移动索引，队列通知共 3 次。控制器测试对 100 次重复位置回报计数，播放通知 100、队列投影重建 0（首次订阅独立计数）；歌词测试对稳定位置的 100 次更新计数，正文深拷贝 0。这些是 Core 内部合成行为测试，不是 Electron IPC 实测。

`scripts/ci/measure-renderer-decoupling-payload.mjs` 固定构造公开 DTO、初始队列已发布、随后 100 次仅位置变化，测得 JSON 负载字节如下。旧策略次数按 base 源码“每次播放通知同时发布队列”推导，新策略次数由当前发布器测试约束；合计仍是模型，不能换算为实际吞吐或帧率。

| 合成队列长度 | 单次 `queue.changed` JSON 字节 | 100 次 `playback.changed` JSON 字节 | 旧策略模型总字节 | 不变队列新策略模型总字节 |
|---:|---:|---:|---:|---:|
| 120 | 27,846 | 2,816,792 | 5,601,392 | 2,816,792 |
| 1,197 | 277,908 | 27,822,992 | 55,613,792 | 27,822,992 |

两种模型下 `playback.changed` 都保留完整队列；下降的是额外 `queue.changed` 的重复发送。模型日志为外置 `payload-model.json.log`，exit 0。

中间实现快照的 `verify-control-plane.mjs`、`verify-boundaries.mjs`、`verify-cycles.mjs` 均 exit 0；当时 cycles 扫描 287 文件。日志分别为 `control-plane.log`、`boundaries.log`、`cycles-intermediate.log`。最终源码门禁见下节，不用此中间结果代替。

## Electron E2E 与最终门禁

`apps/desktop/e2e/v1-ui.spec.ts` 的新增同曲 100 次进度用例检查网易云歌词/喜欢读取不重复、进度/封面/按钮能力仍更新、Roon 本地收藏读取不重复且可操作，以及 `lyrics.changed(B)` 先于 Roon 播放快照时新歌词保留。首次单独执行在 Roon 收藏读数处失败（`e2e-progress-final.log`）。排查证明合成 Roon 队列操作已到达、页面已显示 Roon 曲目与新歌词，`favorites:check` 仅收到先前 album 描述符，未收到 track；在同一隔离 Renderer 中，普通描述符可通过 preload，而 Proxy 描述符报 `Error: An object could not be cloned.`（`e2e-progress-diagnostic-4.log`）。基线 `App.vue` 已将深 `ref.value` 直接传收藏 IPC，此为旧隐患被本次真实行为回归揭出，不是解耦新引入。播放域已做最小 plain DTO 修复，新增 `structuredClone` 行为测试；诊断探针未留在正式 E2E，真实 track 读写断言保留。

受影响 E2E 的 `--grep` 选中 20 项，已用 `--list` 验证（`e2e-affected-list.log`，exit 0）；涵盖 Roon 浏览/歌词/续播、Core/Remote 生命周期、账号、搜索/歌单/队列、导航和新增进度。plain DTO 修复后的首轮为 18/20、exit 1（`e2e-affected-post-favorite-fix.log`）：过期登录页同时有侧栏和推荐区两个合法“打开设置”按钮，旧夹具未限定容器；导航用例旧断言要求主页标题，但既有搜索保留语义实际恢复原 `synthetic` 查询与结果。仅迁移测试定位和语义断言，保留登录过期、重新扫码、播放 IPC 零变更、曲目、队列及 Zone 断言，不改生产导航。两项定向重验 2/2、exit 0（`e2e-two-test-assertion-migration.log`）；20 项受影响 E2E 串行重验 20/20、exit 0（`e2e-affected-after-assertion-migration.log`）。

最小修复及断言迁移后的最终验证，以下未注明绝对路径的日志均位于 `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-decoupling-wngGCE/`；各命令使用 Node 22.23.2、pnpm 10.17.1 和外置临时目录，测试单进程执行：

| 门禁 | 最终结果 | 日志 |
|---|---|---|
| Desktop 相关定向单测 | 67/67，exit 0 | `desktop-focused-post-favorite-fix.log` |
| Desktop 全量单测 | 740/740，exit 0 | `desktop-all-post-favorite-fix.log` |
| Contracts 全量单测 | 191/191，exit 0；本轮 Contracts 源码未修改 | `contracts-all.log` |
| Core 全量与小修后定向 | 全量 1,367 pass、1 skip、exit 0 为发布器重试小修前快照；小修后定向 112/112、exit 0，不冒充小修后全量 | `core-all.log`；`/Volumes/LifeWeave/Developer/CommandLine/tmp/musicbridge-core-focused-after-publisher-20260926.log` |
| Contracts、Core 类型检查 | 各自 exit 0 | `contracts-typecheck-final.log`、`core-typecheck-final.log` |
| Desktop Vue、E2E 类型检查 | Vue 与 E2E 各 exit 0；断言迁移后 E2E `tsc` 再次 exit 0 | `desktop-vue-typecheck-post-favorite-fix.log`、`desktop-e2e-typecheck-post-favorite-fix.log`、`desktop-e2e-tsc-final.log`（末项无诊断输出） |
| Contracts、Core、Desktop 生产构建 | 三包串行，各 exit 0 | `contracts-build-final.log`、`core-build-final.log`、`desktop-build-post-favorite-fix.log` |
| 受影响 Electron 合成 E2E | 20/20，exit 0，`--workers=1` | `e2e-affected-after-assertion-migration.log` |
| Control plane、boundaries、cycles | 均 exit 0；`CONTROL_PLANE=PASS`、`BOUNDARIES=PASS`、`CYCLES=PASS files=288` | `control-plane-final.log`、`boundaries-final.log`、`cycles-final.log` |
| `git diff --check` | 报告与 STATUS 更新后复核，exit 0 | 命令退出状态 |

没有直接运行默认并发的 `pnpm verify`；各包与受影响 E2E 采用串行门禁。本轮没有完整重跑发布器小修后的 Core 全量，也没有运行全仓所有 Electron E2E。

## 证据边界与 carryover

本轮自动验证已覆盖上述范围；尚无真实播放、安装版操作、物理设备或 Owner 验收结论。本报告快照形成时 GitHub push 与远端 CI 均未执行，远端 HEAD 待主任务交付时核对；不预写后续结果。合成 E2E 和通知次数不能代替真实帧率与听感。旧 Roon Display 审计的配置竞态、迟到歌词附着和 `zones_changed` 清词风险继续作为 P1/P2 carryover，不借本轮解耦标记为已修复；真实 Roon 自然续播复测同样保留。

另有一项旧逻辑静态观察：`resolveFavoriteToggle` 只有在传入的网易云与本地状态都为 `true` 时才返回取消。当实际上只有一个来源可用时，不可用来源仍以 `false` 参与计算，重复点击可能继续发送收藏而非取消；不可用来源本身不会发起写入。两来源都可用、但仅一处已收藏时，补齐另一处是另一种既有策略，不应与前述单来源可用情形混同。本轮未做真实账号的单来源取消收藏操作，也未扩修此旧逻辑，不能声称完整取消收藏行为已验收。
