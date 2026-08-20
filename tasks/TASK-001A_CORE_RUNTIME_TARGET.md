# TASK-001A — Core Runtime Target

## 目标

在开发 Mac 上完成全部开发、测试和构建，并通过 SSH 将脱敏、可运行的 Bridge Agent 部署到 Roon Core Mac。Core Mac 只提供用户级 Node.js 22 运行时和同机 Agent 运行环境，不作为开发机。

## 输入与边界

- 开发根目录：`/Users/yihe/VSCode/MusicBridge`
- Core SSH endpoint：由 Owner 运行时通过 `CORE_SSH_TARGET` 提供，不在脚本中硬编码 IP。
- Core 主机标识：由 Owner 提供的主机名仅用于人工确认和报告脱敏记录。
- 控制端口：`127.0.0.1:38501`
- 流端口：`127.0.0.1:38502`
- 不进行 Roon 配对测试，不调用网易云，不播放歌曲，不执行 `POST /v1/play`。

## 允许修改的文件

```text
docs/15_TWO_MAC_DEVELOPMENT_WORKFLOW.md
tasks/TASK-001A_CORE_RUNTIME_TARGET.md
scripts/deploy/build-agent-bundle.sh
scripts/deploy/deploy-agent.sh
scripts/deploy/start-agent.sh
scripts/deploy/stop-agent.sh
scripts/deploy/status-agent.sh
reports/TASK-001A_RESULT.md
.gitignore  # 仅在确实需要忽略本地部署产物时最小修改
```

本任务不得修改产品源码、`package.json`、`package-lock.json`、Roon extension_id、端口、loopback-only 规则、网易云接口或 Stream Gateway 行为。

## 执行阶段

### A. 只读基线与远程预检

1. 完整读取开发蓝图、运行协议、测试发布策略、TASK-000/TASK-001 报告、包清单和运行入口源码。
2. 记录开发 Mac 的分支、HEAD、工作区、Node.js 和 npm。
3. 通过严格 host key 校验的 SSH 连接 Core Mac。
4. 脱敏记录 Core Mac macOS 版本和 CPU 架构。
5. 只读确认 Roon 进程存在、38501/38502 未被占用、nvm/Node 状态。
6. 不停止、不重启、不修改 Roon，不读 Roon 数据库或音乐库。

### B. 用户级 Node.js 22

1. 优先使用 Core Mac 用户目录中的 nvm。
2. 不使用 sudo，不卸载或覆盖已有 Node.js。
3. 如果 Core Mac 无法访问官方 nvm 下载入口，可转移开发 Mac 已核验的 arm64 nvm 核心和 Node.js 22 用户级运行时。
4. 新 zsh Shell 必须报告 Node.js `v22.x.x`，npm 可用，`nvm current` 和 default 均为 22。

### C. 开发 Mac bundle

1. 运行 `npm ci`。
2. 按顺序运行 `npm run verify`、`npm run build`。
3. 以当前 Git commit SHA 生成独立 staging 和归档。
4. staging 顶层只包含 `dist`、生产 `node_modules`、`package.json`、`package-lock.json`。
5. 扫描禁止文件、敏感赋值、完整播放 URL 和生产依赖中的 `.node` 模块。
6. 有原生模块时比较两端架构；不一致立即停止。

### D. 远程发布与运行

1. 上传到 `~/Library/Application Support/MusicBridgeAgent/releases/<commit-sha>/`。
2. 校验 bundle SHA-256 和顶层文件清单。
3. `current` 使用临时符号链接原子切换；首次 release 写入 commit 和 bundle SHA-256 metadata。
4. Agent 从稳定 `data/` 目录启动，日志写入稳定 `logs/` 目录。
5. 使用固定 loopback 环境启动，不创建 `.env`，显式清除 `NETEASE_COOKIE`。
6. 同一 release 已存在时，必须校验 metadata、`dist/main.js`、生产 `node_modules`、`package.json` 和 `package-lock.json`；不一致停止，不覆盖、不删除。
7. deploy 调用 build 脚本时，成功、失败和 SSH 中断均清理经验证属于本次 `mktemp` 的 staging/archive；build 脚本独立运行可保留输出。

### E. 远程验收与回滚

1. start 解析 `current` 的 40 位 commit SHA，写入权限为 600 的 `data/agent.release`，并与 PID 成对维护。
2. 只验证 Agent、health、loopback 监听、零 stream/播放状态和脱敏日志。
3. status 必须核对 expected/current/running/`agent.release` 四个 release 身份，三者或四者不一致时失败；不得只凭命令行包含 `dist/main.js` 判定版本。
4. stop 成功后删除 `agent.pid` 和 `agent.release`。
5. 不调用 `/v1/play`，不播放歌曲，不做 Roon pairing Gate。
6. 保存旧 release，执行一次 current 切换到旧 release、启动验收、停止并恢复新 release 的真实回滚验证。
7. 创建 `reports/TASK-001A_RESULT.md`，结论只能是 `PASS`、`PARTIAL` 或 `BLOCKED`。
8. 完成报告后立即停止，TASK-002 写为 `NO`。

## 固定运行环境

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

## 停止条件

遇到密码/人工确认、host key 无法核验、远程架构不一致、端口占用、原生模块不兼容、敏感信息、需要 sudo、Roon 修改、非 loopback 监听、部署包污染或任何范围外修改时，立即停止并写明失败命令和 Owner 所需动作。
