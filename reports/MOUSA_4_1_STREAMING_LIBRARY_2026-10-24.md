# Mousa 4.1：索引期间浏览与等待问题阶段报告

本报告是阶段验证记录，不代表整个 4.1 完成或用户验收。固定事项编号见 `project/MOUSA_4_1_TODO.md`。

## 基线与范围

- Mac 分支：`codex/mousa-4-1-artists-search`；base SHA：`f459c46525855e87e1d8ee68388e8ea21ab04653`。
- iOS 分支同名；base SHA：`4e9d8fb8f0ba734b010ac9c7a9d2f91bc15a628e`。
- 实现提交、报告提交及下一任务提交基线：尚无；保留原有未提交工作，未提交或推送。
- 主代理沿用用户指定的 Astra。当前唯一真机为 SE；Air 属于历史验证，后续不操作 Air 或被其他项目占用的 14P。Owner 最新要求全程自主推进，常规开发和测试不再交由人工操作。
- 证据目录：`/Volumes/LifeWeave/Developer/CommandLine/tmp/mousa41-artists-search-c997n3rn`，下文日志均相对于此目录。

## 已改变的行为

1. 既有专辑与歌曲目录独立于艺术家索引读取。艺术家索引使用独立 SQL Worker，批内让出执行权；索引尚未就绪时，已导入的曲库仍能分页浏览。完整艺术家与搜索结果只在对应修订完成后发布，不把部分索引当作完整搜索或续播范围。
2. iOS 空本地主库在专辑首批通过校验后立即发布，歌曲继续加载。原有修订、切换来源、权限失效与游标保护保留。
3. 搜索或艺术家详情打开本地专辑时保存原页面、来源、筛选和位置；返回只恢复仍有效的上下文。迟到请求不能重新打开已经离开的专辑。下拉关闭后可以用相同关键词重新打开。
4. 本地文件准备增加 30 秒前台期限和取消处理。超时后显示明确错误；实际文件操作尚未静止时继续保留资源占用，迟到文件句柄关闭后才释放。一个播放 lane 关闭失败不再提前拒绝仍可等待健康 lane 的请求。

## 等待原因与边界

同步 SQL 确实曾阻塞共享执行线程，因此原问题不全是视觉上的卡顿。独立索引读口解决这一部分；原冷启动曲库审计、移动服务准备仍有成本，本轮不将其计为已修复。

实际本地点播在目录物化与两次来源捕获完成后停在 `LEASE_REGISTER`，尚未提交 Roon SDK。线程采样显示文件与目录打开等待，数据库线程空闲，四个文件线程仍有两个空闲。系统 TCC 日志同时记录了网络卷权限记录不匹配及授权提示；与挂起吻合。Owner 随后完成网络卷授权；已安装 20261023.181121 后，本地第 24 项起播、跨页到第 25 项及返回第 24 项均观测到真实播放进度。不能据此宣称数据库死锁、线程池耗尽或 Roon 故障。

早期网络卷授权窗口由用户本人处理，未修改 TCC 记录或绕过权限。Owner 已确认 Air 重新配对；之后 test03 曾在启用 XCTest 自动化前超时（退出 65，真实方法执行 0），不计产品搜索失败。提示消失后的单次重试仍退出 65。随后 Owner 明确完成系统授权，新鲜 test03 实际执行 UI 并在连接前置检查处跳过：xcodebuild 退出 0、真实 0 PASS / 0 FAIL / 1 SKIP。109 冷启动仍显示尚未连接；身份、构建与 harness 清数据排查均已完成，未读取凭据或解除配对。Owner 已授权补建 Air 应用内配对。

## 真实曲库副本测量

副本有 81,559 首歌曲、10,481 张专辑、1,151 位艺术家。使用独立真实文件身份，未包含正式数据集歌词库存；未读取音频，不修改正式数据库。

| 场景 | 样本 | P95 | 结果 |
| --- | ---: | ---: | --- |
| 索引同时读取 Mac 原目录 | 386 次 | 2.05 ms | 0 次失败 |
| 索引同时读取移动目录服务 | 211 次 | 444.40 ms | 0 次失败 |
| 索引就绪后五类本地搜索 | 各 20 次 | 14.98–204.11 ms | 原文、全拼、首字母与短词分别测量 |

独立索引包含一次独立审计，共 194.54 秒。20 ms 事件循环采样最大间隔 118.19 ms。预热单列：原库审计 55.63 秒、Mac 首读 10.81 秒、原移动服务准备 65.87 秒；不计入上述并发请求耗时。该数据是服务层测量，不能替代实际 App 渲染或 iOS 局域网首屏 P95。早期 138.1 秒测量的审计条件不同，不能据此比较索引速度。原始收据：`real-library-worker-benchmark-r1/RESULT.json`。

