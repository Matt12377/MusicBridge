# TASK-053：Roon 选曲与录音草稿结果

## 身份与结论

录音页已通过正式 Main → Core → SQLite 保存跨专辑选曲草稿，可编辑标题、节目类型、曲序和移除曲目。Roon 浏览信息不成为 Source Lock；没有冻结母版、预留库存或正式录音动作。

- 基线：`bc4290a10b7ca4a5f5fb73fe70898946fb49be16`。
- 分支：`codex/task-053-v3-master-source-picker`。
- 实现：`26bf98de6985695402ff724668c12b0796586c59`。
- 本报告独立提交，报告 SHA 由后续 STATUS 锁定；TASK-054 从最终锁定 HEAD 开始。

## 实现

Schema 5 增加草稿和不可变操作账本，迁移失败保留旧音乐/照片/关联。每个草稿与草稿曲目有本地 UUID；重复标题不自动合并，重新排序保留曲目身份。单草稿最多 200 首、单次明确选择最多 100 首，分页有界。

Core 只从当前有效 Roon 引用提取安全快照。运行期引用、itemKey、session、封面引用和 UI 的缺失信息占位文字不写入草稿。重启后保留草稿与曲序，但试听引用待重新定位。用户明确试听才调用既有播放接口；选曲/保存/导航不操作播放。

Compilation 初步时长包含相邻边界额外 5 秒；Concert/Continuous 不自动增加间隔，未知曲长不伪造总时长。草稿始终 sourceLockEligible=false，界面明确提示实际源文件尚未验证；此处估算不是最终 Layout 或帧级执行时间线。

取消选择不写入。明确拒绝后重新核对；回执未知保持原命令重试，避免重复草稿和曲目。编辑与曲序变更要求保存；返回可明确放弃未保存编辑。选曲弹窗关闭恢复焦点。

## 行为 RED 与调试

正式草稿 IPC 返回 UNKNOWN_IPC_COMMAND、录音页选曲按钮 disabled、草稿确认合同被拒绝均为行为 RED。注入合成目录的 runtime 原先无法通过公共专辑入口浏览，在既有 runtime 测试中取到 undefined 后增加显式注入分支。合成目录仍不会提供试听成功证据。

草稿身份/曲序、幂等/冲突、事务回滚、未知时长、跨重启、删除归属、200 首边界、不可变账本及实际数据库字节不含运行引用均有自动验证。旧 V3 导航用例按已实现能力改为期待选曲可用，原有播放不变断言保留。

一次合并运行 Desktop preload 测试时 cwd 设在仓库根目录，导致其相对文件读取 ENOENT；改为在 apps/desktop 按既有入口执行后通过，不把此环境错误当行为 RED。初建工作树时一次无效基线引用被 Git 拒绝，实际创建后已核验为上述 TASK-052 最终 HEAD，没有错误分支或工作树被接管。

## 最终 Gate

全部 Gate 显式使用 Node 22.23.2 与 Corepack pnpm 10.17.1；共享构建目录串行执行。

| Gate | 结果 |
|---|---|
| verify：类型、单元、生产构建 | exit 0；Contracts 34/34、Core 473/473、Desktop 168/168 |
| security | exit 0；22/22 |
| Electron 生命周期 | exit 0；4/4 |
| Playwright 全量 | exit 0；39/39 |
| control-plane / boundaries / cycles | PASS / PASS / PASS，111 files；control-plane 只核对旧 WAVE-3 |
| diff / 暂存检查 | exit 0 |

新增 UI 覆盖取消零写入、跨两张专辑选曲、稳定身份排序、关闭应用后离线恢复、删除曲目与未知回执重试。720 选曲弹窗、720/1440 草稿页无横向溢出，局部 axe serious/critical 为 0；实际查看了最终截图。真实 Roon 和 Owner 美观验收未执行。

最终日志 `/tmp/musicbridge-task-053-final-{verify,security,electron,e2e}.log`，本地归档 `reports/runtime/task-053-final-mtc29j5_/`。初始 RED 存于 `reports/runtime/task-053-initial-red/`，中间校验日志保留。

## 自查、遗留与接续

主代理先核对选曲/取消/顺序/来源状态规格，再检查元数据边界、事务、输入输出校验、异步生命周期、分页与 UI；未使用子代理，不声称独立审查。

TASK-054 接入实际 Source Roots 与只读源文件验证。Source Picker 内实体/数字关系入口、最终分面、库存推荐/预留、版本冻结、执行引擎、归档/J-Card、参考目录和完整 A～E/Owner 尚未完成。跨应用重启未确认命令 outbox、F-01、真实目录/账号/设备、旧歌词与视觉 carryover 保留。

无 push、main 合并、签名、公证或发布。远端 main 为 `90d0aa8aa7f156c6ecfc6f366eea698f8e4d6098`，远端无本任务分支。按六步面板持续推进完整 V3，不把本切片通过称为 V3 完成。
