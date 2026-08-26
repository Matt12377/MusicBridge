# MusicBridge V1 / V2 集成分支真实环境稳定化结果

> 执行日期：2026-08-25 至 2026-08-26
> 工作树：`/Users/yihe/VSCode/MusicBridge/worktree/v1-v2-integration`
> 分支：`codex/v1-v2-integration`

## Gate 结论

| Gate | 结论 | 证据边界 |
|---|---|---|
| Automated / Synthetic Gate | **PASS** | 当前源码的 typecheck、unit、build、security、Electron、startup、E2E、控制面与边界检查均为新鲜 `exit 0` |
| Real Provider Gate | **PASS** | 真实网易云账号、真实搜索/播放/歌词/Pause/Resume/fallback/会话恢复 |
| Real Roon Engineering Gate | **PASS** | 真实 Dev Extension、Remote Core、Zone、Browse、Artwork、Native Play/Queue/Seek/Pause/Resume/Stop、Smart 与 reconnect |
| Owner 分项 Gate | **PASS** | Owner 已确认歌词听感“同步”，并参与真实 Zone、播放、Queue、Pause/Resume、Smart、导航与 reconnect 检查 |
| Owner Final Gate | **PASS** | 2026-08-26，Owner 针对当前 Final HEAD 的完整短验收明确回复 `Owner Final Gate PASS` |
| Merge to main | **BLOCKED** | 未获 Owner 合并授权；未 push、未创建 PR、未 merge、未修改 `main` |

本报告不使用“集成完成”或“没有其他问题”作为结论。当前准确表述是：**工程自动 Gate、真实 Provider Gate、真实 Roon Gate 和 Owner Final Gate 均已通过；由于没有 push、PR 或 merge 授权，合并到 `main` 继续阻塞。**

## A. Git 身份与边界

- 固定工作树：`/Users/yihe/VSCode/MusicBridge/worktree/v1-v2-integration`
- 分支：`codex/v1-v2-integration`
- 稳定化 Base SHA：`37d6d795b7efc73251446ba7aabdf9073b1abc57`
- P1-D 代码 HEAD：`f05a11d74e31290b2a76bdc6fffee557ea964eda`
- Final HEAD：本报告所在文档提交，交付时以 `git rev-parse HEAD` 为准
- 远端分支 HEAD：`37d6d795b7efc73251446ba7aabdf9073b1abc57`
- 远端状态：本地稳定化提交尚未 push
- 工作树保留项：`apps/desktop/test-results/` 为原有未跟踪测试产物，未清理、未暂存
- 外部操作：未 push、未创建 PR、未 merge、未修改 `main`、未修改 V1/V2 来源工作树
- 安全边界：没有增加 Delete、Remove from Library、Trash、`rm`、`unlink` 或任意 destructive Roon action；没有删除或移动任何本地音乐库文件

## B. 稳定化提交

| 阶段 | SHA | 标题 |
|---|---|---|
| P0-A | `3f82487214de682a65bfdb17bb0d080fdc136ccc` | `fix(roon): refresh and persist zones across dev-core lifecycle` |
| P0-B | `3033b1d151dc60e44956333ead057e0c7da1504f` | `fix(roon-library): preserve browse context and resolve real album tracks` |
| P0-C | `e3c48f571006e1dbf45043355613b37fd485e3e8` | `fix(roon-image): preserve binary payloads and cache decoded artwork` |
| P0-B follow-up | `752dfd2d30e4b80edf16a610cfd0ffae6acdf514` | `fix(roon-browse): exclude album actions from track drill-down` |
| P0-B follow-up | `644766d4cb89904e5b101b483fe3fe98d3758e71` | `fix(roon-browse): inherit album identity for tracks` |
| P0-D | `c664bea7258dfd382dc881269a93cee9285ecacd` | `fix(playback): confirm native transport state before updating UI` |
| P0-D | `9d3951c1821aa0d7dca63d2d63262d3fd07992dd` | `fix(desktop): bind playback UI to live Roon lifecycle` |
| P0-D support | `39121eb13477993408e49eda47dc77d16f70f862` | `fix(credentials): preserve vault on temporary core failure` |
| P0-D follow-up | `2bcaee79e1f18c1f5e2f42f8c3ccdef0050b0c58` | `fix(roon-library): replay track actions in fresh sessions` |
| P1-A | `05721ab916b20c2573c5a8cf78e9308c5d3d38e0` | `fix(matching): bound renderer smart match requests` |
| P1-A | `38eea9e6764570d942d39418bf904e0989c2dabb` | `fix(matching): resolve real Roon track identities` |
| P1-B | `5c7ea24f67bc74c9949addeeaa81b261a76b9acb` | `fix(lyrics): anchor line updates to confirmed playback position` |
| P1-C | `7293f1fe1e480971b2c2c15f377485ab6ef79023` | `perf(playback): reuse hydrated search metadata and trace startup latency` |
| P1-D | `f05a11d74e31290b2a76bdc6fffee557ea964eda` | `fix(ui): remove duplicate library navigation and expose real capability states` |

