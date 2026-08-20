# POC-001 验收标准

POC 只有“全部通过”和“未通过”，不接受用 UI 演示替代音频证据。

## Gate A：静态与自动验证

- [ ] `npm run typecheck` 通过
- [ ] `npm test` 通过
- [ ] `npm run build` 通过
- [ ] `npm audit --omit=dev` 的结果已记录；高危项有明确隔离或升级结论
- [ ] 仓库中不存在 `.env`、Cookie、完整上游签名 URL、音频文件

## Gate B：Roon 扩展

- [ ] Roon `Settings → Extensions` 能看到 `Music Bridge for Roon — NetEase POC`
- [ ] 扩展可 Enable
- [ ] Settings 中可选择目标 Zone
- [ ] 进程重启后仍能重新配对并恢复 Zone 设置
- [ ] 未选 Zone 时，播放请求返回明确错误而不是静默失败

## Gate C：普通音质播放

- [ ] 用账号有权播放的普通歌曲 ID 调用 `standard` 或 `exhigh`
- [ ] 10 秒内进入 Roon 播放状态，或输出可诊断超时
- [ ] 歌名、歌手、专辑至少显示在 Roon 的文本信息中
- [ ] 歌曲完整播放，无重复开头、随机中断或明显断续
- [ ] `npm run stop` 后 Roon Session 结束，Zone 归还给 Roon

## Gate D：无损链路

- [ ] 用账号有权播放的歌曲请求 `lossless`
- [ ] 记录网易云实际返回的 `level`、`type`、`br`、`size`
- [ ] Roon Signal Path 截图显示输入格式与实际响应相符
- [ ] 网关代码路径中没有 FFmpeg、PCM 解码、重采样或重新封装
- [ ] 如果网易云降级到有损，结果必须标记“降级”，不能算无损通过

## Gate E：HTTP 媒体行为

- [ ] Roon 发出的 `Range` 被转发到上游
- [ ] 206、`Content-Range`、`Content-Length`、`Accept-Ranges`、`Content-Type` 正确保留
- [ ] HEAD 请求不会触发整首下载
- [ ] 响应以流式管道传输，不在内存中读取完整文件
- [ ] 播放过程没有持久化音频文件

## Gate F：安全边界

- [ ] 任意 `ENABLE_GENERAL_UNBLOCK=true` 会让程序拒绝启动
- [ ] 代码未调用解灰、替代音源、跨平台匹配接口
- [ ] 试听片段 `freeTrialInfo` 被拒绝，不冒充完整曲目
- [ ] Cookie、临时令牌和完整上游 URL不出现在日志
- [ ] 控制端口与流端口在 POC 中只绑定 127.0.0.1
- [ ] 停止或失败后临时流令牌撤销

## 必交证据

Codex 完成后创建 `reports/POC-001_RESULT.md`，包含：

1. 环境：macOS、Node、Roon Server 版本、运行机器。
2. `npm run verify` 原始摘要。
3. Roon 扩展 Enable 与 Zone Settings 截图。
4. 普通音质、无损各一次播放记录。
5. Roon Signal Path 截图。
6. Range/206 代理日志的脱敏摘要。
7. 未通过项、复现步骤、下一步，不得用“应该可以”代替。
