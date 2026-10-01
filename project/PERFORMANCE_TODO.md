# MusicBridge 性能与正确性实施进度

**实现完成：6/11 · 本地软件验收：6/11 · 真实 Mac/Roon：未执行**

当前任务：**MBP-003B — 先播与按需补队列**。基线 `0212560`，分支 `codex/mbp-003b-demand-queue`。

本计划已获 Owner 授权连续实施。技术栈保留 Electron、Vue、Node/TS；真实播放、设备录音、main 合并、正式 App 替换和发布分别记录，不由软件测试代替。

## 当前子步骤

- [x] MBP-001 本地软件 Gate、独立实现/报告提交和开发分支 push；远端 HEAD 已核对。
- [x] 从 MBP-001 报告 HEAD 创建 MBR-001；真实 Roon/音频与系统钥匙串未执行。
- [x] 旧 terminal 与 Stop 失败的 RED/GREEN 行为验证：新增 17/17、Controller 89/89、Native 53/53。
- [x] Adapter 的每个 Zone 新鲜度、曲目确认和可重试停止：Adapter 80/80、诊断 9/9。
- [x] Renderer 旧集合分页、停止重试与键盘冒泡修复：相关回归 65/65、实际 Chromium 键盘 1/1、Core/桌面类型通过。
- [x] 固定实现 `2b79715` 全量 verify 退出 0；原 Electron 启动/恢复门禁 4/4。
- [x] 原完整 Electron E2E 已执行：84 通过、19 失败、4 个原有条件跳过，退出 1；未缩小范围。
- [x] 修正设置返回收藏与窄窗按钮无名称的实际问题；侧栏实际 Vue 8/8，7 项 E2E 失败路径均按原因修正并重跑通过，保留业务保护。
- [x] 固定最终实现 4c36e95：完整 verify（Contracts 222 / Core 1609+原2跳过 / Desktop 880）、Electron 4/4、全量 E2E 103+原4条件跳过，退出均0；独立报告提交后接续。

MBP-001 远端已结束：security 通过，verify/Electron E2E 失败。本地全量 verify 固定 `d89c3ea` exit 0。原始日志与产物已保存：19 项在 `e97f9e5` 基线同样失败，其中 17 项 UI 夹具失配、2 项设置返回收藏导航缺陷；新增 2 项失败表现分别为大目录超时与隐藏打印窗口选择竞态。`2b79715` 本地大目录和打印用例通过，但不替代远端失败归因。verify 测试写死本机 TMPDIR 已修正；远端验收尚未通过。

结构基线：250 条播放上下文先读完 10 个剩余页；专辑/艺人/歌单首屏 24 条各读取 250 条；50/500/5000 队列双 tick JSON 估计总负载为 25,662 / 253,371 / 2,570,880 字节。这些是合成结构观测，不是实际 Roon 耗时或 Electron 线上字节。

## 任务顺序

| 顺序 | 任务 | 实现 | 自动验收 | 交付范围 |
| --- | --- | --- | --- | --- |
| 1 | MBP-001 | 已完成 | 通过 | 基线、Trace、负载夹具 |
| 2 | MBR-001 | 已完成 | 本地通过 | 播放终止、停止失败、Zone 确认、旧队列与键盘正确性 |
| 3 | MBP-002 | 已完成 | 本地通过 | 只读取消、截止期限、共享读取、导航和加载状态 |
| 4 | MBR-002 | 已完成 | 本地通过 | 录音未知回执恢复、SSH 探测关闭、Control API 防护 |
| 5 | MBP-003A | 已完成A | 本地通过 | 短状态处理与优先控制；属于 MBP-003 的第一步 |
| 6 | MBP-004 | 已完成 | 本地通过 | Roon 详情真分页与原始游标 |
| 7 | MBP-003B | 已完成 | 本地通过 | Core 持有上下文，先播并按需补队列 |
| 8 | MBP-006 | 待开始 | 未执行 | 小进度事件、队列版本与重连恢复 |
| 9 | MBP-005 | 待开始 | 未执行 | 作用域缓存、网易云歌单快照、渐进搜索 |
| 10 | MBP-007 | 待开始 | 未执行 | 虚拟网格、封面竞态修复和资源预算 |
| 11 | MBP-008 | 待开始 | 未执行 | 批量 SQL、进度匹配与历史预算热点；worker 按测量决定 |
| 12 | MBP-009 | 待开始 | 未执行 | 接口收口、全量回归、性能对照与实机验收记录 |

MBP-003 只有 A/B 都完成并验收才计为一个完成任务。每个完成项绑定固定实现 SHA、报告、退出码和证据；没有证据不勾选。所有 Gate 保持原有范围，不新增 skip。

