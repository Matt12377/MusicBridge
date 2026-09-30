# MBR-002 — 录音未知回执与资源收尾恢复

基线 f672c9f1ef4c8faf0af86a8758476cb4def50a9f；分支 codex/mbr-002-recovery-lifecycle。Owner 已授权完整计划连续实施；保留技术栈与所有用户资料。

按原录音 commandId、完整请求指纹和窗口 Dataset 只读核对回执；accepted/pending/unknown 区分持久受理与未决/缺席，不把缺席认作未受理，不产生新命令或自动重放。终态不替代 engineStoppedSubmitting 与 cleanupQuiescent；精确 Attempt/run 未静止时继续观察、保留安全停止恢复与离页锁。Begin 在途及未知时锁历史选择，迟到权威身份仍可停止。原物理停止确认独立保留，不能替代软件关闭证明。

SSH 健康探测必须拥有子进程，在超时/停止时取消并核对实际退出；未知退出保留失败所有权，不再开始另一组进程。Control API 仅 loopback，核 Host/Origin 与写入 JSON 来源，保留无 Origin 的本机工具调用；请求体、慢读取及关闭有界，不把已经派发的写入超时伪称失败。

Root 持有 Contracts/Main/Preload/utility IPC 与 E2E；按 Owner 最新偏好，三个 gpt-6.1-sol high 子代理分别独占 Core Attempt 四文件、Renderer 录音恢复七文件和 SSH/Control 四文件，完成后交换只读审计。同目录不交叉写，构建与全量 Gate 串行，冻结 SHA 后按原完整范围验证，独立实现与报告提交再 push 开发分支。

远端 MBP-002 E2E 失败后保存日志与产物，限定本轮补齐合成崩溃 Gate 的执行收尾：等待真实 failed 且仅一次重启，从 spawn 起收集标记并要求进程实际 close/exit 0。不改生产重启策略，不将内存竞态复现包装成该次 CI 失败的唯一归因。

全部故障测试使用合成数据、Fake driver/SSH 或隔离 loopback，不连接真实 Provider/Roon、设备录音或真实 SSH，不认证 Gate B；main、正式 App 与发布不在范围。
