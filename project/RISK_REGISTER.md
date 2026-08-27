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
| R-017 | 本地与 NetEase 同名/同歌手仍可能不是同一录音，元数据无法证明真实听感同步 | 五轴硬拒绝、录音簇、CONFIRMED/MANUAL 才展示、短期候选会话 | 用 Owner 真实样本验证；不得将 Synthetic 结果写成真实录音验收 |
| R-018 | 跨源歌词真实 Provider/Roon 和 Owner 产品接受尚未完成 | Owner 于 2026-08-27 明确授权先集成 main；TASK-047 真实矩阵保留为 carryover，不能标记 complete | v3 继续保留真实样本与同步验收，不将集成授权当作产品验收通过 |
| R-019 | 标题中的编号或符号使本地歌词匹配漏召回；宽泛清洗又可能造成误匹配 | 只完成现有生产函数的合成对照，尚未实现新清洗规则；原始标题和稳定签名保持不变 | 先核对本地与网易云完整标题，再为有界清洗建立正例及误匹配 RED，保留歌手、版本、时长和歧义约束 |
