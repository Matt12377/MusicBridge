# V1 / V2 集成结果：以 V1 为基线接入完整 V2 本地音乐库

## 身份与 Git 边界

- 固定工作树：`/Users/yihe/VSCode/MusicBridge/worktree/v1-v2-integration`
- 集成分支：`codex/v1-v2-integration`
- V1 基线：`3095b2c5fd8f2a575d779119d6c43d9069db6349`（`codex/bugfix`）
- 合并前 RED 契约提交：`ea1ec88f6d5f5e87114cd01fb84e734b2fe055e3`
- V2 输入：`4d895197b1b005d1995c878ee4f1384a493c3039`（`codex/v2-preflight-roon-capability-probe`）
- 集成实现 merge commit：`8a0fd4e535406e46d7feedb6d24abac7322e6391`
- merge parents：`ea1ec88f6d5f5e87114cd01fb84e734b2fe055e3`、`4d895197b1b005d1995c878ee4f1384a493c3039`
- 报告提交：本报告所在的后续独立文档提交，最终 SHA 以交付时 `git rev-parse HEAD` 为准。
- 外部操作：未 push、未创建 PR、未合并到 `main`、未部署、未修改远端，也未修改 V1/V2 来源工作树。
- `apps/desktop/test-results/` 是集成工作树中的 E2E 产物，保持未跟踪、未暂存。

## 集成原则

本次不是把 V2 的旧产品壳覆盖到 V1 上，而是以 V1 已修复的 UI、公开合同、Provider 行为、队列、歌词、Now Playing、分页和错误语义为产品基线，将 V2 能力逐层接入 Contracts、Core、Main、Preload 和现有 Renderer 页面。

冲突处理规则已经固化在 `docs/adr/ADR-007-V1-V2-LOCAL-LIBRARY-INTEGRATION.md`：

- V1 与 V2 冲突时，保留 V1 的界面和用户行为；
- V2 的本地音乐库、原生 Roon 播放及远程开发能力作为增量能力全部保留；
- Provider、Roon、Main、Preload 与 Renderer 之间继续使用类型化、可校验、fail-closed 的公开边界；
- 自动 Gate、真实 Provider、真实 Roon/Core Mac 和 Owner 验收分别记录，互不冒充。

## 已接入的 V2 功能

| V2 能力 | 集成结果 |
|---|---|
| Roon Library 基础与可选 SDK | 接入 Core；Roon Browse/Image 服务缺失时不破坏既有 transport |
| Albums、Artists、Genres、Playlists | 接入 V1 侧栏和内容区，包含分页、空态、追加失败和重试状态 |
| Album/Artist detail、Roon search、artwork | 通过类型化 Preload API 接入；runtime reference 不进入持久化边界 |
| Typed Play、Queue、Pause/Resume、Stop | 接入 V1 统一播放状态和队列控制，不建立第二套 Renderer 播放状态机 |
| Seek 与 Zone capability | 只有原生 Roon 且 Zone 明确 `seekAllowed=true` 时开放；V1 Provider 进度仍只读 |
| 本地 Track/Album/Artist favorites | 接入串行、原子持久化仓库以及 Renderer 收藏页 |
| NetEase likes 与 Roon matching | 接入显式 like 查询/修改、匹配状态、缓存和双身份 Heart |
| Smart playback 与混合队列 | 已确认匹配才选择原生 Roon；未知匹配保持 V1 Provider 并后台预热 |
| 现有队列项直接播放 | 新增有界 queue-index 合同；选择项目不再把混合队列塌缩成单曲 |
| Remote Roon control 与 Core websocket | 接入 loopback-only 控制边界、固定端口对和有界远程能力 |
| Secondary ports 与 pairing guidance | 保留 V2 远程开发入口，并明确 Dev Mac extension 的 Owner 配对步骤 |

## 以 V1 为准的冲突决议

- 保留 V1 页面层级、响应式布局、虚拟列表、搜索“艺人 / 专辑 / 单曲”分区、歌单与收藏分页、全屏歌词、Now Playing 和统一底部播放器。
- 保留 V1 NetEase track ID 作为 Smart 队列的逻辑身份，因此切到原生 Roon 后仍可关联歌词、Provider 收藏和历史记录。
- 保留 V1 搜索修复：公开搜索请求不转发 cookie；失败结果不缓存；认证与 Core 错误映射为可操作且不泄露内部信息的公开错误。
- 未确认或非唯一匹配不会阻塞第一次播放，也不会在歌曲中途把 Provider 切成 Roon。
- V1 Provider Audio Input 不开放 seek；V2 seek 只扩展到明确可 seek 的原生 Roon Zone。
- V2 页面嵌入现有 V1 侧栏和内容区，没有采用 V2 旧版 `App.vue` 或样式覆盖 V1。

## 集成时修复的 V2 问题