## 工程与实际运行分开记录

| 层级 | 当前证据 |
| --- | --- |
| iOS 首批渐进显示 | 88 项通过；Production 109 已签名安装到 Air |
| 索引与原移动读口 | 索引恢复 27 项、独立 SQL Worker 8 项、原移动查询 84 项通过；范围分别记录，不拼成总通过数 |
| 本地准备生命周期 | 新增单调准备时钟与租约时钟隔离回归后 8 项通过；`lease-clock-green-LML5oh/test.log` |
| 桌面导航与播放 | 202 个不同测试分批通过；最后导航与组件 76 项复测通过，`catalog-navigation-final-green-r3.log` |
| Core 本地播放与音质 | 149 个不同测试分批通过；fresh Reader 下 namespace 36 项通过，音质 30 项自然退出 0 |
| 类型检查 | 最新标准 verify 中全工程类型检查通过；类型收窄修正后的导航与组件 76 项回归通过 |
| 正式构建与签名 | 20261024.000732 已同身份签名安装；002900 全拼排序候选构建、38 编译文件封装比对、885 源码文件比对、23 目标签名及 deep/strict 校验通过，等待安装 |
| 标准门禁 | 最新完整 r8 自然 exit0，类型、合同、Core、Desktop 与生产构建全阶段通过；真实工作树 control-plane 与 boundaries 均 exit0。历史失败保留于下文 |
| Mac 实际应用 | 已验下拉 Esc 保留词、同词重开、回车搜索；本地第 24→25→24 项续播，以及播放中打开艺术家详情；网易云第 2 项播放进度至 78 秒、下一项至 18 秒。不是人工听感或视觉验收 |
| Air 真机 | 109 已安装；Owner 完成系统授权后 test03 真实执行 UI，连接前置检查仍为尚未连接而 SKIP；应用内重新配对已获授权，搜索尚未执行 |

旧完整 verify 的退出码 143 表示被中止，不能表述为已得到若干失败文件。后来定位到旧音质测试没有关闭测试进程的共享 Rust 池；只添加测试收尾后 30 项通过并在约 4.8 秒自然退出。普通产品 Reader 生命周期未改变。旧 namespace 夹具现观察真实 Rust 解析调用，仍实际解析文件，保留写保护、读取字节和 lease 断言。首次失败日志均保留。

历史 `mac-source-prepare-verify-r3.log` 已通过全工程类型检查与合同阶段，Core 的 `collection-repository.test.ts` 两项测试因将诊断日志当作 JSON 解析而失败。随后日志超过 90 秒没有新增，多个测试进程与 Rust 子进程持续存活；保存 `verify-r3-stall-observation.json` 后以 SIGTERM 停止本次自有验证组，确认无残留。没有动态基线证据把这两项失败归为旧版本。该轮不是完整回归，后续封装成功也不能覆盖此结论。

已安装候选备份位于证据目录的 `mac-source-prepare-signed/Mousa.app`。构建日志 `mac-source-prepare-build-r2.log` 退出 0；封装内 38 个编译文件与 dist 逐字节匹配；当前产品源码与隔离快照共 885 个文件匹配。包版本 `20261023.181121`，asar SHA-256 `5e1be96cda1c1f45b46a3ca170476e02a414822b71201e2ea51aa324d054c7ee`。`mac-source-prepare-signed/SIGNATURE.json` 记录 23 个签名目标与原身份一致、deep/strict 校验退出 0，原生资源及 asar 在签名前后不变。签名为本地工程使用的 Apple Development，不表示发布准入。

## 剩余事项

- 000732 已实测原文姓名首位、返回封面位置 y=60 前后一致、本地与网易云播放确认后无残留等待提示；全拼排序新修复待 002900 实测，中文输入法仍未验证。
- XCTest 授权已实际生效；Air 109 尚未保存可恢复连接，Owner 已授权补建应用内配对，随后执行搜索、详情、非首条点播及跨页续播。不得用安装或连接图标替代功能证据。
- 两台物理设备同时运行、iOS 局域网首屏 P95、人物关联更正与解绑重启保存、用户视觉验收尚未完成。
- 旧曲库文件身份变化导致的补读失败仍需沿已有目录重新关联和扫描流程恢复，未忽略身份校验或修改音频文件。
- 完整 verify、既有 cue-plan 边界门禁及长期鉴权回执容量仍单独保留，不被定向测试通过覆盖。

## 安装后发现与当前修复

20261023.181121 已安装且普通启动成功。观察收据为 `mac-new-runtime-observations-r1.json`；播放进度与来源由实际界面取得，未将其扩写为可听音频、音质或用户验收。

