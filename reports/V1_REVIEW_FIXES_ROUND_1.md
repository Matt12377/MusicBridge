# V1 Review Fixes Round 1 结果报告

## 1. 范围与接管边界

本轮接管自 `MusicBridge_LunaMax_Handoff_2026-08-22.md`，目标是保留旧工作并完成以下 Review Fixes：

- YRC 真实时间语义与歌词更新调度；
- Roon `Time` 回调真实字段验证与时间同步；
- Core 子进程环境白名单；
- safeStorage 冷启动与 Core 重启恢复；
- Core Mac 最新签名包的真实 Provider/Roon/Zone 播放验证。

接管初始状态：

- 工作区：`/Users/yihe/VSCode/MusicBridge`；
- 分支：`codex/v1-review-fixes-round-1`；
- 初始 HEAD：`513d152968aa25298cfc41e6b3c88493a060fd0f`；
- 初始工作区无未提交修改；
- 初始远端 `codex/v1-beta-candidate` 与 `codex/task-041-beta-acceptance` 均指向 `513d152...`；
- 恢复快照：`/tmp/musicbridge-lunamax-recovery-20260822-104058`；
- 快照、Git 锁、活动进程与凭据边界检查完成；未删除锁、未直接杀进程、未吸收无关修改。

## 2. 实现提交

本轮实现提交按线性顺序保留：

| 提交 | 内容 |
|---|---|
| `157736e72e25c1d99b9bf56117ec13671293d21b` | V1 Review Fixes Round 1 主实现 |
| `16f43b897e8464416076becbb1541abfca008446` | 签名发现显式开关 |
| `3b775d42c55f33a8dada4f6f9dbfe0e79d2e3266` | 播放前初始化 NetEase XEAPI 运行时 |
| `1bddd82913edbf461ba672273aac6cd669461087` | 使用已验证的 Roon `seek_position_ms` 时间回调 |

报告提交与最终 SHA 由本文件提交后的 Git 复核记录。

## 3. 代码修复与证据

### YRC 与歌词时序

- YRC word tuple 的首字段按绝对 `startMs` 解析，不再把绝对时间误当相对偏移；
- 歌词协调器在播放开始后使用 100ms 调度器，在曲目切换、停止、Roon 时间更新、关闭和 generation 失效时取消或重置；
- generation、track 和 stale callback 保护保留。

### Roon Time

先通过真实 Core 的脱敏 Gate 捕获并验证了以下形状：

```json
{"bodyPresent":true,"bodyType":"object","topLevelKeys":["seek_position_ms"],"nestedKeys":[],"candidates":[{"path":"seek_position_ms","type":"number","finite":true,"safeInteger":true,"nonNegative":true,"durationBounded":true}]}
```

不记录原始时间值。代码现在只接受非负、安全整数、24 小时内的 `seek_position_ms` 毫秒值；其他形状继续 fail-closed 并保留估算回退。

TDD 证据：

- 真实字段测试先以 49/50 失败；
- 实现后 focused Roon adapter suite 50/50 通过；
- 完整 Bridge Core suite 152/152 通过。

### NetEase XEAPI 冷启动

- 固定 API 包的 `song_url_v1` 请求前会惰性初始化 `os.tmpdir()/xeapi_public_key`；
- 使用 API 包自身的非空设备标识请求公钥状态；
- 采用原子写入，缓存文件权限为 `0600`；
- 初始化失败时不输出密钥材料；已有合法缓存时保持 fail-closed 兼容；
- 只在解析音频 URL 前触发，不阻塞离线浏览和搜索。

这解决了 Core Mac 旧实例首次播放时报 `NETEASE_REQUEST_FAILED`、桌面端只显示 `Core request failed` 的问题。最新签名版本在 Core Mac 上已完成真实播放，Owner 确认可以出声并完成播放。

### Core 环境白名单与 safeStorage

- Core 子进程不再继承父进程环境；只传递明确的运行时白名单；
- 测试探针、崩溃探针和 Roon Time Gate 均有显式开关与路径约束；
- safeStorage 冷启动、Core 重启恢复、权限与合成凭据 Gate 通过；
- SSH 会话启动的 Electron 实例曾显示 Provider missing，这是 macOS 登录会话的 safeStorage 差异；从 Core Mac GUI 手动打开同一 `current` App 后 Provider 恢复为 configured。该现象不改变产品 Gate 结论。

