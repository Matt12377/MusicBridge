# Mousa 4.1 — 搜索清空修复与 Duo 客户端核验

## 身份与授权

- Desktop 分支：`codex/mousa-4-1-search-clear-duo`。
- Desktop base：`efe12f67105eacbcd95568f549f60bb8a65985c6`。
- Desktop 实现 / 实窗受测 HEAD：`c12ffcfea3ae949a75362d5a6d156851b8f0f368`。
- 本报告为独立 report-only 提交；报告身份使用 `git log -1 -- reports/MOUSA_4_1_SEARCH_CLEAR_DUO_2026-11-08.md` 核对，避免自引用 SHA。
- iOS base：`ae213df83dc9c962745e09891be00d760d65ddcd`；iOS 测试实现：`54ef7d08e438a44071ab1c9d142e98561a9c1eae`。
- Owner 授权修复搜索、判断 iOS 是否受影响，并仅向 Duo 真机构建部署；随后授权下一步 Tailscale 自主实施。后者另开分支，本报告不包含其实现。
- 工作均在登记的隔离 worktree 中完成；未纳入两个原始工作区的用户 WIP。

## 问题与最小修复

叉号原来只清 Catalog draft，没有清已提交的 Catalog query，也没有走搜索离页与原来源恢复。旧聚合搜索状态和 Catalog 状态独立，导致看似空输入框但仍停留在旧搜索页。

- 将叉号接到实际 Catalog 清空与 journey 返回流程。
- 离页门禁先行；通过后才清提交查询、结果、预览及搜索返回路径。
- 使用 Catalog 原有代际撤销机制隔离迟到搜索、预览与远端详情响应，不进行空查询网络搜索。
- 从搜索页或搜索派生的 Roon 详情清空时，返回原侧栏来源；不一律跳主页。
- 在其他页面仅清未提交草稿，不破坏艺术家详情或本地页过滤。
- 叉号可访问名称调整为“清除搜索”。没有重设计样式，没有更改共享网络合同、鉴权或播放逻辑。
- 既有 Catalog 导航测试 AST 夹具补齐原 App 已有的 `desktopReadReady` 绑定；没有因此改动产品 readiness。

## 自动 Gate

所有输入均为合成数据；自动 Gate 不连接真实 Provider 或 Roon。

| Gate | 结果 |
| --- | --- |
| 新清空回归修改前 | 8 项中 7 fail / 1 pass，复现未清提交查询及未返回来源 |
| 搜索、Catalog、导航相关五组回归 | 62 pass / 0 fail / 0 skip，exit 0 |
| Desktop Vue 与 E2E 类型检查 | exit 0 |
| Control-plane Gate | exit 0 |
| Boundary Gate | exit 0 |
| `git diff --check` | exit 0 |
| `corepack pnpm@10.17.1 dev:desktop --build-only` | exit 0；只准备 dev 运行产物 |

回归覆盖主页、本地库、Roon 艺术家与专辑来源、迟到搜索/预览/详情、空旧搜索状态、离页门禁延迟恢复及未提交草稿。

## 新版 dev 真实窗口验证

- 没有构建发行版 macOS App、打包、安装或替换系统 App。
- 旧 dev 的系统正常退出请求没有使原进程退出；使用原应用托盘“退出 Mousa”命令后，原 managed dev 命令正常 exit 0。未强杀、未重启配对的 Roon Core。
- 从本任务工作树执行 `corepack pnpm@10.17.1 dev:desktop`，使用该树新 dev 产物，不将旧窗口冒充新修复。
- 核对精确新 development bundle、Main、从属 Core 和原生窗口。操作前验证目标窗口、控件唯一标签及真实焦点。
- 从主页提交合成词：实窗观察搜索页和“清除搜索”按钮；实际按叉号后，搜索页、查询和叉号消失，回到主页。前后截图已私有保存并由代理逐图检查。
- 从本地音乐页重复提交与清空：恢复本地专辑浏览与其返回位置，未强制跳主页；原生控件计数及私有截图核对通过。
- 验证仅涉及导航与只读搜索，没有发起新播放；新 dev 与搜索测试后播放均为 idle，没有自动重播旧请求。
- 单测的延迟响应注入提供精确竞态证据；真实窗口不冒称覆盖所有人为延迟时序。

## iOS 判断与 Duo 部署

iOS 使用原生专用搜索 Tab；空输入隐藏结果，store 撤销全局搜索 scope。保留空的专用搜索 Tab 不等于 Desktop 遗留搜索页问题。本任务没有新增需要 iOS 采纳的服务端协议变化，所以无需修改 iOS 业务代码。

- 新增三项测试：清空已完成结果且保留本地过滤、清空后迟到响应隔离/空白字符处理、保留已捕获播放上下文而不复活结果。
- MBLibrary 搜索 store 与 repository 共 42 pass / 0 fail，exit 0。
- Production scheme、Debug-iphoneos 构建 `0.1.0 (126)`，exit 0；严格代码签名、现有团队及 Duo Provisioning Profile 核验通过。
- 首次手动 profile override 因 Xcode-managed profile 与 Swift package resource bundle 配置冲突而 exit 65；改为沿用已存在的有效自动签名 profile 后成功。没有账户恢复、重新登录或放宽签名。
- 唯一选中的目标是物理 Duo，排除同名与其他模拟器；原位升级 `app.musicbridge.ios` build 125 → 126。
- 安装、安装后版本核对、启动与启动后进程存活读取均 exit 0。
- 未卸载、清空文档、重置配对或操作其他设备。不将安装启动成功冒称 iOS 全部按钮、音频或跨网络验收。

## 交付与 carryover

- 两个仓库分别使用实现提交和本报告提交；普通推送 Desktop `origin` 与 iOS 已配置的 `github`，最终 HEAD / 报告身份 / 干净工作树由私有交付收据核对。
- iOS `origin` 是本地镜像，不把其旧 refs 当作 GitHub 权威；已在 `github` 上核对 iOS base 对应分支。
- 下一独立任务从各仓库本报告最终远端 HEAD 创建，不从未推送或脏输入继续。
- `ownerAccepted: false`。自动测试、真实窗口和安装启动分别记录，不代表 Owner 接受。
- 原两项 `SOURCE_NAMED_CHECK` 失败及本地歌词真实播放覆盖仍开放；没有读写源媒体、重新签发未知请求、降低 FD/签名/媒体准入保护，或改变既有精确代理例外。
- 私有设备标识、证书/团队细节、截图、用户曲目/目录和原始诊断不进入 Git。