- 本地艺术家精确姓名原被合作名挤后：已将原文完整相等的优先级放在分页限制之前；先失败后修复，全文件 27 项通过。
- 搜索专辑返回保留了关键词与筛选，但实测封面位置偏一行（329 像素）：现等待真实虚拟墙列数、行高及布局提交后恢复，保留换来源与迟到请求保护；相关 62 项通过，真实 App 待新包复测。
- 播放已真实确认后，晚到接受回包会复活等待提示：增加原请求所有权检查，不能重开已闭合请求或覆盖新请求；79 项相关测试通过，真实 App 待新包复测。

标准 verify r4 自然完成 Core 后退出 1（263.54 秒），全工程类型检查和 362 项合同通过；Core 3579 项中 3377 通过、200 失败、2 跳过，桌面阶段未执行。逐类审查已保存 `verify-r4-failure-classification.json`。已修正本轮准备时钟域回归、结构化艺人字段夹具、旧 Rust 生命周期观察及隔离快照漏入的纯诊断解析器，正在 r5 完整复验。静态接手基线相同的遗留失败尚无动态基线归因，不写为全套通过或已免责。

## 当前候选与验证（2026-10-24 补充）

000732 普通 App 实测收据为 `mac-ui-followup-runtime-observations.json`：本地原文完整姓名列首位、同一封面返回前后均在 y=60；本地搜索第 24 项起播，跨页到第 25 项并返回第 24 项均有真实进度；网易云第 2 项到第 3 项均有真实进度，普通页面不再保留幽灵等待提示。播放中打开详情未改变当前歌曲。该观察不代表听感、音质或用户验收。随后发现全拼及首字母仍将合作名排前，现保留原文优先层级，在同层排序中优先完整全拼/首字母；先失败后修复，隔离候选 35/35 通过。新包 20261024.002900 的构建、封装、同身份签名通过，安装与实际复测单独记录。

完整 verify r5 自然结束 Core 并退出 1：全工程类型检查与合同 362 项通过，Core 3604 项中 3542 通过、60 失败、2 跳过。桌面阶段未到达。分类文件 `verify-r5-failure-classification.json` 区分 58 个直接失败、2 个父级级联，未以静态相同认定动态基线免责。独立桌面 188/188 通过；后续 WAVE/CD01 定向 160 项中 153 通过、7 失败，仍有真实格式解析差异和工作台捕获期限失败，完整门禁未通过。

正常退出另有缺陷：181121 与 000732 都在普通退出后停留于 Core 已断开的界面，进程仍存活。181121 已保存采样后精确终止 Main 才完成替换；000732 正在保存现场调查。此问题未修复，不能将可启动或播放成功表述为完整生命周期通过。

Air 授权后收据为 `air109-owner-authorized-test03-ouqcss6c/test03-verdict.json`：test03 真实进入并执行约 10 秒，xcodebuild 退出 0；0 PASS / 0 FAIL / 1 SKIP，原因是应用 UI 的连接前置检查“尚未连接”。身份检查确认仅一份正式产品、109 同 bundle/Team，harness 不清数据；单次普通冷启动后仍然如此。没有读取 Keychain，不能确认缺少的是 locator 还是对应凭据。Owner 已授权由 Root 补建 Air 应用内配对，已有 Mac 配对记录保留。

## Air 配对与搜索实际复现（2026-10-24 08:50）

Mac 002900 已安装并正常进入实际应用；全拼 zhoujielun 和首字母 zjl 的精确人物均排首位，Esc 保留输入、回车进入结果及周杰伦本地/网易云双入口已观察。收据 `mac-phonetic-and-air-pairing-observations.json`。

Air 109 经普通公开资料导入、证书核对、验证服务器及配对许可流程完成连接，真实首页内容已加载。已连接自动测试批次 exit65，1 PASS / 8 FAIL / 0 SKIP，失败分类与截图见 `air109-connected-01-09-by1bcov7/tests01-09-verdict.json`；没有执行查询命中断言。Root 随后实际下拉展开原生搜索并输入 zjl，本地艺术家可返回，歌曲和专辑等待后提示服务忙。这是待修真实功能问题；尚无 Air 播放、跨页或配对后冷恢复通过结论。

## Air 本地播放、110 升级与 Mac 输入法补充

Air 109 从本地周杰伦详情打开《无与伦比演唱会 CD2》，第 2 首《藉口》显示播放进度 42 秒，Mac 搜索后同一曲目显示 68 秒；下一首《瓦解》进度至 100 秒后暂停。返回搜索仍为 zjl／本地／艺术家。该证据不包含自然结束、跨页或人工听感。110 在保持 bundle 与 Team 的前提下原位安装，设备读回确认版本，普通启动恢复已配对首页，四标签及常驻搜索框已实际看到。在线搜索与多来源艺术家由独立 runner 复测中。

