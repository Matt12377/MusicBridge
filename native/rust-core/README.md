# RUST-001 只读快照进程

本原型只接受调用方提供的完整公开 `CollectionModel[]`，不读取数据库、网络、凭据、音频或设备。正式 Core 入口继续使用 Node。

私有协议见 [`rust-readonly-sidecar-v1.md`](../../docs/contracts/rust-readonly-sidecar-v1.md)。每个 UTF-8 JSON 行最多 4,194,304 字节，不计 LF；严格拒绝各层重复键、未知字段和不完整末帧。快照最多 2,000 个型号；进程最多 65,536 个请求，最后一个序列位只供 `close`。安全信封下的业务错误只返回固定中文；坏 JSON、UTF-8、信封、重复请求、非连续序列直接非零退出，不输出输入或原生诊断。身份围栏、容量错误会清空快照并结束进程。

`prepare` 只加载一次，`commitBoot` 后才可读取；`dispatch` 仅支持无筛选的 `collection.list`，保留快照次序与全部公开字段。分页范围为 `offset=0..1,000,000`、`limit=1..100`。`collection.list` 的公开验证器不支持 `readContext`，原生层同样拒绝它。`close` 回传 `null` 后自然退出，不等待 stdin 关闭；干净 EOF 自然成功退出，不完整末帧失败退出。

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
