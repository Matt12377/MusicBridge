# ADR-032：不可变录音计划、参数快照与执行准入

状态：TASK-072 实施中。前置：Owner 于2026-08-28确认 `f01-permanent-execution-v1`；基线 TASK071 `6323b3431ec7beeaba851155c062f9fae4bf41ea`。

## 决策

PRD58～60的 Profile Snapshot → RecordingPlan Freeze → Preflight 是不同阶段。ADR019曾把后端认证列入正式冻结前置；本决策细分为“资料身份冻结”和“正式执行准入”：可以保存不可变计划，不能因此授予输出权限。后端认证/实时设备状态属于可信Core Preflight，TASK072固定 `BACKEND_NOT_CERTIFIED` / Gate B `NOT_RUN`，没有开始播放、Attempt或自动回退接口。TASK073补后端证据后也必须重新预检，不回写旧计划。

冻结取当前明确Session的Profile版本和Overrides，复制完整有效值及session revision。执行资产另保编译时settings；两者ExecutionFormat含outputProfileVersion必须一致。仅NR/电平/校准/临时设备链变化无需重编译，但必须产生新的计划快照；异步核验期间参数、规划或实体发生变化时旧proposal失效。以后修改默认Profile不能影响旧Plan。

Plan保存明确Master/Layout、PlannedTimeline、Prepared与RenderTimeline（适用时）、已核验ExecutionManifest与音频hash、PhysicalCopy及预留归属、归档操作与F01政策。不能从各集合取latest拼接。选择依赖只能是明确ID和CAS，Renderer不能提交自称已验证的数据或设备认证。

## 保留与备份

成功实际执行音频及谱系永久保留；Prepared原始Render永久保留；原始源遵循本次明确选择的归档策略。失败/取消无自动删除，本片不提供清理命令。精确重播需完整的历史执行音频；重建需相应源与转换器等依赖，缺失不承诺可重建。

冻结只接受FINALIZED且无issue的归档，与资产和manifest一致并做当前字节校验。此前操作只保存历史未决政策，不能改写；新Plan保存已批准政策。完整备份包含归档内容；metadata备份不包含音频。新备份不再附加政策未决标记，验证器兼容旧包原标记，仍不授予恢复路径权限。

schema18增加不可变计划和幂等账本，SQLite Backup快照及只读完整性验证覆盖新结构。固定schema14～17备份兼容；恢复后的原源/归档路径仍未授权，历史Plan保留，Preflight保持阻断。

## 并发与用户体验

预览与预检只读；freeze经现有持久outbox写入，用commandId+完整请求fingerprint去重，同body返回原结果、异body拒绝。文件核验后事务内重查数据库依赖，再写不可变计划。面板明确选择资产和归档，错误不装空列表；一次只呈现一个主要下一步，不新增永久导航。

## 验证边界

自动合成数据覆盖容量、依赖变化、归档缺失/变化、事务回滚、幂等、恢复撤权、参数历史、输出未认证。SPEC先QUALITY、每类最多两轮。真实设备、实录、听感及Owner验收没有因此通过。
