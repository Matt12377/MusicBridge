# MBP-003A — 短状态处理与优先控制

基线 `a838a00486d113ea086e4edbe229cafe528a9bf7`；分支 `codex/mbp-003a-priority-controls`。Owner 已授权十一项计划连续实施，本步骤属于 MBP-003，A/B 都通过软件验收后才计一个完成任务。

把 BridgeController 长期占用 operationTail 的 metadata、URL、preflight、Smart 匹配、Roon Browse 与播放确认移出短状态处理。保留单一状态所有者：短 mailbox 负责校验、队列/容量、注册意图和当前状态发布；外部工作回到短处理时核对 generation、队列项对象、Zone、来源和捕获 token。Promise 任务句柄不能被 mailbox 的 Promise adoption 再度变成长锁。小批 append/insert 的元数据填充也不阻塞控制，保持5000容量及原插入顺序。

设备写入保持有序。Stop 立即撤销准备与旧确认等待，已派发 SDK 请求继续按实际回执或原有有界截止处理，abort 不替代 RPC 完成。原始所有者和停止未知 barrier 保留到真实确认，不让新播放、换 Zone 或 Smart fallback 越过未知停止。未派发取消不得迟到注册流或派发播放；旧成功、失败、finally 与 terminal 不得改写新所有者。pause/resume/seek/next/previous 保留顺序与原能力校验；volume 已有独立设备路径，本步骤检查它不进入慢准备链。

内部可取消接口采用 `RoonOperationOptions { signal?: AbortSignal; expectedZoneId?: string }`，不进入公开 DTO/IPC：RoonPlayRequest 增加 signal/onDispatch；播放确认请求增加 signal；RoonPort pause/resume/seek/control 接收可选 options。NativeRoonPlaybackPort.play 第四参数为同 options 加 onDispatch 与 onDispatchCompletion，其他控制可选 options。onDispatch 仅在第一个实际 SDK 写入前同步登记；onDispatchCompletion 保留实际 Browse 请求结束的独立 Promise，公开播放确认可先成功，但设备写链不能提前释放。取消后的停止使用独立 barrier 和捕获 Zone，不复用已取消 signal。hasPlaybackOwnership 包含准备、派发、活动及停止未知，用于 runtime 两处换 Zone 入口。Control API 原有外部 Roon seek 能力保留，通过 Controller 的同设备写链执行，不能绕过在途播放请求。

Root 独占 runtime.ts、任务/进度/报告、统一构建与 Gate。三个 `gpt-6.1-sol high` 子代理：Controller+controller.test.ts；Roon adapter/types/confirmed-track-action 与相关测试；runtime.test.ts 与独立只读审计。共享文件不交叉写，先确认内部接口，再并行；代理不构建共享 dist、不跑全仓库、不提交或 push。冻结身份后按原完整 verify、mock Electron与完整E2E范围验证；保留原跳过，不以缩范围验收。独立实现与报告提交，再推开发分支。

行为验证用受控 deferred 证明控制不等待 metadata/URL/preflight 与旧确认；验证派发前零写、派发后停止确认、旧结果/终止隔离、未知 Stop 重试、Smart 取消不回退、跨源切换顺序、队列变更与资源释放。Trace 区分应用处理与真实 Roon 等待，不用合成毫秒冒充实机指标。

本步骤不实现真分页、Core 播放上下文、缓存新策略、小进度事件或虚拟网格，分别按后续 MBP-004/003B/005/006/007推进。仅合成 Provider/Roon/Fake与隔离库，不连接真实账号、音响、SSH或录音设备；不修改 Gate B、合并main、替换正式App或发布。
