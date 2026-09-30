# MBP-002：只读请求生命周期与导航恢复

基线：37fe2d22168d20b5defa336d679c8c8d7dc5d06a。分支：codex/mbp-002-read-lifecycle。
首个实现：bc04b713522ab8547a416131ee18e13336ba1740；最终实现：28bac4a257a39f1c8b4f28c3c3d964c7d8b59c44。
报告身份由包含本文件的独立报告提交解析；下一任务必须从该报告 HEAD 创建。

## 行为变化

- 24 个明确的纯读取命令携带 ID 与绝对截止期限。Renderer 的 Signal 保留在本地，Main 验证可信主页面、原参数、读取 ID 与窗口所有权；Core 只取消对应读取。写命令、录音开始和未知写入回执不进入取消协议。
- Core 在相同作用域、命令和参数下共享读取，各订阅者独立取消和到期。底层 flight 的期限从首次创建固定，后来的订阅者不能延长；排队期间最后一个订阅者取消时零派发。共享 flight 与订阅者数量有界。
- Provider 不支持物理取消时，已派发操作仍计入预算直到实际完成；本地等待结束不伪称上游停止。网易云读取与播放元数据留出独立容量，Roon Browse 与图片也有限额。旧账户、Zone、服务和 Core 作用域的迟到结果不能写回当前缓存或错误状态。
- Roon 超时或取消后废弃状态不明的 session key；按原稳定路径、源索引与元数据核对目标，再使用新的 item key。搜索 session LRU 不逐出仍有操作的会话。迟到图片与 Daily 失败不能污染新一代负缓存。
- Renderer 离页先撤销页面读取所有权，再取消读取和隐藏防抖；返回用新 ID 恢复原目标、查询、分页及滚动。已完成数据和父详情保留在原作用域。取消静默，超时和真实错误仍可见；旧 finally 不能留下跨代加载锁或抢回导航。
- 实际 Electron 检查发现目标页收藏检查被离页清理误取消。首屏检查现统一在目标详情进入后启动；收藏、目录、聚合与父详情返回共用这一顺序，更多页不覆盖在途收藏写入。

本项没有实现详情真分页、TTL 页面缓存、渐进搜索、播放快通道或 Play first / Queue later；对应后续独立任务。

## 最终固定实现证据

源码：826 个跟踪文件，SHA-256 e7e86032e653dc4af47ea9cb04dfb1dca76cf9857de95d9267c4771fdfd35a72。
规则为 git tracked apps/packages/scripts 的 ts/vue/mjs/cjs/json/yaml/yml/js，加根 package/lock/workspace，排序后按 path\0bytes\0 计算。全部 Gate 后复算一致。

| 验证 | 结果 | 退出码 |
| --- | --- | --- |
| 原完整 verify | Contracts 223；Core 1626 / 原有2跳过；Desktop 941，通过 | 0 |
| 严格类型、生产构建、preload 边界 | 三层通过 | verify 内 0 |
| Electron 启动、崩溃恢复、合成凭据与冷启动恢复 | 明确 mock 模式，原4项通过 | 0 |
| 原完整 Electron E2E，加1项实际读取生命周期用例 | 104通过 / 原有4条件跳过，108 total，0 fail/flaky，单 worker，4.8分钟 | 0 |
| control-plane / boundaries / cycles / diff-check | 通过；cycles 347文件 | 各0 |
| Renderer 九文件定向回归 | 118通过 / 0 fail / 0 skip | 0 |

原完整测试范围保留，仅按文件串行运行 Node 单测；未增加 skip/fixme，也未通过缩小范围代替全量结果。完整退出码、源码身份和98份外置证据 SHA-256 见 MBP-002_EVIDENCE.json。

## 失败归因与断言保护

首个固定 bc04b71 的完整 verify 退出1：Contracts 223、Core 1626+原2跳过；Desktop 931通过、1失败。生产构建未到达。主题 IPC 的 VM 夹具按相邻处理器截取源码，却包含新读取处理器；只调整 Main 处理器排列，原来源拒绝与主题值断言未修改，定向1/1通过后在最终提交全量重跑。

实际 Electron 定向第一次退出1：新 Renderer 使用 library:read，原规格只替换具名 IPC，因此合成收藏未进入新通道。新增仅 E2E 使用的适配器，只接入被规格替换的处理器；未替换的读取仍走正式 broker，取消和期限继续有独立身份。没有禁用新能力，也没有失败后回落旧协议。

接线后的第二次定向仍退出1：详情已显示，收藏按钮一直不可用。这是本项新增的真实导航回归，不归为旧夹具问题。实际 browse+journery 调用顺序的 legacy/readLibrary × album/artist 四项均 RED；修正目标页顺序后四项 GREEN，并补九项保护。原收藏、封面、播放全部、分页、布局与写 API 断言全部保留，最终完整 E2E 中对应原用例通过。

其他定向 RED 覆盖期限上下文被剥离、同载荷未共享、Main 回包绝对期限遗漏，以及导航、防抖、加载标志、旧数据和恢复竞态；中间失败日志均保留，不能把某次局部 GREEN 扩大为全分支通过。

## 模式记录与验收边界

Root 的首次 Electron 启动命令漏设 mock，实际以默认 system 模式运行了4项合成值软件门禁，退出0；先前定向 E2E 也使用默认模式。该结果如实保留为 system 模式，不能冒称 mock 或删除记录。随后显式 MUSIC_BRIDGE_TEST_KEYCHAIN_MODE=mock 重跑原4项以及完整 E2E，通过。没有使用真实账号或 Provider 凭据；Owner 对真实凭据恢复的验收未执行。

真实 Provider、Roon/audio、设备录音、Owner听感/设备验收、main合并、正式App替换与发布均 NOT_RUN。录音 Gate B 未认证继续阻断；本项软件结果不能为设备录音背书，也没有测出真实 Roon 延迟或资源占用收益。

上一任务固定37fe2d2的远端：软件 verify 作业、Electron E2E、security通过；verify工作流的独立 dependency-audit失败，11 moderate / 7 high。不标为全CI通过，依赖修复与再次审计保留在 MBP-009 收口。当前报告 push 后的 CI 单独记录。

全部本项跟踪改动已提交；保留原无关的 apps/desktop/test-results/ 与 worktree/ 未跟踪目录，不宣称整个工作区零未跟踪文件。回滚只切回基线或回退本项代码，不删除用户数据库、原图、工作树与报告。

下一项 MBR-002 从本报告提交 HEAD 接续：只读核对原录音 commandId、未知收尾保护与安全重试、SSH探测拥有与关闭、Control API来源和请求预算防护。完整计划继续，不把3/11阶段交付写成V3完成。