本报告另以独立 docs commit 提交，不与 P1-D 代码形成巨型混合提交。

## C. Root Cause Matrix

| Owner 问题 / 阶段 | 根因 | 修复 | 自动测试 | 真实 Gate |
|---|---|---|---|---|
| P0-A：设备列表为空、Core 后连接不刷新 | Zone 只在 App 初始化读取；Core/Remote ready 突发事件、旧响应和 disconnect 没有统一生命周期 | 建立 `core-disconnected/loading/empty/unselected/selected` 状态与 refresh coordinator；Core ready、`roon.changed`、Remote ready/reconnect 自动刷新，断连立即清空陈旧 Zone | PASS | PASS；`Studio Display` 自动出现、断连清空、重连自动恢复 |
| P0-B：专辑约 8000 首、实体漂移 | Album Drill Down 丢失原 Browse session/hierarchy；把根列表或中间层强制映射为 Track；运行期引用无稳定上下文 | 保存 Browse Context/path；只接受最终 Track shape；中间 Disc/Folder 继续下钻；分页和 Artist/Genre/Playlist 保留实体身份 | PASS | PASS；`0 (2024版)` 为 11 首，未回落到约 8491 项；真实 2CD 标签可见 |
| P0-C：封面破损 | JPEG 字节在 Core/Main/Preload/Renderer 均完整，真正失败点是 Renderer CSP 不允许 `blob:`，不是 CSS 尺寸 | 五层受控二进制诊断；MIME/magic 校验；允许 `blob:`；Core 二进制 LRU、Renderer Blob URL LRU、negative cache 与 revoke | PASS | PASS；同一 JPEG 五层一致，72 张真实卡片正常解码 |
| P0-D：Pause/Resume 乐观更新、进度假走 | UI 在 Roon 确认前进入 paused/playing；Zone/Track generation 不足；第二次 Track Action 复用已消费 Browse session | `playing → pausing → paused`、`paused → resuming → playing`；只在真实状态确认后推进；每次 Play/Queue 使用短生命周期 action session | PASS | PASS；暂停后进度固定，恢复后从真实位置继续；Queue Next 与 Stop 成功 |
| P1-A：Smart `INTERNAL_ERROR`、错误候选 | Renderer 同时发起过多 Browse；真实标题含 `7. ` 序号导致 `title-exact` 丢失；候选元数据不足 | 全局 Smart 调度并发 2、首屏预热 8、点击等待上限 300ms；Search Track Drill Down；拆分曲目序号与标题；动态 exact/possible/none | PASS | PASS；`归零 / 林忆莲` Confirmed 并走 ROON 本地；Possible/None 保持网易云 |
| P1-B：歌词跳动、暂停后漂移 | 行变化与逐字变化共用节流；Source/Zone/Pause/Resume 后 0ms 锚点没有完整重建 | 行变化立即发布；逐字更新有界节流；歌词跟随真实 playback generation/position；程序滚动与用户滚动分离 | PASS | PASS；5 首真实样本，Owner 确认“同步”，未增加固定 offset |
| P1-C：点击播放等待长、重复点击 | 搜索已取得的 Metadata 在播放 IPC 丢失；Core 重复取 metadata；UI pending 不同步 | 透传 hydrated metadata；缓存 256 条/5 分钟；独立 Provider 阶段并行；保留 Gateway preflight；同步“正在准备”并阻止重复点击；记录 8 阶段时间 | PASS | PASS；5 组真实播放均由 Roon 确认 playing |
| P1-D：重复导航、假按钮、错误泛化、点赞状态失败 | 内容区第二套分类与 Sidebar 双状态；Genre/Playlist 无 Drill Down；错误被压成 `NOT_READY/INTERNAL_ERROR`；Electron 丢失自定义 Error 属性；`song_like_check` 在真实环境不稳定 | 只保留 Sidebar；Genre → Albums/Tracks、Playlist → Tracks；公开错误码贯穿 Core/Main/Renderer；在受控 message 中保留错误码；like status 改用真实 likelist 并缓存 30 秒 | PASS | PASS；Jazz、26 首 Roon Playlist、Provider like status、断连提示、自动 reconnect 均实测 |

