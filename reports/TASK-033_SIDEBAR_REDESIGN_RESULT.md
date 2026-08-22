# TASK-033 结果报告：Apple Music source sidebar v2.0

## 任务身份

- 任务：TASK-033 — Apple Music style source sidebar redesign
- 规范文件：`MusicBridge_AppleMusic_Sidebar_Redesign_v2.0.md`
- 基线分支：`codex/task-033-ui-reference-adaptation`
- 基线 SHA：`e9448bdd0a1fc0963904819336760c934a9141fe`
- 工作分支：`codex/task-033-apple-music-ui`
- 第一实现提交：`591a9320a8f0ab15853d44f9a50158ba31b4397c` — `refactor: replace dashboard navigation with music source sidebar`
- 第二实现提交：`2a0eb15f47a92b527bab74b50ab6efc01000a75a` — `feat: add dynamic playlists and sidebar account controls`
- 测试提交：`6ccd7e123e7baf768aae5234af9c1852b5a0ab7e` — `test: verify Apple Music style source navigation`
- 报告提交信息：`docs: record TASK-033 Apple Music sidebar redesign result`；最终提交身份由 `project/STATUS.json` 的 `reportCommit` 记录。
- 本次延续调整：当前工作区未提交、未 push，已构建并打开正常 Electron 窗口供 Owner 验收。
- 未创建 PR、未合并、未 push、未 force-push、未发布 release。

## 实现摘要

- 删除旧的 `AppSidebar.vue` 与七项同级后台导航模型；Renderer 只保留 Music Source Sidebar 的固定入口：发现/主页、资料库/我喜欢的音乐、资料库/所有歌单。
- 新建 `components/sidebar/` 组件组：品牌栏、常驻搜索、分组来源行、动态歌单行/列表、Zone 选择器和 Zone Popover；本轮移除旧的侧栏账户按钮、账户菜单与 `useAccountMenu`，账户入口统一收敛到 Toolbar 连接状态抽屉。
- 搜索框固定在侧栏顶部，支持 `⌘L` 聚焦、Esc 清空并恢复输入前的 source；Search 不再是侧栏导航项。
- 通过既有公开 `getUserPlaylists()` 读取真实歌单，支持 4 行 skeleton、局部错误重试、真实封面、基于歌单名的稳定渐变 fallback、24×24 封面、长名称截断和滚动位置恢复；没有添加艺人、专辑、最近添加或创建歌单假入口。
- 收起状态固定为 64px rail；动态歌单通过“歌单”浮层访问；展开偏好只保存非敏感 UI 状态。完整侧栏在 248px，窄窗口在 220px。
- 播放区改为跨窗口的底部全局播放横条；Zone 选择器位于播放横条上方，侧栏底部不再承载设备或账户行。
- Core、Roon、网易云和当前播放设备从 Toolbar 状态 Popover 查看；网易云状态行可点击进入 Settings，未登录时自动进入扫码 waiting 状态；顶部不再永久展示技术状态卡片或第二个搜索框。
- Now Playing、Lyrics、Queue、Settings、Diagnostics 均不再出现在侧栏；Now Playing 通过底部播放器进入，Lyrics/Queue 通过底部播放器入口进入，Settings/Diagnostics 通过 Toolbar 连接抽屉进入。没有改变既有播放、队列、歌词或 IPC 语义。

## 入口映射

| 旧入口 | v2 入口 |
|---|---|
| Search | 侧栏常驻搜索框、`⌘L` |
| Library | “我喜欢的音乐”“所有歌单”和动态歌单 |
| Now Playing | 底部播放器封面/标题 |
| Lyrics | 底部播放器歌词入口 |
| Queue | 底部播放器队列入口 |
| Settings | Toolbar 状态 Popover → 网易云 |
| Diagnostics | Toolbar 状态 Popover → 打开诊断 |

## 自动验证

