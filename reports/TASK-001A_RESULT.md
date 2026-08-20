# TASK-001A 结果

## 结果

**PASS**

TASK-001A 已完成：开发 Mac 负责构建，Core Mac 仅作为远程运行目标；Node.js 22 用户级运行时、脱敏 Agent bundle、release/current 目录、启动/停止/状态脚本和 38501-only SSH 隧道验证均已完成。TASK-002 未开始。

## 开发机与运行机职责

| 设备 | 本次职责 |
|---|---|
| 开发 Mac | 在 /Users/yihe/VSCode/MusicBridge 执行 npm ci、verify、build；生成 production bundle；通过已核验 SSH ControlMaster 部署和验收 |
| Core Mac | 用户级 Node.js 22；在稳定 data/ 工作目录运行 Bridge Agent、Stream Gateway 与 Roon Core 同机；不安装 VS Code/Codex/完整开发环境 |

本次没有修改产品源码、package.json、package-lock.json、Roon extension_id、端口、loopback-only 规则、Provider 或 Stream Gateway 行为。

## 开发机基线

| 项目 | 结果 |
|---|---|
| 项目根目录 | PASS：/Users/yihe/VSCode/MusicBridge |
| Git 分支 | codex/task-001-starter-baseline |
| Git HEAD | 98227ae3b1491758d1c9ea0abdb0647de27c48a2 |
| Node.js | v22.23.2 |
| npm | 10.9.8 |
| CPU 架构 | arm64 |
| macOS | 26.6.1，Build 25G76 |
| 依赖/源码范围 | package.json、package-lock.json、src 均未修改 |

## 脱敏远程环境

| 项目 | 结果 |
|---|---|
| SSH endpoint | Owner 已核验的 Core endpoint；报告不记录内部 IP |
| macOS | 26.5.2，Build 25F84 |
| CPU 架构 | arm64 |
| Roon 进程 | 只读布尔检查为 present |
| 远程 nvm | 0.40.6 |
| 远程 Node.js | v22.23.2 |
| 远程 npm | 10.9.8 |
| 新 zsh 默认 Node | v22.23.2 |
| 新 zsh nvm current/default | v22.23.2 / default -> 22 |
| 远程 Shell 配置 | 远程原先不存在 ~/.zshrc；创建了只含 nvm 初始化的用户级配置，因此没有可用的旧 ~/.zshrc 备份文件 |
| 远程 Node 安装方式 | 官方 nvm 下载入口因 Core Mac egress 失败；从开发 Mac 已核验的 arm64 nvm 核心和 Node.js 22 用户级运行时转移，未使用 sudo |

SSH host key 由 Owner 在本地终端核对后，使用临时 ControlMaster 完成部署。密码没有写入脚本、环境变量、报告或日志。

## 部署目录与 release

远程目录：

~~~text
~/Library/Application Support/MusicBridgeAgent/
├── releases/98227ae3b1491758d1c9ea0abdb0647de27c48a2/
├── current -> releases/98227ae3b1491758d1c9ea0abdb0647de27c48a2
├── data/
└── logs/
~~~

部署结果：

| 检查项 | 结果 |
|---|---|
| release SHA | 98227ae3b1491758d1c9ea0abdb0647de27c48a2 |
| current | PASS，指向该 release |
| 远程 release 顶层 | dist、node_modules、package.json、package-lock.json |
| production node_modules | PASS，使用 npm ci --omit=dev --ignore-scripts |
| bundle SHA-256 | dbcc1a7bfdbdb6c3f401c182d7b0eea4348848a6673641de7c356e21700a7359 |
| production .node 数量 | 0 |
| release 禁止文件数量 | 0 |
| 临时 current/probe symlink 残留 | 0 |
| incoming 目录数量 | 0 |

bundle 未包含 src、test、docs、tasks、reports、.git、.env、日志或音频文件。上游依赖中的 .env.example 和日志文件仅在临时 staging 中剔除，没有修改项目依赖或 lockfile。

## 开发机构建验证

| 命令 | 结果 | 证据 |
|---|---|---|
| npm ci | PASS | 退出码 0 |
| npm run verify | PASS | typecheck、test、build 均通过 |
| npm run build | PASS | 退出码 0 |
| npm test | PASS | 16/16 通过，0 失败、0 跳过 |
| production npm ci --omit=dev --ignore-scripts | PASS | 退出码 0 |
| bundle 文件清单扫描 | PASS | 仅四个允许的顶层项目 |
| 原生 .node 扫描 | PASS | 0；两端 arm64 仍已核验 |
| bundle SHA-256 | PASS | dbcc1a7bfdbdb6c3f401c182d7b0eea4348848a6673641de7c356e21700a7359 |

