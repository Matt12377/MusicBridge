# WAVE-3 风险登记

WAVE-2 历史风险保留在 `docs/07_RISK_REGISTER.md`。本文件只登记 V1 Beta 完成链新增或重新升高的风险。

| ID | 风险 | 当前控制 | 触发后的处理 |
|---|---|---|---|
| R-011 | Provider 固定 wrapper 响应形状随版本漂移 | 固定 `4.40.1`、直接 wrapper contract tests、禁止静默升级 | 先更新契约与夹具，再由 Owner 放行 Provider 版本变更 |
| R-012 | CI 或诊断输出秘密 | 静态秘密/URL/query 扫描、合成凭据、日志布尔 Gate | 立即停止发布链，删除泄漏载荷并重跑扫描 |
| R-013 | Renderer 安全边界被 UI 迭代破坏 | Preload 白名单、CSP、sender/origin 校验和 Electron security tests | 阻断 UI/打包任务，修复后重新执行安全 Gate |
| R-014 | Core 或流资源在崩溃/退出后残留 | utilityProcess restart/fail-closed、退出清理、30 首稳定性 Gate | 先关闭资源泄漏再进入 Beta |
| R-015 | macOS 签名/公证条件缺失 | 未签名 arm64 fallback、`SIGNING_CREDENTIALS_PENDING` 明确记录 | 允许内部 Beta candidate，不宣称公开可分发 |
| R-016 | Lyrics 时序或 stale 响应污染当前播放 | generation、track identity、LRU 上限、无伪造 word sync | 保留静态歌词或 unavailable，不回退到不受控上游 |
