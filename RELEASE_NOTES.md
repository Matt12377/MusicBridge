# Music Bridge for Roon `0.1.0-beta.1`

## `0.1.0-beta.2` 状态（重建基线中，未发布）

- 工作区版本已推进到 `0.1.0-beta.2`，但 **beta.2 尚无任何已构建候选**：没有 DMG、没有 hash、没有签名/公证结果、没有 Owner 验收结论。
- beta.2 处于重新建基线阶段：TASK-033/034/035 已通过 PR #1（合并提交 `8948aead451e38dddaf7d94756bbebdee946c6b0`）进入 main，CI 测试分层由 TASK-036 修复。
- 后续 beta.2 候选必须从唯一冻结 SHA 重建 DMG、重新计算 hash、重新审查 Fuses、签名、安装冒烟并重做 Owner 验收；待执行清单见 `reports/BETA2_REBASELINE_CHECKLIST.md`。
- 以下 `0.1.0-beta.1` 章节为历史记录，原样保留。

## 状态

这是 Apple silicon `arm64` 的内部 Beta 候选，不是公开发行版。当前没有自动更新，也没有创建 GitHub Release。Developer ID 签名、公证和 staple 尚未配置，因此不能把本候选当作可公开分发的 Gatekeeper 包。

## 本候选包含

- 本地 Electron Desktop shell、Bridge Core utility process 和受限 Preload API。
- Roon 配对、Zone 选择、Provider QR 登录和 safeStorage 登录恢复路径。
- 搜索、Liked、Playlist 分页、队列、Previous/Next/Stop、自然结束推进。
- Now Playing 元数据、封面、请求/实际质量、歌词和诊断导出。
- 菜单栏 Tray、关闭窗口隐藏、重新激活同一窗口和有界退出清理。
- 仅本机 loopback 的控制/流服务；未加入代理、随机 IP、解灰、下载、缓存或转码。

## 构建身份

- App 版本：`0.1.0-beta.1`
- Bundle ID：`com.musicbridge.roon`
- 架构：`arm64`
- 产物：`MusicBridge-0.1.0-beta.1-arm64.dmg`
- 产物 hash、ASAR hash、Fuse、签名和安装冒烟证据见 `reports/TASK-040_RESULT.md` 与 `reports/V1_BETA_ACCEPTANCE.md`。

## 已验证范围

- 冻结锁文件安装、workspace verify、桌面 Playwright 5/5、启动/Crash Gate、safeStorage Gate、诊断导出、loopback/安全开关和 ASAR 内容扫描通过。
- 之前的 Owner 实机证据确认了 QR 登录重启恢复以及两首歌曲自然完整、Signal Path 为无损；这些证据不替代最终 Beta DMG 在真实 Core Mac 上的重复验收。

## 使用前提

- 只在 Owner 控制的 Apple silicon macOS 测试机上使用。
- Provider 凭据只通过 App 的安全登录路径提供，不写入命令、Git、报告或日志。
- 真实 Roon/Provider/Zone 验收必须按 `reports/V1_OWNER_ACCEPTANCE.md` 逐项记录，不需要把账号资料或凭据发给开发者。
