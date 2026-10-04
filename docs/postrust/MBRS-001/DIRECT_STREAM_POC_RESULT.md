# MBRS-001 隔离原文件直送 POC 结果

任务整体 PARTIAL；隔离软件阶段已通过，真实 Roon 及 Owner 验收未完成。基线 `6f1cc0edcb0c59b78a2dfd0828b8e6196e816e47`，实现 `c0ad30a9df471e772a0c9e9268bd7b0c41cb8763`，分支 `codex/mbrs-001-isolated-offline-poc`。

## 实际行为

固定只读 FD 服务 runner 自建的两份同名、不同字节小 WAV。实际 loopback 全 GET、闭/开/suffix Range、强 If-Range、HEAD 零 body、非法 Range 与撤销在途响应均有行为测试。HTTP 完成或暂停仍保留租约，撤销等待 request ref 归零再实际关闭 FD；关闭后用 stat 的 EBADF 独立探针验证。原 Adapter 和锁定官方 AudioInput 薄 SDK 被复用，Fake moo 只给实际发送的请求分配 callback，远端关闭由独立 ledger 观察，不由本地计数推断。

实跑末次 Gate：nested noEmit 退出0，新增32/32、原 Adapter/Gateway/Registry 118/118、一次 offline reproduction 退出0，失败/跳过/取消/todo均0。两份样本各300B且SHA不同；Playing/Paused/Time 是人工 Fake 观察，均不证明 Roon 解码或发声。最终 openFD/ref/token/timer/Fake callback/observer/subscription均0，closedFD=2、实际 EBADF探针true。

完整命令：`node scripts/ci/verify-mbrs001-offline.mjs --output-root=<全新且经共享策略准入的外置任务目录或真正 hosted 专用目录>`。工具只接受这一参数；本机要求真实 LifeWeave 外置卷、tmp/cache准入，真实 GitHub hosted 要求两个官方标记及专用目录。新run0700、结果/log0600/wx；每stage独立POSIX进程组，180秒/4MiB边界只清自有组。锁定六项TAP summary与32/118数量，缺字段、重复、遗漏、skip/todo均不能通过。落盘日志只有allowlist状态/计数；内存原stdout/stderr按实际到达字节散列，不声称保存了任意诊断原文。Git HEAD加28声明直接输入在结束复核；此清单不冒传递依赖完整闭集。

## 九项原验收

| 原ID | 原层级 | 当前结论 | 适用证据与缺口 |
|---|---|---|---|
| MBRS-AT-001-01 | live_roon | BLOCKED_ENV | 无真实未监控/未入库文件许可与点播记录 |
| MBRS-AT-001-02 | integration | PASS，合成原文件字节范围 | 实际FD/GET/Range/HEAD；非系统音频回采、非Roon出声 |
| MBRS-AT-001-03 | live_roon | BLOCKED_ENV | 合成同名源/attempt关联已测，真实样本未测 |
| MBRS-AT-001-04 | live_roon | BLOCKED_ENV | 仅loopback，未证明异机Core可达拓扑 |
| MBRS-AT-001-05 | live_roon | BLOCKED_ENV | Fake pause/resume新Zone revision、seek1234ms→1.234s、track/channel payload已测，设备效果未测 |
| MBRS-AT-001-06 | integration | PARTIAL | 本地固定FD和旧/新回调归属已测；原SessionEnded-only terminal缺口、cancel/timeout远端UNCONFIRMED保留 |
| MBRS-AT-001-07 | integration | PARTIAL | 无映射/禁止端口的合成新提交重复已测，真实重复点播未测 |
| MBRS-AT-001-08 | integration | PASS，隔离软件范围 | 自建合成数据/敏感值不落Git；生产src/锁/原WIP保护单独核验 |
| MBRS-AT-001-09 | integration | PASS，隔离软件范围 | 原Adapter/官方薄SDK复用，独立工具且无第二产品coordinator/队列 |

原ID、kind和requirement保留，App/live/Owner均未运行。finite Node+Rust软件G0沿R16新记录ADMITTED；旧000 NOT_ADMITTED仍是封存快照，不改原件，不推导完整Rust迁移或真实源写许可。默认Node、可选Rust收藏只读OFF、library_write_enabled OFF。

## 审查、失败和回退

两轮正式代码审查已结束。首轮四根因修复：TS7022、reporter、完整计数、工具观察owner；第二轮剩余同ownership边界由主控在其后补旧active epoch/context首写前门禁，并增加真实行为RED/GREEN，不冒第三独立审查。先类型检查0再复现多发旧stop：实际2/期望1；修后完整32/118通过。普通stop确认不必通知Adapter terminal，工具调用方完成本地dispose；SessionEnded-only清理由HARNESS origin单列，不能假补生产terminal。

原Range RED（3控制PASS+代表200!=206失败）、首完整TS7022失败、root误依赖路径准备失败、Fake误拒真实zone_id对象导致29/31及定点诊断、先31通过与末32通过均保留。中间绿色只覆盖当时冻结，最终 source05与实现Gitblob已核一致。原生产src、Provider/lock、既有tests/Gates、Rust迁移树、音乐目录、用户DB和安装App未改。回退可撤回隔离工具与CI step；不涉及用户数据schema或文件迁移，不自动清理其它树。

正式结果报告为 `reports/MBRS-001_ISOLATED_OFFLINE_POC.md` 与 `reports/MBRS-001_EVIDENCE.json`，报告提交通过 `git log -1 --format=%H -- reports/MBRS-001_ISOLATED_OFFLINE_POC.md` 解析。下一002从最终报告HEAD接续，真实carryover继续保留。

报告结构补记：旧000校验器在当前台账运行为12/13、退出1，仅G0_DECISION_MISMATCH；该差异在001 base6f1与实现c0均已存在。R16新准入与000封存决定分别保留，不改历史比较器或将该轮写成PASS；本次台账增量身份单独校验。

实现提交远端4workflow/6job均自然attempt1 success，新增offline artifact的28输入逐一匹配实现Gitblob，32/118/POC全部通过。综合verify4142PASS+2原skip，准备48和历史片段4，Electron12、E2E104+4原skip；实际依赖6moderate。已核3份artifact digest；Electron195MB补充ZIP仍下载中，Main内容未验，不将该补充写成完成。报告HEAD的CI另采，全部仍仅合成软件证据。
