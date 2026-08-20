# TASK-023 — Roon 元数据、音质与错误恢复

## 目标

完善 Roon 当前歌曲文本/封面、实际音质展示和主要错误恢复路径。

## 场景

- 请求无损但降级。
- URL 过期单次刷新。
- Roon MediaError。
- ZoneLost。
- Core 重启。
- 登录过期。

## Exit Gate

所有场景有确定状态、用户文案、诊断 ID 和资源清理测试。
