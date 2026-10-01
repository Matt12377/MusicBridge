# MBR-002：录音回执恢复与资源收尾

基线 `f672c9f1ef4c8faf0af86a8758476cb4def50a9f`；开发分支 `codex/mbr-002-recovery-lifecycle`。首个实现 `8421ea1d8fe09da22e6246189e9a2f651abb81af`；补修实现 `200da1903578bff1342e405d663e04391e94b90f`。报告提交由包含本报告的独立提交解析。本地标准软件 Gate 已通过，真实设备与发布验收仍单独保留。

录音命令结果不明时，Renderer 可用原 commandId、完整请求和 Dataset 只读查询 pending/unknown/accepted；查询不会执行原动作、生成新命令或进入 outbox。accepted 携带不可变原回执及最新 Attempt，两者用途分开。终态仍未静止时保留离页/历史/规划锁，已受理 Stop 保留原请求以便用户手动重试失败关闭。Begin 在途或未知时锁历史，迟到身份只能由对应权威回执绑定。

Core 驱动 cleanup 只保留局部证明，真实 handle.close 与输入租期释放完成后才补充同一 Attempt/side/run 的软件静止。无 handle 的启动拒绝须原 pendingStart 实际拒绝、精确 cutoff/cleanup 和有效输入释放三者齐全；外层超时不替代实际 settle。失败 Attempt/barrier 不升级为成功，不制造 ACK、EOF、排空或物理停止。只读查询不重试关闭，明确手动 Stop 可重试已经失败的 close，在途 close 不并发重入。

SSH 保留子进程退出所有权；停止/探测期限取消实际探测，TERM/KILL 后退出未确认则保留失败所有权，阻断新连接。Control API 仍仅 loopback，校验 Host/Origin 与 JSON 来源，保留无 Origin 的本机工具调用；请求体、读取期限、TCP 关闭和连接数量有预算。已经派发的写入不会因连接关闭自动重放或被宣称撤销。

## 首轮失败与归因

固定 `8421ea1` 的原完整 verify 退出1：三层类型检查通过，Contracts 224通过；Core 1634通过、7失败、原2跳过，Desktop 测试与生产构建未到达。827源码文件在运行前后 SHA256 `dba73798cbb0233bc518521d592e4574d4cdf390eb87fee3336fc5ca4938b013` 一致。

| 失败测试 | 基线/首轮表现 | 原因与修正 |
| --- | --- | --- |
| Formal 首帧前 expired / selection-generation / second-verify（三项） | 基线 Node22 全量通过；8421 三项失败 | 生产回归：忽略局部 cleanup 后没有 handle，关闭证明丢失。原断言未改；仅实际 start 拒绝、精确证明及有效输入释放后持久 quiet。 |
| 冷启 pre-spawn 无 sidecar 不误锁（一项） | 基线 Node22 全量通过；8421失败 | 同一生产根因，保留 failed Attempt 与 failed barrier，同时正确解除资源锁；原断言未改。 |
| 无静止证明/槽占用拒绝处置（一项） | 基线通过；8421失败 | 旧夹具只省略 driver cleanup，却仍完成真实 close+lease，新实现正确补 quiet。Begin 前以局部旧 store 构造历史缺证明数据；不改已写事实，保留 ACK 不替代 cleanup、拒绝处置、数据库不变和槽占用保护。正常生产完成分支另断言 quiet。 |
| 主动取消冷启保留记录（一项） | 8421失败 | 将最新 Attempt 与不可变原 Stop 回执混比。等待真实软件静止，分别检查新 revision 的冷启一致与旧回执原样重放；保持无成功档案、无虚构 ACK/排空/物理确认。 |
| 取消后显式处置、新 Plan 与新谱系（一项） | 8421失败 | 处置使用了原 Stop 回执旧 revision。改用最新 revision，并增加旧 revision 必须 CONFLICT、状态和许可不变；原未知实体/旧 Plan 禁止重录与新旧谱系冷启保护保留。 |

基线证据来自上一固定任务已经保留的同 Node22 全量日志，不包装成本轮新独立复跑。补修定向结果：Core 五文件141/141、历史夹具14/14、主流程3/3，退出均0；最终验收仍以完整范围重跑为准。

