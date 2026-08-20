# TASK-001A 复审修复结果

## 最终结论

**PASS**。

本报告记录 Owner 对 TASK-001A 的 CHANGES REQUESTED 修复结果。开发机继续负责构建、验证和部署；运行机只运行脱敏 Agent。TASK-002 未开始，仍为 **NO**。

## 审查基线与分支

Owner 指令给出的 base SHA `63532329b1491758d1c9ea0abdb0647de27c48a2` 在本地和远端均无法解析。经 `origin/codex/task-001-starter-baseline` 核验，与审查提交 message 对应的实际原始实现 commit 为：

`63532329ca0e0fd7b4c43b52fae75e92fa2d19ff`

| 项目 | 结果 |
|---|---|
| 修复分支 | `codex/task-001a-review-fixes` |
| 修复 commit | `5e37de04866240772a7addfd8a182b190bb216e7` |
| commit message | `fix: harden two-mac agent deployment` |
| 原报告“未 push 新提交” | 提交前记录，已由本次修复分支的最终发布状态更正 |
| 修改范围 | 仅部署脚本、两份工作流/任务文档和本报告 |
| 产品源码/依赖基线 | 无差异 |

## 修改文件

- `scripts/deploy/build-agent-bundle.sh`
- `scripts/deploy/deploy-agent.sh`
- `scripts/deploy/start-agent.sh`
- `scripts/deploy/stop-agent.sh`
- `scripts/deploy/status-agent.sh`
- `docs/15_TWO_MAC_DEVELOPMENT_WORKFLOW.md`
- `tasks/TASK-001A_CORE_RUNTIME_TARGET.md`
- `reports/TASK-001A_RESULT.md`

未修改 `src/`、`test/`、`package.json`、`package-lock.json`、`.gitignore`、Roon extension_id、端口、loopback-only 规则、Provider 或 Stream Gateway 行为。

## Release 完整性修复

新 release：`5e37de04866240772a7addfd8a182b190bb216e7`

bundle SHA-256：`8bfb4600ec4c75db0ec76ccffc1da4c90227fd89c69096ffffbdecf636f7b569`

验证结果：

- release 内 metadata 记录的 commit 与 bundle SHA-256 均匹配；
- metadata 权限为 `600`；
- `dist/main.js`、生产 `node_modules`、`package.json`、`package-lock.json` 均存在；
- `incoming` 目录数量为 `0`；
- 已存在 release 不再静默覆盖、删除或无校验复用；缺少 metadata 或内容不一致会停止；
- 旧 release 缺少新 metadata，但通过兼容的 start/status 运行路径完成回滚验证，未用于 deploy reuse。

## 运行版本身份

最终运行 release 的 expected、current、running 和 `data/agent.release` 四个身份均为：

`5e37de04866240772a7addfd8a182b190bb216e7`

- `data/agent.pid` 权限：`600`；
- `data/agent.release` 权限：`600`；
- `RELEASE_IDENTITY_CONSISTENT=true`；
- stop 成功后已验证 PID 与 release 标识成对删除；
- status 不再只凭命令行是否包含 `dist/main.js` 判定版本，而是解析完整 release SHA 并与 current/agent.release/expected 交叉核对。

## 本地环境与验证退出码

最终本地构建和验证均显式使用 Node.js `v22.23.2`。复审期间发现登录 shell 曾默认落到 Node.js 25；没有用该环境进行最终 bundle，随后加载 nvm 的 Node.js 22 重跑全部验证。

| 命令 | 结果 |
|---|---|
| `bash -n scripts/deploy/build-agent-bundle.sh` | 0 |
| `bash -n scripts/deploy/deploy-agent.sh` | 0 |
| `bash -n scripts/deploy/start-agent.sh` | 0 |
| `bash -n scripts/deploy/stop-agent.sh` | 0 |
| `bash -n scripts/deploy/status-agent.sh` | 0 |
| `npm run doctor` | 0；脱敏环境未配置 Provider 凭据的提示符合预期 |
| `npm run typecheck` | 0 |
| `npm test` | 0；16/16 通过 |
| `npm run build` | 0 |
| `npm run verify` | 0 |
| `deploy-agent.sh` | 0；`DEPLOY_RESULT=PASS`、`DEPLOY_TEMP_CLEANUP=PASS` |

