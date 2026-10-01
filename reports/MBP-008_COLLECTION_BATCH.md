# MBP-008：收藏读取热点与完整 Dataset Owner 隔离

最终候选 `77901d5b553cf782e3943f3027957884928212c7` 的原完整本地软件门禁已通过；5000全量算法对照、固定Linux关闭竞态复核、本地及远端Electron门禁已完成；本任务按软件范围收尾，依赖审计准确另列。基线 `8253bc19c2f473943b304ac9418ad22f71a65f79`，开发分支 `codex/mbp-008-collection-batch`。局部算法快照 `4d84ccd`、完整owner首实现 `f810728`、失效票据与旧静态检查修订 `7791388`、共用领域类型修订 `957bd1c` 分别保留，不混用早期通过覆盖后来代码。

## 改变的行为

型号列表保留原SQL筛选、rowid倒序与分页，页内完整型号一次读取，SKU、库存池、实体与照片按50 ID分块查询并恢复原顺序。池与实体独立聚合，避免JOIN数量倍增。reserved/unavailable仍计held；NULL长度、精选照片与rowid fallback、未确认版本和逐项完整DTO校验保持。

完成度读操作建立一次局部上下文，distinct目录revision完整解析/校验一次，批取求购、历史型号版本和evidence，单遍归并品牌/系列与库存长度。目录激活核验按调用复用source/revision/snapshot并将matches分组、型号存在性批取；公共guard以Set/Map替代重复成员扫描。原历史字节/指纹/CAS/BEGIN IMMEDIATE/回滚、FK与trigger、条目/UTF8/JSON/8MiB/生产容量限制均保留，没有持久缓存或扩限。

这些局部优化将2000目录current首warm中位从15910.800ms降到70.774ms，snapshot从约15911ms降到108.576ms；current的SQL4035→16、完整目录parse2001→1、parse bytes1006661079→503079。但同线程生产Utility合成read→pause的current/snapshot p95仍为61.014/157.653ms，未满足20ms目标，因此进一步实施完整所有者隔离。

父Core继续承载播放、Roon SDK/PublicLibrary、Provider、Stream/Control和事件。新worker完整承载20子域、两条长期数据库连接、208领域命令、协调器、激活generation、原生输入/输出资源、租约和quiet屏障；没有第二个只读库或逐store RPC。有限Roon元数据投影绑定epoch、scope、来源与一次消费许可，不传函数、SDK、FD、凭据或设备资格。观察到未取得许可的旧来源票据失效后永久退休，旧来源对象回来也不能复活。

启动顺序是owner prepare→父runtime启动→owner commitBoot→ready。关停先封新入口，按原顺序尽力停止所有资源，等在途dispatch、提交和异步文件工作收口，再关闭两库并等待worker自然退出。任何关闭失败都不发送成功ACK；其余资源继续收尾、两库保留，走现有Core监督与冷启动恢复。发送后断链仍是unknown，原请求和commandId保持，不自动重放。

## 固定候选的本地门禁

| 原范围 | 实际结果 | 退出码 |
| --- | --- | --- |
| verify：三层类型、单测、三包生产构建 | Contracts254 / Core1948+原2skip / Desktop1219，全部类型和构建通过 | 0 |
| mock Electron启动、崩溃恢复与凭据恢复 | 4/4；不证明系统钥匙串或真实凭据 | 0 |
| 原完整Electron E2E | 104通过+原4条件skip，0失败/0flaky | 0 |
| control-plane / boundaries / cycles / diff | 原范围通过，cycles372文件 | 各0 |
| 正式编译owner与嵌套表格worker | CSV/XLSX/XLS中文、公式文本、输入字节不变、回执与重启一致、自然退出 | 0 |

最终898源码SHA `95f2a18dbb7ed62dc166f4a266805c3dd87ad7cef885d4fb685c395c61b61498` 在Gate前后相同。主checkout在全部旧对照结束前保持4d84，878源码与690构建文件逐项不变。原4个条件skip名称逐项相同，没有缩范围、新增skip或降低失败阈值。原10个算法生产/测试文件在4d84与77901d5中逐字相同；5000算法对照不冒充5000 owner-wire SLA。

