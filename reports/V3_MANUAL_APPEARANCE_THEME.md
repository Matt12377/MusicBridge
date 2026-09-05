# 手动浅深色主题 — 2026-09-05

final result: passed（代码、定向工程检查与隔离原生视觉范围）。Owner 真实媒体库中的视觉反馈仍待确认。

## 结果

设置 → 应用 → 外观 → 主题，提供浅色 / 深色两张单选预览卡。保持默认浅色；选择即时生效、保存到本机 localStorage，并同步 Electron 原生主题与窗口底色。启动时在 Vue 挂载前恢复内容主题。没有加入自动跟随系统。

浅色的 `style.css` 和 `sakura-theme.css` 相对上一提交没有修改；深色通过独立、有主题选择器约束的样式覆盖颜色和材质。深色参考 Owner 的截图，使用蓝灰色遮罩、浅色文字与暗色浮动播放器，保留封面颜色层次。浏览器扩展具体处理算法未确认，因此不声称复刻扩展的每个像素。

两种主题共用默认背景、封面预加载和暂停保持机制。主题切换即时更新文字和背景，切歌仍保留原有 900ms 交叉淡化。切换过程不调用播放或队列操作。

独立 HTML 预览也增加了设置内主题选择；可用 `?theme=dark&state=playing` 打开蓝色封面深色示例。新预览控制不会进入正式播放数据。

## 身份与验证

- 分支：`codex/v3-ui-redesign`；工作树：`worktree/v3-ui`。
- Base：`501a37ee28245d41f86301232166d41382559741`。
- 实现：`3aa635cd316d5b86ba5e20f4a9a2332f15d321b9`。
- 报告：本报告及 STATUS 的独立提交；`git log -1 --format=%H -- reports/V3_MANUAL_APPEARANCE_THEME.md` 可解析身份。下一轮以报告提交 HEAD 为基线。
- 远端读取：`fffc12783dc05ea2f2521288685f6cce3c6caf2a`；本轮没有 push、merge、release。
- RED：先创建偏好测试，模块缺失时 exit 1；GREEN：61/61 定向测试 exit 0。
- 范围：appearance-preference、appearance-ipc、ambient-artwork、ambient-preview-parity、sakura-theme、renderer、preload、ipc-security。
- desktop typecheck、production build、control-plane、boundaries：均 exit 0。
- 原生 Gate：鼠标切换、方向键切换、重新加载、保存后结束进程并重新启动、原生 themeSource 同步、非法主题拒绝、暂停曲目/位置/队列保持，均通过。
- 浅色同尺寸关键几何/材质对照通过；深色 HTML 与正式应用侧栏/播放器/背景遮罩计算颜色匹配。人工查看深色默认主页、封面主页、宽/窄设置截图。
- 核心测试未使用真实账号、真实 Roon 或音频设备。未运行全量单元/E2E，沿用 Owner 速度优先要求。已有真实播放 carryover 不由这次主题检查覆盖。

## 证据与复现

外置证据目录：`/Volumes/LifeWeave/Developer/CommandLine/tmp/musicbridge-appearance/`。

- `home-dark-idle.png`、`home-dark-cover.png`、`reference-dark.png`。
- `settings-dark.png`、`settings-light.png`、`settings-dark-narrow.png`。
- 外置临时根下 `musicbridge-appearance-{red,focused,typecheck,build,native,restart}.log`。

在既有 `ambient-ui-gate.mjs` 的隔离环境参数上增加 `MUSIC_BRIDGE_APPEARANCE_GATE=1`，运行会测试两种主题并以深色保存退出。使用同一合成用户数据目录再次启动，增加 `MUSIC_BRIDGE_APPEARANCE_RESTORE=1`，验证跨进程恢复。参考 HTML 需由端口 4186 的既有只读本地服务器提供。产物、日志、测试用户数据均使用外置临时目录；不得替换成真实用户配置。

结果标记：`AMBIENT_REFERENCE_PARITY_PASS`、`APPEARANCE_NATIVE_PASS`、`APPEARANCE_COLD_RESTART_PASS`。原生日志的 meta frame-ancestors 提示是既有信息，没有放宽 CSP。

## 使用边界

现有用户实例没有重启。重新从此 UI 工作树启动后即可使用设置入口。正常本机存储可用时会保留选择；存储不可用的防御路径允许本次会话切换，不承诺该异常条件下跨重启保存。正式新主题视觉仍以 Owner 真实媒体库反馈为准。
