# Music Bridge for Roon 开发总蓝图

**文档版本：** v0.2.0-architecture  
**基线日期：** 2026-08-20  
**状态：** Frozen for implementation（实现冻结基线）  
**适用对象：** Owner、Codex LunaMax、后续审阅者  
**当前产品入口：** 网易云音乐 → Music Bridge → Roon Audio Input → Roon Zone

> 本文档是项目的最高级开发基线。除非 Owner 明确批准变更，Codex 只能实现本文档，不得自行改变产品边界、进程模型、技术栈、安全策略或阶段顺序。

---

## 0. 先给结论

这个项目可以交给 Codex LunaMax 完成，但角色必须划分清楚：

- **Owner**：决定产品目标、验收真实播放、批准范围变化与发布。
- **本蓝图**：承担产品规划、架构、边界、接口和阶段设计。
- **LunaMax**：承担单任务实现、测试、修复和证据整理；它不是项目架构师。

LunaMax 每次只执行一个编号任务。任务必须有明确输入、允许修改范围、验收命令和报告。禁止一次性指令“把整个项目做完”。

项目总体形态不是一个嵌入 Roon 左侧导航栏的原生网易云服务，而是一个独立 macOS 桌面应用：

```text
用户在 Music Bridge 中登录、搜索、查看歌单并点击播放
                    │
                    ▼
Music Bridge 获取用户账号有权播放的网易云音频地址
                    │
                    ▼
Music Bridge 的本地 Stream Gateway 提供临时 HTTP 媒体 URL
                    │
                    ▼
内置 Roon Extension 告诉 Roon 在选定 Zone 播放该 URL
                    │
                    ▼
Roon 主动拉取音频，负责 DSP / RAAT / 输出设备
```

---

## 1. 产品定义

### 1.1 一句话目标

让用户在一个独立、易用的 macOS 桌面软件中使用网易云音乐，并把当前账号合法可播放的原始音频流交给 Roon 播放。

### 1.2 V1 用户体验

用户应能完成以下流程：

1. 打开 Music Bridge。
2. 看到网易云和 Roon 的连接状态。
3. 使用网易云扫码登录。
4. 浏览“我喜欢的音乐”、自己的歌单和搜索结果。
5. 选择一个 Roon Zone。
6. 点击一首歌曲。
7. Music Bridge 显示歌曲、封面、歌手、专辑、请求音质和实际音质。
8. Roon 从选定 Zone 播放，并继续负责 Signal Path、DSP、RAAT 和设备输出。
9. 用户可以停止、上一首、下一首；暂停与进度拖动只有在实机证明稳定后才进入 V1。
10. 出错时显示可理解、可诊断的原因，而不是“播放失败”四个字。

### 1.3 V1 成功标准

V1 不是“窗口能打开”或“接口返回 200”。必须同时满足：

- 网易云扫码登录可用，凭据不会进入 Renderer、日志或 Git。
- 搜索、我喜欢、歌单可正常读取。
- 普通音质和账号有权播放的无损歌曲均可进入 Roon。
- 实际音质与 Roon Signal Path 一致；降级必须明确显示。
- 30 首连续队列播放无资源泄漏、令牌残留或随机中断。
- Roon 未配对、Zone 丢失、Cookie 过期、歌曲无版权等状态都有确定恢复路径。
- macOS 应用可打包、签名、公证并在干净用户环境启动。

### 1.4 明确不做

V1 不包含：

- 把网易云注册成 Roon 原生 Music Service。
- 把网易云歌曲加入 Roon Library 或 Roon 全局搜索。
- 解灰、替代音源、会员绕过、地区绕过、DRM 破解。
- 下载、离线缓存、音频转码、重采样或响度处理。
- Apple Music、QQ 音乐、Spotify 等其他 Provider。
- Windows、Linux、iPhone 客户端。
- 跨机器 UI/Agent 分离部署。
- 云账号、云同步或远程控制。
- 自动更新服务；可在 V1.1 加入。

---

## 2. 固定技术决策

### 2.1 技术栈

