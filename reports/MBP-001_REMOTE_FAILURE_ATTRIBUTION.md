# MBP-001 远端 Electron E2E 的 21 项失败归因（只读审查）

## 身份与证据边界

- 比较基线：`e97f9e578beb7c5329d0c59e232b0da568e2f6fa`（下文 E97）。
- 失败产物：`7a6a19105480be456778dfa4369379f224665e39`（下文 7A6），GitHub Actions run `36765154891`。不是当前 MBR-001 的 `2b79715` 工作区产物。
- 原日志：`mbp-001-remote-e2e-failed.log`，SHA-256 `e96c91fe0cefd7cadc8950c30d69979e8f1e3e5c091a39018d86031f5d3538f3`。
- 上传产物根：`mbp-001-remote-e2e-artifacts/electron-e2e-7a6a19105480be456778dfa4369379f224665e39/`，下文所有 `results/.../error-context.md` 均相对此根。
- 使用的是上传产物的 `tmp/musicbridge-playwright-report.json`，SHA-256 `6047af8a2ec29a99bff23c8a4ceb6f4198b52524a4f4e4dfed68a5552dd5b3ed`。根目录同名 JSON 是后来本机键盘测试的报告，不能混用。
- 远端 Node `22.23.2 arm64`，Playwright `1.62.1`，实际 worker 数 1；生产 Main/Preload/Renderer 构建、Preload 依赖门禁和私有 Core 构建均先成功。E2E 结果 **81 passed / 21 failed / 4 skipped，退出码 1**。
- 新收到 E97 远端原日志：`base-e97-remote-e2e-failed.log`，run `36743158479`，SHA-256 `20285b33cada62850ecb7b0e3b240b0b667c88b64386180760529ed092ea9167`。其结果 **83 passed / 19 failed / 4 skipped，退出码1**（日志874-899）。19项历史失败与7A6按测试全名一一对应，等待目标及栈位置也相同。Task-070大目录与Task-077自动PDF在E97分别通过33.1s（日志328）、15.4s（日志358），在7A6新增失败。本审查没有自行重跑两提交；依据的是两个固定提交的远端执行日志及7A6上传产物，不能把两次CI不同机器瞬时负载视为受控性能A/B。
- 只读源代码、日志和上传的受控合成失败快照；未启动 Electron、服务、真实账号或 Roon，未构建或改正式源码。

## 结论与优先顺序

21 项中，**19 项在 E97 远端已失败：17 项 UI 夹具失配、2 项设置返回实际导航缺陷；7A6 比基线新增2个失败表现：Task-077窗口夹具抢到隐藏打印窗，以及Task-070生产大目录读取Core超时**。前者由上传打印内容快照确定为目标选错，原有夹具假设受启动时序影响；后者是相同范围测试由基线通过转为本批失败，应作为本批待解决性能回归候选保留，不能因业务store源码没改就归为旧失败。尚没有受控A/B能证明其因果来自trace补丁或仅来自CI负载。

最早失败不是页面缺失 `navigation` 合同：`CollectionView.vue:219` 的 `nav[aria-label="磁带收藏内容"]` 仍存在，首项 E2E 已经过该断言。第二项在深色设置后调用 `openCollection()` 失败，上传页面快照仍显示 **region“设置” / tabpanel“应用” / 深色已勾选**，未返回收藏页。相同触发造成 Task-085 collection 的第 7 项失败。应保留单次正常导航能从设置返回的保护，不能只删掉该断言。

8 项 `Target page, context or browser has been closed` 是 **各自用例内** 的次生错误：先等待不可达的旧入口，达到 30 秒测试期限，再由清理关闭 Electron。上传 JSON 对这 8 项记录 `status=timedOut`；每次失败的 workerIndex 从 0 递增到 20，且用例有独立 beforeEach/afterEach，后续仍有大量通过项。不存在“第一项崩溃导致其余 20 项共用坏页面”的证据。

## 最小可实施夹具对照

