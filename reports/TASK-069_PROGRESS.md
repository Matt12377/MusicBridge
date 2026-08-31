# TASK-069 实施记录

基线 `49a322db0ebd1ab32e5bf227c5614e0b0553de63`，独立分支 `codex/task-069-excel-import`。当前实施中，尚未全量Gate或完成声明。Owner授权Sol/High按合同、存储、界面独立范围并行，root负责接线与最终验证；无push/main合并/发布/真实输入。

## 已取得证据

- 新树初始clean，Node22.23.2/pnpm10.17.1 frozen/ignore-scripts安装exit0；TASK068固定native13文件复制后身份一致。
- SheetJS官方固定0.20.3安装exit0，下载原包SHA与锁定integrity记录在runtime/sheetjs-identity.json；补integrity后frozen install exit0。
- ZIP实际展开、CRC/目录一致性、危险路径/重复/加密/超量：3项缺入口行为RED→3/3GREEN。
- 单文件读取（无写入、拒绝symlink/目录/伪扩展/超限及错误路径脱敏）：2项RED→2/2GREEN。
- 独立Worker真实合成XLSX/XLS中文、原行、数值、日期系统、公式缓存、范围预算、超时后可继续：5项RED→5/5初次GREEN；后续接入最终合同守卫与生产打包还需重新验证。
- Store原真实schema15夹具：9项行为RED（15不等于16、缺迁移故障钩子和导入入口），开始schema16与原子账本实现。
- UI Unknown空标题与普通补充死路的真实SSR RED已取得，显示fallback与限制普通手工补充后4/4GREEN；导入面板仍实施中。

## 第一轮接线与构建检查

- 合同105/105、typecheck exit0；新增仅apply单条3MiB上限，20000个人工对应决策不再撞原2MiB限制，其他命令/总账本预算不变。
- UI面板/controller定向27/27；所有分页已对真实合同guards测试，不把fake返回成功当作公开DTO合法。E2E三场景已编写，尚未执行。
- Preload 11项业务入口真实RED后7/7回归通过；一次从错误cwd调用的测试输出单独保留为preload-wrong-cwd.log，正确apps/desktop目录重跑exit0。
- Main读取/原生收据定向35/35；Core IPC真实合成文件→Worker→受控store调用、删源文件后原回执恢复及scope末端检查1/1。受控store仅用于IPC接线，完整SQLite效果仍等待Store/集成Gate。
- 并发Worker资源限制真实RED后6/6解析测试通过；同时只处理一份工作簿，超时/完成均释放。
- 首次生产build exit0但独立产物probe实际失败：动态createRequire在dist/main路径不能解析bridge-core依赖。改为静态ESM解析器+完整codepage打包后，第二次build与XLSX/XLS生产Worker probe均exit0。源码测试与构建退出码均不能替代此产物行为验证。

## Store 与备份整合

- Store 原子事务、原始字节、独立行Lot、重排修订、人工资料保护、数量账本和容量/篡改校验已实现。8份旧schema夹具保留原故障断言并适配schema16，定向173/173通过；新增规范化元数据约束具有独立RED/GREEN。
- 固定schema15只读可验；schema14正式迁移至16仅增加零调整额。真实合成XLSX经Worker登记、导入、照片、参考快照、数量更正，再完整备份→隔离恢复→激活→冷启动，原文件离线后仍逐列及原字节相等。两份备份测试38/38通过。最初拒16分别在backup index、隔离恢复、cold runtime取得RED后接线。

## 真实 Electron 启动与构建根因

- 首次3个新增E2E均在firstWindow前失败，不曾执行导入业务。合成启动只暴露DESKTOP_STARTUP_FAIL；源码在Electron内置Node24.18.1/SQLite3.53.1下内存迁移和文件库打开均通过，重新构建仍失败。
- 仅在临时测试产物捕获异常并在finally逐字恢复，定位到electron-vite5的正则CommonJS shim注入器：把SQL模板里的import当成模块声明，将node:module导入插进触发器字符串，SQLite报near node语法错误。
- 新真实构建回归先RED（require未定义），pnpm固定补丁改用Rollup AST顶层ImportDeclaration后GREEN。SQL逐字相等、require实际可用；frozen/ignore-scripts重安装exit0。没有修改SQL规避，也未放宽Electron安全设置。

## 审查与集成进度

- SPEC第1轮FAIL（P1来源默认首次、P2跳过公式被拦、P2元数据文案缺失），真实RED后修复；第2轮限定复核PASS，P0～P3=0，不再派第三轮SPEC。
- 显式sourceRelationship与previousRevisionId严格配对，默认未选择；同bytes同Sheet仍零增量。有效新行+跳过公式的混合批次仅有效行入库，原公式与问题保留。
- 生产Electron真实XLSX/XLS与11API、重导、修改建议、独立更正与冷启通过；原生登记回执未知、冷启不重放、原文件离线后恢复原回执也通过。
- UI初次getByLabel精确定位不匹配嵌套select，改用实际combobox无障碍名称；一次错误cwd使未改测试重复执行，作为失败日志保留。随后表头数字fill未触发change而被后续映射重渲染还原，测试加入真实Tab提交并断言只有1源行，没有放宽生产审核。五步场景通过，6张截图已人工查看、各步axe serious/critical=0；额外原行/数量账本细节截图随最终全E2E执行。
- QUALITY前候选canonical verify exit0：Contracts107/Core880/Desktop314；Control/Boundaries/Cycles192均PASS。该结果是过渡候选，不作为后续变更的最终证据。
- QUALITY第1轮FAIL：映射变化沿用旧公式勾选、品牌/型号原控制符被先清洗两项P2，及历史列表旧空态P3；两项真实RED后修复：原文控制符先校验；映射编辑代次同步清空旧公式勾选；历史缓存失效后显示待刷新。Core18/18、UI15/15与类型检查通过，QUALITY第二轮限定复核PASS、P0～P3=0。

## 最终封版

最终62文件/13native候选canonical verify已exit0：Contracts107/Core881/Desktop316，编译和E2E类型均通过。安全27/27、Electron4/4；单次完整生产E2E显式native开启，60/60通过、无skip，6.8分钟。9张窄窗截图及原行/账本细节已人工查看；control/boundaries/cycles与最终候选身份封版复核通过。本地实现/报告/最终提交后才将TODO069勾选并创建070；真实输入、账号、设备、Owner验收、push/main合并/发布均未执行。


最终本地实现提交 `20e2562f36aa4575654d32ea34090e357ce5920b`，结果报告提交 `7a62d26f17a9012335096d143d6c4bfe75196c63`。最终锁定HEAD以本机final-closeout.json及下一TASK070基线为准；TODO069仅标记本地完成，Owner未验收。
