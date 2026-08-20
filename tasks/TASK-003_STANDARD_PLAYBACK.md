# TASK-003 — 网易云合法 URL 与普通音质实播

## 目标

使用用户本机 `.env` 中的合法 Cookie 和一首可播放歌曲，完成 standard/exhigh → Gateway → Roon Zone 的真实播放。

## 安全

- 绝不输出 Cookie。
- 日志不输出完整上游 URL 或 token。
- 禁用解灰、代理和随机 IP。
- 拒绝试听片段和非 HTTPS URL。

## 操作

1. 验证 `song_detail` 与 `song_url_v1` 解析。
2. 在请求前显示歌曲元数据和实际返回音质（脱敏）。
3. 注册临时 token。
4. 创建 Roon Audio Input Session。
5. 完整播放一首普通音质歌曲。
6. stop 后确认 Session 与 token 清理。
7. 补充 Controller 成功/失败清理测试。

## Exit Gate

- 真实 Zone 出声。
- 歌曲完整播放或有精确失败原因。
- Roon 显示基本元数据。
- stop 幂等。
