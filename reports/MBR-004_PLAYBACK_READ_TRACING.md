# MBR-004 — 快速切歌修复与 Roon 逐请求追踪

基线 `dbece1cb3beacf5dd2d8d24861feb9bf71829b26`；分支 `codex/fix-playback-read-tracing`。实现提交：`16132564d8bbb3bec900602fbf0cdefc86a09bd5`。报告提交按最后修改本文件的提交解析；下一分支从最终报告 HEAD 继续，仍须 Owner 授权。

Owner 在 MBR-003 软件门禁通过后复测，仍遇到 `library:read / CANCELLED` 与 `playback:replace-queue / INTERNAL_ERROR`。本轮按最新授权修复并接通 VSCode 终端追踪，不把 MBR-003 或早期 CI 的绿色结果扩展到真实运行。

## 已确认与仍待确认的故障

此前隔离复现使用实际网易云 Client、Controller 与 Gateway，Provider 返回合成成功数据、CDN 返回合成 HTTP 206，仍能触发请求预算失败：冷启动 9/20 首队列被后台补全争抢；快速切歌留下已撤销但尚未结束的 SDK 请求；41 项旧队列继续派发后继补全；旧 preflight 没有实际取消信号。真实诊断中 3 次失败均为 `NETEASE_REQUEST_FAILED`，但原记录缺少细分 reason，不能断言真实每次失败都由预算引起。

Roon 的真实唯一根因尚未确认。合成 Renderer → Main → Core → SDK 链路已覆盖正常结果、scope 换代、离页取消、迟到回调与完整回执。此前正常进度采样没有观察到 scope 持续换代；原始条目 hint 不匹配能产生 raw 1 / mapped 0 的空页，但没有取得真实 SDK 的条目形状，故保留原 hint 过滤。新日志用于现场归因，不把“已打通追踪”写成“真实 Roon 已恢复”。

此前诊断证据：`/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-upstream-production-repro-xetnly8y/DIAGNOSIS_2026-10-02.md`。

## 最终实现

1. 当前歌曲的元数据与音频地址优先派发。后台补全改为每代有限 worker，换代、Owner 撤销及离开旧队列时停止新派发；迟到响应不得回填新队列。Next 准备有独立取消域，认领后仍跟随新 Owner 的撤销。
2. 网易云非库读取保持总物理在途 8、后台物理在途 2；LibraryRead 独立保持 32。等待队列最多 32，给当前歌曲的 metadata 与 URL 各预留一个位置。原 SDK Promise 实际落定才释放物理槽位，取消与本地超时只结束等待，不假装网络已关闭。
3. 排队与实际 SDK 请求分别默认最多 10 秒；实际派发重新获得完整请求窗口，避免等旧连接释放后只剩几毫秒。准备工作另有最多 10 秒本地等待。固定 SDK 4.40.1 不透传 AbortSignal，但真实 Axios 的 timeout 已生效；合成 loopback 测试观察到 Owner 撤销后连接继续，随后由 timeout 关闭。准备过程自身的物理撤销未证明。
4. Gateway preflight 使用 Owner 的真实 fetch AbortController，启动前取消不派发；取消、超时、迟到响应和响应体关闭分开处理，最后清除监听器与计时器。
5. runtime 保存固定失败分类，并把脱敏后的 `[playback:replace-queue] {code, reason}` 转到开发终端。正常替代取消不记成播放故障；原始消息、URL、凭据与栈不输出。
6. `[library:read]` 贯穿 Renderer、Main/Core 关联编号、flight/scope、SDK browse/load 派发与回调、映射计数及回执。最后订阅者在成功后释放，标记 `last-subscriber-release / outcome=ok`；不会误认为异常取消。每层保留真正的取消/期限来源。
7. 复用既有 `library:read` / `library:cancel-read` 的封闭私有尾参数，不扩展公开 API 或任意日志 IPC。ID、阶段、reason、计数和布尔量重验后转发；utility stdout/stderr 的其他内容只消费、不转发。别名、近期回执与分片缓冲均有界。
8. 开发构建默认开启追踪，production 构建及打包 App 默认关闭，显式 `MUSIC_BRIDGE_LIBRARY_READ_TRACE=0/1` 覆盖。默认开关由编译模式决定，避免未打包 production 构建没有 NODE_ENV 时误开；实际产物已核验。专辑页只在完整、首段、total 0 且有 sourceEpoch 的回执后提示本次无结果，不再凭未完成/被过滤的空页断言 Core 空库。

## 验证与失败归因

所有构建、缓存、临时文件和日志位于已核验的外置 LifeWeave；Node 22.23.2、pnpm 10.17.1。没有调用真实 Provider、Roon/SSH、录音设备或正式安装数据。

