# ADR-029：工作簿来源、导入修订与库存更正分离

状态：TASK-069 本地实现与自动验证通过；Owner 未验收。基线 `49a322db0ebd1ab32e5bf227c5614e0b0553de63`。

## 决策

Excel 是可追溯的来源资料，不是可覆盖当前库存的镜像。Core 保存原文件字节、SHA-256、解析器版本、日期系统和类型化原行；Renderer只取得有界摘要或分页，私有路径和完整字节不进入公开合同或Main outbox。

每源行默认独立Lot。用户先明确选择介质格式、Sheet和字段映射，预览本身不写库存。只有明确批准的有效新增行在同一SQLite事务写入导入效果、Lot及账本。Used只表示LegacyUsed，剩余为Unclassified；空白元数据保留Unknown语义，不创建PhysicalId，不将版次候选当作已确认Edition。

同内容同Sheet二次导入不增加数量。来源关系默认未选，必须显式声明 independent/null 或 revision/有效父ID；修改文件承接前一Revision，不按文件名自动判断关系。唯一内容对应可以建议，重复和歧义需要人工选择；修改与删除保存建议，不改写人工状态、照片、永久编号、原始记录和参考目录历史。候选目录关联不能自动变成Owned或Missing。

数量调整是另一次明确命令，绑定实际Lot和当前余额指纹。原始acquired不变，schema16新增signed quantity_adjustment；池余额不能为负，不能消费已物化或预留副本。独立Ledger记录前后事实，导入和调整分别幂等。迁移仅在受控重建窗口关闭外键，事务提交前检查关系并恢复外键；旧schema15备份只读可验，新schema16需完整守恒校验。

## 解析边界

采用官方固定SheetJS CE0.20.3完整构建（Apache-2.0），不使用过期npm分发或浮动版本。固定tarball SHA-256为 `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`；pnpm URL初始缺integrity，已补实际SHA-512并通过frozen install。官方安装与许可说明分别见 [安装文档](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/) 和 [许可文档](https://docs.sheetjs.com/docs/miscellany/license/)。此记录不是第三方依赖无漏洞声明。

只读单个显式选择的普通文件，检查文件描述符与路径身份、大小和读取前后修改时间。解析在可终止Worker完成；Worker不是OS沙箱。输入8MiB，XLSX条目2048，实际单项解压16MiB/总64MiB，最多32Sheet、每Sheet20000行/64列、250000非空单元格，单文本32KiB、结果16MiB、解析10秒。ZIP声明不足以证明安全，需实际展开限额、CRC、中央与本地目录对应和范围校验。

不执行公式、宏或链接，不输出HTML，不读取图片路径。公式原文与缓存分开保留，无缓存/错误不能猜数量；日期保留序号与格式、1900/1904系统，不在解析阶段默默转时区或修正异常日期。

原生选择依照TASK067恢复规则先查原commandId回执；已有回执不再读文件，没有回执只有明确重试才重新选择。应用修订与数量调整走普通持久outbox并保持原工作库scope。

20000行全部人工对应并确认公式时，合法决策JSON实测超过原2MiB请求上限。因此仅`spreadsheetImports.apply`的outbox单条预算为3MiB；其余命令仍2MiB、总账本64MiB不变。原始单元格不进入该请求。单Core同一时间只允许一个解析Worker，并发解析明确拒绝，不排无限任务。

持久化按全部 spreadsheet 表 TEXT/BLOB 合计256MiB、1000来源、Revision/Effect/Adjustment合计100000条、全表1000000行限制；JSON单行8MiB，SQL行额外64KiB元数据。超限拒绝新事务，历史不清理。元数据超库存约束时保留原文并标 INVALID_METADATA，不截断成有效资料。明确跳过的公式行可保存问题而不入库；参与处理的数量公式仍需审核。

electron-vite 5.0.0 的正则 shim 注入会误识别模板 SQL 内的 import。固定 pnpm 补丁改为 Rollup AST 的顶层 ImportDeclaration 定位，避免污染 SQL；实际打包回归比较原迁移字符串与执行 require 的结果。此构建补丁不改变数据库内容、业务规则或 Electron 安全配置。

## 验证与后续

只用合成XLSX/XLS与固定旧schema15夹具，分别验证解析、行匹配、原子库存效果、调整、回执、冷启及备份恢复。真实Excel、账号、硬件和Owner验收没有因此授权；不push、合并main或发布。完整TASK070～079与F-01边界保留。
