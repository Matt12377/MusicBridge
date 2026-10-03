# RUST-011 离线候选包原生资源准入

2026-10-03。本地候选资源、原默认Node运行、外部Node→包内Rust真实协议及软件验证通过；两轮独审通过，报告与最终身份收口。**本任务未证明包内Main/Core→Rust路由，也没有启用生产默认Rust或迁移数据库写入。**

基线 `ed40e39c39db908200e946c0c13dcfc1ddc0a206`，实现 `5f56611e3ef77a2630a17fb57abf8a914cc412db`，分支 `codex/rust-core-011-native-candidate-package`。报告提交由 `git log -1 --format=%H -- reports/RUST-011_NATIVE_CANDIDATE_PACKAGE.md` 解析，最终HEAD和下一分支基线由外置 `FINAL_IDENTITY.json` 独立绑定。实现与报告分开提交，无push。完整机器总账：[RUST-011_EVIDENCE.json](RUST-011_EVIDENCE.json)。

候选实际位于 `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-011-3samm9m1/candidate-final-03/package/mac-arm64/MusicBridge Rust Resource Candidate.app`。固定Resources/darwin-arm64资源、严格清单与独立manifest SHA pin、薄arm64 Mach-O/链接/权限/闭集检查及可信解析已实现；原Main/Core、生产package及音频beforePack未改。清单schema v1对应默认snapshot wire v2，Node公开IPC v1保持。native先签名、生成清单，再打包/Fuses、复核native，最后外层ad-hoc seal并deep/strict验证，禁止重新信任邻接清单。

专用tsc覆盖TS、声明与调用方；checkJs:false不作为JS实现静态类型证据。两个.mjs的Node语法检查及实际Gate/行为检查分别通过。

冻结1069程序输入，源摘要 `d06fd33f0beebf7debec3a7e87dd9e11d846dc669ef3a097a520a92c048c8163`；最终实现Git逐项1069 blob匹配。新鲜production build及29份完整dist均匹配最终ASAR；275份Electron来源缓存未变。ASAR全部4714条目检查无私有wrapper及开发工具依赖；实际9位Fuse wire核对，原7项配置保持，6/8位保留实际缓存值。最终native SHA `2feb6d5fbe2d875228c5b0de26f016abe6377aee05a7e48977503ece899f21ef`，manifest SHA `f2f1c8b089739e843a749ea001b1162d3086ed52b324272e212e46aff8a7bc70`；完整bundle项目、CDHash、ASAR/header/Info.plist SHA均见机器总账。签名仅本机ad-hoc。

| 验证 | 新鲜结果 |
|---|---|
| 候选完整Gate03 | 退出0；专项typecheck0，163/163，零fail/skip/cancelled |
| 四套专项 | 资源48、定位22、实际协议9、严格证据84 |
| 实际原Node两库→Resources Rust | 56完整DTO对照，59请求/ACK，Node两会话自然0、Rust自然0/signal null、kill0 |
| 数据只读 | 两主库与WAL四项读取前后身份一致；关闭checkpoint变化单列，写命令由原TS侧明确拒绝 |
| 原默认候选可执行 | 原Main/preload/Core，ready1/fail0，Core0、Electron自然0，无强制清理；两次before-quit按实际顺序接受 |
| 完整软件六步 | typecheck/test/build/control-plane/boundaries/cycles退出全0；3926通过，原2 native条件skip |
| 最终签后包内binary旧回归 | lifecycle11＋host8＋refresh7＝26/26，零skip；原受控SIGKILL负例保留 |
| 独审 | 两轮PASS_IN_SCOPE，未解决P1/P2=0 |

默认Node后代观察为50ms有界采样辅以原入口字节身份，并非完整系统跟踪；该默认启动的Owner Worker退出未独立观察，另列真实Node协议两会话的退出。只读写拒绝不是Rust wire writer ACK。受控旧故障不称为全部子进程自然退出0。源码提交前的native清单source commit为基线（本期Rust源码未改），新程序由独立源摘要及实现Git blob绑定。

两次失败均保留。Gate01的Worker相对tsx加载器在根cwd失败，旧CLI打印FAILED但外层退出0，明确归类FAILED_NOT_PASS；绝对加载器和明确失败退出码已修正并补实际根cwd回归。Gate02退出1，资源/协议/默认Node局部观察成功，但strict helper误限before-quit为一次导致完整Gate失败；正例RED及重写真实日志的三个拒绝负例保留，修正后Gate03重新构建且完整通过。旧失败不计入成功次数，不累计测试重试。

生产仍默认Node，数据库唯一作者仍Node；没有真实账号、Roon、音频/录音、真实用户数据、安装替换、远端CI、push或发布。候选未认证原生产音频beforePack，原音频资源缺失警告原样保留；不影响本期离线资源合同，但不是音频功能通过。跨架构、Developer ID/公证、large wire3候选接入及生产启用分开准入。MBR-004真实恢复与Gate B carryover保持。开发测试均由代理执行，Owner只负责最终成品使用反馈。

下一步从本任务最终报告HEAD建立RUST-012独立工作树，验证可信包内Main/Core可选只读Rust路由；最终HEAD/原工作树及010手册WIP字节身份由报告提交后的外置收据核对。