Mac 002900 原生组词显示 `zhou'jie'lun`，空格确认成“周杰伦”后才出现建议加载；方向键加回车进入本地人物详情。组词期间浮层却显示空结果提示，已用原组件测试复现（12 PASS／1 FAIL），加组词可见性门后 13 PASS，等待下一包实测。退出阶段的 `close_artist_catalog` 观察遗漏已补齐，16 项通过；这只补证据，未宣称正常退出已修复。

本地歌曲/专辑搜索仍真实 BUSY。当前可检验假设是完整搜索结果逐条物化导致重复串行鉴权与 Owner 读取，正在私有服务内补有限页批量物化。10 秒 owned 请求错误默认不可重试，不能把约 40 秒界面等待直接解释为三次超时。公共接口、权限和文件身份校验不放宽。记录见 `mac-ime-air-local-playback-and110.json`、`ime-popover-ioaz4zi6/`。

Air 110 定向结果：test06 FAIL（真实网易云艺术家查询普通30秒仍在载入），test09 PASS（原双来源作品入口断言），批次自然 exit65，0 SKIP；专辑和歌曲断言未执行。截图支持真实输入和结果状态，具体服务端/客户端原因仍排查，未延长预算或放宽断言。收据 `air110-netease-allartists-9bnu1l19/verdict.json`。

补充候选：iOS 111 的手机首屏分页设为 25，原公开上限和共享默认 100 不变；13 项 MB41ArtistSearchTests、Production 构建与签名检查通过，尚未装机。须先保留 Air 110 的 100 条请求验证服务端完整页面，再测试 111 首屏与后续分页。收据 `ios-phone-page25-dxuhyq10/RESULT.json`。私有 HTTP 分段观察的 6 项合成测试通过，默认关闭，不含查询或凭据；真机根因结论仍待观察。

最新 Air 结果见事项表 011 与外置收据 `air110-selected-page-runtime-receipt.json`：原100条本地歌曲、专辑已实际显示；网易云中文三类通过；来源入口泄漏与首次字母转圈仍在修复。完整工程检查尚未通过，不据此宣布交付完成。

### Air112 实际搜索、后续页播放与工程复验

Air112 单项05为0通过/1失败/0跳过；本地艺术家通过，专辑已ready25，但固定首个匹配位于屏外，原失败保留并修测试导航。人工搜索三类、专辑详情12首及返回位置已观察；第2首起播后371首后续队列完整，选择倒数第2首、近尾seek后EOS自动续播，下一首进度超过168秒。未试听或测LAN P95，完整上下文先补齐造成首次点播等待另查。证据 `air112-manual-search-and-playback.json`。

iOS完整MBLibrary在完整测试环境和5份夹具修正后671/671通过、自然exit0；产品源码未改，314个Packages Swift文件前后相同。原669失败保留。Mac source/auth定向Core103+desktop9通过，新SQL未封装；全Mac工程门禁仍失败。

2026-10-24 设备目标更新：Owner 已将后续真机测试由 Air 改为 SE。SE 已有线连接、系统配对并开启开发者模式，尚未安装 Mousa；当前 112 描述文件不含 SE。旧 Air 停止操作，14P 仍由其他项目使用。Air 的 5 项普通启动搜索测试已通过（`air112-scroll-search-m64bkcst/RESULT.json`），仅保留为历史设备证据；SE 的安装、连接、小屏与播放需重新验证。

SE 113 准备补充：独立测试运行器已为 SE 成功签名，尚未执行真机用例；新版搜索播放先使用已校验首批，再由播放模型持有同来源补页，34 项模型测试通过，完整音乐库测试与生产构建进行中。WAVE 修复在明确重建 Rust 原生二进制后，87 项相关测试全部通过、0 失败并自然退出；首次误用旧二进制的失败日志保留，不计修复验证。Mac 旧诊断启动进程因 stdout/stderr 管道读端消失产生 EPIPE，普通退出与 SIGTERM 未成功，已仅结束本次自有进程及所属隧道并普通重启；不记为正常退出通过。

SE 113 已签名安装并普通启动：34 项模型测试、679 项完整音乐库测试、生产构建、deep/strict 校验全部 exit0，379 个指定 Swift/工程输入构建前后相同。首页与四标签可见；第一次只读连接诊断未进入测试方法，停在系统 Enable UI Automation（触控 ID）并初始化超时。该失败不归因于搜索，也不计任何真机功能通过；等待 Owner 完成系统授权及确认 SE 的新增应用配对，Mac 工作继续。

