# TASK-040 结果报告：macOS Beta 打包

## 任务身份

- 任务：TASK-040 — DMG、签名、公证与干净机
- 基线 SHA：`2648f6108b2a5942089225b43a1ab4dd1db48bf0`
- 工作分支：`codex/task-040-macos-package`
- 实现提交：`32a16ef64ad68e10d553c61f6bbc8ef15839e6a0`
- 实现提交信息：`build: prepare the macOS beta package`
- 报告提交信息：`docs: record TASK-040 verification`
- 实现提交已推送到 `origin/codex/task-040-macos-package`
- 未创建 PR、未合并、未 force-push、未创建 GitHub Release、未公开发布

## 构建决策与修改范围

- Beta 目标架构：`arm64`；未构建 universal 包。
- App 版本：`0.1.0-beta.1`。
- Bundle ID：`com.musicbridge.roon`。
- 产品名：`Music Bridge for Roon`。
- 未加入自动更新配置。
- 新增本地 App 图标源和生成的 macOS `.icns`，没有使用远程资源。
- 配置 hardened runtime，并只声明 `allow-jit` 与 `allow-unsigned-executable-memory` 两项 Electron 运行所需 entitlement；未启用 `disable-library-validation`。
- 启用 ASAR；构建后执行 Electron Fuse：RunAsNode 禁用、Cookie 加密启用、NODE_OPTIONS 环境变量禁用、Node CLI inspect 参数禁用、嵌入式 ASAR 完整性校验启用、只从 ASAR 加载 App、额外 file protocol 权限禁用。
- ASAR 内容排除依赖文档、测试/夹具、日志、source map，以及工作区 contracts 的 TypeScript 源和 tsconfig；未全局排除生产依赖的 `src` 目录，因为部分生产依赖的运行入口位于该目录。
- 未修改根 `package.json`、`pnpm-lock.yaml`、产品源码、Provider 依赖版本、Roon `extension_id`、端口或 loopback-only 规则。

## 构建产物

- DMG：`apps/desktop/release/MusicBridge-0.1.0-beta.1-arm64.dmg`
- App：`apps/desktop/release/mac-arm64/Music Bridge for Roon.app`
- DMG SHA-256：`fb5e053069bed0c862031e05938c5b9a06e77db5ccd02d3e6ddd68f5a95dba59`
- `app.asar` SHA-256：`c042de97e178d59c292bb2d0e8a849f6258ffc0ef52a6181be8f59e8268310a6`
- ASAR 条目数：4595；文档、测试、tests、夹具、日志、source map、工作区 contracts 源文件检查均为 0。
- 未发现 `.env`、Provider 凭据文件、Cookie 文件、运行日志、音频文件或项目 `docs/tasks/reports/src/test` 内容。

## 自动验证

| 命令/检查 | 退出码 | 结果 |
|---|---:|---|
| `corepack pnpm@10.17.1 verify` | 0 | PASS；contracts 16/16、bridge-core 146/146、desktop 36/36，生产构建通过 |
| `corepack pnpm@10.17.1 --filter @music-bridge/desktop pack:beta` | 0 | PASS；arm64 App 与 DMG 生成 |
| `git diff --check` | 0 | PASS |
| `git diff -- package.json pnpm-lock.yaml` | 0 | 无根 package 或 lockfile 差异 |
| `codesign --verify --deep --strict` | 0 | PASS；App 在磁盘上有效且满足签名要求 |
| `spctl --assess --type execute` | 0 | 本机 PASS；输出含 `override=security disabled`，不作为公开分发证明 |
| Electron Fuse 读取检查 | 0 | PASS；关键安全 Fuse 均符合目标状态 |
| 干净临时目录 App 启动 Gate | 0 | PASS；`DESKTOP_STARTUP_READY` |
| 干净临时目录 safeStorage Gate | 0 | PASS；`CREDENTIAL_VAULT_GATE_PASS` |
| DMG `hdiutil attach` | 0 | PASS；只读挂载 |
| 临时安装目录首次启动 | 0 | PASS；`DESKTOP_STARTUP_READY` |
| DMG `hdiutil detach` | 0 | PASS |

## 签名、公证与分发边界

- Builder 检测到本机 Apple Development 签名身份并完成 App 签名；未在报告中记录证书名称、指纹或任何私密签名材料。
- 没有可用于本轮自动生成公证参数的 Developer ID/notary 配置，Builder 跳过 macOS notarization。
- 当前产物是 arm64 内部 Beta 候选，不是已公证的公开分发包；状态：`SIGNING_CREDENTIALS_PENDING`。
- 没有请求或读取任何签名私钥、公证凭据、Provider 凭据或账号资料。

## Owner-only 实机 Gate

以下事项未在本轮自动化中代替 Owner 执行，因此不宣称已通过：

- 在真实干净 macOS 用户环境安装并确认 Gatekeeper 行为；
- 真实 Roon 配对与 Zone 选择；
- 真实扫码登录与重启恢复；
- 真实歌曲播放与 Signal Path；
- 真实菜单栏/退出/卸载后的残留检查；
- Developer ID 签名、公证和 staple。

本轮没有连接或修改 Core Mac，没有停止或重启 Roon，没有播放歌曲，没有调用 Provider，没有创建 `.env`，没有读取或输出任何凭据、二维码、账号资料、完整 URL 或日志内容。

## 结论

**PASS WITH SIGNING_CREDENTIALS_PENDING AND OWNER-ONLY REAL-DEVICE GATE PENDING**

TASK-040 的开发机打包、ASAR 内容边界、Fuse、签名校验、safeStorage、干净临时安装冒烟和 DMG 挂载流程均通过。产物仅作为内部 Beta 候选；公开分发所需的 Developer ID、公证和真实设备 Gate 仍由 Owner 在后续验收窗口处理。按项目规则，可在此候选基础上进入 TASK-041，但不得据此宣称公开发布资格。
