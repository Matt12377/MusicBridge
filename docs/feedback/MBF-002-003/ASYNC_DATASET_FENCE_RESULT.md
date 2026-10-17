# 整理工作台异步工作库身份围栏修复

工作台 Main IPC 原来把 `assertDataset` 当作同步函数调用。正式接线若使用异步 `commandOutbox.context`，读取、取消或应用可能在库身份尚未核实前执行，结果也可能提前回送。本次让每个入口和回复前实际等待核对，并在等待前后复核可信页面、sender 存活与关闭状态；同步端口继续兼容。

## 身份与范围

- 工作树：`/Volumes/LifeWeave/Developer/CommandLine/tmp/mbf-002-003-7tvk_82n/workspace`。
- base：`e2d17ad1c4d11756db75b24d91d2422c7e1fecbb`；从该干净报告创建 `codex/mbf-003-workbench-async-scope`。
- 实现提交：`3175d272bdb64ff14869581927241032887b32e9`。
- 实现只修改 `apps/desktop/src/main/local-library-workbench/workbench-ipc.ts` 与 `apps/desktop/test/mbf-local-workbench-ipc.test.ts`。
- 本文件为直接报告提交的唯一改动；报告实际 SHA 在提交后的外置收据登记，不自引用尚未生成的 hash。
- 原 `codex/mbf-002-003-local-library` 及其 `c9398af` / `e2d17ad` 交付身份保留；完成后在干净状态切回该原分支。新修复分支保留，供 V3.9 在原模块集成后追加。
- 本地交付，没有 push；`origin` 仍为原只读 Tape 来源，没有新修复分支的远端 ref。下一补丁基线是本直接报告最终 HEAD，正式 App 基线仍由 V3.9 登记。

## 行为与新鲜验证

读取入口、普通 request 中的读取、`cancelRead`、写操作发起及写结果回送均使用 `await check`。同一 nonce、sender 与库身份的预算仍沿原实现；取消只影响读取，写操作仍使用独立信号。已发起应用关闭后按原命令查询回执，不生成新 command、不重放应用。

所有日志和收据在外置任务 `checks/`；包装器启动前核验 LifeWeave 为实际外置、挂载且可写。此次仅运行这一个 IPC 文件，不重复 214 项、600 轨或全包编译，不启动 App、Provider、真实曲库或音频。

| 标签 | 2026-10-11 UTC 起止 | 结果 |
| --- | --- | --- |
| `mbf-workbench-async-scope-red-v1` | 03:52:07.863648–03:52:08.834508 | 退出 1；28 项中 6 通过、22 失败，取消/跳过 0。有效断言捕获核对未完成即读取/写入/取消、旧结果提前回送及页面失效后仍回复。 |
| `mbf-workbench-async-scope-green-v1` | 03:52:38.206217–03:52:39.031809 | 退出 1；26 通过、2 失败。一个关闭后读取的子测试误期待通用失败，而原生命周期正确返回 `AbortError`；另一失败为该父测试的汇总。原日志保留。 |
| `mbf-workbench-async-scope-green-v2` | 03:53:04.520762–03:53:05.356663 | 修正该测试为精确取消错误，产品源码未再变化。退出 0；28/28，失败/取消/跳过 0。 |
| 完整实现差异与暂存检查 | 实现提交前 | `git diff --check` 与 `git diff --cached --check` 均退出 0，范围恰为获分配的两个路径。 |

28 是 Node TAP 报告计数，包含 14 个顶层测试与 14 个子测试，不代表 28 个 CoverDrop 功能。原 5 个测试全部保留；RED/首轮 GREEN 的测试字节与最终 GREEN 有该错误分类修正差异，未冒称同一测试 hash。

最终测试覆盖：异步前置与返回前拒绝、读取与写入在等待期间的可信页面失效/sender 销毁/关闭、取消读取的库核对、原应用物理 Promise 收口及按同一 command 查询。应用与重开回执使用受控端口，只证明 IPC 语义，不证明真实 SQLite writer、真实重启恢复或正式 App 功能。

三次检查均无超时，`sourceChanges=[]`，自有进程组物理退出。`ASYNC_SCOPE_SOURCE_DELIVERY.json` 核各收据日志 hash、两文件检查时 hash 与当前提交字节；原始日志、首次失败及完整 runner 收据均保留。

| 文件 | base SHA256 | 实现/最终检查 SHA256 |
| --- | --- | --- |
| `workbench-ipc.ts` | `b31956920bb88945ec76e298a231129094e8b76cbbfb01d1b154a6e4f84a9fc4` | `83ee01e528d64c8a6908450393a37078f163583814b2a38ad2fec2db0636531d` |
| `mbf-local-workbench-ipc.test.ts` | `bf428eea44ca908e08de16b8c3277e733944dfaa112461a22e4c694c43dcf6b5` | `6e6d4fa05c60f9cde085d22b75b478bacdbc9ee74a29303fa4ad891389cc16ac` |

## 集成与未完成项

V3.9 需在 `c9398af` 原模块集成后追加此实现，并实际接入可信 Main 的 `commandOutbox.context` 和当前 child 代际。此补丁不能让固定 Preload scope 自动刷新，不能替代 dataset 切换时原页面重载，也不补齐 Owner/RPC/Worker、nativeImage、原子 writer 或 CoverDrop 原生能力。

全包类型检查按调度进入共享验证窗口，本次未执行；正式页面、完整 CoverDrop、300k、真实本地播放与 Owner 验收仍未完成。三项反馈继续保持开放，未邀请 Owner 试用。