### Roon Zone

Roon Extension Settings 的真实 payload 使用 `values.zone` 与 `output_id/name`。适配器现在正确读写 `zone`，内部仍保持 `settings.output` 持久化模型，Zone 选择不会再点击后回到 `-`。

## 4. Hi-Res / Lossless 证据边界

本轮 Core 公开状态成功复现：

- `requestedQuality=hires`；
- `actualQuality=lossless`；
- `format=flac`；
- 产生 `QUALITY_DOWNGRADED`；
- 真实 Core/Zone 状态为 ready，Provider 已配置。

代码确实把 `level: hires` 发送给 Provider，并以 Provider 返回行的 `level` 作为 `actualQuality`。因此当前歌曲的降级发生在 Provider 音频 URL 响应层，不是 UI 丢失选择，也不是 Roon 在收到 Hi-Res 后才降级。

“只有部分歌曲能 Hi-Res”最符合歌曲级别的资源或授权差异：歌曲没有 Hi-Res 母带、当前地区/账号未开放该版本，或 Provider 为该歌曲返回的最高可用等级只有 Lossless。FLAC 不等于 Hi-Res；最终采样率、位深和输出链路仍以 Roon Signal Path 为准。

该行为符合项目的“实际音质优先于请求音质”决策：不强制升采样、不解灰、不替换音源、不把 Lossless 标成 Hi-Res。当前不是 Round 1 的代码 blocker。

## 5. 自动 Gate

最新实现已通过：

- `corepack pnpm@10.17.1 verify`：退出码 0；
- Contracts：16/16；
- Bridge Core：152/152；
- Desktop：40/40；
- typecheck：通过；
- production build：通过；
- `git diff --check`：通过；
- Roon Time focused suite：50/50；
- Roon Time 真实字段 focused 测试：先 RED，后 GREEN；
- XEAPI runtime smoke：`NETEASE_API_RUNTIME_READY`；
- safeStorage、冷启动、Core restart、crash/restart Gate：通过；
- Core env allowlist 与 canary：通过。

## 6. Core Mac 部署 Gate

最终部署使用：


- release SHA：`1bddd82913edbf461ba672273aac6cd669461087`；
- bundle SHA-256：`2c90a7eb392a5798f5d726a3706807da4df89a556695a57a715ea97dc595a8ad`；
- App ASAR SHA-256：`c5f7d935c8deed48c3dc05f45ab015336f2c0f418617803686b252c3eb29134e`；
- 远端 bundle 与本地 bundle：MATCH；
- 远端 ASAR 与本地 ASAR：MATCH；
- `codesign --verify --deep --strict`：PASS；
- Core health：PASS；
- Roon：ready；
- Zone：`Studio Display`；
- Provider：通过 Core Mac GUI 手动打开后 configured；
- 38501/38502：仅 loopback；
- 最新进程：1；旧进程已正常退出；
- 真实播放：Owner 已确认通过；
- 最终复核时 active stream 已清理，播放状态回到 idle。

## 7. WAVE 边界与 carryover

WAVE-2 已由 `reports/WAVE-2_RESULT.md` 正式关闭，结论为 **PASS WITH ACCEPTED CARRYOVER**。其 carryover 是未破坏性触发的 Owner-only 故障场景与最终 Beta packaged UI 复核，不是本轮重新打开 WAVE-2。

当前工作属于 WAVE-3 后的 Review Fixes Round 1。未开始 UI adaptation；未改变 Provider 版本、Roon extension id、端口、安全开关、Stream Gateway 架构或解灰边界。

## 8. 发布与停止边界

本报告完成前：

- 不创建 PR；
- 不 merge；
- 不创建 GitHub Release；
- 不移动旧的 `codex/v1-beta-candidate`；
- 不公开发布；
- 不把真实 Provider 凭据、Cookie、Token、二维码、完整 URL、Roon session 或原始 Provider 响应写入报告、日志或 Git。

报告提交后，按用户授权执行：

1. 推送 `codex/v1-review-fixes-round-1`；
2. 在同一最终 SHA 创建并推送 `codex/v1-beta-candidate-r2`；
3. 复核旧候选分支未移动；
4. 最终停止，等待 Owner 后续验收决定。

