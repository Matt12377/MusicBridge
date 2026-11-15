# iOS 会话交接：资料库渐进可用

## 分工与基线

- 本会话只开发桌面/Core；不修改、构建、签名、安装或部署 iOS。
- 桌面起始基线：`399f5ddc534a8baad9e857eb126a73a0a08cbcc4`。
- 桌面第一项分支：`codex/mousa-4-1-progressive-library-shell`，目录 `worktree/progressive-library-shell`。
- 目标、阶段与安全约束见 `docs/adr/ADR-MOUSA-4-1-PROGRESSIVE-LIBRARY.md`。

## 当前接口承诺

第一项拆桌面应用壳/设置启动门禁；第二项只为桌面增加具名的可选版本化读取；第三、四项仅调整 Core 内部核验与扫描调度。不改变 iOS HTTP DTO、SRP、配对、authority/profile、LAN/Tailscale 路由、资源票据或队列恢复合同。既有客户端无需为此更新。后续如确需跨端合同变化，将先在本文件列出版本和兼容行为，不能要求旧 iPhone Air 客户端同步升级才能使用。

### 桌面第二项的可选能力

- 分支：`codex/mousa-4-1-progressive-library-batches`，基线 `815311e3efd29621e378c5ad8cb6c5118795f2fe`。
- 新增桌面具名只读命令 `localAlbum.queryVersioned`，公开可选方法 `queryLocalAlbumsVersioned`，内部可选读端口 `queryVersionedAlbums`；闭集返回 `{ revision, page }`，每页 1–100 张，`revision` 为 64 位小写十六进制。
- **不是新 iOS HTTP 接口**，不能向旧 HTTP DTO 猜加 `revision`。旧专辑查询形状和 200 上限保留；没有新能力的旧适配器沿原严格分页，不把无版本页伪装为版本化页。
- 修订是当前单页与成员目录身份，不是持续快照、游标票据、Source 授权或可播放资格。目录、扫描、名称/歌词、来源及组织事实变化会推进；按封面筛选还包含库存成员变化，普通补图不使普通画廊反复重排。
- 桌面逐页发布、按实际条数推进 offset；漂移时保留卡片并去重，完整稳定轮才删项/排序。扫描提交不必攒够 100 张，100 只是页面上限。成长专辑的当前曲目另走原详情/唯一队列，不拿旧摘要直接发起播放。

### 桌面第三项的 Core 内部启动边界

- 分支：`codex/mousa-4-1-progressive-library-audit`，基线 `ad52961f7064ec731d868e1330fcedc751be08bc`。只拆内部启动审计服务与原事务读 session，不新增 HTTP、IPC、SRP、Source 或播放授权能力。
- 已核缓存仍须通过既有内容指纹与实现/runtime/schema/物理身份检查；miss 时两域完整核验。原关键恢复、唯一提交与 Owner 交付之前仍不提供业务就绪，任一域失败不返回部分可用证明。
- 只在原同步启动事务和同一次完整核验中有界复用已 guard 的批原文；逐行实际 SQL 水位与 file-state/关联检查保留。水位变化、事务结束、取消或代次失效不续借。它不是客户端游标、持续快照、离线可播放资格或可下放到 iOS 的权限。
- 旧迁移/备份/恢复普通核验仍保留原逐项实读。iOS 可以继续按原 HTTP/authority/epoch 合同开发，不需要复刻桌面内部事务优化；打包、软件 Gate、实际起播与 Owner 接受分别记录。

### 桌面第四项的 Core 内部播放优先预算