| 命令/检查 | 退出码 | 结果 |
|---|---:|---|
| `node --import tsx --test apps/desktop/test/renderer.test.ts` | 0 | PASS，Renderer 约束 5/5 |
| `corepack pnpm@10.17.1 --filter @music-bridge/desktop typecheck` | 0 | PASS |
| `corepack pnpm@10.17.1 --filter @music-bridge/desktop build` | 0 | PASS，production Electron bundle |
| `corepack pnpm@10.17.1 --filter @music-bridge/desktop exec playwright test e2e/v1-ui.spec.ts` | 0 | PASS，packaged Electron Playwright 6/6；axe critical/serious 为 0 |
| `corepack pnpm@10.17.1 --filter @music-bridge/desktop test` | 0 | PASS，44/44 |
| `corepack pnpm@10.17.1 verify` | 0 | PASS；workspace typecheck、contracts 17/17、bridge-core 156/156、desktop 44/44、production build（本轮复跑） |
| `node scripts/ci/verify-control-plane.mjs` | 0 | `CONTROL_PLANE=PASS` |
| `node scripts/ci/verify-boundaries.mjs` | 0 | `BOUNDARIES=PASS` |
| `git diff --check` | 0 | PASS |

## UI / 可访问性 Gate

- 已验证旧七项在 `音乐来源` nav 中不存在；Search、Now Playing、Queue、Settings、Diagnostics 没有作为一级侧栏行出现。
- 已验证动态 `Synthetic Playlist` 进入对应歌单详情；搜索框、`⌘L`、Esc source 恢复、`⌘1/⌘2/⌘3`、`⌘\`、`⌘⇧L`、`⌘⇧Q`、Toolbar 连接抽屉、网易云设置入口、底部 Zone Popover 和 64px rail。
- 已验证 `app-footer` 横跨侧栏与主内容区，播放设备选择器位于全局播放横条上方；连接状态入口在窄窗口下仍保持右上角位置。
- 侧栏使用 `nav`、真实 button、`aria-current="page"`、可见 focus ring、收起态 aria-label/title；歌单封面使用 `alt=""`，名称由文字提供。
- 已验证合成启动、Roon disconnected/ready、未选择 Zone、Provider missing 等公开状态不会把内部错误码、凭据或会话资料暴露到侧栏或报告。
- 合成截图：`/tmp/musicbridge-task-033-home.png`、`/tmp/musicbridge-task-033-sidebar-720.png`。截图仅使用测试 Core，不代表真实 Provider、真实 Roon 或 Owner 听感验收。

## 边界与未执行事项

- 本轮新增改动只涉及 Renderer、Renderer E2E/静态测试和任务报告；`apps/desktop/src/main`、`apps/desktop/src/preload`、`packages/contracts` 未改。工作区中既有的 `packages/bridge-core/src/runtime.ts` 用户改动予以保留，未在本轮触碰，未改 typed IPC、Roon、Provider、播放语义或安全边界。
- 未读取、配置或输出真实 Provider 凭据、Cookie、Token、账号资料、完整 URL、Roon session/Zone 标识；CI 和 E2E 只使用合成数据。
- 未执行真实 Provider 登录、真实 Roon 播放、Core Mac 部署、Owner 听感、真实设备截图或 Owner acceptance；这些保持为 Owner-only Gate。
- 附件末尾列出的主内容、底部播放器、右侧 Inspector 和 Now Playing 的完整 v2 后续规范不在本次侧栏 slice 内；本轮只切换其入口归属，不重写既有播放语义。

## 结论

**PASS WITH ACCEPTED OWNER-ONLY CARRYOVER**

TASK-033 的唯一 Music Source Sidebar、动态歌单、全窗口底部播放横条、播放横条上方 Zone 选择、Toolbar 网易云设置入口、Toolbar 状态 Popover、Renderer 安全隔离、自动化与可访问性 Gate 已通过。真实 Provider/Roon 与后续 Inspector/Now Playing 细化按明确边界留给 Owner/后续 v2 slice；本轮改动未提交、未 push、未合并、未发布。