SE 系统授权已生效：只读连接 test00 为 1 PASS / 0 FAIL / 0 SKIP（`se113-scroll-search-236xrmuj/RESULT.json`）。Owner 已授权 SE 应用配对，公开证书资料已复制至正式应用 Documents，配对尚在执行；没有操作旧 Air 或 14P。

Mac 最新独立门禁：Owner 33 项、完整容量 145 项、边界检查与 9 项反例通过。SQL 批次尚有 compact/full-envelope 测试形状差异和两项 CD01 原 2 秒超时，且嵌套入口缺失测试收尾导致人工停止；须使用原 root 入口复验。隔离副本没有 Git 历史造成 control-plane 失败，真实工作树原命令已通过；没有修改 Gate。收据 `se113-mac-closeout-WPa9Kc/RESULT.json`，正式目录日志 `se113-control-plane-real-worktree.log`。全工程验收仍未通过。

Mac SQL 原入口复验：恢复 root 测试收尾后，六文件批次自然 exit1，304 项中 302 通过、2 失败、0 跳过；原 compact/full-envelope 形状与读取预算断言已通过，仅 CD01 专辑、艺人两项仍超过原 2 秒期限。收据 `se113-sql-final-UiCQ1d/RESULT.json`。真实 SQLite 诊断显示 Source fields 回调为零，成员/问题 SQL 的 prepare 和 execute 都有明显成本；不能归因为重复读取 Source 正文。资格提取的 ART-only 单变量实验使成员查询更慢，问题查询在 prepare 失败，故未合入产品；两轮原测试与计划完整保留于 `cd01-eligible-paired-1sUEl7`。全 Mac 门禁仍未通过。

SE 配对续验：正确公开服务器与证书已在正式 App 确认；新运行器曾再次停在 Enable UI Automation，Owner 完成后，公开前台剪贴板探针 1 通过、0 失败、0 跳过，探针文字已清空，未提交配对。收据 `se113-pairing-clipboard-probe-eq5g619i/RESULT.json`。原失败把 enabled 与键盘后的 hittable 混为一个条件，修正仅在外置测试脚本。Mac CUA 窗口绑定持续报 noWindowsAvailable，已请 Owner 在普通界面生成新许可并完成 SE 配对；未读取手机凭据，搜索与播放尚未执行。

单来源入口补充修复：只读需求核对发现，Mac 已关联网易云的人物在统一搜索仅选“本地”时，展示层仍补出网易云按钮。现显式将当前来源范围传入人物卡聚合；全部来源及艺术家列表的已关联多入口保持原规则，头像资料不扩大作品范围。新增3项行为先复现，单文件 RED 9通过/3失败 → GREEN 12通过/0失败/0跳过，桌面类型检查 exit0；尚未封装或实际应用复测。证据 `catalog-source-filter-x3zliqc6/RESULT.json`、`catalog-source-typecheck-9deykyr5/RESULT.json`。

CD01 优化对照续验：资格提取方案已确认碰到 SQLite too-many-references，未应用。九字段仅计算一次的新 ART-only 实验能降低 prepare/execute 成本，三个合成库的所有观测均完整，查询没有新的 prepare 错误，但原专辑/艺人两个2秒测试仍失败；移除诊断 probe 后仍为1通过/2失败，故仍未合入产品。证据 `cd01-raw-paired-IgCepK/RESULT.json`、`cd01-raw-natural-MW6nhs/RESULT.json`。不提高原期限、不省略独立 resolve，也不将实验耗时记为真实曲库或局域网 P95。

CD01 空锚资格续验：仅移除未使用外层联接的 ART-only 对照仍未达到原2秒期限，未合入。新观测三个实际合成库共95次 Source ordinal 返回均为NULL、fields回调为0；只读核对其完整账本无 SOURCE_WRITES_V1 事件，结合原空投影初始化及真实facts写入规则确认资格。现仅私有Reader在原审计 fullRaw.size===0 时使用无锚点SQL；一旦出现有效锚点仍选原规则，空标签事实亦不等于无锚点。产品和行为验证尚未完成，不记为性能修复或完整门禁通过。证据 `cd01-outer-sf-paired-LDDxub/RESULT.json`、`cd01-ordinal-only-3OpTur/QUALIFICATION.json`、`cd01-no-anchor-fix-yahv_uez/FROZEN.json`。

