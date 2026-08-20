# POC-001 产品范围

## 目标

证明用户可以在自己拥有合法播放权限的前提下，将网易云音乐的一首歌曲，以原始编码、不落盘、不转码的方式送入 Roon Audio Input，并从指定 Roon Zone 播放。

POC 成功后，项目才进入扫码登录、歌单和正式控制界面阶段。

## POC-001 范围内

- 运行于 Roon Server/Core 同一台 Mac
- 通过环境变量读取用户自己的网易云 Cookie
- 输入一个网易云歌曲 ID
- 请求 `standard`、`exhigh`、`lossless` 或 `hires`
- 读取歌曲名、歌手、专辑、时长和封面 URL
- 获取账号实际可用的音频 URL 与实际返回音质
- 将 URL 注册为高熵、临时、本机流地址
- 保留 HTTP Range 和关键媒体响应头
- 通过 Roon Audio Input 创建 Session 并播放到已选 Zone
- 停止、错误清理、状态查询
- 自动测试、类型检查、构建、实机证据

## 明确不在 POC-001

- 扫码登录、手机号登录、验证码登录
- 我的歌单、我喜欢、搜索、每日推荐、歌词
- 播放队列、上一首、下一首、暂停、拖动进度
- SwiftUI、菜单栏、iPhone 客户端
- Apple Music、QQ 音乐或其他 Provider
- Docker 部署、跨机器部署、开机自启、签名安装器
- 下载、离线缓存、音频格式转换、响度处理
- 解灰、替代音源、跨平台匹配、会员或地区限制绕过

## POC-002 候选范围

只有 POC-001 全部通过后再开始：

- 网易云扫码登录与 macOS Keychain
- 我的歌单、我喜欢、搜索
- 播放队列和基本控制
- SwiftUI macOS 控制端
- 将 Core 与 Provider Adapter 拆成稳定插件边界