| 层 | 固定选择 | 说明 |
|---|---|---|
| 桌面外壳 | Electron | macOS V1；只加载本地打包资源 |
| UI | Vue 3 + TypeScript + Composition API | 使用 Vue 官方 TypeScript 路径 |
| UI 构建 | electron-vite / Vite | Main、Preload、Renderer 分离构建 |
| 状态管理 | Pinia | 仅存 UI 与非敏感会话状态 |
| 后端核心 | Node.js + TypeScript strict | 网易云、Roon、Gateway、播放状态机 |
| 后台进程 | Electron `utilityProcess` | Bridge Core 与 Main/Renderer 隔离 |
| 音频代理 | `node:http` + Node Streams | 精确控制 Range、206、HEAD 和 backpressure |
| Roon | `node-roon-api` + Audio Input | 以 RoonLabs 官方示例为行为基线 |
| 凭据 | Electron `safeStorage`，macOS Keychain | 只在 Main 进程加解密 |
| 数据存储 | 小型 JSON 配置；V1 后半期再引入 SQLite | 不提前制造数据库迁移负担 |
| 测试 | Node Test/Vitest + Playwright | 核心、契约、网关、Electron E2E |
| 打包 | electron-builder | DMG、签名、公证；V1 不做自动更新 |

### 2.2 版本策略

- 现有 POC 保持 **Node.js 22 LTS**，先完成真实 Roon Gate。
- POC 通过后，执行 Node 22/24 兼容性矩阵。
- 正式 Electron 基线使用当时仍受支持的稳定 Electron 主版本；截至 2026-08-20，基线为 Electron 43.x 稳定线，禁止使用 beta/nightly。
- Electron 内置 Node 版本与 Bridge Core 必须实测；不能假定“独立 Node 通过”就等于“utilityProcess 通过”。
- 所有第三方依赖固定精确版本或 Git commit，并提交 lockfile。
- 依赖升级必须是独立任务，禁止夹带在功能任务中。

### 2.3 为什么后端不选 Go、Swift 或 Rust

V1 的关键工作是网易云 Node API、Roon Node API、HTTP 流式代理和 Electron 进程通信。Node + TypeScript 可以直接复用两端生态，避免额外守护进程、FFI、RPC 和双语言打包。当前程序不做音频解码或 DSP，因此没有必要为了理论性能引入 Rust/C++。

未来只有在实测证明 Node 网关存在不可接受的 CPU、内存或延迟问题时，才允许单独评估 Rust 辅助模块。不得先优化不存在的问题。

---

## 3. 部署边界

### 3.1 POC-001：同机模式

第一次验证必须让 Music Bridge Core 与 Roon Server/Core 运行在同一台 Mac：

```text
Stream Gateway: 127.0.0.1
Control API:     127.0.0.1
Roon Core:       同机
```

这样可以排除多网卡、防火墙、路由和 ACL 造成的假故障。

### 3.2 V1：仍以同机为正式支持模式

V1 桌面应用应安装在运行 Roon Server 的 Mac 上。如果用户的 Roon Server 是无头 Mac mini，仍可通过该 Mac 的桌面会话或远程桌面使用应用。

### 3.3 V1.1 候选：Agent/Client 分离

架构必须保证 Bridge Core 不依赖 Electron UI，以便后续形成：

```text
桌面 Music Bridge UI  ──受认证控制连接──>  Roon Core Mac 上的 Bridge Agent
```

但 V1 不实现跨机器模式。LunaMax 不得提前加入 LAN 监听、远程认证或 Agent 安装器。

---

## 4. 总体架构

```text
┌──────────────────────────────────────────────────────────────┐
│ Electron App                                                 │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Renderer: Vue 3                                        │  │
│  │ Home / Search / Library / Now Playing / Settings       │  │
│  │ 无 Node、无 Cookie、无文件系统权限                      │  │
│  └──────────────────────────┬─────────────────────────────┘  │
│                             │ typed IPC                      │
│  ┌──────────────────────────▼─────────────────────────────┐  │
│  │ Preload                                                │  │
│  │ contextBridge 白名单 API，参数与返回值 schema 校验       │  │
│  └──────────────────────────┬─────────────────────────────┘  │
│                             │                                │
│  ┌──────────────────────────▼─────────────────────────────┐  │
│  │ Main Process                                           │  │
│  │ Window / Lifecycle / safeStorage / Core supervision    │  │
│  └──────────────────────────┬─────────────────────────────┘  │
│                             │ MessagePort                    │
│  ┌──────────────────────────▼─────────────────────────────┐  │
│  │ Bridge Core utilityProcess                            │  │
│  │                                                       │  │
│  │  ┌──────────────┐   ┌──────────────┐   ┌───────────┐  │  │
│  │  │ NetEase      │   │ Playback     │   │ Roon      │  │  │
│  │  │ Adapter      │──>│ Controller   │──>│ Adapter   │  │  │
│  │  └──────┬───────┘   └──────┬───────┘   └─────┬─────┘  │  │
│  │         │                  │                 │        │  │
│  │         │            ┌─────▼──────┐          │        │  │
│  │         └───────────>│ Stream     │<─────────┘        │  │
│  │                      │ Gateway    │                   │  │
│  │                      └─────┬──────┘                   │  │
│  └────────────────────────────┼───────────────────────────┘  │
└───────────────────────────────┼──────────────────────────────┘
                                │ HTTP media stream
                                ▼
                         Roon Server/Core
                                │
                                ▼
                         Roon Zone / RAAT
```

