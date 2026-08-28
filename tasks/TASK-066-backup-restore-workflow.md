# TASK-066：备份恢复工作流、位置绑定与桌面确认

## 身份与约束

基线 `abbd2fc230956103a2a22c3c9555e65f9c653a81`，独立分支 `codex/task-066-backup-restore-workflow`。Owner 持续开发授权；2026-08-28 最新授权允许按独立文件范围并行，智能体统一 GPT-5.6 Sol / High。不 push/main 合并/发布，不访问真实账户、源目录或设备。

## 实施顺序

1. 全局备份恢复概览合同与 Main/Core 内部原生目录能力授权；Renderer只持有ID和有界摘要，不接收绝对路径。
2. 持久后台备份/恢复任务、独立确认账本、查询取消与冷启动中断处理。稳定请求ID不能改成不同参数；未完成目录不能直接覆盖重试。元数据与内容备份范围分开。
3. Backup Archive Now 和备份包验证/恢复候选/索引问题查看入口，位于既有录音上下文，不新增永久导航。选择目录与预览不代表写入确认。
4. 已恢复内容的新位置绑定与历史引用保留；不删除触发器改写历史路径。恢复数据库、根位置映射与当前工作库切换有独立确认/收据，不覆盖旧库，不激活未经核验的候选。
5. 激活涉及Core生命周期及播放影响，必须明确告知并确认；崩溃窗口、回滚/冲突、切换后的备份再恢复需要真实合成进程验证。没有完整取证不能称恢复产品已交付。
6. Main→Core→SQLite/文件→Renderer 合成E2E、应用重启、回执丢失、键盘/窄窗与V2回归。

## 架构记录要求

持久工作流状态不能在恢复旧快照时丢失；位置绑定与激活意图在 ADR-026 定义后实施。当前未决定全局清理/永久保留政策，F-01待Owner，正式Plan/Attempt不解锁。基本索引的未知字段与Quarantine问题保持可见，不伪造历史事实。

## 允许路径

- Contracts 新 `recording-backups.ts`、index/ipc/validator/errors 及相关测试。
- Core `recording/backup-*`、`restore-*`、必要的archive存储/读取位置映射、`collection/`数据集位置与迁移、runtime/utility-main，以及对应测试/fixture。
- Desktop main/preload/supervisor、RecordingView及新增备份恢复组件/composable、必要的既有单测与E2E。
- 当前task、TODO、索引、WAVE-5、STATUS、执行计划、ADR-026、报告与本地证据。无新增第三方依赖的默认需求。

## UI约束

沿用已有Vue 3组件与设计token。已读取 ui-ux-pro-max，并查询UX/Vue规则：键盘焦点可见、错误靠近对应步骤、异步副作用卸载清理、窄窗不横向溢出。当前是既有页面的上下文工具，不重新生成设计系统或引入新的表单/状态库。

## Gate

先API缺失/行为RED，逐层GREEN；最终verify、安全/Electron/E2E与control-plane/boundaries/cycles，提交候选与报告身份分开。仅有Core和隔离复制不关闭完整Gate E或Owner接受。


## Owner 接续授权（2026-08-28）

Owner 要求全速推进，已定位的测试接线问题按推荐路线继续，不逐次停下来征求同意。解除此前 E2E 停修；保留失败证据。测试窗口默认后台隐藏并保持渲染，真实窗口恢复专项使用 showInactive，不改正式应用行为。该变更属于本任务 Main/E2E 允许路径。

Owner 进一步授权自主调度并行模块，不逐次询问：本轮由主任务接位置绑定/显式激活，三个 GPT-5.6 Sol / High 智能体分别负责维护库存储安全、索引问题明细、后台 E2E 类型与焦点约束。各范围单一写入者，汇合后统一验证；局部 GREEN 不替代整任务 Gate。

## 收口

本地自动Gate通过，见结果报告。额外允许desktop/package.json标准E2E类型接线及project/RISK_REGISTER.md风险记录。SPEC主任务裁决后QUALITY主任务带有界容量carryover通过；无真实环境或Owner接受。
