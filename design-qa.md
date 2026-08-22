# MusicBridge UI 视觉 QA

## 对比目标

- source visual truth：`/var/folders/_n/tl8_8vzx5ng2xr633gkh0cn80000gn/T/TemporaryItems/NSIRD_screencaptureui_HesUYc/截屏2026-08-22 18.16.41.png`
- motion/background reference：`/var/folders/_n/tl8_8vzx5ng2xr633gkh0cn80000gn/T/TemporaryItems/NSIRD_screencaptureui_6G3Uuq/截屏2026-08-22 18.29.57.png`
- implementation screenshot：`/tmp/musicbridge-ui-redesign-playlist-final.png`
- playing ambient implementation：`/tmp/musicbridge-ui-redesign-playing-v4.png`
- combined comparison：`/tmp/musicbridge-ui-design-qa-comparison.png`
- 基线：`95fcffb770bdc358ac8828cbccd0264d52ad2c0c`
- 工作分支：`codex/ui-redesign`

## 视口与状态

- source：4096 × 2304 像素的 macOS 截屏；对比时裁去菜单栏、Dock 和窗口标题栏，保留应用内容区域。
- implementation：1920 × 1216 像素截图，Electron CSS 视口 960 × 608，`devicePixelRatio = 2`。
- 规范化：两张图都按 900 像素高缩放后放入同一张并排比较图；source 的应用内容裁剪为约 3960 × 2140 像素，未把 macOS 系统 chrome 当成产品 UI 比较。
- 状态：第一组为深色主题、空闲播放器、歌单详情；第二组为正在播放、Now Playing 和当前封面氛围层。source 使用真实“我喜欢的音乐”内容与视频中的专辑封面背景，implementation 使用 E2E synthetic playlist 和本地拦截的合成封面，内容数据不同但结构状态一致。

## 全视图比较

实现覆盖了用户要求的三块主区域：

- 左侧边栏：独立的半透明深色玻璃面板，保留搜索、发现、资料库、歌单、播放设备和账户层级。
- 右侧主题区域：主内容使用透光背景、柔和边缘高光、圆角和模糊，歌单标题与曲目列表仍保持清晰的阅读层级。
- 底部播放栏：改为独立的底部玻璃材质，播放封面、歌词提示、进度线、队列和播放控制保持稳定对齐。

与 source 的主要差异是有意的视觉升级：实现增加了 Apple 风格的蓝紫环境光、半透明表面、边缘高光和更圆的控件；source 的纯黑平面和细直角边框没有被逐像素复制，因为用户明确要求液态玻璃和毛玻璃背景。

动态背景按用户第二张参考图复核：当前播放曲目的 `artworkUrl` 被放大铺满、模糊、压暗后放在三块玻璃表面下方；播放状态下以 150 秒线性动画缓慢旋转，切歌使用串行淡入淡出，停止后封面节点清空并回到环境底色。截图中的紫红色氛围来自 synthetic cover 的真实运行态路径，不是静态 CSS 伪造。

## 聚焦区域比较

聚焦检查了侧栏导航、歌单曲目行和底部播放器。三者都使用同一套玻璃边界与交互状态：选中项有独立高光，曲目行有悬停层，播放器按钮有圆形触控目标；没有发现裁切、文字溢出或主要控件被遮挡的问题。

## 必检保真面

- 字体与排版：沿用项目已有系统字体栈，提升主标题的层级和字重，辅助文字在玻璃背景上提高到可读对比度；中文标题、英文 kicker 和小号状态文字均保持清晰。
- 间距与布局：三块主表面保留原有信息架构，侧栏宽度、主内容滚动区和播放器三栏对齐不变，仅调整圆角、留白和控件间距以匹配 Apple 桌面密度。
- 颜色与视觉令牌：使用冷色石墨底、蓝紫主强调、红色停止/错误状态，并通过透明度、内高光和阴影表达玻璃层级。
- 图片与资产：产品运行时继续使用当前曲目的 `artworkUrl`，没有新增需要打包的图片资产；E2E 仅通过受控 synthetic cover 响应验证动态背景，未连接真实 Provider 或 Roon。
- 文案与内容：未改业务文案或数据流，仅复用现有中英文标签和公开状态文本。

## 对比历史

### 第一轮

- 视觉层完成后，真实 Electron 截图确认三块区域均已换成玻璃材质。
- 自动 Axe 检查发现搜索快捷键、侧栏分组标题、底部播放器辅助文字对比度不足；这属于可操作的可访问性问题。

### 修正轮

- 提高 `.sidebar-search-field kbd`、`.sidebar-section-title`、`.sidebar-footer-copy small`、`.player-label`/播放器辅助文字的前景透明度。
- 重新构建并重新截图；Axe 严重级别检查通过，视觉复核没有新增 P0/P1/P2 差异。

### 动态封面轮

- 首次切歌/停止验证发现无限旋转动画会阻止 Vue 离场节点完成清理；离场时显式停止旋转后，连续切歌和停止均能在淡出结束后回收封面节点。
- 调低工作区和底部播放器的遮罩不透明度，保留玻璃文字对比度，让当前封面的蓝紫/粉橙环境色实际透过侧栏、主内容和底部播放器。

## 验证结果

- `git diff --check`：通过
- Desktop typecheck：通过
- Desktop 单元/启动测试：44/44 通过
- Desktop E2E：6/6 通过
- Axe critical/serious：通过
- 动态封面 E2E：播放时 `.album-ambient-cover.is-playing` 可见并使用 `album-ambient-rotate`，停止后封面节点为 0

## Findings

没有剩余可阻塞交付的 P0/P1/P2 视觉问题。source 与 implementation 的内容数据和系统窗口 chrome 不同，已按本次“视觉系统重做”范围归类为预期差异。

## Follow-up Polish

- P3：如果后续提供真实播放曲目和固定目标窗口尺寸，可以再做一次同内容、同 CSS 视口的精确截图对齐；当前动效和数据绑定已经在 synthetic cover 路径验证。

final result: passed
