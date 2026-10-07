正式 UI R1 需要修复 6 项 P2；未发现新的 P0/P1。此前两次预检不计正式轮次，本次为第 1 轮，最多仍为 2 轮。

输入候选 `644365ac5ab33c20807159810eab242c0680cef1a75894b041002a7aa5da428c`，base `418389708ca9400dbe347da448a829b9481dbb84`。27 个产品文件和 10 个测试文件的字节均匹配候选；Root 的独立收据记录 200/200 本地软件检查通过。本审查只读源码与既有收据，未编译、测试、启动 App、扫描或联网。

| Before | After | Why |
| --- | --- | --- |
| **P2 UI-R1-01**：pendingOverride只在最初成功返回时清空；relocationUnknown置true后无任何恢复分支。打开Outbox、确认成功、刷新、离页/返回都不接回这些标志。 [useLocalLibrary.ts](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-mbrs009-mhocj_g8/checkout/apps/desktop/src/renderer/src/composables/application/useLocalLibrary.ts:160) | 保留原commandId与dataset/命令身份；显式读取或从原Outbox关闭/刷新路径接回持久结果，确认原命令已成功或已拒绝后按当前业务修订刷新/解除相应锁。未确认、不同dataset或仅放弃跟踪不能直接清空。重定位也保存可核对的原命令身份。 | 一次回执丢失会让本次会话的所有显示更正或所有文件重定位持续禁用，用户完成既有恢复操作也不能继续；这与“核对未确认操作后恢复”提示不一致。 |
| **P2 UI-R1-02**：localLibraryPlaybackStatus仅当receipt.request与leaf匹配才读实际phase；receipt=null时无论当前006/007快照是否已确认Playing，都返回“尚未点播/尚无本次观察”。每次动作前会清lastPlay，且回执返回后才写入。 [details.ts](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-mbrs009-mhocj_g8/checkout/apps/desktop/src/renderer/src/components/player/details.ts:36) | 将当前公开播放事实与最近请求受理/结果未知分层。按当前source/currentTrack/local资产修订、ownership与Roon observation围栏显示真实当前状态；在派发前保留本次原request身份，回执丢失仍允许已确认公开流证明本次实际状态。不能凭accepted/bytes生成Playing或借用旧文件参数。 | 初次进入或返回正在播本地曲目的页面、请求处理中、以及回执未知但公开流已确认时，本地页会与原播放器矛盾，甚至把正在播放显示成未点播。 |
| **P2 UI-R1-03**：range-window的scoped五列规则比全局响应规则更具体；它仅在<=720px改为两列。旧全局<=800px却隐藏track-index，721–800px时剩余DOM按五列自动排位，封面落24px列、正文落64px列、132px操作落60px列。操作容器还容不下3×44px按钮加2×5px gap。 [TrackTable.vue](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-mbrs009-mhocj_g8/checkout/apps/desktop/src/renderer/src/components/media/TrackTable.vue:240) | 为range-window统一隐藏元素与列模板的断点/显式列位，或在该范围采用既有窄行适配；132px宽度须与最小按钮及gap一致。保留实际84px和原默认表格行为，不引入另一套表格。 | 正常支持的780px窗口会挤压标题并使播放/更多/详情操作越出分配列，影响键盘焦点可见性和可点击范围。该结论来自CSS层叠与自动网格排位，尚未做像素实测。 |
| **P2 UI-R1-04**：添加了aria-rowcount/aria-rowindex，但role=row下的header span与数据span仍无columnheader/cell；原header被display:none移出可访问性树。抽象总数测试只数row，SSR也仅断言行号。 [TrackTable.vue](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-mbrs009-mhocj_g8/checkout/apps/desktop/src/renderer/src/components/media/TrackTable.vue:182) | 在共享TrackTable中补一致的逻辑列与columnheader/cell角色，或使用符合原布局的原生表格语义；标题可视觉隐藏但须保持读屏可用，spacer/装饰封面正确隐藏，行号计数含真实可访问表头。保持84px及默认路径。 | 读屏无法可靠识别曲目、时长和操作所属列；行数宣称含表头但可访问性树并无该表头。只提供row编号不足以达成本次可访问性要求。 |
| **P2 UI-R1-05**：LocalLibraryView的open-queue事件直接inspectorOpen=true；没有调用现有openQueue/openInspector，所以未保存触发焦点，也未聚焦检查器关闭按钮。 [App.vue](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-mbrs009-mhocj_g8/checkout/apps/desktop/src/renderer/src/App.vue:928) | 将此入口接到既有openQueue；保留同一Inspector与原记忆/返回焦点路径，不再另写一套队列或焦点状态。 | 键盘打开本地队列后焦点继续停在被面板遮挡的页面按钮，Tab不能从检查器可操作项开始，关闭时也缺对应返回位置。原播放器入口已有可复用实现。 |
| **P2 UI-R1-06**：reload失败设置error；之后成功轮询更新roots/jobs与rootsLoaded，但不清除该读取错误。只有用户发起另一业务action才先清error。 [LocalLibrarySettings.vue](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-mbrs009-mhocj_g8/checkout/apps/desktop/src/renderer/src/components/settings/LocalLibrarySettings.vue:13) | 区分读取故障与操作/未知结果提示；成功的当前代次reload仅清读取故障。保留未确认动作的持久提示，不能因为一次成功poll抹掉操作未知。 | Core短暂不可用后扫描/目录已恢复，界面仍持续报告“读取未获确认”，与最新成功数据矛盾，用户也没有纯读取恢复入口解除该告警。 |

