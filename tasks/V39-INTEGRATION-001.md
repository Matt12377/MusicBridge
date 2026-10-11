# V39-INTEGRATION-001：Tape 历史兼容的正式组合

本任务的累计基线为已验证的唯一报告 `9bfb5915c17e8b5770ece7ac9a0efc1998d54e72`，分支 `codex/v39-integration-001`。前序元数据报告与本任务的两次失败 Source 身份分别保留；本任务当前修复提交仍须完成自己的标准检查、Gate 和首次自然 CI。

本次组合 Tape Source `92956514474dc04c7100e52fe4138212278f1f9b` 的 13 个准确路径与直接 Report `6356aa3215364327f8a08783e0367dce51683ca1` 的 2 个历史报告。15 叶与原 173 验证业务输入继续逐字节保留；旧 4814 测试中 4812 通过、2 跳过仅作为历史记录。本次 277 项 Gate、标准检查、首次自然 Source CI 与唯一直接 Report 自身 CI 分别绑定各自实际提交。

首轮 Source `534aad4d337c1c8aba6f45db21d91276f6981584` 的本地 277 项通过，首次自然远端六项 job 中四项通过、两项失败，不能授予产品 CI 资格。verify 的 Diff whitespace 因三个 EOF 空行失败；Electron 的 Rust/TS 构建验证阶段中，受控生命周期第 5 例已收到 TIMEOUT，但真实耗时使 child spawn 为 0，违反测试预设的 1。Electron 启动与 E2E 未执行。完整失败身份、实际 step 闭集及诊断边界离线登记在 `LOCAL_SOFTWARE_EVIDENCE.json.sourceCorrection`，不把日志读取失败误作产品根因，不声称取得失败制品的整体 SHA 或全部成员 CRC。

Source2 只允许以首轮 Source 为唯一直接父提交。累计闭集为 40 路径（原 39 加现有生命周期测试），首轮 Source 到 Source2 精确为 10 个 M：准入与测试支持 5 叶、Gate 支持 2 叶、主代理登记 3 叶。原第 5 例改为受控单调时钟，保留 1000ms 总期限、2000ms 请求预算、23 个原测试名称、迟到回执拒绝和关闭断言；必须通过能识别错误重置期限的受控负例。生产 owner/router/sidecar 与 15 个 Tape 叶保持不变，不新增第 41 路径。

`EXECUTION_SCOPE.json` 开发态 `frozen:false / IN_PROGRESS` 仅登记写范围，不授予完成资格。Source2 前须冻结累计 40 叶的角色、基线 mode/blob/bytes/SHA 与新叶完整 pin，另验证直接 10 个 M 的首轮 before pin。标准检查须新鲜完整执行并核实实际 pnpm/tee 退出及 fresh Reader；再执行当前 277 Gate，保留自然退出、全量 raw、进程组和后代收口。唯一直接 Report 仍只允许 Scope 指定的 8 个结果路径，复用实际新 Source2 的首次自然 CI；Report 自身首次自然 CI 另行封口。失败 Source 不重跑、不改写、不冒充通过。

先核历史目录、库存、照片、个人录音与关联，再验证真实匹配、预览变化、幂等、冷开与回滚。工程验证使用受控复制资料。真实资料导入另开单一运行窗口，先确认应用与作者句柄收口，并完整备份 DB/WAL/outbox、归档和照片；2.55GB 照片资产不进入 Git。测试或构建不代替真实 profile 备份、应用运行、设备声音或 Owner 接受。原 18 tasks / 156 acceptance cases、有效 17 / 150 与取消 015 的 6 项 N_A 保持。

Tape 封口后，`V39-INTEGRATION-002` 从其实际报告继续完整 Feedback、Async、SQL 小范围修正与共享 Owner/CAS/journal/native writer/HTTPS/Main/Preload/sidebar/routes。完整 CoverDrop 保留原 35 项及当前 9 组增量，特别歌词获取、预览选择、LRC 保存、受保护标签嵌入、全库批处理、停止恢复和独立侧栏入口。两条反馈链按准确增量采用；3175 的产品 IPC 与测试修正不能被 72e5 整棵树覆盖。随后按既定顺序执行 MBRS-016、MBRS-017。本任务不再次运行 300k，不缩减后续完整功能。

## Source3：第二轮自然 CI 失败后的精确修复

Source2 `39c9b9471ca04c7c4ae866799ab8b5876c45955f` 的本地标准检查为 4949 注册、4947 通过、2 个原条件跳过，277 项组合 Gate 通过；它的首次自然 CI 是 5 个成功 job、1 个失败 Electron job。真实 Playwright 共 116 例，其中 109 通过、5 跳过、2 失败：合法 500 项目录的 25 份历史快照分页收到原 Main 2000ms 请求 TIMEOUT，生产 UI 的独立两次崩溃探针自然退出 1。独立的 Rust host 制品 CreateArtifact 请求超时发生在内容上传前，不改工作流把它伪装成软件成功。完整 verify job 日志的读取缺口也不当作产品失败。

