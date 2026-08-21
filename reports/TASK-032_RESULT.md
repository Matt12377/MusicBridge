# TASK-032 结果报告：菜单栏与应用生命周期

## 任务身份

- 任务：TASK-032 — menu bar and application lifecycle
- 基线分支：`codex/task-031-diagnostics-stability`
- 基线 SHA：`7bb8bda1686543dbb69760dc9c21981dd3a41df0`
- 工作分支：`codex/task-032-tray-lifecycle`
- 实现提交：`b7434c29920b775d273496a51549c0bdfc1156f8`
- 实现提交信息：`feat: add menu bar and lifecycle controls`
- 报告提交信息：`docs: record TASK-032 verification`
- 实现提交已推送到 `origin/codex/task-032-tray-lifecycle`
- 未创建 PR、未合并、未 force-push、未发布

## 实现摘要

- Main 进程创建原生 Electron `Tray`/`Menu`；Renderer 不持有托盘对象，也不读取系统能力。
- 新增本地单色模板图像，构建时内联到 Main bundle，不依赖远程资源。
- 红色关闭按钮固定为隐藏窗口；App、Core 和当前播放继续运行。
- Dock 激活、托盘点击和 `Open Music Bridge` 会显示并聚焦原来的窗口；不会创建第二个窗口。
- 托盘菜单固定为：Open Music Bridge、当前公共曲目摘要、Roon/Provider 状态、Previous、Next、Stop、Show Queue、Export Diagnostics、Quit Music Bridge。
- 菜单摘要只使用公开标题、艺人、专辑和公开枚举状态；不包含 Cookie、URL、内部曲目/Zone 标识、Pause 或 Seek。
- `Show Queue` 通过窄的 Main→Preload→Renderer 应用命令切换到 Queue 视图；托盘本身仍完全由 Main 管理。
- `Quit Music Bridge` 与 Command+Q 共用已有的有界退出路径：先停止 Core（其内部清理 Roon Session、Gateway 和播放资源），再销毁 Tray，最后退出 Electron。
- 诊断导出逻辑抽为 Main 复用函数，Renderer 与托盘都只得到导出成功/取消结果。

## 修改文件

- `apps/desktop/e2e/v1-ui.spec.ts`
- `apps/desktop/src/assets.d.ts`
- `apps/desktop/src/main/assets/musicbridge-tray-template.svg`
- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/main/tray.ts`
- `apps/desktop/src/preload/api.ts`
- `apps/desktop/src/preload/index.ts`
- `apps/desktop/src/renderer/src/App.vue`
- `apps/desktop/test/preload.test.ts`
- `apps/desktop/test/tray.test.ts`

未修改 `package.json`、`pnpm-lock.yaml`、Provider 依赖、Roon `extension_id`、38501/38502 端口、loopback-only 规则、Bridge Core、Stream Gateway 或 Provider 行为。

## 自动验证

| 命令/检查 | 退出码 | 结果 |
|---|---:|---|
| `corepack pnpm@10.17.1 --filter @music-bridge/desktop typecheck` | 0 | PASS |
| `corepack pnpm@10.17.1 --filter @music-bridge/desktop test` | 0 | PASS，36/36 |
| `corepack pnpm@10.17.1 --filter @music-bridge/desktop build` | 0 | PASS |
| `corepack pnpm@10.17.1 --filter @music-bridge/desktop test:e2e` | 0 | PASS，Playwright 5/5 |
| `corepack pnpm@10.17.1 verify` | 0 | PASS；workspace typecheck、tests、build 全部通过 |
| `git diff --check` | 0 | PASS |
| `git diff -- package.json pnpm-lock.yaml` | 0 | 无差异 |

## 生命周期与菜单 Gate

- 纯函数托盘安全测试：PASS；菜单动作集合固定，公共摘要不包含内部标识、完整 URL、凭据词或 Pause/Seek。
- Idle 关闭/隐藏/激活恢复：PASS；Electron E2E 通过。
- Playback 关闭/隐藏/激活恢复：PASS；窗口隐藏后合成播放状态仍为 playing，重新激活后仍在同一窗口。
- Dock/应用激活：PASS；`app.emit('activate')` 恢复现有窗口，不重复创建。
- `Show Queue`：PASS；Main 发出的受控应用命令使 Renderer 进入 Queue 视图，播放状态保持。
- 真正退出：PASS；Electron E2E 发出 `app.quit()` 后在有界时间内以退出码 0 结束，退出前经过 Core shutdown 路径并销毁 Tray。
- Renderer 隔离与可访问性：PASS；既有 Renderer 安全测试和 axe critical/serious 检查继续通过。

## 未执行事项与 Owner-only Gate

本轮只完成开发机上的自动化与打包 Electron E2E，未建立或使用 SSH，未连接真实 Core Mac，未读取或输出任何 Provider 凭据，未调用真实 Provider，未播放歌曲，未重启或修改 Roon。

以下真实设备 Gate 留待 Owner 在后续统一实机窗口确认：

- Core Mac packaged smoke；
- 真实 Roon Session/Gateway 停止后的端口释放与残留进程检查；
- 真实播放中的关闭/重新打开与 Command+Q；
- 真实菜单栏点击验收及 crash/failure 状态展示。

## 安全检查

- 未新增 Cookie、Token、账号资料、完整 URL、Query 或内部设备信息到代码、日志、报告或 Git。
- 托盘摘要对文本做长度和 URL/Query 脱敏；菜单不显示 track ID、Zone ID、播放 URL 或凭据状态以外的敏感内容。
- 未开放 LAN 端口，未改变控制端口或流端口的 loopback-only 约束。
- 未执行 `npm install`、真实播放、Provider 登录、Cookie 配置、下载、缓存、转码、FFmpeg、解灰、代理或随机 IP。

## 结论

**PASS WITH OWNER-ONLY PACKAGED CORE SMOKE PENDING**

TASK-032 的实现、自动化、生命周期 E2E、托盘安全边界和退出路径全部通过。真实 Core Mac packaged smoke 与真实设备菜单/退出验收尚未执行，按 Owner-only Gate 保留，不阻塞继续创建 TASK-040 分支。

下一任务：TASK-040 — macOS Beta packaging。
