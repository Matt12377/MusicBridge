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
  | { version: 1; id: string; type: 'auth.pollQr'; key: string }
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

## 3. 事件

```ts
export type CoreEvent =
  | { version: 1; type: 'core.ready'; payload: CoreReady }
  | { version: 1; type: 'core.health'; payload: CoreHealth }
  | { version: 1; type: 'auth.changed'; payload: AuthState }
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
