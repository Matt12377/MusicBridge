# Roon 接入层专项计划

状态：**Owner 已于 2026-11-01 批准执行；工程及真实 Mac/mini 验证完成，Owner 听感验收另记**。本专项只改 Mousa ↔ Roon 的接入层，不重做播放系统、曲库、扫描、录音或 UI 架构。

## 1. 范围

### 本轮做

- 用 Roon 官方接口直接发现、配对并连接目标 Core，不再把 SSH 作为同局域网主路径。
- 由 Mousa 媒体服务发布 mini 真正可访问的音频 URL 和实际端口；Roon Core 按该 URL 取流。
- Mousa 的控制、账户、诊断接口继续留在本机 loopback。
- 把“控制已连接 / 音频已读取 / 播放已开始”拆成三个可观测状态。
- 用真实 Mac + mini 播放验证 30 秒超时是否消失；换掉 SSH 本身不作为成功证据。

### 本轮不做

- 重写播放队列、传输控制、歌词、曲库或 Roon SDK 封装。
- 把 Mousa 媒体服务或 Core 迁到 mini（方案 2，另立项目）。
- Tailscale 手机接入（独立专项；现有移动 HTTPS 只接受私有 IPv4，需要单独适配）。
- 播放期间电源管理、启动全量性能优化（独立任务；只做接入层必须的启动/端口修正）。
- 改变 Roon 官方协议、Audio Input 语义或用户已有的播放凭据/来源校验。

## 2. 官方依据

