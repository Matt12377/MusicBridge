# Music Bridge 双 Mac 开发与 Core Runtime 工作流

## 状态与适用范围

本文档记录 Owner 对 TASK-001A 的临时运行目标调整：

- 开发、测试和构建只在开发 Mac 的 `/Users/yihe/VSCode/MusicBridge` 完成。
- Roon Server/Core 所在 Mac 只作为远程运行目标，不作为开发机。
- Bridge Agent、Stream Gateway 和 Roon Core 在 Core Mac 同机运行。
- 本文档不改变产品源码、核心模块边界、Roon extension_id、端口或 loopback-only 安全规则。
- 本文档不授权 Roon 配对测试、歌曲播放或 TASK-002。

这是一条部署与运行工作流，不是对冻结产品架构的重新设计。产品行为仍以 `docs/09_MASTER_DEVELOPMENT_BLUEPRINT.md` 和当前任务文件为准。

## 两台 Mac 的职责

| 设备 | 允许做的事 | 禁止做的事 |
|---|---|---|
| 开发 Mac | 读取源码、运行固定 pnpm 的 `install`、`verify`、`build`；生成 bundle；通过 SSH 发布、启动、停止和状态检查 Agent | 不把密码、Cookie 或 Token 写入命令、脚本或报告；不执行 Roon 播放验证 |
| Core Mac | 用户级 Node.js 22；运行脱敏 Agent、Stream Gateway 与 Roon Core 同机；提供本地 health 和 loopback 监听 | 不安装 VS Code/Codex/Electron 开发环境；不执行源码测试/构建；不改 Roon；不读数据库或音乐库；不开放 LAN 监听 |

## SSH 前置条件

脚本不硬编码 Core Mac IP。执行时必须提供 Owner 已确认的 SSH endpoint：

```bash
export CORE_SSH_TARGET='roonstation@<verified-core-endpoint>'
```

Host key 必须先由 Owner 在本地终端核验并登记。重复部署推荐使用 Owner 在本地建立的短时 ControlMaster：

```bash
export SSH_CONTROL_PATH="$HOME/.ssh/musicbridge-control/core-live.sock"
```

脚本使用 `BatchMode=yes`，不会把密码放进参数、环境变量、脚本或报告。如果没有可复用的 SSH 公钥或 ControlMaster，脚本在认证阶段停止。

### 本地验收包连接 Remote Core

本地验收包保留受控的 Remote Core 开发入口，默认关闭：

1. 打开“设置 → 高级”。
2. 在“SSH 目标”填写已经写入 `~/.ssh/config` 的别名，或填写 `user@host`。
3. 点击“启动远程 Core”，等待隧道、远端健康检查和本地 Core 重启依次完成。
4. 返回“设置 → Roon”确认 Core 与 Zone 状态。

SSH 目标只在开发 Mac 的应用偏好中保存，不进入 Git、报告或远端 bundle。应用不读取、保存或传递 SSH 密码；Host key、SSH key 和首次认证仍由 Owner 在本地终端预先完成。Main 只调用固定 `/usr/bin/ssh`，保持 `BatchMode=yes`、`StrictHostKeyChecking=yes`、固定端口集合和 loopback-only 转发。

## Core Mac 用户级运行时

优先使用 Core Mac 用户目录下的 nvm，并将 Node.js 固定到 `22.x`：

- 不使用 sudo。
- 不卸载或覆盖 Core Mac 已有 Node.js。
- 不安装全局 npm 包、VS Code、Codex、Electron 或其他开发工具。
- nvm 初始化只加载用户 shell；运行脚本显式加载 `~/.nvm/nvm.sh` 并使用 `nvm use 22`。
- 如果 Core Mac 无法访问官方 nvm 下载入口，允许使用开发 Mac 上已核验的 arm64 nvm 核心文件和 Node.js 22 用户级运行时进行一次性转移；必须记录网络阻断和两端架构核验结果。

## 发布顺序

所有构建步骤在开发 Mac 运行：

```text
pnpm install --frozen-lockfile
  ↓
pnpm verify
  ↓
pnpm build
  ↓
生成独立 staging
  ↓
生产依赖 pnpm deploy --legacy --prod
  ↓
原生 .node 扫描与敏感文件扫描
  ↓
通过 SSH 上传到 releases/<commit-sha>，写入 release metadata
  ↓
current 原子切换
  ↓
start-agent.sh
  ↓
status-agent.sh
```

bundle 顶层只允许：

```text
dist/
node_modules/       # 仅生产依赖
package.json
```

禁止进入 bundle：`src`、`test`、`docs`、`tasks`、`reports`、`.git`、`.env`、Cookie、Token、日志、音频文件和完整播放 URL。

