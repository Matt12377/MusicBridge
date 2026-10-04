# MBRS-001 官方 SDK 与原 Adapter 行为记录

本文的静态定位基线为 RUST-016 final `6f1cc0edcb0c59b78a2dfd0828b8e6196e816e47`。官方 `node-roon-api-audioinput` 锁定 revision 为 `21ff59e52a12cf36a21bb9d3fd546f3e6d70581f`，本树实际 lib.js 为1511字节，SHA256 `807a30adb8a6c9b6f0d9e9f913d5b2f7be9694f0e8c6dfa7c428da4261c1cd23`。本轮工具复用 `packages/bridge-core/src/roon/adapter.ts`，生产源码保持。

## 薄 SDK 的可观察合同

| 调用 | 锁定类的实际行为 | 本轮结果的边界 |
|---|---|---|
| begin_session | 实际向 moo 的 audioinput begin_session 发送 options；返回句柄初始 session_id=null。收到 SessionBegan 时先赋 ID，再把 msg.name 字符串与 body 交给 Adapter。 | 请求已发、会话已建立、Playing 和实际发声分别观察。 |
| play | 直接转发 options；回调仍为 moo 原消息对象与 body。 | 不能把 begin 的字符串合同套到 play，也不能由 HTTP200推 Playing。 |
| end_session | 只有返回句柄已有 session_id 才发送 moo end_session；提前调用完全 no-op。 | 句柄调用次数与真实 moo 请求数分开。 |
| clear / update_track_info / update_transport_controls | 薄类仅转发各自 method/options/callback。 | 许可字段或 Success 不证明真实设备的控制效果。 |

能力媒体 URL、opaque token 和 session handle 仅在私有工具内存里做精确断言。落盘使用 attempt/sample 别名、字段形状、字节摘要和独立资源计数，不保存这些能力值。本文不列真实路径、账号或设备。

## 原 Adapter 的代际与资源观察

| 场景 | 源码可观察行为 | 必须单列的结果 |
|---|---|---|
| begin 已派发后取消，尚未 SessionBegan | 取消拒绝启动 Promise，保留 stopping context；还需 explicit stop。官方早期 end 没有请求，晚到 SessionBegan 后才有补发 end。 | 收到与实际请求对应的关闭确认后，才能写 confirmed closed。取消本身不自动证明关闭。 |
| 已收到 Playing，之后仅收到当前 SessionEnded | Adapter 清当前 context 并转 ready，但不通知 terminal handler。 | KNOWN_GAP；context=0 不证明媒体租约已回收。本轮不修生产 Adapter。 |
| 等待 SessionBegan 超时 | 启动拒绝并清 context。晚到 SessionBegan 被 stale fence 忽略，没有 play/end 请求。 | 后续 stop 可因本地无 context 返回；远端仍 UNCONFIRMED。没有实际 play 请求时，测试不能捏造 Playing callback。 |
| 已发 play，等待 Playing 超时 | 清 context；该实际 play 的晚到 Playing/Time 被忽略。 | 保留启动超时及远端 UNCONFIRMED，不能用本地计数归零抵扣。 |
| 已 Playing 后 explicit stop 超时 | stopping context 保留，确认前远端未知；晚到真实关闭确认后清 context，并通知迟到 reconcile。 | 原失败原件保留，晚确认独立记录；不自动重发播放。 |

以上为源代码及锁定依赖的观察表；测试 GREEN 可以证实已知行为，却不等于修复缺口或关闭原 MBRS-AT-001-06。媒体租约的请求 ref、会话 ref、实际 FD close 与远端确认分别统计。旧 attempt 的终态不得撤销新 attempt 的 token 或句柄。

## track、channel 与时间

原 Adapter 仅保留已实现的 track/channel 两种模式，不猜 next-slot。Audio Input 的合法毫秒字段为 seek_position_ms；旧字段、负数、非整数及超出界限值不会被合法时间解析器纳入。一个合法整数自身无法证明调用方没有把秒当毫秒，因此不声称形状检查拒绝了所有单位错误。

Paused 可以使启动 Promise 落定，不能替代 Playing 观察。Transport seek 的毫秒入参会转成秒交原 transport；pause/resume/seek 的真实控制效果仍属于原 live_roon 验收。离线 Fake 的 callback、回执与 Zone revision 只能证明软件合同。

## 真实项

真实未入库文件点播、两份同名真实样本的来源与 attempt 关联、Core可达地址、pause/resume/seek、track/channel出声及全部格式结果均 NOT_TESTED / BLOCKED_ENV。Fake 不做真实 discovery、Browse、Resolver、增强、媒体网络或设备调用。后续005/006继承本记录并补生产租约与原 coordinator 接入；格式边界见 [FORMAT_INITIAL_MATRIX.md](FORMAT_INITIAL_MATRIX.md)。

最终运行计数、工具观察与命令退出码由 [DIRECT_STREAM_POC_RESULT.md](DIRECT_STREAM_POC_RESULT.md) 登记；最终本机 source05 Gate实跑32新增与118原回归全部通过；实际结论仍仅隔离软件合同，不扩展成真实Roon行为或出声PASS。

本机控制实跑补充：原Adapter pause/resume传单字段zone_id对象，seek目标仍为Zone字符串。正常显式stop的关闭回执不保证触发terminal，调用方按所属attempt完成本地dispose。停止超时后即使本地FD收口，工具仍要求原Adapter旧context实际清除，才允许新attempt取得观察owner；不能先挂新handler再重试旧stop。
