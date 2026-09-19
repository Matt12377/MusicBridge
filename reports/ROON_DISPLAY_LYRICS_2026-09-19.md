# Roon Web Display 本地歌词接入

## 范围与身份

- Owner 授权接入其 Web Display，让本地歌曲不再匹配网易云，授权离开电脑期间自主开发；不修改本地音乐文件、Roon 导入偏好、账号凭据或安全策略。
- 工作树：`worktree/v3-ui`；分支：`codex/roon-display-lyrics`。
- Base：`2e1a344afcde1d64c446e04e62312f7564139c2b`。
- 实现提交：`f8635b033d04052b5968aa3657c6c16da67e32cc`。本报告由独立文档提交记录；下一分支基线为本报告提交 HEAD。
- 当前增量仅本地提交，未推送、合并或发布；上一轮明确 GitHub 同步任务已经单独完成。核对远端 `codex/unified-search` 仍为上述 base；远端尚无本轮分支。
- 保留未跟踪的 `apps/desktop/test-results/`、`prototypes/metafine-study/`，不纳入提交或清理。

## 实现

- Main 加载 Roon 自己的 Web Display 页面，通过 Electron CDP 读取现有 WebSocket 推送的 `LyricsChanged`，提取有界 LRC 和 Zone/曲目元数据。
- 隐藏窗口没有 preload、Node 权限或持久化 session；sandbox、contextIsolation、webSecurity 开启，只允许指定局域网主机及端口，拒绝外部资源、下载、权限请求、新窗口和任意导航。
- 不复制官方 SDK、注册假扩展或将 Web Display 的 key/token/原始帧传给业务层；歌词仅保存在内存。
- Core 按 Zone、标准化标题/艺人、已知专辑与时长核对当前曲目。启用后本地歌词不自动回退网易云，网易云曲目的原链路保留。
- 接入原有逐行歌词、高亮与播放时钟，换歌、换设备、断连、Core 重启会使旧歌词失效；10 秒有界重连。
- 设置 → Roon 新增 Display 地址、状态、保存及停用入口；来源标签明确为“Roon Web Display”。使用 ui-ux-pro-max 的表单标签、就近错误、禁用反馈和主题语义色指导，沿用已有 Vue 设置样式。
- 设置保存串行且原子写入；防止迟到恢复/轮询覆盖新设置，防止旧网易云结果重建已停用的匹配状态。
- URL 只存本机 `roon-display.json`，文件权限 0600。Owner 地址已写入正式应用的本机配置，不进入 Git；普通启动尚未完成，需处理系统提示后重新启动确认读取。

## 验证证据

Node 22.23.2 / pnpm 10.17.1；测试与构建串行，测试并发 1。所有构建、缓存、测试结果与日志位于已核实挂载且可写的外置 LifeWeave APFS。

| 验证 | 结果 / 退出码 | 边界 |
|---|---|---|
| Contracts 全部单元测试 | 191/191，0 | 合成 |
| Core 歌词、匹配、runtime、utility IPC 相关测试 | 132/132，0 | 合成，非 Core 全量 |
| Desktop 协议、preload、安全、CSP、protocol、supervisor | 72/72，0 | 合成，非 Desktop 全量 |
| Contracts/Core/Desktop 类型检查 | 0 | 静态 |
| Core/Desktop production build | 0 | 构建 |
| Control Plane / Boundaries / diff check | 0 | 边界与静态 |
| `node apps/desktop/scripts/roon-display-gate.mjs`（在桌面目录运行 `node scripts/roon-display-gate.mjs`） | 0 | 真 Electron + loopback 合成服务器：首连、隔离、外链阻断、歌词解析、0600 持久化、断连清词、自动重连、重启、恢复、并发停用 |
| 新增歌词设置 E2E | 1/1，0 | 合成 IPC：输入校验、保存、停用、浅深色、来源/高亮、清词；不是实际 Core 端到端 |
| 真实 Display 连接器 | 0，收到两份 LRC | 51/71 条时间行，249000/266000ms，存在标题、艺人、专辑；未切歌，不记录歌词正文 |
| electron-builder macOS arm64 dir | 0 | `--publish never` |
| 构建包与安装包 codesign verify | 0 | ad-hoc，不是 Developer ID/公证 |
| 构建包与安装包隔离启动 | 0 / 0 | 都出现 `DESKTOP_STARTUP_READY`，mock keychain + 合成 Core |
| 普通安装版启动 | 未通过 | 系统钥匙串读取等待 Owner，不以隔离启动替代 |