| 原用法 | E97 与 7A6 的真实合同 | 最小调整 | 必须保留的保护 |
|---|---|---|---|
| 收藏页 `getByRole('tab', {name:'空白磁带收藏'/'实体音乐库'})` | `MusicSidebar.vue:104-108` 的 group“实物收藏分类”内是普通 **button“收藏音乐库”/“实体音乐库”**；当前子按钮才带 `aria-current=page` | 通过该 group 内的具名按钮进入指定视图；必要时先展开实物收藏，再点击子按钮 | 键盘用 Tab/Enter/Space 到达并激活真实按钮、当前子项标记、搜索返回、侧栏收起；不要把普通 button 强行伪装成 tab |
| 收藏父按钮 `aria-current=page` / 外层 `tabpanel“空白磁带收藏”` | 父按钮是 `aria-expanded` 的折叠控制；`CollectionView.vue:192-193` 是 region“收藏音乐库”/“实体音乐库” | 对父按钮检查展开状态，对子按钮检查 current；对内容检查 region | 视图切换、选中状态和无障碍范围仍应验证 |
| 打开型号后直接拆封/登记旧录音 | `CollectionModelDetail.vue:13-17` 默认“概览”；批次操作在 tab“我的库存” → tabpanel“我的库存”（104-117） | 先选“我的库存”并断言选中及 panel 可见，再点真实操作；需要看汇总时回“概览” | 数量守恒、分类不冒充空白、保护策略阻断、幂等及冷启持久化 |
| 打开型号后直接访问单盘与录音内容 | 单盘与“档案与当前内容”/“查看录音内容”在 tab“实体磁带” → panel（119-137） | 先选“实体磁带”，再按确切 physicalId 定位 | 指定盘身份、精确制作归属、预留/释放、返回原盘、档案焦点恢复 |
| 打开型号后直接添加/查看照片 | `CollectionModelDetail.vue:138-139` 的 tab“资料照片”中渲染 `CollectionPhotos`；按钮合同未删除 | 先选“资料照片”并断言 panel 可见；返回或冷启重开后再次选该页 | 原生导入、原字节不变、懒读计数、失败单图重试、代表图、库存不增加、照片上限与归属 |
| `app.firstWindow()` 一定是首页 | `main/index.ts` 在 Core onReady 启动印刷 worker，且先于创建正式窗口；印刷 renderer 建立 `show:false` 的 data URL 窗口 | Task-077 的 launch 使用已有 `waitForMainWindow(app)`，按正式 renderer protocol/host/path 选择主窗口 | 保留自动 PDF worker 真实运行及归档字节检查；不延迟/关闭 worker 来“修”夹具 |
| 从设置再点收藏父按钮应返回 | `usePageJourney.navigate('settings')` 保留 sidebar.activeSource=collection；`MusicSidebar.toggleCollection:40` 因此仅折叠并 return | 生产局部修复可使已在设置时父按钮执行导航（已有 `settingsActive` prop）；另保留“设置→单次父按钮→收藏”的独立回归 | 不能用重复点击、强制点击或删 visibility 断言掩盖该正常路径缺陷 |

示例夹具应始终操作真实可见控件，不用 `force:true`、`includeHidden:true` 或 Renderer 假数据绕过视图：

```ts
async function openCollectionView(page: Page, view: 'tapes' | 'music') {
  const group = page.getByRole('group', { name: '实物收藏分类', exact: true })
  if (!await group.isVisible()) await page.locator('[data-sidebar-source="collection"]').click()
  const label = view === 'tapes' ? '收藏音乐库' : '实体音乐库'
  const target = group.getByRole('button', { name: label, exact: true })
  await target.click()
  await expect(target).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('region', { name: label, exact: true })).toBeVisible()
}
async function selectModelPage(detail: Locator, label: '概览' | '我的库存' | '实体磁带' | '资料照片') {
  const tab = detail.getByRole('tablist', { name: '型号详情页面', exact: true }).getByRole('tab', { name: label, exact: true })
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  await expect(detail.getByRole('tabpanel', { name: label, exact: true })).toBeVisible()
}
```