## D. Real Roon Evidence

### Core / Extension / Zone

- 真实 Remote Core：目标 `macmini`，远程端口 `38512`，本地 Gateway `127.0.0.1:38502`，健康检查为“可用”。
- 真实 Zone：`Studio Display`。
- Core 断开后，Settings 与 Bottom Player 同时清空陈旧 Zone，显示“Core 已断开”。
- Remote Core reconnect 后，当前流派页自动恢复真实列表；Zone 从“正在读取播放设备”自动变为“播放设备已选择”，没有手动点击刷新。
- 断连时真实 Electron IPC 页面显示“Roon Core 未连接”，不再落入统一的“暂时无法读取”。

### Browse / Album / Genre / Playlist

- `0 (2024版)`：真实 11 首曲目，没有出现约 8000 首全库误映射。
- 大库扫描覆盖约 8491 个运行期引用，没有发现 parse failure；普通 Album、Search、Artist、分页与返回导航均未回落到根列表。
- 真实 2CD 条目确认 CD1/CD2 标题；只从明确最终曲目标题投影 `discNumber`，不猜测任意中间列表。
- `Jazz` 流派首次实测捕获到“子流派摘要误当专辑”的真实失败；补 RED→GREEN 后仅保留 1 张真实专辑 `Heart and Soul (Bonus Track Version)`。
- 进入该专辑后显示 12 首真实曲目。
- 真实 Roon Playlist：`000-g.e.m.-the_best_of_2008-2012_(2nd_version)-2cd-cn-flac-2013`，首屏 24/26，加载更多后 26/26；header/action 项没有被映射为 Track。
- 从该歌单点击 `A.I.N.Y.` 后进入真实 ROON 本地 Now Playing，并由 Zone 确认播放。

### Artwork

- 真实样本：`contentType=image/jpeg`、`byteLength=26204`、前 8 字节 `ffd8ffe000104a46`。
- Roon callback → Bridge Core → Main IPC → Preload → Renderer 五层的 MIME、长度与 magic 一致；字节没有在 IPC 链路损坏。
- 72 张真实卡片可解码；返回页面与快速滚动没有观察到请求数继续增长。
- Album、Bottom Player、Now Playing、Queue 使用同一受控 artwork seam；破损图片进入 bounded fallback。

### Play / Queue / Pause / Resume / Seek / Stop

- Album 样本：`7. 歸零` 播放后 Queue Next `2. 太陽系`；随后 `2. 太陽系` 在 MusicBridge 与真实 Roon 中均成为当前播放曲目，Zone 为 `Studio Display`。
- 暂停后进度保持；恢复后从真实 Roon position 继续；Queue inspector 显示当前曲目与“接下来 0 首”。
- P1-B 对 ROON 本地 `归零` 覆盖 Seek、暂停约 10 秒、恢复与歌词滚动恢复。
- 本轮 P1-D 再次对 Smart `归零` 验证：播放到 0:23 后暂停，等待 3 秒进度无变化；恢复后进度前进到 0:32；随后通过停止 Remote Core 清理真实播放。
- Owner Final Gate 在 `d25246ba603f97f329e672bf97b3000e7ec21ec7` 上重新启动开发版并连接真实 Remote Core：`Studio Display` 自动恢复；`归零 / 林忆莲 / 0 (2024版)` 显示 `ROON 本地`并加载真实歌词；0:15 暂停后 3.2 秒保持不动，恢复确认后推进到 0:24，最终再次暂停在约 0:30 供 Owner 试听。

### Smart Matching

