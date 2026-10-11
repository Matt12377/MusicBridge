# CI-REPORT-MIRROR-001：报告镜像历史对象准备

本任务修复报告 CI 的历史对象准备缺口。首次报告 `aebf9464dc080d1242c379db183f4424e62f0b40` 的 verify 在加载原磁带准入负测时缺少 `cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f`，因此失败。原 MBM-004 产品 Source `16507120ab52d4843012e6888ad521138d8336d6` 的软件资格和该次报告失败记录均保留。

本任务使用独立分支 `codex/ci-report-mirror-001`。唯一修复 Source 的直接父为上述失败报告，唯一直接 Report 的父为实际修复 Source；只允许普通新增提交和普通 push。禁止改写既有提交、重跑或手工 dispatch 既有 CI，也不能在原产品 Source 下产生第二份直接报告。

## 修复范围

verify 建立源码身份固定的构建镜像后，在原准入正负例执行前设置独立历史对象准备步骤。实际磁带准入 fixture 存在时，从当前 checkout 的本地 Git 对象库读取原两枚完整 SHA：`cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f`、`99c89519f3357f4018b32930e8179b66719f99e7`。该步骤覆盖 full 与 report-only，使用本地 file 协议，不写标签或 FETCH_HEAD。原产品 task-applicability 的 full 条件、原 11 文件 173 项负测、产品预算和镜像建立实现保持。

Source 的精确范围由 `docs/postrust/MBM-004/CI_CORRECTION_SCOPE.json` 固定：6 个新增文件和 6 个修改文件，共 12 条精确路径；没有产品源码、产品测试、依赖、原任务记账或原报告文件变更。身份由 `CI_CORRECTION.json` 绑定真实父链、原失败和原产品 producer。新路由须在完整 Git 准入后生效；单独分支名、环境变量、记录中的 PASS 或任意路径前缀均不能授予资格。

原 `EXECUTION_SCOPE.json` 的 114 条、`SOURCE_CORRECTION.json`、`LOCAL_SOFTWARE_EVIDENCE.json`、原产品 Git modes/blobs/bytes及 mobile 1.7.0/40 合同必须保持。原 18 任务/156 验收项、有效 17/150 和 MBRS-015 六项 N_A 不增加完成项。Tape、Feedback、Async、整合功能及 MBRS-016/017 不属于本次实现。

Report 仅允许原八条精确报告路径的本域记账更新：`reports/MBM-004_RESULT.md`、`reports/MBM-004_RESULT.json`、`docs/postrust/MBM-004/CI_EVIDENCE.json`、`docs/postrust/MBM-004/STATUS.json`、`project/STATUS.json`、`project/POSTRUST_PLAN.json`、`project/POSTRUST_TODO.md`、`project/POSTRUST_PROGRESS.md`。必须保留原失败和原产品证据归属，不能改变任务/角色/权限/真实验收状态或旧验收项。

## 本次验证和证据归属

新工具 Gate 验证实际 Git 身份、严格 Source/Report 闭集、历史对象准备、原 173 项和新安全行为；保留完整 raw、次数、退出码、signal、timeout、overflow和自有子进程物理关闭证据。修复路径中的原 173 项仅由该 Gate 执行一次，旧独立步骤明确跳过；非修复路径保持原命令和执行。本机 Gate 只在外置卷运行，并与并行容量观测串行。不得调用旧产品 Gate、编译、App、Native Owner、设备或音频流程。

Source 要求首次自然 push 的 4 个 workflow/6 个 job。当前工具准入、镜像准备、工具 Gate、CI 控制/边界/循环检查和依赖 audit 新执行。只有严格验证产品所有输入与原产品 Source 一致后，才复用原 Source 的已消费软件 producer；类型/产品测试/编译、Rust和Electron/App步骤明确记录为 `SKIPPED_REUSED_S165`。本次只保存真实工具产物，不把旧五个产品 ZIP 改称本次产物，也不将跳过写为本次产品 PASS。

Report 要求其首次自然 push 的 verify/security 2 个 workflow/3 个 job，完整原负测及新工具 Gate仍执行。报告准入须先核真实直接父和八路径，再验证实际修复 Source 的首次自然 CI；原 Source CI 或原失败报告 CI不能替代该父提交的资格。只在 Source 与 Report 各自收口后，才从实际新 Report 建立后续整合基线。

本任务只证明 CI 工具修复与原软件证据可复用。正式 App、真实服务、设备、音频和 Owner 验收仍为 `NOT_RUN`。