已有详情 tab 的左右/Home/End 键盘合同（`CollectionModelDetail.vue:24-31`）仍应保留。旧的两个顶层收藏 tab 已不存在，不能继续断言其箭头键行为；应改为验证真实侧栏子按钮的原生键盘操作。

## 21 项逐项对照

表中源码行号均以 7A6 为准。每项 E2E 源码与 E97 的 Git blob 相同；基线列包含E97固定提交的远端实际结果与日志行号。`UI`=基线已失败的UI夹具失配，`NAV`=基线已失败的实际导航缺陷，`WINDOW+`=本批新增失败、原窗口目标假设的时序竞态，`PERF+?`=基线通过而本批超时、生产性能回归候选。`→清理` 是该项自身的超时次生 closed 错误。

| # / 精确测试名 | E97 基线 | 7A6 当前失败 | 原因 / 最小入口修正 | 保留保护 |
|---|---|---|---|---|
| 1 `collection-preview.spec.ts:210` 收藏原型：浅深色三列墙、720 窄窗长型号、滚动入口与实体音乐仍可使用 | **失败，同等待目标/栈，基线日志464-489**；Sidebar/Journey/Collection/test 均同 blob；已有 selected source 与 settings view 分离 | `openCollection:29`，调用点 238；nav 不存在；快照仍为深色设置页（日志 244-268） | **NAV**：父按钮仅折叠，未 navigate；该 nav 实际仍在 CollectionView:219 | 两种主题、三列墙、720 长名/滚动入口、参考图失败、实体音乐入口；保留设置正常返回回归 |
| 2 `task-070.spec.ts:355` V3完成度：合法大目录历史按响应字节预算分页，完整分组与全部快照均可到达 | **通过33.1s，基线日志328**；同测试、store/contract与默认2s deadline | 366 页读取 `collectionProgress:snapshots` 返回 Core `[TIMEOUT]`；25 次 capture 后分页阶段失败（日志 270-283）；上传快照仍为正常首页 | **PERF+?**：E97通过→7A6超时，保留本批生产性能回归候选；全历史预算扫描 + 多次 storedSnapshot 完整校验/聚合/目录匹配/序列化是候选热点，trace补丁因果尚未证明 | 500 项×25 历史、每响应≤8MiB、每项完整500品牌/500系列、25 ID 不重不漏/顺序、分页 limit/offset/hasMore/空尾页；不延长 deadline 或 skip |
| 3 `task-071.spec.ts:170` V3交互：两库照片按需读取、失败单图重试、长名与横竖图保持原始资料 | **失败，同等待目标/栈，基线日志490-510**；已有侧栏普通子按钮，旧 helper 未迁移 | helper `task-071-photo-workflow.ts:113` 等 tab“空白磁带收藏”30s（日志285-304） | **UI**：改侧栏子按钮；进入型号后另选“资料照片” | 离屏0读取、进入视口才读、独立大图失败/明确重试+1、横竖原尺寸/contain、原文件字节、库存与发行数量不变、axe/焦点 |
| 4 `task-071.spec.ts:331` TASK-085 J05：正式 UI 登记发行与逐件、归属照片、关联更正撤销并冷启保留 | **失败，同等待目标/栈，基线日志511-528**；侧栏实体音乐库按钮与测试均原样 | 348 等不存在的 tab“实体音乐库”（日志306-322） | **UI**：group 内 button“实体音乐库” | 发行与逐件身份、发行/单件照片归属、Exact/Probable/CD Rip 的明确确认、撤销/更正、原字节、冷启不丢关系 |
| 5 `task-075.spec.ts:81` V3档案界面明确选择实体和处置，空态与读取故障分开、键盘确认不自动写入 | **失败，同等待目标/栈，基线日志529-546**；型号默认概览、单盘操作在实体 tab；test 原样 | 121 等“档案与当前内容”（日志324-340） | **UI**：先选“实体磁带”；快照是概览，不是档案能力删除 | 明确实体/处置、确认前0写入、键盘确认一次写入、空态/故障分开、关闭回原入口焦点、历史同盘 |
| 6 `task-077.spec.ts:29` Completed持久任务在真实App冷启自动生成PDF，公开八API保持历史字节、导出取消零写与改图不回填 | **通过15.4s，基线日志358**；同firstWindow/worker/renderer，潜在窗口目标假设原已存在 | launch:19 等首页；被选窗口关闭（日志342-366）；上传快照明确是“历史录音”“JP0基础版…按实际大小100%打印”的 J-Card 内容 | **WINDOW+**：E97通过、本批新增失败；firstWindow抢到隐藏印刷窗口已由快照确认。原有潜在夹具竞态应修目标选择；不宣称业务主窗口崩溃 | 实际自动 PDF、内容/hash/几何、公开八 API、取消零写、覆盖须确认、幂等、历史 Artwork/Record 不回填、冷启、axe |
| 7 `task-085-collection.spec.ts:200` TASK-085 J03/J04/C11：库存表原行到目录合并拆分、求购快照与同库冷启 | **失败，同等待目标/栈，基线日志547-572**；同 #1 导航状态，全部相同 | 225 深色设置后 openCollection:117 找不到 collection-view（日志368-392）；上传快照仍为设置 | **NAV**：同 #1 的生产导航缺陷；不是 `.collection-view` 改名 | 浅深色对比度/尺寸、库存表原行、非破坏导入/更正、目录合拆、Owned/Wanted正交、历史快照、同库冷启守恒 |
| 8 `task-085.spec.ts:80` 正式 App：指定单盘进入确切制作、明确预留与释放后回到原盘 | **失败，同等待目标/栈，基线日志573-599**；默认概览及 v-show copies 页已存在 | 102 physicalId copy DOM存在但 hidden；快照“概览[selected]”（日志394-419） | **UI**：先选“实体磁带”；scrollIntoView 无法解除父 v-show | 确切盘进入确切 draft/plan、浏览不预留、明确预留/释放、返回原盘/focus、不得取消其他归属、Core库存、无设备认证冒充 |
| 9 `v1-ui.spec.ts:1385` V3 收藏与录音分开，收藏视图支持键盘、搜索返回和收起侧栏 | **失败，同等待目标/栈，基线日志600-626**；父 expanded 控制+子 current，旧 top tab 已不存在 | 1392 父按钮无 aria-current（日志421-446） | **UI**：检查父 expanded、子 current、真实 group 按钮和 region | 收藏/录音独立、键盘原生按钮、搜索返回、视图选择保留、收起侧栏能访问、单侧栏、无旧概览/设备入口 |
| 10 `v1-ui.spec.ts:1432` V3 导航不触发播放变更 IPC，保留正在播放的曲目、队列和 Zone | **失败，同等待目标/栈，基线日志627-646**；已有普通子按钮，test原样 | 1454 等不存在实体 tab →30s→清理 closed（日志448-466） | **UI**：改实体侧栏子按钮；closed 仅本例次生 | 拦截的播放/队列/seek/select-zone/roon-play 变更请求总数0；currentTrack/queue/selectedZone/state及搜索恢复一致 |
| 11 `v1-ui.spec.ts:1472` V3 页面在桌面和最小窗口无横向溢出，未接入状态与无障碍检查清晰 | **失败，同等待目标/栈，基线日志647-671**；Collection区域已为 region“收藏音乐库” | 1480 等 tabpanel“空白磁带收藏”（日志468-491） | **UI**：替换区域定位，不改实际空态 | 桌面/720无横溢、真实空态/添加入口、未接入与错误可区分、axe严重问题为0 |
| 12 `v1-ui.spec.ts:1499` V3 真实库存录入、实例化与刷新后数量保持一致 | **失败，同等待目标/栈，基线日志672-691**；批次在“我的库存”，默认概览 | 1515 等拆封按钮 →30s→清理 closed；快照实际总数8/概览（日志493-511） | **UI**：先我的库存，单盘动作选实体磁带，汇总/保护回概览 | 总数8守恒、sealed7/opened1、预留/撤销、保护拆封禁用、刷新及同库冷启持久化 |
| 13 `v1-ui.spec.ts:1548` V3 未分类不冒充空白，旧录音登记守恒；表单和详情支持最小窗口 | **失败，同等待目标/栈，基线日志692-711**；登记旧录音/待确认操作在我的库存 | 1572 等登记按钮 →30s→清理 closed（日志513-531） | **UI**：先选我的库存、实体磁带；不可通过hidden force click | 总量10、sealed0、legacy3→2/recorded1、unknown7不被空白化、未知无预留、窄窗/axe |
| 14 `v1-ui.spec.ts:1613` V3 实物照片原生导入、代表图与重启持久化，不预分配单盘编号 | **失败，同等待目标/栈，基线日志712-736**；照片在资料照片 tab，默认概览 | 1623 添加实物照片不可达；总数5已显示，快照概览（日志533-556） | **UI**：先资料照片；每次重启/回详情后重选 | 原生解码/缩放/正式IPC/SQLite、0预建单盘、照片/代表图/冷启/移除、原文件不变、库存不增 |
| 15 `v1-ui.spec.ts:1722` V3 单盘照片拒绝非法文件；加载失败可重试且不丢库存 | **失败，同等待目标/栈，基线日志737-756**；同#14 | 1734 等添加照片 →30s→清理 closed（日志558-576） | **UI**：先资料照片，不是非法文件校验未生效 | 非法文件拒绝、1盘库存保留、单图加载失败/重试、照片归属与可用状态 |
| 16 `v1-ui.spec.ts:1788` V3 实体音乐库录入原版 CD，重启后仍在且不改变空白库存 | **失败，同等待目标/栈，基线日志757-774**；实体音乐入口已为侧栏button | 1791 等实体 tab（日志578-594） | **UI**：改group内实体按钮 | 原版CD实际保存、数量/曲序/资料、刷新和同目录冷启、空白库存不变 |
| 17 `v1-ui.spec.ts:1850` V3 旧录音补录 A/B 曲目后两库指向同一盘，库存不增加 | **失败，同等待目标/栈，基线日志775-794**；查看录音内容在实体磁带tab | 1855 等查看录音内容 →30s→清理 closed（日志596-614） | **UI**：先实体磁带，再进入录音内容 | A/B补录、两库同physicalId、库存不增、未知历史与用户已确认资料区分 |
| 18 `v1-ui.spec.ts:1884` V3 实体音乐库读取失败不冒充空库，保存回执丢失重试只保留一条 | **失败，同等待目标/栈，基线日志795-814**；已有实体侧栏button | 1894 等实体 tab →30s→清理 closed（日志616-634） | **UI**：改入口；原故障注入尚未通过该入口命中，不删除故障断言 | 读取失败≠空库、刷新原读、回执未知禁止新提交、同命令人工重试、只1条实际记录 |
| 19 `v1-ui.spec.ts:1912` V3 原版实体详情提供明确的 Roon 关联入口 | **失败，同等待目标/栈，基线日志815-834**；已有实体侧栏button | 1915 等实体 tab →30s→清理 closed（日志636-654） | **UI**：改入口 | 真实原版entry contentStatus=commercial，明确关联按钮可达可用 |
| 20 `v1-ui.spec.ts:1922` V3 Roon 关联闭环：取消、确认、矩阵、双向导航与重启重新定位 | **失败，同等待目标/栈，基线日志835-853**；已有实体侧栏button | enterPhysical:1927 等实体 tab（日志656-673） | **UI**：helper改入口，冷启复用同helper | 取消0关系、Exact与CD Rip独立确认、双向导航、矩阵2张、冷启needs-resolution、明确重定位、离线保留关系/禁用试听、axe |
| 21 `v1-ui.spec.ts:1987` V3 Roon 关联闭环：候选不符后可重新选择，不形成无法退出的重试 | **失败，同等待目标/栈，基线日志854-873**；已有实体侧栏button | 1993 等实体 tab →30s→清理 closed（日志675-693） | **UI**：改入口 | 错候选未保存且原metadata不变、取消可用、改正确候选仍需重新勾确认、最终退出picker |

