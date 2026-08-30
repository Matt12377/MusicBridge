# TASK-063：归档授权、执行谱系与桌面确认

## 身份与结论

- 基线：`4cdffc25cae80aa80003d1b331025d1a9b5fbcd3`，TASK-062 最终状态锁定提交。
- 分支：`codex/task-063-archive-workflow`。
- 实现提交：`ddee7e5f724bedbeb155c310f3a90873cd91b7ab`。
- 报告提交：包含本文件的独立提交；精确 SHA 记录在下一状态锁定提交的 `project/STATUS.json`。
- 结论：本任务限定的归档工作流通过本地自动验证。完整 V3、完整 Gate E、正式录音和 Owner 验收未完成。0 子代理；无 push、main 集成或发布。

## 实现范围

原生选择归档父目录仅持久化授权候选，不创建归档文件。用户明确确认初始化后，先将 owner nonce 意图写入 SQLite，再建立应用独立子目录；文件成功而 DB 回滚时可用同一意图恢复，不接管未知目录。Root 初始化也支持并发幂等重试、关闭和撤权中断。schema14 保留已有内核 Root，并新增不可变工作流命令账本。

内容预览不写归档文件或创建归档操作。源政策初始未选择，必须明确选择 Reference Dependent 或 Preserve Exact Sources，再确认归档提案。文件、Root 身份、冻结谱系和容量在确认时重新核对。原命令重复 start 先返回持久操作，不因原源目录后来离线而生成第二份归档；已消费的取消不会取消后续恢复。

四条执行路径分别保留实际执行音频、Direct 转换中间文件、原始 Manifest、冻结 Master/Layout/执行参数事实。PREP 同时保留原始 Render、原 Manifest 和冻结 PREP；原件引用可用两条角色引用共享同 Hash 对象，派生不会代替原件。精确源复制只读取冻结 Hash/长度对应的当前明确授权绑定，不查找同名文件或扫描整库。源内容、inode、mtime/ctime 的保护有测试。

后台操作沿用 TASK-062 的分阶段文件/SQLite协议，新增读取取消、总体期限、Source/Preparation/Archive 撤权和关闭订阅。已暂存操作可在源离线时恢复；失败/取消部分文件保留。历史 FINALIZED 与当前完整性核验分开，损坏对象不覆盖，已提交引用不伪撤销。后台恢复不阻塞普通读取的取消。Source Root 不允许覆盖已有或待初始化的 Archive Root。

正常/合成 runtime、正式 utility IPC、Main 原生选择、preload 与既有 ExecutionPanel 内联界面已接通，无新永久导航或嵌套 dialog。未知回执保留原命令重试，返回执行资产保留参数界面与焦点。设计见 [ADR-023](../docs/adr/ADR-023-archive-workflow-confirmation.md)。

## 新鲜验证

Node22.23.2 / pnpm10.17.1。实现提交共41个明确路径，其中35个代码/测试文件，6个控制/设计文件。运行证据和 native bundle 不进 Git。

| 验证 | 结果 | 退出码 |
|---|---|---|
| 根 verify | Contracts71 / Core704 / Desktop179，类型、测试、构建全通过 | 0 |
| 归档工作流 | 23项，含4类执行谱系、SQLite冷连接、撤权/取消/恢复、初始化和读取期限 | 0 |
| 文件/事务内核 | 26项，包含在完整Core回归中 | 0 |
| Security | 22/22 | 0 |
| Electron 生命周期 | 4/4 | 0 |
| Playwright | 49/49，显式启用固定原生转换器 | 0 |
| Control / Boundaries / Cycles | PASS；155源文件；Control仍只覆盖旧WAVE-3 | 0 |
| 确切候选/暂存检查 | 41路径允许集一致，35代码/测试blob复核，cached diff通过 | 0 |

扩展桌面测试从原生目录选择、独立初始化、无默认源政策、只读预览到后台归档与核验，实际使用合成WAV/SQLite。归档start回执丢失后重试只保留一操作；原源字节不变。720px无横向溢出，axe无critical/serious问题；应用重启后历史保持且可再次核验。已查看归档窄窗截图。此处不是用户真实音乐、真实Logic、实际Provider/Roon或声卡/磁带录音证据。

固定原生 bundle 复用 TASK-062 已核定候选，manifest SHA-256 为 `d552121ea60fdc4d86e7e697503e6208152679f1fad58d1ed48a59a79af597cc`，复制前后相同。完整E2E包含该候选的实际转换、验证和冷启动，不因此获得输出后端认证或分发许可。既有内核的真实子进程SIGKILL用例包含在本次Core回归中；新增工作流故障以受控异常、实际冷连接和应用重启覆盖，不宣称物理断电/拔盘测试。

本机证据目录：`reports/runtime/task-063-archive-workflow`。最终主日志为 `final-verify-eof.log`、`security.log`、`electron.log`、`final-e2e.log` 及三项静态检查日志。`e2e-final-artifacts` 保存全量桌面产物，`final-candidate.json`/`staged-files.json` 保存候选与暂存身份，`spec-quality-review.md` 保存主代理自查。未提交运行产物或合成私有目录。

## 失败记录与自查

缺API的首次RED仅算接线。后续行为RED覆盖确认账本、初始化生命周期、Source重叠、错误公开边界与后台恢复阻塞读取取消。修复了返回执行界面重挂Profile导致的焦点丢失；保留原面板挂载后E2E通过。测试曾错误发出不在IPC合同中的BAD_REQUEST，导致模拟响应被丢弃；改用合法INVALID_IPC_REQUEST后Supervisor/Preload19项通过。UI按实际combobox角色定位。所有失败日志保留，不放宽生产验证来迎合测试。

暂存检查发现新复用夹具末尾额外空行；仅规范EOF后再完整运行verify，仍为71/704/179通过。生产与E2E文件blob未变，夹具旧/新blob另有记录。曾一次调用错误的cycles路径；之后正确scripts/ci入口独立执行退出0，不将错误命令冒充成功检查。

SPEC → QUALITY：先规格、后质量的主代理自查，不是独立审查。没有开放任意路径IPC，未扩大网络/输出权限，没有以归档结果伪造正式录音或库存变动。

## 接续与验收边界

下一任务从本任务最终状态锁定HEAD创建独立分支，不能从实现提交跳接。精确最终SHA与下一基线写入本机final-closeout.json，并由后续STATUS/base锁定。

F-01仍无Owner明确答复，不冻结正式RecordingPlan/Attempt、不决定永久保留或自动删除。接续可独立推进一致性完整备份/恢复与剩余功能；完整Gate E、Quarantine管理、Replica、J-Card、正式预检/输出认证/录音状态机、实体完成同步、参考目录/Excel/Want List、PRD30项与A–E/U-01–U-10、Owner验收全部保留。TASK-047实际歌词、跨Renderer/应用重启outbox、既有视觉carryover和TASK-061分发准入不自动关闭。

当前仅已验证本地硬链接/fsync文件系统；多应用实例共写、任意NAS/FAT不在已验证支持范围。未push，远端无对应分支，main仍为90d0aa8。本地测试和提交不构成GitHub交付、公开发布或Owner产品接受。
