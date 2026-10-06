# MBRS-006 · 现有播放器接入本地Audio Input

版本：1.2｜状态：有限软件候选已冻结，原实机验收另列｜范围：CORE。11条原验收文字与kind保持；本轮有限实施边界见下方。

## 目标

同一播放协调器接入具体本地版本，并保持原网易云和原生Roon入口。

## 依赖与执行边界

硬依赖：MBRS-005、MBRS-002

任务依赖表示验收条件，不阻止提前编写隔离合同/mock；产品接入必须有G0记录。编号不是提交顺序。

先核对 [实际代码复用表](../docs/postrust/MBRS-000/REUSE_MAP_RESOLVED.md)、[Rust待办映射](../docs/postrust/MBRS-000/RUST_TO_MBRS_RESOLVED.json)、[本地对象合同](MBRS-002_LOCAL_SOURCE_CONTRACTS.md)。文件名是当前定位线索；迁移后使用等价后继实现，不恢复旧架构。

## 实施步骤

1. 复用BridgeController/RoonAdapter后继实现，LocalFileAsset走统一SourceResolver；本包名称不要求创建同名类。

2. 根据001实证映射实际有限track/metadata/control，不把本包DTO直接当SDK参数；能力许可字段不能代替真实pause/seek。

3. 准备、提交、待观察、Playing、未知、外部接管分开；用本次attempt/session/文件请求关联到所选asset revision，不能只比较标题。

4. 旧A在B后返回不得覆盖B或释放B资源；提交后超时先reconcile，不盲重放，不声称已经发出的命令可被本地撤回。

5. 本地来源身份进入歌词/进度/事件时保持命名空间，不经网易云ID强转；当前Zone无能力时明确失败，不改系统输出。

6. 外部接管/Zone分组与断连后暂停后续提交，不全局stop别人；窗口关闭和真正core退出按既有策略分开。

7. 完成20真值样本，包括未入库、同名不同版、移动找回、增强关闭；受测格式和Core build单列。

## 验收

- [ ] **MBRS-AT-006-01 / live_roon / 1.1**：20样本含未入库和同名不同版通过本地ID→文件lease→AudioInput真正播放。

- [ ] **MBRS-AT-006-02 / integration / 1.1**：无映射表/内部侧车/封面网络仍可新点播，代码依赖图与测试证明。

- [ ] **MBRS-AT-006-03 / unit / 1.1**：准备/提交/等待/Playing/未知/失败分开；HTTP完成不触发下一首。

- [ ] **MBRS-AT-006-04 / live_roon / 1.1**：pause/resume/seek与状态/歌词时间正确，显示许可字段不替代实际能力。

- [ ] **MBRS-AT-006-05 / fault / 1.1**：提交后回报丢失先核对，无重复开始或重复队列副作用。

- [ ] **MBRS-AT-006-06 / fault / 1.1**：A→B、旧epoch、旧session终态不覆盖B或清理B资源；已发送A的取消边界明确。

- [ ] **MBRS-AT-006-07 / live_roon / 1.1**：原生客户端接管或Zone移除后MB不抢回、不停止外部正在播放。

- [ ] **MBRS-AT-006-08 / integration / 1.1**：关闭增强无影响；真正退出媒体进程可能影响流且按提示/策略处理。

- [ ] **MBRS-AT-006-09 / integration / 1.1**：既有网易云和Roon原生入口不回退，也不被自动当本地失败fallback。

- [ ] **MBRS-AT-006-10 / integration / 1.2**：同一BridgeController/RoonAdapter增量接入本地来源；不重写既有网易云/原生播放控制器。

- [ ] **MBRS-AT-006-11 / unit / 1.2**：本地ID命名空间不会被网易云数字ID转换或smart匹配接管，来源在事件与歌词身份中一致。

## 交付物

- `本地播放用例`

- `原coordinator状态增量`

- `20样本证据`

- `API_BEHAVIOR_MAPPING.md`

## 禁止

禁止第二套播放器或状态权威；禁止local故障隐式转云/native/internal/M3U。

## 阻断处理

实机缺口记PARTIAL/BLOCKED_ENV，继续本地读库和离线保护测试。

## 证据与回退

按 [本期执行范围](../docs/postrust/MBRS-006/EXECUTION_SCOPE.json)交代码范围、确切提交、命令/退出码、失败保留、证据层级及未完成项。产品测试不是包结构校验；纯设计/旧报告/上游支持不能替代新实机证据。

使用 [本期验证与状态映射](../docs/postrust/MBRS-006/API_BEHAVIOR_MAPPING.md)控制验证成本；按 [基线授权边界](../docs/postrust/MBRS-000/AUTHORITY_SCOPE.md)区分代码、数据库、文件及运行服务的恢复。共享交付只维护一个主实施任务，不复制实现或完成状态。

## 2026-10-06 本轮执行范围

从005最终独立报告 `cce8594f4b6e9872afd576bb1b032f526c93af72` 建立 `codex/mbrs-006-local-audio-input`。Owner已授权连续到017、每独立任务完成后更新待办并push，按风险选择测试。前任务终态见 [005交付收据](../docs/postrust/MBRS-006/PREVIOUS_DELIVERY_RECEIPT.json)。

唯一产品writer增量接原Controller/Adapter、唯一Owner私有事实票据与同步提交fence；主控负责Gate/报告，两个调查者只读。所有await和实际SDK发送前核当前authority；提交未知不重播，旧A不清B，无关asset/库存/录音不被全库stamp断播。保留005固定FD/物理guard与原网易云/native入口，默认Rust可选OFF。

公开local入口与compact身份按现有合同演进，原legacy不支持local时明确拒绝。raw Roon session、路径、URL secret、FD、SAB只在可信私有端口；实际consumer不得把local当网易云收藏或数字ID最近重播。真正退出及Owner故障先封派发、join自有IO/FD，再关闭/退出；远端未知与本地资源quiet分别记录。

原01/04/07的live_roon kind和20真实样本仍单列未验；软件测试不能代签。当前未授权真实账号/Roon/发声、LAN部署、真实源写、main合并、安装和发布；不重跑003规模，不把CUE/非null片段冒充整文件。API映射记录已接线候选与有限测试，20样本均保留NOT_TESTED；最终Gate与CI退出码由独立报告记录，本文件不代签原实机验收。
