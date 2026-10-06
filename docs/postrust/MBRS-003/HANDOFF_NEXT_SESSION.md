# MusicBridge 换届交接：MBRS-003 → MBRS-004

003按Owner决定阶段完成，下一步只做004；本轮未建立004分支或实施004。首先读项目AGENTS.md、project/POSTRUST_TODO.md、003结果报告和机读证据。

## 已确认决定

- 不再重跑当前版本十万、三十万首；Owner接受历史结果用于阶段推进。
- 历史300k为300000访问、299975接受、25拒绝：读取超时20、Worker启动超时5。物理原因与逐项身份仍未知，历史技术FAILURE不改。
- 全部功能开发完成后，统一用真实曲库验收。
- 003完成后换届；保留任务历史、失败原件、用户WIP和未完成验收。

## 开始位置

003工作树：/Volumes/LifeWeave/Developer/CommandLine/worktrees/musicbridge-mbrs-003-persistent-incremental-scan

分支：codex/mbrs-003-persistent-incremental-scan

基线002最终报告：a7b27b5b6a5168bd146a3cbe61b579efd5639263

003初始实现：6e01a1d9e8f14282eedaef6065ad1368355674b8

003最终实现：85841879bf6d31b3efd0970f235c8431fed980e8

003最终报告HEAD：用 git log -1 --format=%H -- reports/MBRS-003_PERSISTENT_INCREMENTAL_SCAN.md 解析，核当前HEAD及origin分支一致后，以它新建004独立分支。不能从002或003初始实现接续。报告push后的CI与远端检查原件在外置 mbrs003-root-delivery-154-01；读取最新终态，不把源CI替报告CI。

主代理gpt-6.1-sol/max，三个子代理gpt-6.1-sol/high，禁止再派生。一个产品写作者，主控整合；其余角色调查规则和测试、审查边界。不能使用gpt-6-sol。沿用外置卷构建/缓存规则。

## 安全修正与最后CI

03f8abb报告的生产依赖审计失败已保留；最终8584187在003内只修依赖与测试DOM兼容。当前workspace verify零失败、4142通过/2既有条件跳过，定向DOM71项与003软件124项通过，高危/严重审计均零。换届前必须核对外置mbrs003-root-delivery-154-01最新FINAL_DELIVERY_RECEIPT的源/报告CI终态，不能把旧251eae9或旧03f8abb当最终基线。

## 003结果

最终本机124项与13阶段、安全29项通过，运行器此前34项证据保留并由当前CI复核；1210份声明输入绑定最终实现Git blob。首轮CI的Core构建顺序和Preload旧表问题已修，首轮失败原件保留。原8项技术验收与最终真实库/播放仍有明确边界，按报告逐项处理。

试用入口：docs/postrust/MBRS-003/TRY_OFFLINE.command；当前8584187新生产构建，离线合成服务、模拟钥匙串、每次独立外置目录。它不证明真实曲库或播放。禁止改/重建既有N/O、打开历史规模数据库、复用耗尽的旧deadline，或擅自新建规模轮次。

## 004只做的事

移植名称、专辑和版本纯规则，保存raw与版本信息，给出可靠候选并保留人工覆盖；canonicalKey只用于候选匹配，不能成为歌曲/版本身份。关闭AI仍能按确定性规则建库；最终播放依后续任务接续。不得复制CoverDrop AppModel、UI、数据库、联网服务或扫描I/O。

原规格：/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-015-i0qxwbi7/postrust-v1.2-readonly/MusicBridge_PostRust_Execution_Pack_v1.2/tasks/MBRS-004.md

CoverDrop实际仓库：/Volumes/LifeWeave/Swift/CoverDrop，main，已只读核HEAD为93fa28f3245da50cf9b5341e0df1466fa4f6a0e7。工作树有WIP，重新核身份并仅读取该提交版；实际origin为Matt12377/CoverDrop，执行包的CoverMate名称须说明。selected_commit未冻结，本地未见许可声明，不能写成MIT。

最小规则来源：

- Domain/Policies/AlbumNameCleaning.swift
- Domain/Policies/AlbumDisplayNameCleaning.swift，改接纯输入类型
- FileSystemLibraryScanner.swift提交版的目录角色/CD/版本判定函数
- 可选AppConfiguration.swift的CoverSearchKeyword.make小函数

全部适用golden：

- AlbumNameCleaningTests三组60输入及幂等断言
- AlbumDisplayNameCleaningTests七组
- AlbumNameEnhancementTests122–164四组共享规则；移植可选建议时再纳入纯JSON/截断测试
- FileSystemLibraryScannerTests1–343十七组及491–535三组，适配为纯目录事实
- AppConfigurationTests的coverSearchKeywordUsesArtistAndAlbum

先保存raw与重制/首版/格式等版本token再清洗展示名；可信度按整专辑覆盖率计算，不能把1/20有效标签判成高可信。六AT覆盖全部适用golden、语义保留、不误合并版本、候选可信度、人工覆盖与CD边界、AI关闭的独立运行。包内八个例子不能替全部golden。

004从003最终报告HEAD起独立分支、冻结精确来源/文件范围、实现提交、报告提交与自动Gate。优先完成这些产品工作；真实账号、实际播放、Source写入、发布及最终Owner验收仍按各自授权和证据处理。
