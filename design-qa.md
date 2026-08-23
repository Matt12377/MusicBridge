# Now Playing / Lyrics 视觉 QA

## 结论

final result: passed

本轮以附件中的 Apple Music 桌面歌词页作为目标参考，以 Music Bridge 当前截图作为改造前基线。比较范围限定为 Now Playing 全屏页、左侧播放卡、右侧歌词焦点、背景氛围、进度和控件；不把附件中的文字、歌曲或系统界面当作产品需求。

## 视觉证据

- 目标参考 A：`/var/folders/_n/tl8_8vzx5ng2xr633gkh0cn80000gn/T/codex-clipboard-923873c8-4034-4734-9867-e9bd2c77f52b.png`
  - 原始像素：4096 × 2304；对话展示为 2048 × 1152，按 2× 参考图处理。
- 改造前基线 B：`/var/folders/_n/tl8_8vzx5ng2xr633gkh0cn80000gn/T/codex-clipboard-17f6c79c-1ac8-4ed2-af8e-96b7dc9c31d5.png`
  - 原始像素：4096 × 2304；仅用于确认差距，不作为最终视觉真值。
- 最终正常播放页：`/var/folders/_n/tl8_8vzx5ng2xr633gkh0cn80000gn/T/musicbridge-task-037-now-playing.png`
  - PNG：1920 × 1216；Electron 默认页面 CSS 视口约为 960 × 608，截图密度约 2×。
  - 状态：合成 Track 1、无歌词、全屏播放卡。
- 最终歌词聚焦页：`/var/folders/_n/tl8_8vzx5ng2xr633gkh0cn80000gn/T/musicbridge-task-037-lyrics-focus.png`
  - PNG：1440 × 900；状态：合成 Track 2、多行中英文歌词、当前行 index 0。
- 最终控件近景：`/var/folders/_n/tl8_8vzx5ng2xr633gkh0cn80000gn/T/musicbridge-task-037-controls.png`
  - PNG：449 × 47；直接截取 `.transport-controls`。
- 同画布对照：`/var/folders/_n/tl8_8vzx5ng2xr633gkh0cn80000gn/T/musicbridge-task-037-qa-comparison.png`
  - 将参考 A 与最终歌词聚焦页统一到同一高度并排比较；仅用于视觉 QA，不作为产品资源。

## 对照结果

### 完整页

- 左侧封面、标题、艺人/专辑、进度和控件形成连续的紧凑播放卡；右侧扩大为主要歌词舞台。
- 取消硬分隔线和歌词区域深色矩形遮罩，左右共享同一张封面氛围背景。
- 窄高桌面窗口增加了专用容纳规则，正常播放页的控件底部不再越过视口。

### 歌词焦点

- 当前行保持清晰、最大字号和最高对比度，稳定落在右侧视觉中心。
- 相邻行按距离递减透明度、轻微模糊和缩放；更远的行继续退后，并通过容器上下 mask 渐隐。
- 翻译作为当前主歌词下的次级行保留可读性，不与主歌词争夺焦点。
- `scrollIntoView({ block: 'center', behavior: 'smooth' })` 继续承担当前行聚焦；用户滚轮、触控或指针操作后短暂暂停自动跟随，减少抢滚动。

### 控件与进度

- 主控缩至 46px，上一首/下一首缩至 36px，间距和按压缩放保持主次关系。
- 进度轨道改为 3px，拖柄缩至 8px；实际音质以轻量 badge 展示，诊断文本收敛为单行低对比信息。
- 使用现有 `SidebarIcon` 和现有停止/播放事件，未引入新的图标依赖或改变播放语义。

## QA 迭代记录

1. 初始草稿对照发现：歌词区域上、下边缘存在硬深色块；音质行信息过密；主控和拖柄偏重；默认窄高窗口的主控被截断。
2. 已修复：改用透明渐隐 mask；压缩音质元数据；收紧主控和拖柄；新增 `min-width: 761px`、`max-height: 760px` 的桌面容纳断点，并增加控件底部不越界的 E2E 断言。
3. 复核结果：最终截图在完整页、歌词焦点和控件近景三个状态均无可执行的 P0/P1/P2 视觉问题。剩余差异属于 P3：真实歌曲封面和 Apple Music 参考图不同，停止态保留品牌红色圆形主控。

## 必要表面检查

- 字体与排版：沿用现有 `-apple-system`、SF Pro 和 PingFang 回退链；标题、艺人、歌词主行、翻译和技术信息有明确字号/字重/透明度层级。
- 间距与布局：双栏比例、封面圆角、歌词中心定位、进度和控件间距均在 960×608、1440×900、2048×1152 几何 E2E 中覆盖；无水平溢出和专辑图/歌词重叠。
- 颜色与 token：沿用 graphite 背景和现有品牌红色；移除径向渐变，保留线性暗化、模糊封面和 vignette，符合现有 `Liquid Glass v4` 静态约束。
- 图像与图标：使用现有 `SafeArtwork` 封面和现有 `SidebarIcon`；没有新增占位图、CSS 图形、手工 SVG 或 emoji 图标。
- 文案与无障碍：保留中文产品文案、实际音质和 Provider 返回状态；控件保持 aria-label；axe 严重度检查通过。

## 验证结果

- `corepack pnpm@10.17.1 run typecheck`：退出码 0。
- `corepack pnpm@10.17.1 run test`：Contracts 19/19、Bridge Core 184/184、Desktop 73/73，退出码 0。
- `corepack pnpm@10.17.1 --filter @music-bridge/desktop run test:e2e`：10/10，退出码 0。
- `git diff --check`：退出码 0。
- 未执行真实 Provider、真实 Roon、Core Mac 部署、Owner 验收、commit 或 push。
