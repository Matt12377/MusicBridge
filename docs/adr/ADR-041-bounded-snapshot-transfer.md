# ADR-041：完整原子快照的有界传输

状态：RUST-004 可选只读原型；生产默认保持 Node。

现有 Node 支持大于 2,000 型号的总库；Rust 原型 v2 的完整事实限制是 2,000 / 4 MiB。直接扩大单帧会放大管道与临时缓冲，公开多页又会混入不同写入时刻。先把完整性、传输和累计资源边界证明清楚，再决定索引及计算迁移。

选择单独 profile `'v3-5000'`：Node 在一次同步只读事务导出完整 5,000 / 8 MiB 版本快照；Rust 使用 manifest、固定 128 型号块、准确 ACK 和完整 commitBoot。每帧、累计规范快照与原始上传各有固定预算，缺块和错误不能准入部分集合。v1/v2 与默认旧 profile 保留，缺少大能力不降级。

继续借用 Node 唯一写入所有者。不改变 schema、Provider、Roon、播放/录音和公开 API，不复制生产 SQLite 或迁移真实数据。v3 候选在 close/invalidate 时立即封闭，在途块收口后自然退出；同一整体单调期限覆盖完整启动，强杀不能代替成功 close。

代价是导出时仍完整持有 Node DTO，TS 保留一次不可变副本，Native 持有只读 JSON 事实；分块只是控制传输帧，不等于无整库内存或硬 RSS 上限。后续应依完整多工作量成本决定索引和迁移收益，不能只比较裸 Native 时间。

合同见 [v3](../contracts/rust-readonly-sidecar-v3.md)，任务见 [RUST-004](../../tasks/RUST-004-bounded-snapshot-transfer.md)。默认启用、签名分发、超过 5,000/8 MiB、实时推送与持久化写入继续单列。
