# TASK-030 结果报告：final V1 desktop UI

## 任务身份

- 任务：TASK-030 — final V1 desktop UI
- 基线分支：`codex/task-024-lyrics-v1`
- 基线 SHA：`d912ea1998564b43479bdca1dd004c2ad7559b8e`
- 工作分支：`codex/task-030-v1-ui`
- 实现提交：`1109d0551b09ab649b88eb7514f759841b0d3d8f`
- 实现提交信息：`feat: build the V1 desktop experience`
- 报告提交信息：`docs: record TASK-030 verification`
- 实现提交已推送到 `origin/codex/task-030-v1-ui`
- 未创建 PR、未合并、未 force-push、未发布

## 实现摘要

- 建立 Home、Search、Library、Playlist detail、Now Playing、Queue、Settings、Diagnostics 八个 V1 视图，以及 228px 侧栏、连接状态条和全局播放器。
- Now Playing 展示封面、标题、艺人、专辑、Selected Zone、请求/实际质量、格式、码率和同步歌词；只提供 Previous、Next、Stop，不添加 Pause、Seek、Gapless 或 Crossfade。
- 实现搜索防抖与陈旧结果保护、我喜欢/歌单分页、歌单详情、播放/加入队列/替换队列、歌词可用/不可用状态、质量降级提示和诊断标识。
- Renderer 使用严格的 `musicbridge://app/index.html` 自定义协议；仅允许 GET/HEAD、受控资产映射、真实路径检查、遍历/符号链接逃逸拒绝和精确 MIME。
- Main/Preload/Renderer 边界保持不变；Zone 列表与选择通过既有 IPC 边界公开，Provider 会话仍不进入 Renderer。
- E2E 合成 Core 仅在 `MUSIC_BRIDGE_UI_E2E=1` 下启用，不改变生产运行时，不访问真实 Provider、账号或 Roon。

## 视觉与安全边界

- 采用深石墨 Hi-Fi 控制台、暖白文字、低饱和琥珀色强调和 macOS 系统字体栈。
- 未使用蓝紫渐变、霓虹玻璃、远程字体或管理后台式巨型卡片布局；支持 720×480 最小窗口、较大 Now Playing 布局和 reduced-motion。
- CSP 保持本地脚本/样式/连接；图片仅允许本地、data 和受控的 Provider artwork origin；禁止 worker、frame、form、object 和远程 connect/font。
- BrowserWindow 继续保持 `nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`、`webSecurity=true`；新窗口和外部导航默认拒绝。
- 队列跨 IPC 前重建为纯 `{ trackId, quality }` 数据对象，避免把 Renderer 响应式对象带过安全边界。

## 依赖变更

TASK-030 明确允许增加自动 UI Gate 依赖。开始任务时从官方 npm registry 查询并固定了：

- `@playwright/test`：`1.62.1`
- `axe-core`：`4.13.0`

只修改 `apps/desktop/package.json` 的 devDependencies 和对应 `pnpm-lock.yaml` 条目；未升级 Electron、Vue、Roon 或 Provider 依赖，未新增生产依赖。

## 自动验证

| 命令/检查 | 结果 |
|---|---|
| `corepack pnpm@10.17.1 verify` | PASS，退出码 0 |
| workspace typecheck | PASS，退出码 0 |
| workspace tests | PASS；contracts 13/13、bridge-core 144/144、desktop 30/30 |
| workspace build | PASS，退出码 0 |
| `corepack pnpm@10.17.1 --filter @music-bridge/desktop typecheck` | PASS，退出码 0 |
| `corepack pnpm@10.17.1 --filter @music-bridge/desktop test` | PASS，30/30 |
| `corepack pnpm@10.17.1 --filter @music-bridge/desktop build` | PASS，退出码 0 |
| `corepack pnpm@10.17.1 --filter @music-bridge/desktop test:startup` | PASS；development/production startup 均通过 |
| `corepack pnpm@10.17.1 --filter @music-bridge/desktop test:e2e` | PASS；Playwright 3/3，退出码 0 |
| `node scripts/ci/verify-boundaries.mjs` | PASS；退出码 0 |
| `node scripts/ci/verify-cycles.mjs` | PASS；42 个受检文件，退出码 0 |
| `git diff --check` | PASS，退出码 0 |

## Playwright Electron E2E Gate

- packaged cold start、登录状态界面、Core/Roon 状态、八视图导航、键盘 focus、Renderer 隔离和 window.open 拒绝：PASS。
- synthetic Search、Library、歌单分页、播放、替换队列、Next、Previous、Stop：PASS。
- quality/downgrade 和实际质量展示：PASS。
- lyrics ready/unavailable：PASS。
- Core crash gate：PASS；受控 crash 启动仍加载 `musicbridge://app/index.html`，并收到 `CORE_CRASH_GATE_PASS`。
- axe-core：PASS；critical/serious violations 为 0。
- Renderer 中 `process` 和 `require`：均为 `undefined`。
- E2E 未配置、读取或输出任何真实 Provider 凭据、账号资料、二维码内容、歌曲/歌单标识或完整 URL。

## 未执行事项与交接

- 未执行真实 Provider 登录、真实 Roon 播放、Owner UI 听感验收或真实设备截图验收；这些属于最终 Owner-only 交互，按 V1 目标文件留到 TASK-041 统一验收窗口。
- 未修改 `package.json` 根 manifest、固定 Provider 版本、Roon `extension_id`、38501/38502 端口、loopback-only 规则或 Stream Gateway 行为。
- 未执行 `npm install`、真实播放、歌曲搜索、扫码、Cookie/Token 配置、下载/缓存/转码、FFmpeg、解灰、代理或随机 IP。
- 未创建 `.env`，未写入日志或报告的 Provider 原始响应、凭据、Authorization、完整 URL、Query、Roon 会话资料或用户内容。

## 结论

**PASS WITH ACCEPTED OWNER-ONLY CARRYOVER**

TASK-030 的实现、自动化、Renderer 安全和合成 Electron E2E Gate 全部通过。真实 Provider/Roon 与最终截图验收不阻塞继续推进，统一交给 TASK-041 的 Owner 验收窗口。

下一任务：TASK-031 — diagnostics, crash recovery and stability。