## 独立审计与 Electron 失败边界

独立审计复现并修正两项问题：Renderer 丢失已受理 Stop 身份，导致不能重试失败 close；driver 局部 cleanup 早于 Core 输入释放，导致页面提前放行。对应新增行为测试保留未知回执、手动恢复、离页/历史锁和资源占用保护。Renderer 四文件最终92/92、直接类型检查退出0。

旧 Renderer 测试同步调整的合同依据：历史列表中的同 Plan 记录不能替代原 Begin 的权威身份，因此发现/选择历史的旧捷径改为原请求只读 accepted，新增 Begin 在途/未知拒切历史与迟到真实身份覆盖；旧“Stop 终态即离页/切 Plan”改为先保持锁，再读取更高 revision 的软件静止后放行；等待 B 面夹具补齐 A 面真实静止事实。保留原 commandId 重试、未知不能交叉 Begin、Stop 优先于迟到人工确认、详情失败仍可安全停止、旧异步结果不覆盖新状态、SFC 父级离页同步和确认失效保护。此次不以“新实现不满足旧断言”作为唯一修改理由。

MBP-002 固定报告 `f672c9f` 的远端后续事实另列：verify 作业通过，security 通过；verify 工作流因独立 dependency-audit 失败（11 moderate / 7 high）。Electron E2E run `36788739591` 为103通过、4原条件跳过、1失败，v5 Core crash marker未达。原始日志和产物已保存，但产物 stdout/stderr 为空，无法确认该次失败的唯一根因。

合成内存复现证实测试工具的两处竞态：固定1秒采样可能早于第二次启动实际终态；Playwright launch后才监听 stdout 可能丢早到标记。本轮仅修正合成 crash Gate：等待 failed 且仅一次重启；测试进程从 spawn 开始收集标记，并要求实际 close、exit0、无 signal。保留双崩溃及只重启一次断言，不修改生产重启策略。相关 startup unit 27/27退出0；本次实际 mock Electron 四项和原完整 E2E 均退出0，v5 含双崩溃的用例通过；不将本地通过冒充远端已通过。

## 验证结果

完整 verify 退出0：Contracts 224/224、Core 1648通过/原2条件跳过、Desktop 975/975，三层严格类型与三包生产构建、沙盒 Preload 边界均通过。mock Electron 启动/恢复原四项4/4，退出0；原完整 E2E 104通过、原4条件跳过、零失败/零flaky，共108项，退出0。control-plane、boundaries、cycles（348文件）和diff-check均退出0。完整Gate前后源码身份一致。日志、退出码、各冻结清单及 SHA256 见 `reports/MBR-002_EVIDENCE.json`。最终源码827文件补修 SHA256 `abf3eca54266d7a9a8491be258425c7ecdecdde2fcbe83566cc8f2dfaf8f3529`，固定实现 `200da19`。

## 保留边界与下一任务

没有连接真实 Provider、账号、Roon、设备、SSH，也未实录、认证 Gate B、合并 main、替换本机 App 或发布。全部录音与 SSH 故障为 Fake/合成资源；Control 测试为隔离 loopback。新的 Electron 测试均显式 mock 钥匙串，不替代 Owner 真实凭据验收。

无证明的 start 拒绝继续 fail closed；收尾已消费拒绝后才到达的证明不会自动解锁，本轮不承诺该恢复能力。SSH 探测可取消，但任意 onTunnelBound 用户回调若一直不返回仍可占用串行生命周期操作，本轮没有承诺所有外部回调的绝对关闭期限。

Core 早期局部命令曾由 login shell 解析到 Node25.6.1，其日志与最终绝对 Node22.23.2 结果分开保留，不冒充 Node22。一次早期 Root RED 等待未结束由中断终止，退出130；另一次 agent RED 子进程 SIGTERM 后 runner 退出1。失败和中断不记为通过。其后实际结束的 Node22 定向与最终全量证据单独记录。

Axios 依赖审计红灯进入 MBP-009 收口，保留7 high/11 moderate原记录，不使用忽略项隐藏。下一开发分支从本任务最终报告 HEAD 创建，继续 MBP-003A 的短状态处理与优先控制；MBP-003 A/B 全部软件 Gate 完成才计一个任务。