- Browse、load、image 和 transport callback 全部加入有界超时，避免 Core 请求永久悬挂。
- 未知、删除和移出资料库等 Browse Action fail-closed；只有 allowlist 中的类型化动作可执行。
- Roon runtime UUID 使用完整 128-bit 十进制映射生成兼容 track ID，避免旧 32-bit 哈希碰撞。
- 本地收藏写入串行化并使用原子替换；写入失败回滚内存，损坏文件拒绝静默覆盖。
- Roon 列表共享统一 loader；修复 initial retry 与 load-more 竞态，旧响应不能覆盖新状态。
- 匹配缓存加入 TTL、容量和 Roon 可用性失效；瞬态 unavailable 不缓存；批量 Browse 并发不超过 3 且保持输入顺序。
- Smart 播放只使用已确认的缓存匹配；原生 Roon 启动失败时先有界停止残留 session，再回退 V1 Provider。
- Smart 队列项在原生 Roon 播放期间保留 NetEase 双身份；无本地 descriptor 时仍保留歌词和 NetEase Heart，有 descriptor 时同步本地 favorite。
- 直接选择混合队列中的 Roon 项改为按索引播放，不再错误调用单曲 `replaceQueue` 破坏前后队列。
- NetEase like 状态与 mutation 必须收到明确成功字段；含糊响应不再默认成未收藏或成功。
- 进入没有本地 descriptor 的原生 Roon 曲目时只清理陈旧的本地 favorite，不错误清掉 Smart 的 NetEase 身份。
- Renderer→Main→Utility 的 payload 在 IPC 边界克隆并验证；公开类型不使用可绕过校验的 `any`。

## TDD 与审查结果

- 合并前先提交 V1/V2 冲突契约测试 `ea1ec88`，确认 V2 未接入时为 RED。
- 每个后续缺口都先以定向失败测试复现，再实现：列表 retry 竞态、收藏原子回滚、回调超时、匹配缓存与并发、Smart 回退与双身份、队列索引保留、like 含糊响应拒绝。
- 规格审查最终结果：Spec PASS；没有其余 Blocker、Critical、Important 或 Minor。
- 代码标准审查的实现类问题均已处理；保留一个结构性 carryover：`App.vue` 体积较大，后续可在不改变 V1 行为的独立任务中继续提取 composable，不能在本次合并尾声冒险重写。

## 自动验证（最终实现源码）

所有命令均在集成工作树、Node.js `v22.23.2`、pnpm `10.17.1` 下执行；退出码均为 0。测试使用 synthetic/fake 边界，不连接真实 Provider、真实账号、真实 Roon 或 Core Mac。

| 验证项 | 结果 |
|---|---|
| `corepack pnpm@10.17.1 install --frozen-lockfile --ignore-scripts` | PASS；lockfile 无需更新 |
| `corepack pnpm@10.17.1 verify` | PASS；typecheck、Contracts 26/26、Bridge Core 262/262、Desktop 117/117、production build |
| `node scripts/ci/verify-control-plane.mjs` | `CONTROL_PLANE=PASS` |
| `node scripts/ci/verify-boundaries.mjs` | `BOUNDARIES=PASS` |
| `node scripts/ci/verify-cycles.mjs` | `CYCLES=PASS files=79` |
| `corepack pnpm@10.17.1 test:security` | PASS，19/19 |
| `corepack pnpm@10.17.1 test:electron` | PASS，4/4 |
| Desktop development / production startup Gate | `DESKTOP_STARTUP_PASS=development`、`DESKTOP_STARTUP_PASS=production` |
| `corepack pnpm@10.17.1 test:e2e` | PASS，Playwright 10/10；axe 无 critical/serious |
| `corepack pnpm@10.17.1 audit --prod --audit-level high --registry=https://registry.npmjs.org` | PASS，`No known vulnerabilities found` |
| `git diff --cached --check` 与冲突标记检查 | PASS；无未解决冲突 |

默认 `npmmirror` 不提供 npm audit endpoint，因此第一次审计命令没有产生安全结论；随后只把审计查询切到 npm 官方 registry，依赖和 lockfile 均未改变，并取得上表 PASS 结果。

## 控制面与外部 Gate

`project/STATUS.json`、`project/WAVE-3.yaml` 和任务索引仍保持继承的 TASK-036 编号身份。本集成是 Owner 发起的未编号本地分支；本次没有擅自发明 TASK-042 或改写 V1 控制面。`CONTROL_PLANE=PASS` 只证明现有控制面文件彼此一致，不代表该未编号集成已经获得 direct-main、发布或下一任务授权。进入 `main` 前仍需 Owner 明确给出控制面重基线/合并决定。

以下真实验收尚未执行，也不会用自动测试代替：

- 真实 Provider 登录、任意关键词搜索、歌词、收藏、连续播放与登录恢复；
- 在真实 Roon 中启用 Dev Mac extension、配对、浏览本地库、封面、播放、队列、暂停/恢复、stop、seek、favorite 和 Smart matching；
- Core Mac 部署、端口健康、真实 Signal Path、签名/公证包与 Owner 听感/UI 验收；
- push、PR、`main` 合并和公开发布。

## 结论

**本地 V1/V2 源码集成与自动化 Gate PASS；V1 是冲突基线，V2 功能已作为增量能力接入。未 push、未合并 `main`，真实 Provider/Roon/Core Mac 与 Owner 验收仍为独立待办。**
