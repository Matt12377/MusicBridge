# Music Bridge V1 Completion Manifest

## 最终候选身份

- 版本：`0.1.0-beta.1`
- 平台：macOS `arm64`
- App ID：`com.musicbridge.roon`
- Beta 分支：`codex/task-041-beta-acceptance`
- Beta 分支起点：TASK-040 报告 HEAD `ea314209fd1ef3abc402ac09bf1adf1c84b3aa73`
- 最终报告提交信息：`docs: complete the V1 beta candidate`
- 最终审查指针：最终提交后创建 `codex/v1-beta-candidate`，与最终候选 SHA 相同
- DMG SHA-256：`fb5e053069bed0c862031e05938c5b9a06e77db5ccd02d3e6ddd68f5a95dba59`
- ASAR SHA-256：`c042de97e178d59c292bb2d0e8a849f6258ffc0ef52a6181be8f59e8268310a6`
- 最终 Core Mac 部署提交：`b734f9874591211e9cacafc9ce9b2dbd2bbd1224`
- 远端 release：与上述提交 SHA 一致，current/运行身份校验 PASS
- 远端部署归档 SHA-256：`da50be2665d514530e196c47e4c3ccbe687f486b76dcb3645a4e3f818b2a9d97`
- 远端 app.asar SHA-256：`c042de97e178d59c292bb2d0e8a849f6258ffc0ef52a6181be8f59e8268310a6`，校验匹配 PASS

## 线性任务链

| 阶段 | 分支/基线 | 实现或阶段提交 | 报告/最终 HEAD | 状态 |
|---|---|---|---|---|
| TASK-000 | 环境锚定 | `reports/TASK-000_RESULT.md` | 环境复查记录 | PASS（Owner 已验收） |
| TASK-001A | `codex/task-001a-review-fixes` | `5e37de0` | `cf0af47` | PASS |
| TASK-001/002/003/004/005 | 早期线性任务分支 | 以各任务报告列出的实现提交为准 | POC-001 `f064323` | PASS；TASK-003 保留 carryover |
| TASK-010—023 / WAVE-2 | `codex/wave-2-desktop-core`，从 `f064323` 延续 | 各任务实现提交见对应报告 | `8c5a471dfd3662609822d2ff79739365f8bc7405` | WAVE-2 PASS；接受既有 carryover |
| TASK-029 | `codex/task-029-control-plane-ci` from `8c5a471` | `aed0ee8e3c60eca6cc39bfd48b12fa9499b81d36` | `fa3df23342b9318867ecd0d933f47891f5f7c4ad` | PASS |
| TASK-024 | `codex/task-024-lyrics-v1` from TASK-029 final | `107960f9f1db871a8fff859e232dca552ab7ee52` | `d912ea1998564b43479bdca1dd004c2ad7559b8e` | PASS with Owner-only carryover |
| TASK-030 | `codex/task-030-v1-ui` from TASK-024 final | `1109d0551b09ab649b88eb7514f759841b0d3d8f` | `a7e12e3cb1d305156fa6d298dc19f2d64785bc77` | PASS |
| TASK-031 | `codex/task-031-diagnostics-stability` from TASK-030 final | `978acb00edf7c33a71bf575a3c4743fe97da479b` | `7bb8bda1686543dbb69760dc9c21981dd3a41df0` | PASS with Owner-only Core carryover |
| TASK-032 | `codex/task-032-tray-lifecycle` from TASK-031 final | `b7434c29920b775d273496a51549c0bdfc1156f8` | `2648f6108b2a5942089225b43a1ab4dd1db48bf0` | PASS with packaged Core carryover |
| TASK-040 | `codex/task-040-macos-package` from TASK-032 final | `32a16ef64ad68e10d553c61f6bbc8ef15839e6a0` | `ea314209fd1ef3abc402ac09bf1adf1c84b3aa73` | Internal candidate; signing pending |
| TASK-041 | `codex/task-041-beta-acceptance` from TASK-040 final | Documentation/release candidate commit below | Final HEAD after report update | Technical regression and final Core deployment PASS; Owner pending |

早期任务的逐项 base、实现和报告 SHA 以各自 `reports/TASK-*_RESULT.md` 为准；本表不重写历史证据，也不把早期 POC 部署包当作最终 Beta DMG。

## Final technical status

- frozen install、workspace verify、Desktop E2E、startup、Core crash/restart、safeStorage、diagnostics、doctor、secret scan 和 diff/lockfile Gate：PASS。
- DMG/App 是 arm64 内部候选；ASAR integrity、only-load-app-from-ASAR、hardened runtime 和关键 Fuse：PASS。
- Apple Development 签名可验证；Developer ID、公证和 staple：PENDING。
- 真实最终 Beta candidate Core Mac deploy：PASS；Bridge Core/Roon ready、Provider missing、active stream/playback 清零、双端口 loopback、日志秘密扫描：PASS。
- 30-track/10-cold-start 长跑和 Owner 20 项统一验收：PENDING。

## Non-release declarations

- 未创建 PR、未合并、未 force-push。
- 未创建 GitHub Release，未上传公开二进制。
- 未执行真实 Provider 调用或歌曲播放作为 TASK-041 的新动作；仅执行了脱敏部署与公开健康检查；未停止/重启 Roon。
- 未把任何凭据、Cookie、Token、账号资料、二维码、完整 URL、Query、Roon 内部 ID 或私密环境变量写入本 manifest。

## Final decision

**INTERNAL V1 BETA CANDIDATE — TECHNICAL REGRESSION PASS / FINAL CORE DEPLOYMENT PASS / OWNER ACCEPTANCE PENDING**

最终候选已部署到 Core Mac并通过脱敏运行 Gate；等待一次综合 Owner/Sol Review。Review 前不再修改产品或发布产物。
