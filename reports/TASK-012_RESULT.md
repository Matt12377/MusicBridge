# TASK-012 结果报告：Bridge Core utilityProcess 与 typed IPC

## 结论

**PASS**

TASK-012 已完成。Bridge Core 现在由 Electron `utilityProcess` 运行，Main 通过版本化 `MessagePort` 与 Core 通信，Renderer 只通过 Preload 暴露的业务方法读取脱敏状态。开发 Mac 自动 Gate、未签名打包 Gate、真实 Core Mac 部署 Gate、崩溃恢复 Gate 和退出端口释放 Gate 均通过。

未开始 TASK-013 或任何更后续任务。

## Git 身份

- WAVE：`WAVE-2`
- TASK：`TASK-012`
- 分支：`codex/wave-2-desktop-core`
- 基线 SHA：`00640852cae94c980902aa422475b59eabb16276`
- 实现 SHA：`dc293f1416130c8f16b124478d859a580a07ffbd`
- 实现 commit：`feat: run Bridge Core in Electron utility process`
- 实现提交已推送到当前阶段分支；本报告随后以独立文档 commit 提交。

最终工作区在报告生成前保持干净；构建目录和打包目录由既有忽略规则排除。

## 实现范围

### Core 与 IPC

- 新增 `packages/contracts` 的 typed IPC 命令、结果和事件类型，协议版本固定为 `1`。
- 命令覆盖 `core.ping`、`core.getHealth`、`core.getState`、`core.shutdown`、`roon.listZones` 和 `roon.selectZone`。
- 事件覆盖 `core.ready`、`core.health`、`roon.changed` 和 `diagnostic.notice`。
- 请求使用唯一 request id；请求、响应、事件和命令结果均做 schema 校验；未知版本、未知命令、非法 payload、非法结果和不安全错误对象均拒绝。
- 公共错误只允许白名单 code/message，不跨 IPC 传递内部 stack、凭据或上游响应内容。
- Bridge Core 运行在独立 Electron `utilityProcess`；Headless 入口改为复用同一 `createBridgeRuntime`，未改变 Core 业务边界。
- Main 监督器对 ready、request timeout、Core 退出和 bounded shutdown 有明确状态；自动重启最多一次，第二次崩溃进入 `failed`，不存在无限重启。
- 测试专用 crash probe 只在测试环境变量和测试启动 Gate 下启用，不在生产 UI 暴露。

### Main、Preload 与 Renderer

- Main 使用 `MessageChannelMain` 和 `utilityProcess.fork` 建立 Core 通道。
- IPC handler 校验当前窗口实例、`webContents` sender、sender id 和本地 `file:` frame；远程 frame、错误窗口和不匹配 sender 均拒绝。
- Preload 只暴露 `getAppInfo`、`getCoreHealth`、`getCoreState`、`pingCore` 和脱敏 `onCoreEvent`；Renderer 不接触 Electron、Node、Cookie、上游地址、网关令牌或 Roon session 身份。
- Renderer 已显示 Core runtime、Roon 状态、Provider 状态和活动流数量；所有字段来自公共状态模型。
- 沙箱 Preload 使用 CJS 构建输出，实际 Electron 启动验证确认 `window.musicBridge` 成功注入。

### 配置迁移与生命周期

- Roon SDK 的工作目录固定为应用正式 data 目录。
- 旧 POC 配置迁移使用普通文件检查、JSON 校验、600 权限、临时文件和原子 rename。
- 迁移失败不会删除旧文件；目标已存在时保留目标并保留旧文件；迁移过程不输出配置内容。
- App 退出先请求 Core bounded shutdown，再关闭应用；Renderer 异常不会阻止 Core 清理。
- Roon extension id、38501/38502 端口、loopback-only 规则以及 Provider/Stream Gateway 的安全开关保持不变。

## 版本与打包身份

| 项目 | 开发 Mac | Core Mac |
| --- | --- | --- |
| CPU | `arm64` | `arm64` |
| macOS | `26.6.1` | `26.5.2` |
| 用户级 Node | `v22.23.2` | `v22.23.2` |
| npm | `10.9.8` | 未作为运行时依赖使用 |
| pnpm | `10.17.1` | 未作为桌面运行时依赖使用 |
| Electron | `43.4.0` | app bundle 内运行 |

未升级已有依赖版本；桌面包为让 Core bundle 在打包环境中解析既有 Roon/Provider runtime 依赖，复用了 workspace 中已锁定的相同版本和 Git 提交引用。

### App bundle

