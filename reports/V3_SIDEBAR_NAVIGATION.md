# 侧栏导航调整 — 2026-09-05

用户澄清括号中的 Roon 与网易云是对“歌单”的说明。主导航改为主页、专辑、艺术家、流派、收藏、实物收藏、录音；收藏只指向既有 Roon 收藏页。移除原“资料库／收藏”分组标题和主导航“我喜欢的音乐”入口；网易云喜欢歌曲仍可从首页进入。

下方统一“歌单”分区可整体展开/收起，包含 Roon 歌单浏览入口、网易云全部歌单入口和既有网易云歌单快捷项。没有改变两个来源的数据加载与分页逻辑。侧栏收窄弹层也提供两个来源，网易云加载失败不会阻断 Roon 入口。设置保留底部固定位置，侧栏禁止横向滚动。

- 工作树 `worktree/v3-ui`，分支 `codex/v3-ui-redesign`。
- Base `36fcd39f5f2a23a94bc6bf4c687abd8518ac4a3b`。
- 实现 `98d8fcce489267714bf7f2aa58fda7cfb3d368ab`。
- 7 项侧栏定向测试、desktop typecheck、生产构建、原生开放布局 Gate、diff 检查均 exit 0。
- 原生 Gate 验证主导航顺序、歌单折叠与 Roon/网易云页面跳转；浅深色、1980/1440/720 窗口布局通过，设置可点击，控件不重叠。已有进度和音量回归通过。
- 已查看展开深色与折叠浅色截图，证据 `/Volumes/LifeWeave/Developer/CommandLine/tmp/musicbridge-sidebar-ui/`；日志 `musicbridge-sidebar-*.log` 位于同一外置临时根。
- 历史 ambient Gate 的喜欢歌曲导航选择器同步为首页入口，仅做语法检查；本轮实际执行的是 open-library Gate。
- 使用隔离合成数据；未验证真实 Roon/网易云账号，未重启用户实例，未 push/merge/release。用户视觉验收待反馈。
- 报告提交可由本文件最后一次提交解析；下一轮从报告 HEAD 开始。

## 后续调整：仅网易云歌单

按用户最新要求，将分区命名为“网易云歌单”，移除 Roon 与重复网易云来源行，只显示网易云歌单列表，保留折叠。删除不再使用的来源组件。Base `cec2743a327865864a6beb60cd657e5514b5a817`，实现 `57531562637d8303df072191a52bc9e0976751ed`。

5 项定向测试、生产构建、diff 检查通过。首次原生验证在旧主页定位选择器处中止；修正为按区域名称定位后重跑，得到完整 `OPEN_LIBRARY_NATIVE_PASS`。已查看最终 Electron 截图，目录 `/Volumes/LifeWeave/Developer/CommandLine/tmp/musicbridge-netease-sidebar-ui/`。本轮未重复类型检查；未操作真实账号、未重启用户实例、未 push。报告 HEAD 为下一基线。
