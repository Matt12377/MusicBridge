# TASK-060：录音 Profile、Session 参数与持久化执行资产

基线 `d3c093947a3661da684e7780e49eb2ebd4a5b46a`，分支 `codex/task-060-v3-execution-assets`。完整 V3 持续开发授权，0 子代理；本阶段全部使用隔离合成文件、资料和目录，不 push，不连接真实账号、Roon 或输出设备。

## 范围

1. 可复用 Recording Profile：有序设备/连接链、默认 NR、校准习惯、录音电平、手动预卷时长、介质兼容和显式 ExecutionFormat。保存产生不可变版本；并发修改、同命令重试、回执丢失、事务失败和冷启动保持一致。用户填写的后端/版本是计划参数，不是后端注册或认证。
2. 每份草稿保存所选 Profile 版本与 Session Overrides，仅覆盖本次变化的 Record Level、Calibration、NR、临时设备链。解析出独立有效参数；修改 Profile 默认值不反向修改旧任务。手动预卷不重复加入已冻结 Lead-in 或 Render 音频。正式 RecordingProfileSnapshot 仍在后续 Plan Freeze 建立。
3. 从 Frozen M/L 或 PREP 及所选参数预览执行资产。明确显示输出格式、版本、目标目录、容量与未正式就绪状态；确认前不写文件。复用 TASK-059 进行整数 PCM Direct 编译及 Prepared 原件引用，未实现转换显式阻断，不暗中替换源/输出格式。
4. 持久化执行任务、逐面进度、取消/撤权、独立 owned 输出目录、文件/Manifest 发布与 DB 提交。恢复只重新验证完整产物再幂等补交，不自动重放编译。无完整文件/Hash/归属则拒绝成功。Prepared 继续引用保留原件，不二次复制或加 Gap。空 B 无占位文件。
5. 保存不可变资产元数据、Profile/Overrides 有效参数、帧清单、各面 Hash 和谱系；历史显示与当前参数分离，支持重新验证实际文件。不把历史完成回执等同当前文件仍可用。
6. 在既有录音上下文接入 Profile、Session 和执行准备面板；不新增设备页或侧栏。原生目录授权、明确确认、失败重试、焦点/键盘、宽窄窗和真实 IPC 的合成闭环。

## 边界

本阶段执行资产尚不可用于正式录音：F-01、Archive Policy、输出认证、设备就绪、完整 Preflight 和 RecordingPlan 仍未完成。资产暂不自动删除，不把未定保留策略写成永久归档承诺。不开始 Attempt，不播放音频，不操作真实磁带/DAT。混合格式解码/SRC/Derivative、正式引擎、停止延迟、完整归档去重/备份/J-Card、参考目录/导入和 Owner 验收继续保留。

## 允许修改及验证

Contracts 的录音 Profile/Session/执行资产合同、IPC/validator/index；Core recording、受控文件存储、repository schema 与 runtime/utility 接线；Desktop Main/Preload/录音面板；相应单元、迁移、IPC/E2E 测试；本任务、索引/WAVE-5/STATUS/执行计划、ADR-020、报告与忽略证据。先测试后实现；API 缺失只记合同接线 RED，行为失败独立留证。最终 verify/security/Electron/完整 Playwright、静态 Gate、视觉和实际文件验证后，独立实现/报告/状态锁定三提交。
