# Rust 只读快照进程

本原型只接受调用方提供的完整公开 `CollectionModel[]`，不读取数据库、网络、凭据、音频或设备。正式 Core 入口继续使用 Node。

私有协议见 [`rust-readonly-sidecar-v1.md`](../../docs/contracts/rust-readonly-sidecar-v1.md)。每个 UTF-8 JSON 行最多 4,194,304 字节，不计 LF；严格拒绝各层重复键、未知字段和不完整末帧。快照最多 2,000 个型号；进程最多 65,536 个请求，最后一个序列位只供 `close`。安全信封下的业务错误只返回固定中文；坏 JSON、UTF-8、信封、重复请求、非连续序列直接非零退出，不输出输入或原生诊断。身份围栏、容量错误会清空快照并结束进程。

显式 `snapshotProfile: 'v3-5000'` 使用 [`v3`](../../docs/contracts/rust-readonly-sidecar-v3.md)：最多 5,000 型号 / 8 MiB 完整快照，manifest 后按 128 型号发送 `appendSnapshot`，最多 40 块。逐块精确 ACK、跨块 ID 和完整数量/字节验证后才可 `commitBoot`，缺块不能返回部分集合。默认 v2 的原预算保持，不静默扩容或降级。

`prepare` 只加载一次，成功时绑定协议版本与快照身份，`commitBoot` 后才可读取。v1 `dispatch` 仍仅支持无筛选的 `collection.list`，请求/响应形状和非空筛选的拒绝规则不变。v2 `dispatch` 必须带 `{request, filterProjection}`，允许公开 `query/brand/decade/stockState` 筛选；所有条件在分页前共同应用，保持快照次序与全部公开字段，`total` 为完整命中数。两个版本的 prepare ready 结果均只有原来的六个字段，后续帧不能切换版本。

v2 的 `filterProjection` 只允许 `query/brand` 字符串，分别在原公开字段经 JS trim 后非空时必填，否则不得提供，每个投影最多 8,192 UTF-8 字节。TS 负责 NFKC、trim、空白合并和 Unicode 小写；Rust 接收投影，只对原型号文本进行 SQLite 一致的 ASCII 小写转换。query 在 `brand + ' ' + name + ' ' + edition` 中作字面子串匹配，`_%` 没有通配语义；brand 作等值匹配。年代支持 `unknown` 或 1900～2200 的整十数字；库存谓词使用 DTO 的识别状态及 sealedBlank/openedBlank/legacyUsed/recorded/unknown 计数。

分页范围为 `offset=0..1,000,000`、`limit=1..100`。`collection.list` 的公开验证器不支持 `readContext`，原生层同样拒绝它。`close` 回传 `null` 后自然退出，不等待 stdin 关闭；干净 EOF 自然成功退出，不完整末帧失败退出。

v3 未完整 commit 的 EOF 和启动错误非零退出并清理部分集合；合法 close 可在上传前/中收口，不能把 kill 当作成功关闭。v3 筛选及公开 DTO 与 v2 一致，不读取文件或数据库，也不改变 Node 唯一写入所有者。

工具链锁定在根目录 `rust-toolchain.toml`；依赖使用本目录 `Cargo.lock`。本机构建之前确认外置 LifeWeave 已挂载且可写，采用外置 Cargo 缓存、target 和 tmp：

```sh
export CARGO_HOME=/Volumes/LifeWeave/Developer/CommandLine/Caches/Cargo
RUST_TASK_DIR=$(mktemp -d /Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-XXXXXX)
export CARGO_TARGET_DIR="$RUST_TASK_DIR/cargo-target"
export TMPDIR=/Volumes/LifeWeave/Developer/CommandLine/tmp
cargo fmt --manifest-path native/rust-core/Cargo.toml --check
cargo clippy --locked --manifest-path native/rust-core/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path native/rust-core/Cargo.toml
cargo build --locked --release --manifest-path native/rust-core/Cargo.toml
```

本机已有的 stable 可以显式设置 `RUSTUP_TOOLCHAIN=stable`，但须先证明 `rustc --version` 精确等于锁定的 1.95.0。不得为构建此原型改变全局工具链或启用生产默认入口。
