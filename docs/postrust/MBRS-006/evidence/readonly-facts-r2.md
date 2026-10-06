# MBRS-006 最后正式只读 R2

结论：PASS。本轮范围内剩余实际 P1/P2 为 0；R1 shutdown P1 已闭合。此结论是冻结产品静态复核与已有验证证据核验，不是重新运行测试、Root Gate 或真实播放验收。无第三轮。

## 身份与范围

- 工作树：/Volumes/LifeWeave/Developer/CommandLine/worktrees/musicbridge-mbrs-006-local-audio-input
- 分支：codex/mbrs-006-local-audio-input；base 与 HEAD 均为 cce8594f4b6e9872afd576bb1b032f526c93af72。
- FREEZE_03.json SHA-256：40eb968e389e1667e16f5b78c330ce170803095c37e09fa1a4beb6de37dd8b45；54 个路径初次及收尾均 54/54 匹配，未读到产品漂移。
- FREEZE02→03：48 个旧路径哈希不变、5 个旧路径改变、1 个新增 runtime-shutdown.test.ts，无删除。与 R1 原 52 路径相比 47 路径完全不变；新增的旧 contracts 兼容期待补充与 runtime-shutdown 测试单独纳入当前 54 路径。
- 改变范围为 controller、adapter、runtime 三个产品文件和 Core 聚合/controller 测试；新增 runtime-shutdown 测试。Owner 私有 transport/Worker、SAB fence/tickets、resolver、三个 SQL 提交口、Rust 装饰透传及 utility-main 均保持 R1 哈希。Root Gate/台账/工作流不属于 writer 产品冻结，本审查未修改或重放。

## R1 修复复核

1. 共享 shutdown flight（runtime.ts:1166–1182）：首次调用同步设置 shutdownStarted，然后在任何关闭回调前登记 Promise；同步重入的 Owner fatal 以及后续重复调用直接拿同一个 Promise。microtask 执行原 cleanup，finally 只负责 runtime 状态/诊断，不吞失败；Owner.close 拒绝在完整 cleanup 后传播，既有拒绝不因重复调用变成成功。
2. 同步封派发与实际 quiet：runtime.ts:1180 立即关闭扫描准入并撤 Owner SAB；dataset-owner-client.ts:39 的生产 seal 为有限同步 revoke。cleanup runtime.ts:1020 起先 Controller shutdown，再 registry.closeLocal，再 Owner close。Controller:1568 起撤旧 context、递增 commandEpoch、abort owner，在 finally 等待 localTasks 和池 close。005 固定 FD 的 local-file-source.ts:87–98 先停止响应，等待全部 operations，再 file.close，最后释放 slot。utility-main.ts:627–632 的正常/Owner fatal 都 await 该 runtime flight 后才进 exit72。原默认 Node 未加 Rust wrapper 的路径现已由 runtime 本身覆盖。
3. 旧 native context 与 mailbox：controller.ts:684 的 PLAY_NOW 受理同步 cancelQueueContext，释放旧 lease；APPEND/NEXT 仅 capture 在原 mailbox 内，完整物化和最终插入在 mailbox 外沿既有 queueEditTail/contextTask 接点执行。controller.ts:950–987 每次相关 await 后及最终 commit 都复核 intent、target 和 fence；未发现 await 自身 mailbox 的环。
4. 有限终态：controller.ts:489–492、789–792、2338 等本 attempt MediaError→FAILED/ROON_MEDIA_ERROR，StoppedUser/主动 Stop→CANCELLED/NONE，自然 SessionEnded→ENDED。准备阶段物理观察不匹配为 FAILED；已派发后缺回报仍 SUBMISSION_UNKNOWN，旧 A 回报仍不能覆盖 B，新非 local startItem:1900 清除旧 local 叶。
5. 目标 ABA：adapter.ts:706–710 捕获 connectionEpoch 与 localTargetEpoch；selected zone 移除、输出分组与实际选择变化单调递增 epoch（1529、1589、1613），恢复相同 fingerprint 不复活旧资格。无关 Zone/state/seek 正例仍可派发，没有改成全局库存或 Zone stamp。

## 已有证据核验

- 有效 shutdown RED04：1 test/0 pass/1 fail、exit1；失败具体为受控阻塞真实已打开 FD 的 read 尚未 quiet 时已观察 exit72，属于目标缺陷，不是 fixture 准备失败。RED01–03 不计为此缺陷证据。
- terminal/target RED：18 tests、12 pass/6 fail，覆盖 4 个终态/prepare 与 2 个目标 ABA；context RED：3 tests/3 fail，覆盖同步旧 lease 撤销及 APPEND/NEXT 原分页未完成不得提前承诺。三个有效 RED 的 result.json、Git HEAD 和日志 digest 均已核对。它们是修复前历史日志；没有独立 RED 源码冻结，不能把修复前日志说成当前 54 文件运行结果。
- 当前 frozen 聚合源码明确导入 runtime-shutdown 两变体。最终 Core 41/41、contracts 2/2、Desktop 3/3，合计 46 个新增测试。Core 41/41 的日志含最终全部 12 个修复行为案例；正常与 Owner.close 拒绝两变体使用 production runtime/default Node utility、实际 Owner fatal handler、实际 local source pool/已打开 FD 与 readSlice，SDK/网络启动/Owner 端点/process.exit 受控。拒绝变体同时断言 quiet 前无 exit、quiet 后出口、FD CLOSED/activeIo=0 及重复 shutdown 仍拒绝。
- 6 条 r1Checks 的 result.json 与日志 SHA 全部吻合，exit0：Core41/41、受影响旧128/128、最终 runtime86/86、fresh Core build/test types/cycles。contracts2、Desktop3 的源码未漂移，继承日志 digest 重新核对一致；无 skipped/cancelled。没有在本审查运行任何构建或测试。详细命令/哈希/TAP 在 R2_IDENTITY.json。
- 继承 R1 已核事实：真实 Worker/SAB 私有 envelope 未转 JSON、Node Owner/Rust 透传保持；三个 SQLite COMMIT 口与 rollback/fatal 状态、扫描 accepted 资格变化且修订不变的事实依赖、相关 dispatch refs 的退休票据，以及事务外有限 Busy quiet 协调未漂移。未引入事务内 await/Atomics.wait 或无关库存/另一 asset 的全局断播。

## 结论边界与元数据观察

真实 Roon/20 样本/live01/live04/live07、NAS/LAN、实际音频/听感/Owner 验收仍 NOT_RUN；HTTP bytes/signal path/digital output/gapless 四轴仍 NOT_TESTED。当前合成实文件/SQLite/Worker/实际 FD 行为不升级为这些真实层证据。隐蔽原地修改的平台观察边界沿用原合同。

非阻塞描述观察：FREEZE03 继承 unchangedPriorHashes:52，该值不是本轮与 FREEZE02 的实际逐文件不变数量；本报告只采用 54 个实际路径哈希与 48/5/1 的比较结果，不以该描述字段推断 PASS。无产品缺陷、无新 Gate/框架要求。
