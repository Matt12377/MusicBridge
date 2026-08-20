# TASK-022 — 队列与播放控制

## 目标

实现 replaceQueue、play、stop、next、previous 与自然结束自动下一首。

## 规则

- 单 active session/token。
- 快速重复点击序列化。
- stop 幂等。
- 不实现 pause/seek。
- 不做 gapless。

## Exit Gate

- Fake 与真实 Roon 队列测试。
- 10 首连续播放无残留。
- 不可用歌曲有明确跳过/停止策略。