### 4.1 进程职责

#### Renderer

负责：

- 页面渲染、列表、搜索输入、播放控制、错误展示。
- Pinia 状态、路由和非敏感缓存。
- 调用 Preload 暴露的白名单命令。

禁止：

- 访问 Cookie、完整播放 URL、流令牌。
- 直接调用网易云或 Roon。
- 使用 `require`、Node API、任意 IPC channel。
- 加载远程网页或执行远程脚本。

#### Preload

负责：

- 使用 `contextBridge` 暴露精确方法。
- 校验入参和返回值。
- 转换内部错误为公开错误模型。

禁止：

- 暴露通用 `ipcRenderer.send`。
- 暴露文件系统、shell 或进程对象。

#### Main

负责：

- 创建窗口、菜单、托盘和应用生命周期。
- 启动、监控、重启 Bridge Core utilityProcess。
- 使用 `safeStorage` 保存和读取网易云凭据。
- 验证 IPC sender。
- 拒绝新窗口、导航和未授权外部链接。

Main 不承担音频流代理或网易云业务逻辑。

#### Bridge Core

负责：

- 网易云会话、搜索、歌单、歌曲详情与播放 URL。
- Roon 发现、配对、Zone 与 Audio Input Session。
- Stream Gateway。
- 播放队列、状态机、错误映射和诊断。
- 向 Main/Renderer 输出脱敏状态事件。

Bridge Core 不导入 Electron UI 模块；它必须能在测试与未来 Headless Agent 中独立运行。

---

## 5. 核心模块与接口

### 5.1 Provider Adapter

```ts
export interface MusicProviderAdapter {
  readonly providerId: 'netease'

  getAuthState(): Promise<AuthState>
  beginQrLogin(): Promise<QrLoginChallenge>
  pollQrLogin(key: string): Promise<QrLoginStatus>
  logout(): Promise<void>

  searchTracks(query: string, page: PageRequest): Promise<Page<TrackSummary>>
  getLikedTracks(page: PageRequest): Promise<Page<TrackSummary>>
  getUserPlaylists(): Promise<PlaylistSummary[]>
  getPlaylist(id: string, page: PageRequest): Promise<PlaylistDetail>
  getTrack(id: string): Promise<TrackMetadata>
  resolveStream(ref: TrackRef, quality: RequestedQuality): Promise<StreamDescriptor>
}
```

原则：

- Provider 只返回标准领域模型，不把网易云原始响应泄漏到 UI。
- 所有解析必须防御性处理未知字段和空值。
- `resolveStream` 必须返回“请求音质”和“实际音质”。
- `freeTrialInfo`、空 URL、非 HTTPS、无权限必须明确拒绝。

### 5.2 Roon Adapter

```ts
export interface RoonPort {
  start(): Promise<void>
  stop(): Promise<void>
  getPairingState(): RoonPairingState
  listZones(): RoonZone[]
  selectZone(outputId: string): Promise<void>
  beginPlayback(input: RoonPlaybackInput): Promise<void>
  endPlayback(reason: StopReason): Promise<void>
  subscribe(listener: (event: RoonEvent) => void): Unsubscribe
}
```

必须保证：

- 新播放开始前结束旧 Session。
- Zone 丢失后状态转为错误，不自动向未知 Zone 播放。
- `MediaError`、`EndedNaturally`、`StoppedUser`、`ZoneLost` 都有确定状态转换。
- 元数据更新不包含 Cookie、上游 URL 或令牌。

### 5.3 Stream Gateway

职责：