## 验证边界

- 结构测试检查调用顺序、次数、状态、身份、库存和事务一致性。
- 集成性能夹具使用合成数据与隔离库，不连接真实账号或音响。
- 毫秒目标先作为待测目标：pending p95 ≤ 50ms，应用自身控制排队 p95 ≤ 20ms；实际 Roon 等待另列。
- 真实设备录音仍受 Gate B 准入约束，本轮不会补造授权或成功回执。
- 后续分支从上一任务最终报告 HEAD 创建；保留当前收藏 UI 和用户数据。

最终 MBR-001 实现 4c36e9554900591b367add7edfc16985690f7a03；本地 Gate 通过，报告 HEAD 37fe2d2 已推送并核对。源码指纹和全部退出码见 reports/MBR-001_EVIDENCE.json。远端结果已结束，见下方独立作业结论。

### MBP-002 当前子步骤

- [x] 从 MBR-001 最终报告 HEAD 创建独立分支，确认外置卷与工作区。
- [x] 只读白名单与期限/取消协议，保留写命令和未知回执；Main/Preload 协议 71/71，退出 0。
- [x] Core 共享读取、独立订阅者与最后订阅者取消；固定 flight 期限、排队零派发及未返回工作预算已有定向证据。
- [x] Provider 迟到回调、账户作用域与 Roon 状态不明会话隔离；生命周期 13/13，退出 0。
- [x] Renderer 导航、加载状态、防抖与返回路径的 RED/GREEN；最终九文件 118/118。
- [x] 固定实现 28bac4a：verify 223 / 1626+原2跳过 / 941；mock Electron 4/4；完整 E2E 104+原4条件跳过，退出均0；源码826文件指纹一致。
- [x] 独立报告 f672c9f 提交、开发分支 push，远端 HEAD 精确相同。

MBP-002 首个固定 bc04b71 的 verify 为 931 Desktop通过/1主题夹具失败，未达到构建；两次实际Electron定向分别证明旧IPC夹具失配与目标详情收藏读取误取消。失败记录和原断言保护见 reports/MBP-002_READ_LIFECYCLE.md，最终冻结实现全量重跑通过。

首次Electron命令漏设mock，实际system模式合成值4项通过，已如实保留；随后明确mock重跑4项及完整E2E均通过。真实账号、Provider、Roon与录音未执行；真实凭据Owner验收未执行。

MBR-001 远端固定 37fe2d2：verify 作业通过，Electron E2E 工作流通过，security 通过；verify 工作流因独立 dependency-audit 失败（11 moderate / 7 high），不标为全 CI 通过。依赖审计纳入后续门禁收口，原始日志已保存在外置证据目录。

### MBR-002 当前子步骤

- [x] 从 MBP-002 报告 HEAD 创建独立分支，保留原无关未跟踪目录。
- [x] 只读预检确认：终态未静止却放行、Begin 在途历史切换、SSH 探测失去关闭所有权、Control 来源/请求预算缺口。
- [x] 原 commandId + 完整请求 + Dataset 的只读回执合同与 IPC 已接入；合同 14/14、Main/Preload/SSH 首轮 24/24；等待固定实现全量验收。
- [x] 软件关闭证明、失败后精确停止恢复与 Renderer 离页/历史锁，定向与全量均通过。
- [x] SSH 探测和子进程取消、确认退出与有界资源保留；独立代码复审通过，合成测试与 Control 合计 27/27。
- [x] Control API Host/Origin、JSON 与请求/停止预算；仅隔离 loopback 验证，未连接真实服务。
- [x] 固定实现原全量 Gate、独立报告和开发分支 push；报告 `a838a00` 与远端HEAD一致。

三名 `gpt-6.1-sol high` 子智能体已完成 Renderer、Core Attempt 的修正与独立复审。成功 Stop 后保留原请求，可手动重试失败关闭；驱动局部清理不再提前解锁，须等 Core 输入租期释放。Renderer 四文件 92/92、Core 补修五文件 141/141、历史静止夹具 14/14、主流程 3/3 均退出0；冻结实现后继续原全量 Gate，不用定向结果升级本轮总计。

固定首个实现 `8421ea1` 已跑原完整 verify，退出 1：Contracts 224 通过，Core 1634 通过 / 7 失败 / 原2跳过；Desktop 测试与构建尚未到达，三层类型检查通过。源码827文件前后指纹一致。4项为 pre-spawn 拒绝后的生产收尾回归，原断言保留并补修；3项是旧历史静止夹具、Stop 原回执与最新 Attempt 版本混用，需修正夹具并继续保留缺静止拒绝、不可变回执、CAS和冷启动保护。当前并行修复后重新冻结；不将首轮失败写成通过。