两项 P3 单列，不要求为它们开启第三轮：

| Before | After | Why |
| --- | --- | --- |
| **P3 UI-R1-O1**：原菜单只设坐标/track，不移焦点、没有Escape/方向键或触发项aria-expanded；键盘click的clientX/Y通常为0。 [TrackTable.vue](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-mbrs009-mhocj_g8/checkout/apps/desktop/src/renderer/src/components/media/TrackTable.vue:83) | 可在同一共享菜单内保存触发项、按按钮矩形定位键盘打开、聚焦首可用项、Escape回原触发项，并正确标识菜单展开状态。 | 继承问题并非009新回归；本地详情提供可访问替代队列动作，可作为P3观察处理。当前不应声明更多菜单已完成真实键盘验收。 |
| **P3 UI-R1-O2**：detailTrigger仅是组件内DOM引用。离页后引用消失，或虚拟窗口卸载原行后isConnected=false，closeDetail仅聚焦搜索框且未preventScroll。 [LocalLibraryView.vue](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-mbrs009-mhocj_g8/checkout/apps/desktop/src/renderer/src/components/library/LocalLibraryView.vue:13) | 在session保存稳定曲目/触发控件身份和必要返回位置；恢复有界行后nextTick聚焦对应按钮并preventScroll，确实不可用时才用可说明的后备项。 | 现有Host测试只覆盖原行仍连接的关闭，不证明离页/缓存窗口卸载后的返回焦点与真实滚动保持。此项需Root有界普通UI核对，不将脚本focusCount当实测。 |

源码已确认单侧栏、原播放器和 Inspector 复用，TrackTable 采用 optional rangeWindow 与 row-detail slot；页为 100 条、缓存最多 6 页，行常量与 CSS 为 84px。Raw/override/effective、已有发行关系与解析参数分层；未知的 Roon 输入/输出保持未知。实际窄窗几何与完整可访问性仍须检查。

Root 的 SSR 脚本只验证实际组件的合成渲染；新增 Electron E2e 源码将走正式 Main/Core/Node Owner/Scanner，但用 3 个自建 WAV 并窄替换 picker，尚未执行。本 R1 不把两者写成普通 App 或 Owner 证据。Root 后续用冻结产物和官方现树收据，经原入口对 245 个自建文件做有界普通 CUA；原 AT03 的 100k/load 继续未实测，AT07 继续与辅助层分列。

另已提醒 Root：EXECUTION_SCOPE 中两项 UI 预检历史 SHA 在后续授权补充 TrackTable 条件后不再对应现文件；最终 provenance 应保留旧快照或绑定后继。当前候选产品/测试身份匹配未受影响。

各问题的具体源行、用户影响、可检验例与建议验证见 [UI_R1.json](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-mbrs009-mhocj_g8/reviews/UI_R1.json)。仅 Root 整合两份 R1 后安排唯一 writer 修复，并冻结下一候选进入 R2。
