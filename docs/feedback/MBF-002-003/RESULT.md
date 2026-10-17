# MBF-002/003 隔离模块交付与未完成接线

本地音乐原页把目录中的歌曲平铺，缺少专辑封面层级，整理入口也未覆盖原 CoverDrop 功能。本次新增按真实来源/目录/发行身份组织的专辑浏览、封面与曲目详情组件，以及完整整理工作台所需的合同、读取、候选、预览和原命令恢复模块。局部软件检查通过；**正式页面与唯一 Owner 共享执行链尚未装配，MBF-001/002/003 均未因此结项，也未进入 Owner 试用。**

## 身份和提交

| 项目 | 实际身份 |
| --- | --- |
| 工作树 | `/Volumes/LifeWeave/Developer/CommandLine/tmp/mbf-002-003-7tvk_82n/workspace` |
| 分支 | `codex/mbf-002-003-local-library` |
| base SHA | `479e746bb7106a4dac158fe616290220de03a53a` |
| 实现提交 | `c9398af851d7b8ddebe83db049e643818eff7659`，78 个明确产品/测试路径 |
| 报告提交 | 包含本文件、映射、接线提案与 manifest 的后续独立提交；其实际 SHA 由提交后外置收据和调度回报登记，本文不自引用尚未生成的 Git hash。 |
| 下一分支基线 | 本报告提交最终 HEAD；仍为本线局部基线，不替代 V3.9 最终集成 HEAD。 |
| 远端 | `origin` 是只读来源 `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-tape-history-e11yzz56/workspace`；没有本分支远端 ref，没有 push。 |
| 远端核对 | 报告提交前本地 `ls-remote`：common-baseline=`479e746bb7106a4dac158fe616290220de03a53a`，history-compat=`6356aa3215364327f8a08783e0367dce51683ca1`。 |

全局 `project/STATUS.json`、TODO 和正式版本状态由 V3.9/调度持有，本线未修改它们。实现提交不是正式 App 接线、真实播放或远端 CI 封板。

## 已实现的隔离模块

- **专辑墙与详情**：复用正式开放式封面墙、连续背景、语义样式及原图标；根/目录/发行身份分别保留，支持本地搜索、七类筛选、分页、回退和旧请求围栏。原 TrackTable 的信息与多选保留，播放/队列只按真实可播放成员限制。默认正式页面的切换由 V3.9 接线。
- **原 Owner 只读专辑投影**：原 guarded 连接中的完整统计与分页，图库一次分组聚合、一行公开 envelope；解析前核精确 UTF-8 2 MiB，不把旧 64 KiB 源行预算移到派生页。成员页最多 200，工作台完整 capture 独立最多 10,000 成员/32 MiB，超限整组拒绝。原 300k 轨、1.2M 关系、600k scan 域及冷核规则未降低。
- **封面事实与读取**：同原来源许可、可撤销读取及真实 FD 生命周期；已有封面/按需未知/明确无图/来源不可用分别保留。候选、显示副本与应用捕获分开，不在浏览或查候选时创建发行。原图来源、结构与图像预算经严格边界验证，真正 native 解码仍待 V3.9。
- **整理工作台**：完整明选批次；原本地/聚合/网页/文件/拖入候选；名称建议、理由和字段比较；CUE 实际区间/格式/独立目标预览；明确应用、逐项结果、取消与 unknown 查询原命令。没有真实端口时如实显示不可用。
- **合同与恢复**：严格公共 DTO、私有 Owner/Main 读取 envelope、Main sender/dataset/nonce 边界、显式 Preload client 和 Renderer ports；持久 CAS helper 只接 required 原 Owner，原命令未知时不重签或重放。Main 异步工作库核对在读前/回复前真实 await。

## CoverDrop 范围

固定来源是 `93fa28f3245da50cf9b5341e0df1466fa4f6a0e7`，以 Git 对象只读核查原 UI、AppModel、设置、服务和实际调用，未读取或改写该项目脏工作区。[完整映射](COVERDROP_FEATURE_MAP.md) 与机器 JSON 分别列出 **35 个原可见流程、1 个 MB 既有保留流程、1 个该固定版本不存在项**。功能数不是测试数。

