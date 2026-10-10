# 磁带资料与 Mac 共同基线集成

Root 于 2026-10-11 放行本次共同基线集成。基线为 Mac 直接报告 `c647e02b40d55b955faabc9d6a2a6220c9286bac`，唯一父及产品 Source 为 `fd176fdf1da069dd678b673f697cdbe8831628cc`；冻结磁带源码为 `cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f`。本线使用独立外置 checkout 和 `codex/tape-catalog-common-baseline` 分支，原磁带分支及主工作区 WIP 保留。

## 产品与资料边界

接入 CFA 的 52 个精确文件，工作流按本次组合任务适配。磁带运行时和验证源码保持 CFA 完整字节，保留资料档案、文本、参考图片与实物照片的来源区分、未知字段及关联关系。资料目录的 34 个品牌、329 个型号名称、634 个年代版本只是参考信息，不代表个人持有；集成源码不向库存添加任何磁带，也不重制 UI。

FD 的 12 项产品绑定、6 项兼容测试和 v3 读取策略完整保留。45 项保护文件逐项追踪；唯一例外是 `scripts/ci/mbm003-predecessor-reuse.mjs`，仅接受已冻结的 CFA 完整内容，其余 44 项保持 Mac 基线。DSD 环境 guard 的 Git blob 为 `1c326466207f035359374707dcba9c3b8cd5d3f6`；移动合同保持 1.7.0、40 个操作、147445 字节及 SHA-256 `3deaa9e238f24b7062945efacc775b604a60a5652b837b8c46378f0b89eeec21`。

## 组合准入与新验证

本次独立 Scope 精确绑定分支、基线、Source 唯一父、报告唯一父、逐提交和累计路径闭包、完整 Git 对象及稳定文件读取。删除、改名、符号链接、执行位、越界改动后回退和未知路径均不取得准入。主 `project/STATUS.json`、`POSTRUST_PLAN.json`、`POSTRUST_TODO.md`、`POSTRUST_PROGRESS.md` 精确继承 c647，不删除旧 LocalFix 标记；本任务仅用此目录的独立记录。

新 dispatcher 输出执行任务、移动回归任务、历史 Gate 模式、LocalFix 任务及组合 Gate 模式。只有完整准入才能输出历史软件证据复用；组合分支不冒充旧 LocalFix 分支，旧准入和其基线仍保持原效力。组合入口执行新 HEAD 的标准完整 verify，以及真正 fresh compiler、Core 和 metadata Worker 的 80 项读取链验证。准入正负例另验证新增分流、证据继承和输出合同。历史 Gate 不重跑，其证据只在精确未变范围复用。

原 CFA 适用性测试及 FD 逆向归一化的 companion 测试含当前工作区的旧 workflow/router 整件断言。本组合已经明确改变这些输入，因此共同工作流不把这两组旧上下文测试当成当前适用 Gate；原测试及其原分支证据保持冻结。新的组合正负例完整验证 CFA router 唯一例外、两套来源字节、分支闭包和新输出合同，旧 LocalFix 纯准入及报告准入测试继续执行。

003 的原 Source `5e96372f0dd99e08b1e2964d68ce234eb438bbdf` 和直接报告 `99c89519f3357f4018b32930e8179b66719f99e7` 的 5 份报告，通过 c647 报告列出的固定 Git ref、blob、长度及 SHA-256 完整读取继承。它们不在 FD 树中，不复制旧 project 记账，也不把原实际运行改称 FD 或本组合 Source 的实测。磁带原档及 1777 项输入、旧手机和真实媒体验证不重复执行。

CI 的隔离镜像使用 `--no-local --no-hardlinks`，普通 clone 不会保留不在当前分支祖先链上的 CFA 与 R99 对象。组合准入前仅从已完整 checkout 的 CI 源仓库读取这两个固定 SHA 的 Git 对象，不复制历史 project 文件，不添加新的产品提交或父关系；新镜像继续没有 alternates，完整字节准入仍实际执行。

## 尚未取得的证据

共同 Source `d6a3fd58a80fd588f7cd86425d870a034548db8b` 已通过本地完整 verify、fresh80、158 项适用准入及首次自然 Source CI。直接 Report 及其 CI 在本报告落盘时待执行；没有普通 App 导入结论。普通库 61 项及冷启动 61 项、真实系统中断和完整 Owner 验收继续开放；这些历史缺口不增加为本次独立软件任务的附加 Gate。

正式资料导入仍为 `NOT_RUN`。执行前另向 Root 提供目标 profile、可恢复备份和资产、目录、库存及关联守恒窗口，由 Root 与正在运行的 App 和 V3.9 操作串行协调。本次源码集成不操作试用 App 或真实资料库，不直接 SQL 写入。

## 共同 Source 软件封口

实现范围 63 路径，唯一直接父 c647；本地完整 verify 4795/4793 pass/2 skip、fresh80/80、158/158，首次自然 Source CI 的 4 workflows/6 jobs 全部 success，均实际读取原日志及本轮 Gate 收据。详见 `reports/TAPE_CATALOG_COMMON_RESULT.md` 和 `reports/TAPE_CATALOG_COMMON_EVIDENCE.json`。Report 本身是 Source 的唯一直接报告，最终 HEAD/远端读回和其自然 CI由外置交付收据绑定。
