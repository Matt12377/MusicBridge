# Mousa 4.1 交付记录（2026-10-25）

本轮已实现本地艺术家、跨本地/网易云搜索、Mac 搜索建议、iOS 作品分页、附近服务器发现和六位码配对；Mac 保留 Roon。主代理按 Owner 最新指令继续使用 Astra。最终产品源码冻结后，只补报告、状态与 Git 工作树约定。

开发、工程检查、普通应用、模拟器、物理设备、听感、Owner 验收及远端推送分别记录。当前具备工程和真实主要路径证据，**不宣称全按钮覆盖、两台物理设备长期稳定、真实局域网 P95 达标、听感或 Owner 验收通过**。失败及未覆盖项见后文，不以早期成功覆盖最终失败。

## 产物与身份

| 项目 | Mac | iOS |
| --- | --- | --- |
| 工作区 | `/Volumes/LifeWeave/VSCode/MusicBridge/worktree/v4` | `/Volumes/LifeWeave/VSCode/MusicBridge-ios-latency` |
| 分支 | `codex/mousa-4-1-artists-search` | `codex/mousa-4-1-artists-search` |
| 开始基线 | `f459c46525855e87e1d8ee68388e8ea21ab04653` | `4e9d8fb8f0ba734b010ac9c7a9d2f91bc15a628e` |
| 最终产品实现 | `30df4b0f009a2cb81f9e4ef1013aadcaba61dd51` | `8b232e9d6d1a1050dc9434049cf780834d62038a` |
| 已安装版本 | `20261024.220048`，`/Applications/Mousa.app` | Production `118`：SE 真机、Duo 27.1 模拟器 |
| 远端 | `origin`：`Matt12377/music-bridge-for-roon` | `github`：`Matt12377/MusicBridge-ios` |

Mac 最终 asar SHA-256：`21bdcf991b0709753e0ede4eec0a5754699645f3696389bf6a385c20676156c7`。封装比对 38 个编译产物、23 个签名目标，原签名身份与本地数据保持；这是本机开发签名产物，不冒充公证发布。iOS 两个 118 构建、签名、安装和普通启动均 exit 0。没有操作 Air、14P 或物理 Duo。

报告提交身份写入各仓库 `project/STATUS.json` 的 `mousa41.reportCommit`。报告提交之后的状态提交不改变产品源码。最终本地/远端完整 HEAD、报告提交和保留改动清单记录在外置证据 `GIT-DELIVERY-FINAL.json`；下一任务以该最终 HEAD 为基线，不以产品实现 SHA 覆盖报告提交。

## 完成范围

- 建立稳定的本地艺术家及专辑/歌曲艺人关系、可重建搜索索引、中文/全拼/首字母原文优先匹配。专辑所属与参与歌曲分开；歧义人物不因同名直接合并。
- 人物卡呈现已确认的多来源入口；本地作品数量与资料来源分离。118 补齐本地来源限定下的已验证头像投影，严格按当前关联 ID 和连接隔离缓存，不为显示头像增加查询或改变播放路由。
- Mac 搜索建议保留当前页，支持选中、确认、Esc 和中文组词；完整结果按类别/来源独立加载，保留来源、版本与同来源续播上下文。最终包修复 Catalog 进入 Roon 专辑/艺术家后的返回入口、逐级回退和位置保存。
- iOS 保留四个主标签，补本地专辑/艺术家/歌曲入口、原生搜索及作品分页。全库播放先使用已加载的同来源前缀，再续取后续页，避免必须等完整曲库才起播。
- 按设备隔离连接、请求、取消及迟到响应；附近发现→iOS 发起→Mac 显示六位码→iOS 确认。保留原认证边界及全部历史配对；SE 真机与 Duo 模拟器已各自完成真实新配对。
- 数据库补读与前台资源争用处理、渐进发布、活动根恢复已完成本轮范围；不修改音频文件，不恢复五个已移除库。

## 工程验证

| 检查 | 证据与结论 |
| --- | --- |
| Mac 最终完整检查 r18 | `corepack pnpm@10.17.1 verify` 自然 exit 0，351698.780167 ms，未超时；Contracts 366、Core 主套 3728、隔离停止 8、Desktop 3002，共 **7104 通过、2 跳过** |
| Mac 编译与边界 | r18 类型检查、生产构建、sandbox preload 均 exit 0；最终工作区 Control Plane、Boundaries 均 exit 0 |
| Roon 返回修复 | 定向 164/164，真实 SFC/交互合同及两项类型检查 exit 0；最终已安装包另做真实 Roon 回归 |
| iOS 118 最新头像/搜索状态 | Swift 6 真实编译，41/41、0 跳过、自然 exit 0；包含新增头像投影与关联/连接隔离及既有艺术家/播放前缀用例 |
| iOS 渐进播放前缀 | 431f00b 阶段相关 55 项通过，后续头像改动不修改播放实现 |
| 较早完整 iOS 检查 | 112 阶段 MBLibrary 671 项属于历史证据，不能写成 118 全包回归 |
| 源码身份 | Mac 最终检查/封装输入未变；iOS 118 构建前后 392 项输入未变；Duo 五个 UI 文件与指定来源提交逐字节相同 |