原三种 AI 后端、豆瓣/iTunes 与网页来源、七类筛选、库记录/多库选择、并发 1–24、扫描快照/局刷、封面入口和八项 CUE 编码规则全部作为保留范围登记。固定版本没有通用源标签/音频改名移动 UI 或歌词服务；MB 的现有源标签/封面写回、搬迁、历史恢复和歌词继续保留，不以本次界面改造删除。

映射完整不表示这些流程全部已接入。本次接口、纯计划、候选及控制器也不表示已经有真实分轨产物、共享写入或云端调用。

## 新鲜验证

所有构建缓存、日志和合成库在外置 LifeWeave 上；每次包装器先核实际外置挂载及可写。没有启动正式 App、Scanner/Reader/Worker、真实 Provider 或真实曲库，不重放原旧任务 Gate。

| 检查标签 | 2026-10-11 UTC 起止 | 实际结果 |
| --- | --- | --- |
| `mbf-core-affected-final-v2` | 03:22:01.484–03:22:08.375 | 97/97，fail/skip/cancel 0，退出 0。 |
| `mbf-desktop-affected-final-v2` | 03:22:01.484–03:22:04.480 | 117/117，fail/skip/cancel 0，退出 0。 |
| `mbf-core-types-final-v2` | 03:22:10.614–03:22:15.961 | Core tsc `--noEmit` 退出 0。 |
| `mbf-desktop-types-final-v2` | 03:22:10.613–03:22:25.333 | desktop vue-tsc `--noEmit` 退出 0。 |
| `mbf-capacity-600-final-v2` | 03:22:33.540–03:22:36.737 | 600 轨真实原 Owner 小例退出 0；37 次请求为 35 成功与 2 个按预期旧修订拒绝。 |
| 暂存后的完整差异检查 | 实现提交前 | `git diff --cached --check` 退出 0，确含新文件；另修正一个 EOF 空行。 |

日志和同名 `.json` 收据都在外置 `checks/`，命令、退出、总时间、物理进程组退出、实际源码 hash 见 [VERIFICATION_MANIFEST.json](VERIFICATION_MANIFEST.json)。原四次/600 runner 的 before/after seal 只包含 Core 与合同集合；desktop 没有该全集独立前后封印。作者 03:21/03:25 的实际 SQL/types/model/对应测试 SHA 已与当前逐项对照，其余 desktop 记录当前完整身份与当时冻结边界，**不把事后 hash 当作原检查全集 before/after 证据**。下一容量 runner 已扩大到 Core/desktop src/test、合同及构建清单。

检查后唯一代码字节变化是 `owner-store.ts` 删除一个 EOF LF；已验证新字节加回 LF 与旧字节/hash 完全一致，完整暂存差异检查通过，未改逻辑。manifest 明确保存该格式变化，不把原字节封印冒充当前字节。

新 600 轨实际 all=50，七类为 0/1/2/2/1/1/2，双根 29/21，三个独立发行。图库 1 SQL/1 包；205 成员尾页 2 SQL/6 行、完整 capture 含 205 成员/2 rejected/3 issues；缺图、raw 水位及自有来源离线/恢复均保留。首图库请求 55.09 ms、37 次请求最大 261.35 ms、累计 maxRSS 183,472 KiB。此例 `full300kQualification=false`，未做 300k writer 拒绝或 301k 冷开负例，不能外推大域性能。

旧 300k 被调度停止，两个自有测试进程物理退出，退出 1、`TEST_STOPPED_PERFORMANCE_NOT_PASSED`；自然完成的首段五次图库共 1,005,059 ms、累计 maxRSS 3,773,056 KiB。旧失败日志、DB/WAL 与完整停止记录保存；新小例不覆盖该旧快照，也不代替新大域资格。详见 [容量证据](ALBUM_SQL_CAPACITY_EVIDENCE.md) 与 [SQL 性能复核](ALBUM_SQL_PERFORMANCE_REVIEW.md)。