最终日志在 `/Volumes/LifeWeave/Developer/CommandLine/tmp/` 下：

- `mb-display-contracts-tests.log`、`mb-display-core-final-tests.log`、`mb-display-desktop-final-tests.log`。
- `mb-display-final-types.log`、`mb-display-final-core-types.log`、`mb-display-final-desktop-types.log`、`mb-display-final-build.log`。
- `mb-display-connection-gate.log`、`mb-display-ui-final.log`；`mb-display-ui-final/` 内浅深色设置卡片与歌词截图已检查。
- `musicbridge-lyrics-install-KO4Zdl/` 内打包、签名后的隔离启动与安装启动证据。

中间失败已区分：E2E 初版用错已有设置按钮名称、重复首页曲目入口，以及播放后本来自动打开正在播放页，均修正测试选择器/流程后通过；未为测试更改产品导航。第一次打包启动检查因测试目录名未满足 `musicbridge-task036-startup-*` 白名单而失败，改正启动参数后通过，未放宽生产安全门禁。

## 安装与当前阻塞

- 安装路径：`/Applications/Music Bridge for Roon.app`。
- 更新前通过应用菜单正常退出旧版，核对无旧主进程后将旧包移至完整备份，再将验证过的暂存新包改为正式路径；没有删除用户数据。
- 备份：`/Volumes/LifeWeave/Developer/CommandLine/Backups/MusicBridge/2026-09-19-lyrics-vGgZK6/Music Bridge for Roon.app`。
- 新构建包与正式安装包 `Contents/Resources/app.asar` SHA-256 均为 `748063119c5ca3666aaafad9056ea33849b1529517ff3dedb438973fe7fa5b27`。
- 普通启动进程已存在，但窗口自动化读取超时。进程采样显示 `SecItemCopyMatching → SecKeychainItemCopyContent → SecurityServer::decrypt` 等待；同期有 SecurityAgent 进程。桌面工具明确禁止访问 SecurityAgent，因此停止该路径，不借其他工具绕过。
- 需要 Owner 回到电脑后处理 macOS 钥匙串提示（若要求密码，只在系统本机对话框输入），然后重新启动 MusicBridge。没有删除/重置钥匙串，没有明文导出或重新录入 Provider 凭据，也没有把 mock keychain 用于真实用户数据。
- 处理系统提示后检查“设置 → Roon → Roon Web Display”为已连接，再从应用正常播放本地歌曲验证逐行高亮、seek、暂停恢复和跨专辑播放。整首真实同步和 Owner 听感验收仍待完成。

## 已知边界与后续

- Web Display 不是稳定公开的歌词 API，Roon 协议升级可能需要维护；原始 `LyricsChanged` 只有 Zone/key/LRC，没有独立曲目身份。当前依赖同一连接的有序元数据更新与 Core 当前曲目核对，不能声称能识别服务端自身误发且元数据不变的旧 LRC。
- “Roon Web Display”只表示实际读取来源，不证明每首词都来自文件内嵌标签。若要求优先文件，Roon 的歌词/同步歌词导入偏好应为 Prefer File；本轮未改动。
- 没有同步 LRC 时显示暂无歌词；不伪造时间轴，也不悄悄回退网易云。
- 本轮不宣称完整仓库回归、远端 CI、真实音频、Remote Core 或 Owner 验收通过；历史 carryover 不由本轮消除。
- 参考：Roon 官方 [Lyrics](https://help.roonlabs.com/portal/en/kb/articles/lyrics)、[Displays](https://help.roonlabs.com/portal/en/kb/articles/displays)，以及本机 Roon 原版 `webroot/display_ui.js`。
