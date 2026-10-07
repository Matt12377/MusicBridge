# MBRS-009 正式 UI R2

候选 02 的六项 R1 UI 问题已在源码及相应有界软件证据中解决，本轮判定 **APPROVE_SOURCE_WITH_BOUNDED_CARRYOVER**。没有新 P0/P1/P2；原更多菜单 P3 保留。此前预检不计正式轮次；这是第二且最后一轮，不安排第三轮。普通 App、像素、真实环境、100k 负载和 Owner 各自独立待验。

只读审查：没有改 checkout、编译、测试、启动 App、操作 CUA、联网、生成规模数据、提交 Git 或派生代理。Reviewer 为 `gpt-6.1-sol/max`，使用现有 Emil 审查格式与风格。

| 输入 | 字节 | SHA-256 |
| --- | ---: | --- |
| writer/CANDIDATE_02.json | 178564 | `36e6c34fd80b300e0c8dc952247069bc6aeb278a6fa288d0b612e4c9772c03f2` |
| ROOT_CANDIDATE_02_CHECK.json | 163197 | `9130bc8262a31737ec7b95bb64aca9e8c117db399713278c6e03d192e91dae0f` |
| checkout/docs/postrust/MBRS-009/EXECUTION_SCOPE.json | 13275 | `c3b717fb8b0afa298d6557bd7232043a717e67aca7c07052ae5813723098e2ad` |
| checkout/scripts/ci/mbrs009-local-library-ui-scope.json | 4312 | `c27af09acea65cdaa52d435f1dc47f8c55d32168128aa725a9ed3dd916d6582d` |
| checkout/docs/postrust/MBRS-009/STATE_MATRIX.json | 6253 | `fd5b2342d3fcb15afe78194741773fd55b1a50531d2e9a0ae21204836903febb` |
| checkout/scripts/ci/verify-mbrs009-ui-render.mjs | 7479 | `9d4e2fc018fee8673a721b4667975994f3cc307296627cb675ab95773fe369d3` |
| root-gate-02/gate-output/manifest.json | 257323 | `abc7db943b0a327ad38c12448271fc7d4c077b06a617c859a21cc14a75fa3a4d` |

Base/实读 HEAD：`418389708ca9400dbe347da448a829b9481dbb84`；分支 `codex/mbrs-009-local-library-ui`。实读候选产品 28 文件、测试 10 文件全部逐字节匹配。Root 候选独立校验为 198 引用/71 收据/671 Core 与合同源码身份；本 reviewer 没有把 Root 执行改称自己执行。

| Before | After | Why |
| --- | --- | --- |
| UI-R1-01（原 P2） 原 override 和 relocation 的未知结果无法随原 Outbox 成功或拒绝终态恢复；离页确认后列表隐藏会丢失恢复机会。 | pending 保留原 commandId、command、dataset 与 mutation generation；Panel 发布 typed 原 overview。同身份 succeeded/rejected 才缓存或消费，离页只缓存，返回重新读取当前 dataset 后消费被 ACK 过滤的原终态，再读最新曲目修订。 | 成功后可以继续独立新编辑，拒绝后保留拒绝提示；uncertain、dismissed、异 dataset、异 command/ID 和迟到读取都不能误清锁或制造重发。 判定：RESOLVED_SOURCE_AND_BOUNDED_SOFTWARE |
| UI-R1-02（原 P2） 没有本页回执、回执在途或丢失时，已确认的当前本地 Playing 被显示为未点播；最近队列请求能遮住当前观察。 | 派发前保存 request，回执结果/未知与当前公开 snapshot 分列显示。当前事实独立校验 source、currentTrack、selected Zone、队列 track/asset/revision、MB ownership 和原 Roon observation/correlation；最近请求仅说明自身结果。 | accepted、BYTES_SENT、追加队列以及旧请求 ID 都不能生成 Playing；UNKNOWN/OWNERSHIP_LOST 只说明未知所有权与暂停自动推进，只有 EXTERNAL/native-external 才断言外部接管。 判定：RESOLVED_SOURCE_AND_BOUNDED_SOFTWARE |
| UI-R1-03（原 P2） 721–800px 落入旧全局隐藏序号与新五列的冲突；132px 容不下三个 44px 按钮与两处 5px 间距。 | range adapter 在 <=800px 同时转为文字和 142px 操作列；旧序号/封面布局明确覆盖，三个按钮各 44px、gap 5px、行高继续 84px，宽屏保留开放封面行。 | 3×44 + 2×5 = 142；共享 virtualWindow 的 84 常量与 CSS 合同一致，保持原表格而无需复制第二套列表。 判定：RESOLVED_SOURCE_GEOMETRY_CONTRACT_PIXELS_PENDING |
| UI-R1-04（原 P2） role table/row 没有 columnheader/cell，旧 header display:none 会排除表头。 | 实际 DOM 提供歌曲/时长/操作 3 columnheader，已载行及占位行均 3 cell；序号/封面/独立 album 装饰 aria-hidden，spacer 装饰。1px 裁切表头使用 display:flex!important 覆盖旧 display:none；窄窗时长裁切仍保留 cell。 | 逻辑列与 aria-colcount、rowcount/index 一致；歌曲 cell 包括作者/专辑，默认和 range 模式共享语义。 判定：RESOLVED_SOURCE_SFC_AND_SSR_SEMANTICS_BROWSER_AX_PENDING |
| UI-R1-05（原 P2） 本地 open-queue 直接令 inspectorOpen=true，跳过原 openQueue/openInspector 的保存、初始焦点与关闭返回。 | 本地事件直接调用原 openQueue；原 rememberInspectorFocus/openInspector/closeInspector 路径负责聚焦关闭按钮及返回入口，并使用 preventScroll。 | 一个现有 Inspector 与播放器继续承担队列交互，键盘用户不会因为打开队列丢失原入口位置。 判定：RESOLVED_SOURCE_AND_BOUNDED_SOFTWARE |
| UI-R1-06（原 P2） 同一 error 容纳读取和业务错误，后续成功轮询仍遗留读错误，或清读错误会误清未知业务。 | readError/actionError 独立；最新 generation 成功读取只清 readError，失败保留上次数据，业务未知不随成功轮询清除。 | 目录读恢复应消除旧读故障；无法确认的业务动作仍提醒用户核对原请求，不能用成功读取替代业务确认。 判定：RESOLVED_SOURCE_AND_BOUNDED_SOFTWARE |