完整失败历史保留，包括 r16 的旧组织预期及后续纠正、早期波次失败和超时记录；最终通过不删除这些历史记录。单个阶段的通过数不与别轮重复相加。

## 合并后的真实界面和播放

| 层次 | 已实际观察 | 结论边界 |
| --- | --- | --- |
| Mac 普通应用 | 最终 220048 查询 Roon 专辑、滚动后打开详情，详情顶部能看到返回；返回保持查询/来源/类别及相同可视锚点；Roon 艺术家→专辑逐级返回；新查询不会复活旧详情 | 不把 AX 自动聚焦引起的位置变化当成产品滚动误差；不宣称 Roon 音频播放已实测 |
| Mac 205018 同源功能层 | 本地专辑第二首实际播放推进；全拼/首字母/短词、本地与网易云入口、IME 组词后提交、Down/Enter、Esc、资料出处均有真实界面记录 | 这些功能源码在 220048 中未改；最终 Roon 导航另在新包重验 |
| SE 117→118 | 原配对恢复；真实本地及在线搜索、艺术家资料/来源、播放中打开曲库、类别、排序、网格切换；118 在未先打开详情时，限定本地后仍保留已关联人物头像 | 本地代表封面与人物资料来源分开。未对真实人物执行改绑/解绑写入 |
| Duo 117→118 | 真实数据的展开/半展开/折叠布局；118 人物卡→本地详情→返回保持查询/类别；限定本地仍显示同一人物头像；更正关联候选打开并关闭，未写入 | 不把模拟器当第二台物理设备或听感证据 |
| 跨页与渐进播放 | 117 网易云搜索真实手动第 50→51 首跨页、另一歌曲近尾自然续播；本地第二首起播、队列 500→800，未等全库读完 | 实际样本，不宣称每个版本/所有尾部结束事件都正确 |
| 最终 220048 + SE 118 | 重启 Mac 后新本地专辑显示 9 首；首次播放停在资源 BUSY，界面重试未推进；普通重启 iOS App、保留原配对与快照后，本地播放从 0:00→0:07→2:43，测试结束在 2:56 暂停 | 保留失败；恢复手段不是根因修复，未把首次播放写成通过 |
| 最终并发端点观察 | 上述 SE 本地播放期间，Duo 读取真实网易云人物详情成功；随后歌曲分类显示服务忙，SE 仍继续推进且音源未被替换 | 成功和来源失败分别记录；只证明所观察区间，不能推出长期稳定或所有请求都快 |

未覆盖的真实按钮包括：断开配对/删除证书、真实改绑/解绑、收藏和歌单持久写入、完整队列编辑，以及部分真机作品分页/跳转。工程覆盖不代替这些实际操作。未为凑覆盖率改变用户配对、关联或收藏数据。`BUTTON-COVERAGE-FINAL.md/.json` 是最终逐类记录；早期 `BUTTON-COVERAGE-DRAFT` 原样保留。

## 曲库恢复与文件边界

普通界面恢复原活动根后，在处理 9216 项处验证暂停/继续，最终访问 82823、接纳 76546、跳过 6277。旧版成功重关联的绑定结算缺口已按原成功回执正规结算；没有重放扫描、重导入、新建根或复活已移除根。

只读回读确认：6 个根仍为 1 活动、5 已移除；5 个已移除根/绑定/能力及移除回执保持原样。3 个代表音频的文件身份/大小/时间和生产只读可播放资格一致。完整备份 `quick_check` 正常。上述预检与后来的真实播放分别记录，不能互相代替。

补读账本当前 81559 项中成功 76483、失败 5076、待处理 0。失败分类为 5074 个 `CONTENT_CHANGED` 和 2 个 `NO_SCAN_EVIDENCE`；前者是泛化提交错误分类，**不能据此断言音频被改动**。它与已移除项数量相同不构成逐项关联证据；没有进行无授权重扫或改写音频。

## 冷启动与首次索引：仅分析

最终已安装 220048 使用普通启动、无诊断参数，到 `FINAL_READY` **148.685 秒**。以下是同次日志中不重叠的阶段：

| 花费 | 时间 |
| --- | ---: |
| 主库目录核验 | 29.020 秒 |
| 主库扫描核验 | 37.076 秒 |
| 启动 Reader 准备阶段第二次扫描核验 | 35.604 秒 |
| 首份移动目录摘要/预热读取 | 8.140 秒 |
| 以上可归因合计 | **109.840 秒** |
| 剩余未精确分段 | 38.845 秒 |

简单说，约 149 秒里约 110 秒耗在反复核验大曲库和生成首份目录摘要。剩余约 39 秒没有足够独立事件细分；不能硬说全是艺术家索引或再额外累加嵌套时间。第二次扫描按启动 Reader 准备链关联，原事件没有 Actor ID，此归因限于该阶段。

