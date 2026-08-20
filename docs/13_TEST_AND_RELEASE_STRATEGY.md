# 测试、质量与发布策略

## 1. Gate 等级

- **G0 静态：** lint、typecheck、build。
- **G1 单元：** parser、policy、state machine、queue、errors。
- **G2 集成：** fake CDN、Gateway、Fake Roon、utilityProcess。
- **G3 Electron E2E：** Renderer/Main/Core 完整控制路径。
- **G4 实机：** 网易云真实账号 + Roon Server + Zone。
- **G5 发布：** 签名、公证、干净机安装。

低级 Gate 不能替代高级 Gate。

## 2. 覆盖重点

### Gateway

- GET/HEAD。
- Range/If-Range。
- 200/206。
- 302/307 多跳与每跳 SSRF 验证。
- 上游断流、慢响应、超时、客户端取消。
- 不出现完整 Buffer 或临时文件。

### Roon

- discovery/pairing。
- Zone 设置持久化。
- 新 Session 前结束旧 Session。
- Playing、MediaError、EndedNaturally、StoppedUser、ZoneLost。
- Core 重启后重新配对。

### Provider

- QR pending/scanned/authorized/expired/cancelled。
- Cookie 过期。
- 搜索与分页。
- 空 URL、试听片段、实际音质降级。
- 未知字段与部分数据。

### Electron

- sandbox/contextIsolation/nodeIntegration。
- IPC sender、schema、长度限制。
- safeStorage 不可用与 Keychain 交互。
- utilityProcess crash/restart。
- 退出清理。

## 3. 实机回归歌曲集

测试者自己选择账号有权播放的、不会泄漏账号信息的曲目：

- 普通 MP3/AAC。
- 标准 FLAC 44.1/16。
- 可用时 Hi-Res。
- 无版权或地区不可用歌曲。
- 仅试听歌曲。
- 长曲目。

报告只记录匿名测试编号，不需要公开歌曲收藏或账号 Cookie。

## 4. Beta Gate

- 连续冷启动 10 次。
- 连续播放 30 首。
- Stop/Next 快速操作压力测试。
- Roon 重启、App 重启、网络短断恢复。
- 登录过期恢复。
- 退出账号后 secret scan。
- 干净 macOS 用户安装、启动、卸载。

## 5. 发布物

- DMG。
- SHA-256。
- 版本说明。
- 已知问题。
- 隐私/本地数据说明。
- 第三方许可证。
- 验收报告。
