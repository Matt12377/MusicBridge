> **完整项目开发入口：** 请先阅读 `START_HERE_LUNAMAX.md`。原 `START_HERE.md` 仅用于 POC-001。

# Music Bridge for Roon — NetEase POC-001

把用户自己的网易云音乐账号中**有权播放的歌曲**，通过本机无转码 HTTP 网关送入 Roon Audio Input，并在用户选定的 Roon Zone 播放。

## 这版只证明一件事

```text
网易云歌曲 ID
  → 用户账号可播放的原始音频 URL
  → 本机临时、无缓存、无转码代理
  → Roon Audio Input Session
  → 指定 Roon Zone
```

POC-001 不做扫码登录、歌单、搜索、每日推荐、歌词、SwiftUI、Apple Music、多房间联动或正式安装器。先把最关键、最容易失败的音频链路打通。

## 固定技术选择

- macOS，且第一轮必须与 Roon Server/Core 同机运行
- Node.js 22+
- TypeScript strict mode
- 官方 Roon Node API 与 Audio Input API
- `@neteasecloudmusicapienhanced/api` 仅作为临时网易云适配器
- `ENABLE_GENERAL_UNBLOCK=false`，程序发现启用即拒绝启动
- 不保存音频文件，不转码，不绕过会员、地区或版权限制
- Cookie 只从环境变量读取，禁止写入仓库和日志

## 目录

```text
src/
  application/   用例编排，隔离网易云与 Roon
  config/        配置与启动安全检查
  control/       仅监听 127.0.0.1 的控制 API
  netease/       网易云适配器、响应解析、版权边界
  roon/          Roon Extension / Audio Input 适配器
  stream/        临时流注册表与无转码 HTTP 网关
  shared/        错误与日志
scripts/         doctor、play、stop、state
 test/           不依赖真实账号和 Roon 的自动测试
docs/            范围、架构、验收、运行手册、Codex 任务
```

## 快速启动

```bash
cp .env.example .env
# 在 .env 中加入自己账号的 NETEASE_COOKIE；不要把 Cookie 发给任何人
npm install
npm run doctor
npm run verify
npm run dev
```

然后在 Roon：

1. 打开 `Settings → Extensions`。
2. 启用 `Music Bridge for Roon — NetEase POC`。
3. 在扩展 Settings 里选择目标输出 Zone。

另开终端：

```bash
npm run play -- 347230 lossless
npm run state
npm run stop
```

歌曲 ID 只是示例；必须替换为你账号有权播放的歌曲。

## 控制 API

默认仅监听 `127.0.0.1:38501`：

- `GET /health`
- `GET /v1/state`
- `POST /v1/play`：`{"trackId":"...","quality":"lossless"}`
- `POST /v1/stop`

流网关默认监听 `127.0.0.1:38502`，URL 使用高熵临时令牌；停止播放后立即撤销。

## 完成标准

只有同时满足以下条件才算 POC 通过：

- 自动测试、类型检查、构建全部通过
- Roon 能发现扩展并选择 Zone
- 至少一首普通音质和一首无损歌曲完整播放
- HTTP Range 与关键响应头被原样保留
- 网关没有转码、落盘或长期缓存
- Roon Signal Path 与网易云实际响应一致；不能把“请求 lossless”当成“实际 lossless”
- 停止播放后 Session 与临时令牌被清理
- 日志不包含 Cookie、完整上游 URL、签名参数或令牌

完整门槛见 `docs/03_POC-001_ACCEPTANCE.md`。
