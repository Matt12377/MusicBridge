# TASK-047：跨源歌词分层验收

> 2026-08-27 集成补录：Owner 已明确授权先合并 main、准备 v3。本文原有禁止合并结论被此次授权取代；真实验收仍未完成，TASK-047 不标记 complete。详见 [WAVE-4 集成补录](WAVE-4_INTEGRATION_ADDENDUM.md)。

## 当前结论

**Synthetic 自动 Gate 已通过；真实 Roon + NetEase 与 Owner 接受尚未执行。TASK-047 不标记 complete，所有 PR 保持未合并。**

## 构建身份

- 分支：`codex/task-047-local-lyrics-acceptance`
- 基线：`097e349b99ced1492d5c2f6065bd479e343bd98c`（TASK-046 最终 HEAD）
- 测试实现提交：`3d50e3836cabb5763b062445a45392d32e37edab`
- 测试实现消息：`test(lyrics): cover cross-source lyrics acceptance`
- 报告身份：由后续独立 STATUS 锁定提交记录。
- 本任务只修改测试、状态和风险登记，没有生产代码变更。
- main 保持 `207f7f04bc11fd4dcf7e6214ab705e999ee6f559`。
- 设计 PR #7 与 A–E PR #8–#12 均为叠加、未合并状态。基线 PR #12 的最终 HEAD 远端 verify、security、dependency audit 和 macOS Electron Gate 已通过。

## Synthetic 证据

新增 17 项跨组件测试：15 项 `local-lyrics-acceptance.test.ts`，2 项 `controller.test.ts`。使用真实领域模型、仓库、Resolver、Coordinator、手动匹配控制器以及受控 Provider/Roon 端口。

| 验收项 | Synthetic 结果与证据 |
|---|---|
| 唯一同版本成功匹配 | PASS：Resolver → Coordinator 来源为 NetEase，仅下载已确认 ID |
| Studio/Live、Original/Remix、Vocal/Instrumental、Original/Cover、Final/Demo | PASS：五组端到端组合测试，均无歌词下载、无手动候选、无正向记录 |
| 精选集同录音 | PASS：不同 album 仍可确认同录音 |
| AMBIGUOUS/POSSIBLE/NONE | PASS：不自动显示候选歌词，公开匹配状态明确 |
| NetEase 无歌词 | PASS：保留匹配、歌词 unavailable，不改变播放快照 |
| 网络失败、Provider 未配置 | PASS：公开有界状态，无内部错误细节；Provider 未配置时不搜索 |
| 音频先开始 | PASS：实际 BridgeController + Fake Native Roon 已 playing 时搜索 Promise 仍未结算；失败后没有 stop/pause/resume 或 Provider 音频调用 |
| Pause/Resume | PASS：实际 Controller 状态联动 Coordinator，暂停和 resuming 期间冻结；确认后重新锚定 |
| Seek | PASS：请求确认本身不伪造新位置，收到有效 Roon position 后立即变更 activeLine |
| 快速切歌 | PASS：旧下载延迟返回不覆盖当前歌词及匹配状态 |
| 重播/跨实例复用 | PASS：新 Repository 实例和变化后的 Roon runtime ID 复用稳定记录，不重新搜索 |
| MANUAL 选择、撤销、过期/旧会话 | PASS：复跑 TASK-046 的 9 项控制器测试和完整 Coordinator 组合测试 |
| UI、键盘、焦点、720px、减少动态效果 | PASS：Playwright 22/22；候选态和匹配态 axe critical/serious = 0 |
| 持久文件隐私 | PASS：只保存正向映射，0600；不含歌词正文、运行期 ID、凭据或媒体路径 |
| 日志/诊断/Renderer 边界 | PASS：Contracts、security 和 boundaries Gate；未接入真实日志，不能据此宣称真实日志验收 |

所有曲目和歌词测试数据均为 Synthetic，即使使用“归零”作为元数据标签，也不构成真实歌曲或账号验收。

### 最终本地命令结果

均在本任务工作树、Node 22.23.2 / pnpm 10.17.1 执行：

