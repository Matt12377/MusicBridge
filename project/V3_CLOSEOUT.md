# V3 软件收尾

## 结论

V3 产品软件范围止于 TASK-079。TASK-080～084 是在 TASK-079 之后完成的 capacity authority、issuer、failure-lineage 与 runtime relocation Harness 加固；这些改动保留在收尾候选中，但不扩大 V3 产品功能范围，也不作为阻塞构建和人工验收的新增前置条件。

本次收尾冻结所有新的 capacity authority、recovery 和 window。已有窗口及失败事实保持只读、不可重放；objects-limit queued-stop 与 joint generation/measure/queued-stop 的正式结果继续为 `NOT_RUN`，不伪装为通过。

## 收尾候选

- 分支：`codex/task-084-capacity-path-remap`
- 收尾起点：`67df2986d35aa98aa067b49c7efa1d92dc262c5d`
- 产品软件边界：TASK-048～079
- 保留的非阻塞 Harness 加固：TASK-080～084
- 收尾结果：见 `reports/V3_SOFTWARE_CLOSEOUT_RESULT.md`

## 唯一自动收尾序列

1. 固化并推送收尾路由提交。
2. 在该候选提交上执行一次标准 `pnpm verify` 和 control-plane、boundaries、cycles 静态 Gate。
3. 执行生产构建、无签名本地打包和启动/正常退出 smoke。
4. 记录候选 SHA、命令退出码、产物路径与摘要。
5. 打开候选应用与 Owner 人工验收清单。

不再运行新的 capacity window，也不通过反复重跑同一聚焦测试延迟收尾。

## 证据边界

自动验证只能证明候选代码、构建产物和受控 synthetic/mock 路径。以下项目保持独立，不因软件收尾而升级：

- 真实声卡、卡座、HAL 生命周期与 Gate B；
- 真实 Source Roots、库存、照片、Excel、Logic、Roon 与录音输入；
- 可听 Digital Replica；
- 实体 J-Card/纸张打印；
- macOS 签名、公证、安装与 Beta 发布；
- Owner 的产品功能、视觉和实际工作流接受。

## 停止条件

自动收尾完成后停在 Owner 人工验收处。任何真实凭据、设备配置、媒体写入、发布、PR Ready/merge 或 `main` 更新，继续保持单独 Gate。
