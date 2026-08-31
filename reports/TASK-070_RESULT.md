# TASK-070：Want List 与收藏完成度

## 身份与授权

- 基线：`d2735054e7f1481db9eccf058c5d400ba87b3019`，TASK069最终锁定。
- 分支：`codex/task-070-want-completion`。实现提交：`0ce37b290748c76304ca9c14a2d1cf4cf8b821f7`；报告提交由最终STATUS锁定，最终HEAD由本机final-closeout.json和TASK071基线锚定。
- Owner持续开发及GPT-5.6 Sol / High互斥范围并行授权；本地提交，不push、不合并main、不发布。全部资料、库存、故障、图片和音频为合成输入；没有读取真实用户资料或连接真实Provider/Roon/设备。

## 交付内容

1. Wanted与Owned/Missing/Unknown正交，已拥有型号可继续求另一长度、包装或品相。求购不改变库存、不购买、不抓取价格。金额保留有界精确正十进制字符串和显式资料币种，不做浮点转换。
2. 求购新增、编辑、取消均需明确确认；expectedVersion避免覆盖并发变更，commandId重试幂等。取消为终态，每次变更保留不可变版本。只向当前目录head写目标，目录修订不自动迁移旧目标，旧目标动态needsReview，人工重绑才建立新版本。
3. canonical型号和版次计一个完成度单位，整体、品牌、系列分别显示Owned/Missing/Unknown及独立Wanted。确认关联且当前实际在手大于零才Owned；候选、待复核不自动贡献。旧修订求购单列，不拼到当前目标。
4. 当前持有长度来自Lot剩余池和Physical Copy，预留/不可用但仍在手实体计入且不双计；零余额不认拥有，未知/目录外长度单列。目录未列已知长度时不能声称集齐。型号详情使用真实读取，加载/失败不显示伪0。
5. 读取current只返回当前事实，请求旧revision明确标记旧目录下当前事实。只有显式capture保存整本目录的不可变统计、条目、长度和Wanted id/version；绑定当前head与全批fingerprint，不受分页影响。TASK068旧快照保持原字节，未采集的新维度不补值、不伪0。
6. schema17四表：求购当前态、不可变事件、完整快照、账本，同SQLite事务。128MiB持久TEXT预算，10000求购、事件与账本合计100000条、5000快照、单JSON8MiB；超限拒绝新事务，不删历史。账本核验使用逐行iterate，保留顺序、版本连续性与计数校验，避免一次驻留所有大回执。
7. 六读与三写共九API接入可信Main、preload和Core；三写复用持久outbox与原dataset scope。失回执保留原命令，冷启不重放，人工恢复幂等；切库后旧scope拒绝。schema14/15/16旧备份保留，新17完整核验、隔离恢复、激活、冷启保留Excel原字节、照片、更正和求购历史。
8. 收藏页“完成度与求购”面板，保留两收藏tab、照片墙和单侧栏。来源/Wanted列表独立加载与失败恢复；写入及目录上下文仍互斥。历史页最多请求25条，按真实UTF-8响应预算返回较小有效页；不截断完整分组，前进用实际条数，后退保存实际访问offset，失败保留旧页与路径。

## 自动Gate与身份

最终41代码/测试/夹具/配置文件Git blob一致，固定native13文件SHA-256一致。最终指纹 `7c3563906bc058c7c0982d7dbf167a10a5d84c86df93a21931f816f68c53eed3`。

| 检查 | 实际结果 | 退出码 |
|---|---|---|
| canonical verify：类型、单元、生产build | 合同118/118、Core897/897、Desktop337/337 | 0 |
| 安全 | 27/27 | 0 |
| Electron启动、crash/restart、合成safeStorage和冷启恢复 | 4/4 | 0 |
| 完整生产E2E，显式MUSIC_BRIDGE_NATIVE_GATE=1 | 66/66，零skip | 0 |
| Control / Boundaries / Cycles | PASS（旧控制范围）/ PASS / 196文件PASS | 0 |
| 最终E2E类型检查 / diff-check | PASS / PASS | 0 |
| 最终候选与native复核 | 41/41 + 13/13一致 | 0 |

新增六个真实Electron合成场景覆盖九API、Owned+Wanted、长度守恒、不可变历史、目录修订人工重绑、Main真实回执失败/冷启/切库、明确UI确认、独立资源失败、大目录分页及前后往返。合法500项长品牌/系列、25份快照原列表16,886,760字节，持久表46,977,500字节；修复后每页通过正式8MiB响应guard，全部快照无遗漏重复，全部品牌/系列保留。

root逐张查看最终8张720×800截图；当前统计、求购确认、历史/旧口径、型号长度、两种局部失败、大目录末页可读。键盘/确认场景的面板axe serious/critical=0，不将每张截图都声称为独立axe审计。固定native转换通过不等于真实设备、听感或发布准入。

## 审查和失败记录

SPEC两轮最终PASS；首轮独立资源Promise.all成败耦合经真实RED4→focused18GREEN及Electron单侧故障RED/GREEN修复。QUALITY两轮最终PASS；首轮大目录列表预算P2经Core真实RED→13/13、UI真实offset25≠2的RED2→20/20及真实Main旧产物INVALID_IPC_RESPONSE RED修复。没有第三轮派审。

审查后生产代码未变。新分页E2E收尾曾因相邻页条数相同，在busy时过早发Escape；仅测试补“读取结束、关闭按钮恢复可用”等待，由root裁决，随后focused1/1和完整66/66通过。一次编辑命令cwd错误未改文件，原测试原样重跑同失败；不算生产修复或GREEN。第一次完整旧候选为64/65，唯一旧TASK069 schema16断言不适用schema17，仅版本断言适配，原业务断言不删。所有过渡失败与初始Gate单独记录，不替代最终结果。

本机证据在reports/runtime/task-070-want-completion/：candidate-final、gate-results、RED/GREEN、两轮审查、截图和最终E2E产物。产物移动保留到final-e2e-artifacts，不进入Git，不清理用户WIP。

## 接续和未完成边界

TASK071从本任务最终HEAD建立独立分支，继续Source Picker关系入口、唯一下一步与有界照片/长名/键盘交互。完整TASK071～079和Owner验收仍待完成。F-01未决，不自动删音频、不冻结正式Plan/Attempt；R-020大库冷启容量和2秒ready策略留TASK078/Gate E。TASK047真实歌词、TASK061发布准入、Beta签名/发布及既有视觉carryover保留。