- 为当前播放创建高熵、短生命周期 token。
- 支持 `GET` 和 `HEAD`。
- 转发 `Range`、`If-Range`，使用 `Accept-Encoding: identity`。
- 保留 `200/206`、`Content-Type`、`Content-Length`、`Content-Range`、`Accept-Ranges`、`ETag`、`Last-Modified`。
- 使用 Node Streams 管道与 backpressure，不读取完整音频到内存。
- 每次重定向重新执行 SSRF 检查。
- 停止、失败、自然结束和进程退出时撤销 token。

禁止：

- 接受外部任意 URL。
- 转发网易云 Cookie 到 CDN，除非经过单独审计证明必要。
- 写临时音频文件。
- 使用 FFmpeg、解码器或重新封装。

### 5.4 Playback Controller

统一协调 Provider、Gateway、Roon 与 Queue。所有播放命令必须序列化，避免重复点击造成并发 Session。

```ts
export interface PlaybackController {
  play(ref: TrackRef, options: PlayOptions): Promise<void>
  stop(reason?: StopReason): Promise<void>
  next(): Promise<void>
  previous(): Promise<void>
  replaceQueue(items: QueueItem[], startIndex?: number): Promise<void>
  getState(): PlaybackSnapshot
  subscribe(listener: (snapshot: PlaybackSnapshot) => void): Unsubscribe
}
```

---

## 6. 领域模型

### 6.1 关键类型

```ts
export type RequestedQuality = 'standard' | 'exhigh' | 'lossless' | 'hires'

export interface TrackRef {
  provider: 'netease'
  id: string
}

export interface TrackMetadata {
  ref: TrackRef
  title: string
  artists: Array<{ id?: string; name: string }>
  album: { id?: string; title: string }
  artworkUrl?: string
  durationMs?: number
}

export interface StreamDescriptor {
  ref: TrackRef
  upstreamUrl: URL
  requestedQuality: RequestedQuality
  actualQuality?: string
  format?: string
  bitrate?: number
  sizeBytes?: number
  expiresAt?: string
  isTrial: boolean
}
```

### 6.2 公开错误模型

```ts
export type PublicErrorCode =
  | 'CONFIG_INVALID'
  | 'AUTH_REQUIRED'
  | 'AUTH_EXPIRED'
  | 'TRACK_NOT_FOUND'
  | 'TRACK_UNAVAILABLE'
  | 'TRIAL_ONLY'
  | 'STREAM_URL_MISSING'
  | 'STREAM_URL_EXPIRED'
  | 'UPSTREAM_HTTP_ERROR'
  | 'UPSTREAM_RANGE_UNSUPPORTED'
  | 'ROON_NOT_PAIRED'
  | 'ROON_ZONE_NOT_SELECTED'
  | 'ROON_ZONE_LOST'
  | 'ROON_MEDIA_ERROR'
  | 'GATEWAY_NOT_REACHABLE'
  | 'CORE_UNAVAILABLE'
  | 'INTERNAL_ERROR'
```

每个错误包含：

- `code`
- 用户可读的中文 `message`
- 是否可重试 `retryable`
- 脱敏诊断 ID `diagnosticId`
- 可选恢复动作 `action`

内部异常栈不得直接传到 Renderer。

---

## 7. 播放时序

```text
Renderer        Core            NetEase       Gateway         Roon
   │              │                │              │              │
   │ play(track)  │                │              │              │
   ├─────────────>│                │              │              │
   │              │ get metadata   │              │              │
   │              ├───────────────>│              │              │
   │              │ resolve stream │              │              │
   │              ├───────────────>│              │              │
   │              │<───────────────┤              │              │
   │              │ validate / register token      │              │
   │              ├───────────────────────────────>│              │
   │              │ begin Audio Input session      │              │
   │              ├─────────────────────────────────────────────>│
   │              │                                │ GET /stream  │
   │              │                                │<─────────────┤
   │              │                                │ GET CDN      │
   │              │                                ├─────────────>│ NetEase CDN
   │              │                                │<─────────────┤
   │              │                                ├─────────────>│ audio bytes
   │ playing      │<─────────────────────────────────────────────┤
   │<─────────────┤                                │              │
```

### 7.1 URL 过期

- 如果 `expiresAt` 距当前时间不足安全窗口，首次请求前重新解析。
- Range 重试遇到 401/403/404 且 URL 已接近过期时，只允许刷新一次。
- 刷新后仍失败则终止播放，禁止无限重试。

### 7.2 音质降级

请求 `lossless` 不等于实际无损。若返回 `exhigh`：

