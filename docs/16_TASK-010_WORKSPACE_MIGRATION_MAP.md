# TASK-010 workspace 迁移映射

## 冻结基线

- WAVE-2 base：`f064323d527dd6d2d7ce0b00e1c44928962bfbe6`
- 冻结 tag：`poc-001-passed`
- 目标分支：`codex/wave-2-desktop-core`
- 行为基线：86 项 POC 测试、Headless CLI、Roon Audio Input、Stream Gateway、部署脚本和 loopback 安全边界保持不变。

## 路径映射

| 冻结路径 | TASK-010 路径 | 处理 |
|---|---|---|
| `src/**` | `packages/bridge-core/src/**` | 原样迁移；只修正迁移后必要的相对路径和 package 入口，不重写业务行为 |
| `test/**` | `packages/bridge-core/test/**` | 原样迁移；保留全部 86 项测试 |
| `scripts/doctor.mjs` | `packages/bridge-core/scripts/doctor.mjs` | 与 Headless Core 同包，保留 `doctor` 能力 |
| `scripts/play.mjs` | `packages/bridge-core/scripts/play.mjs` | 与 Headless Core 同包，保留 `play` 能力 |
| `scripts/state.mjs` | `packages/bridge-core/scripts/state.mjs` | 与 Headless Core 同包，保留 `state` 能力 |
| `scripts/stop.mjs` | `packages/bridge-core/scripts/stop.mjs` | 与 Headless Core 同包，保留 `stop` 能力 |
| `scripts/deploy/**` | `scripts/deploy/**` | 保留在仓库根目录；仅将构建输入和 lockfile 检查改为 workspace 路径 |
| `tsconfig.json` | `packages/bridge-core/tsconfig.json` | Core production 编译配置 |
| `tsconfig.test.json` | `packages/bridge-core/tsconfig.test.json` | Core 测试类型检查配置 |
| 根 `package.json` | 根 workspace manifest | 只保留 workspace 编排、统一命令和固定 `packageManager` |
| `package.json` 的 POC 运行依赖 | `packages/bridge-core/package.json` | 保留冻结 lockfile 中的解析版本，不升级依赖 |
| `package-lock.json` | `pnpm-lock.yaml` | 完成依赖集合/解析结果核对后删除旧 lockfile；旧 lockfile 仍保留在 Git 历史 |

## 新 workspace

### `packages/bridge-core`

- 包名：`@music-bridge/bridge-core`
- 责任：现有 NetEase、Roon、Stream Gateway、控制服务、Headless 入口和 CLI。
- 允许依赖 `@music-bridge/contracts`，但 TASK-010 不把业务实现放入 contracts。
- 不导入 Electron 或 Vue。

### `packages/contracts`

- 包名：`@music-bridge/contracts`
- 初始内容仅为公共状态模型、公开错误模型、IPC envelope 和 runtime validator。
- 不依赖 bridge-core、Electron、Roon、NetEase 或 Node-only 实现。

### `apps/desktop`

- 包名：`@music-bridge/desktop`
- TASK-010 只建立 workspace 占位和可验证的空壳 package。
- 不创建 Electron 功能，不加入 Electron/Vue 依赖，不连接 Core。

## 根命令映射

| 根命令 | 执行目标 |
|---|---|
| `pnpm build` | contracts、bridge-core、desktop 三个 workspace 的 build |
| `pnpm typecheck` | contracts、bridge-core、desktop 三个 workspace 的 typecheck |
| `pnpm test` | contracts、bridge-core、desktop 三个 workspace 的 test；包含全部 POC 测试 |
| `pnpm verify` | 按 typecheck → test → build 顺序覆盖全部 workspace |
| `pnpm doctor` | 调用 bridge-core 的 Headless doctor |
| `pnpm play/state/stop` | 调用 bridge-core 对应 Headless CLI |
| `pnpm dev/start` | 调用 bridge-core 的 Headless 入口 |

## 部署映射

- bundle 的生产入口从根 `dist/main.js` 改为 `packages/bridge-core/dist/main.js` 输入，staging 内仍输出稳定的 `dist/main.js`，以保持远程 release 启动契约。
- bundle 使用 pnpm workspace 的生产依赖解析，不再依赖根 `package-lock.json`。
- 远程 release 继续只包含可运行产物和生产依赖，不包含源码、测试、文档、任务、报告、Git 元数据、环境文件、凭据或音频。
- `current`、release identity、loopback 端口和 Core Mac 目录边界保持不变。

## 边界与验收

- 不升级既有 POC 依赖，不改变 Roon Git commit、NetEase API 版本、extension ID、端口或安全开关。
- 迁移期间先验证 package manifest 与旧 `package-lock.json` 的依赖集合及解析版本，再删除旧 lockfile。
- 完成后运行根 `pnpm verify`、Headless `doctor`/构建检查、循环依赖扫描和 bundle 静态检查。
- TASK-010 完成后才允许进入 TASK-011；本映射不授权任何 Electron 功能实现。