逐项源与可检验例：

- **UI-R1-01**：[源码](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-mbrs009-mhocj_g8/checkout/apps/desktop/src/renderer/src/composables/application/useLocalLibrary.ts:137)、[行为测试](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-mbrs009-mhocj_g8/checkout/apps/desktop/test/mbrs009-local-library-session.test.ts:151)。原显示更正或 relocation 丢 ACK → 离页 → 在全局 Panel 收到原成功/拒绝并确认隐藏 → 返回同 dataset：原锁释放且读取新修订，原派发次数仍为 1；返回异 dataset 则继续保锁。
- **UI-R1-02**：[源码](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-mbrs009-mhocj_g8/checkout/apps/desktop/src/renderer/src/components/player/details.ts:35)、[行为测试](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-mbrs009-mhocj_g8/checkout/apps/desktop/test/mbrs009-local-library-session.test.ts:112)。匹配公开 Playing + 无 receipt/另一首 APPEND receipt/本次丢 ACK，当前观察仍显示已确认；公开曲目、asset revision 或 Zone 失配时不得显示确认播放/暂停。
- **UI-R1-03**：[源码](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-mbrs009-mhocj_g8/checkout/apps/desktop/src/renderer/src/components/media/TrackTable.vue:53)、[行为测试](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-mbrs009-mhocj_g8/checkout/apps/desktop/test/mbrs009-local-library-ui.test.ts:96)。Root 在实际生产窗口取 721/760/800/801px，检查每个已载行 84px、操作列 142px、三个按钮各至少 44px，无遮挡/横向溢出；目前只确认源码合同。
- **UI-R1-04**：[源码](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-mbrs009-mhocj_g8/checkout/apps/desktop/src/renderer/src/components/media/TrackTable.vue:182)、[行为测试](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-mbrs009-mhocj_g8/checkout/apps/desktop/test/mbrs009-local-library-ui.test.ts:112)。加载页、等待页及 <=800px 表格应仍有 3 header/每行 3 cell；在实际浏览器可访问树确认 header 未被 display:none 排除。
- **UI-R1-05**：[源码](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-mbrs009-mhocj_g8/checkout/apps/desktop/src/renderer/src/App.vue:625)、[行为测试](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-mbrs009-mhocj_g8/checkout/apps/desktop/test/mbrs009-local-library-ui.test.ts:129)。键盘聚焦本地“打开原播放队列” → 打开 → 关闭：关闭按钮取得焦点，返回原入口且 scrollTop 保持；真实窗口仍由 Root 核对。
- **UI-R1-06**：[源码](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-mbrs009-mhocj_g8/checkout/apps/desktop/src/renderer/src/components/settings/LocalLibrarySettings.vue:7)、[行为测试](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-mbrs009-mhocj_g8/checkout/apps/desktop/test/mbrs009-local-library-ui.test.ts:120)。读失败 → 成功轮询：读警告消失；另一次业务未知 → 读失败 → 读成功：业务警告始终保留。