## 交给 V3.9 的具体共享提案

本线提供隔离模块与最小改动规格，调度 Root 审界，**V3.9 实施共享最终代码**。以下提案没有在本线应用，不以接口存在或 apply-check 替代实际执行。

| 提案 | 需要 V3.9 完成的实际接点 |
| --- | --- |
| [正式路由与页面](V39_ROUTE_AND_PAGE_INTEGRATION.md) | 原 Client/RPC/Worker、utility wrapper、Main supervisor/register、私有错误封送、Main native 解码、Preload keys、App/LocalLibraryView 真实默认封面墙及原维护入口。 |
| [原子 writer](V39_ATOMIC_WRITER_INTEGRATION.md) | 同原 Owner 原连接完整组事务、原字段级作者证明、准确发行/关系/原图冻结、失败无半组、未知回执与重开；CUE 另走 Actor。 |
| [原生与设置](V39_NATIVE_SETTINGS_INTEGRATION.md) | picker/FD/独立目标许可、CUE 实际编码/逐轨输出及物理收口、库记录/多库、扫描并发与快照/局刷、原三 AI 后端/保险库。 |
| `proposals/SHARED_WORKBENCH_JOURNAL_PROPOSAL_V2.patch.gz` 与原 `.json` | Root 已限定认可 V2 替换 V1；仍须原冷核注册、同连接持久 CAS/capture/apply/reopen/stale/rollback 实做。 |
| `providers/pinned-transport-review.patch` | Root 已限定认可来源请求头最小修正；仍由 V3.9 应用并核 HTTPS/DNS/TLS/取消物理收口，不放宽公有地址规则。 |

两份 patch 在当前 source 上 `git apply --check` 退出 0，仅说明可应用；没有应用、编译该共享差异或封存实际 SQL 写入验证。V2 journal patch SHA `68d2409c692455413f7bc7077b55097e9b7452a6059c7fa03fb66fdde820d356`，保留原 V1 证据，V1 不再作为拟实施版本。

Git 中的两个 journal patch 使用 gzip 无损保存，解压字节与获批原 patch 完全一致，metadata JSON 的 `patchSha256` 继续针对解压后原字节。这样保留原 diff 上下文空白行，并继续执行普通源码的完整空白检查，不修改获批 patch 或放宽 Git 检查。普通 `.patch` 副本完整保存在外置 `checks/immutable-proposal-copies/`，原 `checks/` 证据也保留；解压身份和当前 apply-check 见 `checks/PROPOSAL_ARCHIVE_IDENTITIES.json`。

## carryover 与试用门禁

| 未完成项 | 所属与下一步 |
| --- | --- |
| 本地点击无声/0:00 | MBF-001 由 V3.9 跟进源读取、输出与真实播放；参数报告不能替代启动/声流/真实声音。 |
| 新完整 300k 与 301k 负例 | 调度统一安排一次新窗口；总 600 秒/单实际请求 30 秒，超时停止并等整个自有进程组退出、保留 partial，完整原合法域与预算保持。V3.9 当前必要修复优先。 |
| 正式专辑默认页及封面 | V3.9 接入正式 App、真实曲库、Main 解码并验证，不能用 SFC/合成封面替代。 |
| CoverDrop 全部真实流程 | 按映射逐项接入/验证；尤其共享 writer/journal、原生输出、扫描/设置/Vault 和原维护入口尚未完成。 |
| 最终工程/真实应用/音频证据 | V3.9 最终 HEAD 的完整回归、打包/Worker、真实 App/媒体与输出分别登记，原局部检查不自动沿用。 |
| Owner 成品试用 | 三项修好并经 Codex 先验证之后再进入；当前未邀请、未接受、未结项。 |

本报告允许接线作者复用已有新鲜局部证据，避免无变化重复检查；任何共享或产品逻辑改动仍须验证实际最终快照。全局发布/验收结论继续由调度及 V3.9 登记。
