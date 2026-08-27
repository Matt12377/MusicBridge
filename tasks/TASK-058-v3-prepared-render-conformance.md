# TASK-058：原始 Render、实际 Marker 与 Frozen PREP

## 身份与授权

基线 `9262dfd9a2338c5502a7d4c9328d18ee3fa89218`，分支 `codex/task-058-v3-prepared-render-conformance`。沿用 Owner 对完整 V3 的持续开发授权；真实文件、目标目录、账号与设备仍需显式授权。本阶段只用隔离合成 Render、目录、版本与介质。

## 范围

1. 从已完成 Preparation 和 Frozen Master/Layout 导入原始 Render。Cassette 支持 A/B，DAT 支持连续 Program。Main 原生选择文件，Renderer 不提交私有路径。记录原始字节 Hash、格式、采样率、声道、总帧和创建时间。
2. 明确确认后保存原始 Render 的独立持久化副本，保留来源/DAW/Processing Lineage。原始文件不被修改或由执行派生覆盖；保存位置、容量与复制边界必须在确认前明确。应用不得把工作区文件名或旧导出回执当成内容正确证据。
3. 显示 Planned Timeline，在最终音频时间线上逐曲校正实际开始/结束点。保留 trackId、源身份、实际帧位置、Gap、确认方法和用户确认。自动候选不能直接成为事实；不以总时长替代曲目、顺序与版本确认。
4. 建立独立 RenderTimeline 与有版本的精确容差策略，覆盖 MATCHED、ACCEPTED_VARIANCE、REQUIRES_NEW_LAYOUT、REQUIRES_NEW_MASTER、REJECTED。曲目/源/全局顺序改变要求新 Master；换面、结构性布局变化或容量不足要求新 Layout；允许的差异必须明确接受。
5. 冻结 PREP 永久绑定 Master/Layout/Planned Timeline/用户确认 RenderTimeline、Preparation ID、DAW/处理谱系与原始 Render 身份，Transition Rendering Mode 固定 Baked Into Render。不得再次插入曲间 Gap。
6. 新布局只影响兼容性显示，旧 PREP 对原版本和历史录音仍有效；不全局标记 Invalid。支持后台任务、取消、撤权、幂等回执、事务/文件发布故障与冷启动恢复。

## 验证与交付

TDD；原始文件与独立副本 Hash、帧精度、五种 Conformance 状态、Marker 人工确认、版本兼容性、路径/权限/容量/取消/撤权、数据库事务与发布故障、真实重开仓库、正式 IPC 与桌面 E2E。完成 verify、security、Electron、完整 Playwright、静态 Gate 与视觉核验后，独立实现/报告/状态锁定提交。

## 边界与后续

导入不自动控制 Logic，不连接真实 Provider/Roon 或硬件，不进行正式录音。Execution Derivative、RecordingPlan、输出认证、完整归档 Gate E、J-Card/备份及 Owner 验收仍需后续。F-01 执行资产保留策略保持未决，不用本任务擅自决定清理政策。完整 V3 目标不缩减为 PREP。

## 允许修改

Contracts 的 Prepared/RenderTimeline/Conformance 与 index/ipc/validator；Core recording、受控文件存储与 collection repository/runtime/utility-main；Desktop Main/Preload/录音与版本上下文组件；相关单元/E2E 与迁移夹具；本任务、索引、WAVE-5、STATUS、执行计划、ADR-018、结果报告及忽略证据。无远程传输、无真实源路径配置、无自动 Logic 操作。
