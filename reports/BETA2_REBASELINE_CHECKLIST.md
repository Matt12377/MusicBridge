# `0.1.0-beta.2` 重建基线待执行清单

状态：**REBASELINE_IN_PROGRESS**。本清单只是待执行结构，不是候选报告；在每一项完成并留证前，beta.2 不存在任何可发布的构建证据。

## 前置事实

- 工作区版本：`0.1.0-beta.2`（根与 desktop package.json）。
- beta.1 的 DMG hash、ASAR hash、Fuse、签名、安装冒烟证据绑定旧候选，**不得**为 beta.2 复用或改写。
- TASK-033/034/035 已通过 PR #1（merge commit `8948aead451e38dddaf7d94756bbebdee946c6b0`）进入 main；CI 分层修复见 TASK-036。

## 待执行（按顺序，全部完成前不得宣称 beta.2 候选）

1. **冻结 SHA**：确定唯一 beta.2 候选提交 SHA（TASK-036 合并后由 Owner 指定），记录于此。
   - 冻结 SHA：_待定_
2. **干净构建**：从冻结 SHA 在干净 checkout 上执行 frozen install + production 构建 + electron-builder arm64 DMG。
3. **重新计算指纹**：记录 DMG SHA-256 与 app.asar SHA-256（不得沿用 beta.1 数值）。
4. **Fuses 复审**：确认 runAsNode/NODE_OPTIONS/CLI inspect 禁用、ASAR integrity 与 only-load-app-from-ASAR 启用、Cookie encryption 启用。
5. **签名与公证复审**：Developer ID / notarization / staple 状态如实记录（当前预期仍为 `SIGNING_CREDENTIALS_PENDING`）。
6. **安装冒烟**：DMG 只读挂载、全新临时目录安装、首启、卸载残留检查。
7. **自动化 Gate 重跑**：frozen install、平台无关 verify、macOS Electron Gate（startup/crash/vault/recovery）、Playwright E2E、boundaries/cycles/control-plane。
8. **Core Mac 部署健康 Gate**：脱敏部署 + 公开健康检查（不播放、不调用 Provider）。
9. **Owner 统一验收**：按 `reports/V1_OWNER_ACCEPTANCE.md` 20 项在最终 DMG 上重做并逐项记录 PASS/FAIL/NOT_AVAILABLE/OWNER_ONLY_PENDING。
10. **文档翻转**：RELEASE_NOTES、KNOWN_ISSUES、V1_BETA_ACCEPTANCE 更新为 beta.2 实际结果后，才允许出现任何 beta.2 的 hash 或结论。

## 明确禁止

- 在没有真实构建与证据时填写任何 DMG hash、ASAR hash、签名结果、Owner PASS 或发布结论。
- 覆盖或改写 beta.1 的历史报告。