| Before | After | Why |
| --- | --- | --- |
| UI-R1-O1（P3）：原更多菜单没有完整键盘开关、方向键、Escape 与返回焦点。 | 保留为继承的 bounded carryover，本轮未改称解决。 | 不因此重构菜单或开启第三轮，真实键盘验收也未声明完成。 |
| UI-R1-O2（P3）：详情仅保存 DOM trigger，卸载或离页后会丢失目标。 | session 保存稳定曲目/窗口/查询/滚动，按原查询恢复有界行并 preventScroll 聚焦；查询改变或目标消失回搜索，代际防止迟到焦点。 | 实际 SFC 宿主覆盖虚拟卸载及离页重建；源码最小恢复已解决，真实窗口焦点/滚动仍由 Root 核对。 |

原侧栏只加一个本地音乐入口，Roon、网易云歌单、收藏、设置和原 BottomPlayer/Inspector 保留。rangeWindow/row-detail 适配复用 TrackTable；页 100、缓存 6、行 84px，未增加第二套表格/侧栏/播放器/队列，也未引入框架或动画库。详情显示原始/更正/生效信息、已存发行关系与名称线索，解析参数和实际 Roon 输出分开；UNKNOWN/OWNERSHIP_LOST 不断言外部接管，Inspector 的 MB 已保存队列不冒充外部下一首。

软件收据分层：最终 writer 新增 Desktop 40 + 原回归 39 全部通过，无失败/跳过/取消/todo；此前另外 141 项仅凭源码未变沿用历史结果。离页 Outbox 追加行为完整 TAP 为 RED 3 fail → GREEN 3 pass，随后包含在最终 40 项。SFC host 编译并调用实际组件/协调器，DOM、计时器、API 与 Artwork 使用受控宿主，不能证明 CSS 像素或真实可访问树。

Root **Gate02 新鲜运行**的 11 阶段全部 exit 0，87 Core + 54 合同 + 79 Desktop = 220，实际 54.34 秒；Root 独立复核 1234 声明输入、38 fresh 产物、2 SSR HTML 与 3 binding 无漂移。本 R2 实读 manifest/check，核验索引阶段日志与两个 HTML 的字节身份。Root Gate02 不属于普通 App、真实 Roon、音频或 Owner 验收。[Gate02 manifest](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-mbrs009-mhocj_g8/root-gate-02/gate-output/manifest.json)、[Root 独立检查](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-mbrs009-mhocj_g8/ROOT_GATE_02_CHECK.json)。

[Gate01 原失败](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-mbrs009-mhocj_g8/root-gate-01/result.json)及完整诊断保留：Root SSR 合成 `container` 误写 `WAV`，现有闭集要求 `WAVE`，SSR 阶段 exit 1。Root 只修正样本与期待文本；旧 7477 B/`d9ae3a998c1977eb366d8a2dee34f3c88b310c62cb20fb87cfaeaa05a246d7ab` 是历史失败版本，当前 7479 B/`9d4e2fc018fee8673a721b4667975994f3cc307296627cb675ab95773fe369d3` 已绑定 Gate02。产品/合同/原 AT/预算未因该样本错误改变，不把它记成产品失败。冻结 STATE_MATRIX 的 Gate/SSR NOT_RUN 是派发快照；R2 用上述后来完成的独立收据记录，不修改冻结文件。

原 **18 tasks / 156 AT / 8 条 009 定义**逐项保持，任务 3293 B/SHA `b0108dd9544c9794b3d73bc4460431274a37c5db5cf516c8430d8300779bbca1` 未变。AT03 仍是 `kind=load` 的实际 100k 查询/滚动负载，**NOT_RUN**；抽象 total、245 文件、virtualWindow、SSR 与 220 软件测试均不能替代。AT07 仍是实际产品可操作证据，SFC/SSR 为辅助，Root 正在独立准备生产 build、E2e 与 CUA，R2 没有据其结果升级计划或状态。

截止本报告，生产 build02 完成、受控普通 App/CUA、真实 CSS/AX/键盘、245 文件真实 Node Owner/Scanner UI、远程 CI 尚未纳入完成证据；真实账号/Roon/NAS/LAN/设备/音频、各输出质量轴和 Owner 不提升。Root 可继续唯一操作者的已授权验证并分别出结论。本 R2 只接受源码审查及已列软件证据，后续不存在第三轮正式 UI 审查。