- 本地打包输入：`apps/desktop/dist` 与生产依赖。
- 打包结果：未签名 macOS arm64 `Music Bridge for Roon.app`。
- bundle 顶层运行内容：Electron app、`dist/main/index.js`、`dist/main/core.js`、`dist/preload/index.cjs`、Renderer 构建资源和生产依赖。
- 不包含源码开发目录、测试、docs、tasks、reports、`.git`、`.env` 或本地凭据文件。
- `Contents/Resources/app.asar` SHA-256：`7227a1d2c94217f43ab62fbcca6019fa21d2fdfda972f6bb1beb9739946d0f4f`。
- staging/archive 临时目录：本轮未创建持久 staging/archive；electron-builder 只生成被 `.gitignore` 忽略的本地 `release` 产物。

## 自动验证

| 检查 | 结果 |
| --- | ---: |
| contracts typecheck | 退出码 `0` |
| bridge-core typecheck | 退出码 `0` |
| desktop typecheck | 退出码 `0` |
| contracts tests | `7/7`，退出码 `0` |
| bridge-core tests | `90/90`，退出码 `0` |
| desktop tests | `14/14`，退出码 `0` |
| `corepack pnpm@10.17.1 verify` | 退出码 `0` |
| `git diff --check` | 退出码 `0` |
| development startup Gate | `DESKTOP_STARTUP_PASS=development`，退出码 `0` |
| production startup Gate | `DESKTOP_STARTUP_PASS=production`，退出码 `0` |
| test-only Core crash Gate | `CORE_CRASH_GATE=development`，退出码 `0` |
| `electron-builder --dir` 未签名打包 | 退出码 `0` |
| 未签名 packaged app startup | `DESKTOP_STARTUP_READY`，退出码 `0` |

development/production startup Gate 会实际从 Renderer 调用 `pingCore`、`getCoreHealth`、`getCoreState`，并使用 contracts 校验返回的公共状态；不是只检查窗口进程存在。

## Core Mac 实机 Gate

### 远程预检

- 严格 host-key 校验的 SSH ControlMaster 已建立并复用；未把密码写入命令参数、脚本、报告或日志。
- Core Mac 为 arm64，用户级 nvm Node 为 `v22.23.2`。
- Roon Core 进程存在。
- 旧 Headless Agent 启动前占用两个端口；未停止或重启 Roon Core。

### 部署、启动与状态

- 旧 Headless Agent 使用既有 stop 流程安全停止，退出码 `0`，旧 release 未删除。
- 新 app 部署到：`~/Library/Application Support/Music Bridge for Roon/releases/dc293f1416130c8f16b124478d859a580a07ffbd/`。
- `current` 为可切换符号链接并指向实现 SHA；远程 incoming 目录部署后已清理。
- 远程 app bundle SHA-256 与开发 Mac 相同：`7227a1d2c94217f43ab62fbcca6019fa21d2fdfda972f6bb1beb9739946d0f4f`。
- Core Mac app 进程存在，PID 文件为普通文件且权限为 `600`。
- Core Mac Roon 状态：`ready`。
- `health` 脱敏字段检查：通过；`neteaseConfigured=false`、`activeStreamCount=0`、无 `activePlayback`。
- 38501 和 38502 均只监听 loopback；未开放 LAN、未转发流端口。
- 日志秘密扫描：通过；未命中 Cookie、Provider credential、授权头、令牌、完整带 Query 地址等模式。
- 未执行歌曲播放、`POST /v1/play`、Provider 配置或 Roon 数据库/音乐库读取。

### 退出与恢复

- 发送 app `SIGTERM` 后 Core shutdown 完成，38501 和 38502 均释放；退出 Gate 通过。
- 随后从同一 `current` release 再次启动 app，最终运行 release 仍为 `dc293f1416130c8f16b124478d859a580a07ffbd`。
- 最终远程状态：app 运行、Roon `ready`、两个端口 loopback、Provider 未配置、无活动流、无 active playback、日志扫描通过。

## 安全与范围

- 未修改 Roon extension id、端口、loopback-only 安全边界、解灰/代理/随机 IP 开关或 Stream Gateway 规则。
- 未把 Provider credential 放入 argv、Renderer IPC、Git、报告或日志；未读取、输出或保存任何凭据内容。
- 未执行播放、未请求歌曲、未调用 `POST /v1/play`，未配置 Provider。
- 未安装 VS Code、Codex、Docker、FFmpeg 或全局 npm 包。
- 未创建 PR、未合并、未发布、未开始 TASK-013。

## TASK 状态

- TASK-012：**PASS**。
- TASK-013：**未开始，等待本报告提交、推送和 Owner 放行**。
