# RUST-010 — 合成人工验收入口

Owner 已授权持续开发到人工验收；本期把 RUST-009 隐藏自动 UI Gate 接成可见、持续交互的合成会话，不扩展真实服务、用户库、默认运行路径、安装或发布授权。

base `5fc369a46b37fec4ad50ebb909aa1f2c4bc09d09`，009最终报告；分支 `codex/rust-core-010-synthetic-owner-session`，工作树 `/Volumes/LifeWeave/VSCode/MusicBridge/worktree/rust-core-010`，外置证据 `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-010-9ytao7v6`。依赖最终身份 cf0b079a070c28f3b5e00469226b7d87499e35235a35946b8ba8d5efdddc3502 与只读入口审计 3d941b6776eca4ca48cf1badb35d4ed03546b3b7f9051a6c5381e7d457d75994 已核。

## 完整目标与冻结边界

1. 独立、明确本机 macOS 的合成 session CLI；默认 node100，仅闭集 node100/rust100/rust2000/rust5000静态 wrapper可选。选择只属于可信本地driver，不由Renderer/env/公共IPC/父消息选择Rust。无需改009既有16宿主文件或生产Main/Core/Owner/preload/Renderer/Rust源码。
2. 启动前核LifeWeave挂载外置且可写、Node22、固定pnpm、完整新driver/config/test及已有组件source/artifact、Rust binary和现有Electron全部275文件/链接身份；路径/链接/身份漂移拒绝，不隐式安装、下载、找系统Electron或回落本机缓存。组件构建manifest与本期新驱动身份分别绑定，不能把原baseSHA当未提交源码SHA。
3. 每次创建全新外置sessionRoot与 `musicbridge-ui-e2e-` 合成profile，启动前按009原helper完成100/2000/5000 rich seed与关闭，拒绝已有profile/真实用户数据。Main设置离线testBridge、CORE_TEST_MODE、显式mock-keychain，scrub凭据环境；所有tmp/log/profile/cache外置。原后台1500ms打印worker照常运行。
4. 实际原Main窗口show/focus，锁定明确“合成人工验收”的固定标题；显示状态必须由实际BrowserWindow/Renderer证明。保持原生产控件与preload；不替换 window.musicBridge、不注入业务数据/假成功、不重做UI或隐藏入口。新可信driver在原窗口显示前冻结实际IPC允许列表，明确拒绝远程Core、账号、真实文件导入、播放、录音及输出的范围外IPC，以及原生文件选择/导出对话框；原收藏浏览与合成policy仍经原handler和Node/outbox。不能仅凭offline变量宣称隔离，需实际拒绝证据。原Main托盘的上一首、下一首、停止只作用于固定CORE_TEST_MODE合成状态，保留为未纳入人工验收的入口；不把IPC阻断扩大为所有播放入口阻断或真实音频验证。窗口不能因Mac红点隐藏被误认为退出。
5. 默认30分钟有界会话，禁止宣称无限常驻或生产打包品质；测试可用受控更短会话验证到期收口，不能改变生产/Rust原预算。Terminal仅status/refresh/quit，串行精确指令，每次refresh仅一次、无自动重试/重放。scope/generation由实际可信控制观察，Node无Rust私有controller为合法默认。用户通过原表单改合成policy→原outbox单写→Node回退；人工明确refresh恢复。
6. readiness分层：实际可见页面、NodeOwner/Core/固定Rust完整ACK、原worker至少2次公开空claim及正确scope/profile；默认Node零Rust/零导出。受控smoke可做少量原控件与终端指令验证，但标记自动，不能把脚本点击当Owner动作/验收。必要时生成固定、安全引用的启动.command作为产物，额外绑定其内容/权限/路径并实际验证；不更改默认或已安装App。
7. quit/正常菜单/到期通过原app.quit触发Main before-quit，记录真实Owner close→exit→closed、Core exit0、每Rust prepare/boot/close ACK与自然exit0以及Electron code0/signalnull，forcedCleanup=false才可记自然收口。超时/中断完整保留未闭资源和日志，明确失败；不得把kill/application.close/窗口隐藏作自然退出。保留所有profile/结果，不清理。
8. 本期session收据独立严格验收；源码/产物/executable漂移、默认模式出现Rust、缺可见/ready/两claim、profile或scale错配、坏ACK/退出与强制清理必须拒绝；进行中没有最终退出证据只能readiness，不可PASS。ownerAcceptance固定NOT_RUN，Owner通过本聊天的明确反馈另记，CLI无accept命令，自动验收不推定Owner通过。仅安全状态/计数/标识进入仓库状态/报告，合成运行日志留外置。

## 文件与四角色

用户最新指定四个sol6.1/high角色优先于旧AGENTS3/max；主代理按会话sol6.1/max约定整合。平台含主代理四活动槽，三作者后第四独审，不再派生。

- 作者1：新 `apps/desktop/scripts/rust-collection-human-session.ts`、`apps/desktop/e2e/rust-collection-human.tsconfig.json`、`apps/desktop/test/rust-core/rust-collection-human-session.test.ts`。严格CLI、预检/全新seed、可见会话/串行控制/有界退出，行为测试；对外输出 schema 和driver API先与作者2协调。原009文件只读复用。
- 作者2：新 `apps/desktop/test/helpers/rust-collection-human-evidence.ts`、`apps/desktop/test/rust-core/rust-collection-human-evidence.test.ts`。严格独立新收据验收和拒绝，输出类型及API与作者1协调；不修改作者1文件。
- 作者3：新 `docs/acceptance/RUST-010_SYNTHETIC_OWNER_WALKTHROUGH.md`，只读审计启动存储/环境/默认Node/权限/真实服务边界和实际人工操作路径，形成外置审计；命令以真实实现和最终artifact为准，未验证不写已就绪。
- 第四角色：独立审查，最多两轮，外置收据；不写生产源码、不重复完整Gate。

主代理：任务/合同/ADR/索引/STATUS/TODO、独立自动Gate/调用入口与验证环境、合成smoke、源码/产物/日志/资源身份、实现/报告两个提交。新增CI文件 `scripts/ci/verify-rust-human-session.mjs` 归主代理；不降旧Rust Gate。

## 验证与交付

先用能捕获违规行为的准入/控制/关闭拒绝测试；新专用tsconfig覆盖全部新driver/helper/test。独立自动Gate至少专用类型/严格行为/组件隔离构建+新driver身份、可见真实Electron合成smoke与最终session验收；无条件缺失skip。新程序冻结后完成匹配源码的完整软件六步及适当旧Rust回归；相同生产源码的历史Gate只是历史，不冒称本期新测试。

本地smoke就绪、自然退出和Owner可交互启动器是三个独立结论。交付实际可运行且严格准入的入口后再请求Owner操作，原可见窗口会话和反馈仍须另记。适当验证后只因新改动/失败/未解风险扩测。两轮独审、明确文件暂存、实现/报告独立提交，最终清洁/HEAD/remote/原WIP核验；不推送。保留009全部失败和缓存carryover，不重写旧结论。

真实Provider/Roon/账号/播放/录音、真实用户库/迁移/生产持久化、设备/PDF/系统钥匙串、安装/签名/发布/push/main merge仍未准入。MBR-004和Gate B P4/P5 carryover保持。Owner验收未发生前不能完成“持续开发到人工验收”目标。