| 样本 | 真实结论 | 实际来源 |
|---|---|---|
| `归零` / 林忆莲 / `0 (2024版)` | Confirmed，UI 显示“Roon 已匹配” | ROON 本地 |
| `至少还有你` 的重复版本 | Possible，UI 显示“可能有本地版本” | 网易云，不强行选本地 |
| `GOT YOU (归零)` | None，无本地徽标 | 网易云 |
| `High High High (Live)` | Live 变体没有因标题相似而冒充 exact | 网易云 |
| `张学友 - 吻别(DjBin Electro Remix)` | Remix 变体保持真实 Provider 身份 | 网易云 |

P1-D 期间曾在旧运行期上下文中出现一次 `playback:replace-queue INTERNAL_ERROR`。停止并重连 Remote Core、让运行期引用失效、重新搜索后，同一 `归零 / 林忆莲` 样本稳定进入 ROON 本地 Now Playing。该旧上下文失败没有在干净 reconnect 路径或 Owner Final Gate 中复现；若后续再次复现，应重新阻塞 Smart Gate 并采集该次公开诊断。

## E. Real Provider Evidence

- 真实账号在多次 App/Bridge Core 重启后恢复到已登录状态；首页、账户资料与私有歌单重新可读，没有在聊天、命令或报告记录凭据。
- 搜索 `归零`，播放 Provider-only 首项 `归零 / 魔鬼花园（李安健）`：
  - 来源：网易云；
  - 真实音质：Lossless；
  - 时长：1:55；
  - 歌词：“纯音乐，请欣赏”；
  - Heart 状态可读，不再出现 `library:like-status INTERNAL_ERROR`；
  - 本轮只读验收没有执行点赞 mutation。
- Provider 曲目 Pause 后按钮变为“恢复播放”，进度保持；Resume 与歌词跟随已在 P1-B 多样本验证。
- 网易云 fallback：
  - Possible Smart 候选不强行走 Roon；
  - None 候选继续走 Provider；
  - Live、Remix 与本地不存在样本均保持真实版本身份。
- P1-B Provider 样本：`High High High (Live)`、`至少还有你`、`夜曲`、`后来`；连续快速切歌时歌词持续高亮，Owner 听感确认“同步”。

## F. Performance / Resource Evidence

| 项目 | 结果 |
|---|---|
| 播放阶段诊断 | 5 组真实播放 × 8 阶段完整序列 |
| 点击到 Roon Playing | median `505ms`；P95 `2922ms` |
| 主要等待 | Stream URL 与真实 Roon Playing 确认；没有删除 Gateway preflight |
| 准备态 | 点击后立即显示“正在准备”；重复播放按钮同步禁用 |
| Metadata cache | 默认 256 条、5 分钟；复播不重复取同一 metadata |
| Smart request | Renderer 全局并发 2，首屏预热 8，点击预算 300ms |
| Roon image Core cache | 128 项 / 32 MiB，LRU |
| Renderer artwork cache | 128 项；Blob URL lease/revoke；失败 negative cache 3 秒 |
| Reference 容量 | 65,536 个运行期引用；reconnect 清空旧 scope |
| 真实封面复访 | 72 张卡片返回/快速滚动没有观察到新增请求 |
| DOM | Album/Playlist 使用分页和既有有界列表，不一次渲染数千 Track |

本轮没有把 Renderer Heap、精确 Object URL 峰值或图片命中率百分比写成伪精确数字；当前证据是有界实现、单测、URL revoke 测试和真实复访请求不增长。若 Owner 要求发布级性能基线，应另做一次带 Instruments/Heap 快照的只读验收。

## G. Automated / Synthetic Tests

所有命令均在固定集成工作树、Node.js `v22.23.2`、pnpm `10.17.1` 下执行。Fake/synthetic 只证明合同和行为，不冒充真实 Provider/Roon。