- 播放可以继续。
- UI 显示“请求无损，实际高品质”。
- 结果不计入无损 Gate。
- 诊断报告记录请求与实际值。

---

## 8. 播放状态机

```text
idle
  │ play
  ▼
resolving ──失败──> error
  │ stream ready
  ▼
preparingRoon ──失败──> error
  │ SessionBegan
  ▼
buffering ──MediaError/timeout──> error
  │ Playing
  ▼
playing ──EndedNaturally──> advancing / idle
  │ stop / next / previous
  ▼
stopping ──cleanup complete──> idle / resolving
```

固定规则：

- 同一时刻最多一个 active Roon Session。
- 同一时刻最多一个 active stream token。
- 新 `play` 会取消旧的 resolve，并结束旧 Session。
- `stop` 必须幂等。
- 错误状态仍必须完成 token、session、listener 和定时器清理。
- 任何超时都必须进入确定状态，不能永久停留在 `buffering`。

暂停和 seek 不在状态机中，直到 POC 证明 Roon Audio Input 与上游 Range 行为足够稳定。

---

## 9. 安全与版权边界

### 9.1 强制禁止

程序在任意下列配置为 true 时拒绝启动：

```text
ENABLE_GENERAL_UNBLOCK
ENABLE_PROXY
ENABLE_RANDOM_CN_IP
```

代码禁止调用：

- 解灰接口。
- 替代音源匹配。
- 跨平台歌曲匹配以获得音频。
- `unblock=true`。
- 任何会员、版权或地区绕过功能。

### 9.2 Cookie / 登录凭据

- POC 临时 Cookie 仅存在 `.env`。
- 正式版扫码登录后，凭据由 Main 进程用 `safeStorage` 异步 API 加密保存。
- Renderer 永远只能得到 `loggedIn`、昵称和头像，不得得到 Cookie。
- Core 只在调用 Provider 时临时获取凭据；不写普通日志。
- 退出账号必须删除持久化凭据并清空内存会话。

### 9.3 Electron 安全基线

```ts
webPreferences: {
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  preload: preloadPath
}
```

另外必须：

- 严格 CSP，仅允许本地资源与经过白名单的图片域名。
- 拒绝 Renderer 导航。
- `setWindowOpenHandler` 默认 deny。
- IPC sender 验证。
- 所有 IPC 参数使用 schema 校验。
- 不在窗口中加载网易云网页并给予 Node 权限。
- 外部链接必须经过 allowlist 并由 Main 打开。

### 9.4 SSRF 与网络

- POC/V1 网关只绑定 `127.0.0.1`。
- 只有 Provider Adapter 可以注册上游 URL。
- 上游只允许 HTTPS。
- 拒绝 localhost、私网、链路本地、保留地址和 DNS 重绑定结果。
- 每个重定向都重新验证。
- 日志不能输出完整签名 URL、Query 参数或 token。

---

## 10. UI 产品要求

### 10.1 页面

V1 固定五个主页面：

1. **Home**：连接状态、最近播放、我喜欢、常用歌单。
2. **Search**：歌曲优先；歌手和专辑可以后置。
3. **Library**：我喜欢与用户歌单。
4. **Now Playing / Queue**：封面、歌曲信息、实际音质、队列、Roon Zone。
5. **Settings / Diagnostics**：登录、Roon 配对、Zone、日志导出、版本信息。

### 10.2 全局播放条

窗口底部始终显示：

- 封面、歌曲、歌手。
- 播放状态。
- 上一首、停止/播放、下一首。
- 当前 Roon Zone。
- 实际音质徽章。

### 10.3 设计原则

- 这是音乐应用，不是后台管理系统。
- 不直接套用大型管理后台组件库的默认视觉。
- 使用 CSS Variables 形成设计 Token。
- 默认支持深色模式；浅色模式可后置。
- 关键错误必须在页面内呈现，不能只弹临时 Toast。
- 长列表必须虚拟化或分页，不一次加载整个歌单。

### 10.4 暂不承诺

- 动态歌词、逐字歌词。
- 频谱动画。
- 沉浸封面背景。
- 拖动进度和暂停恢复。
- Roon 多房间分组编辑。

这些可以在核心链路稳定后单独增加。

---

## 11. 仓库结构

### 11.1 当前 POC 期间

保持现有单包结构，不在 POC 前迁移构建系统。

### 11.2 POC 通过后的目标结构

使用单仓库、最小 pnpm workspace：

