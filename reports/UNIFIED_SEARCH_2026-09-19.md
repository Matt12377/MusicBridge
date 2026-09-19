# 统一搜索改造与真实 Roon 修复（2026-09-19）

基线：`c9f8cec4e0a9774035862406f822fd7401016cec`；分支：`codex/unified-search`。实现与报告仍为未提交工作树修改，未 push。保留既有 Remote Core、图标、原型等其他工作。

## 当前用户路径

输入关键词 → 同时浏览 Roon / 网易云艺人与专辑 → 切分类查看更多 → 打开艺人或专辑详情 → 播放歌曲 → 返回原搜索。

Owner 最新要求覆盖此前快速基础检查的安排：本轮执行完整单元/组合回归、受影响端到端场景、真实账号与 Roon 数据验证和截图比较。

## 真实故障与修复

实际在已连接的 Roon Core 搜索“张惠妹”，点击 aMEI 详情复现失败。经过分类后的 Browse 诊断显示 `invalid-item-key`：搜索分组切换后 Roon 更新条目 key，详情导航仍使用旧 key，并非此次 Core 断连。

`navigateToPath` 对搜索层级的每一层复用已有身份校验/重新定位逻辑，读取当前 key 后再进入；拒绝不匹配的身份，不通过标题猜测另一张专辑。增加分组切换导致 key 失效的行为回归，修复前失败、修复后通过。诊断仅输出错误分类与结构信息，不记录查询、条目 key、会话或凭据。

## 最终交互

- 顶部分类为综合、单曲、专辑、艺人。综合页按艺人、专辑、单曲排列；查看更多跳到对应分类，各来源分别分页。
- 综合页展示两位艺人、最多六张专辑、六首歌曲。宽窗口歌曲为两列三行，专辑为六列；窄窗口自动收拢。
- 同名艺人仅在无歧义时聚合显示，保留来源详情；跨语言别名不自动认定同一人。专辑保留 Roon / 网易云版本和来源，不跨来源合并。
- 网易云艺人详情读取 `artists` 的热门歌曲数据；歌曲缺封面时按页批量补图，失败不丢搜索结果。
- 详情返回保留搜索状态；新关键词把滚动位置归零。歌曲图文与区块间距收紧，移除搜索页重复叠加的底部播放器留白。
- 沿用 MusicBridge 玻璃背景与播放器。参考网易云的信息密度和分类结构，保留用户要求的“专辑在单曲上方”。

## 真实运行证据

在正常开发版、现有真实账号和真实 Roon Core 上执行，未使用合成 IPC 替代以下结果：

1. 搜索“张惠妹” → aMEI 艺人详情返回 37 张专辑，当前加载 24 张。
2. 打开《阿密特2 [台湾首版]》 → 显示 10 首歌曲。
3. 播放《怪胎秀》 → Studio Display 输出被选中，UI 进度推进至 0:26 / 4:22，出现暂停按钮；验证后已暂停在约 0:36。此证据确认播放状态与进度，不代表听感或完整音频质量验收。
4. 直接打开搜索中的 Roon《你在看我吗》整碟版本 → 显示 CD1 / CD2 两首整碟文件与播放入口。
5. 网易云“张惠妹”艺人详情显示 51 张专辑 / 788 首的来源统计，实际加载首批歌曲及更多入口；不把统计总数当成已全部加载。
6. 搜索“半点心” → 真实歌曲封面、六首预览、专辑分类加载更多和艺人分类结果均可见。
7. 已在真实窗口滚动至底部检查六首歌曲与播放器间距，并保存综合页、专辑分类和底部截图。

真实截图位于 `/Volumes/LifeWeave/Developer/CommandLine/tmp/musicbridge-search-repair-qa-20260919/`：`real-overview.png`、`real-albums-category.png`、`real-bottom.png`。最终响应式尺寸另由同目录合成截图验证；两者明确分账。最终通过正常 `dev` 入口重新构建并启动，`real-final-dev.png` 记录最终版本真实“孙燕姿”单曲分类（来源总数 295，当前加载 80；Roon 当前 20 / 48）。当前窗口留给 Owner 继续试用。