本轮 deploy 内部再次执行了 `npm ci`、`npm run verify` 和 `npm run build`；未修改依赖声明或 lockfile。

## 临时目录清理

- build 脚本明确返回本次 `mktemp` staging 父目录；deploy 对路径模式、普通目录/文件类型和父子关系进行核验后清理；
- 本次 deploy 的 staging 和 archive 精确路径均已不存在；
- deploy 输出 `DEPLOY_TEMP_CLEANUP=PASS`；
- 远端 `incoming` 数量为 `0`，current/rollback 临时符号链接数量为 `0`；
- 临时目录中另有早于本次修复的历史 staging 目录，本次未删除，避免越界清理非本次创建的目录。

## 新 release 运行验收

最终 `status-agent.sh` 退出码为 `0`，关键结果如下：

```text
CURRENT_RELEASE_SHA=5e37de04866240772a7addfd8a182b190bb216e7
RUNNING_RELEASE_SHA=5e37de04866240772a7addfd8a182b190bb216e7
AGENT_RELEASE_SHA=5e37de04866240772a7addfd8a182b190bb216e7
EXPECTED_RELEASE_SHA=5e37de04866240772a7addfd8a182b190bb216e7
AGENT_PID_STATUS=running
CONTROL_LISTEN=loopback
STREAM_LISTEN=loopback
NODE_VERSION=v22.23.2
HEALTH_OK=true
NETEASE_CONFIGURED=false
ACTIVE_STREAM_COUNT=0
ACTIVE_PLAYBACK_PRESENT=false
LOG_SECRET_SCAN=pass
RELEASE_IDENTITY_CONSISTENT=true
STATUS_RESULT=PASS
```

日志扫描覆盖审查要求的凭据变量、凭据头/赋值、用户凭据标识、CSRF 标识、授权头、Bearer、令牌字段、完整 URL 和 Query 参数；命中时只输出失败状态，不输出匹配内容。最终扫描为 `pass`。

## 两个真实 release 的回滚结果

旧 release：`98227ae3b1491758d1c9ea0abdb0647de27c48a2`

| 步骤 | 结果 |
|---|---|
| 新 release deploy | 0；current 指向新 release |
| 新 release start | 0 |
| 新 release status | 0；身份一致、health/loopback/零播放状态通过 |
| 停止新 release | 0；`AGENT_STOPPED` |
| current 切换到旧 release | 0 |
| 旧 release start | 0；兼容路径写入旧 SHA 的 `agent.release` |
| 旧 release status | 0；身份一致、health/loopback/零播放状态通过 |
| 停止旧 release | 0；`AGENT_STOPPED` |
| current 恢复新 release | 0 |
| 新 release 再次 start/status | 0；最终状态 PASS |

整个回滚过程中没有停止、重启或修改 Roon，没有读取 Roon 数据库或音乐库。

## 安全与范围检查

- 未请求、记录或输出密码、SSH 私钥、内部 endpoint、真实设备名称、持久化配置内容或账号信息；
- 未调用 Provider、未播放歌曲、未执行播放 POST、未进行 Roon 配对或 Zone 测试；
- 控制端口和流端口最终均只监听 loopback；未开放 LAN、未转发流端口、未修改防火墙；
- 未创建环境文件，未配置 Provider 凭据或访问令牌；
- 未安装 Docker、FFmpeg、全局 npm 包、VS Code、Codex 或 Electron 开发环境；
- 未创建 PR、未合并、未 force-push、未修改默认分支。

## 最终发布状态

修复分支应包含上述修复 commit 和本报告提交，并已推送到远端供 Owner / 架构审查。当前远程运行 release 为：

`5e37de04866240772a7addfd8a182b190bb216e7`

TASK-002：**NO**。完成报告后停止，等待 Owner 决定下一步。
