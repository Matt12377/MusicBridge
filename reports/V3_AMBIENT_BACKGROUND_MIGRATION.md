# 全窗口背景正式迁移 — 2026-09-05

final result: passed（本轮代码、定向检查和隔离原生视觉范围）；真实账号视觉与播放验收待 Owner。

## 交付身份

- 分支：`codex/v3-ui-redesign`；工作树：`worktree/v3-ui`。
- Base：`c17f00f49dd61369d19a0b9634db3ab9de719c4e`。
- 实现提交：`f7b9267cd4f863dfb690ad08d9b931a0aaa19bfb`。
- 报告提交：本文件与 STATUS 的独立报告提交；可用 `git log -1 --format=%H -- reports/V3_AMBIENT_BACKGROUND_MIGRATION.md` 解析。
- 视觉基准：`prototypes/ambient-study/index.html`，Owner 明确要求保持该 HTML 的视觉效果。
- 远端核验：`origin/codex/v3-ui-redesign` 为 `fffc12783dc05ea2f2521288685f6cce3c6caf2a`；本轮没有 push、merge 或 release。
- 下一轮从本报告提交的最终 HEAD 继续；未启动另一任务。

## 实际迁移

默认背景使用预览原图，SHA256 对照测试逐字节匹配。全窗口共用连续背景；侧栏 30% 浅色玻璃、25px 模糊；播放器 70% 浅色玻璃、32px 模糊，宽 1060px、高 88px、底距 18px、圆角 23px。封面墙保持五列，内容最大宽 1380px。颜色、字体和间距直接沿用预览，旧颗粒和强高光不再叠加。

新封面解码完毕才替换旧画面，900ms 同时淡入淡出；暂停保留封面；无封面或当前加载失败回到默认背景。异步请求有代次检查，迟到结果不会覆盖最新选择。Roon 封面沿用现有本地 artwork cache，淡出结束后释放租约，卸载时回收。

主页和收藏标题层级迁入正式组件。实际日期/歌曲数量、刷新、播放全部、音质、设备选择、队列、设置及业务导航沿用现有功能。收藏页歌曲专辑/时长/操作列和 58px 虚拟列表行高保留，未套入预览的模拟列表逻辑。播放自动进入详情页的既有流程也保留。预览工具条、模拟状态文案、示意曲目和占位图库均未进入生产数据。

Bootstrap Icons 复用预览本地 WOFF2。原资源自带查询参数不符合正式资源协议的无查询参数约束，已移除参数；未放宽协议或 CSP。没有新增第三方运行时依赖。

## 验证

| 范围 | 结果 | 证据 |
|---|---|---|
| 初始 RED | exit 1，预期失败 | 新行为模块和视觉迁移尚未实现时先执行测试 |
| 定向单元/结构测试 | 55/55，exit 0 | ambient-artwork、ambient-preview-parity、sakura-theme、renderer、sidebar-controls、roon-artwork-cache |
| 类型检查 | exit 0 | desktop `typecheck` |
| 生产构建 | exit 0 | desktop `build`，背景和字体成功打包 |
| Control Plane / Boundaries | 均 exit 0 | 标准两个检查入口 |
| 原生布局 | exit 0 | 1980×1080、1440×819、720×480；五/三列、7 个播放器按钮、无重叠、设置可点、滚动到底无遮挡 |
| 预览对照 | PASS | 同一 Electron、1440×819；背景/遮罩/侧栏/播放器/主标题/分组头的坐标、尺寸、字体和材质匹配 |
| 原生交互 | PASS | 合成选区准备后，点击正式播放全部 → 返回列表 → 点击暂停；背景保持，暂停按钮已变为恢复播放；设置内未确认操作面板可打开 |
| 全量单元/E2E、真机播放 | 未运行 | 依 Owner 速度优先要求，仅覆盖本次变更；不代表音频与设备验收 |

视觉对照仅移除 HTML 的演示工具条来统一应用视口，未修改已认可 HTML。图像内容与文本由真实业务数据决定；合成 Gate 的所有曲目共用一张演示图，因此不声称整幅截图像素相同。透明背景下任意封面的文字对比度也未作全面认证。

查看了默认主页、窄窗口和暂停后的收藏列表原生截图。原生日志存在既有 meta `frame-ancestors` 提示；本次没有修改安全策略。

## 可复核证据与复现

证据目录：`/Volumes/LifeWeave/Developer/CommandLine/tmp/musicbridge-ambient-migration/`。

- `home-open-1980.png`、`home-open-1440.png`、`home-open-720.png`：正式组件、合成数据。
- `reference-1440.png`、`comparison.json`：同尺寸 HTML 对照与计算样式。
- `list-idle.png`、`list-playing.png`、`list-paused.png`：实际业务页面背景状态。
- `native.log`：`AMBIENT_REFERENCE_PARITY_PASS`、`AMBIENT_PLAY_PAUSE_PASS`、`AMBIENT_NATIVE_PASS`。
- 外置临时根下 `musicbridge-ambient-migration-{red,focused,typecheck,build}.log`：各阶段日志。

原生 Gate：`apps/desktop/scripts/ambient-ui-gate.mjs`。先在仓库根用 `python3 -m http.server 4186 --bind 127.0.0.1 --directory prototypes` 提供只读参考；构建后使用独立 `musicbridge-ui-e2e-*` 外置临时目录，以 `MUSIC_BRIDGE_UI_E2E=1 MUSIC_BRIDGE_CORE_TEST_MODE=1 MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR=<该目录> MUSIC_BRIDGE_AMBIENT_QA_DIR=<外置证据目录>` 启动 Electron `--use-mock-keychain apps/desktop/scripts/ambient-ui-gate.mjs`。不能用真实用户数据目录替代。

## Carryover

HTML 视觉方向已认可；正式应用在 Owner 真实媒体库中的最终视觉仍待确认。本轮没有重启用户正在运行的旧实例、连接真实服务或验证真实声音。先前远程音频链路恢复与真实播放验收仍保留，不被本轮合成 Gate 覆盖。正式新界面在该 UI 工作树构建启动后生效。