另一真实曲库副本的首次艺术家索引约 **194.541 秒**，属于单独测量，**不能加到上述 148.685 秒，也不是本次普通启动的精确索引时间**。副本预热后的服务查询测量与实际 LAN/UI 分开，未认证本地 P95≤500ms 或 iOS LAN 首屏 P95≤1s。

另有只读分析确认扫描来源索引触及 32MiB 预算后不发布完整映射，可能回退历史查询；一次约 12 秒重建发生在服务就绪前。该现象没有撤销审计证书，专辑 DTO 不走文件解析路径，也不足以证明每次 BUSY 的唯一原因。按 Owner 指令未修改冷启动、首次索引策略或预算。

## 留待后续判断的问题

- **服务重启后的播放资源恢复缺口**：最终 SE 的应用内重试未恢复，普通重启 App 后恢复。可能涉及旧资源/清理状态，但没有闭合到唯一根因；本轮没有扩展重写资源或音频引擎。
- **部分歌曲近尾停止的历史观察**：另一些歌曲自然续播正常；证据不足以确认回调或时长根因。1ms 结束判定与本轮基线逐字节一致，不能写成本轮新增或已确认根因。
- **旧 Mac Core 进程代际变化与一次退出挂起**：旧 181805 丢失 LAN 的原因未确认；后两包能普通退出不等于旧问题普遍修复。
- **来源 BUSY 与补读失败余额**：保留最终在线歌曲分类忙及上述账本失败，不把加载完成或已连接写成所有加载/播放成功。

这些问题按 Owner 的范围控制单列，没有继续追成新的大型修复任务。Owner 视觉与听感验收仍未进行。

## Git 与后续工作树

只正常推送当前 feature 分支，不强推、不合并远端默认分支。Duo 仅整合 `d40565bca43c0be452f4ee280415246a15b5fa12` 的五个 UI 文件，整合提交 `d275508915e75df4f694b65b3e97bcac47beadd2`，不合并整个 Duo 快照。既有 Duo 工作树保留。

Mac 后续工作树根：`/Volumes/LifeWeave/VSCode/MusicBridge/worktree/`；iOS 后续工作树根：`/Volumes/LifeWeave/VSCode/MusicBridge-ios-latency/worktree/`。使用 `git worktree add` 登记和 `codex/` 分支，见 Mac `project/WORKTREE_WORKFLOW.md` 及 iOS `worktree/README.md`。不移动或删除旧工作树。

Mac 旧主检出的三个无关未跟踪项保持原样；iOS 原有 `IOS102IdleRenewalTests.swift` 末尾空行改动继续留在工作区，不提交。状态仅改 `mousa41` 片段；其他任务的状态字节保持。

## 外置证据索引

证据根：`/Volumes/LifeWeave/Developer/CommandLine/tmp/mousa41-artists-search-c997n3rn/`。真实数据库、音频、截图、配对凭据和原始私有日志不进入 Git。

- `mac-source-prepare-verify-r18.json/.log`：最终完整工程检查。
- `mac-ui-closeout-package-2hriJk/RESULT.json`、`mac-ui-closeout-packaged/PACKAGED.json`、`mac-ui-closeout-signed/SIGNATURE.json`、`mac-ui-closeout-install.json`：最终 Mac 封装/签名/安装。
- `ios-artist-card-profile-z9dxgdg7/RESULT.json`：118 最新定向验证；`ios-se118-ekrblua6/RESULT.json`、`ios-duo118-signed-cux50j3_/RESULT.json`、`ios118-install-launch-receipt.json`：两个 118 构建及部署。
- `UI-205018-117-CLOSED-OBSERVATIONS.json`、`UI-118-AVATAR-AND-COMPLEX-OBSERVATIONS.json`、`UI-220048-FINAL-ROON-RETURN.json`、`UI-220048-118-FINAL-MULTIDEVICE-OBSERVATIONS.json`：分层真实界面成功与失败。
- `mac-observed-runtime-W7qt7F/FINAL-COLD-START-AGGREGATE.json`：同次普通启动、不重复累加的耗时分析。
- `IOS117-EOF-READONLY-DIAGNOSIS.md/.json`、`IOS117-EOF-BASELINE-IDENTITY.json`：范围外近尾观察与基线对照。
- `duo-five-files-before-118.json`、`worktree-convention-final.json`、`STATUS-PRESERVATION-FINAL.json`、`GIT-DELIVERY-FINAL.json`：整合身份、工作树、状态边界及最终推送回读。

独立的最终008回读：`/Volumes/LifeWeave/Developer/CommandLine/tmp/mousa41-final-008-readback-g8txgc0m/RESULT.json`。Roon 返回修复定向检查：`/Volumes/LifeWeave/Developer/CommandLine/tmp/mousa41-catalog-roon-return-u_e3341h/RESULT.json`。

本副本归属：Mac 仓库；产品身份以上表为准。