| 命令/Gate | 结果 |
|---|---|
| `corepack pnpm@10.17.1 verify` | exit 0；类型、测试、生产构建通过 |
| Contracts / Core / Desktop | 27/27、422/422、162/162 |
| `corepack pnpm@10.17.1 test:security` | exit 0；22/22 |
| `corepack pnpm@10.17.1 test:electron` | exit 0；4/4，包括启动、崩溃、safeStorage 与恢复 |
| `corepack pnpm@10.17.1 --filter @music-bridge/desktop exec playwright test` | exit 0；22/22 |
| control-plane / boundaries / cycles | PASS / PASS / PASS（98 files） |
| `git diff --check` | exit 0 |

测试夹具首次 typecheck 缺少 PlaybackSnapshot 的两个导航字段，已补齐；不是产品行为 RED。此前 TASK-046 的远端分页测试竞态已由测试层修正，本任务基线包含该修正。没有用跳过测试或强制重试掩盖失败。

主代理先核对 ADR-008 全矩阵覆盖及生产 diff 为零，再检查测试隔离、可控时钟/Promise 和临时文件清理；未声称独立外部审查。

## Owner 真实验收清单（全部待执行）

先退出旧开发实例，从本任务分支启动桌面开发版。只通过现有 UI 完成网易云登录和 Roon 配对；不要在聊天或命令行提供 Cookie、Token、密码。使用 Roon 本地曲库点播，不用网易云音频代替本地源。

| 编号 | 本地真实样本 | 必须观察 | 状态 |
|---|---|---|---|
| R1 | 归零 | 音频仍由 Roon 播放；有确认匹配时出现网易云来源提示；无确认时不能猜歌词 | 待执行 |
| R2 | 唯一同版本且有逐行歌词的曲目 | 本地播放先开始，歌词异步出现；听感与高亮一致 | 待执行 |
| R3 | Live/Studio 冲突样本 | 错误版本不能自动显示，也不能作为安全手动候选 | 待执行 |
| R4 | Cover/Original 冲突样本 | 同上 | 待执行 |
| R5 | 同一录音在精选集 | album 不同不应直接拒绝同录音 | 待执行 |
| R6 | 多个相似版本 | 不自动选；手动选择只换歌词；撤销后重新解析 | 待执行 |
| R7 | 网易云无歌词的本地曲目 | 显示暂无歌词，音频持续 | 待执行 |

在 R2/R6 上追加以下操作：

1. 暂停数秒，确认歌词停止推进；恢复后以真实 Roon 播放状态继续。
2. 向前、向后 Seek，确认高亮随 Roon 确认位置更新。
3. 快速连续切换数首歌，确认旧歌词和旧候选不能覆盖当前曲目。
4. 重播同曲并重启 App，确认保存的匹配可复用；使用缓存不等于听感已经验收。
5. 在不破坏 Roon 本地连接的前提下模拟网易云不可用，确认歌词失败不停止本地音频。若无法隔离网络，保留此项未执行，不直接切断正在使用的 Roon 网络。
6. 检查抽屉键盘/Escape、窄窗口、来源提示；不得出现工程分数或签名。

记录只需要：构建 SHA、样本编号、匿名 Zone 标签、音频来源是否保持、操作及通过/失败、时间区间。不要记录歌词正文、账号资料、Roon session/item_key、媒体路径或原始 Provider 错误。

### 分层签字

- Synthetic 自动验证：PASS（本报告所列命令）。
- 真实 Provider/Roon 工程验收：NOT RUN。
- Owner 产品接受：PENDING。
- main 集成/合并授权：NOT GRANTED。

## 下一步与停止点

等待 Owner 执行上述真实样本测试并反馈。若出现 P0/P1 产品缺陷，另开有界 bugfix，先复现再修复，不能夹在验收报告提交中。

没有新任务基线或自动合并动作。Owner 明确接受后，再决定按依赖关系整合设计与实现 PR。自动测试生成的未跟踪 `apps/desktop/test-results/` 保留但不提交。
