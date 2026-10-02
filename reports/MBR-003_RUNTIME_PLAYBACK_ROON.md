# MBR-003 运行问题修复结果

基线 `e2eac26eecb835224f2a00477552e1f0f727c5fb`；实现 `cc742c0fc7ef7981be2de23c7046098dfa7418b4`；分支 `codex/fix-playback-roon-runtime`。报告提交以最后修改本文件的提交解析，下一分支基线为本轮最终报告 HEAD。

Owner 的最新日志包含 `playback:replace-queue / INTERNAL_ERROR` 和 `library:read / CANCELLED`。较早运行的 Core exited / NOT_READY 与最新失败分开记录，不把旧进程退出解释为本次全部故障。

## 确认的缺陷及修复

1. 集合首播在途时，Renderer 直接丢弃后续点击。现接受新选择，保留操作代际隔离，迟到回执、旧错误及旧后台分页不能覆盖新选择。
2. Core 中尚未开始的旧 replaceQueue 仍会执行，可能先播放中间曲或被其慢准备阻塞。现替换命令只派发最新意图；已派发播放仍需真实 Stop / 清理，停止未知时保留所有权并拒绝新播放。未修改 Stop、Zone 的独立屏障与连续 Next 语义。
3. Browse / Image SDK 回调的异步上下文可能属于另一条已取消读取，导致当前有效请求被误判 READ_CANCELLED。现用 AsyncLocalStorage.bind 绑定整个回调到自身派发上下文；无读取作用域也明确隔离。自身取消、期限、scope、迟到返回及资源预算未放宽。独立审计的 10 项保护探针通过。
4. 当前请求取消后 UI 静默回到空数据，造成“Core 返回 0 张”或空收藏的误导。现当前错误显示重试；真正离页、旧请求仍静默，缓存刷新失败保留已有内容。
5. 被较新意图替代的播放请求映射公开 CANCELLED；已知音频服务、Roon 媒体与地址过期失败仍用原公开错误码，但提供有界中文说明。runtime 增加 queue_replace_failed 的内部错误码诊断；正常替代取消不记成故障。测试确认不泄露 URL 或私有错误详情，预检失败后后续正常播放无需重启。

## 本轮新鲜验证

所有命令采用 Node 22.23.2、pnpm 10.17.1；日志、临时目录与缓存在外置 LifeWeave。每次 runner 先核验当前外置盘 disk10s1 挂载及可写性。没有读取真实 Provider/Roon、录音设备或用户媒体。

| 检查 | 实际结果 |
| --- | --- |
| 根 run typecheck（含 Desktop Vue 与 E2E TS） | 退出 0 |
| 根 run test：Contracts | 254 通过，0 失败 |
| 根 run test：Core | 1964 通过，0 失败，原 2 项 native 条件跳过 |
| 根 run test：Desktop | 1229 通过，0 失败 |
| 根 run test 总进程 | 退出 0，范围未缩小、未新增跳过 |
| Roon Renderer 生命周期定向 | 116/116，退出 0 |
| Roon SDK 回调新测试 / 相关回归 | 8/8、138/138，退出均 0 |
| 快速切歌与 Stop 保护定向 | 196/196，退出均 0 |
| runtime 诊断与恢复定向 | 35/35，退出 0 |
| IPC 错误新测试与 utility IPC | 56/56，退出 0 |
| 独立取消保护审计 | 10/10，退出 0 |
| control-plane / boundaries / cycles | 退出均 0；cycles 检查 372 文件 |
| git diff --check | 退出 0 |

复现历史保留：快速切歌新增 5 项在旧实现失败；Roon callback 新 8 项旧实现 1 通过 / 7 失败（退出 1）；当前 Roon 取消 UI 旧实现 11 项中 2 失败（退出 1）；播放 IPC 新 2 项旧实现失败（退出 1）。这些与最终绿色结果分开存档，不删除原断言。

Root 补 runtime 诊断测试时首次使用了非法的合成歌曲 ID，导致 2 失败及异步拒绝（退出 1）；首次类型检查也捕获了 BridgeError 测试参数结构错误（退出 2）。仅修正测试输入与参数，随后 runtime 35/35、完整类型检查及原全量单元测试通过。这两次是测试夹具错误，不作为生产 RED 证据。

精确 argv、日志、退出码、日志 SHA256 与本次 16 个实现文件的摘要见 `reports/MBR-003_EVIDENCE.json`。外置证据目录：`/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-runtime-fix-n924wlut`。

## 结论与复测边界

确定的并发和回调上下文缺陷已修复并通过上述软件门禁。合成共享 SDK 资源可稳定复现错误归属，但尚未证明本机实际 SDK 传输资源恰好继承同一旧上下文；不能宣布本次所有 Roon 取消的唯一根因已闭合。

旧日志的 INTERNAL_ERROR 丢失了内部错误分类；不能据此把所有播放失败都归为取消。预检 HTTP 503 可在隔离夹具产生相同公开码，但它不是实际失败歌曲的唯一根因证明。新诊断用于进一步归因，未自动重试真实歌曲。

Owner 复测：退出旧开发进程，运行 `corepack pnpm@10.17.1 --filter @music-bridge/desktop run dev`；在同一歌单快速 A→B→C，检查最终 C 播放、无旧错误覆盖；再读取专辑、艺人、流派、收藏及详情 / 封面。仍失败时保留新的 VSCode 日志，并在设置导出诊断核对 queue_replace_failed 的 code。

本轮未执行完整 Electron E2E、生产 App 构建 / 安装、真实账号或设备验收、远端 CI；未推送、合并 main 或替换本机正式 App。旧 MBP-009 的绿色 CI 只属于旧快照，不覆盖本提交。P4/P5、真实录音 / Gate B 等历史 carryover 保留。

原未跟踪 `apps/desktop/test-results/`、`worktree/` 保留；报告提交后应无本轮 tracked WIP。回滚需单独授权，不删除用户数据或自动切换正式安装。
