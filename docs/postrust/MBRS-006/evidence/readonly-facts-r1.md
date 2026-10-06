# MBRS-006 正式只读 R1

结论：CHANGES_REQUIRED。发现1项实际P1，无另外实际P2。冻结01的52个产品路径首次逐项SHA256全部相符；身份与最终回读范围见 R1_IDENTITY.json。模型继承 gpt-6.1-sol/high，未派生、未改产品/测试/文档/Gate，未执行构建或测试。

## R1-P1-01：并发Owner fatal绕过在途shutdown收口

路径：packages/bridge-core/src/runtime.ts:1165–1167；相关 packages/bridge-core/src/utility-main.ts:627–632、754–758。

默认Node/Rust OFF时，先由用户或正常退出调用runtime.shutdown，shutdownStarted=true，并在Controller/Registry等待真实read、response或FD close。Owner此时error/exit会进入新onFatal，调用第二次runtime.shutdown().then(exit72,exit72)。第二次因if(shutdownStarted)return立即成功，不等待第一次cleanup，于是fatal执行process.exit(72)抢在实际quiet前。utility现有共享wrapper只在resolvedRustReadonlyCollection已配置时安装，默认Node路径无此保护。

这是冻结源码两处组合可直接确定的控制流；本轮未运行复现，不能把静态序列称作已执行故障测试。005 AssetLease.close:88–97本身会join responses/operations后close FD，问题是第二次shutdown没有等待这个flight。

最小修正：runtime.shutdown缓存并返回同一Promise/flight，每个调用都等待真正cleanup，保持原失败结果；Owner fatal依然沿该flight等待后退出。补有意义的阻塞FD/read quiet+重复shutdown/并发Owner fatal行为case，证明解除阻塞前没有resolve/exit、解除后全部调用共享最终结果。Root已核实并授权writer最小修复，正式R2审修正；本报告保留R1缺陷，不提前写闭合。

## 其余范围已核

- Worker/SAB：独立capture/revalidate/release operations闭集，Worker连续sequence、expectedDatasetId/epoch/boot，Client pending requestId+operation/epoch关联；真实SharedArrayBuffer16字节/version/state/reserved校验，facts/metadata64KiB预算；假ArrayBuffer/交叉绑定拒绝。Client/Worker/Domain close与fatal封票，utility与Rust显式透传；不进入Main/Renderer/公开dispatch或Rust快照。
- 三SQLite口：catalog.transaction与privateBatch在fault/audit之后最终COMMIT前同步检查，SourceStore revoke在提交前检查；全用原guarded同连接getter，不另开BEGIN/连接。COMMIT/ROLLBACK异常触发repository fatal锁死与seal，不把Busy吞成普通错误；只有明确回滚成功的Busy可最多两次事务外重核、每轮250ms，不重发SDK/队列。
- 依赖精度：capture比较track/asset/root/sourceRoot/relative/accepted observation。accepted→rejected而catalog revision未改仍撤票；select同asset的selection修订、file/location/root/sourceRoot变化会撤销相关绑定。metadata、edition、库存、另一asset绑定不进入全库stamp撤销；相同accepted新scan job的jobId/progress/checkpoint不被用作音频版本。
- 退休票据：current=false但refs>0仍留registry和提交比较；release先revoke、assertQuiet再delete，revalidate不复活；无关绑定不被退休claim一概阻挡。CAS claim无await，valid与refs同字，最后assertCurrent+真实SDK send受同一个guard。
- 正常收口主链：seal → controller.shutdown → registry.closeLocal → Owner.close；Controller旧attempt disposal等待renew、lease.close后才release ticket。005close先停止响应，再join实际operations/file.close后释放physical guard。未把未知远端stop、第三方隐藏修改或HTTP完成冒充会话/音频确认。上述正常单flight链正确，但受本轮P1并发调用缺陷影响。

## 已有证据与边界

只读复核FREEZE_01指向的11份日志，全部SHA与收据相符、exitCode=0；新Core29、contracts2、Desktop3；受影响Core313，Desktop57（含新3）。这些是writer已有执行证据，本代理未重跑。已有真实Worker/SQLite/SAB/扫描→FD链及COMMIT/ROLLBACK注入、claim-worker测试内容与声明吻合；新并发fatal竞态未被现有case覆盖。

Root另更新一个旧contracts compact-v1期待文件（原52之外），保持原产品冻结。本轮不审未冻结后续修复，也不把其hash混进R1 PASS。真实Roon/原20真值样本、LAN/NAS部署、音频/信号路径/数字输出/gapless与Owner验收均NOT_RUN或NOT_TESTED。005stat对不可观察原地修改的能力界限保留。

下一步是授权最小修复后的正式R2，无第三轮。
