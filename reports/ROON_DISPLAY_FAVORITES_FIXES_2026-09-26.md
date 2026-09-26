# Roon Display 连接与播放收藏修复（2026-09-26）

## 身份与范围

- 工作树：`/Volumes/LifeWeave/VSCode/MusicBridge/worktree/v3-ui`；分支：`codex/roon-display-favorites-fixes`；base：`5c61cd5afe18b37a7f51cf587cc833cab052ffdf`。本轮验证的实现源码与夹具随后封存为下述实现提交；base 对应远端 `origin/codex/renderer-decoupling`。
- 本轮仅修 Roon Display 配置/增量消息和正在播放收藏切换，迁移对应的过期 E2E 夹具。未改公开 IPC 合同、产品导航或歌词显示策略。实现提交：`1daefda790c32948663dc76ddbf75fbe1fdc319e`；报告提交以包含本文件的提交为准，下一分支基线须取最终报告 HEAD，不与实现提交混同。报告与状态文件尚未提交时，不把工作树写成清洁或已推送。
- 原有未跟踪 `apps/desktop/test-results/`、`prototypes/metafine-study/` 保留，未纳入本轮。所有验证均使用外置 LifeWeave APFS 上的临时目录 `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-roondisplay-favorites-O7TMmd/`，Node 22.23.2、pnpm 10.17.1、单测试进程与 Playwright 单 worker。

## 改动和证据边界

- Display 配置操作与 `restore` 串行；写盘成功后的活动地址、返回设置和持久化地址保持一致。Core 停止时暂停连接而不取消排队配置；旧重连定时器不能夺回新配置；失败写盘保留最近的有效地址。连接的独立 session、sandbox、无 preload 和同服务网络限制保持不变。
- `zones_changed` 只有播放状态等增量字段时保留已知曲目及歌词；显式 `now_playing: null` 清词。非法曲目不污染已知区域；新增区域及完整快照缺曲目时不继承旧身份。协议层只投影公开曲目与 LRC，不转发 Web Display 的 key/token。
- 正在播放的“喜欢这首歌”按实际可用来源切换：仅网易云只写网易云，仅原生 Roon 只写本地收藏；双来源有一边未收藏先补齐，两边都已收藏才一起取消。未知/失败读数不猜方向；点击至多重读一次，失败写入后的重试重新读取真实状态；切曲、换来源或描述符替换使旧异步结果失效。
- Owner 已明确选择保留现有歌词显示。现有证据尚未验证 `LyricsChanged.key` 具有可关联当前曲目的语义；没有可靠上游身份时，本轮**不修复也不宣称修复**无已验证身份的迟到歌词可能附着于当前曲目的问题。该边界是已接受的本轮范围决定，不是等待回复；未据此发明字段或对真实歌词回放做替代性宣称。

## 上轮远端 E2E 与夹具迁移

