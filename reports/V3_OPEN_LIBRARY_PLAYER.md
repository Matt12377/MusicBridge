# 开放式音乐库与完整播放栏 — 2026-09-05

结果：代码、定向工程检查、隔离 Electron 视觉与交互验证通过。真实媒体库视觉、真实设备音量和 Owner 最终体验验收仍待反馈。

## 实现

- 删除歌单、Roon 专辑/实体、搜索艺术家/专辑、收藏和实物音乐封面的外层底板。主音乐页面取消最大宽度，普通窗口两侧各留 24px，窄窗口各留 14px。歌单/专辑格子以最小 210px 排列；窄窗口最小 160px。
- 共用歌曲表、Roon 专辑/歌单/流派曲目采用透明列表，移除外框、常驻分隔线和表头。主列表封面 64px、行高 84px；曲名、艺术家/专辑、来源提供的格式/码率/版本按层次排列。大列表虚拟行高同步 84px。队列封面 56px、行高 80px，虚拟常量同步。
- 播放栏放宽、增高，封面 68px、曲名 18px、艺术家 14px，封面旁显示实际等级、格式和码率。音质按钮只有当前值，音质和设备按钮均为 38px 高；菜单仍选择后续播放偏好，不把偏好标作实际值。未播放时按钮展示偏好。
- 新增进度、已播放/总时长，使用真实播放快照插值，暂停固定；拖动复用现有 seek 接口。提交后等待快照确认，不用拖动值冒充成功后的进度。
- 新增音量按钮与弹层。Renderer → preload → 主进程可信来源检查 → 受限 Core IPC → Roon Transport change_volume。读取所选 Zone 输出的原生单位、范围、步长；数值/分贝用滑块，增量设备用加减。分组输出分别显示，固定音量设备明确说明不支持。
- 音量请求绑定 Zone 与 Output，拒绝旧 Zone、越界、非法数值；只有设备订阅读数能改变已观测音量，不用成功回执中的请求值覆盖设备读数。没有改本机系统音量。
- 保留浅深色设置、封面预加载与暂停背景。播放栏增高后同步侧栏设置入口、列表尾部和队列的底部避让。

## 身份

- 工作树：`worktree/v3-ui`，分支 `codex/v3-ui-redesign`。
- Base：`001aa26dd0991d09f485e31c30320ae9073bfbf4`。
- 实现提交：`70c4babc339f90645b1986a843a54f99a97605aa`。
- 报告提交：用 `git log -1 --format=%H -- reports/V3_OPEN_LIBRARY_PLAYER.md` 解析；下一轮从该报告提交 HEAD 开始。
- 远端读取仍为 `fffc12783dc05ea2f2521288685f6cce3c6caf2a`；未 push、merge、release。

## 验证

- RED：新增真实音质/进度、设备音量约束测试，缺失模块时测试退出 1；随后实现通过。
- desktop：player-details、volume-ipc、preload、renderer、appearance-ipc、appearance-preference、virtualWindow，53 项通过，exit 0。
- Core：roon-adapter、roon-volume、utility-ipc，115 项通过，exit 0；覆盖官方 Transport 调用、设备错误、旧 Zone、原生单位/步长和有限 IPC。
- desktop typecheck、Core typecheck、生产 build、control-plane、boundaries：exit 0。
- 原生入口：`apps/desktop/scripts/open-library-ui-gate.mjs`。隔离用户目录、mock keychain、合成库，不连接真实 Provider/Roon。
- 两种主题分别在 1980×1080、1440×819、720×640 下检查控件无重叠、同高、设置按钮可点击；封面容器 padding/border 为零、背景透明。主列表实际行高 84px、封面 64px，自动分页到 120 首后最后一行能完整滚出播放栏。
- 原生交互确认暂停、seek 到 65 秒、音量从 40 改到 39，并从 Core 回读；实际音质显示 `无损 · FLAC · 1,411 kbps`。检查截图包括浅深色主页、列表、音量弹层和窄窗口。
- Gate 的触底检查先前把自动追加的新一页误认为最终列表末尾，现等待合成库分页结束后再定位到底部；不是通过移除尾部遮挡断言来放行。
- 未运行全量测试或打包发布；没有重启用户现有真实播放实例。

## 证据与边界

证据根：`/Volumes/LifeWeave/Developer/CommandLine/tmp/musicbridge-open-ui/`。关键图片：`player-details-dark.png`、`player-volume-dark.png`、`list-light.png`、`playlists-dark.png`、`home-dark-720.png`。日志位于同一外置临时根，前缀 `musicbridge-open-`，包含 regression、adapter、typecheck、core-typecheck、build、native、control、boundaries。

歌曲列表和播放状态未提供采样率/位深时不会根据码率或音质档位推断。列表缺少格式/码率时显示“音质未知”；这不是经过音频解析的媒体技术信息覆盖证明。真实设备是否提供滑块、分贝或增量能力须看其 Roon 返回值。

独立 `ambient-study` HTML 保留之前背景设计基线，本轮正式布局明确按最新截图反馈更新，旧的几何 parity Gate 不作为本轮尺寸验收。现有真实播放/设备 carryover 没有被合成 Gate 消除。用户重启当前 UI 开发版后可查看新播放栏和列表。
