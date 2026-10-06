# MBRS-003 持久增量扫描结果报告

本次最终实现为85841879bf6d31b3efd0970f235c8431fed980e8。Owner已接受历史规模结果用于阶段推进，不重跑当前100k/300k；完整产品最终用真实曲库验收。本轮不启动004，完成003自动检查后换届。

## 当前验证与安全收口

本机固定pnpm10.17.1冻结安装退出0，原high级生产依赖审计退出0：高危0、严重0，仍有6项moderate。标准workspace verify在当前实现HEAD自然退出0，类型检查、254项合同测试、2468项Core测试（2466通过/2既有条件跳过）、1422项Desktop测试及生产构建通过；合计4142通过、2跳过、零失败。003专用13阶段/124项软件Gate通过，1210份声明输入逐字绑定最终实现Git blob；安全29项和控制平面/边界/循环检查退出0。它不是完整依赖源码递归闭包或当前全规模PASS。

前一报告03f8abb的生产依赖审计自然退出1：1critical＋2high＋6moderate。这些版本已在002基线存在，报告与前实现之间的依赖树无变化；两次npm审计响应不同，具体更新/缓存原因未证实。保留该失败，不借前实现的审计绿灯替代。最小修订保持原patch、override、xlsx校验值及审计阈值，仅固定proxy-addr2.0.8、source-map-js1.2.2，并将Vue与compiler-sfc同升3.5.42。依据：[proxy-addr公告](https://github.com/advisories/GHSA-jqcg-44mw-7w3h)、[source-map-js公告](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)、[Vue公告](https://github.com/advisories/GHSA-g2v6-rqmx-r4w6)。

升级后的首轮workspace verify保留真实5项Desktop失败：新版Vue使用getRootNode和Document/ShadowRoot身份，原合成DOM欠缺接口。只补共有测试环境及三处harness，保持全部既有测试声明、断言和产品SFC；四个原测试文件71项GREEN，再完整workspace verify GREEN。没有吞异常、跳用例、增等待或降低安全门槛。

此前6e01a1d的Core构建顺序与Preload旧表错误在251eae9中修复，原失败保留；251eae9自然CI四项最后均成功，但不替8584187的新CI。当前实现CI及本报告CI分别记录，报告封存时未终结的状态如实保留，最后终态见外置mbrs003-root-delivery-154-01的FINAL_DELIVERY_RECEIPT。

## 实现与身份

基线：a7b27b5b6a5168bd146a3cbe61b579efd5639263。初始实现6e01a1d9e8f14282eedaef6065ad1368355674b8；前次CI修正251eae9bd354f916a2904e4899c6b061ac3371ec；最终实现85841879bf6d31b3efd0970f235c8431fed980e8。分支codex/mbrs-003-persistent-incremental-scan。报告提交从本文件Git历史解析，远端HEAD和报告CI另核。

新增持久扫描任务、分批写入、暂停/继续/取消与冷恢复、增量识别、分页本地库、CUE关联、确认重定位和设置页入口。普通metadata扫描使用有界只读Reader，保持原唯一业务库writer、源文件只读和旧录音严格探测；Node仍为默认，Rust可选只读保持OFF。

当前Gate约61.35秒，软件整体360秒/阶段180秒、外层390秒，未运行规模扫描。它只核固定Owner决定与四份历史JSON，不打开旧数据库。运行器此前34/34有限测试证据保持，当前提交CI按原入口重新执行；当前计数与终态按各自运行身份记录。

## 25条超时：已知与未知

历史300k运行访问300000、接受299975、拒绝25；其中读取TIMEOUT为20，WORKER_START_TIMEOUT为5。分类已完整核对，未知错误码为0。运行自然退出1，未耗尽18小时内部预算，后两阶段未运行。

已知：20条触发读期限错误，5条在Worker启动3秒期限内未观察到online。坏项被隔离，已接受数据保留。未知：逐项身份、当时的父/Worker触发位置以及具体物理原因；现有日志无法把CPU调度、I/O、解析或依赖加载中的某一项判为根因。启动耗时统计不含未online的5项，Worker总寿命也不能当解析耗时。

当前Reader固定期限及v2 Worker部署问题已有代码与有限行为验证，但没有新的完整规模结果证明25条全部消失。依Owner决定将此风险带入最终真实曲库验收；若再次出现，按当前安全origin/phase与Reader/Worker/句柄记录定位，保留失败原件，不无限重试。

## 原验收与剩余范围

| 原验收 | 本轮结论 |
| --- | --- |
| 01 首次/增量/恢复 | 有限软件与离线App通过，真实全库留待最终 |
| 02 故障隔离/交互 | 软件故障和App坏文件/权限/取消有证据；普通App原生3秒超时及扫描中响应仍待验 |
| 03 支持矩阵 | 六核心格式与CUE关联已有样本；APE/DSF/DFF明确UNSUPPORTED，片段播放未验 |
| 04 源内容不变 | 短合成原件前后字节保持，未对真实全库下结论 |
| 05 重定位身份 | 有证据的确认定位/冷恢复通过，多候选不误合并；真实整库重挂待验 |
| 06 读取优先级 | 13项Controller/Gateway软件集成通过，真实播放并发待最终 |
| 07 普通扫描与录音 | 有界读与原严格Hash/SourceLock保持分离，有限软件通过 |
| 08 独立规模/分页 | Owner接受历史规模用于阶段放行；当前100k/300k不重测 |

原8条断言与全部18任务/156AT完整文本保持，不把Owner的规模例外解释成八条技术全PASS。离线App现有51项身份、5000项暂停恢复、1200项取消冷开及坏文件/权限结果按各自证据范围保留；5000/1200仅完整计数、200前缀及三个样本身份，不能称全量逐ID证明。当前N软件/App事实不代替真实账号、Roon、音频或Owner成品验收。

## 试用与换届

试用入口：docs/postrust/MBRS-003/TRY_OFFLINE.command。当前独立试用树绑定8584187与1210份声明输入，使用新生产构建的798份编译文件（含20份Desktop产物）、官方Electron43.4.0、每次全新外置资料目录、离线合成服务与模拟钥匙串；zsh语法检查0。本轮未额外启动App，旧N42/O不改。这是工程试用，真实曲库、账号、播放与成品Owner验收仍待最终。

Owner要求003完成后换届，本轮不启动004。下一届读取 docs/postrust/MBRS-003/HANDOFF_NEXT_SESSION.md，从003最终报告HEAD创建004独立分支，继续名称/专辑/版本规则；完整产品后做真实曲库及播放验收。002、RUST历史carryover仍按原边界保留。

机读结果与精确引用见 MBRS-003_EVIDENCE.json。
