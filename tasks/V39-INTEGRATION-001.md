# V39-INTEGRATION-001：Tape 历史兼容的正式组合

本任务直接从已验证的唯一报告 `9bfb5915c17e8b5770ece7ac9a0efc1998d54e72` 开始，分支 `codex/v39-integration-001`。前序 Source2 与直接 Report 的首次自然 CI、完整日志与各自 12 文件制品已封口；原失败提交与产品证据全部保留。

本次只组合 Tape Source `92956514474dc04c7100e52fe4138212278f1f9b` 的 13 个准确路径与直接 Report `6356aa3215364327f8a08783e0367dce51683ca1` 的 2 个历史报告，以及 24 个独立任务与 CI 支持路径。源码机械兼容已经逐字节核对；组合验证必须绑定本次实际源码。旧 4814 测试中 4812 通过、2 跳过作为历史记录保留。

`EXECUTION_SCOPE.json` 开发期间 `frozen:false / IN_PROGRESS` 仅登记精确开发写范围，不授予 CI 或完成资格。最终 Source 提交前必须冻结全部 39 路径的角色、原 mode/blob/bytes/SHA 与新叶完整 pin，保持原 004、mirror、metadata 的冻结原件与历史提交。新任务只有自己的精确分支、机器登记、基线和全量差异闭集可进入对应路由；未知分支、遗漏路径、额外产品、环境注入与不完整历史一律拒绝。

先核历史目录、库存、照片、个人录音与关联，再验证真实匹配、预览变化、幂等、冷开与回滚。工程验证使用受控复制资料。真实资料导入另开单一运行窗口，先确认应用与作者句柄收口，并完整备份 DB/WAL/outbox、归档和照片；2.55GB 照片资产不进入 Git。测试或构建不代替真实 profile 备份、应用运行、设备声音或 Owner 接受。

源码 Gate、标准检查、首次自然 Source CI 与唯一直接 Report 自身 CI 分别记录；报告只允许 Scope 指定的 8 个结果路径，不修改源码或冻结 Scope。原 18 tasks / 156 acceptance cases、有效 17 / 150 与取消 015 的 6 项 N_A 保持。

Tape 封口后，`V39-INTEGRATION-002` 从其实际报告继续完整 Feedback、Async、SQL 小范围修正与共享 Owner/CAS/journal/native writer/HTTPS/Main/Preload/sidebar/routes。完整 CoverDrop 保留原 35 项及当前 9 组增量，特别歌词获取、预览选择、LRC 保存、受保护标签嵌入、全库批处理、停止恢复和独立侧栏入口。两条反馈链按准确增量采用；3175 的产品 IPC 与测试修正不能被 72e5 整棵树覆盖。随后按既定顺序执行 MBRS-016、MBRS-017。本任务不再次运行 300k，不缩减后续完整功能。
