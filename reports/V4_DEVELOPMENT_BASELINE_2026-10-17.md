# V4 本机开发基线集成

> 本文保留初次建立时的证据。工作树后来已迁入项目目录，当前入口见 `docs/development/V4_START.md`；迁移验证见 `reports/V4_WORKTREE_RELOCATION_2026-10-17.md`。

工作树：`/Volumes/LifeWeave/Developer/CommandLine/worktrees/v4`；分支：`codex/v4`。

## 来源与提交

- Git 基线：`4c1c6c78d965260a56c3f5bf51f1d6c83ddb9870`，来自既有 V3.9 独立仓库；仅本地导入历史，原分支和未提交改动保留。
- 实现提交：`d2c8c855727cf9c6ec7cf25d5c3a455df1b82757`。
- 本报告提交为实现提交的直接子提交，最终 HEAD 以 Git 为准；下一开发基线为该报告提交。
- 最新 Mac 快照：2365 个文件，SHA256 `2aef7af258197e69ac735d32a37b99dc7d6f0d847db71f279d587790e7163f48`。
- 快照之外保留 Git 基线的原生源码、合同夹具、文档和其他已有跟踪文件；未把快照中未列出的文件当作删除清单。
- 快照投影仅有三处集成差异：根 `package.json` 添加桌面命令别名；`local-cue-output-actor.ts` 与 `local-cue-output-protocol.ts` 各移除一个文件末尾多余空行。其他 2362 文件字节、SHA256 和模式核对一致。
- 新增 `.nvmrc` 和开发入口说明；忽略本机 CUE、TagLib、library-watch 分发资源，依赖与派生产物不进入提交。

## 默认环境和入口

已有 `.zshenv` 的构建根、缓存根、临时目录默认值保持，补齐 Corepack、pnpm、npm 的外置缓存默认值；原文件备份留在本机外置证据目录。交互式 `.zshrc` 已加载 nvm；`.nvmrc` 固定 Node 22.23.2。

```zsh
cd "/Volumes/LifeWeave/Developer/CommandLine/worktrees/v4"
nvm use
corepack pnpm@10.17.1 dev:desktop
```

旧终端首次执行 `source ~/.zshenv`；新终端自动采用。已有产物可使用 `corepack pnpm@10.17.1 start:desktop`。

## 实际验证

- 锁文件离线安装退出 0，612 包全部复用、下载 0；移动工作树后再次离线重连退出 0，已无旧目录的命令入口引用。
- Contracts TypeScript 构建退出 0；Core TypeScript 构建退出 0。
- 固定 Metadata Worker 在最终批准根新构建退出 0；原始输入和加载图闭合继续校验。
- CUE、TagLib、watch 捕获与封存，Electron Vite development 构建、preload 依赖检查均退出 0。
- 两处 EOF 规范化后只重编译受影响 Core 输出及其桌面绑定；Contracts 和未涉及的固定 Worker 不重复构建，既有功能测试保持暂停。
- Electron 命令入口 `--version` 退出 0，返回 v43.4.0；产品界面未启动。
- `git diff --cached --check` 退出 0。
- 原根仓库与原 V3.9 仓库 HEAD、分支、既存未提交文件重新核验保持；详见本机证据。

## 保留的失败与修正

首次把工作树放在 VSCode 项目目录，Worker 的原 `buildStoragePolicy` 在输出校验阶段拒绝“构建目录必须位于批准根之下”。原始失败结果和日志保留；仅将新建 v4 工作树移动到现有批准构建根的 `worktrees/v4`，没有修改挂载、真实路径、同卷或输出范围校验。先补验证该失败步骤，再继续桌面构建。

第一次暂存检查发现上述两个既有新文件 EOF 空行；修正后检查通过。该规范化不改变执行语句。

## 交付边界

本次交付为本机可构建的最新开发基线。未启动应用、未安装替换正式 App、未触发远端 CI 或推送；首次只读远端查询未找到 `codex/v4` 上游分支。当前软件构建证据不代表真实曲库、封面滚动体验、手机播放或 Owner 验收通过。

桌面封面真实五场景和移动端发现页／专辑曲目 503 继续独立保留；其他开发、设备操作与功能测试仍暂停。

本机详细证据目录：`/Volumes/LifeWeave/Developer/CommandLine/tmp/musicbridge-v4-setup-eifhgyg0`。