## 超时必须继续保留的生产热点

Task-070 不是 UI 夹具失败。`collectionProgress.snapshots` 属于现有默认 2 秒 Core 请求期限（`CoreSupervisor:89,206-216`），MBP 没有改变期限或调用的业务参数。Preload 新 invoker 在 trace 关闭时直接调用原 invoke（`performance-transport:39-40`），Main wrapper 关闭时直接 handler（`performance-ipc:15-16`），repository 只有显式 trace 环境变量为1时才包 SQL（`repository:216`）。这能排除“默认序列化整份业务数据做 trace”的静态原因，不能证明远端未发生时序变化或完全排除本批性能回归。

基线已有的工作量：`collection-progress-store:130` 每次read先 `budget(db)`（29-41，所有历史表统计/最大JSON检查）；`snapshots:193-205` 按页逐个 `storedSnapshot`；`storedSnapshot:95-113` 每份历史做完整 DTO 校验、读取同一 catalog revision、聚合对照、对500项逐个catalog.find、历史match校验和指纹重算；合同 `metricsFields:150-151` 还有每个品牌对series过滤的重复遍历。最后再序列化计字节及过 Main DTO validator。页尚未返回时 Core 2秒计时已覆盖这些工作及跨进程传输。

后续生产优化应在同一500×25合成数据、相同2秒默认期限下证明每页完整可达，并保留越界/损坏/完整分组/不可变历史的拒绝保护。优先测 Core read/SQL/DTO/序列化/传输分段，而不是仅调 Playwright timeout。不能仅把大history测试 skip、改小数据、删完整brands/series、或延长 Core deadline 来关闭该项。

