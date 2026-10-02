# RUST-003：快照版本、刷新与可选读取路由

状态：本地完整软件与 Rust Gate、两轮独立审查通过。显式可选原型已实现，生产默认仍为 Node。

## 身份

- base SHA：`763b5c62283978c3ab4981c9cce60f4237d1f051`，RUST-002 最终报告提交。
- 分支：`codex/rust-core-003-snapshot-refresh`；工作树：`/Volumes/LifeWeave/VSCode/MusicBridge/worktree/rust-core-003`。
- 实现提交：`5194c5c09fe013b032c6d0ef3c199cdd7b57c84b`。
- 报告提交：由 `git log -1 -- reports/RUST-003_SNAPSHOT_REFRESH_ROUTING.md` 解析最终提交，避免自引用 SHA。
- 下一分支基线：本报告最终提交 HEAD。
- 远端分支复核：`git ls-remote --exit-code --heads origin refs/heads/codex/rust-core-003-snapshot-refresh` 退出 2、无匹配引用；本期未 push。
- 本期使用 4 个显式 gpt-6.1-sol/high 子代理，按平台槽位分批负责 Node、路由、实际进程集成和独立审查；主代理负责整合、修复、门禁和交付。

## 行为变化

RUST-002 的旧快照在 Node 后续写入后仍保持导出时刻的事实。本期为 Node 唯一所有者增加同一 SQLite 连接的 data_version / total_changes 只读探测，生成实例内 opaque revision。稳定读取不改令牌；同连接行变化、回滚中的写入和其他合成连接提交均有行为证据。版本化导出在既有同步完整原子导出两侧比较 stamp，身份或版本改变整体拒绝；stamp 数值复制避免复用对象改写前一观测。

新增私有 `getCollectionSnapshotVersion`、`exportVersionedCollectionSnapshot` 和扩展 Node 端点。原快照 API、公开 208 命令、工作库 UUID v1～v8、schema、2,000 型号/4 MiB、Rust v1/v2 帧及数据库唯一作者保持。Native 计算程序本期没有变更，复用 RUST-002 固定二进制。

新显式 `createRustReadonlyCollectionRouter` 借用已 boot Owner，初始 Node，显式刷新才建立 Rust；不 boot/close 来源、不自动重试或重放。刷新共用一个整体单调期限，旧 child 收口后才建立新 child。Rust 读取前后各探测版本，前置变化可读尚未发出的 Node 请求一次，后置变化拒绝旧结果，不静默重读。刷新、失效、关闭和 scope 变化撤销发布权，迟到候选只清理。已审定纯收藏读取 list/detail/copy/photo 具有 Node 代次围栏；其他命令保守视为潜在写入，仅发 Node 一次，保留成功与 unknown 原回执。

公开 collection.list 当前拒绝 readContext。本路由将其交给 Node 保留原失败，不冒称该字段已支持，也不向 Rust 发送。内部 status 仅暴露固定状态、身份、代次与封闭错误码。

协议：[路由 v1](../docs/contracts/rust-readonly-router-v1.md)；决策：[ADR-040](../docs/adr/ADR-040-versioned-readonly-routing.md)；范围：[RUST-003](../tasks/RUST-003-snapshot-refresh-routing.md)；进度：[TODO](../project/RUST_CORE_TODO.md)。

## 审查与修复

第一轮独立审查发现一项 P2：工厂尚未返回时 prepare/boot 失败，路由还没有取得候选，工厂清理失败被原错误覆盖；连续显式刷新可能在旧 SIGKILL child 尚未退出时再启动，路由 close 也可能错误成功。

修复为内部候选登记回调，在任何原生 prepare/boot 之前把资源登记到路由。失败候选也进入退役队列，关闭失败保留并阻断下一 child。三个 prepare / commitBoot / timeout 加延迟强杀退出测试修复前均失败，修复后全部通过；调用 kill 不等于自然退出。原工厂公开单参数调用兼容，回调不进入 options JSON、线程或 Rust 帧。

