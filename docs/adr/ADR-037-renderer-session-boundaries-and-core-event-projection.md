# ADR-037：Renderer 会话边界与 Core 高频事件投影

状态：2026-09-26 已实现，本轮合成与静态门禁通过；真实 Roon、安装版与 Owner 验收仍待独立完成。基线 `77d05886888d0b9e9a9a8b90605097e8d0259de4`。

## 决定

`App.vue` 保留现有模板、样式和模块装配。应用状态按实际业务所有者拆到 `composables/application/`：

- `usePlaybackSession` 唯一持有播放、歌词、当前收藏身份和播放控制。
- `useAggregatedSearch` 持有主页聚合搜索、来源结果和匹配调度。
- `useRoonBrowse` 持有 Roon 本地列表、详情、收藏和原生浏览入口。
- `useNeteaseLibrary` 持有账号、歌单、喜欢和推荐。
- `usePageJourney` 唯一持有页面导航、搜索返回路径及滚动恢复。
- `useRendererLifecycle` 只装配订阅、初始加载和释放，不再平行保存领域状态。

领域模块使用明确的小接口连接，不互相循环引用，不传入整个 App 上下文；订阅和异步响应仍按现有请求代次、设备与曲目身份拒绝迟到结果。本轮不增加状态框架、IPC 字段或用户可见交互。

`useNeteaseLibrary` 在 Core 或 Remote 不稳定时等待恢复后再读取私有资料，并拒绝登出、歌单切换和卸载之后的旧响应回填。普通切页后同一歌单响应的导航语义沿用旧版；本决定不宣称解决所有导航竞态。

播放收藏描述符仍由播放域持有。合成 Electron 回归揭出旧 `App.vue` 已有的深 `ref` 值直接跨 contextBridge 传递、导致 Proxy 无法克隆的隐患；送入收藏查询/切换 IPC 前，播放域逐字段投影为公开合同的纯标量 DTO。这不新增 IPC 字段，也不改变收藏身份规则。

Core 的内部不可变队列投影供频繁的播放位置通知复用；公开 `getPlaybackState()` 仍返回独立副本，调用方不能修改内部队列。`queue.changed` 由队列投影身份变化触发，位置和歌词推进不应重复发送不变队列。`playback.changed` 继续携带完整公开播放快照及队列，因此不能据此宣称跨进程更新已经与队列长度无关。歌词在确定需要发布后才复制快照；同曲 Roon 观测只在整个公开投影未变化时跳过重复发布。

## 验证与边界

使用固定合成队列和播放/歌词事件序列，记录通知次数、序列化字节及耗时；比较基线与实现，但不将合成吞吐换算为真实帧率。单元、类型、构建、边界及受影响 Electron E2E 均使用 Node 22.23.2、pnpm 10.17.1，在外置 LifeWeave 卷串行执行。E2E 使用合成 IPC 与 mock keychain。

本轮不修改 Roon Display 旧审计的配置竞态、迟到歌词与 `zones_changed` 风险（P1/P2 carryover），也不操作真实 Roon、真实账号、运行中的应用或安装版。真实设备播放、歌词同步、性能体感和 Owner 验收仍是独立门禁。