## 源码同一性与复核

E97→7A6 的以下22文件逐一 `git rev-parse <SHA>:<path>`，均为同一 Git blob：9个相关E2E/helper文件（collection-preview、task070、task071、task071-photo-workflow、task075、task077、task085-collection、task085、v1-ui）、main-window helper、playwright config、MusicSidebar、CollectionView、CollectionModelDetail、CollectionPhotos、PhysicalMusicView、usePageJourney、App.vue、recording-print-renderer、recording-print-worker、collection-progress-store、contracts collection-progress。

代表性blob：MusicSidebar `cedd712055c7033df1b024bfe11b40f1f22b55b7`；CollectionView `adb909d36e992474efe0a7e2006e72faffef8f72`；CollectionModelDetail `872051ab6dfdf7fa82f49d33ec151ae35f6e7b52`；usePageJourney `a538314fb5241ea2fefaa3e5d5513ca309065d06`；task077 E2E `ee71d80a1a56d2564a8a11cb9b4c03f2305fba2f`；print renderer `41aa6cade9a62f0dd8bb3f96229ff483543894b5`；progress store `73f683deddcc3a033c891e1cd58d4ff17907bc1d`。

可复核的最小范围：

```bash
git diff e97f9e578beb7c5329d0c59e232b0da568e2f6fa 7a6a19105480be456778dfa4369379f224665e39 -- apps/desktop/e2e apps/desktop/src/renderer/src/components/collection apps/desktop/src/renderer/src/components/sidebar apps/desktop/src/renderer/src/composables/application/usePageJourney.ts packages/bridge-core/src/collection/collection-progress-store.ts
```

该范围差异为空，退出码0。读取/证据提取用绝对Node22，退出码0；已按名称核对E97远端实际失败/通过结果，但没有自行执行E2E或受控基线性能A/B。Controller两文件保持原SHA-256：source `b20fa35e149a2d1dce0aad5ff8abf391438421f355cd7c8404d9d8c6d6da43a8`，test `335ee4db009af0e080f4781a29aa966f035360d2e1f52128a04c17fec5bf7c01`。
