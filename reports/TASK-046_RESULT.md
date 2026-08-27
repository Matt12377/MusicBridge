# TASK-046 结果报告：本地歌词来源与手动匹配

## 身份与集成边界

- 分支：`codex/task-046-local-lyrics-manual-ui`
- 基线：`fee74e5b51a517253e5804a0c8dc217a0feeb106`（TASK-045 最终 HEAD）
- 实现提交：`f97c941645e96fb643716f5c2f63695b9bc158d5`
- 实现消息：`feat(desktop): add manual local lyrics matching`
- PR：[#12](https://github.com/Matt12377/MusicBridge/pull/12)，base=`codex/task-045-cross-source-lyrics-coordinator`，保持 Open。
- 按 Owner 指示使用未合并的叠加分支，不修改 main。报告提交身份由随后独立的 STATUS 锁定提交记录。

## 实现范围

- 公开有界匹配状态和 `get/select/revoke` IPC；候选只公开 title、artists、album、duration 与会话内不透明 ID。比设计草案进一步收紧：Renderer 不获得 NetEase Track ID。
- Core 创建五分钟、最多二十项的候选会话；选择校验 signature、playback generation、时效和成员资格，不接受任意 Track ID。
- 候选来自领域模型的可用录音簇；hard reject 和标题不相关的搜索结果不进入手动 allowlist。
- 选择串行化，防止并发请求重复写入；持久化期间切歌会拒绝旧选择并回滚旧写入。撤销只操作当前签名下实际存在的确认记录，随后重新解析。
- 按 ADR-008，MANUAL 和 CONFIRMED 均可撤销。重新解析仍可能再次自动确认；撤销不是永久屏蔽。
- Resolver 与 Coordinator 的缓存按当前签名失效，手动选择和撤销只重新加载歌词。缓存命中时同步恢复匹配状态，避免重播后一直显示查找中。
- 停止、stopping 和播放错误状态不保留可操作的歌词上下文；Smart-to-Roon 不开放第一版手动 UI。
- NowPlaying/LyricsPanel 显示“歌词来源：网易云”，复用现有抽屉视觉；具有候选/无匹配/无歌词/未登录/网络错误文案。
- 列表使用原生列表和按钮语义，支持 Tab 循环、Escape、关闭后恢复焦点、候选移除后的焦点修复和减少动态效果。720px 最小窗口使用贴底抽屉。
- Renderer 的查询和 mutation 响应受事件修订号约束，旧成功/失败不能覆盖较新的 Core 事件。

## RED / GREEN 与审查

先检查 TASK-046/ADR-008 的规格边界，再检查候选安全、并发、缓存、事件顺序和辅助功能。由主代理完成两阶段审查，未声称独立外部审查。

行为 RED 包括：hard reject 混入手动候选、并发双写、重播缓存状态丢失、停止后保留上下文、旧 IPC 响应覆盖新事件、初始化失败清空新事件、候选列表 ARIA 子级不合法、选择后焦点丢失、窄窗抽屉距底部 200px。对应回归均已转 GREEN。

规格复核纠正了开发中将撤销仅限 MANUAL 的过窄判断，最终保持 ADR-008 的 MANUAL/CONFIRMED 撤销语义。

| Gate | 最终本地结果 |
|---|---|
| `corepack pnpm@10.17.1 verify` | exit 0；typecheck、unit、build 全部通过 |
| Contracts | 27/27 |
| Core | 405/405；包括 9 项手动匹配、30 项歌词/协调器测试 |
| Desktop unit | 162/162 |
| Security | 22/22 |
| Electron startup/crash/safeStorage/恢复 | 4/4 |
| Playwright E2E | 22/22 |
| axe | 候选态、匹配态与现有全界面 critical/serious = 0 |
| control-plane / boundaries / cycles | PASS / PASS / PASS（98 files） |
| `git diff --check` | exit 0 |

UI E2E 使用 Main 测试夹具；Core 另有真实组件组合测试覆盖 controller → repository → resolver → coordinator。两者均是 Synthetic，不冒充真实 Provider/Roon 或真实听感。

## Carryover 与下一步

- 远端首次最终 HEAD macOS Gate 在既有搜索分页 E2E 失败：强制点击滚动后已被 IntersectionObserver 加载状态替换的按钮。只调整测试为滚动并等待第二页结果，不改分页产品代码；最终远端状态以 PR checks 为准。

- 本任务没有连接真实 Provider 或真实 Roon，没有取得 Owner 接受。
- TASK-047 从本任务最终身份提交创建，补齐全矩阵组合验收及真实样本操作清单。
- 自动测试生成的未跟踪 `apps/desktop/test-results/` 保留但不提交；不删除其他工作树及证据。
- 设计和所有实现 PR 必须保持未合并，等待 Owner 全套测试确认。