- [node-roon-api](https://github.com/RoonLabs/node-roon-api)：扩展通过 `start_discovery()` 发现 Core，通过 `core_paired`/`core_unpaired` 或 `ws_connect({host, port})` 直连；Roon 不要求 SSH。
- [roon-connect-stream-example/lib.mjs](https://github.com/RoonLabs/roon-connect-stream-example/blob/main/lib.mjs)：通过 `RoonApiAudioInput.begin_session()` 和 `play({ media_url: url })` 让 Core 取流；`Playing` / `Time` / `MediaError` 是 Core 侧的真实回执。
- 结论：SSH 是项目为跨机器回环地址加的中间层，不是 Roon 的要求。问题不在“Roon 需要 SSH”，而在“Core 能否访问 Mousa 发布的媒体 URL”。

## 3. 实施前采样事实

- 运行中的 Mousa Core 是 local 模式，公开流地址为 `http://127.0.0.1:<port>`。
- Roon Core 在 mini；mini 访问 `127.0.0.1` 只会访问它自己。
- 本次采样没有 SSH 隧道进程，也没有 LAN 媒体监听；只能确认本次运行的远程音频发布未启用，不推断历史状态。
- 30 秒超时与此高度一致，但最终归因仍需真实取流证据；不能仅凭“去掉 SSH”宣告解决。

## 4. 目标链路（方案 1）

```text
Mousa Core / 媒体服务（Mac）
  ├─ Roon 官方控制连接（发现/配对） ───────────────► mini Roon Core
  ├─ 媒体服务绑定 Mac 的 LAN IP，发布 media_url ───► mini Roon Core 取流
  └─ 控制 / 账户 / 诊断 ── loopback（仅本机）

mini Roon Core ──► 用户所选 Roon Zone / 播放设备
NAS 曲库 ──► Mac 媒体服务读取（保持现有位置）
```

- Roon 控制：官方 discovery/pairing 或显式 `ws_connect`；不经过 SSH `-L`。
- 音频：Mousa 媒体服务绑定指定 LAN 地址，`media_url` 使用该地址和实际端口；Roon Core 直接取流。
- Mousa 控制、账户、诊断：继续 loopback，不随音频地址一起暴露。
- 播放凭据、token、来源校验沿用现有实现；只新增“发布地址”和“对端可达性”这一层。

## 5. 任务

### RI-001：接入层现状取证（只读）

- 记录当前 Core 发现/配对方式、`media_url` 生成、媒体服务绑定地址/端口、SSH 使用点、状态事件。
- 确认目标 Core 身份（避免多 Core 时连错）；记录当前失败阶段。
- 产出简短基线报告；不改代码。

### RI-002：官方直连 Core，移除同 LAN SSH 主路径

- 使用既有 `node-roon-api` 发现/配对；多 Core 时确认目标 Core，不自动连第一个。
- 同 LAN 默认不启动 `/usr/bin/ssh`；SSH 仅保留为显式回退。
- 保持现有 Roon 授权 token/配对持久化；发现模式复用官方 SDK 的再发现；显式连接由既有连接生命周期负责断开后重拨和退出撤销，`core_unpaired` 只是事件，不视为自动重连保证。
- 测试：无 SSH 子进程；目标 Core 正确；断线重连；多 Core 选择。

### RI-003：发布 mini 可达的媒体 URL

- 媒体服务只绑定指定 LAN IP，不绑定 `0.0.0.0`；端口沿用/确认实际可用端口。
- `media_url` 使用 `http://<mac-lan-ip>:<port>/...`；token、来源校验、Range 行为保持不变。
- 对端 allowlist 只允许实际已配对 Core 的精确地址，不自动放宽子网。
- 同时接通本地 `/local-stream/`、已登记的网易云 `/stream/` 和固定 `/assets/icon.png`；图标地址校验仅接受本机或当前可信媒体 origin。
- 普通桌面在已配对远端 Core 后启用其对应媒体监听；未配对、测试、退出或显式 SSH 回退时不自动开放。端口以实际监听为准。
- 控制、账户、诊断继续 loopback。
- 测试：LAN host 校验；URL 主机/端口正确；非白名单来源拒绝；控制端口不随之上 LAN。

### RI-004：状态拆分与失败归因

- 三个独立状态：
  1. **控制已连接**：`core_paired` / zone subscription 成功。
  2. **音频已读取**：媒体服务收到 mini 的请求并实际返回字节（含 Range）。
  3. **播放已开始**：Roon AudioInput 对本次 Core/Zone/会话返回 `Playing`；Zone 快照只作补充，不能用旧播放或其他人的播放冒充本次成功。
- 失败归因矩阵：
  - 无控制连接 → 发现/配对/token。
  - 控制有、媒体服务无请求 → 先分辨停止旧会话、`SessionBegan`、本次 `play` 发出；只有确认已发出后才检查 URL/主机/防火墙/端口。
  - 有请求无字节或 4xx/5xx → token/来源/Range/格式。
  - 有字节但无 `Playing` → AudioInput/Zone/格式/媒体错误。
  - `Playing` 但无声 → Zone/设备/输出。
- 诊断只记录 host/port/阶段/错误码，不记录完整 URL、token、凭据、Roon session。
- 测试：每个阶段的可观测事件和错误归因；状态不互相冒充。

### RI-005：真实播放验证

- Mac + mini 同 LAN；NAS/网易云各至少一首；验证暂停恢复、拖动/Range、切歌以及 Mousa 断开重连。
- 记录：目标 Core 身份、`media_url` host/port（token 脱敏）、mini 侧取流结果、媒体服务字节/Range、Roon `Playing`/`MediaError`、Zone/设备。
- 明确回答：30 秒超时是否消失；若仍存在，归因到上述哪一层。
- 自动测试、合成 Electron、真实 Mac/mini 验收分开记录；真实凭据不入 CI/报告。

## 6. 验收标准

- 同 LAN 正常路径无 SSH；Roon 控制直连目标 Core。
- mini 能从 Mac 的 LAN 地址取到音频；不再发布 `127.0.0.1` 给远程 Core。
- Mousa 控制/账户/诊断仍只在本机 loopback。
- “控制/音频/播放”三态可分别观测，失败时能指出断点。
- 真实播放验证必须通过；若仍超时，只能记录定位完成/播放未通过及其阶段，不能算修复完成。不以“换掉 SSH”代替播放证据。
- 不改变播放队列、曲库、录音和 Roon 协议语义。

## 7. 与独立专项的边界

- **Tailscale 手机**：独立专项。当前移动 HTTPS 只接受私有 IPv4，`100.64.0.0/10` 和 Bonjour 均未适配；不要混入本接入层改动。
- **播放队列 CANCELLED / idle 队列**：独立的小范围正确性修复；不属于“Roon 接入层”，本轮不重做播放系统。
- **启动全量优化 / 端口保留**：独立任务；本专项只处理媒体服务发布地址和接入所必需的端口。
- **Core-on-mini（方案 2）**：未来选项；NAS 双端可访问使其可行，但需要远程 UI、数据/凭据迁移和部署体系，本轮不做。

## 8. 风险与回退

| 风险 | 缓解 |
| --- | --- |
| Mac LAN IP 变化 | 固定 DHCP/静态地址；发布前重新确认；变化时停止旧流并重建 |
| macOS 防火墙拦截 mini | 启用前提示放行；真实取流验证；记录实际 peer |
| Roon Core 来源 IP 非预期 | 对端 allowlist 只使用已确认 Core 的精确地址；地址变化重新确认，不自动子网回退 |
| 多 Roon Core 连错 | 显式确认目标 Core；配对后校验 core_id/display_name；不自动选第一个 |
| 媒体 URL/端口被缓存 | transport/host 变化时结束旧 AudioInput session，重新发布 |
| 30 秒超时仍存在 | 按 RI-004 归因，不宣告已解决；必要时保留 SSH 显式回退 |
| 安全边界回退 | 独立媒体监听仅在可信桌面启动且已配对远端 Core 后启用；未配对/断开/退出撤销；控制/诊断仍 loopback；ADR 记录 |

## 9. 已批准执行

- 采用方案 1：保留 Mac 媒体服务，LAN 直连 mini，移除同 LAN SSH 主路径。
- 批准媒体服务绑定指定 LAN IP，并接受对端 allowlist + token 的安全设计。
- 批准后从 `worktree/v4` 当前 HEAD 新建独立分支/工作树实施 RI-001 → RI-005；不修改正在运行的 v4 工作树。
- 执行前按 `AGENTS.md` 确认模型/会话，或 Owner 明确授权当前会话继续。

## 执行记录

- 基线：`92f72475b8579db28f1dfa18ed94aea089cb4700`；工作树 `worktree/roon-integration`，分支 `codex/mousa-4-1-roon-integration`。
- 沿用 Owner 已指定的 Astra 主会话；原 RI-001～RI-005 编号与任务范围固定。
- 本轮不修改旧根文档 WIP、不重写队列、不进行源文件标签编辑。

- 收口：RI-001～RI-005 已完成本专项验证，详见 `reports/MOUSA_4_1_ROON_INTEGRATION_2026-11-01.md`；开发版运行且暂停。
