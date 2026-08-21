# Third-party notices

本仓库和当前 Beta 候选仍按私有、内部测试项目处理；本项目没有选择对外发布许可证，也没有创建公开发布页。本文件是项目级依赖清单，不替代各上游包、Electron/Chromium 分发内容或 Roon 的完整许可证文本。若将来进行外部发布，必须重新核对每个上游版本的许可证、版权和商标要求。

## Runtime dependencies

| Package | Pinned version | License reported by local manifest | 用途 |
|---|---|---|---|
| `electron` | `43.4.0` | MIT | macOS Desktop shell；Electron 分发内容另含其上游 Chromium/系统组件 notices |
| `vue` | `3.5.18` | MIT | Renderer UI |
| `vue-router` | `4.5.1` | MIT | Renderer 本地视图路由 |
| `pinia` | `3.0.3` | MIT | Renderer 状态管理 |
| `@music-bridge/contracts` | workspace | 项目内部私有包 | Main/Preload/Core 的受限公共契约 |
| `@neteasecloudmusicapienhanced/api` | `4.40.1` | MIT | 非官方 Provider API 适配；不代表网易云音乐官方授权 |
| `node-roon-api` | `1.2.3` | Apache-2.0 | Roon Core 连接 |
| `node-roon-api-audioinput` | `1.0.0` | Apache-2.0 | Roon Audio Input |
| `node-roon-api-settings` | `1.0.0` | Apache-2.0 | Roon 设置/配对配置 |
| `node-roon-api-status` | `1.0.0` | Apache-2.0 | Roon 状态 |
| `node-roon-api-transport` | `2.0.1` | Apache-2.0 | Roon Transport |

Roon 依赖以仓库固定提交引用锁定；版本/许可证信息来自当前本地安装 manifest。正式发布前仍需按固定提交复核上游 notices。

## 使用边界

- Provider 适配只服务于用户自己授权的账号和合法可访问内容；使用者必须遵守 Provider 服务条款、账号权限、地区限制和版权规则。
- 本项目不得启用或包装“解灰”、跨平台替代音源、会员绕过、DRM 绕过、下载保存、离线音频缓存、转码或去除访问控制的能力。
- Beta 构建不包含用户凭据、Cookie、Token、账号资料、日志或音频文件。