```text
music-bridge-for-roon/
├── apps/
│   └── desktop/
│       ├── src/main/
│       ├── src/preload/
│       ├── src/renderer/
│       ├── electron.vite.config.ts
│       └── package.json
│
├── packages/
│   ├── bridge-core/
│   │   ├── src/application/
│   │   ├── src/providers/netease/
│   │   ├── src/roon/
│   │   ├── src/gateway/
│   │   ├── src/playback/
│   │   ├── src/queue/
│   │   └── package.json
│   │
│   └── contracts/
│       ├── src/domain/
│       ├── src/ipc/
│       ├── src/events/
│       ├── src/errors/
│       └── package.json
│
├── docs/
├── tasks/
├── reports/
├── pnpm-workspace.yaml
└── package.json
```

只允许三个 workspace：desktop、bridge-core、contracts。V1 不创建共享 UI 包、插件 SDK 或复杂构建工具链。

### 11.3 依赖方向

```text
contracts  <- bridge-core
contracts  <- desktop main/preload/renderer
bridge-core 不依赖 desktop
renderer 不依赖 bridge-core 实现，只依赖 contracts
```

禁止循环依赖。

---

## 12. 开发阶段与 Gate

### Phase 0：运行环境与现实基线

**任务：** TASK-000、TASK-001  
**目标：** 确认 VS Code 之外的 Node、Git、依赖与 starter 真实状态。  
**退出 Gate：** 安装可重复、`npm run verify` 有基线、无秘密进入仓库。

### Phase 1：POC-001 音频链路

**任务：** TASK-002 至 TASK-005  
**目标：** 网易云合法音频 → Gateway → Roon → Zone 真正出声。  
**退出 Gate：** 普通音质与可用无损完成；Signal Path、Range、Session 清理有证据；冻结 `poc-001-passed` 检查点。

### Phase 2：桌面基础设施

**任务：** TASK-010 至 TASK-013  
**目标：** 从 Headless POC 迁移到 Electron 安全进程模型。  
**退出 Gate：** Electron UI 启动；Core 运行在 utilityProcess；typed IPC；凭据保险库；旧 POC 测试全部保留。

### Phase 3：网易云产品能力

**任务：** TASK-020 至 TASK-023  
**目标：** 扫码登录、搜索、我喜欢、歌单、标准领域模型。  
**退出 Gate：** 登录恢复、退出清理、分页、过期恢复、无凭据泄漏。

### Phase 4：播放器与 UI

**任务：** TASK-030 至 TASK-032  
**目标：** 队列、控制、完整 V1 页面与诊断。  
**退出 Gate：** 30 首连续播放、用户可理解错误、UI E2E、无资源泄漏。

### Phase 5：Beta 发布

**任务：** TASK-040、TASK-041  
**目标：** DMG、签名、公证、干净机验证、发布说明。  
**退出 Gate：** Beta acceptance 全部通过，残余风险有清单。

阶段不能跳过。尤其禁止在 POC 未出声前开发 UI，也禁止在未建立 safeStorage 前把手动 Cookie 方式包装成发布版。

---

## 13. LunaMax 执行协议

### 13.1 每次只做一个任务

Owner 每次只给出一个任务文件，例如：

```text
阅读 docs/09_MASTER_DEVELOPMENT_BLUEPRINT.md、
docs/10_LUNAMAX_OPERATING_PROTOCOL.md，
然后只执行 tasks/TASK-000_ENVIRONMENT_REANCHOR.md。
不要开始任何后续任务。
```

### 13.2 开工前输出

LunaMax 在改代码前必须先输出：

- 当前任务目标复述。
- 将读取和修改的文件列表。
- 风险和假设。
- 验收命令。

它不得因为“顺手”修改任务之外的模块。

### 13.3 实施规则

- TypeScript strict，不使用无说明的 `any`。
- 先补测试或 Fake，再修改实现。
- 不重写工作正常的模块。
- 不升级依赖，不改架构，不改端口和安全策略。
- 不使用 FFmpeg，不下载音频，不加入解灰。
- 不把 Cookie、URL、token 打印到终端或报告。
- 不 push、不创建 PR、不发布包，除非 Owner 明确授权。

### 13.4 两轮修复上限

同一 Gate 连续两轮修复仍失败时，LunaMax必须停止扩散修改并提交：

- 最小复现。
- 已尝试方案。
- 原始错误摘要。
- 受影响文件。
- 推荐下一步调查。

