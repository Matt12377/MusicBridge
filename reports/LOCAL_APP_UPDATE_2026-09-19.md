# GitHub 同步与本机构建安装（2026-09-19）

## 提交检查点

- 用户授权：提交到 GitHub、更新远端，在开发机构建并替换现有应用。
- 分支：`codex/unified-search`；远端：`origin`（`Matt12377/music-bridge-for-roon`）。不合并 main，不发布 Release。
- Base：`c9f8cec4e0a9774035862406f822fd7401016cec`。
- 实现提交：`2de344ac854ef90b6848c50349fe67466a79739c`。
- 本报告的独立提交记录此前搜索、收藏、布局、队列同步及确认时序修复的验证报告。此前报告中的“未提交/未推送”是各轮结束时的历史状态。
- 已验证：上一轮相关测试 234/234、隔离 Electron 2/2、Core/Desktop 类型检查和构建；本轮再次执行 Control Plane、Boundaries 和暂存区 diff check，退出码均为 0。
- 未纳入：`prototypes/metafine-study/` 与 `apps/desktop/test-results/`，保持原状；不强制清理工作区。
- 已核对安装目标：`/Applications/Music Bridge for Roon.app`，bundle ID 为 `com.musicbridge.roon`；检查时该安装版进程未运行。
- 本机构建产物与缓存只放外置 LifeWeave APFS；安装到 Applications 为用户明确要求的最终部署，不迁移用户数据。
- 本检查点尚未执行打包或替换；后续结果另行追加，不以源码构建代替打包/启动验证。实现与报告提交后的 HEAD 是下一步构建源码基线。

## 构建与安装完成

- 构建源码基线（第一份报告提交）：`81a13a061f3da7372c3755daacf04458afd9e940`，已推送并通过 `git ls-remote` 核对一致。
- GitHub 返回仓库迁移提示：旧 origin 地址已重定向至 `https://github.com/Matt12377/MusicBridge`；未擅自改写 origin URL。
- Node 22.23.2 / pnpm 10.17.1；Core build、Desktop production build、electron-builder macOS arm64 dir 打包依次执行，退出码均为 0；使用 `--publish never`，未创建 Release 或 DMG。
- 原生转换器和输出包通过现有 beforePack 身份检查；应用为本机 ad-hoc 签名，未做 Developer ID 签名或公证，不作为公开分发包。
- 打包产物与安装后应用的 `codesign --verify --deep --strict` 均通过。
- 打包产物隔离启动通过：`DESKTOP_STARTUP_READY`、退出码 0、进程正常关闭。
- 安装后从 `/Applications/Music Bridge for Roon.app` 运行的隔离启动同样通过。使用 mock keychain 与合成 Core、外置独立测试目录；不读写真实应用数据，不连接真实 Provider/Roon。
- 替换前再次确认安装版未运行；先将新包复制到 Applications 临时暂存路径、校验，再将旧应用移至备份，最后将新包改名为正式路径。未删除旧版或用户数据。
- 备份：`/Volumes/LifeWeave/Developer/CommandLine/Backups/MusicBridge/2026-09-19-29V27t/Music Bridge for Roon.app`。需要回退时可恢复这个应用包，用户数据独立保留。
- 安装包与构建包 `Contents/Resources/app.asar` 的 SHA-256 一致：`4c8d08ed3f64d88a24ed4bcc2c76dd4507693e0ff406465aeb5aa6621520e2a1`。
- 构建和启动日志目录：`/Volumes/LifeWeave/Developer/CommandLine/tmp/musicbridge-local-install-RM5tIj/`，包含 `core-build.log`、`desktop-build.log`、`package.log`、`packaged-startup.log`、`installed-startup.log`。
- 最终报告提交只更新报告和状态，不改变已安装的实现代码；下一基线为该报告提交 HEAD。完成后推送该提交并再次核对远端 HEAD。
- 未执行真实账号登录、真实音频/设备、Owner 验收或远端 CI 验收；不以隔离启动代替这些结论。保留两个未跟踪的独立原型/测试结果目录，已提交文件没有未提交差异。