最新工程门禁 r6：原3项 CD01 已在原2秒及独立resolve规则下全部通过，7项Source行为全部通过；冷封面比较改为先明确断言真实探测后的missing状态，再与冷页做完整逐字段比较。标准verify的类型检查与362项合同通过，Core主批次3654项中3652通过、0失败、2跳过，另8项排队Stop独立阶段通过并自然退出。桌面阶段已见28项失败，随后三个实际图片测试进程遗留Rust池，日志超过100秒无新增；保存现场后仅停止自有PGID并确认0残留，不计完整verify。正在补齐两个提取夹具依赖、精确关闭收讫帧和默认OFF闭集日志断言，以及三个测试文件的实际池收尾；不更改相关产品逻辑。证据 `cd01-no-anchor-cold-check-i6HsT2/RESULT.json`、`mac-source-prepare-verify-r6.json`、`verify-r6-desktop-stall-odwy67wv/STOP.json`。

## 自主执行与桌面完整诊断续验

Owner 要求全程自主。SE 113 的服务器与证书已核对、系统自动化及公开粘贴探针通过，但应用配对仍未完成。当前 Mac 的连接设置可读取，生成按钮操作未产生许可栏，坐标滚动报 `noWindowsAvailable`；未取得新许可，未传输许可，也未提交配对。该证据属于窗口控制器限制，不是 Main 配对服务拒绝；新包普通启动后继续核对，不再等待 Owner 代点。

原完整 Desktop 单元范围自然结束，2951 项中2877通过、71失败、3取消、0跳过，自然退出1，约14.7秒。原件 `desktop-full-diagnosis-1uYoGY/RESULT.json`、完整日志和 `FAILURES.json` 均保留。此前八文件定向批次81项中75通过、6失败，原 r6 的28项失败已消除，6项均为旧WebP/FD尾部假设；记录 `desktop-r6-fix-validation-k3p5gv/RESULT.json`。尚未将它们写成全工程通过。

后续按当前真实合同补齐退出与预热的资源依赖、Preload九项目录入口、分页尺寸、本地歌词读与Provider隔离、实际Catalog组件装配。发现详情刷新失败的提示隐藏及重试错页为真实产品缺陷，正在作最小修复并覆盖刷新和追加两类上下文；没有用放宽断言掩盖该缺陷。Root13份夹具修订与一次静态自查原件在 `desktop-root-regression-contract-8h2y3df3/`，尚未重新验证。

## r7类型门禁与r8续验

完整Desktop第二次诊断自然exit1：2956项中2928通过、28失败、0取消/跳过，收据 `desktop-full-diagnosis-fHXK6e/RESULT.json`。其后五文件定向207项中206通过、1失败，未取消/跳过；唯一剩余是CoverDrop旧显示夹具缺Owner网格副本。Root仅补合法grid字段，保全部原IMG新src、精确读取数、零写入和禁用断言；最小修订后整文件27项全通过，自然exit0，输入前后不变，收据 `coverdrop-grid-contract-check-5j8xgk8a/RESULT.json`。短暂的受控CPU叶变体没有合入：原断言已通过，Root额外要求fallback路径不符合实际直接网格分配，变体与失败原件保留于 `coverdrop-refresh-grid-fixture-7b3iphw9/`。最终宿主恢复原版本，产品未因该夹具更改。

真实播放codec源码测试现在从Core明确声明的esbuild 0.28.2在外置TMP内编译当前Worker；保存实际onLoad字节SHA和metafile闭包，原Worker资源帽、空env/execArgv、退出与join保持，测试结束检查真实使用大于零。两次五文件批次中该链通过；既不是同步fake codec，也不是已安装包运行证据。

标准r7自然exit2，停在测试帮助函数TMPDIR的类型收窄，尚未进入完整测试；原件 `mac-source-prepare-verify-r7.json`。Root补显式typeof，未改路径策略或生产代码；标准r8已启动，完整通过仍待实际结果。真实工作树control-plane/boundaries均exit0，原件 `current-worktree-final-gates-6irn_20l/RESULT.json`。两端差异检查exit0，保留原未提交工作。SE lockState只读显示passcodeRequired=false，不代表应用配对、搜索或播放通过。

## r8 完整标准验证与封装

标准 `corepack pnpm@10.17.1 verify` 在 2026-10-24 10:52:26–10:57:27 UTC 自然 exit0，300.30 秒，无超时或信号终止。全工程类型检查通过；合同 362/362；Core 主批次 3654 项中 3652 通过、0 失败、2 跳过，独立排队 Stop 8/8；Desktop 2957/2957，0 失败/取消/跳过；完整生产构建及 sandbox preload 依赖校验通过。原件 `mac-source-prepare-verify-r8.json`、同名 `.log`。原生 media-worker 构建前后 SHA 相同，且已包含此前明确重建的 WAVE 修复。

