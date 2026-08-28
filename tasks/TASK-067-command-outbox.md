# TASK-067：跨Renderer与应用重启持久命令outbox

## 身份与授权

基线 `a64a31a6f7fca9ae34ea112faba1f9c7a2c530e2`，分支 `codex/task-067-command-outbox`。Owner授权持续开发与GPT-5.6 Sol / High互斥范围并行。无push/main合并/发布，无真实账号、音乐、照片、库存或设备访问。TASK066旧工作树保持清洁。

## 范围

补齐既有所有稳定commandId的V3用户变更：库存/照片/实体音乐与关系、草稿/规划与预留、Profile、源证据与后台文件任务、取消撤权、备份维护、原生选择回执及显式激活回执。不把持久任务查询或会话闭包当成跨重启outbox。照片仅保留已规范化受限图片DTO，不保存原文件路径；原生选择保留公开参数，私有路径仍只在既有Core安全账本。原生对话框与激活使用专用恢复路线，不当作普通业务命令自动投递。

先落盘再发送，回执未知保留原DTO、commandId和fingerprint；Main保存成功但Renderer未确认仍可查看。重启不自动投递，恢复必须明确人工操作。明确冲突保留，不更改数量/版本/引用来绕过冲突；放弃跟踪不等于撤销业务。Main独立单写者存储，不与Core维护库争写。白名单之外不记录，Provider/凭据/播放/硬件控制全部排除。

复合PREP文件撤权必须整批先持久化：一次确认的A/B/Program请求不可仅留在Renderer逐项await闭包。专用批次限制1～3项同scope撤权，不同commandId与目标ID；持久化全部成功后才发送，部分结果未知保持每项原回执，重启不自动执行尾项。

工作库身份绑定原Renderer编辑上下文，并由Core最后执行边界再次核对。默认库具有稳定非null UUID；新建数据库换身份，恢复激活不能继承旧快照身份。切库后的旧命令保留隔离，不能发送时重新盖当前scope。原生选择只能查询旧回执或在用户明确重新选择后打开；激活重试先恢复持久终态，不二次停止或重启已激活Core。

## 允许路径与单写者

- Contracts 新command-outbox、必要index/ipc/validator及测试；Core dataset identity/restore-dataset-runtime/backup-workflow-store/runtime/utility-main及相关测试由契约与Core智能体负责。
- Desktop新command-outbox-store/service及独立相关测试由存储智能体负责。
- Desktop新CommandOutboxPanel.vue/测试与App.vue有界入口由UI智能体负责。
- 主任务负责Main index/supervisor、preload API/index、端到端测试、原生选择与激活特殊恢复汇合；必要共享文件改动先交接。
- tasks/ADR-027/TODO/STATUS/WAVE/索引/执行计划/结果报告/风险与本机证据由主任务负责。

## Gate

RED→GREEN；非法DTO、秘密/路径拒绝、双实例排他、真实Main崩溃窗口、回执丢失、无自动发送、原DTO重试、冲突、Renderer刷新/应用重启、数据集切换竞态、原生选择与激活特殊恢复、照片容量边界。最后SPEC后QUALITY最多两轮修复/复审；verify/security/Electron/完整E2E/control/boundaries/cycles与候选/提交身份复核。F-01、真实A～E/Owner和R-020规模carryover不因此关闭。
