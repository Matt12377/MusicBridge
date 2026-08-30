# TASK-052：Roon 与原版实物双向关系结果

## 身份与结论

V3 原版实体详情、数字对象详情和收藏矩阵已接通正式 Main → Core → SQLite。用户明确确认版本关系，实体与数字对象保持独立身份；Roon 断连和应用重启不删除收藏。真实 Roon 和 Owner 验收仍待执行。

- 基线：`60d4752d585c8a1b67629b0d5d3f85b36ba9362e`。
- 分支：`codex/task-052-v3-roon-physical-links`。
- 实现：`725827956cc6e4624ae3877e838b642a2a569f3b`。
- 本报告单独提交，报告 SHA 在后续 STATUS 锁定提交记录；TASK-053 从该最终 HEAD 开始。

## 实现与边界

Schema 4 保存安全数字元数据、明确的 Exact / Probable / Related 关系、双方缺少声明及不可变命令账本。CD Rip 单独确认且仅允许原版 CD 的 Exact 关系。关联提交原子消除冲突缺少声明；解除关联不删除任何一侧，也不自动声明缺少。矩阵不按标题合并，确认同版数量与待核实关系分开。

公共 Roon 目录在断连时失效旧作用域，同时拒绝此前发出、之后才返回的浏览结果。数据库与账本不存运行引用、itemKey 或 session。重新定位核对当前候选和原元数据，元数据变化不能沿用旧数字身份。以上仅是目录关系，不能替代 Source Lock 或音频证据。

界面支持当前 Roon 搜索/浏览、已存数字对象离线选择、明确确认/取消、双向详情、矩阵、独立 CD Rip 确认、缺少声明与解除关系。数字详情复用曲目浏览/试听接口；没有正式录音动作。运行中断连立即禁用试听并保留关系。明确拒绝允许重新选择，回执未知只重试原命令。

## 行为证据与修正

- 原版详情缺少关联按钮、数字目录 IPC UNKNOWN_IPC_COMMAND：生产入口行为 RED。
- 相同服务对象重连后旧引用仍可使用、延迟浏览结果污染新作用域：断言 RED 后修复，Roon 公共目录 16 项通过。
- CD Rip 与非 Exact 的合同组合原先接受：合同 RED 后加约束。
- 同一运行引用元数据变化时仍沿用旧数字对象：协调器 RED 后拒绝不一致快照。
- UI 测试发现返回同一实物仍停留数字详情、候选拒绝后被未知回执重试锁住、取消弹窗没有恢复焦点、断连时详情状态未更新。分别保留断言 RED，按根因修正后完整回归通过。
- 测试曾误用含 option 文本的 label 定位 select，改为明确 combobox 角色；该定位失败不作为生产缺陷或有效行为 RED。测试命令的额外分隔符曾导致全量执行，结果如实为旧 33 项通过、新入口 2 项失败。
- Schema 3 → 4 中断回滚、现有音乐/照片不变、命令幂等、提交失败无孤儿、离线关系保留、不同版本拒绝、磁带不能 CD Rip、自录不冒充商业发行版、实际 SQLite 字节不含 Roon 引用均有自动验证。

## 最终 Gate

全部命令显式使用 Node 22.23.2 与 Corepack pnpm 10.17.1；共享构建目录的 Gate 串行执行。

| Gate | 结果 |
|---|---|
| verify：类型、单元、生产构建 | exit 0；Contracts 33/33、Core 466/466、Desktop 168/168 |
| security | exit 0；22/22 |
| Electron 生命周期 | exit 0；4/4 |
| Playwright 全量 | exit 0；36/36 |
| control-plane / boundaries / cycles | PASS / PASS / PASS，108 files；control-plane 仍只检查旧 WAVE-3 |
| diff / 暂存检查 | exit 0 |

新增 UI 闭环经过完整退出和重启，确认本地关系仍在且链接待重新定位，用户再次确认后恢复；无效候选不改变快照。720/1440 视口无横向溢出，数字关联区域 axe serious/critical 为 0，取消后键盘焦点返回通过。实际查看了最终合成数据截图，未代替 Owner 美观验收。

最终日志 `/tmp/musicbridge-task-052-final-{verify,security,electron,e2e}.log`。本地归档 `reports/runtime/task-052-final-fzv8gm5u/`，既有 RED 和中间失败证据保留在同级 task-052 目录。

## 自查、遗留与接续

先核对版本身份、明确确认、缺少状态、Source Lock 边界和 UI 流程，再核对协议校验、事务、引用作用域、分页、资源清理及异步结果。主代理自查，未使用子代理，不声称独立审查。

历史/正式自录的逐曲数字源关系由 Master Source Picker / 归档接续，不创建伪商业 Exact。完整 A～E、跨应用重启未确认命令 outbox、F-01、真实设备/真实源文件/Owner 验收仍未完成。旧 TASK-047 真实歌词、V2 闲置设备对比度和旧侧栏视觉 carryover 保留。

无 push、main 合并、签名、公证或发布。远端 main 核验为 `90d0aa8aa7f156c6ecfc6f366eea698f8e4d6098`，远端无本任务分支。接续 TASK-053 选曲草稿，继续推进完整 V3，不重新输出 HTML Todo。
