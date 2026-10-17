# V4 工作树迁回项目目录

源码工作树：`/Volumes/LifeWeave/VSCode/MusicBridge/worktree/v4`。这是 `git worktree move` 移动的真实目录，分支仍为 `codex/v4`，并非符号链接或重新克隆。

## 身份与范围

- 迁移基线：`a222b81da84f2b3e524e423569b4ccec0de889a3`。
- 实现提交：`e7eb32d9832f01d90f5a96739a612fe362857345`。
- 本报告提交为实现提交的直接子提交，最终 HEAD 以 Git 为准，作为后续开发基线。
- 移动前后 3469 个跟踪文件逐个 SHA256 核对保持；之后仅修改根开发命令与说明，新增两个开发适配脚本及针对性测试。Mac 产品源码、公开合同、Native 资源和 `build-storage-root.mjs` 均未修改。
- 旧外置工作树位置已由 Git 登记移动，不保留第二个活动检出。

## 启动方式

```zsh
cd "/Volumes/LifeWeave/VSCode/MusicBridge/worktree/v4"
nvm use
corepack pnpm@10.17.1 dev:desktop
```

默认环境继续来自既有 zsh 配置，旧终端首次刷新 `source ~/.zshenv`。只启动已构建产物使用 `start:desktop`；源码发生变化或构建未完成时会要求先重新构建。

## 源码与编译输出

根开发入口将当前跟踪文件、未提交源码和既有 Native 资源同步到 `/Volumes/LifeWeave/Developer/CommandLine/worktrees/musicbridge-dev-25b6ed0447bc/workspace`。按内容及模式复用相同输入，只删除原同步清单拥有且源码已删除的副本文件，保留未知缓存文件，不复制其他 Git 忽略项。

依赖和产物留在批准构建根；编译完成声明在输入变化或重建开始时失效，避免失败后启动部分产物。工作树拥有独立副本和进程锁，源码目录不充当产物目录。原挂载、规范路径、同卷和输出范围检查继续使用。

## 验证与保留失败

- 最终根命令 `corepack pnpm@10.17.1 dev:desktop --build-only` 退出 0，24.733 秒；Contracts/Core、固定 Metadata Worker、新鲜 Native 捕获/封存、Electron Vite development、Preload 依赖检查及 Electron v43.4.0 启动器版本检查均通过。
- 新增副本行为验证涵盖输入复用、未提交修改、精确删除、忽略凭据和旧产物、链接逃逸拒绝、不同工作树隔离，以及源码变化后撤销构建声明；回退源码也不恢复失效声明。
- 首轮合成测试的两个指纹断言失败：夹具把源码放在根 `source.ts`，未对应工程真实 `packages/` 输入。仅改夹具路径后通过。另一例在创建输出逃逸链接前缺少父目录，补齐夹具目录后定向通过；原断言和负例保留。
- 后续补入构建声明失效保护，只定向运行受影响的缓存例，链接和隔离已通过项复用；最终入口再次完整构建以绑定当前适配器。没有重跑既有产品全量测试。
- `git diff --cached --check` 退出 0；完成后工作区清洁检查另见最终本机收据。

详细原始日志、失败记录和结果：`/Volumes/LifeWeave/Developer/CommandLine/tmp/musicbridge-v4-relocate-4onp9eqm`。

## 交付边界

仅本机工作树与开发入口交付；没有启动 MusicBridge 产品界面、替换安装包、操作真实曲库或手机，没有推送或触发 CI。其他开发与功能测试继续暂停。桌面封面与移动端 503 原有问题的验收状态保持。
