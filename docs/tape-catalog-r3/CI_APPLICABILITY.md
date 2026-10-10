# 磁带资料分支的CI适用性修复

2026-10-10，Root已接收磁带资料的独立软件检查点，并安排在本分支追加最小CI路由修复和确切的验证源适配。运行时产品源码、原产品范围、共享排程、正在试用的App和真实资料库保持不变；验证源已有单独授权的改动，不能笼统声称全部源码字节与ff相同。

## 原始阻断

产品Source为`ff02c6b2fd248748fe7d461259f5749dda86fa0c`，唯一直接报告为`799fece27f0cfe056a56fd6258f0db380db3461e`，基线为`c0b945a2b8d0f6f3ee2d9ea9d2cb50a787dc7f95`。这些原提交保留，不重写。

Source首次自然push的verify运行`38052666522`、attempt 1，在“MBM003 精确前序软件证据复用”步骤因“003 分支不符”退出1。继承的共享双表仍登记MBM-003，但原脚本只接受003的独立分支。后续install和完整verify没有执行，因此首轮失败不能写成CI通过，也不证明后续产品检查的成败。原始日志和发布回执保留于本线外置证据目录。

## 有限准入

执行任务明确为`TAPE-CATALOG-R3`，当前移动回归任务为`MBM-003`，两者分别输出。Tape路径必须同时满足：

- 精确分支、原EXECUTION_SCOPE原始字节SHA、固定Source的唯一父基线，以及固定报告的唯一父Source。
- 报告之后的有界线性提交链，当前HEAD前后稳定且工作区清洁；hosted runner的SHA及分支必须一致。
- 每个新提交及最终累计diff仅包含CI_SCOPE列出的六个普通CI或本线说明文件，以及验证修正清单中的确切文件。验证源分别绑定ff原版和审阅修正版的完整SHA256及Git blob；逐提交仅准入原版到修正版的唯一替换，拒绝第三版、反向替换或隐藏改动后回退，不给整个测试目录豁免。
- 验证源同时核对Git读取的ff原始完整字节和当前FD稳定读取的修正完整字节，累计diff必须包含所有声明修正。运行时产品路径、共享机器双表、移动合同、删除、重命名、链接和执行位继续拒绝。
- 修复后verify.yml的精确字节SHA。白名单内也不能删除完整verify、当前移动软件Gate或改变其他检查。
- 继承的三个003任务选择器一致，并继续执行原003授权、authority/lane/schedule及双表、固定历史收据、8件冻结文件、旧R唯一父与祖先约束。

原003分支继续执行原有严格准入。未知分支不取得Tape例外。所有Git事实使用真实对象，禁用replace objects，清除外部GIT目录和配置环境；逐提交范围检查避免中途越界后撤回被累计diff隐藏。

## 应执行的验证

Tape和003均须运行标准完整verify，以及现MBM003 hosted软件Gate的65例（合同27、Core18、Desktop20）。该Gate仍绑定实际当前HEAD、源码、fresh compiler/Worker、产物、完整TAP及真实退出结果；准入成功不代表Gate成功。Hosted未执行的native15例沿用其原边界。

17个历史步骤（MBRS-001～014共14步，MBM-000/001/002共3步及其内部companion测试）仅在原冻结前序Source`7ec898d9f26cbafb5e01f5483bfaccf14ca61d27`和直接报告`d5189ecba0aaf266e7fa375613a7a99beffabc2e`的精确软件证据下复用；不把它们写成当前Tape提交重新通过。不会因错误回落legacy而重跑在新合同下不适用的旧001/002入口。

控制平面、安全边界、cycles、offline准备、报告准入正反例、历史片段检查、dependency-audit和security/Rust/Electron工作流保持执行。新增CI准入行为测试纳入既有报告准入测试步骤。

## 证据归属与交接

已有本地4779项验证、原ZIP审计和1777输入绑定仍准确归属于产品Source `ff02c6…`；本次不重跑、不重新封存或扩大其证明。CI修复提交使用相关行为测试和随后由Root安排的新自然完整CI单独证明，原失败run不重跑。精确新Source、相关检查退出状态及外置结果回执由Root交接登记读取。

本次相关本地检查使用Node 22.23.2：新增27组CI适用性行为测试及既有19组MBM003报告准入测试共46组全部通过（0失败、0跳过）；控制平面、边界检查和CI脚本语法检查退出0。这些结果不替代新Source的远端完整CI，也不扩大原产品证据。日志保留在本线外置目录`logs/ci-fix-related-tests.log`、`ci-fix-control-plane.log`和`ci-fix-boundaries.log`。

Root审阅后已正常推送CI路由Source `3f552e1af28869407588ac70d9856819817c057f`。R799已作为3f的祖先一并公开，未单独推为分支tip，也未改写原Source/R。3f的首次自然verify运行`38055169649`、attempt1实际通过分支准入，但完整verify在Core的9个合成档案事务测试失败；这些fixture写死本机外置路径，真正Linux hosted在创建临时库时ENOENT，当前003软件Gate因此skipped，不能算通过。原失败日志保留。

## 严格临时目录修正

Root明确追加授权`packages/bridge-core/test/reference-archive-catalog-store.test.ts`的fixture修正。它复用既有`buildStoragePolicy`，以已存在的配置TMPDIR为临时根：本机核实LifeWeave真实挂载、路径和可写权限，hosted核实真正RUNNER_TEMP下的专用MusicBridge子树；不创建假Volumes，不回落本机临时目录。9个业务测试正文原字节不变，不删除断言、不增加skip。

这一验证文件的原版与修正版身份列入CI_SCOPE v2和严格准入模块。单独运行9例全部通过（0失败、0跳过），日志为本线外置`logs/ci-fixture-repair-nine-tests.log`。这是本机相关验证，完整clean环境verify和当前003软件Gate仍须由后续固定新Source的自然CI证明。

## 原有图片语义定位适配

旧ff的首次自然Electron运行`38052666630`、attempt1最终为failure：110项E2E通过、1项失败、5项跳过。唯一失败位于`apps/desktop/e2e/collection-preview.spec.ts`第263行，测试使用旧图片名称“书籍参考图，非实物照片”，而同一ff的运行时组件已使用“原书资料参考图，非我的实物照片”；定位名称不匹配，尚未执行到实际图片尺寸断言。这一错误不能当作已证明图片加载失败。

Root已独立回读并批准该E2E文件第263/264行的两处定位名称适配，运行时组件保持原样。新文件严格等于ff原始字节仅替换这两处正则；图片可见性、160×100真实解码、error回退、库存计数、浅深色、全宽和窄窗几何及入口断言全部保留，不增加skip、retry或fallback定位器。此第二个验证文件也单独绑定原版和修正版的完整SHA256与Git blob，不放宽整个E2E目录。

本次只完成名称与完整字节的静态核验和准入行为验证，没有运行本机App或E2E。真实图片及完整UI行为须由后续固定Source的自然Electron CI证明；旧ff与3f的失败记录保持原始身份。

两项适配的最终本地相关验证使用Node 22.23.2：v2准入36组加既有MBM003报告准入19组，共55组通过（0失败、0跳过）；Core档案9例通过；Core测试类型检查`tsc --noEmit`、控制平面、边界及CI脚本语法检查退出0。日志与退出状态分别保存于本线外置证据目录，不替代新Source的完整远端verify、当前003软件Gate或Electron实际行为。

后续Source必须先交Root回读具体diff，再安排普通推送与新的自然CI；不重跑ff或3f的失败run，暂不新增报告提交。没有共同基线集成、生产导入、真实账号/设备/音频或Owner验收结论。
