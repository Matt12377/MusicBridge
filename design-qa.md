# MusicBridge UI 视觉 QA

## 当前规范与证据边界

- 唯一视觉规范：`/Users/yihe/Downloads/MusicBridge_Apple_Liquid_Glass_Visual_Redesign_v3.0.md`
- Owner 当前参考：`/var/folders/_n/tl8_8vzx5ng2xr633gkh0cn80000gn/T/TemporaryItems/NSIRD_screencaptureui_7tJaA6/截屏2026-08-22 21.19.25.png`
- 内容组织参考：`/var/folders/_n/tl8_8vzx5ng2xr633gkh0cn80000gn/T/TemporaryItems/NSIRD_screencaptureui_1rccEM/截屏2026-08-22 21.20.14.png`
- 工作树：`/Users/yihe/VSCode/MusicBridge/worktree/ui-development`
- 分支：`codex/ui-development`
- 基线：`96a4bd1ea4c3dd8c400f4de693a1e00406651855`

本报告记录当前实现检查，不把自动测试、合成数据截图或旧截图当作 Owner 视觉验收。v3.0 明确要求提供 Home、Search、Library、Playlist、Now Playing、Inspector 的最新目标截图后，才能宣称视觉 PASS。

## 本轮已实现的视觉结构

- Sidebar、Toolbar、Global Player、Zone Popover 和 Playback Inspector 使用统一的中性 Liquid Glass 材质。
- 内容层改为透明/中性基底：Home 封面墙、连续歌曲表、歌单封面 Grid、Playlist Detail 连续歌曲表。
- 固定蓝紫 token、蓝紫径向背景、蓝色进度光和全局封面旋转已删除。
- 当前封面环境层保留模糊、压暗和 780ms 交叉淡入淡出；无封面回到中性石墨底。
- Zone 已收进唯一 Global Player，未渲染独立 Zone Dock。
- Lyrics/Queue 由右侧 Playback Inspector 承载；Now Playing 使用沉浸式封面、质量单行和歌词预览。
- 歌曲行的播放/更多操作只在 Hover、Focus 或 Context Menu 中出现；支持双击播放、下一首播放和加入队列。
- 破损或缺失封面显示音乐符号 fallback，不再把图片 alt 文本撑满封面区域。

## 当前实现截图（合成数据）

本轮在 Electron 窗口中检查了以下状态：主页封面墙、我喜欢的音乐连续表、所有歌单 Grid、歌单详情、Search 连续表、Now Playing、Queue Inspector。截图来自本地 `MUSIC_BRIDGE_CORE_TEST_MODE=1` 合成数据路径，未连接真实 Provider 或真实 Roon。

这组截图证明当前代码已经能运行到目标结构，但不是 Owner 对最终视觉方向的确认；Search、Library、Playlist、Now Playing、Inspector 的最新目标截图仍未提供。

## 自动验证

- `git diff --check`：通过
- Desktop typecheck：通过
- Desktop tests：56/56 通过
- Electron production build：通过
- Renderer：无 Node / Electron 访问
- CSS：单一 `:root`；无 `radial-gradient()`；无 `rotate()`；无旧蓝紫 token
- 运行窗口：主页、连续歌曲表、歌单 Grid、歌单详情、Now Playing、Queue Inspector 均可打开

## 待 Owner 截图确认

- [ ] Home 最新目标截图
- [ ] Search 最新目标截图
- [ ] Library / Liked 最新目标截图
- [ ] Playlist / Playlist Detail 最新目标截图
- [ ] Now Playing 最新目标截图
- [ ] Inspector（Lyrics 与 Queue）最新目标截图
- [ ] 1440×900、720×480、无封面、蓝色封面、红色封面、黄色封面截图组
- [ ] 对上述截图完成逐页构图、层级、对比度和响应式复核

final result: blocked