## 性能与控制证据

5000固定合法夹具的99项全部输出、canonical及protected facts匹配。基线同会话实际退出0，99=原5+新94；候选一次续跑实际退出3，99=原8+新91全部完成，原总runner234中未选择135仍UNSTARTED。此前50/500/2000的135项来自另一runner，234项合并清单明确分列provenance，不能声称本runner234完成或退出0。原8、原135和578个已有证据哈希保持不变。原基线cross3个partial样本缺退出回执，仍是unknown，未补造通过。

| 5000总库目录 | 路径 | 原中位ms | 优化中位ms | 原/优化SQL | 原/优化完整parse |
| --- | --- | ---: | ---: | --- | --- |
| 书1 | current | 16462.245 | 83.018 | 4035/16 | 2001/1 |
| 书1 | snapshot | 16288.552 | 117.390 | 4026/19 | 2001/1 |
| 书2 | current | 16534.544 | 82.913 | 4035/16 | 2001/1 |
| 书2 | snapshot | 16396.487 | 121.487 | 4026/19 | 2001/1 |
| 书3 | current | 4207.950 | 51.616 | 2035/16 | 1001/1 |
| 书3 | snapshot | 4233.232 | 67.410 | 2026/17 | 1001/1 |

每项保留原5样本、median/p95、SQL/parse/字节、DTO与运行身份。5000拆书规模为2000+2000+1000，未提高生产上限；数据库模型/目标5000、快照3，fixture SHA `5d7f11adb13a0128ac8362998d92056066f4ded0e8a0c6ce78d23d9851c526be`，protected facts SHA `de4346c58dffa64e27de24b258ed45c87bca9636d1cae604b9fca1da7e908bcd`。这些是4d84算法路径证据，原10文件与最终owner逐字相同，仍不将数字升级为5000完整owner-wire延迟承诺。

原范围包括50/500/2000合法单书、5000总库拆2000+2000+1000；首/中/末page25，warm/cold新owner/cross-secondary，五个原始样本和完整canonical/受保护事实逐项对照。cold包含真实open/recovery/verify和公开空页SQL，不称OS冷磁盘。并发测量的绝对时间不是独占性能承诺；SQL计数也不计SQLite内部扫描或所有显式Map lookup。

完整owner控制使用同一2000合法固定数据库，真实Node Worker、完整两个数据库所有者、生产Utility dispatcher与TestRuntime，先read后pause并保留完整公共DTO guard及expectedDatasetId验证。四路径list/current/snapshot/wants的pause p95分别0.115/0.131/0.224/0.144ms，五样本p95为最大样本，均达20ms目标。完整canonical、受保护事实、原输入文件、源码身份、关闭与自然退出均核对。这是Node Worker+合成播放控制；不是真实ElectronUtility/Roon确认或听感证据。

## 录音负载与边界

录音定向检查使用真实Worker、完整Domain/twoDB、正式DeviceAttemptProvider、输入只读FD租约与实际pump；原生协议child是受控10ms合成流，未打开真实HAL/硬件。2000容量下current/snapshot各三次read为约65–76/96–117ms。Stop确实在第三次read中发送，但owner入口仍排队64.803/95.466ms；PCM最大间隔76.797/117.480ms，不能以三样本冒充p95或宣称实时录音通过。

Stop原合同继续区分accepted与quiet：回执时quiet为false，随后精确native close、输入LEASE_CLOSED、quiet、关闭后不再PCM、两个DB关闭、worker自然退出和重启身份/旧Stop回执一致均已核对。Print关闭失败的行为检查确认继续尝试其他资源，拒绝关闭成功且保留两库。合成租约恢复仍BLOCKED OUTPUT_RUN_UNVERIFIED，不补造设备认证。播放控制已与DB热点隔离，录音原生pump/Stop与该owner的同步热点仍共处一个线程；后续若要更低延迟须另立完整资源边界，008不擅自扩大第二次架构改造。

## 失败、修正与审计范围

