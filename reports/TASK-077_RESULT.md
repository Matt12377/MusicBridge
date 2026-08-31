# TASK-077：基础 J-Card、Master Artwork 与不可变 Printed Artifact

## 身份与授权

- 基线：`323b8852b10baff356418edd02625b6b19fa6d9e`，分支 `codex/task-077-j-card`。
- 实现提交：`8d8c6730d4c21effe5b8dc1a0d89859ed2858df2`。报告提交由最终 STATUS 锁定；078只从本任务最终 HEAD 建独立分支。
- Owner授权持续软件开发至079，智能体统一GPT-5.6 Sol / High。仅本地提交，不push、不合并main、不安装发布。无设备不阻断软件；计划RME/Apogee声卡与Sony卡座不等于设备操作、型号兼容或认证。

## 本地软件交付

1. Master Artwork明确属于冻结Master版本，选图仅暂存，显式确认创建不可变JPEG版本；精确命令回执可人工同DTO重试。选择/保存不改源文件、库存或旧Record，不把实物照片/Roon浏览封面冒充Artwork。
2. schema21独立保存Artwork/打印请求/job/event/Artifact/PDF与回执。Cassette新首次Completed在同一事务登记Record v2、冻结Artwork和打印事实、唯一pending请求。DAT不生成Cassette卡；旧schema20 Record保持v1原JSON/hash，仅显式补建，不读取今天的Artwork填历史。
3. Main受限后台worker随Core就绪自动单flight领取；打印成功原子归档PDF/预览和几何，失败保留有限原因且不撤销录音完成。重启恢复打印任务，不自动录音、弹保存框或打印；旧已生成Artifact不重新渲染。空队列轮询不扫描对象或开写事务。
4. 自制JP0基础版尺寸103.1875×101.6mm（292.5×288pt），外面flap25.4/spine12.7/cover65.0875mm；中文标题、脊字、两个ID、历史型号、UTC日期、Artwork及A/B曲序/实际整面时长齐备。长曲目有界续页，超容量明确失败，不丢曲、不无限缩字。这里只生成PDF，不枚举或操作打印机。尺寸事实参考[制造商JP0规格](https://www.duplication.com/printspecs/jcard/jp0%20template%20rectoverso%20with%200625%20bleed.pdf)，模板图文为自制，不复制制造商设计。
5. 专用隐藏Electron窗口禁Node/导航/网络/下载/权限，固定受信HTML与转义文本。真实Chromium纸宽向外量化后，有限经典xref/Page字典规范化仅恢复精确MediaBox，不缩放正文、不移动xref、不编辑流；未知/压缩/多页盒等拒绝，不开放任意PDF处理入口。
6. 八个固定dataset公共API与四个Main私有worker协议贯通。原生对话框返回后再核工作库/对象；不暴露路径、PDF注入、HTML或SQL。导出精确历史字节，不自动重放：EXCL/NOFOLLOW临时文件、完整写/fsync/读回SHA、最终scope/路径/inode检查、exclusive link、发布后目标FD与名字/目录复核；已有文件或符号链接不覆盖，未知只报未确认。
7. Record详情内查看明确Artifact/事实/排版预览、显式旧档案补建和失败重试/导出。明确Master历史内管理Artwork。面板关闭/换身份/迟到响应隔离、焦点返回、键盘、窄窗和局部样式保持；双库仍同一实体，不重复库存。
8. 一致备份与隔离恢复保留SQLite内JPEG/PDF原始字节及引用闭包；坏对象拒绝，不能用重新生成掩盖损坏。不改旧FINALIZED执行音频归档清单。

## 验证结果

本表依据最终命令输出、退出码及候选身份复核填写；完整E2E耗时194.098秒。

| Gate | 结果 | exit |
|---|---|---|
| 修后完整verify | Contracts184 / Core1088 / Desktop601，全PASS、零skip | 0 |
| 安全 | 29/29 | 0 |
| Electron生命周期、崩溃、冷启保险库 | 4/4 | 0 |
| 最终完整E2E | 90/90、双native、零skip | 0 |
| 控制/边界/循环 | PASS / PASS / 256文件PASS | 0 |
| 固定native | 16/16与入场基线SHA相同，双native Gate开启 | 0 |
| 实际PDF独立检查 | 3个样本23页精确MediaBox、NFKC全文/200曲完整；Poppler抽样7页视觉通过 | 0 |
| 实际App PDF | 冷启自动生成、原生导出字节/SHA、精确MediaBox/标题独立重开通过 | 0 |

最后staged diff检查发现新测试helper末尾多一个空行，移除该空行后再跑相关77/77通过；仅测试空白变化，没有生产变化或重审循环。完整Gate原候选与这唯一格式差异均留有SHA清单，最终staged diff检查通过。

最终72文件候选 `de23b454e9ac2190473d8bc76c7181a12b66f2617cd5a5ccaafb7784a9f4b941`。本次所有独立进程/库为合成测试，未枚举或打开音频设备、未发声、未真实录音、未使用真实Provider/Roon或操作打印机。Gate B=NOT_RUN、formalReady=false；生成/导出PDF不等于实体打印/装盒或Owner接受。

## RED/GREEN、审查与保留证据

- 合同与纯facts：接口缺失/边界真实RED→GREEN，相关97与纯facts5通过，root全合同184通过；明确v1/v2不互相放宽。工厂九测试通过，追加Print参数不改变既有Record/Replica位置。
- Core：新store/migration/backup16测试及相邻31通过，全Core1088通过；首次完成事务、故障回滚、回执、冷启/恢复、原v1JSON、不同历史图像与不可变PDF均覆盖。非作者30路径SPEC→QUALITY R1通过。迁移端点测试由20改21，原失败保留，不冒称迁移断言调整为产品修复。
- 接线/导出：缺模块/UNKNOWN_IPC_COMMAND、末次核库期间同长度篡改、发布前源inode替换分别有真实失败。发布后FD/hash复核修复后focused13/13，非作者SPEC2→QUALITY通过。对未确认目标不执行危险回滚删除。
- PDF：首轮harness exit0但产物不完整，保留为不足；修复退出保活后完整产物尺寸仍FAIL（293.04001pt）。三种真实printToPDF选项probe一致，受限页盒修正后第三轮23页精确292.5×288pt，内容和独立Poppler视觉通过。超长标题/超页数两个明确LAYOUT_OVERFLOW。Poppler Type3字形bbox warning保留，所查页面文字可见且全文无缺。
- PDF质量R1发现timer/close销毁异常逸出；root受控timeout/close×isDestroyed/destroy真实32pass4fail→36/36。保留首有限终因、finally收口和迟到不复活，R2通过；不开展第三轮。
- UI：新20+旧48+preload9共77/77，非作者R1通过。真实截图另发现父deep样式污染，computed-style RED checkbox617×44/grid→两SFC局部样式后18×18/flex row/44点击区，R2通过。实际720/1440顶区与详情4图、axe serious/critical零、无面板横向溢出；不代表Owner视觉接受。
- 完整E2E首轮88/90，旧069/070两处PRAGMA仍期望20，实际21；各一行改正确端点，原业务守恒断言全部保留，相关11/11再通过。所有初始失败与旧截图留在runtime，不覆盖日志或用后续结果抹去。

命令、回执、候选hash、真实PDF、截图和作者/非作者报告均在 `reports/runtime/task-077-j-card/`。最终构建之后再独占E2E，没有并行构建共享dist或拿仅selector/假PDF当真实PDF证据。

## 保留与接续

R020大库冷启、R021旧CDP退出FAIL、R022真实HAL及输出端测量、R023全历史/照片/新增Print对象闭包与检索规模风险保留至078。正式Begin仍拒绝；不宣称最大预算或实时Stop达标。073 Gate B、可听Replica、Source Roots/Logic/Provider/Roon、实体纸张/盒型/打印、Owner接受仍未完成。

非阻断视觉小项：HTML排版预览包含隐藏窗口滚动条，实际PDF不含这些浏览器条；078处理未来预览生成，不能改旧Artifact/PDF。本轮不为此开启第三轮审查。TASK061发布准入与历史视觉项保留，不push/merge/签名/公证/发布。

TASK078将逐项映射PRD30、A～E63与U10共103条；先冻结合成规模/时间测量计划，针对冷启/停止/检索与退出真实RED补足全链路自动证据。Task079准备真实环境及Owner逐项验收，不把无设备条件当成自动接受。
