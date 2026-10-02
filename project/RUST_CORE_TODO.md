# Rust Core 开发进度

更新：2026-10-02。当前任务 **RUST-002：原子收藏快照与只读筛选 — 已完成**。分支 `codex/rust-core-002-atomic-snapshot`，工作树 `worktree/rust-core-002`。

此表随开发更新；只有实际验证通过的项目才打勾。默认应用仍使用 Node，真实账号、Roon、录音和用户数据不进入本期验证。

## 待办事项

### 后续升级路线（规划，尚未开工）

- [ ] 依据本期测量选定下一处实际瓶颈，确定 Rust 承担的计算及 Node 保留的控制职责。
- [ ] 规划大于 2,000 型号时的完整性与内存预算，避免用截断或跨时刻分页扩容。
- [ ] 设计快照版本、刷新与失效通知；验证切库、关闭和旧响应不能覆盖新状态。
- [ ] 为确认有收益的查询建立 Rust 索引及差分/规模回归，记录首次建立和重复查询成本。
- [ ] 建立可选路由与可观测状态，保留明确的故障语义和 Node 读取路径。
- [ ] 验证 macOS 架构、打包资源、签名与二进制身份准入；生产默认启用单列验收。
- [ ] 对可能的 Rust 持久化阶段梳理 schema、跨库事务、幂等回执、未知结果、不可变历史和恢复合同；在完整兼容证据前保持 Node 唯一作者。
- [ ] 准备真实环境验证材料，分别记录 Roon、播放、录音和 Owner 结果；本地合成测试不替代这些验收。

## 已完成事项

### RUST-002

- [x] 从 RUST-001 最终 HEAD 建立独立分支和工作树，确认外置构建目录及冻结依赖。
- [x] Node Owner 完整原子快照导出：一次 SQLite 读事务，最多 2,000 型号，保留顺序、库存与照片；超限或损坏拒绝。
- [x] Node 导出新测试 9 项及相关回归合计 80 项通过；类型检查退出 0。
- [x] 真实 Node 两库 → Rust 的 2,000 型号差分测试通过：27 种筛选、108 个分页结果与 SQLite 一致。
- [x] 验证筛选在分页前执行、total、稳定顺序、中文/Unicode、字面 `%`/`_`；验证导出后写入不污染旧快照，显式新快照反映变化。
- [x] 局部启动超时、迟到结果、源 Owner 失败、身份变化、预算超限、坏回执和自然关闭测试通过。
- [x] 已补齐 Node 私有导出、Rust v2 协议和 ADR-039。
- [x] TS v2 筛选与只读回执校验、Owner 显式工厂和整体单调期限已实现，并通过故障与真实二进制测试。
- [x] Rust v2 搜索、品牌、年代、库存及组合筛选已实现；保留 v1、绑定版本、拒绝越界投影。
- [x] 两项独立审查问题已修复并复审：合法 UUID v1～v8 工作库身份保留，macOS CI 临时目录准入。
- [x] 最终 Rust Gate 通过：Rust 26 项、TS 故障 35 项、Node 原子快照 9 项、真实二进制集成 9 项，无新增跳过；281 份源码与新二进制身份稳定。
- [x] 完整工作区 typecheck、3,544 项单元测试、生产 build、control-plane / boundaries / cycles 均通过；仅保留原有 2 项 native 条件跳过。
- [x] 补齐 Desktop 边界测试的 Rust 工作流 fixture，保留全部拒绝断言，完整门禁已重跑通过。
- [x] 完整调用成本已记录：2,000 型号导出约 58 ms、完整启动约 124 ms、关闭约 2.5 ms；单一 warm 查询中位 Node 3.963 ms / Rust 含 TS 校验 1.950 ms，不冒称生产收益。
- [x] 最终源码、日志和二进制摘要已核对；STATUS 与 TODO 已更新。
- [x] 实现提交与最终报告分别保存；下一阶段从最终报告 HEAD 接续。详见 [RUST-002 报告](../reports/RUST-002_ATOMIC_SNAPSHOT_QUERY.md)。

### RUST-001：只读 sidecar 原型

- [x] 冻结 TS/Rust v1 进程协议和生命周期。
- [x] Rust 只读快照进程与显式 TS 适配器；生产默认路径保持 Node。
- [x] 本地 Gate：Rust 16 项、TS 故障测试 25 项、真实 Rust 集成 5 项；完整 Node 测试 3,525 项通过，保留原有 2 项 native 条件跳过。
- [x] 实现与报告分别提交；最终基线 `abc716686061811cd708eeb733e81ec82a1e93b9`。

报告：[RUST-001_READONLY_SIDECAR.md](../reports/RUST-001_READONLY_SIDECAR.md)。

范围：[RUST-002-atomic-snapshot-query.md](../tasks/RUST-002-atomic-snapshot-query.md)。证据目录：`/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-002-kupkidlt`。

## 保留的验收边界

- 默认 Node 控制面和数据库唯一写入所有者保持不变。
- 真实 Provider/Roon、录音、Owner 验收、安装替换、远端 CI、push 和发布均未执行，不由本地测试代替。
- 后续阶段依据本期真实结果继续规划；完成本期后以最终报告提交作为下一分支基线。
