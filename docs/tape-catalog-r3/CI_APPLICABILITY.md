# 磁带资料分支的CI适用性修复

2026-10-10，Root已接收磁带资料的独立软件检查点，并安排在本分支追加最小CI路由修复。此次不修改产品源码、原产品范围、共享排程、正在试用的App或真实资料库。

## 原始阻断

产品Source为`ff02c6b2fd248748fe7d461259f5749dda86fa0c`，唯一直接报告为`799fece27f0cfe056a56fd6258f0db380db3461e`，基线为`c0b945a2b8d0f6f3ee2d9ea9d2cb50a787dc7f95`。这些原提交保留，不重写。

Source首次自然push的verify运行`38052666522`、attempt 1，在“MBM003 精确前序软件证据复用”步骤因“003 分支不符”退出1。继承的共享双表仍登记MBM-003，但原脚本只接受003的独立分支。后续install和完整verify没有执行，因此首轮失败不能写成CI通过，也不证明后续产品检查的成败。原始日志和发布回执保留于本线外置证据目录。

## 有限准入

执行任务明确为`TAPE-CATALOG-R3`，当前移动回归任务为`MBM-003`，两者分别输出。Tape路径必须同时满足：

- 精确分支、原EXECUTION_SCOPE原始字节SHA、固定Source的唯一父基线，以及固定报告的唯一父Source。
- 报告之后的有界线性提交链，当前HEAD前后稳定且工作区清洁；hosted runner的SHA及分支必须一致。
- 每个新提交及最终累计diff仅包含CI_SCOPE列出的六个普通CI或本线说明文件；拒绝产品路径、共享机器双表、移动合同、删除、重命名、链接和执行位。
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

本次不自动推送新Source，不单独发布旧R799；Root审查具体diff后安排普通推送。没有共同基线集成、生产导入、真实账号/设备/音频或Owner验收结论。
