# V4 本机桌面开发入口

当前工作树为 `/Volumes/LifeWeave/VSCode/MusicBridge/worktree/v4`，分支为 `codex/v4`。
源码使用项目工作树目录。`dev:desktop` 会把当前已跟踪文件、未提交源码和既有原生资源同步到批准构建根中的专用编译副本，编译产物仍写在 `/Volumes/LifeWeave/Developer/CommandLine`；固定 Worker 的挂载、真实路径及同卷检查保持不变。

## 启动开发版

```zsh
cd "/Volumes/LifeWeave/VSCode/MusicBridge/worktree/v4"
nvm use
corepack pnpm@10.17.1 dev:desktop
```

`.nvmrc` 固定 Node 22.23.2；项目固定 pnpm 10.17.1。`dev:desktop` 沿用桌面程序原有的先构建再启动流程，修改源码后重新执行，不是热更新服务器。

已打开的旧终端首次使用时，先执行一次 `source ~/.zshenv`。新 zsh 会自动读取外置构建根、临时目录以及 Corepack、pnpm、npm 缓存默认值。交互式终端从已有 `.zshrc` 加载 nvm；非交互式调用可使用 `zsh -lic` 再运行上述命令。

如果没有修改代码，只启动已经构建的桌面产物：

```zsh
corepack pnpm@10.17.1 start:desktop
```

根目录原有 `dev` 和 `start` 继续作为 Core 命令，桌面入口使用带 `:desktop` 的命令。源码改变后，`start:desktop` 会要求先重新构建，防止启动旧产物。直接执行桌面子包的 `dev` 会跳过编译副本准备，请使用这里的根目录入口。

编译副本仅同步发生变化的输入。开发命令会显示实际编译目录；需要只检查构建、暂不打开 App 时，可执行 `corepack pnpm@10.17.1 dev:desktop --build-only`。

## 本机准备与范围

依赖已按锁文件从外置缓存离线安装，Electron 分发包已单独准备，原生资源已从冻结源码包复制到本工作树；依赖、构建产物及原生分发包不提交到 Git。

本工作树采用 2026-10-17 桌面封面修复候选的 2365 文件快照，保留 V3.9 Git 历史。开发入口配置和集成记录单独列明。封面真实滚动体验与移动端 503 仍分别待验证；本次准备没有启动产品界面或恢复其他暂停任务。