| 命令 | Exit Code | 结果 |
|---|---:|---|
| `corepack pnpm@10.17.1 verify` | 0 | 三包 typecheck/build；Contracts 26/26、Bridge Core 316/316、Desktop 148/148 |
| `node scripts/ci/verify-control-plane.mjs` | 0 | `CONTROL_PLANE=PASS` |
| `node scripts/ci/verify-boundaries.mjs` | 0 | `BOUNDARIES=PASS` |
| `node scripts/ci/verify-cycles.mjs` | 0 | `CYCLES=PASS files=83` |
| `corepack pnpm@10.17.1 test:security` | 0 | 22/22 |
| `corepack pnpm@10.17.1 test:electron` | 0 | 4/4 |
| `node apps/desktop/scripts/startup-gate.mjs development` | 0 | `DESKTOP_STARTUP_PASS=development` |
| `node apps/desktop/scripts/startup-gate.mjs production` | 0 | `DESKTOP_STARTUP_PASS=production` |
| `playwright test --output=/tmp/musicbridge-p1d-e2e.AihJGl` | 0 | 19/19；axe 无 critical/serious；没有覆盖原有 `test-results` |
| `git diff --cached --check`（P1-D 代码提交前） | 0 | 无 whitespace error |

P1-D 的真实 Genre 子流派误映射与 Electron IPC 错误码丢失均先新增失败测试，再实施修复并转为 GREEN。

## H. Owner UI Gate 与可视证据

Owner 已经直接参与或观察以下分项：

- 真实 Zone 与设备选择；
- Native/Provider 播放；
- Queue Next；
- Pause/Resume；
- `归零` Smart；
- 歌词同步，并明确反馈“同步”；
- 单一 Sidebar 本地导航；
- Genre、Album、Roon Playlist 下钻；
- Remote Core stop/reconnect。

本轮通过真实 Electron 可访问性树和 live UI 完成证据采集，但没有把临时截图或录屏复制进 Git。Owner Final Gate 在验收基线 HEAD `d25246ba603f97f329e672bf97b3000e7ec21ec7` 上完成以下短验收：

1. 单一左侧本地导航；
2. 专辑封面与正确曲目数；
3. 设置页 `Studio Display`；
4. Roon Playlist 26/26；
5. Smart `归零`；
6. 歌词同步；
7. Pause/Resume；
8. Remote Core reconnect。

新鲜实机证据包括：Remote Core `已就绪`且健康检查`可用`、`Studio Display` 自动选中、Jazz 仅显示 1 张真实专辑且进入后为 12 首、Roon Playlist 完整加载 26/26、Smart `归零`进入 `ROON 本地`、歌词加载，以及 Pause 冻结/Resume 继续。Owner 随后明确回复：`Owner Final Gate PASS`。

## I. Remaining Issues

### 1. 一次旧运行期 Smart 失败未在干净 reconnect 后复现

- 证据：旧上下文出现一次 `playback:replace-queue INTERNAL_ERROR`；受控 stop/reconnect、重新搜索后 `归零 / 林忆莲` Confirmed 并真实播放成功。
- 影响：当前工程 Gate 与 Owner Final Gate 均不失败；后续若复现，必须重新阻塞 Smart Gate 并采集该次公开诊断。
- 建议：后续回归从干净 reconnect 和新搜索上下文开始播放 `归零`。
- 是否阻塞 main：**否**，当前干净 reconnect 与 Owner Final Gate 均未复现。
- 是否需 Owner 决策：否；复现时再升级。

### 2. 发布级性能快照不在本次源码稳定化证据内

- 真实限制：没有记录 Renderer Heap、精确 Object URL 峰值和图片命中率百分比。
- 影响：不影响已验证功能正确性；若要发布性能基线，证据仍不完整。
- 建议：发布前另做只读 Instruments/Heap 验收，不改变本阶段代码。
- 是否阻塞 main：**不阻塞本次稳定化 Gate**；是否成为发布前置由后续发布决策决定。
- 是否需 Owner 决策：仅在要求新增发布级性能基线时需要。

### 3. 发布与分发未执行

- 未部署、未签名/公证、未 push、未创建 PR、未 merge。
- Owner Final Gate PASS 不自动授予这些动作；它们仍不在当前授权内。
- 是否阻塞 main：**是，直到 Owner 明确授权**。

## 结论

**当前稳定化分支的 automated/synthetic Gate、real Provider Gate、real Roon Engineering Gate 和 Owner Final Gate 均 PASS。MERGE TO MAIN 仍因缺少明确 push/PR/merge 授权而 BLOCKED。没有 push、PR、merge，也没有 destructive library capability。**
