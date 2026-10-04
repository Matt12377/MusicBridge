# MBRS-001 格式初测矩阵

本表属于隔离 POC 的格式证据边界。固定文件句柄的整段或 Range 字节一致，仅证明 HTTP reader 没有改写原字节；官方薄 SDK 与 Fake moo 不执行真实解码，不能据此判断 Roon、输出设备或音质。

| 候选格式 | 本轮真实 Roon 解码 | 真实 Playing / Time | 真实发声及设备 | 格式或音质结论 |
|---|---|---|---|---|
| WAV / PCM | NOT_TESTED | NOT_TESTED | NOT_TESTED | 未取得实机证据 |
| FLAC | NOT_TESTED | NOT_TESTED | NOT_TESTED | 未取得实机证据 |
| MP3 | NOT_TESTED | NOT_TESTED | NOT_TESTED | 未取得实机证据 |
| AAC / M4A | NOT_TESTED | NOT_TESTED | NOT_TESTED | 未取得实机证据 |
| ALAC | NOT_TESTED | NOT_TESTED | NOT_TESTED | 未取得实机证据 |
| DSF / DFF | NOT_TESTED | NOT_TESTED | NOT_TESTED | 未取得实机证据 |

样本由隔离 runner 自建，描述符、字节摘要和资源记录以本轮外置原件为准。扩展名、MIME、许可字段和 SDK 调用没有异常均不改变上表；不将系统音频回采作为源文件证据。真实 Core、明确 Zone、样本及媒体网络准入尚未具备，原四条 live_roon 验收保持独立。

有限 track 与 channel 的字段和回调观察记录在 [API_BEHAVIOR_NOTES.md](API_BEHAVIOR_NOTES.md)。后续 MBRS-008 继承本表的未测项，并须取得自己的真实格式、处理链、设备与边界证据；不复制 POC 的软件通过状态。
