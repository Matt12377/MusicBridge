# POC-001 架构

## 形态：模块化单体

V0.1 不使用多仓库、微服务或复杂 monorepo。所有代码在一个 Node 进程中，但通过端口接口隔离 Provider、流网关和 Roon。等第二个 Provider（Apple Music）真正开始时再决定是否拆包。

```text
┌────────────────────────────────────────────────────────────┐
│ Music Bridge daemon（与 Roon Server/Core 同一台 Mac）       │
│                                                            │
│  127.0.0.1:38501                                           │
│  ┌──────────────┐                                          │
│  │ Control API  │── play(trackId, quality) ──┐             │
│  └──────────────┘                            │             │
│                                              ▼             │
│                                   ┌───────────────────┐    │
│                                   │ BridgeController  │    │
│                                   └──────┬─────┬──────┘    │
│                                          │     │           │
│                     metadata / URL       │     │ session   │
│                                          ▼     ▼           │
│  ┌─────────────────────┐       ┌────────────┐ ┌──────────┐ │
│  │ NetEase Adapter     │       │ Stream     │ │ Roon     │ │
│  │ account permissions │       │ Registry   │ │ Adapter  │ │
│  │ no unblock          │       └─────┬──────┘ └────┬─────┘ │
│  └─────────────────────┘             │             │       │
│                                      ▼             │       │
│                               127.0.0.1:38502       │       │
│                               Stream Gateway       │       │
└──────────────────────────────────┬─────────────────┼───────┘
                                   │ original bytes   │ Audio Input API
                                   ▼                  ▼
                          网易云官方/授权 CDN       Roon Core → Zone
```

## 播放时序

1. 控制 API 接收歌曲 ID 与请求音质。
2. `BridgeController` 并行获取歌曲元数据和账号实际可播放 URL。
3. 网易云适配器拒绝空 URL、试听片段、非 HTTPS URL和任何解灰配置。
4. 流注册表创建 256-bit 随机令牌，并保存一个“必要时刷新 URL”的解析器。
5. Roon Adapter 创建 Audio Input Session，将本机临时 URL 作为 `media_url`。
6. Roon Core 请求 `/stream/<token>`。
7. Stream Gateway 验证 URL、转发 `Range`，流式转发响应，不解码、不转码、不落盘。
8. 停止、播放失败或进程退出时结束 Roon Session 并撤销令牌。

## 端口与信任边界

- Control API 默认只绑定 `127.0.0.1`，不对局域网开放。
- Stream Gateway 在 POC-001 也只绑定 `127.0.0.1`，因此要求与 Roon Core 同机。
- 上游 URL 只能由内部 NetEase Adapter 写入注册表；外部请求不能提交任意 URL。
- 流令牌不可预测、短生命周期、停止即撤销。
- Cookie 不进入流网关，不发送给 Roon，不写日志。

## 为什么第一版必须同机

Roon 发现、HTTP 可达性、多网卡选择、防火墙和局域网 ACL 都可能制造假故障。同机可先证明核心链路成立。跨机器部署属于下一阶段，届时将：

- 显式选择 LAN 接口与公开基址
- 限制只允许 Roon Core IP 访问流端口
- 处理 Tailscale、Thunderbolt Bridge、Wi-Fi 与以太网多路由
- 加入 macOS LaunchAgent 与 Keychain

## 可替换端口

应用层只依赖两个接口：

- `NeteasePort`：`getTrack()`、`resolveStream()`
- `RoonPort`：`start()`、`play()`、`stop()`、`getState()`

因此测试可使用 Fake，未来 Apple Music Adapter 不需要修改流网关或 Roon Adapter。
