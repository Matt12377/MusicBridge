# ADR-007：以 V1 为产品基线接入 V2 本地音乐库

## 状态

已接受，适用于 `codex/v1-v2-integration` 及其后续合并。

## 背景

V1 已完成搜索、资料库、队列、歌词、Now Playing、账户状态和桌面交互等多轮修复；V2 在较早的产品基线上新增 Roon 本地音乐库、匹配、收藏、混合队列和远程开发能力。直接选择 V2 冲突版本会重新引入 V1 已修复的问题，直接选择 V1 又会丢失本地音乐库能力。

本次集成的产品规则是：V2 功能全部保留；凡 V1 与 V2 冲突，以 V1 的界面、用户语义、Provider 行为和公开合同为基础，把 V2 作为增量能力接入。

## 决策

### 1. V1 是产品行为基线

- 保留 V1 的页面层级、响应式布局、虚拟列表、搜索分区、歌单与收藏分页、队列、歌词、Now Playing、账户状态和错误文案。
- 保留 V1 的 NetEase track ID 作为统一队列的逻辑身份，歌词、Provider 收藏和历史记录不因实际播放来源切换而失去关联。
- 保留 V1 已修复的公开搜索语义：搜索需要已配置账户，但不会把账户凭据转发给公开搜索端点；失败快照不进入缓存。
- V2 页面只增加到现有侧栏与内容区域，不用 V2 的旧版 `App.vue` 或样式整体覆盖 V1。

### 2. V2 通过有界合同增量接入

- Renderer 只能通过 Preload 的类型化 API 访问 Roon albums、artists、genres、playlists、album/artist detail、search、image、play、queue、stop 和 seek。
- Roon Browse 的运行时 `item_key` 不进入持久化收藏，也不作为 Renderer 可自行拼接的公开参数；公开引用由 Core 生成并校验作用域。
- Roon Track 引用的完整 128-bit UUID 映射为十进制兼容 ID，避免旧 32-bit 哈希在 V1 数字 track ID 边界内产生高概率碰撞。
- Browse、load、image 和 transport callback 都有有界超时；公开错误不暴露 Core、Roon、Provider 或 Electron 内部细节。

### 3. 播放来源按曲目锁定并安全回退

- 未知或非唯一匹配仍立即走 V1 Provider；后台匹配只为后续播放预热，不中途切换当前歌曲。
- 只有缓存中的 `confirmed` 匹配可把 Smart 队列项解析为原生 Roon；开始后该队列项的来源保持不变。
- 原生 Roon 启动失败时先有界停止残留 session，再清除本次 Roon 解析字段并回退到 V1 Provider。
- V1 Provider Audio Input 继续保持不可 seek；只有当前来源为原生 Roon，且所选 Zone 明确报告 `seekAllowed=true` 时，Renderer 才开放 seek。
- 混合队列仍使用 V1 的统一队列控制、容量上限和真实曲目摘要，不建立第二套 Renderer 播放状态机。
- 从混合队列中选择歌曲时只更新当前索引并解析该队列项，不把被选歌曲重建成单曲队列，避免破坏 V1 的前后曲目与队列顺序。

### 4. 收藏与匹配保持双身份边界

- NetEase like 与本地 Roon favorite 是两个独立、显式的写操作；双身份 Heart 通过协调逻辑保持两边一致。
- Smart 队列项保留 V1 NetEase 身份，即使当前已解析为原生 Roon 且 Renderer 没有本地 descriptor，也继续提供歌词和 NetEase Heart；有确认的本地 descriptor 时再同步 Roon favorite。
- NetEase 收藏查询和修改必须收到明确成功字段；缺失或含糊的上游响应按失败处理，不能默认成“未收藏”或“修改成功”。
- 本地收藏只持久化稳定公开元数据，不持久化 Roon runtime reference、媒体路径、上游 URL、账号字段或凭据。
- 收藏文件使用串行、原子替换；写入失败时回滚内存状态并清理临时文件，损坏文件拒绝静默覆盖。
- 匹配缓存有容量与 TTL；Roon Library 暂时不可用等瞬态失败不进入缓存，配对可用性变化会使旧运行时引用失效；批量 Browse 匹配并发固定为不超过 3，且输出顺序与输入一致。

### 5. Roon 动作与远程开发继续 fail-closed

- 删除、移出资料库和未知 Browse Action 始终阻断；Play、Queue、Favorite 只有在类型化 allowlist 和显式 mutation 许可同时满足时执行。
- Control API、Stream Gateway、Roon Core websocket 和 SSH 转发只使用规定的 loopback 地址与有界端口集合。
- 远程开发复用受控 secondary port pair，并明确提示 Owner 在 Roon 中启用 Dev Mac extension；配对和真实播放仍是独立人工 Gate。

## 后果

- V1 后续修复可以继续围绕原有 UI 和统一队列演进；Roon 能力集中在合同、Core library/adapter、共享 composable 和少量 V1 页面接入点。
- V2 的 albums、artists、genres、playlists、search、detail、image、typed play/queue、favorites、matching、Smart mixed queue、stop、seek、remote control、Core websocket、secondary ports 和 pairing guidance 均保留。
- 自动测试、Electron/E2E、真实 Provider、真实 Roon/Core Mac 和 Owner 听感验收继续分开记录。自动 Gate 通过不能替代真实 Roon 配对、播放、seek、收藏与匹配验收。
