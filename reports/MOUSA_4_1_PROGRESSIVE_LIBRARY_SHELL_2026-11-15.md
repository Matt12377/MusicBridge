# Mousa 4.1：渐进资料库第一项——独立应用壳与设置

## 身份与范围

- 起始提交：`399f5ddc534a8baad9e857eb126a73a0a08cbcc4`。
- 分支：`codex/mousa-4-1-progressive-library-shell`。
- 实现提交：`966445257469ff1a4e3250f5f6c9cc725e73609a`。
- 报告提交：`git log -1 -- reports/MOUSA_4_1_PROGRESSIVE_LIBRARY_SHELL_2026-11-15.md`。
- 当前状态：第一项软件验证完成，完整单元集保留已复现的基线夹具债务；未部署、未取得 Owner 使用接受。本报告不是四项计划全部完成的声明。
- 执行规则见[阶段 ADR](../docs/adr/ADR-MOUSA-4-1-PROGRESSIVE-LIBRARY.md)；[iOS 交接](../docs/PROGRESSIVE_LIBRARY_IOS_HANDOFF_2026-11-15.md)保持跨端合同不变。

## 实现

1. [Main](../apps/desktop/src/main/index.ts)在早期窗口创建前单独注册两个应用壳 IPC：静态应用信息与浅/深色外观。沿用原窗口/URL 身份验证，并明确要求当前主 frame；无效主题、异窗口、子 frame 均拒绝。
2. [Preload](../apps/desktop/src/preload/index.ts)只为这两个固定能力提前放行。原 remote preference/唯一 Core 启动握手不变；remote 状态与 outbox context 两个原启动纯读等待真实结算。准备期业务调用立即拒绝，不排队、不在恢复后重放。
3. [App](../apps/desktop/src/renderer/src/App.vue)不再用资料库准备占位页挡住设置。准备、可用、暂不可用由设置服务状态单独表达，不把未知曲库冒充零首，也不把未知账户冒充未登录。
4. [SettingsView](../apps/desktop/src/renderer/src/components/settings/SettingsView.vue)保留现有外观、布局、导航、关于和诊断入口。服务依赖模块只在当前页取得资格后挂载；同页临时断连使用 disabled/inert 保留已挂载表单。断连后切到另一页不能借用旧页的资格挂载新查询模块。通用页在尚未读取曲库时使用真实的准备/不可用提示。
5. 不改变 Source 许可、数据库 Schema、唯一 Owner/队列/route、默认源写 OFF、扫描提交、播放授权或 iOS HTTP/SRP/LAN/Tailscale 合同。

### 原启动 Gate 的构建接线修复

执行原生 Gate 时发现原脚本只调用 electron-vite，清空 dist 后没有恢复 Main 必需的 CUE/音频标签构建 metadata；标准桌面构建已有 capture/build/seal 三段。现将相同的原包捕获和封口接入[启动 Gate](../apps/desktop/scripts/startup-gate.mjs)：先捕获固定 pin，构建成功后验证同原 pin 并封口，失败不启动半成品，不重新接受旁边的新 manifest。

另一次受控实测表明完整正常退出的 56 条闭集收口记录使输出约 68 KiB，超过旧 64 KiB 总预算。只将该合成启动脚本的有限输出预算明确为 128 KiB，保留原进程等待、超限拒绝、真实 close 与退出码检查，不过滤收口证据；通用 runner 的默认预算与私有崩溃捕获上限没有放宽。

## 自动验证

全部使用合成 API、隔离临时数据目录和批准的外置构建副本；没有打开真实曲库或真实账户。

| 验证 | 结果 |
| --- | --- |
| 应用壳/设置/启动/安全聚焦集 | **188 通过，0 失败/cancelled/跳过；退出 0** |
| 桌面 vue-tsc 与测试/E2E tsc | 均退出 0 |
| 标准外置 build-only | 最终候选退出 0，不启动用户应用 |
| 官方 Electron 43.4.0 ZIP 与实际执行树核验 | 退出 0 |
| production/development 原生启动，mock keychain | **两模式均退出 0**；保留真实 marker、close、正常退出检查 |
| Source/control-plane 边界 | 最终复核均退出 0；diff --check 退出 0 |
| 完整桌面单元集 | **3101 项：2962 通过、130 失败、9 cancelled、0 跳过；退出 1**。全部剩余失败/取消组与独立基线一致，不宣称全绿 |
| 真实钥匙串、真实账号、真实音频、Owner 视觉与使用接受 | 未运行 / 未接受 |

新增保护覆盖：pending/rejected bootstrap 下壳能力即时可用；六类业务/未知调用零重放；原 Main 授权函数的异窗口/子 frame/坏主题拒绝；实际 App 设置祖链在准备和失败时保留入口且不挂载依赖模块；同页断连保留模块、跨页不借用资格；capture/build/seal 成功与各失败阶段的原控制流。

## 完整单元集的基线债务

完整运行发现多组此前未随 App 接线更新的 VM 夹具：缺少 startup preview 与 desktopReadReady 依赖，以及旧打印客户端的文本匹配。使用未修改的起始提交离线副本、相同依赖和合成环境复现了对应 7 个文件：217 项中 78 通过、130 失败、9 cancelled、0 skipped。原始工作树没有修改。

本项没有把这些夹具失败冒充产品回归通过，也没有关闭断言或把它们 skip。最终完整集的失败/取消按文件与错误类别计数后，与该基线复现完全一致，差集均为空；旧夹具债务仍未消除。后续相关扫描/播放任务需要补齐这些夹具的真实依赖后再使用其保护结论。实际 Rust media-worker 由外置正式构建产物及其 SHA 明确注入完整测试环境，不因缺少测试原生资源而删掉测试。

## 证据与剩余边界

- TDD 分别观察到原壳准备门禁、设置过早挂载及启动 metadata 缺口的失败，再执行修复后回归；私有日志、官方身份收据和合成 profile 保留在外置 Developer 证据目录，不入 Git。
- 本项只解除设置/应用壳与历史扫描核验的耦合；不宣称已经解决每 100 张动态分页、8 万首冷启动深核验或稳定播放期间的扫描预算。
- Main 的原生资源资格检查和原 fatal 退出策略保留；本项不保证底层原生启动失败时进程一定存活。
- 没有重启、停止、切换或部署到当前用户开发实例；没有安装或操作 iOS，没有触碰原用户队列、真实扫描记录或来源文件。
- 可选转换器/源写原生包的真实可用性、实机音频与最终体验不由 mock 启动 Gate 认证；Owner 接受仍为 false。

## 下一项

完成本报告提交与普通推送、核对远端后，从该最终 HEAD 创建独立的每 100 张渐进加载任务分支；继续原四项授权计划，不在本项停止。
