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

## WAVE-5 新增风险

| ID | 风险 | 当前控制 | 关闭条件 |
|---|---|---|---|
| R-020 | TASK-066 普通冷启2秒ready与完整数据库/候选扫描可能在大库或慢盘超时 | TASK078完整启动期限调整为每次60秒（最多重试一次），48专项和独立审查通过；普通IPC仍2秒；固定app03包history-small与objects-small各10次首次启动/UI最大0.782/2.498秒、正常退出无残留（mock-keychain、OS缓存未清），最大联合规模与完整恢复仍待，不覆盖旧库 | TASK-078/Gate E以实际规模合成库测量并统一冷启超时策略；发布前关闭 |
| R-021 | TASK073实际应用包正常Quit在纠正探针后仍15秒超时，仅Main残留 | 旧失败与既有清理证据保留；TASK078新包无CDP普通Quit复现15秒FAIL：Core exit0、print/outbox已收口，will-quit后Main等待；采样见系统钥匙串调用，原因未关闭。TERM5秒未close，后续PID消失但最终码未知；新隔离候选包两种mock-keychain普通Quit均code0/close且无持有进程残留，只是软件依赖隔离证据；不放松Fuses/sender，不将晚消失当PASS | 独立取得退出阶段/主线程根因证据，修复后实际包正常child close为code0且无强制信号；关闭前不宣称正常退出或发布验收通过 |
| R-022 | 隔离FakeDriver的join/静止保证不能直接移植为真实HAL保证 | 新生命周期内核不链接应用或现有helper；Driver须封闭新派发并等待全部回调，超时不释放；只报告合成76断言及sanitizer证据 | 明确真实设备与配置/故障操作授权，实现并核验实际HAL屏障，按Gate B独立测量输出端无声及停止时限；不能用ACK、进程退出或源码编译代替 |
| R-023 | Attempt/Record/Print 历史与对象闭包累计增长可能拖慢停止、检索、冷启和恢复 | TASK078已完成有界对象证书、receipt/预算增量校验与完整回退：history-limit正式generation/measure/queued-stop通过，objects-small cold/backup/full-recovery/queued-stop及Print write通过；10/25/50 objects非正式阶梯近线性。正式objects-limit window-02按“计划写入+10GiB余量”准入时短缺7,007,517,084B，未签发且不重放旧窗口；joint正式窗口继续等待。全部软件结果不冒充真实driver或输出端测量 | 提供安全存储准入后按新UUID顺序完成objects-limit generation/measure/queued-stop与joint正式窗口；真实设备接入后独立执行Gate B，不以软件ACK/close替代输出端停止 |