npm 安装保留了既有 Git 依赖 integrity warning 和上游 deprecated warning；没有升级依赖，没有执行 npm audit fix。

## 远程 Agent health 与监听

最终 status-agent.sh 退出码为 0：

~~~text
CURRENT_RELEASE_SHA=98227ae3b1491758d1c9ea0abdb0647de27c48a2
AGENT_PID_STATUS=running
CONTROL_LISTEN=loopback
STREAM_LISTEN=loopback
NODE_VERSION=v22.23.2
HEALTH_OK=true
NETEASE_CONFIGURED=false
ACTIVE_STREAM_COUNT=0
ACTIVE_PLAYBACK_PRESENT=false
LOG_SECRET_SCAN=pass
STATUS_RESULT=PASS
~~~

Agent 启动环境固定为：

~~~text
BRIDGE_CONTROL_HOST=127.0.0.1
BRIDGE_CONTROL_PORT=38501
BRIDGE_STREAM_HOST=127.0.0.1
BRIDGE_STREAM_PORT=38502
BRIDGE_PUBLIC_STREAM_BASE_URL=http://127.0.0.1:38502
ENABLE_GENERAL_UNBLOCK=false
ENABLE_PROXY=false
ENABLE_RANDOM_CN_IP=false
LOG_LEVEL=info
~~~

启动脚本显式清除 Provider 凭据环境变量，未创建 .env。未执行 /v1/play、歌曲播放、网易云调用或 Roon 配对测试。

## SSH 隧道验证

仅建立并验证了控制端口转发：

~~~text
ssh -N -L 38501:127.0.0.1:38501 <CORE_SSH_TARGET>
~~~

开发 Mac 通过隧道取得：

~~~text
HTTP status=200
health ok=true
neteaseConfigured=false
activeStreamCount=0
activePlayback 不存在
~~~

隧道已关闭。38502 没有转发，也没有暴露到 LAN。

## 回滚验证

- 部署流程保留旧 release，不删除历史 release。
- 发现 macOS 普通 mv 可能跟随 current 目标目录后，已将原子切换修正为 mv -h -f。
- 使用临时 rollback probe 验证 current 原子切换到 probe 后可恢复到真实 SHA。
- probe 和临时 symlink 已清理；最终 current 恢复到 98227ae3b1491758d1c9ea0abdb0647de27c48a2。
- 这是首次 release，因此没有第二个不同 commit 可执行内容差异回滚；真实旧版本回滚将在产生下一 release 后再单独验证。

stop-agent.sh 的首次 20 秒等待遇到 Agent 正在完成 Roon adapter shutdown 的时序边界；日志事件随后确认 bridge_shutdown_complete，且进程已退出。脚本已增加进程状态检查并将安全等待上限调整为 60 秒；随后真实执行 start → stop，最终返回 AGENT_STOPPED，再重新启动并通过最终 status 验证。未使用 kill -9。

## 安全检查

- 没有读取或输出 Core Mac 登录密码、SSH 私钥、Provider 凭据、临时令牌、远程持久化配置内容、账号信息或完整播放 URL。
- 没有调用网易云、播放歌曲或执行 POST /v1/play。
- 没有停止、重启或修改 Roon Server/Core；只确认 Roon 进程存在。
- 没有开放 0.0.0.0、局域网控制端口或流端口。
- 没有转发 38502，没有修改防火墙，没有安装 Docker 或 FFmpeg。
- 没有创建远程全局 npm 包、VS Code、Codex、Electron 开发环境。
- 已锁定的 API 依赖树仍包含间接的 unblock provider 包；本任务未新增、删除或调用它，现有安全环境旗标均为 false。该项作为供应链残余风险，需独立任务和 Owner 决策。
- 日志扫描只输出通过/失败状态，不输出日志正文；最终为 pass。
- 当前工作区只产生本任务允许的文档、脚本和报告文件；未修改产品代码或依赖。

## 未执行事项

- 未开始 TASK-002。
- 未进行 Roon pairing、Zone 选择、歌曲播放、Signal Path 或真实账号 Gate。
- 未执行 POST /v1/play。
- 未发布、未创建 PR、未合并、未 push 新提交。
- 未修改 .gitignore，因为 staging 使用系统临时目录，不产生项目内部署产物。
- 未创建或填写 .env。

## TASK-002 是否可开始

**NO**。

TASK-001A 已完成并在本报告记录证据，但 Owner 必须单独放行 TASK-002；在放行前不得开始 Roon 配对测试或任何后续任务。完成本报告后停止。
