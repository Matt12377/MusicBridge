# RUST-010：可见合成人工验收入口

状态：本地实现、适当验证和两轮独审完成，独立实现与结果报告保存；Owner 人工验收尚未执行。生产默认继续 Node，生产数据库仍由 Node 独占写入。

## 身份与实现

base `5fc369a46b37fec4ad50ebb909aa1f2c4bc09d09`；分支 `codex/rust-core-010-synthetic-owner-session`；独立工作树 `/Volumes/LifeWeave/VSCode/MusicBridge/worktree/rust-core-010`。程序冻结06为1,110文件，SHA `ec00577670bfee535799d149b496915b144799ebfd0deef03c74d824ae28bee2`；原009的1,104个输入逐字节保留，仅新增6个程序输入。外置证据根 `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-010-9ytao7v6`。实现提交 `cffb57998e5a6e29da7244f1132eb73a7530e623`；1,110份Git blob与冻结完全一致；报告提交由 `git log -1 --format=%H -- reports/RUST-010_SYNTHETIC_OWNER_SESSION.md` 解析，不写自引用SHA；下一任务以最终报告HEAD为基线。提交后的清洁、远端、原工作区WIP及全部Git blob身份由外置 FINAL_IDENTITY.json 保存。

原009自动页面会隐藏并自行退出。本期增加可见、focus、明确合成标题的30分钟入口，闭集为node100/rust100/rust2000/rust5000，默认node100。每次创建新外置profile，原Node helper seed后关闭，再启动原Main/Core/Owner/preload/Vue；只有可信本地driver可以选择模式或发出status/refresh/quit。原生产程序、默认入口、旧fixture和Rust没有修改。

显示前冻结实际IPC范围及原生文件对话框，保留原handler和按钮；范围外操作明确拒绝。原收藏policy仍经原表单、durable outbox和Node单次写入。Rust只承担只读投影；写后旧快照撤回并回退Node，明确refresh恰一次恢复，原1500ms空领取worker保留。原托盘上一首/下一首/停止只走CORE_TEST_MODE合成状态，未纳入人工验收，不能把IPC拒绝扩大成所有播放入口阻断。

驱动接管启动期间的信号收口：仅固定Playwright1.62.1完整bundle及三个精确回调的本次launch注册被隔离，既有及其他监听器保留，原descriptor恢复；不修改依赖。中断共用原隐藏Main的DOM启动屏障，稳定后单次原app.quit，不显示窗口或发布ready；真实中断失败现场及资源退出单独验证。

## 新鲜验证

| 验证 | 结果与证据范围 |
| --- | --- |
| 新会话build06 | 6步骤退出0；专用类型、39/39行为、原组件隔离构建、固定pnpm和启动器语法；无skip |
| 可见smoke06 | 原Vue四模式、默认.command，以及starting SIGINT受控负例；Gate退出0 |
| 实际收据准入 | 96/96通过，零fail/skip；使用同批四模式真实session，不以缺输入skip替代 |
| 当前真实Rust适当回归 | 生命周期11＋宿主8＋刷新7，共26/26，零skip；666输入稳定，复用009固定binary，未重跑旧完整30步Rust Gate |
| 完整软件 | 六步各退出0；254 contracts＋2,422 core＋1,250 desktop＝3,926通过；原2 native条件skip保留，零新增skip；cycles384文件 |
| 默认应用启动 | development、production原startup Gate各退出0，mock-keychain，工具/基本系统环境白名单，默认Node；不是系统钥匙串或已安装应用验收 |
| 构建后身份 | 1,110程序、原009全部1,104输入、666回归输入、898组件输入/38产物、275 Electron资源、native/Playwright/依赖/启动器当前身份匹配 |

四正常模式与实际默认CLI共5个会话均通过原app.quit/before-quit自然收口；Electron/Core/Node Owner为0，Rust三个模式初始与刷新共6个child具有prepare/boot/close ACK并自然0，forcedCleanup=false。受控starting SIGINT是driver1、state=failed、无ready，但Electron/Core/Owner均0且原before-quit已观察；它是有效失败收口负例，不能记正常session或Owner通过。

