# TASK-070：Want List 与收藏完成度

基线 `d2735054e7f1481db9eccf058c5d400ba87b3019`，分支 `codex/task-070-want-completion`。Owner 授权持续本地开发与 GPT-5.6 Sol / High 按互斥文件并行。保持 TASK064～079 完整队列，不 push、合并 main、发布或访问真实账号、库存、照片、书籍、Excel和硬件。

## 范围与口径

依 PRD21～33 与 Gate C06/C10/C11：Wanted 与 Owned/Missing/Unknown 正交，Owned 也可求另一长度、品相或包装。求购只记录目标，不改库存、不自动购买、不联网取价格或汇率。主完成度按当前目录 canonical 型号和edition计一次；overall/品牌/系列分别显示Owned/Missing/Unknown。确认关联且当前实际持有大于零才Owned；candidate/needs-review不贡献，未匹配导入仍Unknown。

长度统计读取 Lot 剩余池与 Physical Copy，预留/不可用但仍在手的实体保留，不双计。不因SKU历史存在认定现有长度；数量归零不拥有。已知目录长度、目录外长度、未知长度分开，数量守恒。已知长度集合为空不能声称AllLengths。

## 求购与历史

求购保存优先级、期望品相、备注、可选长度/包装/价格。价格使用显式三位大写资料货币代码与精确正十进制字符串，不parseFloat、不承诺ISO认证或推断货币小数位；整数最多12位、小数最多4位，不接受符号/指数/前导零/全零。长度1～360分钟或null；品相/包装最多200字、备注4000字。

只允许对当前目录head新增或编辑；取消为终态，新目标另建。每次改动保存不可变版本和账本，expectedVersion避免覆盖并发编辑，commandId幂等。目录修订不自动迁移或复制旧Wanted；保留历史并动态needsReview，用户明确编辑才能绑定当前revision/ref。当前完成度只统计完全匹配revision/ref的active目标，旧修订active数单列提醒。

读取完全只读。完整完成度快照仅用户明确capture创建，绑定当前head、全批fingerprint和commandId，分页不改变fingerprint。快照保存所有统计、条目、长度与Wanted id/version摘要。旧revision的current API是旧目录下的当前事实，必须明确并禁止capture；不是历史快照。TASK068既有CatalogSnapshot保持字节不变，不回填Wanted/长度，更不能用伪0表示未采集。

## 合同、持久化与安全

新9个公开API对应内部collectionProgress：wants/saveWant/cancelWant/wantHistory/current/capture/snapshots/snapshot/modelLengths。三写命令走持久outbox并固定工作库scope；其余经可信Renderer与严格合同验证读取。公开page最多25（作为请求上限）；快照历史列表按8MiB响应预算可返回更小有效limit，客户端依实际返回条数前进、保存访问offset后退，不截断摘要或分组。目录条目最多500，每ref active目标最多100、全批最多5000。

schema17添加求购当前态、不可变版本、不可变快照及账本，单SQLite事务并支持beforeCommit故障回滚。持久预算128MiB TEXT/BLOB，10000求购、版本事件与账本合计100000条、5000快照，单JSON8MiB；超限拒绝新事务不清理历史。保留真实schema16合成夹具，旧14/15/16备份只读核验，新17全量校验并支持隔离/冷启恢复；不改069原字节、数量更正或068快照。

## 互斥分工

- 合同：collection-progress.ts、contracts index/ipc/validator/command-outbox及对应合同测试。
- Core：collection-progress-store.ts、repository.ts、专属测试/schema16夹具；旧spreadsheet/reference/repository/archive-transactions/archive-workflow/recording-profile/prepared-render/preparation/master-versions测试只适配schema17，不删除旧守恒断言。
- UI：CollectionProgressPanel.vue/controller、CollectionView.vue、CollectionModelDetail.vue和专属UI测试。保留两收藏tab、照片墙与单侧栏，新入口“完成度与求购”。720窄窗、键盘、分页、独立加载/失败状态及原命令重试。
- E2E测试作者：合同交回后转写task-070.spec.ts，只有该测试文件所有权，不运行构建或Electron。
- root：Main/preload/utility接线、outbox标签、备份和restore测试、E2E执行与审查、TASK069 E2E的schema17断言适配（仅版本）、控制文档与最终集成。共享文件只在交接后改；统一构建由root执行。

## 验证与接续

先真实RED再生产实现。覆盖Owned+Wanted、候选Unknown、重复版次、归零长度、未知/额外长度、修订needsReview、快照不漂移、并发冲突/幂等、三种事务回滚、预算/篡改、schema16迁移/17恢复、可信IPC/outbox与合成真实Electron用户链。SPEC先QUALITY、最多两轮，最终verify/security/Electron/完整E2E含固定native、control/boundaries/cycles及代码身份核验。独立实现/报告/最终提交后TASK071从最终HEAD接续。F01未决，不冻结正式Plan/Attempt，不自动删除音频；Owner验收与实际设备证据保持待办。
