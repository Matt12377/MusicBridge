# TASK-072：正式 Profile Snapshot / RecordingPlan / Preflight

## 身份与授权

- 基线：`6323b3431ec7beeaba851155c062f9fae4bf41ea`（TASK071最终封版）。分支：`codex/task-072-recording-plan`。
- 实现提交：cab05c2c8eb367dbabfd703b4bd6eef9a96d046f。报告提交由最终STATUS锁定，最终HEAD见本机final-closeout.json；TASK073必须从该最终HEAD接续。
- Owner于2026-08-28确认F-01保守保留方案并授权持续开发，GPT-5.6 Sol / High三路按路径分工；仅本地提交，不push、不合并main、不发布。所有账号、音频、库存和目录均为临时合成输入，没有访问真实音乐/设备/账号。

## 交付

1. 增加不可变RecordingPlanVersion与持久幂等账本，schema18。明确选择执行资产及其FINALIZED归档，再读取当前Session的Profile版本、Overrides和effective参数形成新快照。原执行资产编译参数单独保留；固定执行格式必须一致，不修改旧资产，不取各集合latest拼接。
2. 计划冻结Master/Layout/PlannedTimeline、Prepared与RenderTimeline（适用时）、精确执行Manifest/Hash/格式/后端/谱系、实体副本和预留、媒体规划revision、完整参数及归档政策。当前节目类型、曲序、metadata和源时长重算布局必须相符。显示标题变化不迫使替换内容相同且明确选中的旧版本。
3. ADR032区分身份冻结与正式执行准入：本任务可保存身份；全部Plan与Preflight仍formalReady=false，backend固定NOT_RUN/BACKEND_NOT_CERTIFIED。八项只读预检核对当前版本、源、执行资产、归档、实体预留、容量、参数及后端。没有Start、Attempt、声卡或自动播放入口，库存使用状态不变。
4. 桌面增加计划与预检面板、明确空选择、提案确认、历史分页、逐项阻断和只读取消。迟到结果及切换代际隔离；读取失败不伪装空历史。冻结使用原outbox，未知回执原命令重试不创建第二版。Main/Preload/Utility有限合同与可信入口、长文件操作期限和安全错误映射均接入。
5. F01新计划记录f01-permanent-execution-v1：成功实际执行音频及谱系、Prepared原始Render永久保留，原始源按选择政策，失败/取消无自动删除。新完整备份含归档音频并接受schema18；旧14～17兼容、旧未决历史原值不改。实际隔离恢复保留Plan/账本但撤销外部授权，预检仍阻断；篡改校验不损原库/原备份。
6. 每草稿完整历史在freeze前按UTF-8计算8MiB减64KiB余量；最多100版本，全库10000版/128MiB，不以截断旧历史满足预算。

## 最终自动 Gate

最终候选55代码/测试/config文件，固定native13文件；指纹`dce1eb19c141f14f67acc015a0438e3d961c71e9a2ea2b339a05b6b9731f3ca7`。旧SPEC2清单54条中包含生成的test-results/.last-run.json，最终明确排除该运行产物；原53项的剩余差异只有桌面第二轮已审的两文件中文文案；另增加两个旧E2E的schema终点兼容断言。

| 检查 | 结果 | 退出码 |
|---|---|---|
| 最终canonical verify（类型/单元/生产build） | Contracts127 / Core922 / Desktop414，全部通过 | 0 |
| 安全 | 27/27 | 0 |
| Electron启动、crash/restart与合成保险库冷启恢复 | 4/4 | 0 |
| Electron后恢复生产build | 最终verify与E2E入口均完成生产构建 | 0 |
| 完整E2E，MUSIC_BRIDGE_NATIVE_GATE=1 | 75/75，零skip，2.8分钟 | 0 |
| E2E类型 / control / boundaries / cycles | PASS / 旧范围PASS / PASS / 205文件PASS | 0 |
| 最终candidate/native/diff | 55/55 / 13/13 / PASS | 0 |

新增两项实际Electron合成场景覆盖当前Session与asset编译参数分离、未知回执原命令重试仅一版、冷启动历史保持、释放实体预留后阻断、取消迟到结果及读取错误脱敏。root逐张查看最终6张截图：提案、720/1440预检顶部与backend末项、错误提示；窄窗通过面板内垂直滚动查看，未见水平溢出。指定区域axe serious/critical为零，不将截图或自动Gate等同Owner视觉接受。

## RED/GREEN、审查与裁决

- 合同初始1/9 RED到9/9 GREEN；另有源/RawRender谱系RED/GREEN。Core计划初始缺实现到行为通过，最终20/20。桌面38项focused，Main/Preload/时限48项focused，备份/恢复/IPC集成均在最终922 Core与414 Desktop内重跑。
- SPEC1唯一P2：相同规划spec重存后可将新节目内容与旧M/L拼接。两个真实业务场景0/2 RED到20/20 GREEN，比较节目类型/曲序/metadata/重算布局；允许仅显示标题变化。Core SPEC2最终PASS，QUALITY1有界PASS。桌面SPEC2→QUALITY2最终PASS；root接线SPEC1→QUALITY1 PASS，两个旧E2E终点适配另在第二轮有界审查。所有模块至多两轮，无第三轮。
- 首次verify Core918项902通过16失败，原因是旧迁移fixture终点仍17，或合成降级未删新计划表。只修测试前置与当前终点，保留原回滚和逐列守恒，176/176 GREEN，最终全量922通过。
- 新E2E首轮2失败：合成sourceRoot包含输出/归档目录，被既有防重叠保护拒绝；仅分离合成目录，第二轮2/2。截图取景随后修正为预检顶部/后端底部和error区域，原业务断言保留。
- 包装和预留原始英文枚举改为中文与“冻结时已预留”，实际SFC 2/3 RED到3/3 GREEN，桌面最后两轮报告按明确delta核对。
- QUALITY P3仅静态观察：相同mediaPlan同内容重存只增长revision时，预检可能保守阻断并误归因COPY_UNAVAILABLE；应分类为versions/VERSION_MISMATCH。未单独复现，没有放行或改写历史风险；root有界延期至后续预检分类测试，不因Minor启动新循环。

完整E2E首轮73/75，两失败均为当前库已升级18而旧测试期待17。仅将TASK069与TASK070各一处PRAGMA断言改为18，后续库存、账本、外键与冷启动断言原样保留，focused2/2通过；原日志和全部产物保留。

证据：reports/runtime/task-072-recording-plan/，含每轮RED/GREEN、失败E2E产物、固定schema17迁移来源、SPEC/QUALITY、candidate-final、最终Gate及截图。原失败证据保留，不把重跑通过当成根因证明。

## 接续与未完成

TASK064～079完整TODO保持；TASK072本地自动阶段收口后从最终HEAD接TASK073输出后端。后端真实Gate B、声卡/录音机选择与测试电平/故障操作/独立时基测量需要Owner明确授权，不用合成sink或驱动回执伪称实际无声。F01已获确认，不再当作待决前置。

真实Roon/Provider、Source Roots、实物、Excel、Logic、正式录音及Owner产品/视觉验收均NOT_RUN。TASK047真实歌词、TASK061发布准入、R020大库/Gate E、既有视觉carryover、签名公证和Beta发布保留。预检P3误分类也保留。远端main/TASK072于最终封版再次只读核验，未push。
