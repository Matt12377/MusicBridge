# ADR-MBRS-001：真实基线与单一权威

日期：2026-10-04。状态：本轮隔离开发有效规则；生效提交由提交后 `git log -1 --format=%H -- docs/adr/ADR-MBRS-001-BASELINE-AND-OWNERSHIP.md` 解析。不是实机或源写许可。

当前基线为 RUST-015 最终报告 `044e6b24edf81b64030d4c96741082670532971c`，实现为 `8c58fdee4309a781dbf6640d8aeba46bb8fe1bd3`。采用明确阶段交接的隔离准备，完整迁移未完成。R15-C06 未闭合，产品 G0 仍 NOT_ADMITTED；不把它转交给依赖 G0 的后续 MBRS 任务制造循环。

当前 Node dataset-owner worker 唯一业务库作者，Main 唯一 outbox 作者，BridgeController 唯一播放 / 队列 / 代际权威，Rust 只作为默认 OFF 的可选收藏只读查询。新增本地对象和扫描沿现有 owner 接入，不能顺手建立第二库权威或宣称 writer 已迁 Rust。

每个当前未完 Rust TODO 有一个主任务与来源 blob / 行号；转交只增加引用，不能改 OPEN 为 PASS。新数字曲目与既有收藏快照分模型 / 成本 / 资源验收，复用测量方法不互换结论。

验证范围为本轮基线、复用、所有权、台账结构与 Git 关联。旧软件 / App、真实 Roon / 音频、Owner 使用反馈分层；后续新来源 / 权限 / unknown / 生命周期变化需要对应新行为证据。回退删除本轮新规则引用与文件即可恢复原基线；本轮没有生产数据库 / 文件变更。
