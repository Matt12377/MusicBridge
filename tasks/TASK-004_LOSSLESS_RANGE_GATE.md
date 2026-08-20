# TASK-004 — 无损、Range、Signal Path 与长播

## 目标

证明请求与账号实际可用的无损链路、Range/206 行为和稳定播放；若账号或曲目降级，必须如实标记。

## 操作

1. 请求 `lossless`，记录实际 level/type/br/size。
2. 验证 HEAD 不下载整首。
3. 验证 Range、If-Range、206 与关键响应头。
4. 查看并保存 Roon Signal Path。
5. 完整播放至少两首，其中一首较长。
6. 测试上游中断、MediaError 与 ZoneLost 清理。
7. 扫描代码确认无 FFmpeg、完整 Buffer、音频落盘。

## Exit Gate

- 实际无损时，Signal Path 与返回格式一致。
- 降级时标记为“无损未通过”，但普通播放可保持通过。
- 无 token/session/listener 残留。
