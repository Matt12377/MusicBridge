# Known Issues — `0.1.0-beta.1`

> **beta.2 边界说明**：本文件各条目绑定 `0.1.0-beta.1` 候选。工作区版本已是 `0.1.0-beta.2`（重建基线中，未发布）；在按 `reports/BETA2_REBASELINE_CHECKLIST.md` 完成重建、重审计与 Owner 验收前，beta.2 继承以下全部边界，且不得引用 beta.1 的 DMG/hash/签名证据。

本文件列出当前内部 Beta 候选的已知边界，不把它们隐藏为“发布通过”。没有发现高危秘密泄漏、非 loopback 监听、解灰路径或自动化资源残留。

## 发布与安装

1. **Developer ID / notarization 待配置**：本轮只有本机 Apple Development 签名；公证参数不可用，不能宣称公开分发或 Gatekeeper 友好安装。状态：`SIGNING_CREDENTIALS_PENDING`。
2. **仅 arm64**：没有 universal 构建，也没有 Windows/Linux/iOS 产物。
3. **无自动更新**：Beta 需要 Owner 手动替换/卸载，升级策略尚未作为产品能力提供。

## 真实设备验收

4. **统一实机验收仍待 Owner 完成**：最终候选已在真实 Core Mac 部署并通过脱敏健康、资源和 loopback Gate，但 Owner 仍需在该候选上确认登录恢复、Roon/Zone 恢复、播放、退出和端口释放。
5. **30 首连续队列、10 次冷启动和长时间 idle 的真实 Core Mac Gate 未在本轮重新执行**：已有 100 项合成队列、资源清理、Crash/Restart 和两首真实完整播放证据；真实长跑仍是 Owner-only carryover。
6. **统一 20 项 Owner 验收未关闭**：清单见 `reports/V1_OWNER_ACCEPTANCE.md`。合成 E2E 通过不等于最终 DMG 的听感或 Roon Signal Path 通过。

## 运行边界

7. **Provider 状态可能为 missing**：没有凭据时这是安全的初始状态；不能以此状态执行真实播放。凭据由 Owner 在本地 App 内输入，开发流程不读取或记录其内容。
8. **卸载不自动删除用户数据**：退出 App 后，Owner 仍需按 `PRIVACY_LOCAL_DATA.md` 自行检查并删除不再需要的本地 App Support 数据。App 不提供“替用户删除全部数据”的破坏性快捷键。

## 处理原则

- 以上均为可解释的内部候选 carryover，最终候选已准备好交给 Owner/Sol 做一次统一 Review。
- 若发现凭据泄漏、音频无法播放、非 loopback 监听、退出残留或安全边界回退，必须停止发布流程并重新打开相应 Gate。