smoke有7幅实际页面截图、20个报告动作条目；三Rust场景各一次原policy保存、Node回退及单次显式refresh，关闭后只读SQLite对照各一条succeeded且acknowledged记录。动作条目包含probe组合及只读对照，不能按条目数冒称20次人工操作。旧009的189动作/295参照是历史证据，不计本期新PASS。

build时manifest.sourceSha表示原009 Git基线；898组件输入及sourceAggregate、新6程序/完整1,110冻结绑定实际受测字节。全软件与两个默认入口会重新构建默认dist，之后独立POST_SOFTWARE_IDENTITY再核组件/合同dist和全部准入；没有靠先前绿色日志覆盖后续产物。

机器明细见 [RUST-010_EVIDENCE.json](RUST-010_EVIDENCE.json)，包括每步argv、退出码、日志SHA、资源和收据路径。两轮独审完成，未解决P1/P2=0；第二轮收据 review-010-round2.json SHA `f9dd3c972cfe33ab1cbf3903f0cf6b4d6eb83ea54da77c79bdf70c3c4692aadb`，绑定实现Git、51最终报告引用、66命令总账与软件/默认启动/当前产物。报告提交后的最终Git身份另由主代理核，不重复完整测试。

## 保留的失败与修补

错误contracts filter退出0但没有实际构建，不记PASS；正确filter真实构建0。CJS解析import-only合同包有有效RED，改ESM实际链接准入后通过；另一次错误tsx路径属于准备失败。CLI/期限积压有有效RED，后续保持原断言通过。中间类型/VM记录器问题的日志保留，最终专用类型与实际Electron证明修复。

smoke03的Playwright回调抢占SIGINT令driver130、closing未落failed，整轮FAIL；精确本次监听器隔离后smoke04落failed，但原bootstrap稳定前quit导致Electron1，仍FAIL。增加共享原隐藏Main启动屏障，最终39行为及fresh06真实中断证明driver1/failed/noReady、全部资源自然0。信号行为夹具22没有活动句柄导致未决top-level await退出13，是夹具准备失败，不能冒称生产RED。

smoke05通过后原96准入测试仅95通过/1失败：越界profile先realpath时得到ENOENT。只在helper先检查词法包含关系，再做范围内realpath；96项原断言及测试字节保留，最终06全通过。独立构建后汇总脚本01/02误读sourceFiles计数和driverExit对象，是外置只读汇总准备错误；程序/测试未改，第三次完整身份核对通过。

最终命令总账绑定66份顶层收据及日志，其中16份非零，包括有效RED、未准入Gate、类型/准备/夹具失败。内层Gate、软件、启动和回归另由manifest绑定；重跑不相加为独立用例数。Electron源前/目标/源后完整275资源与链接一致，APFS复制已存在外置依赖，未安装/下载；008历史缓存I/O缺口不追认为合规。

## 人工入口与范围

已实际验证的0700启动器 `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-010-9ytao7v6/human-gate-06/start-synthetic-owner.command`，SHA `38f63fdcbf3b3cd0c2511faf1589ed50f410c2d8c9869e3f1a0368e733479635`，默认node100/30分钟；可选参数仅`--mode=rust100|rust2000|rust5000`，不能换profile/manifest/期限或用accept。匹配外置产物或依赖发生漂移时拒绝，不隐式修复/安装。

操作见 [人工验收手册](../docs/acceptance/RUST-010_SYNTHETIC_OWNER_WALKTHROUGH.md)，进度见 [TODO](../project/RUST_CORE_TODO.md)。Owner须在本聊天反馈原收藏浏览、筛选/详情、合成policy、Node回退/显式refresh与退出；机器收据始终ownerAcceptance=NOT_RUN，自动点击不替代。

真实Provider/账号/Roon/音频播放/录音、真实用户库迁移/Rust生产持久化、设备/PDF、系统钥匙串、签名/安装替换、远端CI/push/发布/main merge仍NOT_RUN。默认2000/4MiB、显式5000/8MiB、128每块/最多40/1MiB帧不扩大。MBR-004真实Roon根因/恢复、Gate B P4/P5及Owner待验保留；本任务本地交付不代表整体Rust升级或人工验收已完成。