## 自动验证

- 全工作区类型检查通过，退出码 0；最终修改后的生产构建通过，退出码 0。
- Contracts 191 通过；Core 1331 通过、1 跳过；Desktop 710 通过。共 2232 个通过、1 个跳过。
- 首次 `verify` 在 Desktop 两条旧静态 UI 断言退出 1；调整断言到新组件后完整 Desktop 重跑退出 0，随后类型检查和生产构建单独通过。不能把首次 verify 记作退出 0。
- 受影响 E2E 分批 15 个通过：连接/设备状态、搜索分页与详情返回、搜索后播放/队列/歌词、歌词匹配竞态、无障碍严重项检查。更新了新六首预览的按钮定位、分类入口、共享背景作用域与现有快捷键导航；新增新查询滚动归零验证。
- 隔离合成搜索 UI Gate 验证六首两列、混合来源、分类与分页、Roon/网易云详情返回和 720px 无水平溢出。使用 mock keychain，不能代替真实 Roon 证据。
- 开发/生产启动 Gate 均退出 0，标记 `DESKTOP_STARTUP_MOCK_PASS`；使用 mock keychain，真实 safeStorage、崩溃恢复与打包签名验收未在本轮重跑。
- control-plane、boundaries、git diff --check 通过。

所有测试缓存、临时数据、日志与截图位于已核验的外置 LifeWeave APFS 卷。

### 完整 E2E 的遗留项

尝试运行整个 `v1-ui.spec.ts`，首次 10 通过、3 失败，触发最多三处失败停止，37 个未运行。搜索场景已更新并重跑通过；另外两处非搜索用例仍引用旧主题颜色，以及会匹配两个“打开设置”按钮的宽泛定位。未扩大本轮范围去重写主页/账户用例，也未把完整 E2E 标为全绿。

## 证据路径

临时根：`/Volumes/LifeWeave/Developer/CommandLine/tmp/`

- `musicbridge-search-stale-key-red.log`：真实缺陷回归的失败证据；最终通过见完整 Core 日志。
- `musicbridge-search-repair-verify.log`、`musicbridge-search-repair-desktop-all.log`：完整单元/组合回归。
- `musicbridge-search-repair-final-typecheck.log`、`musicbridge-search-repair-final-build.log`：最终类型检查与生产构建。
- `musicbridge-search-repair-playwright.log`：首次全 E2E 失败及未运行范围。
- `musicbridge-search-repair-focused-e2e.log`、`musicbridge-search-repair-final-e2e.log`、`musicbridge-search-repair-search-e2e.log`：分批回归与最终通过。
- `musicbridge-search-repair-final-ui.log`：最终隔离搜索视觉 Gate。
- `musicbridge-search-repair-startup-development.log`、`musicbridge-search-repair-startup-production.log`：启动 Gate。
- `musicbridge-roon-browse-gate-search-real.jsonl`、`musicbridge-roon-browse-gate-search-fixed.jsonl`：真实故障前后不含来源标识的 Browse 结构诊断。

## 交付边界

工程修复与所列真实用户路径已验证；尚未获得 Owner 对最终布局的确认。未生成安装包、替换已安装应用或发布远端。分支没有配置 upstream。一次直接 start 后的 CUA 输入与画面状态不同步，未将该次操作计为真实路径通过；最终以正常 dev 入口重新启动后的真实画面为交付状态。下一次继续使用当前工作树，不能只从基线 SHA 重建这些未提交修改。


## 追加修订：自动分页与原生播放确认（2026-09-19 晚）

### 实现

