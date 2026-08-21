# V1 Owner 统一验收清单

本清单用于一次统一验收。所有 Provider 登录、扫码、歌曲选择和听感判断由 Owner 在本地完成；不需要把凭据、账号资料、二维码内容、歌曲完整 URL 或私人响应发给开发者。

## 最终候选部署前置 Gate

- 候选提交：`b734f9874591211e9cacafc9ce9b2dbd2bbd1224`
- Core Mac `current` release：与候选提交一致，PASS。
- Bridge Core runtime：`ready`；Roon：`ready`；Provider：`missing`（本次公开初始状态）。
- `activeStreamCount=0`；`activePlayback` 不存在；38501/38502 仅 loopback；日志秘密扫描 PASS。
- 本次只执行脱敏部署与健康检查，未播放歌曲、未调用 Provider、未停止或重启 Roon。

上述是部署准备 Gate，不替代下表中的 Owner 听感、登录恢复、UI 和真实退出验收。

## 验收顺序

| # | 项目 | 自动/历史证据 | 最终 Beta DMG Owner 状态 |
|---:|---|---|---|
| 1 | 冷启动 | packaged startup Gate PASS | 待 Owner |
| 2 | 登录恢复 | TASK-020 真实 QR/重启历史 PASS | 待 Owner 在最终 DMG 复核 |
| 3 | Roon/Zone 恢复 | TASK-023 历史 Core/Zone 证据 | 待 Owner 在最终 DMG 复核 |
| 4 | 搜索 | TASK-021 与 Desktop E2E PASS | 待 Owner |
| 5 | Liked | TASK-021 与 Desktop E2E PASS | 待 Owner |
| 6 | Playlist 与分页 | TASK-021 与 Desktop E2E PASS | 待 Owner |
| 7 | 从搜索/Liked/Playlist 播放 | 受控播放测试 PASS；历史 Owner 播放 PASS | 待 Owner |
| 8 | 10 首队列 | 合成 10 项队列 PASS | 真实队列待 Owner |
| 9 | Next/Previous/Stop | 合成与历史队列 Gate PASS | 待 Owner |
| 10 | 自然结束推进 | 合成自然结束 PASS；历史双曲目播放已确认 | 待 Owner |
| 11 | 标题/艺人/专辑/安全封面 | TASK-023 与 Desktop E2E PASS | 待 Owner |
| 12 | 请求/实际质量与降级 | 自动质量解析 PASS；历史 Signal Path 无损 | 待 Owner 复核 |
| 13 | 歌词、翻译、逐词同步 | 合成解析与 UI Gate PASS | 按可用曲目待 Owner |
| 14 | Queue/Lyrics 切换 | Desktop E2E PASS | 待 Owner |
| 15 | 错误/诊断展示 | 诊断 writer、脱敏和安全扫描 PASS | 待 Owner |
| 16 | 关闭窗口保持播放 | Desktop E2E PASS | 待 Owner 在真实播放中复核 |
| 17 | 菜单栏控制 | Tray 单测与 E2E PASS | 待 Owner 在 macOS 菜单栏复核 |
| 18 | 真正退出清理 | Electron quit E2E PASS | 待 Owner 检查真实 Core/端口 |
| 19 | 重启不自动恢复旧音频 | 合成启动/恢复 Gate PASS | 待 Owner |
| 20 | DMG 安装/卸载/残留 | 临时目录安装冒烟 PASS | 待 Owner 在干净 macOS 环境复核 |

## Owner 记录格式

只记录有限结果：`PASS`、`FAIL`、`NOT_AVAILABLE` 或 `OWNER_ONLY_PENDING`，以及必要的脱敏阶段/诊断 ID。不要记录或粘贴凭据、账号、二维码、完整 URL、Query、Zone ID、Session ID 或 Provider 原始响应。

## 当前统一结论

**OWNER_ACCEPTANCE_PENDING**

自动化和历史 POC 实机证据足以形成内部 Beta 候选，但最终 DMG 的真实 Core Mac、Roon Zone、Provider 登录恢复、完整播放、菜单栏和卸载残留仍需 Owner 一次性确认。确认前不应宣称公开发行或完成 V1 的最终 Owner 验收。