首owner f810全verify实际1：Contracts254/Core1946+原2skip通过，Desktop1218通过/1旧静态入口断言失败，尚未到构建。加载设备helper已迁入owner bootstrap，旧测试仍查core-entry；修正到实际加载位置，保留pin/资源保护并新增完整接线断言。第二候选779的type依赖环实际1，Root仅停止自己verify子树actual143再修；部分日志不计通过。抽取共同DatasetServices后原cycle checker不变，最终957原全量重跑通过。

Root独立行为测试复现未取得许可的Roon票据在旧来源对象回来时可复活，实际RED1→修正后5投影+3真实DB Worker集成actual0。新增关闭/身份/未知回执/幂等/崩溃/录音场景的定向证据与全量结果有重叠，不相加成新的测试总数。协议层8个实际Worker/受控消息case使用fakeOwnedDomain，完整DB/录音组合证据单列。

正式编译表格检查先后失败三次，全部保留。首因SheetJS的biff8写出器未把SUM公式写进原XLS输入；另两次因SheetJS给Buffer附加读取/写出方法属性，使deepStrictEqual比较JS属性而非纯文件字节。最小生成器核对明确两种格式字节和长度均一致；夹具以普通Buffer保留原字节，XLSX强断言SUM(5,5)/缓存10仍保留，XLS按实际序列化输入校验。生产源码未因此改变，最终actual0。

008独立R1/R2只覆盖各自冻结的四文件/最终十文件算法增量，未确认该已审范围P1/P2，不扩展为完整分支无严重缺陷。完整owner由作者行为检查、Root自查与固定完整Gate覆盖，没有第三轮独立审查。新bootstrap测试用os.tmpdir，受runner外置TMPDIR约束；本机通过不冒充Linux CI通过。

957远端Linux verify新增一个真实协议竞态失败：close失败response和随后fatal是两帧，父端在间隙终止时会把原因改成worker-exit。本批77901d5在收到合法匹配的close失败response时同步锁定close-failed，保留原安全错误、在途unknown及exactly-once fatal；不终止、不自动重放。受控消息顺序确定性RED实际1→修复8/8和strict实际0；原real Worker失败断言未放宽。最终候选已重新跑上表原完整Gate。957失败原始日志和完整verify artifact均已另存，其Core1946通过/1失败+原2skip，不冒充最终779通过。

## 远端与后续

4d84远端verify作业、security29和Electron104+原4skip通过；verify工作流的dependency-audit仍失败11moderate/7high。完整原始日志已保存，产物下载实际124/180秒超时、只取得部分，不宣称全部产物保留。957源码阶段非force开发分支push实际0，其security29和Electron104+原4skip通过，Linux关闭竞态失败已归因并修正。77901d5非force源码阶段push实际0且远端SHA相同；exact779远端security29/29、Linux verify（254/Core1948+原2skip/Desktop1219，全部类型/构建）与macOS startup4/Electron104+原4skip已通过。两个关闭失败用例均在Linux通过；verify工作流仅dependency-audit仍失败，新日志为11moderate/8high，第8项为API→pac-proxy-agent→get-uri→basic-ftp5.3.1的GHSA-c475-qrg2-pj4r，官方修复6.2.1。该数量绑定新快照，先前7high记录保持为各自旧运行。完整779 verify artifact下载actual0、无signal/timeout，834111字节原verify.log已保存；三项作业完整原始日志均保存，不宣称全部macOS产物已下载。依赖安全修复、完整v1纳入strict与最终全量/远端收口由009处理，保持API4.40.1、utils0.4.4与原审计门禁。

最终报告提交由 `git log -1 --format=%H -- reports/MBP-008_COLLECTION_BATCH.md` 解析；报告开发分支推送回执在交付核验中记录，不在报告里自引用尚不存在的SHA。009从008最终报告HEAD建立独立分支。真实Provider/账号/Roon/音频/设备录音、GateB、Owner验收、main合并、正式App替换及发布均NOT_RUN；软件交付不等于V3完成。

报告提交修订：`b9544d3` 提交了待补全草稿，进度仍9/11。新鲜8high与Linux/macOS终态在本次后续报告提交补齐，不改写已有Git历史；本任务最终报告身份取本文件最后一次提交。下一任务从本次最终报告HEAD开始。