当前 Source3 以该失败 Source2 为唯一直接父提交，累计闭集精确 52 路径（17 A、35 M），直接变更精确 20 个 M。原 40 叶全部保留，写范围从原53/21收缩，移除Core环境文件的改动；该文件恢复固定c647/Source2完整5714字节。32 个原 Source2 叶完全不变。三位作者分别保留 Core 2 叶、Renderer 10 叶、准入/Gate 5 叶；主代理写 Scope、软件证据规范和本任务说明 3 叶。没有发布、真实账号、数据库迁移、照片删除或下一任务授权扩展。

进度修复只能在一个同步操作内复用已经完整证明的相同实际正文指纹；每个候选仍读取原行、解析完整 DTO、核原身份和历史目标、重算原 canonical SHA，再决定是否复用重复语义证明。跨请求、跨页、跨连接不保留资格，首个超出响应预算的候选也完整核验；500 项、25 份、UTF8 8 MiB、原 2000ms 请求预算与损坏数据拒绝保持。 原容量检查先限定最多 5000 份快照，再以相同 WHERE 和 rowid 倒序一次读取有界匹配 ID，计算精确 total 并按原 offset/limit 选择完整正文候选，消除重复的 JSON 过滤扫描；空页、尾页、跨书/修订筛选及原响应预算保持。

崩溃探针由 Main 在真实启动恢复和 compact snapshot 提交 ready 后通过当前 Utility 的受控私有通道 arm，首轮还需进入原 crash Gate 分支。之后仍在原 25ms 故障，两轮真实 spawn、Main ready、退出 71 与一次重启齐全才可 PASS。凭据恢复原自动 250ms 故障不改变。独立合成探针按显式选项保存私人完整 stdout/stderr，默认摘要不包含原始日志；原组合 64 KiB、30s 启动/退出、1s kill grace、2s close 限额保持，raw 写入失败不得通过。

Source1 与 Source2 的 Git tree、所有叶原件、Scope、旧 generation2 correction、自然 CI 实际结论及诊断制品的 partial/false whole 边界均由 generation3 固定。旧本地绿色定向 E2E 和受控延迟复现只帮助定位，不授予远端资格。当前 Source3 须重新生成完整标准 TAP 和 Reader，再跑原 277/277/0 Gate，普通追加提交、首次自然 push CI；失败提交不重跑、不 amend、不 reset。只有合格的新 Source3 可生成精确 8 路径唯一直接报告，该报告自身 203 注册、200 通过、3 项明确继承跳过及首次自然 CI 另行封口；V39-INTEGRATION-002 仍等待实际合格报告。

Source3未发布本地候选 `1367c907437811f4ab92a2dcdad94bcbe0dc12b6` 的首次完整标准检查实际4967注册、4962通过、3失败、2原条件跳过，类型检查通过而生产构建未运行；失败集中于Main factory新增自由变量与生命周期回调首语句兼容。候选、完整原日志、自然退出1及物理关闭记录均保留；它未采用、未push、未运行CI。仅在相同21叶内修正Main及已有启动测试，另从干净Source2创建独立普通兄弟候选，未reset、amend或重跑失败SHA。原Core与Utility事实及所有限制不扩大。

Source3未发布候选 `b64b8bd4add0500aa4dc81ec4cb78262ecb72511` 的本轮258完整标准实际4967注册、4965通过、2原条件跳过及生产构建自然成功；随后277组合Gate在原173阶段实际172通过、1失败，第157例固定FD文件读取预期5714字节，合法新Core环境5919字节导致旧输入前提冲突。候选及全量raw、自然退出1、物理关闭记录全部保留，未采用、未push、未运行CI。本次将arm开关局限在Main实际crash分支，恢复原Core环境whole bytes与第157例原断言；只收缩至52/20，不增加新叶、不改变原173/277/203名称与数量、不增加历史输入mirror。两个未发布失败SHA均不重跑、不改写。

2026-10-12 准入性能修复：保留未发布1dce52e310cba6d8d09cfdd40178cf2963e2a345及262完整标准通过和admission-safety原90000ms超时原件。只在原准入模块批量预读同operation内固定Base blobs，并在原报告fixture中将CRC32换成等值查表；原52累计/20直接闭集、全部case标题与注册、原断言、全历史字节、16MiB/64MiB和90000/480000ms预算不变。尚未获得当前Source、CI或Owner资格。
