# 架构决策记录

## D-001：Node.js 22 + TypeScript strict

原因：网易云 API 与 Roon 官方 Node API 都在同一生态；Roon `node-roon-api` 已加入 Node 22 支持。首版不引入 Swift/Node 双语言边界。

## D-002：POC 与 Roon Core 同机

原因：消除局域网可达性、多网卡和防火墙变量。跨机器不是核心可行性问题，后置。

## D-003：模块化单体，而不是 monorepo/微服务

原因：当前只有一个 Provider。先稳定端口边界，第二个 Provider 到来再拆包，避免 Codex 同时维护不必要的构建系统。

## D-004：固定并锁定第三方依赖

- 网易云适配器固定到已核对版本。
- Roon 依赖固定到具体 Git commit。
- 必须提交 lockfile；升级只能单独开依赖验证任务。

## D-005：硬禁用解灰

程序启动时强制：

```text
ENABLE_GENERAL_UNBLOCK=false
ENABLE_PROXY=false
ENABLE_RANDOM_CN_IP=false
```

任何一项被启用都直接失败。代码不得调用 `song_url_match`、替代音源或 `unblock=true`。

## D-006：本机代理，不直接把网易云临时 URL交给 Roon

原因：URL 可能过期、重定向、需要 Range；本机固定入口允许刷新 URL、保留媒体头、统一清理和避免完整上游 URL出现在 Roon 配置中。

## D-007：网关只透传，不转码

不使用 FFmpeg，不解析 PCM，不改变采样率/位深/声道，不写临时音频文件。是否真正无损以网易云实际响应与 Roon Signal Path 为准。

## D-008：实际音质优先于请求音质

请求 `lossless` 只代表偏好。界面和日志必须展示网易云实际返回的 `level/type/bitrate`；如果降级，不得标成无损。

## D-009：POC 不做扫码登录

Cookie 仅用于临时实机验证；正式版必须改为扫码登录 + macOS Keychain。这样可先隔离“登录链路失败”和“音频链路失败”。

## D-010：Roon Zone 在扩展设置中选择

沿用 Roon 官方 Extension Settings 的 `zone` 控件，不自行复制一套 Zone 选择与持久化协议。
