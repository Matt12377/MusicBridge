fn main() {
    // 错误仅通过可信协议身份返回；不可信帧和 I/O 失败不泄露输入或原生诊断。
    if musicbridge_rust_core::run_stdio().is_err() {
        std::process::exit(1);
    }
}