两轮独立审查后剩余实质 P1/P2 为 0。最终审查文件为证据根的 `review-final.json`，SHA-256 `8d484359e1446f271c67c8e0175f78a30301d97e65c995c34871d88c98704135`。主代理另修复来源 scope 回退、已确认写回执被代次覆盖、发布后 fatal 闭包、历史端点强引用、可变 options 与缺省 expectedDatasetId 等边界，并补入最终行为回归。

## 验证

全部本机构建、缓存、临时数据和日志在已确认挂载且可写的 LifeWeave 外置卷。证据根：`/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-003-nlk69h67`。

| 检查 | 最终证据 |
|---|---|
| 固定实际 rustc/cargo 1.95.0、fmt、clippy -D warnings、locked build | PASS，退出 0 |
| Rust v1/v2 | 26 通过，0 失败 |
| 原 TS sidecar / Node 原子快照 | 35 / 9 通过，0 失败、0 跳过 |
| Node 版本 / 路由故障 | 11 / 36 通过，0 失败、0 跳过 |
| 实际 Node 两库/Rust | 16 通过（原 9＋本期 7），0 失败、0 跳过；本期 2,000 型号固定 32 差分页 |
| 全工作区类型检查 / 生产构建 | PASS，退出 0 |
| 全量单元 | Contracts 254 / Core 2,098 / Desktop 1,239，共 3,591 通过，0 失败；原有 2 项 native 条件跳过名称相同，无新增跳过；退出 0 |
| control-plane / boundaries / cycles | PASS，各退出 0；cycles 381 文件 |
| diff / JSON / 提交及工作树身份 | diff 与 JSON 退出 0；实现/报告分开提交后核对清洁及报告身份 |

最终 Rust manifest：`rust-gate/run-zPbgWm/manifest.json`，13 步各 exitCode=0、signal=null，286 份源码与日志摘要均匹配；成本、二进制摘要一致。候选 binary：`cargo-target/release/musicbridge-rust-core`，SHA-256 `55043d477e44ce62ead4bca264e7d7fce89bb90f1d312973ae23e89f2075f6ac`，与原 RUST-002 native 程序相同。原两期工作树及各自二进制保持。

完整 software manifest：`software-final/software-manifest.json`，1,047 份代码、测试、锁与构建文件的开始/结束指纹一致，六条完整验证日志退出 0；报告整理未修改受测代码。实际新集成第一轮 6/7，失败来自测试误以为 Node 接受 collection.list readContext；改为验证保留同一合法失败且零 Rust dispatch 后，二轮 7/7、最终同目标 Gate 通过，首轮失败日志保留。测试期 contracts 未 build 的首次加载阻断未作为代码 RED。

## 完整成本与结论边界

最终 Gate 2,000 型号、warm Node Owner、OS 缓存未控制：显式刷新 **123.369 ms**，关闭 ACK 加自然退出 **3.068 ms**。10 次固定查询的 Node roundtrip 中位 **3.778 ms**；Rust 包含前后两次 Node 版本 RPC、进程往返和 TS 完整事实校验，中位 **2.440 ms**。数据来自本轮 `refresh-routing-cost.json`，原始逐次值及对应二进制身份保留。

这是一个合成规模和一种 warm 查询的结果，不证明真实库、冷盘或整体应用收益；刷新成本不能省略。后续先比较实际热点和多种工作量，再决定计算迁移及索引，不只引用裸 Native 时间。

## Carryover 与交接

默认 Node、唯一数据库作者保持；没有真实用户库、数据迁移、Provider/Roon、播放、录音、Owner 验收、全量 Electron E2E、安装替换、remote CI、push 或 main merge。MBR-004 真实恢复与 Gate B/P4/P5 原 carryover 不提升。

本期采用按读取探测，没有后台失效推送或自动刷新。大于 2,000 型号、完整 208 命令迁移、持久化写入、默认启用和签名分发分别待办。下一任务从本报告最终提交 HEAD 接续；本地版本控制交付不等于真实产品验收。