- 分支：`codex/mousa-4-1-progressive-library-playback`，基线 `cba4f540dc45eaff4e280a3a05aa94758680fd8f`，实现 `9465b97f34a15e54d742bb9c3b87bdcbad81b6ec`。
- `scanReadBudget` 仅为原 Node Core↔唯一 Owner 私有空请求，返回调度上限 0／1／2／8；不是新增 HTTP/Renderer 命令、可用空槽、Source 许可、客户端状态字段或 iOS 能力。不要把它加入旧 HTTP DTO，也不要从手机 playing 字段推导授权。
- 起播/切歌/seek 等原关键期先退让；同一原播放代和资源归属合格、连续稳定至少 2000ms 后最多一槽，仍逐读取得原票据和统一 claims。失观测、不明/并行媒体读保守暂停，不承诺所有设备都可无条件边播边扫。
- 手动暂停/取消扫描、实际 FD quiet、恢复/COMMIT/readiness、原唯一播放队列不变；原 recording 路径和源写默认 OFF 保留。不为页面变得可浏览而自动建队列或开始播放。
- iOS 可以继续按旧 HTTP/authority/epoch 与来源身份合同开发；本会话没有修改、构建、安装或部署 iOS，实际音频与成品接受仍单列。

## iOS 可并行处理的边界

1. 页面导航、外观、关于可独立于资料库完全就绪；具体连接、查询和播放控件分别按真实服务资格开放。
2. 分页结果的总量会随着扫描提交增长，不能把总量变化等同于空库，也不能把旧快照卡片直接转为可播放身份。
3. 取消/切库/换 epoch 后，晚到页必须丢弃；按当前接口的分页/游标契约消费，不能猜测未公布的新字段。
4. 播放仍由唯一服务端权威与原队列控制；不自动播放，不把新扫描曲目自动追加到已建立队列；暂停恢复不自动 prepare/load/grant。
5. LAN/Tailscale 仍是同一 authority/credentials 的不同路由，不能建立第二配对身份或控制会话。

## 状态

第一项应用壳/设置已实现，提交 `966445257469ff1a4e3250f5f6c9cc725e73609a`；[第一项报告](../reports/MOUSA_4_1_PROGRESSIVE_LIBRARY_SHELL_2026-11-15.md)保留当时的 188 项相关回归、类型检查、双模式隔离启动和旧 VM 夹具债务证据。

第二项已补齐这些夹具的真实依赖，并实现上述版本化渐进读取。最终桌面完整集 **3120/3120**、选定 Core/权限撤销/队列保护集 **333/333**、真实 SQLite 的 80,000 条合成提交专项 **1/1** 通过；桌面/Core/测试类型检查和官方 Electron 双模式隔离 mock-keychain 启动退出 0。实现身份、完整证据范围与未验收项目见[第二项报告](../reports/MOUSA_4_1_PROGRESSIVE_LIBRARY_BATCHES_2026-11-15.md)。

第三项历史核验/启动服务已实现，提交 `f077b65c82086245209d974977a70c78364e2a93`。8 万条合成原件的两域完整核验约从 27.806 秒降为 14.385 秒，仍在原保护事务内；真实克隆冷/暖重开、38 项启动/缓存保护、Core 主集及双模式隔离启动通过。扩展深层集中另有一项在原基线与候选上都实际复现的可选 MPC8 格式失败，保留原严格期望、不标绿，完整范围见[第三项报告](../reports/MOUSA_4_1_PROGRESSIVE_LIBRARY_AUDIT_2026-11-15.md)。

第四项播放优先扫描已实现，标准 Core 3870 项中 3868 通过、2 项原有显式原生 opt-in skip，桌面 3120/3120，实际 Rust/原 Runtime 合成集成 16/16，以及官方 Electron production/development 双模式 mock-keychain 启动通过。合成链路首 64/128 项已提交时原播放先完成自有 loopback 响应，之后同一原播放 session 下按一槽扫完剩余项；真实 Native 在途撤权和 FD 收口另有独立保护。保留同一可选 MPC8 失败，不称全绿，详见[第四项报告](../reports/MOUSA_4_1_PROGRESSIVE_LIBRARY_PLAYBACK_2026-11-15.md)。

iOS 当前不需要为这四项更新 HTTP 接口。不把桌面 IPC、Core 内部审计或预算读口当成已发布 HTTP 能力，也不据此扩大任何格式或播放资格。四项仅按隔离开发树与普通分支推送交付，没有替换当前用户 App。本文件不是部署许可或真机音频验收；Owner 接受与真实音频均未认证。
