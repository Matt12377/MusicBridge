# 上游基线（核对日期：2026-08-20）

## Roon

官方示例仓库：

- `https://github.com/RoonLabs/roon-connect-stream-example`
- 示例要求在 Roon `Settings → Extensions` 启用扩展并选择输出，然后以 HTTP URL 调用 `play`。
- 示例使用 `node-roon-api-audioinput`、settings、status 与 transport。

本 starter 固定：

- `RoonLabs/node-roon-api` commit `055dae6c2ac45b6c738aa3b9e5ac1fd722ed60e8`
  - 2026-02 合并移除脆弱 `ip` 包的安全修复
  - 上游此前已加入 Node.js 22 支持
- `RoonLabs/node-roon-api-audioinput` commit `21ff59e52a12cf36a21bb9d3fd546f3e6d70581f`
- `RoonLabs/node-roon-api-settings` commit `67cd8ca156c5bcd01ea63833ceaaec6d6a79654d`
- `RoonLabs/node-roon-api-status` commit `504c918d6da267e03fbb4337befa71ca3d3c7526`
- `RoonLabs/node-roon-api-transport` commit `2ee60008a4cdb90c34ff3de58bb4b949067f1d20`

Audio Input 库暴露：`begin_session`、`play`、`clear`、`update_track_info`、`update_transport_controls`。

## 网易云适配器

仓库：

- `https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced`
- 固定 npm 包：`@neteasecloudmusicapienhanced/api@4.40.1`
- README 推荐 Node.js 22+ 和 pnpm，但本项目用 npm 以减少额外工具要求。
- `song_url_v1` 支持 `standard`、`exhigh`、`lossless`、`hires` 等 level。
- 该项目也包含解灰功能与相关依赖；本项目明确不使用，并在启动和调用层双重禁止。
- 这是非官方逆向 API，不代表网易云音乐官方支持，接口稳定性与服务条款风险必须单独管理。

## 尚未证明的事实

- 当前用户 Roon 版本是否仍完整兼容 Audio Input 行为
- 当前账号/地区能否取得完整网易云音频 URL
- Roon 对网易云 CDN 的 HEAD、Range 和重定向实际序列
- Hi-Res 的实际格式、Roon Signal Path 与设备兼容性

这些只能通过 POC-001 实机证据确认，不能由代码审阅替代。
