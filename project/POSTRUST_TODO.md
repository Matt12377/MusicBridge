# PostRust v1.2 开发与验收台账

更新：2026-10-04。真实 base 为 RUST-015 final `044e6b24edf81b64030d4c96741082670532971c`。当前 Node 控制面与唯一业务库作者保持；Rust 可选收藏只读默认 OFF，完整迁移未完成。当前有限Node+Rust软件阶段 G0 **ADMITTED**（EXPLICIT_PHASE_HANDOFF）；真实动作/完整迁移/Owner边界独立。

机器入口：`project/POSTRUST_PLAN.json` 保存18任务和156条原验收（126条v1.1保留、30条v1.2衔接），每条分别登记软件、App、live与Owner。包PASS、计划批准、软件通过、App操作、实机与最终反馈互不推导。

- [x] MBRS-000 基线交付：12复用 / 14原框映射 / 18任务156验收 / 有限ADR已落实，13结构正负例、Git来源Gate、control-plane与boundaries均退出0，首轮独审无确认P1/P2。实现与报告分开提交解析，000报告快照G0为NOT_ADMITTED，当前准入另见R16新记录；AT-000-02/03的原记录保持PARTIAL。
- [x] RUST-016-ci-security-portability：限定软件/实际CI Gate通过；base000 final `dd2a7e5`，实现最终 `043a5635`。原Rust30、Electron12、E2E104+4原skip、远端4workflow/6job、48准备/82加密与原high审计均通过；6moderate、完整迁移/live/平台/Owner另保留。报告提交/远端身份与有限G0新记录随后解析；见 `reports/RUST-016_CI_SECURITY_PORTABILITY.md`。
- [ ] 其它Rust剩余职责：原14框逐行在 `docs/postrust/MBRS-000/RUST_TO_MBRS_RESOLVED.json`，拟任务登记仅定位主责，未完成、不自动获准生产执行。原Rust路线、平台 / live / Owner分别保留。
- [x] MBRS-001 隔离软件阶段：实现 `c0ad30a9` 已push；32新行为+118原定点回归/noEmit/offline全通过，9原AT分别3软件PASS/2PARTIAL/4liveBLOCKED_ENV。整体PARTIAL，真实Roon/格式/最终Owner仍待；源CI4workflow/6job success；195MB Electron补充artifact仍待、6moderate与原skip保留。报告与实际CI独立交付见 `reports/MBRS-001_ISOLATED_OFFLINE_POC.md`。
- [ ] MBRS-002：本地对象、音源合同与存储增量，NOT_STARTED，产品依赖000与真实G0；不迁旧writer。
- [ ] MBRS-003/004：持久增量扫描与CoverDrop纯规则，NOT_STARTED；真实扫描另核目录许可，纯规则可隔离准备。
- [ ] MBRS-005/006：固定FD lease / Gateway / 统一资源协调与原播放器增量，NOT_STARTED；原SSRF与唯一coordinator保留。
- [ ] MBRS-007/008：队列控制 / 无缝及音质格式证据，NOT_STARTED；字节Hash、Roon处理、设备数据和边界分别验收。
- [ ] MBRS-009/010/011：正式本地UI / 封面 / 整理计划，NOT_STARTED；保留原布局 / 控件 / 库存 / 照片与数据。
- [ ] MBRS-014：旧收藏 / 录音 / Frozen来源保护，NOT_STARTED；为012源写硬前置。
- [ ] MBRS-012/013：受限源写与改名 / 移动 / 恢复，NOT_STARTED；默认OFF、逐计划授权，备份 / journal / 回读 / 锁与恢复缺一不执行。
- [ ] MBRS-015：可选内部协议只读增强，NOT_STARTED；关闭或故障不阻断新点播，不抵扣RUST-015。
- [ ] MBRS-016/017：整体验收与最终包 / 回退，NOT_STARTED；真实CI、安全、全媒体、平台签名、安装和Owner分别取证。

依赖以机器表为准，不按编号强行执行：014在012前；017依赖016；可选015不是CORE主线前置。任务完成后相同共享实现由唯一主任务存证，其它任务引用，不复制PASS。

当前没有新产品 App/live/Owner PASS；000八条为基线/规则记录及结构PASS，AT-000-02/03保持PARTIAL。旧 Source15 4051软件通过与七候选包 / 两普通CUA仅复用适用收藏容量范围；新鲜015远端verify/Electron失败、Rust零job和high依赖阻塞记录在 `REGRESSION_LEDGER.json`。Owner只负责最终成品使用反馈，中间验证由代理承担，不把机器结果代签为接受。

RUST-016报告已实际独立交付并核remote/clean/不变输入；有限G0新记录为 `docs/postrust/RUST-016/ADMISSION_DECISION.json`（EXPLICIT_PHASE_HANDOFF/ADMITTED），仅Node+Rust软件阶段。000/015的NOT_ADMITTED是封存快照；新记录不改其原件，不关闭完整迁移/live/平台/Owner。最终第四证据round2由提交后外置原件解析。
