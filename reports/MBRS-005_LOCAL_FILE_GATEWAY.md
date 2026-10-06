# MBRS-005 · 本地文件网关与统一物理资源租约

当前增量在已有StreamGateway/Registry加入本地原文件分支：只有经唯一Owner扫描观察绑定的私有descriptor才能打开固定FD，完整GET/HEAD/单Range按原字节输出；HTTP请求完成不结束播放租约。默认仍为loopback，异机媒体factory存在但真实LAN未启用。最终源提交为 `afece74b55bdba56cd802e03e1dca7fa886f26a7`（初始产品实现4587a21，含严格宿主测试修正），base为004最终报告 `52c9ffe0aec3c581fe4682a8fd3ba8edf1a74f58`。

新34项行为与旧85项受影响回归共119项统一Gate全部通过；九阶段包括fresh Contracts/Core/固定Metadata Worker bundle、Core/Desktop及E2E类型。20份fresh输出在本次Gate内后验保持；1155份声明输入随后逐项与实现提交Git blob匹配，不宣称整个传递依赖源码闭集。另29项Gate/CI脚本检查、桌面production构建与preload依赖检查通过。按本轮风险政策本机未重复全workspace，实际源提交的远端验证另记录；没有重跑十万/三十万扫描。

固定租约PREPARED为30秒；真实可信会话确认才能转ACTIVE/PAUSED，续期5分钟、总上限12小时。物理保护按真实FD dev/ino协调跨根别名、硬链接及共享cover；Core utility与唯一dataset-owner Worker共享32772字节SAB，旧五种严格读取入口统一保护且不降低Hash/nlink/预算。取消先中止响应、join实际IO并确认FD关闭，再释放保护；无法证明quiet就保守保锁。每块64KiB、遵守背压、每lease4请求/全局8请求、默认8租约；stat validator只作弱ETag，If-Range保守回完整200。

首次源4587a21自然CI在Rust/Electron前置及workspace遇到旧宿主测试的两键断言；实际Linux/macOS小artifact摘要匹配、所选适配日志及本机16项复现均定位同一第5case。修正后严格三键与SAB身份/尺寸验证保持环境和生命周期断言，16项加入统一Gate，119全通过，产品实现未改。保留初始失败和未下载的277MB Electron宽artifact，不手动rerun旧CI。

首轮审查发现descriptor之后替换文件可能把新bytes关联旧catalog修订；六项有效RED失败后，通过私有扫描signature与asset/track/root/location/selection修订绑定、打开前后核对修正，六项GREEN及第二轮实际scanner/admission/SQLite→固定FD探针通过。独立产品R2无剩余P1/P2。原循环检查发现类型依赖环，随后只拆出解析类型leaf、保留Registry re-export，437文件检查通过。CI审查补齐Rust路径过滤的patches真实输入；报告复用仅接受精确直接父源码的四套attempt1实际产品步骤和当前任务Gate成功、相同repo/branch/head、未过期artifact digest元数据；未知API/身份回完整检查，不宣称下载或验证artifact内容。

原12条验收文字和kind不变：01/02/03/04/11/12为限定软件PASS，05/07/08/09/10为带明确实际环境/Controller/Organizer/UI缺口的PARTIAL；06保持live_roon未运行。受控MetadataReader和NAS式错误不是真实parser/NAS验收。实际Roon/Core/Zone、LAN部署、NAS离线、声音、普通App和Owner最终成品验收均未运行；006接实际Controller所有currentness/session，012/014再接受保护的具体源写计划。当前拒绝非null片段/CUE，不把它们当整文件播放。

[网络范围](../docs/postrust/MBRS-005/NETWORK_ACCESS.md)、[本地验证记录](../docs/postrust/MBRS-005/evidence/local-software-checks.json)和[机器证据报告](MBRS-005_EVIDENCE.json)给出命令、退出码与私有证据引用。原Writer RED/准备失败、循环首次失败均保留。001/002真实验收、004播放AT006、003历史300000访问/299975接受/25拒绝（20读取超时、5Worker启动超时，物理原因未知）、iOS合同采用与上游许可UNKNOWN继续独立跟踪。

最终源提交的四条自然CI／六个job均已实际完成success：[rust-core.yml](https://github.com/Matt12377/MusicBridge/actions/runs/37415678695)、[security.yml](https://github.com/Matt12377/MusicBridge/actions/runs/37415678709)、[verify.yml](https://github.com/Matt12377/MusicBridge/actions/runs/37415678655)、[electron-e2e.yml](https://github.com/Matt12377/MusicBridge/actions/runs/37415678701)。verify的完整workspace实际4284总／4282通过／2条件跳过／0失败，生产依赖审计和当前MBRS005 Gate、双平台Rust边界、Electron启动/恢复与完整Playwright步骤均成功；本机保持定向验证政策。workspace计数来自实际job日志，源artifact仅核平台producer／digest元数据，未下载本次源artifact内容，不能称归档字节验收。

Owner最新要求每个独立任务闭环后更新待办并push，持续到017，测试按风险选择。本报告为最终源提交的直接子提交；报告SHA按Git历史解析，报告push与自然CI在提交时待运行，最终结果统一封存于外置 [最终交付收据](/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-mbrs005-zfe0d69k/FINAL_DELIVERY_RECEIPT.json)，不递归改写报告以填入自身SHA。报告检查只有精确父源的实际产品Gate成功及文档/机器台账范围不变才可复用，仍运行控制面、边界、循环、准入脚本与生产依赖审计；未知身份回完整检查。最终报告HEAD是006分支基线，006尚未开始。