七项失败的修正已冻结：原 formal-provider 三项与 output-recovery 一项断言未改；安全 pre-spawn 拒绝保留失败 Attempt/barrier，只有精确关闭证明和有效输入释放才解除资源锁。历史缺静止证明夹具在 Begin 前构造旧 store 路径，不修改已写事实；主流程继续检查原回执不可变、旧 revision 拒绝及最新状态冷启一致。新固定提交将重跑原完整 verify 与 Electron 范围。

MBP-002 固定报告 `f672c9f` 的远端后续结果：verify 作业通过、security 工作流通过；verify 工作流仍因 dependency-audit 失败（11 moderate / 7 high）。Electron E2E 为 103 通过、4 原条件跳过、1 失败（v5 的 Core crash marker）；原始日志与测试产物已保存，但未保留进程实际输出，无法确认本次失败的唯一原因。独立内存复现确认固定 1 秒采样和迟装 stdout 监听存在竞态；本轮已修正并保留双崩溃、只重启一次、真实关闭与退出码断言，相关 unit 27/27，仍待完整 Electron 验证。

MBR-002 最终固定实现 `200da19`：完整 verify 224 / 1648+原2跳过 / 975、三包生产构建，mock Electron4/4，原完整E2E104通过+原4跳过，均exit0。827源码Gate前后指纹一致；v5 Core crash 用例本次本地通过。独立报告与证据已保存，完成报告提交及开发分支push后立即接续MBP-003A。远端CI与真实设备仍单列，不扩大本地通过结论。

### MBP-003A 当前子步骤

- [x] 从 MBR-002 最终报告 `a838a00` 创建独立分支，确认外置卷与无关WIP保留。
- [x] 仅读定位长 operationTail、准备中原生所有权缺口与内部取消接口。
- [x] 短状态处理、外部播放准备、队列填充与完整身份隔离；定向行为验证通过。
- [x] Roon派发边界、可取消确认、捕获Zone与停止未知保护；100项定向验证通过。
- [x] runtime换Zone覆盖准备/派发所有权，独立行为审计；原断言与资源保护保留。
- [x] 最终固定c2038e6：原完整verify、mock Electron4/4、完整E2E104+原4跳过与静态Gate，退出均0；827源码指纹一致。
- [x] 独立报告与119份证据Hash已封存，报告提交即本步骤软件交付。
- [x] 开发分支push；报告c91c537与远端HEAD精确相同，tracked工作区清洁，无关WIP保留。

MBR-002 固定报告 `a838a00` 的远端检查已结束：security和Electron E2E通过，verify作业通过；verify工作流仍因独立dependency-audit失败（11 moderate / 7 high），原始日志已保存。MBP-003A完成仍不增加总计，须后续003B一起验收。

MBP-003A已有RED：Controller慢metadata/URL/preflight与小批插入4项失败；生产runtime组合两Zone入口11项中音量原独立路径通过，其余10项复现准备撤销、原生所有权和真实SDK回执排序缺口。Roon适配层97项定向通过；Controller仍实施，不以局部结果勾选软件验收。

MBP-003A随后定向通过：Roon100/100，生产runtime组合25/25（含17项新增行为），Controller最终105/105及严格类型通过，外部Stop排队捕获Zone保护已包含在最终冻结中。Transport确认和实际SDK回执使用独立屏障；同turn意图、Stop未知、迟到准备、新所有者资源、Smart取消与有序控制保持。独立审计和原完整Gate尚未结算，未升级总计。

固定首个实现 `a6abd4c` 原完整verify退出0：224 / 1697+原2跳过 / 975，三包构建通过，827源码Gate前后指纹相同。Root补查复现最后意图结算后已发布canStop仍为true、实际所有权已释放的差异（独立内存复现及新增契约测试均exit1）；补修结算时发布能力变化，Controller106+runtime25共131项通过，未修改已有断言。补修后重新固定并重跑原完整Gate，不沿用首个通过覆盖新代码。

第二固定 `d30bfdb` 原完整verify退出0：224 / 1698+原2跳过 / 975；827源码指纹前后一致。独立窄审发现普通已确认播放成功Stop的公开canStop结算遗漏，Provider/Native两个行为case实际RED退出1；matching Stop flight结算时发布能力释放，未知停止锁继续保留。Controller108+runtime25共133项GREEN退出0；最终代码重新冻结后完成原全量Gate。首次RED命令在仓库根找不到tsx，属于执行入口错误而非行为RED，修正工作目录后的两项失败证据单独保留。

