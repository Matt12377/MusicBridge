# RUST-016之后的有限Node+Rust阶段准入范围

本文件与ADMISSION_DECISION仅记录已有Owner阶段交接及已核Gate，不是新增动作授权。原授权定位为docs/postrust/MBRS-000/AUTHORITY_SCOPE.md#owner-current-session-explicit-phase-handoff。RUST-015限定本地交付、MBRS-000结构基线及原C01/C06软件+实际CI条件分别核证；不是完整Rust退出，模式为EXPLICIT_PHASE_HANDOFF。

当ADMISSION_DECISION的实施/独立报告提交、实际CI原件和外置post-report HEAD/remote/clean收据全部对应时，G0只开放已有连续PostRust v1.2范围内的新隔离任务开发：每任务从本轮最终交付HEAD独立分支，按原18任务/156验收的硬依赖、唯一主责、复用、冻结范围和适用Gate推进。编号不改变原包依赖与证据层级，001缺真实环境仅阻live，002等产品软件接入仍依其G0条件。

共存权威保持：Node dataset-owner Worker为业务SQLite唯一writer，Main为outbox唯一writer；BridgeController唯一播放/队列/代际权威；SourceStore保持根/工作库现有权威。Rust仅可选收藏只读且默认OFF，2000/4MiB有界合同及完整Node回退保持。新本地领域与未来唯一writer接入需在对应任务冻结合同/迁移/回退，不能暗中双写或把加表当全Rust迁移。

本次已核基线问题只有R15-C01和R15-C06：四历史fragment保留原raw/indices/producer来源；Source08原拒绝不补造；标准high审计真实0，6既有moderate保留；verify/Rust/Electron/E2E真实source06自然attempt1成功。主控native探针不是远端stderr，后续报告修订仅当前入口及可解析身份；封存000/015原件、原14未完框/唯一主责保持。

G0软件身份不授予真实目录扫描、真实媒体读取/写入、Provider登录、真实Roon/Zone发声、DSP/音量、Core重启、LAN开放、正式安装/替换、main合并或发布。001软件工具默认offline，使用自建合成输入、现有Adapter和锁定官方薄SDK；真实部分需要具体样本/Zone/Core/地址与网络范围。源文件操作仍需Organizer精确计划/字段/Hash权限，旧录音GateB/P4/P5独立。

RUST-017～025、完整媒体包、平台签名/公证/其它平台、真实设备/音频与Owner最终使用反馈继续原主责，不由本准入关闭；不把所有未来优化扩成当前G0硬前置，也不将当前G0前置反向移交依赖G0的后继形成环。

若后续实际Gate出现新的安全/CI/唯一writer/生命周期fatal，按原政策停止对应受影响动作并保留原件，重新核准入；当前录入JSON、schema解析或客户端approval不能证明授权真实性，也不能替代真实软件/设备测量。
