# MBRS-001 隔离 POC 软件交付

状态 PARTIAL：隔离合同软件通过；4项真实Roon验收BLOCKED_ENV，2项integration PARTIAL，3项限定软件PASS。

基线 `6f1cc0edcb0c59b78a2dfd0828b8e6196e816e47`；实现 `c0ad30a9df471e772a0c9e9268bd7b0c41cb8763` 已普通push。报告是独立后续提交，当前commit身份用本文git log解析，避免自引用SHA。默认Node与Rust只读OFF、SourceFiles写OFF；没有真实Roon/账号/音乐目录/用户DB/安装/merge/release操作。

新增工具只处理runner合成文件，复用锁定官方AudioInput薄SDK与原Adapter。10代码/CI文件+任务范围提交；原生产源码、lock/Provider和既有测试不变。最终源聚合 `894a9b9d1a2b97ba939a3ece5daf28c17c30cfbd16bdbac62e205c99dbdb498f`。

本机完整Gate退出0：nested noEmit0，32新行为及118原定点回归全部PASS，无skip/cancel/todo，一次offline复现0，实际FD EBADF探针与资源收口满足。control-plane与boundaries各0。自动Gate已加入原verify workflow，原完整verify/audit/历史回归/artifact步骤保留；实现提交远端4workflow/6job自然runAttempt1全success，新增离线artifact的28直接输入逐一匹配实现Gitblob，32/118/POC全通过。综合verify4142通过+2原条件skip，准备48、历史片段4、Electron12、Playwright104通过+4原skip；依赖high阈值Gate通过，实际6moderate。3份已下载artifact digest match；195MB Electron ZIP仍DOWNLOAD_PENDING，digest/Host/Main未核，补充取证继续且独立收据封存。报告提交CI在提交后另采，不用实现CI替代。

两轮正式独审与主控后续最小处置分开。R2 ownership残余旧stopFailed context夺权，新增用例先得到实际2/期望1有效RED，修后32 GREEN；不声称第三独审。完整失败/绿色冻结/命令退出与日志SHA见EVIDENCE。各原9AT逐项、实际HTTP/SDK/控制形状、已知通知缺口与远端UNKNOWN见[直送结果](../docs/postrust/MBRS-001/DIRECT_STREAM_POC_RESULT.md)、[API记录](../docs/postrust/MBRS-001/API_BEHAVIOR_NOTES.md)、[格式矩阵](../docs/postrust/MBRS-001/FORMAT_INITIAL_MATRIX.md)。格式解码/听感、Core真实可达和最终Owner体验未测试。

R16新有限软件G0为ADMITTED，旧000 NOT_ADMITTED原件不回写。原83工作树和8dirty文件保护由证据角色独立核验；root未reset/clean/stash或提交无关WIP。下一任务MBRS-002从本任务最终报告HEAD创建独立分支；稳定本地领域/closed DTO/合成旧库迁移沿既有唯一Node owner，不能由001工具推出真实目录/写音乐权限。

报告台账复核另运行旧000结构test：实际12/13、退出1，唯一G0_DECISION_MISMATCH。精确base6f1与实现c0已有同一差异：current计划为R16新ADMITTED，000封存决定仍NOT_ADMITTED。001未改G0字段、旧seal或旧校验器；此失败保留，不登记13PASS。当前18/156身份、其它17/147完整对象、九项状态、source/ref/报告allowlist由外置增量检查另证。