- 专辑和艺人独立分类使用可见区域哨兵自动加载，两来源分别推进；失败来源停止自动重试并保留显式重试入口，已加载内容保留。单曲分类移除额外 Roon 分区及无用的 Roon 单曲搜索请求。
- 艺人分类减少两侧留白，宽窗口六列、头像最大 160px；中等窗口四列、窄窗口两列。
- 修复 `roon.library.play/queue` 被读库 10 秒超时提前终止的问题，改用已有的 60 秒播放操作预算；普通读库仍保持 10 秒。
- 已按实体路径定位并派发的原生动作，收到同一所选设备、较新 revision、playing 状态和相同规范化曲名时立即确认，允许 Browse/Transport 中英文元数据差异。其他播放确认默认仍保留严格元数据匹配。这沿用已有超时后确认规则，避免为了同样的确认条件多等 10 秒。
- 原生播放请求增加在途防重；行内按钮的 Enter/双击不再额外触发行播放。失败后解除在途状态，可以重试。

### 本轮验证与机器重启

- 新增缺陷回归先失败：别名即时确认和原生 play/queue 超时预算共 3 条失败；修正后 121 项相关测试通过。
- 初次全工作区 verify 完成，但实际使用 Node 25；随后补跑 Node 22 时用户报告机器死机并重启。补跑日志中断，没有完成结论。不能将死机归因断定为测试，但当时未限制全量测试并发，增加了资源风险。
- Owner 允许继续后，改为 Node 22.23.2、单项顺序执行、测试文件并发 1。196 项搜索/播放/IPC/Renderer 相关测试通过；全工作区类型检查、生产构建、开发构建通过；control-plane、boundaries、diff check 通过。
- 隔离 Electron 搜索 Gate 通过：双源专辑各 18 项自动加载至 36 项；网易云第二页一次失败时 Roon 继续到末页；失败来源不循环重试；显式重试后补齐；到末页不再发请求；艺人 23 项（同名聚合后）自动补齐；六列头像宽 160px；六首两列综合预览；单曲页无额外 Roon 区；720px 无横向溢出。首次两次启动分别因目录名称、目录不存在失败，修正测试启动参数后通过，未修改生产路径校验。
- 受影响 E2E：搜索/分页/详情/播放队列与歌词、axe 严重项检查共 2 项通过。新增原生连续点击/失败重试用例首次缺少合成播放设备而失败，补齐夹具后单独通过（1 项）。本轮未再运行全量 E2E。
- 真实开发版已重新启动，真实 Roon/网易云混合搜索结果可见。桌面自动化出现 native pipe closed、界面树与截图不一致、窗口变更拦截及枚举超时，尚不能把修复后的《逆光》真实播放标为通过。此前真实播放证据属于前一版，不替代本轮验证。

### 本轮证据

外置临时根下：`musicbridge-playback-red.log`、`musicbridge-playback-focused.log`、`musicbridge-search-serial-focused.log`、`musicbridge-search-serial-typecheck.log`、`musicbridge-search-serial-build.log`、`musicbridge-autoload-ui-gate-final.log`、`musicbridge-search-serial-e2e.log`、`musicbridge-search-native-retry-e2e.log`、`musicbridge-search-playback-real-fixed.log`。

视觉与分页证据：`musicbridge-autoload-qa-20260919/result.json` 及同目录截图。布局已检查；合成封面不代表真实曲库图像加载通过。真实播放延迟及最终听感仍待完成。


## 页面范围搜索（2026-09-19）

Owner 确认已有聚合搜索页面没有发现问题，并要求增加独立的本地专辑、艺术家搜索。