禁止第三轮“碰碰运气式”大改。

### 13.5 任务结束报告

每个任务创建：

```text
reports/TASK-xxx_RESULT.md
```

固定包含：

- 修改文件。
- 设计选择。
- 执行命令与结果。
- 未通过项。
- 安全检查。
- 对后续任务的影响。

报告中不能使用“应该可以”“大概没问题”替代证据。

---

## 14. 测试策略

### 14.1 测试金字塔

#### 单元测试

- 网易云响应解析。
- 音质降级识别。
- 安全配置拒绝。
- 状态机与队列。
- token 生命周期。
- 公开错误映射。

#### 契约测试

- 使用脱敏 fixture 验证 Provider Adapter。
- 使用 Fake Roon 验证 Session 顺序。
- 使用 typed IPC schema 验证 Main/Core/Renderer 契约。

#### 集成测试

- 本地假 CDN 支持 200、206、HEAD、重定向、断流和过期。
- Gateway 验证 Range、backpressure 与清理。
- utilityProcess 崩溃和 Main 自动恢复。

#### Electron E2E

- 首次启动。
- 未登录、已登录、登录过期。
- Roon 未配对、未选 Zone、Zone 丢失。
- 搜索、播放、停止、下一首。
- 退出时 Core 与 Gateway 清理。

#### 实机 Gate

- 真实 Roon Server。
- 真实账号合法歌曲。
- 普通音质和无损。
- Signal Path。
- 长队列。

### 14.2 必须保留的命令

