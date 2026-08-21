# 领域、IPC 与状态契约

## 1. 原则

- Renderer 只依赖公开 contracts。
- contracts 包不得导入 Electron、Roon 或网易云实现。
- 所有 IPC 请求与事件必须有版本和 schema。
- 内部错误栈不得跨越 IPC。

## 2. 命令

```ts
export type CoreCommand =
  | { version: 1; id: string; type: 'auth.beginQr' }
  | { version: 1; id: string; type: 'auth.pollQr'; challengeId: string }
  | { version: 1; id: string; type: 'auth.cancelQr'; challengeId: string }
  | { version: 1; id: string; type: 'auth.getState' }
  | { version: 1; id: string; type: 'auth.setCredential'; credential: string }
  | { version: 1; id: string; type: 'auth.clearCredential' }
  | { version: 1; id: string; type: 'auth.logout' }
  | { version: 1; id: string; type: 'library.search'; query: string; page: PageRequest }
  | { version: 1; id: string; type: 'library.liked'; page: PageRequest }
  | { version: 1; id: string; type: 'library.playlists' }
  | { version: 1; id: string; type: 'library.playlist'; playlistId: string; page: PageRequest }
  | { version: 1; id: string; type: 'roon.listZones' }
  | { version: 1; id: string; type: 'roon.selectZone'; outputId: string }
  | { version: 1; id: string; type: 'playback.play'; ref: TrackRef }
  | { version: 1; id: string; type: 'playback.stop' }
  | { version: 1; id: string; type: 'playback.next' }
  | { version: 1; id: string; type: 'playback.previous' }
  | { version: 1; id: string; type: 'playback.replaceQueue'; items: QueueItem[]; index: number }
```

`auth.setCredential` 与 `auth.clearCredential` 是 Main → Core 的受控内部请求；Preload 不暴露这两个方法，响应只返回公开状态，不返回凭据。

Library 命令使用统一的分页合同：`PageRequest` 为 `offset >= 0` 与 `1 <= limit <= 100`，`library.search` 的查询词去除首尾空白后长度为 1–100。Provider 原始对象不得出现在任何 Library 响应中；响应只允许标准 `TrackSummary`、`PlaylistSummary`、`PlaylistDetail` 与 `Page<T>` 字段。封面只接受 HTTPS 的 NetEase 图片域名，Renderer 使用懒加载，旧搜索操作的结果在新操作开始后失效。

Provider 会话过期只向公开 IPC 返回 `AUTH_EXPIRED`，不携带 Provider 原始错误、账号资料或响应内容。

扫码登录的公开状态只允许以下字段：`status`、不透明的 `challengeId`、本地二维码图片数据和过期时间。Provider 返回的内部 key 不进入公开状态。

`auth.pollQr` 在 Core → Main 的内部响应中可以携带一次性凭据；Main 完成验证、safeStorage 写入和 `auth.setCredential` 后，只把其中的公开 `state` 返回给 Renderer。Preload 的 `pollQrLogin` 永远不返回凭据。

## 3. 事件

```ts
export type CoreEvent =
  | { version: 1; type: 'core.ready'; payload: CoreReady }
  | { version: 1; type: 'core.health'; payload: CoreHealth }
  | { version: 1; type: 'auth.changed'; payload: { state: AuthState } }
  | { version: 1; type: 'roon.changed'; payload: RoonSnapshot }
  | { version: 1; type: 'playback.changed'; payload: PlaybackSnapshot }
  | { version: 1; type: 'queue.changed'; payload: QueueSnapshot }
  | { version: 1; type: 'diagnostic.notice'; payload: PublicNotice }
```

## 4. IPC 安全

- Preload 暴露业务方法，而不是通用 channel。
- Main 对 sender frame、origin 与窗口实例做校验。
- 参数长度有限制：搜索词、分页、队列项数量。
- URL 类型不从 Renderer 接收。
- Renderer 不能指定上游 URL、网关 token 或 Roon session ID。
- Renderer 不能读取 Provider 凭据；二维码是受长度限制的 `data:image/*` 图片，仅用于本地展示。
- 退出登录先清理 Core 内存中的 Provider 会话，再删除 Main 侧的 safeStorage 文件；任一步失败都不得向 Renderer 返回秘密数据。

## 5. 状态快照

`PlaybackSnapshot` 至少包含：

- state
- currentTrack
- queueIndex
- requestedQuality
- actualQuality
- format/bitrate（可用时）
- selectedZone
- lastError
- canNext/canPrevious/canStop

不得包含：

- cookie
- upstreamUrl
- gatewayToken
- internalStack

## 6. 兼容性

任何 IPC breaking change 必须提高 `version`，同时保留迁移说明。V1 内避免频繁版本化；优先冻结合同后实现。