- 复用侧栏搜索框，按所在页面显示“搜索本地专辑”/“搜索本地艺术家”；主页及其他页面维持聚合搜索。
- 本地页面仅请求 Roon 对应类型，查询整个 Roon 搜索结果，不局限已加载的当前一页。分页沿用关键词与类型，不调用网易云搜索。
- 初版专辑与艺术家各自保留会话内关键词和结果；Owner 后续要求更改返回层级及切页清理规则，当前行为以以下追加修订为准。清空/Escape 恢复该类型完整列表。
- 新查询输入时立即使旧请求失效；离开详情时使迟到的详情响应失效，避免重新跳回详情。空结果区别于空音乐库，错误沿用现有重试入口。
- Node 22.23.2 串行验证：38 项相关单元测试通过，桌面类型检查、生产构建、diff check 通过；两个端到端用例通过（本地范围/分页/清除/详情返回/迟到响应/聚合边界，以及原聚合搜索与播放队列流程）。均为隔离合成数据，不作为真实本地播放证据。
- 日志：外置临时根下 `musicbridge-local-search-focused.log`、`musicbridge-local-search-typecheck-final.log`、`musicbridge-local-search-build-final.log`、`musicbridge-local-search-e2e.log`。截图 `musicbridge-local-search-albums.png` 已检查。
- 当前变更为 Renderer 层功能，产物已构建；既有运行中开发版尚未可靠确认加载此轮新界面，需要重启开发版。未改造播放后端，前一轮《逆光》真实播放复测待办继续保留。


## 追加修订：逐级返回与切页清空（2026-09-19）

- Roon 专辑、艺术家详情记录父页面、侧栏来源与滚动位置。艺术家进入专辑后，先返回该艺术家详情，再返回艺术家列表或搜索结果；本地搜索和主页聚合搜索均使用此规则。返回文案显示实际父层。
- 在同一详情路径内返回保留查询；通过侧栏切换页面或进入设置等独立页面，清空搜索关键词、结果、待执行搜索及返回路径。再次进入专辑/艺术家页面显示完整列表，不恢复旧搜索。
- 返回和切页使旧详情/搜索请求失效，避免迟到响应把界面切回已离开的详情。
- Node 22.23.2 串行验证：38 项相关测试、桌面类型检查、生产构建及 `git diff --check` 全部退出 0。两个 Electron E2E 通过，覆盖本地/聚合搜索逐级返回、迟到详情响应、切页后空查询和完整列表，以及原搜索/分页/队列流程。
- 本轮为隔离合成数据验证，不作为真实 Roon 播放证据。未重新启动用户正在运行的开发版；需要重启后加载新产物。未提交或推送，保留原有工作区修改。
- 外置日志：`musicbridge-search-back-focused.log`、`musicbridge-search-back-typecheck.log`、`musicbridge-search-back-build.log`、`musicbridge-search-back-e2e.log`，均位于 `/Volumes/LifeWeave/Developer/CommandLine/tmp/`。

## 搜索保留条件纠正（2026-09-19）

Owner 澄清：只有切换页面后再次搜索新内容，才清除之前的搜索；单纯切换页面需要保留上次打开的页面。本节覆盖上一节“切页清空”的行为说明。

- 切换侧栏页面或打开设置时暂存当前搜索路径，重新进入原入口恢复关键词、已加载结果、分类、详情层级和内容滚动位置。主页聚合搜索与本地专辑、艺术家搜索使用相同规则。
- 在其他页面输入新搜索后，清除旧查询、结果及暂存路径；之后返回旧入口显示完整列表。同一详情路径内仍然逐级返回。
- Roon 详情保存独立快照，避免在其他页面打开专辑覆盖原详情；离开时使未完成详情请求失效，恢复尚未加载完的详情时重新请求。恢复详情时刷新收藏状态。
- 基线仍为 `c9f8cec4e0a9774035862406f822fd7401016cec`，分支 `codex/unified-search`。实现与报告均未提交；下一次继续当前含未提交修改的工作树，不能仅从基线 SHA 重建。
- Node 22.23.2 串行验证：41 项相关单元测试通过；类型检查、生产构建及两个受影响 Electron E2E 通过，退出码均为 0。E2E 覆盖切页恢复详情、滚动位置、分类、跨页新查询清理、迟到响应与原搜索/分页/播放队列流程。使用合成数据与 mock keychain。
- 日志位于外置临时根下 `musicbridge-search-retention-focused.log`、`musicbridge-search-retention-typecheck.log`、`musicbridge-search-retention-build.log`、`musicbridge-search-retention-e2e.log`。未操作真实播放或重启用户开发窗口，新界面需重新加载；真实播放待办、Owner 验收及完整回归的历史边界继续保留。
