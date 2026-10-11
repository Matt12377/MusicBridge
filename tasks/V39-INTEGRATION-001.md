# V39-INTEGRATION-001：Tape 历史兼容的正式组合

本任务的累计基线为已验证的唯一报告 `9bfb5915c17e8b5770ece7ac9a0efc1998d54e72`，分支 `codex/v39-integration-001`。前序 Source2 与直接 Report 的首次自然 CI、完整日志与各自制品已封口；原失败提交与产品证据全部保留。

本次组合 Tape Source `92956514474dc04c7100e52fe4138212278f1f9b` 的 13 个准确路径与直接 Report `6356aa3215364327f8a08783e0367dce51683ca1` 的 2 个历史报告。15 叶与原 173 验证业务输入继续逐字节保留；旧 4814 测试中 4812 通过、2 跳过仅作为历史记录。本次 277 项 Gate、标准检查、首次自然 Source CI 与唯一直接 Report 自身 CI 分别绑定各自实际提交。

首轮 Source `534aad4d337c1c8aba6f45db21d91276f6981584` 的本地 277 项通过，首次自然远端六项 job 中四项通过、两项失败，不能授予产品 CI 资格。verify 的 Diff whitespace 因三个 EOF 空行失败；Electron 的 Rust/TS 构建验证阶段中，受控生命周期第 5 例已收到 TIMEOUT，但真实耗时使 child spawn 为 0，违反测试预设的 1。Electron 启动与 E2E 未执行。完整失败身份、实际 step 闭集及诊断边界离线登记在 `LOCAL_SOFTWARE_EVIDENCE.json.sourceCorrection`，不把日志读取失败误作产品根因，不声称取得失败制品的整体 SHA 或全部成员 CRC。

Source2 只允许以首轮 Source 为唯一直接父提交。累计闭集为 40 路径（原 39 加现有生命周期测试），首轮 Source 到 Source2 精确为 10 个 M：准入与测试支持 5 叶、Gate 支持 2 叶、主代理登记 3 叶。原第 5 例改为受控单调时钟，保留 1000ms 总期限、2000ms 请求预算、23 个原测试名称、迟到回执拒绝和关闭断言；必须通过能识别错误重置期限的受控负例。生产 owner/router/sidecar 与 15 个 Tape 叶保持不变，不新增第 41 路径。

`EXECUTION_SCOPE.json` 开发态 `frozen:false / IN_PROGRESS` 仅登记写范围，不授予完成资格。Source2 前须冻结累计 40 叶的角色、基线 mode/blob/bytes/SHA 与新叶完整 pin，另验证直接 10 个 M 的首轮 before pin。标准检查须新鲜完整执行并核实实际 pnpm/tee 退出及 fresh Reader；再执行当前 277 Gate，保留自然退出、全量 raw、进程组和后代收口。唯一直接 Report 仍只允许 Scope 指定的 8 个结果路径，复用实际新 Source2 的首次自然 CI；Report 自身首次自然 CI 另行封口。失败 Source 不重跑、不改写、不冒充通过。

先核历史目录、库存、照片、个人录音与关联，再验证真实匹配、预览变化、幂等、冷开与回滚。工程验证使用受控复制资料。真实资料导入另开单一运行窗口，先确认应用与作者句柄收口，并完整备份 DB/WAL/outbox、归档和照片；2.55GB 照片资产不进入 Git。测试或构建不代替真实 profile 备份、应用运行、设备声音或 Owner 接受。原 18 tasks / 156 acceptance cases、有效 17 / 150 与取消 015 的 6 项 N_A 保持。

Tape 封口后，`V39-INTEGRATION-002` 从其实际报告继续完整 Feedback、Async、SQL 小范围修正与共享 Owner/CAS/journal/native writer/HTTPS/Main/Preload/sidebar/routes。完整 CoverDrop 保留原 35 项及当前 9 组增量，特别歌词获取、预览选择、LRC 保存、受保护标签嵌入、全库批处理、停止恢复和独立侧栏入口。两条反馈链按准确增量采用；3175 的产品 IPC 与测试修正不能被 72e5 整棵树覆盖。随后按既定顺序执行 MBRS-016、MBRS-017。本任务不再次运行 300k，不缩减后续完整功能。