| 检查 | 最终结果 |
| --- | --- |
| Contracts 原完整单元范围 | 254/254，退出 0 |
| Core 原完整单元范围 | 2007 通过、0 失败、原 2 项 native 条件跳过，退出 0 |
| Desktop 原完整单元范围 | 1239/1239，退出 0 |
| 全项目 typecheck，含 Vue 与 E2E TS | 退出 0 |
| 当前播放与实际 Client/Gateway 整合 + 安全 stderr | 8/8，退出 0 |
| 网易云请求层，含真实 SDK/Axios 合成 loopback | 18/18，退出 0 |
| Controller / Gateway 受影响回归 | 123/123、24/24，退出均 0 |
| Roon 逐请求追踪、日志安全与 UI 定向 | Core 27/27、Desktop 129/129，退出均 0 |
| 4 份 Desktop 夹具对照与修正 | 基线 32/32；当前 33/33，退出均 0 |
| 根 production build + 沙盒 preload 依赖 | 退出 0 |
| production 实际编译产物日志开关 | 退出 0，默认关闭 |
| development build + 实际产物日志开关 + 沙盒 preload | 退出均 0，默认开启 |
| 原 Electron 启动/Core 重启/凭据恢复，mock 钥匙串 | 4/4，退出 0；真实钥匙串未验证 |
| control-plane / boundaries / cycles | 退出均 0；cycles 检查 378 文件 |
| git diff --check | 退出 0 |

三包完整单元范围与标准 test 脚本的 `test/*.test.ts` 相同，显式 `--test-concurrency=1`；没有新增 skip、删减规格或删除失败断言。分层执行 typecheck、完整单元范围与 build，不声称执行过根 `pnpm verify` 总进程。完整 Electron E2E 未执行，不能用 4 项 mock 进程测试代替。

首轮 Desktop 1238 项中 8 失败：Main factory 1 项与 startup VM 5 项缺少新增日志依赖，Preload 1 项没有真实新模块，空页文案 1 项仍要求“Core 当前返回 0 张”。同环境固定基线的原 4 份规格 32/32 通过，当前补实际 helper/client 后 33/33 通过。保留全部 IPC/ID、托盘、路径隔离、未配对和其他页面保护；cancel 的人工回执改成既有公开 Promise<void> 的 undefined，仍检查原通道与 ID。专辑文案新增“不冒称 Core 0”保护，挂载行为另有完整/过滤空页用例。

首轮 Core 2009 项中 2006 通过、1 失败、原 2 项 native 条件跳过。未修改的“错误 PID 固定失败”在 2 秒预算内没收到子进程回执，结果为 timeout，原断言要求 failed；基线与当前在同一环境单独运行均通过，原 helper 和限额未改变且 SHA256 对照相同。首轮失败保留，不能以单项重跑替代全量结论；第二轮按原完整范围重跑取得 2007 通过、0 失败、原 2 项条件跳过，退出 0。首轮为何未在期限内取得回执仍不作唯一根因断言。

三包最终合计 3500 通过，0 失败，原 2 项条件跳过。仅这份最终源码获得上述本地软件证据；真实服务与发布结论继续独立。

RED 证据保留：Controller 初始 7 项失败；Client 取消/限额初始 4 项失败；Gateway 取消 4 项中 3 失败；排队后新请求只获残余期限失败；后台队列只预留一个位置导致 URL 拒绝；runtime 旧诊断没有安全 reason；未打包 production 原构建默认追踪误开。中间 TS 夹具缺依赖、重复属性及首次产物探针从没有 tsx 的根目录执行，也保留为验证准备失败，不当作生产 RED。

精确 argv、原失败与最终日志、退出码、日志 SHA256、最终源码摘要及两种编译产物摘要见 `reports/MBR-004_EVIDENCE.json`。主证据目录 `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-read-playback-fix-Z4QNBZ`；Roon 定向目录 `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-read-trace-vKObIF`。固定基线对照工作树保留于主证据目录的 `baseline-fixtures/`。

## 现场复测

退出旧开发实例后，在 VSCode 终端运行：

```bash
cd /Volumes/LifeWeave/VSCode/MusicBridge
MUSIC_BRIDGE_LIBRARY_READ_TRACE=1 corepack pnpm@10.17.1 --filter @music-bridge/desktop run dev
```

在同一网易云歌单快速 A → B → C，核对最后 C 播放、旧错误没有覆盖；再读 Roon 专辑、艺人、流派、收藏和详情。保留从 `renderer.dispatch` 到 `renderer.return` 的同一次读取日志；`main.dispatch` 对照 rendererReadId/coreReadId，Core 再通过 flightId/sdkId 对照 SDK。只有 dispatch 没有 callback 时查 SDK/连接；`core.scope` 的变化布尔量查服务或 Zone 换代；`core.map` 的 raw/mapped/filtered/hintCounts 查映射；`main.cancel` / renderer 记录查离页、Owner 或期限。

本轮未完成真实账号或听感验收、Roon 现场故障闭环、录音/Gate B/P4/P5、系统钥匙串、完整 Electron E2E、远端 CI、推送、main 合并或正式 App 安装替换。原未跟踪 `apps/desktop/test-results/`、`worktree/` 保留。
