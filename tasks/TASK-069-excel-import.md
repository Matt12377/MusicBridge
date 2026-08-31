# TASK-069：Excel 非破坏导入

基线 `49a322db0ebd1ab32e5bf227c5614e0b0553de63`，分支 `codex/task-069-excel-import`。Owner 已授权持续开发与 GPT-5.6 Sol / High 互斥范围并行，无需逐项询问。保持完整队列，不 push、合并 main 或发布，不读取真实 Excel、库存、照片、账号或硬件；自动 Gate 仅合成文件。TASK068 工作树保持 clean。

## 需求与决策

PRD43～46：每一源行默认形成独立 Inventory Lot，保存 Brand、Model、Version Candidate、IEC、Length、Quantity、Price、Purchase Date、Used、Notes。Workbook SHA-256 基于原文件字节；Source Row 保存 Sheet、原 Row Index、类型化原始单元格、Raw Row Hash 和 Normalized Row Signature。原文件、解析器版本、日期系统和导入 Revision 可追溯。

首次导入预览不写库存，只有明确确认的有效行产生 Lot 和 Ledger。总数10/Used3得到 Legacy Used3与Unclassified7，不认定空白，不分配 Physical ID。品牌、型号、版次、年份、IEC、长度等未知不能被伪造；Unknown 描述允许入库。介质类别由用户明确选择 Cassette/DAT 作为导入上下文，不从缺失值猜测。未知品牌/型号在数据中保持空值语义，UI显示待确认；内部使用稳定来源身份隔离未知型号，不能把全部未知行归成同一型号。普通手工 receive 仍要求原有有效输入。

同文件同 Sheet 重导不得新增数量，即使 commandId 不同。来源关系默认未选择：用户须明确声明独立首次来源，或为修改文件选择旧 Revision；Core 合同强制声明与父修订一致，不按文件名猜测关系。行号只作位置。唯一原始/规范化内容匹配可以提出一对一对应；重复行及其它歧义要求人工确认，不能把排序、插入或删除当作库存新增/删除。用户明确认定为新增的行才可入库；修改/删除行先保存更正建议，不覆盖 Edition、实物状态、照片、Physical ID 或历史。

更正数量采用独立明确确认的 Ledger 命令：绑定导入源行/实际 Lot 和当前余额指纹，只调整用户明确选择的 Legacy Used/Unclassified 增减量。余额不得为负，不消耗已物化、预留或已录实体，不静默重置数量；原始导入与更正前后事实可追溯。价格、日期、Notes 和版次候选作为原始资料/建议保留，不自动改写人工资料。参考目录最多产生 Candidate，不把未匹配变成 Missing，不改 TASK068 历史快照。

## 文件与解析安全

显式原生选择单个 `.xlsx` 或 `.xls`；不扫描目录、不跟随工作簿链接或图片路径，不执行公式、宏或 HTML。原生选择使用 TASK067 专用 outbox 收据恢复路线，路径和完整工作簿不进入公开 DTO/outbox。读取检查文件身份、原始字节限额；Core 持久化原字节和实际 SHA。后续普通写命令只引用 source/revision ID 和有界决策，并固定原工作库 scope。

依赖采用官方固定 SheetJS CE 0.20.3 完整构建（Apache-2.0），同时支持 XLSX 与旧 BIFF XLS；官方 npm xlsx 分发过期，不使用不明镜像或浮动版本。实际包 Hash、lock integrity 和许可证须记录。解析放入有明确时间/内存预算的可终止独立 Worker，不阻塞 Main/Core 主事件循环；不声称 Worker 是完整 OS 沙箱。

初始预算：原文件8MiB，XLSX条目2048、实际解压总量64MiB/单条目16MiB，Sheet32，每Sheet20000行/64列，总非空单元格250000，单元格文本/公式32KiB，结构化解析结果16MiB，解析10秒。ZIP检查实际展开产出而非仅信声明，拒绝危险/重复条目名、加密及不支持结构。超限明确拒绝，不截断后入库。公式只保留公式和缓存值；关键数量字段有公式时必须明确审核，缓存缺失/错误不能猜数。1900/1904日期系统保留，异常日期不悄悄修正。

持久化预算覆盖全部 spreadsheet 表的 TEXT/BLOB 合计256MiB、源1000份、Revision/Effect/Adjustment合计100000条、全表行合计1000000条；单行JSON8MiB，SQL行另留64KiB身份元数据。超限回滚新事务，不删除既有历史。品牌/型号超120字或含控制符、规范化后版次候选/备注超32KiB均报告 INVALID_METADATA，保留原单元格并禁止该行产生效果，不通过截断制造有效值。显式跳过公式行仍保留公式与问题，不要求审核不参与入库的缓存。

构建依赖 electron-vite 5.0.0 的 CommonJS shim 注入器会把 SQL 字符串中的 import 误当模块导入，污染生产迁移SQL。使用 pnpm 固定本地补丁，改由 Rollup AST 只识别顶层 ImportDeclaration；保留完整兼容层，不改 SQL 绕过构建器。新增真实打包回归测试验证迁移字符串逐字一致且 require 实际可用。

## 分工

- 合同智能体：新 spreadsheet-import 合同、必要collection Unknown读取语义、index/ipc/validator/command-outbox及对应合同测试。先给精确API/DTO草案交root及其它owner，不独自改Core/UI。
- Store智能体：新导入存储/纯行匹配与对应Core测试，schema16、repository内原子 receive复用/明确数量账本、固定schema15迁移夹具；保留手工receive行为、TASK068快照和备份数据。原始行效果与库存事务必须一起提交，不循环调用各自提交的公开receive。
- UI智能体：收藏页内Excel导入入口/面板/controller及UI测试、Unknown显示补齐。明确选择Sheet/列映射/介质、预览行问题/对应/差异、确认新增和单独数量更正、原命令恢复、历史只读。不改Main/preload/App/outbox公共label。
- root：固定依赖与文件/Worker解析实现、Main/preload/Core接线、原生专用outbox、备份schema15/16兼容、E2E、控制文档/报告/最终集成。共享文件先交接，禁止并行改同一文件。

## 验证与接续

所有生产行为先真实RED，再GREEN。覆盖原字节Hash、XLSX/XLS、非法压缩/公式/日期、重复文件、新commandId、排序/插入/重复行歧义、缺失元数据、LegacyUsed/Unknown守恒、手工资料与照片保留、事务中断、余额指纹/数量更正、冷启outbox及旧schema15与新schema16备份恢复。静态SPEC后QUALITY，修复复审最多两轮；最终verify/security/Electron/E2E（含显式固定native）、control/boundaries/cycles及候选一致性。

完成后独立实现/报告/最终提交，TASK070从最终HEAD接续。F01、R020、真实输入/账号/设备及Owner验收仍单独保留。
