# TASK-047：Local-to-NetEase Lyrics 分层验收

## 目标

完成 Synthetic、真实 Roon + NetEase 和 Owner 三层验收，证明跨源歌词可靠且不会改变 Roon 音频来源。

## 基线与分支

- 基线：TASK-046 合并后的最新 `main`。
- 分支：`codex/task-047-local-lyrics-acceptance`。

## 允许范围

- Synthetic fixtures/E2E 和验收报告所需的最小测试支持
- `reports/TASK-047_RESULT.md`
- `project/STATUS.json` 与风险登记
- 验收发现的 P0/P1 修复必须另开 bounded bugfix，不在报告提交中夹带

## Synthetic Gate

必须覆盖 ADR-008 全部验收矩阵，特别是：

- 唯一同版本；
- 五组版本硬冲突；
- 精选集同录音；
- 多个相似版本不自动选；
- 无歌词、网络断开、Provider 未配置；
- pause/resume、seek、快速切歌；
- 重播使用记录；
- MANUAL 选择、撤销和 stale session；
- Roon 音频开始时间不等待搜索；
- 日志、诊断和持久文件无歌词正文、凭据、路径或 runtime reference。

## 真实 Gate

真实测试由 Owner 在本地安全会话中执行，不把凭据写入聊天、命令、日志或报告。至少使用：

- `归零`；
- 一个唯一同版本且有逐行歌词的本地曲目；
- 一个 Live/Studio 冲突样本；
- 一个 Cover/Original 冲突样本；
- 一个精选集同录音样本；
- 一个多版本歧义样本；
- 一个 NetEase 无歌词样本。

逐项记录：Roon Zone、音频是否持续来自 Roon、歌词来源提示、pause/resume、seek、快速切歌、缓存复用和听感同步。报告不得记录歌词正文、账号资料、Cookie、Roon session/item_key 或本地路径。

## 通过标准

- 全部 Synthetic Gate 通过；
- 真实样本未出现错误歌词自动显示；
- 网络/Provider/匹配失败不影响 Roon 音频；
- pause/resume/seek/快速切歌没有 stale 高亮或旧歌词覆盖；
- 自动、真实工程验收和 Owner 接受分别签字，不互相替代；
- 若 MANUAL UI 延期，必须明确记录 TASK-046 未完成，本任务不得宣称完整产品验收。

## Gate

- `corepack pnpm@10.17.1 verify`；
- control plane、boundaries、security、Electron 和 E2E；
- 正式报告中的提交/分支/base SHA 与远端一致；
- `git diff --check` 和清洁工作树；
- Owner 明确接受后才可标记 complete。

实现提交（如仅测试夹具）：`test(lyrics): cover cross-source lyrics acceptance`。

报告提交：`docs: record cross-source lyrics acceptance`。
