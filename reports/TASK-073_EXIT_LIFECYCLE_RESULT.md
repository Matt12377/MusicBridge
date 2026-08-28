# TASK-073：退出验证与合成配置隔离结果

## 身份和范围

- 基线：`81dbd2621774ba84d017cff3b98734d63e75fd4f`；分支`codex/task-073-output-backend`。
- 实现提交：`27df7e7cd2eda1698f96fbaa45c6d8cd801ad8bb`。报告提交和本阶段最终HEAD由随后STATUS及最终收口记录锁定，本文不自引用提交SHA。
- 候选：8个代码/测试文件；candidate SHA-256 `789a3820a67046af0ce3f23a8ab7e2953aa919a98479581f76fd2d944b5b5c7f`。既有12个代码文件与16个原生文件身份未变。
- 两个独立模块由GPT-5.6 Sol / High代理实施，非作者SPEC1→QUALITY1均PASS；无二次修复审查，没有重开旧模块审查。
- 仅本地合成开发，不push、不合并main、不安装/发布、无真实声卡或账号操作。Owner已明确继续软件开发至TASK079；这不解除真实输出Gate B或人工验收。

## 实际修复

1. 原启动Gate看到READY即清除唯一期限，随后无界等exit，且可能在stdio尚未close时报告成功。新helper把启动、首次READY后的退出、close与失败清理分别限定期限；成功须close/code0/signalnull及对应PASS。仅向自建且未退出的直接子进程发TERM→KILL；未close时释放父侧管道并返回失败，不承诺任意后代已经终止。应用输出受预算限制且不回传原始文本，构建继承输出保持。外层watchdog210秒覆盖内层预算，专用crash/vault/recovery标记不被READY替代。
2. 原合成startup/UI虽然隔离userData，仍解析home并进入真实旧配置迁移。现在Main用已有验证后测试标志选择无路径的synthetic-test内部请求，函数首先返回skipped_test；普通迁移流程未改。没有新增环境/IPC后门。旧合成fixture不再用于本阶段，未声称旧运行实际读取了什么用户内容。

## RED与验证

证据目录`reports/runtime/task-073-exit-lifecycle/`；各命令的完整日志、独立JSON退出码与候选身份留存。

| 验证 | 新鲜结果 | exit |
| --- | --- | --- |
| 旧启动等待真实Node RED | 2项均失败：READY后挂起、exit早于close；缺模块RED另计 | 1 |
| 旧迁移行为RED | 原3PASS、新3FAIL：路径getter及两种Main路径访问探针 | 1 |
| root独立focused | 启动helper11/11；迁移/环境/配置24/24 | 0 |
| canonical verify（类型/测试/生产构建） | Contracts134、Core957、Desktop461，双native启用，零skip | 0 |
| 安全 | 28/28 | 0 |
| 实际Electron | 4/4，含dev/prod启动、crash、合成safeStorage、同进程与冷启恢复 | 0 |
| 完整E2E | 80/80，双native开启，零skip，独立输出目录保留旧test-results | 0 |
| control-plane / boundaries / cycles | PASS / PASS / 216文件PASS | 0 |
| 两模块独立审查 | migration SPEC1/QUALITY1、startup SPEC1/QUALITY1 PASS | 静态审查 |
| 新本地应用包 | ASAR23与已验dist逐字节一致；原生16pin一致；整包codesign strict/deep通过 | 0 |
| 新包启动自退出 | 全新合成目录、现有STARTUP_TEST入口、无CDP；ready后app.quit，实际close code0/signalnull约703ms，无清理信号/残留 | 0 |

首个打包命令因未满足既有beforePack本地签名约束而exit1，未运行应用；按原准入设置关闭自动签名发现、identity=null及ad-hoc签名重置后打包exit0。未改安全Fuse值、sender规则或现有打包校验器。该命令配置错误不是产品RED，也不是包退出失败重试。

## 包退出证据的限制

新包直接启动并自退出已通过，但它没有执行旧的“冻结Plan检查后保留CDP连接退出”场景，也没有证明旧根CDP失败的具体根因。R-021旧15秒超时FAIL继续保留到后续全链路诊断，不用约703ms的新启动退出结果抹掉旧失败。未重放旧探针、未复用旧包或旧fixture。

R-022真实HAL资源静止/设备排空保证、真实输出配置认证、B01～B15、实际延迟分布仍NOT_RUN；隔离FakeDriver及先前76断言/sanitizer证据没有扩大为实机结果。formalReady=false保持。

## 接续

本阶段最终HEAD锁定后，下一软件任务建立`codex/task-074-recording-attempts`独立分支。TASK073完整硬件验收保持未完成；TASK074可以在显式测试驱动下实现状态机/事务/中断恢复，生产准入必须继续拒绝未认证设备。保留完整TASK064～079、R020容量、R021旧退出场景、R022真实HAL、TASK047真实歌词、TASK061发布准入及最终Owner验收，不据本地Gate标人工接受。