最终固定 `c2038e6`：原完整verify224 / 1700+原2skip / 975、三包构建，mock Electron4/4，完整E2E104+原4条件skip、零失败/零flaky，退出均0。827源码SHA cff7fa95…Gate前后完全相同；MBP-003A软件子步骤通过，整个MBP-003仍待B步骤，总计保持4/11。

### MBP-004 当前子步骤

- [x] 从MBP-003A最终报告c91c537创建独立分支与外置证据根。
- [x] 只读设计与接口冻结：response-only sourceEpoch/complete/nextOffset，保留原请求和业务遍历顺序。
- [x] Core按原始页增量展平、作用域失效与有界缓存；最终63/63及严格类型通过，字节准入补修有实际RED/GREEN。
- [x] Renderer下一游标、混代拒绝/有界恢复、未知总数和选曲/关联兼容；冻结80/80及严格类型通过。
- [x] 公共合同、scope失效通路和隐私映射验证：合同230/230、公共库21/21及严格类型通过。
- [x] 独立增量边界行为测试与源码复审；独立文件23/23，两轮审计与最后指定delta闭合，最终源码待原统一Gate覆盖。
- [x] 固定0df9fb5原全量Gate通过，独立报告和证据已封存；报告提交后push核对远端。

独立增量边界测试已冻结23/23（0失败/跳过）；album/playlist首屏50、500、5000项均1次load/5条raw，group-first artist均2次load/10条raw。Core原两份规格54/54，Renderer分页/选择器上一轮73/73通过，仍待作者最终冻结及统一Gate。最后复核正在补明确缓存字节预算；计数限额不能替代字节限额。root total保持SDK raw行口径，detail total仅有效EOF总数。尚未升级整体任务总计。

最终固定MBP-004 `0df9fb5`：原完整verify230 / 1744+原2skip / 997、三包构建，mock Electron4/4，完整E2E104+原4skip、零失败/flaky，静态Gate均exit0；830源码指纹422ce0a3…前后相同。软件完成5/11；MBP-003仍待B。独立报告创建后推送并核对远端，再连续接续003B。

MBP-004报告 `02125604ab19a62f85a7b75d84b400f9d0e3f105` 已推送，远端HEAD精确相同，tracked工作区清洁，无关WIP保留。远端CI未作为本地通过结论。

### MBP-003B 当前子步骤

- [x] 从MBP-004最终报告创建独立分支，确认外置证据与工作区。
- [x] 只读设计：响应opaque handle、Core独立owned Browse session、stateless页接口和手工队列事务编辑策略。
- [x] 公共合同与IPC薄适配；合同236/236、Utility54/54，runtime组合6/6；非法/互斥handle在停止旧播放前拒绝，尚待最终统一Gate。
- [x] Core授权窗口、独立session/epoch、pin与预算；5规格128/128和隔离类型exit0，UI离页取消不破坏续播。
- [x] Controller先播、单页预取/边缘补页与自然推进；145/145、隔离类型及冻结前后指纹通过，保留当前项对象、Stop未知与实际设备barrier。
- [x] Renderer不先collect全队列；9文件已冻结，75/75与隔离类型exit0，后台曲目收藏/重播和旧缺字段兼容。
- [x] 独立行为审计、固定原全量Gate、报告；开发分支push即将精确核对。

50/500/5000项生产runtime组合（外部服务为合成夹具）均确认：所选曲目先派发，随后最多读取一页、窗口不超过101项；这是调用顺序与工作量证据，不是真实Roon耗时。独立复审捕获数字索引/prefix竞态及错误数组冒充枚举，已保留实际RED并补修；Core已核Zone换代后稳定动作引用，Controller已核队列外切歌撤销和同turn编辑。Root组合runtime/Utility85/85、Main/Preload11/11通过，最终原全量Gate待固定源码，总计仍5/11。

首个固定1fff4d9原完整verify退出2，在Contracts新测试helper命令参数被推断为string处停止，未到测试或整体构建。仅补IpcCommand类型注解，生产与行为断言不改；三包类型入口随后均退出0。新固定源码将重跑原完整Gate，首轮失败不计通过。

最终固定003B `77101e1`：原完整verify237 / 1802+原2skip / 1020、三包构建，mockElectron4/4、完整E2E104+原4条件skip，零失败/flaky，静态Gate均exit0；837源码SHA dc33ee87…前后相同。003A/B整体完成，总计6/11。独立报告提交/push后从报告HEAD连续接续006。上一报告0212560远端verify作业/security/Electron E2E通过，工作流仍因dependency-audit失败11moderate/7high；全CI红灯不隐藏。
