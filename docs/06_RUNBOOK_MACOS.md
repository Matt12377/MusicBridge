# macOS 实机运行手册

## 1. 运行位置

第一次验证必须在运行 Roon Server/Core 的同一台 Mac 上执行。不要先放到 DGX、Docker、NAS 或另一台 Mac。

## 2. 环境

```bash
node --version   # 需要 22+
npm --version
```

复制配置：

```bash
cp .env.example .env
```

在 `.env` 中填入自己账号当前有效 Cookie。不要把 `.env` 发给 Codex 云端、ChatGPT、GitHub、Issue 或任何日志系统。

保持：

```text
ENABLE_GENERAL_UNBLOCK=false
ENABLE_PROXY=false
ENABLE_RANDOM_CN_IP=false
```

## 3. 安装与自动验证

```bash
npm install
npm run doctor
npm run verify
```

`doctor` 不会访问网易云或 Roon，只检查 Node、配置安全、目录和端口。

## 4. 启动守护进程

```bash
npm run dev
```

预期看到：

- Control API：`127.0.0.1:38501`
- Stream Gateway：`127.0.0.1:38502`
- Roon：等待配对或已配对

日志不应显示 Cookie、完整上游 URL 或 token。

## 5. 在 Roon 中配置

1. `Settings → Extensions`
2. 找到 `Music Bridge for Roon — NetEase POC`
3. 点击 Enable
4. 点击 Settings
5. 选择要播放的 Zone

如果看不到扩展：

- 确认守护进程和 Roon Core 在同一台机器
- 临时检查 macOS 防火墙是否阻止 Node 的局域网/UDP 发现
- 确认没有 VPN 或安全软件改写本地网络
- 记录日志，不要盲目改成固定 Roon IP

## 6. 播放

另开终端：

```bash
npm run play -- <song-id> standard
npm run state
```

普通音质通过后：

```bash
npm run play -- <song-id> lossless
```

必须查看：

- 命令返回的 `requestedQuality`
- 网易云实际 `actualQuality/format/bitrate`
- Roon Signal Path

三者不一致时，以实际响应和 Signal Path 为准。

## 7. 停止

```bash
npm run stop
```

确认：

- Roon 不再由扩展占用
- `npm run state` 没有 active track/token
- 没有生成音频文件

## 8. 清理敏感信息

完成测试后：

```bash
rm .env
```

正式版将使用扫码登录和 macOS Keychain；POC Cookie 方式不得直接进入发布版。
