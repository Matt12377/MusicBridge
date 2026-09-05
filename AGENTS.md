# Music Bridge for Roon 工程执行约定

## 任务推进

任务按 `tasks/00_TASK_INDEX.md` 与 `project/WAVE-3.yaml` 的线性顺序推进。每个任务必须有独立分支、实现提交、结果报告提交、自动 Gate；下一任务从上一任务最终 HEAD 创建。只有 Owner 明确放行的任务才可开始。

开始任务前，先确认项目根目录、当前分支、HEAD、远端对应分支和工作区状态。完成任务后必须复核 `git diff --check`、工作区清洁、远端 HEAD 和报告身份。使用明确文件路径暂存，保留与任务无关的用户变更。

## V3 已确认的开发方向（2026-08-27）

- Owner 已认可 Preview 02 的方向并授权开始开发；这不等于完整 PRD 冻结、真实录音或发布验收。
- 在现有侧栏新增“收藏”和“录音”两个独立入口，不增加第二套永久侧栏。收藏内含“空白磁带收藏”和“实体音乐库”两个视图；录音是独立页面。
- 删除 V3 概览页、设备页和旧五区域导航；母版、录音记录和设备参数在录音上下文中处理。V2 的播放设备选择不删除。
- 原型示例库存与第三方参考照片不进入正式用户数据或生产资源。未接入的能力明确标识，不提供虚假的录入成功或录音完成状态。
- V3 按独立 WAVE-5 任务线推进，沿用独立任务分支、TDD、结果报告与自动 Gate；WAVE-3/WAVE-4 的真实验收 carryover 保留。2026-08-28 Owner 已确认执行资产保留策略 F-01，见开发包。计划身份冻结与正式输出准入分离；Gate B 未认证时 Preflight 必须阻断。

## 已确认的樱花 UI 方向（2026-09-04）

- Owner 已认可 `prototypes/sakura-glass/index.html`，授权迁移到正式应用：樱粉、淡蓝、淡紫渐变背景，乳白磨砂玻璃；保留所有已有功能、按钮入口、用户数据与播放流程。
- Owner 后续明确：边栏及控件必须透出背景并有毛玻璃质感，不能以浅色实心填充代替；本轮修订的正式应用视觉仍待 Owner 确认。
- 原型只作为材质与视觉层级参考，不把模拟曲目、图库占位图、虚假的连接状态或模拟播放逻辑带入正式程序。
- 复用现有组件和图标，优先通过语义颜色与材质样式实现；避免给长列表每行叠加 backdrop-filter，保留虚拟列表的实际行高合同。
- 预览认可不等于正式应用视觉、真实音频、设备或发布验收。
- Owner 已认可居中悬浮播放栏样式（2026-09-04）；侧栏和内容面板必须铺满至窗口底部，播放栏不得在正常布局中占用整行形成空带。滚动末尾及会被覆盖的入口需要避让，但不改变玻璃背景的完整高度。

## 已认可的全窗口背景视觉（2026-09-05）

- Owner 明确认可 `prototypes/ambient-study/index.html`，要求“不改变 HTML 上的视觉效果，搬到 MB”。它是本轮迁移的视觉基准，覆盖此前樱花渐变和颗粒玻璃的参数选择。
- 默认背景复用 `default-scene.png` 原图；播放时使用当前封面，暂停保留，切歌预加载后 900ms 交叉淡化，失败恢复默认画面。侧栏、内容和浮动播放器共用连续背景，分别使用预览的透明度与模糊参数。
- 保留五列封面墙和悬浮播放器的尺寸、字体、圆角及间距；图标复用预览的 Bootstrap Icons 本地字体，不引入参考项目运行时。
- 正式业务数据、音质/设备/刷新/队列操作及虚拟列表行高仍使用现有实现；预览工具条、说明状态、模拟曲目和模拟播放逻辑不进入正式应用。
- HTML 方向已获认可，迁入正式应用后的真实账号视觉及播放体验仍须单独验收。

## 证据边界

- 自动测试、打包测试、Core Mac 实机 Gate、Owner 验收、GitHub push 分开记录。
- 受控 Fake 可以覆盖破坏性或不可重复的故障，但不得伪称真实账号、真实 Roon 或真实听感证据。
- `project/STATUS.json` 是机器读取的当前任务状态；每个任务分支都必须更新它，并保持无用户内容、无凭据、无私密环境变量。
- 详细任务约束放在 `tasks/`；架构决策放在 `docs/adr/`；阶段风险放在 `project/RISK_REGISTER.md`。

## 安全边界

Provider 凭据只允许经本地安全通道和已批准的桌面保险库流动，不进入聊天、命令参数、Shell 历史、Git、报告、日志、Renderer 或 Roon。CI 永远使用合成数据，不连接真实 Provider、真实账号或真实 Roon。

Control API 与 Stream Gateway 只绑定 loopback。V1 不下载、缓存、转码、解灰、代理替换来源或随机 IP；不把上游 URL、Cookie、Token、Roon session ID 或内部错误栈暴露到公开合同。

## 验证入口

开发机使用 Node.js 22.x 与固定 Corepack pnpm 版本。标准本地入口是：

```bash
corepack pnpm@10.17.1 install --frozen-lockfile --ignore-scripts
corepack pnpm@10.17.1 verify
node scripts/ci/verify-control-plane.mjs
node scripts/ci/verify-boundaries.mjs
```

Electron 启动、utilityProcess crash/restart 和 safeStorage 测试使用 `apps/desktop/scripts/startup-gate.mjs`；不要在 CI 中写入真实 Provider 凭据或访问 Roon。

## 报告与停止

报告必须给出 base SHA、实现/报告提交、验证退出码、carryover 和下一分支基线。遇到凭据、真实账号、Owner 人工操作或安全/播放/登录恢复 fatal Gate 时停止并报告；非 fatal 的视觉或可选能力问题记录为 bounded carryover，不跳过验收标准。
