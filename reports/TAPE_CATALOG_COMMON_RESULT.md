# 磁带资料与 Mac 共同基线结果

冻结磁带实现 CFA 与 Mac 的读取策略已经在独立分支共存，本次没有操作试用 App 或真实资料库。

基线：`c647e02b40d55b955faabc9d6a2a6220c9286bac`；唯一父及 Mac 产品 Source：`fd176fdf1da069dd678b673f697cdbe8831628cc`。共同实现 Source：`d6a3fd58a80fd588f7cd86425d870a034548db8b`，唯一直接父为基线。磁带冻结 Source：`cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f`。本报告提交只添加两份报告并修改独立 STATUS/INTEGRATION，唯一直接父必须为共同 Source；提交后自身身份由外置交付收据记录，避免循环自绑定。

## 实现范围

接入 52 个 CFA 精确文件并适配共同准入、fresh Gate 与 CI，共 63 项 Source 路径。Mac 的 12 项产品、6 项兼容测试、45 项保护、v3 读取策略、DSD guard 和移动合同逐件保持绑定；唯一保护例外是 CFA router 的完整文件。4 份主项目记账文件仍继承 c647，由 V3.9 维护。资料的 34 品牌、329 型号名称、634 年代版本是继承的参考元数据，不表示个人持有，也不是本次真实库导入结果。

## 本地验证

- Node.js 22.23.2、Corepack pnpm 10.17.1；外置 LifeWeave 任务目录，无本机构建回落。
- Source 完整 verify：4795 tests / 4793 pass / 2 skip / 0 fail；类型检查、单元测试及构建退出码 0。
- 新边界 42 项准入、7 项分流、9 项收据/Worker；连同适用旧纯准入和报告测试，共 158/158、0 skip、退出码 0。该套先验证冻结待提交树，之后 63 文件字节匹配实际 Source；Hosted CI 又对实际 Source 执行同套 158 项。
- fresh compiler/Core/metadata Worker 80/80、0 skip、退出码 0；3 个编译阶段均为 0，1048 项完整输出和 36 项产品输出封口。9 stage 的退出、close、raw 捕获、规范日志及名单实际核对。
- 控制平面、边界、循环扫描、实际 Source 准入、完整字节审查与 diff-check 均退出码 0。

这几层单独统计，不把重复执行的测试相加当作需求覆盖率；没有声称普通 App、设备、声音或 Owner 验收通过。

## 首次自然 Source CI

- [Rust Core 只读原型 #38085057621](https://github.com/Matt12377/MusicBridge/actions/runs/38085057621)：首次自然 push / attempt 1，2 个 job 全部 success。
- [security #38085057663](https://github.com/Matt12377/MusicBridge/actions/runs/38085057663)：首次自然 push / attempt 1，1 个 job 全部 success。
- [verify #38085057664](https://github.com/Matt12377/MusicBridge/actions/runs/38085057664)：首次自然 push / attempt 1，2 个 job 全部 success。
- [electron-e2e #38085057646](https://github.com/Matt12377/MusicBridge/actions/runs/38085057646)：首次自然 push / attempt 1，1 个 job 全部 success。

实际消费 6 份完整 job 原日志和本轮 verify 产物中的 14 份收据/规范日志；Hosted 标准 verify 为 4795/4793 pass/2 skip，准入 158，fresh 80。只下载本轮新 verify 产物；旧大 ZIP、1777 输入、旧手机及媒体 Gate 均未重跑。归档排除了临时 raw 文件，它们的现场完整捕获由 Gate 收据记录，本报告不声称从归档重读了这些临时 raw 文件。

本轮 Hosted Electron 启动与恢复 12/12、0 skip；端到端 116 tests / 111 pass / 5 skip，原日志实际读取，均绑定共同 Source。

## 原报告继承与纠正

原 003 Source `5e96372f0dd99e08b1e2964d68ce234eb438bbdf`、直接报告 `99c89519f3357f4018b32930e8179b66719f99e7` 的 5 份 Git 对象，按固定 ref/blob/长度/SHA 完整读取继承；原实际运行没有改称 FD 或本共同 Source 实测。测试初轮失败、Git alternates、两种负例构造问题、镜像缺历史对象及本地收据命名冲突都保留诊断记录；后续适用范围的当前源码复测与真实 Source/CI封口另记，没有把失败尝试涂成通过。原旧上下文 companion 保持字节冻结，共同 workflow 执行新适用范围。

## 后续与证据边界

正式导入 NOT_RUN；普通库 61、冷启动 61、真实系统中断和 Owner 验收仍开放，不增加为本次软件任务的新 Gate。Root 已接收静态审查和本地证据，正式导入在 V3.9 最小正常加载/冷启动窗口之后另协调目标 profile、可恢复备份及资产/目录/库存/关联守恒。本任务未选择真实 profile、未写入真实库、未替换 App。

下一共同基线为本 Source 的唯一直接 Report，最终 SHA 与其首次自然 CI由外置小型交付收据交给 Root；本报告落盘时报告 CI 尚未执行，不把它写成通过。
