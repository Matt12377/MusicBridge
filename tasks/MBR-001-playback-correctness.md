# MBR-001：播放正确性

基线 `7a6a19105480be456778dfa4369379f224665e39`，分支 `codex/mbr-001-playback-correctness`，从 MBP-001 最终报告 HEAD 接续；Owner 已授权连续实施。

## 范围

修复旧 Audio Input terminal 在串行队列中误清新播放、Stop 失败提前清身份、原生 Zone 新鲜度与同名曲误确认、Renderer 旧集合分页回填和键盘操作冒泡。停止未知不能宣布 idle 或允许新播放越过停止门禁；诊断、业务合同和用户数据保留。原生 metadata 别名不能绕过身份校验，时长冲突必须拒绝。停止重试重试原停止操作。

## Gate

1. 确定性旧 terminal/重复 terminal、Stop 失败重试/迟到/并发、新鲜 Zone/同名曲回归。
2. 集合替换/Stop 后的旧分页及回执不得追加或回填，新的有效请求可继续。
3. 行本身 Enter 仍播放，子按钮 Enter/Space 只执行按钮操作。
4. 相关合同/Core/Renderer 回归、类型、生产构建、static Gate、diff-check；原完整 verify 与 Electron 合成验证保留原范围，无新增 skip。
5. 真实 Mac/Roon/audio NOT_RUN，不能用 Fake 升级听感或发布结论。

独立实现和报告提交。下一任务 MBP-002 从最终报告 HEAD 创建。main、正式 App 与用户库不改。