[base 对应的 Electron E2E run #36232275521](https://github.com/Matt12377/MusicBridge/actions/runs/36232275521) 已完成、结论为 failure，HEAD 与本轮 base 相同；当时 Playwright 为 87 pass、6 fail、4 skip，构建和 Electron 启动等独立步骤成功。六处原始断言对应的当前 UI 证据与迁移如下；这些是旧 E2E 夹具差异，不能将上轮失败改写成通过，也没有证据归咎于 Renderer 解耦生产回归。

| 旧断言 | 当前证据与保留的行为断言 |
|---|---|
| 玻璃播放器只接受半透明背景 | 系统 `prefers-reduced-transparency: reduce` 下产品明确用不透明色；CDP 显式分别验证默认玻璃透明度/模糊/几何与浅深色无障碍不透明 fallback，不放宽原阈值。 |
| 旧主题色 `#f8eaf1/#b34f79` | 当前主题 token 为 `#f2edf1/#a84c72`，继续精确比对。 |
| 聚合搜索直接出现 TrackTable 更多操作 | 当前先显示六首预览，进入“单曲 → 查看全部”后再验证 TrackTable 操作与入队。 |
| 侧栏 `liked`/`playlists` 来源按钮 | 现行侧栏为“收藏”及可展开的网易云歌单；网易云喜欢和歌单页面仍经既有 `Meta+2/3` 入口验证。 |
| “播放 Synthetic Track 1”精确可访问名 | 当前预览按钮包含艺人，辅助夹具按完整可访问名定位，保留播放验证。 |
| 收藏入口“Roon 收藏”名称 | 当前明确为“收藏”，继续验证侧栏名称与路由。 |

本轮限定 E2E 首跑 13/15、exit 1：歌单 region 的非精确名称同时匹配主页“来自我的歌单”；折叠搜索按钮旧名称不再存在。精确定位后第二轮仍 13/15、exit 1：匿名主页有两个合法“打开设置”按钮，旧定位未限定侧栏；折叠宽度旧值 64px，当前样式与计算值均为 66px。仅迁移这四处夹具定位/精确尺寸，并把复用的诊断入口限定到侧栏；两项先单独走通 2/2，最后限定 15 项 15/15、exit 0。首次和第二次失败日志、error context 均独立保留，不删除行为断言或改生产 UI。

## 验证快照

以下日志均在上述外置任务目录的 `logs/` 下；命令退出码为本轮实际执行结果，不把合成数据等同真实账号、Roon 或 Owner 验收。

| 门禁 | 结果 | 日志 |
|---|---|---|
| Desktop 改动四文件定向单测 | 36/36，exit 0；连接测试使用标准 Node 22 入口，无 `--experimental-test-module-mocks` | `desktop-focused.log` |
| Desktop 全量单测 | 763/763，exit 0，`--test-concurrency=1` | `desktop-all.log` |
| Core Display 相关单测 | 11/11，exit 0；Core 生产源码本轮未改 | `core-display-focused.log` |
| 根级类型检查 | Contracts、Core、Desktop Vue 与 E2E TypeScript 均 exit 0 | `typecheck.log` |
| 最终 E2E 夹具类型复核 | 两处夹具收尾后单独 `tsc --noEmit -p tsconfig.e2e.json`，exit 0 | `e2e-typecheck-final.log` |
| 根级生产构建 | Contracts、Core、Desktop 串行均 exit 0 | `build.log` |
| 真实 Electron + loopback Display Gate | exit 0；实际隔离 BrowserWindow/WebSocket/Store，覆盖状态增量保词、显式空曲目清词、跨服务请求阻断、断连、自动重连、持久化、重启及停用 | `display-gate.log` |
| 受影响合成 Electron E2E | `--list` 选中 15 项、exit 0；最终 15/15、exit 0、`--workers=1`。含上轮六处失败覆盖、Display 设置、100 次进度、两个单来源 UI 收藏、导航和续播；不是全仓 E2E | `e2e-list.log`、`e2e-final.log` |
| E2E 夹具诊断 | 首轮 13/15、第二轮 13/15，均 exit 1；两项局部重验 2/2、exit 0 | `e2e-affected.log`、`e2e-affected-rerun.log`、`e2e-two.log` |
| 静态门禁 | control-plane、boundaries、cycles 均 exit 0；`CYCLES=PASS files=288` | `control-plane.log`、`boundaries.log`、`cycles.log` |

本轮没有运行默认并发的 `pnpm verify` 或全仓所有 Electron E2E；等效相关检查按上表串行执行。Contracts/Core 的类型和生产构建为本轮新鲜结果；Core 全量单测未重跑，base 报告中的旧全量数字不冒充本轮快照。Display Gate 是真实 Electron 隔离连接，但其服务端与歌词数据均为 loopback 合成夹具；Display 设置 E2E 则使用模拟 IPC，二者不能互相替代为真实 Roon 播放。

## 远端 CI（实现提交）

实现提交已 push，远端分支 HEAD 为 `1daefda790c32948663dc76ddbf75fbe1fdc319e`。以下 run 的 `headSha` 均为该实现提交，不是尚未产生的报告提交；它们和本地串行验证分别记录。

| Workflow | Run | 当前结论 |
|---|---|---|
| security | [36235829553](https://github.com/Matt12377/MusicBridge/actions/runs/36235829553) | success |
| verify | [36235829699](https://github.com/Matt12377/MusicBridge/actions/runs/36235829699) | success |
| electron-e2e | [36235829560](https://github.com/Matt12377/MusicBridge/actions/runs/36235829560) | 截至 2026-09-26 10:37 UTC 仍在运行；本报告不预写为通过 |

远端 Electron E2E 已按约定只读观察约八分钟，未触发重跑；其后续结论须按该 run 的实际完成状态另行核对，不倒填为本报告快照的成功。

## 本机 App 更新

Owner 已在本轮本地验证后另行授权更新本机 App；部署执行方独立交付以下证据，来源为实现提交 `1daefda790c32948663dc76ddbf75fbe1fdc319e`，不把部署归给尚未产生的报告提交。

| 检查 | 结果 |
|---|---|
| mac arm64 打包 | `electron-builder --mac --arm64 --dir --publish never`，exit 0；产物 `/Volumes/LifeWeave/Developer/CommandLine/tmp/musicbridge-local-install-eItHnr/package/mac-arm64/Music Bridge for Roon.app`。 |
| 包与安装版身份 | 两处 `Contents/Resources/app.asar` SHA-256 均为 `a13c7e7c08caaea15a3c9e8623e1359aed9405ed6d1046406ee894bab9c235ec`；两处 `codesign --verify --deep --strict` exit 0，ad-hoc 完整性签名，bundle id `com.musicbridge.roon`；不宣称公证。 |
| 替换与备份 | 原 App 在替换前无运行进程。旧版精确备份为 `/Volumes/LifeWeave/Developer/CommandLine/Backups/MusicBridge/2026-09-26-9leUJG/Music Bridge for Roon.app`，旧 app.asar SHA-256 `fb0e1bca67efaec3beb5a818183e94524b2f745936de91e7e272a89402c45a8d`；未删除，可供恢复。新安装目标 `/Applications/Music Bridge for Roon.app`。 |
| 包内与安装版隔离启动 | 两者均使用外置隔离 userData、mock keychain、合成 Core；`ready=true, markerSeen=true, closed=true, code=0`。日志分别为 `/Volumes/LifeWeave/Developer/CommandLine/tmp/musicbridge-local-install-eItHnr/packaged-startup.log`、`installed-startup.log`。 |
| 普通启动边界 | `open -a '/Applications/Music Bridge for Roon.app'` exit 0，主进程 PID 91432 及同路径 Helper/Renderer 子进程启动；LaunchServices 记录该 App 为 Foreground 且 check-in 成功。只读窗口查询对应用名和精确路径均超时，全局界面查询也超时；同期前台列有 `SecurityAgent`，但未读取内容，不能判定是否与超时有关。未确认主窗口实际显示或壳层就绪，未绕过系统提示、输入凭据或操作播放/登录。 |

隔离启动 Gate 证明可启动/退出的工程路径，普通 `open -a` 与进程存在证明启动尝试和进程存活；两者均不等于真实账号播放或 Owner 验收。

## Carryover 与交接

- 未用真实 Provider 账号、真实 Roon 或物理音频设备验证。安装版隔离合成启动通过，普通启动观察到进程与 LaunchServices check-in，但窗口查询超时，普通窗口/UI 与日常播放未确认；Owner 操作验收仍独立待办。本轮按 Owner 决定无需真实歌词回放/账号播放作为收口条件，不能把未运行写成通过。
- Roon Web Display 协议不是稳定公开歌词 API；无身份迟到歌词按上文保留现状。未来若要解决，需新的可信曲目身份或上游证据及另行授权。
- 实现提交已 push 且远端分支 HEAD 核对为 `1daefda790c32948663dc76ddbf75fbe1fdc319e`；远端 CI 结果另行按同一 SHA 记录，不能与本地 15/15 或未来报告 HEAD 混同。报告提交及其 push 各有独立身份，交付前应核对远端 HEAD 与最终工作区，再将最终报告 HEAD 作为下一分支基线。