Root 未重复执行生产构建，直接封装该次 dist；工作树、隔离快照与同步清单的 2,902 个源码、测试及构建输入逐项一致。封装自然 exit0，`mac-r8-package-eUKomu/RESULT.json` 与 `SOURCE-IDENTITY.json`。原身份签名、普通安装启动、正常退出与 SE 真实功能验证尚在继续；软件全绿不写成这些运行层均已通过。

## 手机设置按钮与SE公开身份核对

Mac 配对按钮实际故障已定位并局部修正：全局歌曲行 `.row-actions { opacity: 0 }` 外溢到手机设置，使按钮在AX存在但视觉透明；仅在MobileConnectionSettings.vue局部加入opacity:1，未改业务。相较r8完整验证只有该CSS一处产品差异，生产构建自然exit0，886个产品输入一致；再封装2,902个输入一致、23目标签名及deep/strict通过，安装20261024.112455。真实App修复前后截图在 `mac-mobile-actions-opacity-2ifp4qti/`，修正后按钮可见，正式按钮已成功生成一次性许可。普通无诊断flag启动105.18秒后进入首页；该冷启动成本单列，不称已修复。此前110352已两次从菜单正常退出并确认主进程消失，无强制结束。

SE公开粘贴检查在原输入框未聚焦时失败；补原生tap及5秒键盘前置后，`se113-pairing-clipboard-probe-hsrstzh4/RESULT.json` 1通过/0失败/0跳过。随后17在首次公开地址精确核对失败，1.68秒停止，未读取Runner许可、未粘贴或提交；`se113-pairing-foreground-pair-c48g4jly/RESULT.json`。自动截图显示地址与指纹可见且键盘关闭，正在核对SwiftUI LabeledContent公开value与label的区别，不将选择器失败归因为配对服务。Mac临时许可已从界面收起、宿主中转文件已删除；Runner未消费文件待仅清理本次自有文件，旧许可不重用。仍未取得SE配对、搜索或播放通过。

## 最新Mac搜索与SE单次提交后诊断

最新真实Mac搜索记录 `mac112455-live-search-eAwKiX/UI.json`：全拼本地艺人精确项优先、人物默认本地详情、18本地专辑/1参与合辑/212参与歌曲分区、网易云资料标注、下拉保留当前详情、Esc保留查询、同词重开、回车完整搜索、已关联人物多来源合卡、本地筛选仅本地入口、详情返回保留关键词与筛选均已观察。中文查询通过系统粘贴输入；本轮不冒称重新验证原生IME或新播放。

SE公开AX诊断21真实1通过/0失败/0跳过，确认地址label为中文顿号“地址、https://…”；原17接受英文逗号的假设已仅在ART修正为新增该精确形式。旧自有Runner许可通过lstat后删除、未读bytes；`se113-pairing-public-identity-qmpa3oie/RESULT.json`。新许可已从正式Mac界面生成并单次提交，17在30秒内未确认已连接终态，`se113-pairing-foreground-pair-42ehpw9s/RESULT.json`；Runner文件已在粘贴前删除，宿主中转文件已删除，剪贴板仅localOnly/30秒并按所有权清理，值未记录，未重复提交。Mac活跃配对条目2→3，SE后续首页已有真实歌单1222项，客户端终态仍未直接核实。

只读00在设置gear点击后找不到settings.connection，`se113-pairing-connection-detail-ft7k25st/RESULT.json`。原九项批次自然exit65，0通过/1失败/8跳过：01找不到音乐库标签，02–09无法建立连接状态读取前置，均未执行搜索断言；`se113-pairing-search-all-rw_v4kkd/RESULT.json`。真实AX显示原生标签栏当前折叠，仅首页/搜索直接可见；正在分离系统导航状态与客户端连接状态，不把这些脚本前置失败称为真实搜索失败或成功。曲库安全恢复前新增只读SQLite备份973160448字节、quick_check=ok，`library-before-root-recovery-t5s_jdmr/BACKUP.json`；尚未重新关联或扫描，音频未改。

测试机变更：Owner 通知 SE 存在问题，要求换机；已停止 SE 后续运行、安装与触控，不操作被其他项目占用的14P或已停用Air。只读设备清单已核对，新目标等待名称；Mac工作继续。22诊断自然exit0只代表诊断完成：实图初始栏折叠，第一次首页点击后四Tab展开；第二次截图为系统控制中心而App AX仍显示首页，不能把后台AX当当前画面。证据 `se-native-navigation-observation-v7xitp06/RESULT.json`。17超时已查明测试假设不符合产品成功终态：连接身份发布后导航会清栈回首页，详情disconnect消失；这不等于鉴权失败，仍需新设备直接核实连接与搜索。

