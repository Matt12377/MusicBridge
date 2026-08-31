# TASK-077：基础J-Card与Printed Artifact

基线`323b8852b10baff356418edd02625b6b19fa6d9e`，分支`codex/task-077-j-card`。076本地软件阶段已封版。Owner授权持续软件开发至079、Sol/High并行，不push/merge main/发布，不操作声卡、打印机、用户源或真实账号。

## 范围与实现决定

1. 对照PRD§67～69，Cassette首次Completed自动生成基础打印意图；Completed、Record、不可变打印事实与pending job同一事务。由Main受限PDF渲染worker自动领取，真实PDF/预览与Artifact再原子发布。打印故障不反改录音完成事实；重启只恢复打印任务，不自动录音或弹保存框。DAT明确不适用Cassette卡。
2. Master Artwork采用明确冻结Master版本归属和不可变图像版本。原生选择本地图片，复用受限JPEG规范化，绝不把实体照片或Roon浏览封面偷换为Artwork。完成时复制所选Artwork引用/字节到历史快照；后改Artwork、型号、默认模板不改旧事实与PDF。旧Record只显式补建，保留原始missing和recordHash，不取今天的Artwork冒充当年。
3. 新Record版本与PrintSnapshot关系要明确且严格向后兼容，不能放宽旧v1合同或重写旧Hash。独立schema21保存Artwork/PrintRequest/job/Artifact/PDF对象/回执，SQLite权威字节跟随一致备份恢复；不改旧FINALIZED执行归档清单。新版本schema、迁移和恢复闭包全部同步，损坏对象不能靠重生成掩盖。
4. 最小模板使用自制JP0基础版，采用制造商已核实的尺寸事实：成品103.1875×101.6mm，外面flap25.4/spine12.7/cover65.0875mm。来源与独立验证工具见runtime/task077-geometry-readiness.md。产品不复制制造商模板图文。PDF必须正确尺寸、中文可读、Artwork/Title/Spine/两个ID/A-B曲目/实际整面时长/历史型号/日期齐全。长内容采用有界续页或明确版面失败，不默默删曲或无限缩字。
5. 使用现Electron printToPDF生成真实PDF，无新外部产品依赖；隐藏专用窗口禁Node、导航、网络和任意HTML，所有用户文本转义，图像仅受限内部字节。仅printToPDF，不调用print或枚举打印机。真实独立测试已发现Chromium将292.5pt宽向上量化为293.04001pt；因此Main对本次受信Skia输出做有限、同字节长度的Page字典MediaBox规范化，精确恢复292.5×288pt且不缩放正文/折线。只接受经典xref定位的已知页字典、原点0及微小向外量化，未知/压缩/额外页盒形状拒绝；不是任意PDF编辑入口，也不放宽几何合同。生成结果独立用Poppler及Python PDF工具重开、抽取、渲染检查，HTML截图或PDF文件头不算验证通过。
6. 公共表面仅明确Master Artwork读取/选择、Record打印列表/显式补建/失败重试、Artifact读取和原生导出。Core worker领取/完成/失败/读PDF为Main私有协议，不暴露Renderer任意渲染、PDF注入、路径或SQL。固定dataset scope、严格DTO、有界payload，确定性写命令依既有回执/outbox策略，原生保存不自动重放。
7. 原生导出按Record/Artifact/hash明确身份，保存框取消零写入；返回后重新核库与字节Hash。写入有界、无意外覆盖、symlink拒绝、fsync/校验；不把未确认导出、PDF文件存在或生成成功称为已打印/已装盒。旧PDF保持原始字节，缺字节明确失败，不重建替代。
8. 现明确Master版本历史内加Artwork入口，Record详情内加J-Card/印刷品面板；双库复用同实体档案，不新建库存或第二份记录。状态区分自动排队/生成/失败/已生成/导出取消/未知，按需读取预览，焦点和窄窗沿现UI。

## 单一写入与阶段

合同先冻结具体名称/shape，然后并行：合同与纯事实/几何、Core schema/自动任务、Main PDF模块；root接runtime/utility/Main安装/preload/E2E/控制面。UI在合同与纯事实冻结后由原UI作者接续。每个共享文件指定唯一作者，dist仅root构建，不并行build与E2E。

详细接口设计与路径allowlist在本runtime/contracts-design.md冻结后执行；不以此任务文档替代真实RED。既有Record/Plan/Attempt和所有真实设备边界不变。

## 验收

先真实RED再生产。必须覆盖首次完成自动请求、重复完成/冷启/失败回滚、实际PDF生成和中文/长文/Artwork版面、旧Artifact不可变、Artwork角色与版本、取消/迟到/错库导出、完整backup→restore且字节相同、schema20迁移守恒和破损拒绝。全verify/security/Electron/E2E、控制/边界/循环、16native pin和独立PDF尺寸/视觉核验完成后才封本地软件阶段。073实机、可听Replica、真实纸张打印与Owner保持未验收，078/079继续。

## 本地软件结果

最终verify184/1088/601、安全29、Electron4、完整E2E90均PASS，双native零skip；实际23页PDF及App导出独立几何/内容核验通过。实现/报告身份见STATUS与[TASK077结果](../reports/TASK-077_RESULT.md)。纸张/盒型/打印机与Owner未验收；预览滚动条作为078非阻断视觉小项，不重写旧Artifact。
