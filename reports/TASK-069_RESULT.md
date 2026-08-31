# TASK-069：Excel 非破坏导入与独立库存更正

## 身份与授权

- 基线：`49a322db0ebd1ab32e5bf227c5614e0b0553de63`，TASK-068 最终锁定。
- 分支：`codex/task-069-excel-import`。
- 实现提交：20e2562f36aa4575654d32ea34090e357ce5920b。报告提交由最终STATUS锁定，最终HEAD由本机final-closeout.json与TASK070基线锚定。
- Owner持续开发与GPT-5.6 Sol / High互斥范围并行授权。无push、main合并或发布；所有工作簿、库存、图片、账号恢复和音频验证均为合成数据，不访问真实用户Excel/照片/音乐/Provider/Roon/硬件。

## 交付内容

1. 原生选择单个XLSX/XLS，Core只读并校验文件身份；保存原字节SHA-256、文件格式、Sheet、解析器版本、1900/1904日期系统和类型化原单元格。路径/原字节不进入公开DTO或Main outbox，来源、源行、导入修订和账本持久保存。
2. 显式选择Sheet、介质、表头、列映射及来源关系。默认不认定首次导入；独立首次必须明确声明，修改文件承接旧修订，Core严格校验关系。预览不写库存。
3. 每批准新行独立Lot；Total10/Used3得到LegacyUsed3与Unclassified7，不推断空白、不分配Physical ID。Unknown保持空值语义；版次仅为候选，人工Edition、照片和历史不被改写。普通手工receive仍严格。
4. 同文件同Sheet新commandId也零增量；跨文件revision按唯一内容建议对应，重复/歧义人工确认，排序/插入/删除不自动改库存。变化/移除保存建议。跳过公式行保留原值及问题且无效果；实际参与行的数量公式需明确审核，映射变化清除旧审核。
5. 独立数量更正绑定源行、实际Lot和当前余额指纹。schema16新增signed quantity_adjustment；原acquired不变，不能消耗已物化/预留实体或产生负余额，独立账本保存前后事实且幂等。
6. 收藏页内五步导入面板，包含分页原行、明确新增/对应/跳过、整批批准、只读历史及独立更正。原命令丢回执后需人工恢复，不自动重放；成功后旧历史列表明确待刷新。11项公开API接入Main/preload/Core，读写边界保持原dataset scope。
7. 原生登记优先恢复Core回执；原文件离线也不重选、不二次登记。不存在回执时，只在明确重试后重新选择。导入效果和库存事务同提交，不循环调用各自commit的receive。
8. 固定schema15迁移与历史夹具，schema14/15旧备份只读验证，新schema16完整校验原字节、行与修订链、效果、余额、账本和不可变schema；内容备份→隔离恢复→激活→冷启保留Excel、参考目录、照片和库存全部事实，不恢复旧路径权限。

## 预算与依赖

SheetJS CE固定0.20.3官方tarball，Apache-2.0；SHA-256 `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`及SHA-512 integrity进入证据/lock。解析由可终止Worker执行，单Core同时一份，10秒、256MiB V8老生代预算；Worker不是OS沙箱。

原文件8MiB、ZIP2048项、实际展开单项16MiB/总64MiB、32Sheet、每Sheet20000行/64列、总250000非空单元格、文本32KiB、解析结果16MiB。ZIP核验实际解压、CRC、路径和中央/本地范围；不执行公式/宏/链接或读取图片路径。原品牌/型号含控制符或超库存约束时保留原文并标INVALID_METADATA，不清洗/截断成有效资料。

全部spreadsheet表TEXT/BLOB合计256MiB、来源1000、Revision/Effect/Adjustment合计100000、全表1000000行，JSON单行8MiB。超限拒绝新事务，不删历史。仅spreadsheetImports.apply的outbox单条3MiB以容纳20000项合法决策，其他命令2MiB、总64MiB不变。

electron-vite5的正则shim注入错误曾污染SQL模板。固定pnpm补丁改用Rollup AST顶层ImportDeclaration定位，保留原兼容层和安全设置；真实构建RED→GREEN覆盖SQL逐字一致和require执行，不以修改SQL绕过问题。

## 自动Gate

最终62份代码/测试/配置文件Git blob一致，固定native13文件SHA-256一致；代码指纹 `547c8e81c89f91b6815e9bbf1a094357b684957691e79f595a142cdcd4c8e686`。

| 检查 | 结果 | 退出码 |
|---|---|---|
| canonical verify：类型、合同、Core、Desktop、生产build | 107/107、881/881、316/316 | 0 |
| 安全 | 27/27 | 0 |
| Electron启动、crash/restart、合成safeStorage与冷启恢复 | 4/4 | 0 |
| 完整生产E2E（显式MUSIC_BRIDGE_NATIVE_GATE=1） | 60/60通过，零skip | 0 |
| Control / Boundaries / Cycles | PASS / PASS / 192 files PASS | 0 |
| diff-check / 最终身份 | 62/62、native13/13 | 0 |

实际新Electron覆盖XLSX/XLS与全部11API、重复命令、重排修订、独立数量更正、冷启、Main回执落盘失败与离线原文件恢复。独立SQLite oracle核对schema16、Lot、源原字节、池数量和账本无重复。五步界面720窄窗9张截图，原行/决定/账本可见，无面板横向溢出，各步骤axe serious/critical=0；主任务已查看截图。固定native实际转换与文件验证不等于真实设备、签名或发布准入。

## 审查与失败记录

SPEC两轮、QUALITY两轮均最终PASS，没有第三轮派审。SPEC原问题为默认来源关系、跳过公式被拦及元数据文案缺失；QUALITY原问题为映射变化沿用公式审核、原控制符先被清洗及历史空态矛盾。均有真实RED后修复，最终QUALITY核验62文件及native13文件无漂移。

早期源码/构建绿不能证明产物行为：曾出现Worker动态require找不到依赖、CommonJS shim污染SQL导致Core启动失败，均保留失败记录并增加产物行为验证。UI测试曾因嵌套select精确getByLabel和数字fill未触发change失败，分别改为实际combobox定位、Tab提交及源行数量断言，不放宽生产规则。过渡候选107/880/314结果单独保留，不作为最终候选证据。

本机证据位于reports/runtime/task-069-excel-import/，包含RED/GREEN、失败诊断、安装与依赖身份、最终Gate、审查、Git blobs和截图。测试输出不进入实现提交；未清除用户WIP或数据。

## 接续与未完成边界

TASK070从本任务最终HEAD建立独立分支，继续Want List、型号完成度、长度覆盖与历史口径。完整TASK070～079、Gate A～E、真实用户数据/账号/Logic/硬件与Owner验收仍未完成。F-01未决，不自动删音频、不冻结正式Plan/Attempt；R-020大库冷启与2秒ready策略交TASK078/Gate E。TASK047真实歌词、TASK061发布准入和历史Beta/视觉carryover继续保留。
