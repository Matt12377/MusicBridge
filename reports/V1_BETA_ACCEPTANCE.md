# V1 Beta 技术验收报告

## 候选身份

- 候选版本：`0.1.0-beta.1`
- 当前架构：macOS `arm64`
- 当前分支：`codex/task-041-beta-acceptance`
- TASK-041 基线：`ea314209fd1ef3abc402ac09bf1adf1c84b3aa73`
- 最终报告提交信息：`docs: complete the V1 beta candidate`
- 最终候选分支：完成本报告提交后从同一最终 HEAD 创建 `codex/v1-beta-candidate`
- 未创建 PR、未合并、未 force-push、未创建 GitHub Release、未公开发布

## 自动技术回归

| Gate | 结果 | 证据 |
|---|---|---|
| frozen install | PASS | `corepack pnpm@10.17.1 install --frozen-lockfile --offline`，退出码 0 |
| workspace verify | PASS | `corepack pnpm@10.17.1 verify`，退出码 0；contracts 16/16、bridge-core 146/146、desktop 36/36 |
| Desktop Playwright | PASS | `corepack pnpm@10.17.1 --filter @music-bridge/desktop test:e2e`，5/5 |
| development/production startup | PASS | `test:startup` 两种模式均退出码 0 |
| Core crash/restart | PASS | `MUSIC_BRIDGE_CORE_CRASH_GATE=1 test:startup` 的 development/production 两种模式均通过 |
| safeStorage / diagnostics | PASS | safeStorage Gate 通过；诊断报告 writer 定向测试 2/2 |
| doctor | PASS | Node 22.23.2、禁用安全开关、loopback host、38501/38502 可用、依赖存在；Provider missing 为无凭据测试预期且非硬失败 |
| secret/material scan | PASS | 未发现高风险凭据赋值、明文材料、Cookie 文件、credential JSON 或日志文件 |
| diff/lockfile | PASS | `git diff --check` 退出码 0；根 `package.json` 与 `pnpm-lock.yaml` 无差异 |

## Beta 包审计

- DMG：`apps/desktop/release/MusicBridge-0.1.0-beta.1-arm64.dmg`
- DMG SHA-256：`fb5e053069bed0c862031e05938c5b9a06e77db5ccd02d3e6ddd68f5a95dba59`
- App ASAR SHA-256：`c042de97e178d59c292bb2d0e8a849f6258ffc0ef52a6181be8f59e8268310a6`
- `codesign --verify --deep --strict`：PASS，退出码 0。
- `spctl --assess --type execute`：本机退出码 0；输出含 `override=security disabled`，不能作为公开分发证明。
- Fuse：RunAsNode、NODE_OPTIONS、CLI inspect 均禁用；嵌入式 ASAR integrity 和 only-load-app-from-ASAR 均启用；Cookie encryption 启用。
- ASAR 内容检查：4595 项；项目 source/test/docs/tasks/reports、`.env`、Cookie/credential 文件、日志、音频、source map 均未进入候选包。
- DMG 只读挂载、复制到全新临时安装目录、首次启动和卸载挂载点均通过。
- 干净临时目录启动输出 `DESKTOP_STARTUP_READY`；safeStorage 输出 `CREDENTIAL_VAULT_GATE_PASS`。

## 最终候选 Core Mac 部署

- 本次部署使用候选提交 `b734f9874591211e9cacafc9ce9b2dbd2bbd1224`，远端 `current` release 与该 SHA 一致。
- 远端部署归档 SHA-256：`da50be2665d514530e196c47e4c3ccbe687f486b76dcb3645a4e3f818b2a9d97`。
- 远端 `app.asar` SHA-256：`c042de97e178d59c292bb2d0e8a849f6258ffc0ef52a6181be8f59e8268310a6`；bundle 与 `app.asar` 校验均匹配。
- Electron App 进程族存在；Bridge Core runtime、Roon 均为 `ready`；Provider 初始公开状态为 `missing`。
- `activeStreamCount=0`，`activePlayback` 不存在。
- 38501 与 38502 均仅 loopback 监听；远端 Roon 进程保持运行，未停止或重启 Roon。
- 远端日志秘密扫描 PASS；本次部署创建的 staging/archive 临时目录均已清理。

## 历史实机证据边界

以下是此前报告中已存在的 Owner/实机或受控证据，保留其原始边界，不重新解释为本轮最终 DMG 实机结果：

- TASK-020：真实 QR 登录授权和重启恢复已记录为 PASS。
- TASK-021：搜索、Liked、Playlist 和分页 Gate 已记录为 PASS。
- TASK-022：Owner 已确认两首歌曲自然完整播放，质量为无损；队列控制和资源清理已记录。
- TASK-023/WAVE-2：App/Core/Roon 状态恢复和一首授权播放的既有证据已记录，并保留 Owner-only carryover。
- WAVE-1：Owner 已确认较长曲目完整播放且 Signal Path 显示无损。

这些证据不是 TASK-041 在最终 Beta DMG 上重新部署、扫码、播放和监听 Signal Path 的替代品。

## 未关闭 Gate 与安全边界

- Developer ID、公证和 staple 未完成；状态为 `SIGNING_CREDENTIALS_PENDING`，候选只可作为内部 Beta。
- 最终候选已部署到真实 Core Mac，部署、启动、健康、资源和 loopback Gate 通过；20 项 Owner 清单仍待 Owner 在本机完成。
- 30 首连续真实队列、10 次真实冷启动、长时间 idle 和最终 Core 资源残留检查未在本轮重做；已有合成稳定性/Crash/Restart 覆盖。
- 未请求、读取、输出或写入任何 Provider 凭据、Cookie、Token、二维码、账号资料、完整 URL 或 Query。
- 本轮未播放歌曲、未调用 Provider；仅执行了脱敏部署与公开健康状态检查，未停止或重启 Roon。
- 未改变端口、loopback-only、安全开关、Roon extension_id、Provider 版本、Stream Gateway 行为或产品架构。

## 结论

**TECHNICAL PASS — FINAL CORE DEPLOYMENT PASS; INTERNAL BETA CANDIDATE; OWNER ACCEPTANCE PENDING**

自动回归、Electron E2E、安全边界、诊断、Crash/Restart、arm64 DMG、safeStorage、Fuse、临时安装冒烟以及最终 Core Mac 部署健康 Gate 均通过。候选不具备公开分发资格；等待 Owner/Sol 的一次统一实机验收与签名/公证决定。详细清单见 `reports/V1_OWNER_ACCEPTANCE.md`。
