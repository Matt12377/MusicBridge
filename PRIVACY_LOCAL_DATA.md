# 本地数据与隐私边界

这是 Music Bridge for Roon 内部 Beta 的本地数据说明，不是法律隐私政策。应用设计目标是把账号、Roon 配对和播放控制留在用户自己的 Mac 上，不把这些内容提交到 Git、报告、日志或聊天。

## 本地保存的数据

### Provider 凭据

- QR 登录成功后，凭据只由 Main 进程接收并写入 Electron `safeStorage` 加密存储。
- 加密文件位于 App 的用户数据目录下的 `data/netease.credential`，不是明文 Cookie 文件；写入权限和删除结果都会校验。
- Renderer 不直接读取凭据；Core 只得到受控的 Main→Core 请求，公共状态只暴露 `missing/configured/expired` 等有限枚举。
- Logout 先清理 Core 内存状态，再删除加密凭据并校验文件不存在。

### Roon 配对与 Zone

- Roon 配置在本机 App 数据目录的 `data/config.json` 中维护，用于恢复已配对 Core 和选定 Zone。
- 报告、诊断导出和 UI 公共状态不会输出 Zone ID、Core 内部标识或回调内容。
- Roon 控制和流服务只绑定 `127.0.0.1`；应用没有把控制端口开放到局域网。

### 诊断与日志

- 诊断导出必须由用户显式触发，内容是版本、平台、公共健康枚举、受限时间线和资源计数。
- 诊断导出会拒绝凭据/URL/账号资料等高风险字段；既有测试覆盖秘密扫描和字段边界。
- 日志只记录受控事件名、状态和计数，不记录 Cookie、Token、Authorization、完整 URL、Query、账号资料、音频内容或 Roon 回调正文。

### 播放数据

- 播放流只在运行期间使用；项目不下载、缓存、保存完整音频文件，不使用 FFmpeg/libav/avconv，不做转码或解灰。
- 当前播放、队列和歌词状态属于运行时内存状态；退出清理后不作为离线音频数据保留。

## 网络与第三方

- Provider 请求和 Roon 请求只在用户启动 App 后执行；没有分析 SDK、云同步或远程账号资料上传功能。
- Stream Gateway 与控制 API 均为本机 loopback；没有 LAN 控制端口、远程控制 Token 或硬编码 Core IP。
- Provider 与 Roon 的第三方服务条款、账号权限和版权责任由使用者承担，依赖清单见 `THIRD_PARTY_NOTICES.md`。

## 用户控制与清理

1. 在 App 内执行 Logout，确认 Provider 状态回到 `missing`。
2. 退出 App，确认没有播放、Core、Gateway 或残留端口后再卸载 App。
3. 若希望彻底移除本地数据，手动检查并删除 App 的用户数据目录及用户主动导出的诊断文件；不要删除尚未备份的 Roon 配对资料。
4. 不要把诊断 JSON、屏幕截图或终端输出上传到公开位置，除非先确认其中没有本地环境信息。

开发、测试和报告流程不会索取或保存 Provider 凭据；Owner 只需在自己的本地 UI/终端完成必须的人工动作。
