# TASK-002 — Roon 发现、配对与 Zone Gate

## 目标

在运行 Roon Server/Core 的同一台 Mac 上证明扩展发现、启用、配对、Zone 选择和持久化。

## 范围

只处理 Roon Adapter、设置与诊断；不调用网易云、不播放音频。

## 操作

1. 启动 daemon。
2. 在 Roon Settings → Extensions 中找到扩展。
3. Enable，并选择目标 Zone。
4. 重启 daemon，确认重新配对和 Zone 恢复。
5. 未选 Zone 时验证明确错误。
6. 使用 Fake 补齐 Session/Zone 状态测试。

## 证据

- 扩展页面截图。
- Zone Settings 截图。
- 脱敏日志。
- 自动测试结果。

## 禁止

- 不硬编码 Roon IP。
- 不开始网易云播放。
- 不扩大端口绑定范围。