每次 bundle 使用构建时 `git rev-parse HEAD` 的完整 SHA；归档文件同时记录 SHA-256。生产依赖中如果发现 `.node` 文件，脚本必须比较开发 Mac 与 Core Mac 的 CPU 架构，不一致时停止。

首次提升为 release 时，release 内写入权限为 600 的隐藏 metadata，记录 `commit_sha` 和 `bundle_sha256`。如果同一 commit 的 release 已存在，deploy 必须核对 metadata、`dist/main.js`、生产 `node_modules` 和 `package.json`；任一项缺失或不一致都停止，不能静默复用、覆盖或删除。旧 release 缺少 metadata 时仍可由 start/status 兼容运行，但不能被 deploy reuse。workspace 的 `pnpm-lock.yaml` 只在开发机参与构建，不随生产 bundle 部署。

`deploy-agent.sh` 会接收 build 脚本明确返回的本次 `mktemp` staging 路径。成功、构建失败或 SSH 中断退出时，只清理经路径模式、普通目录/文件类型和父子关系三重核验的本次 staging/archive；独立运行 `build-agent-bundle.sh` 时仍保留输出供人工使用。

## Core Mac 目录与运行环境

```text
~/Library/Application Support/MusicBridgeAgent/
├── releases/<commit-sha>/
├── current -> releases/<commit-sha>
├── data/
└── logs/
```

- `current` 是可替换的符号链接，不覆盖旧 release。
- 新 release 内的隐藏 metadata 保存 commit 和 bundle SHA-256；`current` 切换前必须通过完整性复核。
- Agent 的工作目录固定为稳定的 `data/`。
- start 从 `current` 解析 40 位 commit SHA，并在 `data/agent.release` 写入该 SHA，权限固定为 600；`data/agent.pid` 与它必须成对存在。
- Roon 配对配置如果由现有运行时产生，只能留在 `data/`，不能放入 release。
- 不读取或输出 `data/config.json` 内容。
- 失败的上传只使用临时 incoming 目录；完成校验后才提升为 release。

## 固定启动环境

```text
BRIDGE_CONTROL_HOST=127.0.0.1
BRIDGE_CONTROL_PORT=38501
BRIDGE_STREAM_HOST=127.0.0.1
BRIDGE_STREAM_PORT=38502
BRIDGE_PUBLIC_STREAM_BASE_URL=http://127.0.0.1:38502
ENABLE_GENERAL_UNBLOCK=false
ENABLE_PROXY=false
ENABLE_RANDOM_CN_IP=false
LOG_LEVEL=info
```

启动脚本显式清除 `NETEASE_COOKIE`，不创建 `.env`，因此本任务的 health 必须显示 `neteaseConfigured=false`。

## 启停与回滚

发布前如已有本任务 Agent 运行，先执行 `stop-agent.sh`。部署脚本拒绝覆盖正在运行的 release，并只在完整校验后切换 `current`。

`stop-agent.sh` 只有在安全停止后才删除 `data/agent.pid` 和 `data/agent.release`。`status-agent.sh` 同时输出并核对 expected、current、running 和 `agent.release` 四个 release 身份；命令行只用于解析完整 release SHA，不再以是否包含 `dist/main.js` 作为版本正确性的唯一依据。

回滚步骤：

1. 停止当前 Agent。
2. 将 `current` 原子切换到已存在的旧 `releases/<commit-sha>`。
3. 重新启动 Agent。
4. 用 `status-agent.sh` 检查 health、两个 loopback 监听和零播放状态。

回滚不删除旧 release，不触碰 Roon 配置，不执行 `POST /v1/play`。

## 允许的验证

远程启动后只验证：

- Agent 进程存在。
- 38501 和 38502 仅监听 `127.0.0.1`。
- Core Mac 本地 `/health` 返回成功。
- `neteaseConfigured=false`。
- `activeStreamCount=0`。
- `activePlayback` 不存在。
- 日志没有 Cookie、Token、完整 URL、Query 或账号信息。
- 日志扫描覆盖 `NETEASE_COOKIE`、`Cookie:`、`cookie=`、`MUSIC_U`、`__csrf`、`Authorization`、`Bearer`、`token`、完整 URL 和 Query 参数；命中时只输出失败状态，不输出匹配内容。
- 可选的开发 Mac 控制隧道只转发 38501，不转发 38502：

  ```bash
  ssh -N -L 38501:127.0.0.1:38501 "$CORE_SSH_TARGET"
  ```

禁止调用网易云、播放歌曲、执行 `POST /v1/play`、开放 `0.0.0.0`、修改防火墙、安装 Docker/FFmpeg、下载/缓存/转码或解灰。

## 任务结束

TASK-001A 完成后创建 `reports/TASK-001A_RESULT.md` 并立即停止。TASK-002 必须继续保持 `NO`，等待 Owner 单独放行。