最终根目录至少提供：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm build
pnpm verify
```

`verify` 必须按顺序执行静态检查、测试和构建。实机 Gate 单独执行，不允许用 Fake 代替。

### 14.3 日志

日志采用结构化事件，但默认不写大量 Debug：

- `event`
- `component`
- `state`
- `diagnosticId`
- `durationMs`
- 脱敏错误码

禁止字段：Cookie、Authorization、完整 URL、Query、token、手机号。

---

## 15. 持久化与迁移

### 15.1 V1 前半期

保存：

- 选定 Roon output ID。
- UI 偏好。
- 最近搜索（可关闭）。
- 加密后的网易云凭据。

不保存音频、完整上游 URL 或流 token。

### 15.2 SQLite 引入条件

只有在搜索缓存、播放历史和队列恢复确实需要查询能力时才引入 SQLite。引入必须单独任务，包含：

- schema version。
- migration tests。
- 回滚/备份策略。
- 数据删除入口。

不得在扫码登录任务中顺手加入数据库。

---

## 16. 打包与发布

### 16.1 macOS V1

- Universal 或按实际硬件确定 arm64；架构选择由 Beta 设备决定。
- Bundle ID 固定。
- Hardened Runtime。
- Developer ID 签名。
- Apple Notarization。
- DMG 安装。
- 首次启动对网络权限和 Roon Extension 配对有明确引导。

### 16.2 不做自动更新

V1 Beta 通过手动下载新 DMG 更新。自动更新涉及签名、发布服务器和回滚，放到 V1.1。

### 16.3 崩溃与诊断

V1 不上传云端崩溃报告。提供“导出诊断包”：

- 版本、macOS、Electron/Node。
- Roon 配对与 Zone 状态。
- 最近脱敏事件。
- 测试结果。

导出前必须运行秘密扫描。

---

## 17. 风险登记

| ID | 风险 | 影响 | 控制 |
|---|---|---|---|
| R-001 | 网易云 API 为非官方逆向生态 | 登录或 URL 随时失效 | Adapter 边界、固定版本、契约 fixture |
| R-002 | 上游含解灰能力 | 版权与供应链风险 | 启动硬禁用、禁止接口、依赖审计 |
| R-003 | Roon Audio Input 文档薄 | Roon 版本行为差异 | 官方示例基线、真实 Gate、Fake 不替代实机 |
| R-004 | URL 有效期与重定向 | 播放中断 | 单次刷新、Range 测试、确定失败状态 |
| R-005 | Electron IPC 或 Renderer 权限过大 | 凭据/系统泄漏 | sandbox、contextIsolation、白名单 IPC |
| R-006 | utilityProcess 与独立 Node 行为不一致 | Electron 化后回归 | Node/Electron 兼容矩阵与集成测试 |
| R-007 | 账号实际音质降级 | 用户误判 | 请求/实际/Signal Path 三方记录 |
| R-008 | 长队列资源泄漏 | 稳定性差 | token/session/listener 清理测试与 30 首 Gate |
| R-009 | 跨机器需求提前出现 | V1 使用受限 | Core 保持 Headless 能力，V1.1 再分离 Agent |
| R-010 | 依赖更新带来隐性回归 | 难排查 | 精确 pin、单独升级任务、lockfile |
| R-011 | 服务条款或发布合规不明确 | 无法公开分发 | 个人本地 Beta；正式公开前单独法律审查 |

---

## 18. Owner 现在该做什么

VS Code 只是 IDE，还需要运行环境。按以下顺序：

1. 把本开发包解压到一个全新的项目目录，不要和其他项目混用。
2. 安装或确认 Git：

   ```bash
   git --version
   ```

3. 安装或确认 Node.js 22 LTS：

   ```bash
   node --version
   npm --version
   ```

4. 在 VS Code 中打开**整个 `music-bridge-for-roon` 文件夹**，不是只打开某一个文件。
5. 推荐安装 VS Code 扩展：
   - Vue - Official
   - ESLint
   - Prettier
6. 不要先创建 Electron 项目，不要先做 UI，不要先复制 Cookie。
7. 给 LunaMax 的第一条指令只执行 `TASK-000_ENVIRONMENT_REANCHOR.md`。
8. TASK-000 报告完成后，再执行 TASK-001。
9. 到 TASK-003/004 需要真实网易云 Cookie 时，只在本机 `.env` 填写，不发给任何模型或聊天。
10. 每个 Gate 通过后保存本地 Git 检查点；未经明确确认不得 push 到远程。

第一条可直接粘贴给 LunaMax 的提示词在根目录 `START_HERE_LUNAMAX.md`。

---

## 19. Definition of Done

一个任务只有满足下列全部条件才算完成：

- 任务范围内功能实现。
- 新增行为有自动测试。
- 原有测试没有回归。
- typecheck、test、build 通过。
- 安全规则没有被放宽。
- 敏感信息扫描通过。
- 有 `reports/TASK-xxx_RESULT.md`。
- 实机任务有截图/Signal Path/日志证据。
- 未通过项明确列出，不隐藏。

一个阶段只有在其 Exit Gate 全部通过后才可进入下一阶段。

---

## 20. 变更控制

需要修改以下任一内容时，LunaMax 必须停止并提交 Change Request，不得自行决定：

- Electron / Vue / Node / Roon 集成技术栈。
- 同机部署边界。
- Provider Adapter 与 RoonPort 接口。
- Cookie 存储策略。
- 网关绑定地址或远程访问。
- 解灰与版权边界。
- V1 页面与功能范围。
- 引入新数据库、语言或后台服务。
- 依赖主版本升级。

Change Request 格式：

```text
问题：
现有基线为什么无法满足：
候选方案：
风险与迁移成本：
推荐方案：
需要 Owner 决策的具体问题：
```

---

## 21. 当前权威文件顺序

LunaMax 必须按以下顺序理解项目：

1. `START_HERE_LUNAMAX.md`
2. `docs/09_MASTER_DEVELOPMENT_BLUEPRINT.md`（本文）
3. `docs/10_LUNAMAX_OPERATING_PROTOCOL.md`
4. 当前编号任务文件
5. POC 阶段再读 `docs/00` 至 `docs/08`

发生冲突时：

```text
Owner 最新明确决定
  > 本文档
  > LunaMax Operating Protocol
  > 当前任务文件
  > 原 POC 文档
  > 代码注释
```

---

## 22. 外部技术基线（截至 2026-08-20）

- Electron 官方进程模型：Main、Renderer、Preload 与 `utilityProcess`。
- Electron 官方安全建议：sandbox、context isolation、限制 IPC 与远程内容。
- Electron `safeStorage`：使用操作系统密钥体系，macOS 由 Keychain 保护；优先异步 API。
- Vue 3 官方 TypeScript 支持与 Vite 路径。
- Node.js 24、22 均处于 LTS 支持线；生产使用受支持 LTS。
- RoonLabs 官方 `roon-connect-stream-example` 与 `node-roon-api-audioinput`。
- `@neteasecloudmusicapienhanced/api` 仅作为非官方适配器基线，不代表网易云官方授权。

详细链接与固定 commit 见 `docs/08_UPSTREAM_BASELINE.md` 和本包 `docs/14_SOURCE_BASELINE.md`。