新设备指令：Owner以“14-”回复，按唯一已连接iPhone14P接替SE；随后优先要求给iPhone Duo真机安装最新版。14P只读已核Mousa106/未锁，114针对14P构建与签名通过，379项源码与已验证113一致，尚未安装。Duo真机UDID末尾EA00036、iOS27.1/开发者模式已开/未锁/Mousa未安装已核，不是同名模拟器。Duo114签名构建自然exit65：Apple提示当前团队iPhone注册已满，描述文件不含该UDID；只读审计6份本地profile，0份覆盖Duo，未改账号/注册记录或安装未签名产物。已请求可用签名团队，常规代码工作继续。证据 `duo-physical-install-preflight-fkygl560/`、`ios-duo114-etgl5w4x/RESULT.json`、`duo-local-profile-audit-swmtyrre/RESULT.json`。

当前Mac112455已从原生菜单正常退出并确认0残留，`mac112455-normal-quit-2e20thqj/RESULT.json`；普通重启105.30秒记录FINAL_READY，但随后CUA仍读准备占位。该次日志已见实际Vue App setup与onMounted后的闭集事件，不能直接称启动Promise死锁；正在核对当前窗口/快照身份及真实Renderer样本。`mac112455-root-recovery-normal-jew2bh2u/`。


2026-10-24 最新设备与工程状态：Owner 已要求暂缓 Duo 签名名额问题，恢复 SE 测试；没有删除 Air/SE 设备注册、证书或其他设备配对。重置后 SE 的 UDID 与重置前一致，114 已签名安装并普通启动（`ios-se114-install-1lv_jl6y/RESULT.json`）。首次运行器初始化超时，Owner 完成新系统授权后，`se114-pairing-connection-state-_qxco8qe/RESULT.json` 已实际执行 test23，公开设置显示“尚未连接”，0通过/1失败/0跳过；这是应用连接前提尚缺，不计搜索或播放测试执行。接下来按既有授权重新配对。

旧曲库恢复新增了活动库过滤、完成扫描后的原游标恢复与持久暂停。`artist-backfill-recovery-checks-U6OCSn/RESULT.json` Core类型检查 exit0，58项定向全通过；`mac-source-prepare-verify-r9.json` 全标准检查自然 exit0，312.08秒，合同362/362、Core3652通过/0失败/2跳过、另Stop8/8、Desktop2957/2957及生产构建通过。两批分别记录，不叠加冒充一次执行。审查发现无快照能力时的完成回调门禁、排队期间撤库后Reader准入两处边界，正在补测，尚未操作真实目录增量扫描。当前正式应用仍为112455，008新实现尚未安装；当前华语76485首为活动库，另5个已撤历史库不重新导入。

112455普通退出已通过（`mac112455-normal-quit-2e20thqj/RESULT.json`），没有强制结束；再次普通启动后重新选择正式应用窗口，真实首页可见（`mac112455-root-recovery-normal-jew2bh2u/UI-RESELECTED.json`）。早先CUA准备页观测与实际挂载日志不一致，不据此认定启动死锁已修复；约105秒启动准备成本仍单列。Owner视觉、听感与真实局域网性能未验收。


008审查补强与安装：四个新增行为先得到8通过/4失败的RED，修复后64项全部通过且自然退出，包含原真实只读FD链；见 `backfill-review-boundaries-hua1ovn8/CHECKS.json`。额外扩大到旧V39完成快照诊断时，该入口缺少其要求的CUE声明，并有原并发夹具1与实际2不符，78通过/3失败/1文件期限取消；该批保留、不计通过，没有修改旧断言或降低期限。最新标准r10仍按原冻结入口执行，完整自然exit0（307.25秒），包含最新产品改动。当前Mac候选20261024.132038，asar `07809069c47b5363b996a37643b864a96d225cb81cf9d7f80d482b7d9ecea45f`，2903个封装输入匹配、38个编译文件逐字节核对，23个签名目标及原身份/deep strict校验通过。已正常退出112455（无强制），保留应用备份后安装，普通无参数启动，尚未开始真实扫描；收据 `mac-artist-recovery-install-rnbho_nd/INSTALL.json`、`mac132038-normal-0dkby11n/START.json`。

SE114准备阶段两次失败均未提交许可：首次公开地址成功保存，键盘检查与实际消失时序冲突，自动截图无键盘；第二次旧setUp在折叠首页恢复失败、未进入24方法。新候选将仅让24/25管理各自当前页面前置，保留旧方法行为；不把测试导航失败记为鉴权、搜索或播放失败。没有生成新的私密许可，全部旧设备配对保留。
