# ADR-MBRS-003：新本地点播范围与原播放器兼容

日期：2026-10-04。状态：本轮隔离设计有效规则；生效提交由提交后本文件最后提交解析。没有新发声 / Zone / 音量 / DSP / Core 操作许可。

本期新增普通本地播放唯一 route 是 `roon_audio_input`：用户选择具体文件 / 版本，Core 核稳定身份与 revision，经受控原样 URL 交官方 Audio Input 和明确 Zone。不要求 Roon 已入库或原生实体映射；不引入 N200 / Aurender / UPnP / DLNA / 本机 DAC 与后端切换 UI。

沿既有 BridgeController / RoonAdapter / Gateway / Registry / outbox / 原 UI 增量接入 `local_file`。公开请求只含 request_id、稳定 track / asset、expected revision、Core / Zone 与动作，不接受任意 path / URL / generation / session。真正 Playing / Paused 来自 Roon 回调；提交成功或 HTTP 字节不产生虚假状态；unknown 先 reconcile，不自动重发；外部接管不抢回或 stop 别人。

Roon-only 只限制本次新普通点播。旧网易云 / native 入口、FFmpeg、OutputNative、Execution Asset、RecordingPlan / Attempt、J-Card、设备配置与旧 Gate B/P4/P5 全保留。新本地失败不隐式转码或回退到 native / 网易云；可选 MBRS-015 内部只读增强关闭或故障也不能阻断新点播。

PREPARED lease 可在 SessionBegan 前存在；ACTIVE / PAUSED 绑定真实 session epoch 并维持固定字节 / FD / revision，暂停 / Range 不过早回收；旧 lease 不读新版字节。文件 Hash、Roon 处理、设备数字数据、无缝边界分别取证。此 ADR 只是合同范围，尚无生产 `local_file` 接入或真实播放证据。
