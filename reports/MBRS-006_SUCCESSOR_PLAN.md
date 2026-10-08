# MusicBridge 移动前移衔接计划

原 MBRS-000～017、18 个任务及 156 条验收原文保留。本文件登记后续移动调度，不改变 MBRS-006 产品冻结范围、门禁、原分工或 WIP。原核心任务继续已有授权；014 保护先于 012/013，015 已由Owner取消、原六条验收不适用。006的源码/报告实际交付身份以对应报告及终态收据为准。当前合同输入为下文UI候选1.5.0，仍待MBM-000正式采纳。

2026-10-08 Owner已授权移动开发前移：MBRS-013完成既定软件交付封版后，接续独立MBM-000～004，再做MBRS-016和017。当前013继续实施，不取消或重启；原产品Gate、硬依赖和验收标准保持。此前“017后启动”的登记是历史调度。正式责任与真机节点见[生效计划](../docs/postrust/MOBILE_FRONTLOADING_PLAN_2026-10-08.md)。原来的真实账号、原文件写入、LAN部署、安装、发布和 Owner验收边界继续有效。移动 file+FLAC 必做闭环不依赖可选 HLS。

## 历史合同输入与交付身份

iOS仓库为 private [Matt12377/MusicBridge-ios](https://github.com/Matt12377/MusicBridge-ios)。本次只读核对远端审计分支`codex/ios-v39-interface-audit`：源码提交`e7d4218b32f615f1e5d910a0d0a8e697ee04ad9e`，最终独立报告HEAD及观测远端HEAD均为`2e7d5ec4aacc1c1ae266d6262cc405fb8b4c7f17`。源码到报告只有一个提交、8个文档/状态/Gate元数据路径，没有产品源码变化。

- 基础：`Contracts/openapi.yaml`，v0.1.0，SHA256 `03056740fbb8443e2ab862e27d7af7927ab467a3f7cb44babfb6b79ee442480d`。
- UI扩展：`Contracts/proposals/UI_V39.openapi.json`，候选1.0.0，SHA256 `321ac5671500cb65e081f88f3389500007f0e481ca0d68103458b22a6449e201`。
- 控件盘点：`docs/integration/UI_V39_CONTROL_COVERAGE.json`，SHA256 `aff69983f0a462096a04a806f3e40468996ea4bd101fd3f7fdc1ab18f99ddbfc`；62个分组、41个intent属于客户端源码盘点。
- [正式交接](https://github.com/Matt12377/MusicBridge-ios/blob/2e7d5ec4aacc1c1ae266d6262cc405fb8b4c7f17/docs/integration/V3_9_IOS_INTERFACE_HANDOFF.md)、[结果报告](https://github.com/Matt12377/MusicBridge-ios/blob/2e7d5ec4aacc1c1ae266d6262cc405fb8b4c7f17/reports/IOS-013_UI_V39_INTERFACE_HANDOFF_RESULT.md)及`reports/evidence/IOS-013_UI_V39_CLIENT_GATE.json`均在最终报告HEAD可审。

上述三个合同文件在源码与报告HEAD字节一致，Gate登记哈希亦一致，核对见006外置证据根`IOS_REMOTE_FINAL_HANDOFF_READONLY_01.json`。iOS报告及Gate登记的软件/模拟器结果由iOS开发对话执行；本对话只核对远端身份与已提交文件，没有重跑iOS测试或构建。客户端本轮状态为SOFTWARE_HANDOFF_DELIVERED，真实服务、物理设备本版和Owner产品验收仍未运行；Mac后端采纳为PENDING_MBM000，客户端交接完成不等于后端支持或联调通过。

首次本地读取HEAD`095a9ad345d7cf40b4e7570074fa53e4d496f1d9`及分支`codex/ios-013-compact-development-menu`、独立WIP和提案初始哈希`e04ae30db1ed7a9308e4cc41b9c2f3436c7ddc863792fd5ae05d3ecbb67dd394`仅保留观察历史；后读发现变化的记录仍在`IOS_HANDOFF_CANDIDATE_READONLY_01.json`与`IOS_HANDOFF_CANDIDATE_POSTREAD_01.json`。本对话没有编辑iOS工程、暂存其文件或复制WIP作为冻结合同。

基础FormatCapability当前只有codec、container、maxSampleRateHz和maxChannels，且additionalProperties=false，位深上限不会由客户端本地校验自动传到服务端。候选在formats条目增加可选maxBitsPerSample请求envelope；仅`/ui/capabilities`同时声明UI版本1.0.0与`resourceFormatBitDepth=true`才发送扩展，旧/缺能力继续基础DTO及受限兼容格式，不能声明直接FLAC能力。MBM-000须核对最终提案，冻结旧/新请求接纳规则、能力开关、版本及字段语义；不能在未采纳时声称基础合同已支持该字段。UI新增能力、最近添加、每日推荐与精确来源歌词共四个候选操作，其失败/空状态仍须按真实能力显示。

移动兼容矩阵还须覆盖旧队列恢复时缺少sourceCodec提示、auto/balanced偏好及明确lossless偏好。服务端以实际精确源文件及修订为准：真实源为FLAC时仍给可播放的保真资源，不能依赖客户端提示，也不能以QUALITY_UNAVAILABLE或AAC结束。此场景列入MBM-000合同差异和MBM-003资源测试，不增加当前006或原MBRS主线门禁。

## 任务、责任与开始条件

| 后续任务 | 前置交付和开始条件 | Mac主责 | iOS主责 | 完成证据 |
| --- | --- | --- | --- | --- |
| MBM-000 合同采纳 | 013最终软件报告封存；iOS当前UI交接获得可核对的最终实现/报告及远端身份 | 核对基础0.1.0、UI扩展、位深envelope、来源/实际参数、能力和错误边界；冻结双方合同版本/哈希与差异台账 | 提供最终合同、控件覆盖、客户端映射与候选版本，落实双方采纳的wire变化 | 成对分支/HEAD、Git与文件哈希、schema及兼容正负例、责任/复用表；不冒充真实服务 |
| MBM-001 配对及只读曲库 | MBM-000；引用009库查询和010封面最终交付身份 | 独立设备配对/鉴权、私有HTTPS、曲库/搜索/分页/封面门面，复用现有数据库读取与权限边界 | 配对、恢复/刷新/解除授权、服务器身份、目录/分页/搜索/封面接入 | 合成认证/分页/权限和稳定身份验证；实际HTTPS/真机联调单列，凭据不入代码/日志 |
| MBM-002 手机资源播放 | MBM-001；引用005读取锁/租约、007队列恢复与008格式证据的最终身份 | 每设备独立session/resource、票据、Range/续期/撤销和资源清理；不依赖家庭Roon当前Zone | 手机本地队列与音频引擎、seek、续期、切歌、换质、过期和断连恢复 | 完整file端到端、Range/续期/撤销、晚回报隔离、FD/读取租约清理、家庭播放互不干扰；实际音频另验 |
| MBM-003 FLAC无损必做 | MBM-002及已冻结格式能力；高规格原样链可靠性按实证判断 | 原样链可靠则直送；不可靠则提供受控无损ALAC或适当PCM/WAV资源。源只读，转换资源独立并复用原读取锁；source/actual分别如实记录 | 提供精确采样率/位深/声道能力；验证实际解码、播放、seek与续期，核对source/actual和处理原因 | 至少覆盖16/24bit及24bit/44.1kHz等双方矩阵；保留高规格FLAC原链失败；无静默AAC/MP3、降采样、降位深或减少声道；不能以unsupported或白名单登记结束FLAC闭环 |
| MBM-004 内容及多设备回归 | MBM-003；前述UI扩展已采纳、原Provider安全通道可合法使用 | 网易云、首页/最近添加、推荐、歌词与精确来源身份，设备隔离和安全回归 | 所有当前按钮/内容接入、空/失败/重试、后台/锁屏与系统播放 | Mac与iOS分别测试/提交/报告；两部手机+家庭Roon联合验证、真实账号/音频及最终Owner产品接受分别登记 |

每个MBM任务独立冻结范围、分支、实现及报告，不把上述新增需求插入007/008/009/010的冻结任务。自然复用点是各原任务的最终报告HEAD；缺少后端能力记入对应MBM待办，不另造数据库写入作者、读取锁或家庭播放协调器。设备在自己手机播放，不要求绑定家庭Roon。原家庭PostRust的原样直送合同继续保持。

Mac开发对话负责后端代码、Gate、明确路径暂存、普通push及源码/报告身份；iOS开发对话负责客户端实现及自身交付。协调对话核对成对版本、依赖和最终联合验收，不代写产品或移动开发树索引。每阶段报告实际接口/能力状态及exact HEAD；“已移交”不能替代尚未完成的实现或验收。

## 未完成事项

当前五个MBM任务均为NOT_STARTED。iOS最终软件交接身份已核；MBM-000等待013最终软件报告封存后连续启动。本次合同只读核对不是Mac采纳或联调成功。FLAC原样/无损转换、真实私有HTTPS、两真机、真实网易云、后台/锁屏、家庭Roon非干扰、30分钟运行、签名安装及最终Owner验收尚未执行。原MBRS真实验收carryover和003历史25条超时继续保留，不用移动计划抵扣。

## 当前合同入口与验证节点（2026-10-08）

当前工作区只读核实UI候选1.5.0，86670B，SHA256 `0ea921d26dff63b5d3418a1830b58d6de45eaed0b630245d404db00ac5a60746`，17 paths/20 operations。此为候选观察，Mac正式采纳仍等待MBM-000；上述0.1及1.0～1.4交付与合同历史保留。000复用已有UI/DTO/PlaybackCoordinator，按真实精确源及位深envelope冻结成对版本。

MBM-002首条可运行真实Mac→iPhone文件链路即接真机，003必须验证可播放FLAC保真路径，004验证双机、后台锁屏、系统控件和家庭Roon非干扰。每项完成更新TODO、实际源码/报告/远端身份，常规开发不重新索取逐任务审批。所有测试、App、真实设备与Owner结果分层登记。
