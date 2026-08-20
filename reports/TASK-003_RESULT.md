# TASK-003 结果报告

## 结论

**BLOCKED — Provider 与 Roon 已就绪，两首测试歌曲分别被 HTTPS 安全策略和完整曲目授权策略拒绝，等待替代歌曲 ID。**

合法 Provider 配置、TASK-003 release 部署、Roon ready/Zone 选择和真实 Provider 请求均已完成。测试歌曲 `191248` 的 `song_detail` 成功，但 `song_url_v1` 在 `exhigh` 与 `standard` 下均返回非 HTTPS 上游地址，Bridge 按既定安全边界拒绝。替代歌曲 `191174` 在两个音质等级下均只返回试听片段，Bridge 以 `TRACK_PREVIEW_ONLY` 拒绝，未将试听冒充完整曲目。两次测试都未创建 Roon Audio Input Session，真实 Zone 尚未出声，因此不能标记 PASS，也不得进入 TASK-004。

## 任务边界

- 当前分支：`codex/task-003-standard-exhigh-playback`
- 基线：TASK-002 报告提交 `a70350d6ab61dc6d59868da202423f85dbb1b159`
- 初始 TASK-003 实现提交：`1da0772590d5f5263f8a9b49cee2356cc93ad8c1`
- Core Provider 配置通道提交：`cd3db03e5f31c1cadfa41669be6b803ccafa3fd5`
- 当前运行实现提交：`289dbdf329ddeed442081c6923c63540dbfde657`
- 未修改产品架构、端口、loopback-only 规则、Provider 接口、Stream Gateway 行为或依赖版本。
- 未开始 TASK-004、TASK-005 或 TASK-010。

## 实现内容

1. `BridgeController.stop()` 在自身没有活动播放和流 token 时直接返回当前状态，避免重复触碰已经清理的 Roon 会话。
2. 增加 Controller 幂等停止测试：第一次停止清理流 token，第二次停止不再调用底层 Roon，状态保持为空。
3. 原有 Controller 成功、Roon 启动失败、播放期间终止、启动阶段终止的 token/state 清理测试继续通过。

## 环境与自动化 Gate

在新登录 zsh、Node.js `v22.23.2`、npm `10.9.8` 下执行：

| 检查 | 结果 |
|---|---:|
| `npm run doctor` | 退出码 0；本地合法 Provider 配置缺失，doctor 明确提示播放不可用 |
| `npm run typecheck` | 退出码 0 |
| `npm test` | 退出码 0，29/29 通过 |
| `npm run build` | 退出码 0 |
| `npm run verify` | 退出码 0 |
| 控制端口检查 | 通过，未占用 |
| 流端口检查 | 通过，未占用 |
| `git diff --check` | 通过 |

上表记录初始自动化阶段；后续部署当前 TASK-003 release 时按既定部署流程执行了 `npm ci`、`npm run verify` 和 `npm run build`。真实 Provider Gate 已执行，但所有工具输出均经过脱敏，不含账号数据、凭据、完整上游地址或临时 stream token。

## 真实 Gate 状态

| Gate | 状态 | 说明 |
|---|---|---|
| `191248` 元数据与 standard/exhigh 流解析 | BLOCKED | 元数据存在；两个等级均返回非 HTTPS 上游地址，Bridge 返回 `UNSAFE_UPSTREAM` |
| `191174` standard/exhigh 流解析 | BLOCKED | 两个等级均返回试听片段，Bridge 返回 `TRACK_PREVIEW_ONLY` |
| XEAPI 公钥 bootstrap | 通过 | 使用既有受控凭据中的设备标识注册；不执行匿名注册、随机 IP、代理或解灰 |
| 临时 token 注册与清理 | 自动化通过；实机未创建 | 两类拒绝均发生在注册 token 前，现场 `activeStreamCount=0` |
| Roon Audio Input Session | 未创建 | 当前 release 已部署，但两首歌曲都在 Provider 完整性/安全 Gate 终止 |
| 真实 Zone 出声 | 未执行 | 需要另一个可返回 HTTPS 完整授权流的测试歌曲 ID |
| Roon 元数据显示 | 未执行 | 同上 |
| stop 幂等 | 自动化通过 | 新增测试已通过 |

## 阻塞原因与恢复条件

Core Mac 的 Provider 凭据状态为 `configured`，Agent health 为 `NETEASE_CONFIGURED=true`，Roon 状态为 ready 且已选择 Zone。当前硬阻塞是已提供的两个测试 ID 都没有可用于完整播放的安全流：`191248` 在两个等级下均为非 HTTPS 上游，`191174` 在两个等级下均为试听片段。按照安全规则不得改写为 HTTPS、放宽为 HTTP、把试听冒充完整曲目，或启用解灰/代理替代源。

恢复时 Owner 只需提供另一首允许测试歌曲的纯数字 ID，不要发送配置内容或完整歌曲地址。随后将继续验证 standard/exhigh、在已选 Zone 完整播放、执行 stop 清理和现场日志安全扫描，并更新本报告。

## 安全与范围确认

- 受控启动与诊断进程只在 Core Mac 内静默读取凭据文件；未在终端、日志、Git 或报告中输出账号凭据、Cookie、Token、设备标识、公钥内容、完整播放地址或配置文件内容。
- 已执行两首歌曲的真实 Provider 请求和本地 loopback 播放 POST；请求分别在 HTTPS 安全 Gate 与试听完整性 Gate 被拒绝，未创建 Roon Session、未播放音频。
- 未开放 LAN 监听，未修改防火墙，未读取 Roon 数据库或音乐库。
- 未创建 PR、未合并、未开始 TASK-004。

## Core Mac Provider 配置通道修复

本轮只在 TASK-003 内增加 POC 运行时凭据通道，未改变正式 safeStorage 架构，也未修改 Provider 代码、端口、loopback-only 规则或解灰/代理/随机 IP 安全规则。

### Owner 临时交互规则变更

Owner 已明确授权将本地 Provider 凭据提示从隐藏输入改为明文输入，以排查终端粘贴无回显造成的误判。当前提示要求在开发 Mac 本地终端使用 `⌘V` 粘贴后按 Return；Shell 读取仍不接受命令参数，因此不会进入 Shell 历史、Git、报告或 Agent 日志。

普通 Bash 只能接收终端字符流，无法可靠证明字符来自键盘还是 `⌘V`，因此“仅允许 `⌘V`”是交互约定而非程序可强制验证的来源。明文模式可能被终端录屏、终端审计或共享屏幕捕获，Owner 应仅在受控本地终端使用，并在测试后刷新凭据。

后续复查确认普通 `read -r` 仍受 macOS TTY canonical 单行缓冲限制：当前开发终端的 `MAX_CANON` 为 1024，而配置通道允许最多 8192 字节。长文本填满行缓冲后，Return 无法提交；同时普通 `read` 不提供方向键编辑。脚本现改为 `read -r -e`，由 Bash Readline 接管动态输入缓冲和光标编辑。6000 字节脱敏输入提交及方向键插入回归均已通过。

新增或修改：

- `scripts/deploy/configure-provider.sh`
- `scripts/deploy/clear-provider.sh`
- `scripts/deploy/start-agent.sh`
- `scripts/deploy/status-agent.sh`

安全行为：

1. `configure-provider.sh` 只在交互式终端通过明文 `read -r -e` 读取授权值，不接受命令参数；通过严格 SSH 的 stdin 传输，不写入 Shell 历史、Git、报告或 Agent 日志。明文回显属于 Owner 临时授权的交互例外。
2. Core Mac 端只写入 `data/netease.cookie`；临时普通文件经非空、最大长度、控制字符、普通文件、非符号链接和 `600` 权限校验后原子 rename。测试证明临时文件不会残留。
3. `start-agent.sh` 首先清除继承的 `NETEASE_COOKIE`。只有在凭据文件满足严格校验时才安静读取，并通过子进程环境传递给 Agent，不放入 argv、不写入 Agent 日志。
4. `start-agent.sh` 在 Provider 已配置时检查 XEAPI 公钥；缺失时静默使用现有设备标识注册，以 `600` 权限临时文件原子写入运行时临时目录。不得执行匿名注册、随机 IP、代理或解灰，且不输出公钥或设备标识。
5. `status-agent.sh` 默认只输出 `PROVIDER_CREDENTIAL_STATUS=configured|missing|invalid`，不输出内容、长度、摘要或哈希；显式 `--runtime` 模式额外验证 `XEAPI_PUBLIC_KEY_STATUS=ready`，Provider 已配置但公钥不就绪时必须 FAIL。
6. `clear-provider.sh` 先调用安全停止流程，再删除目标文件并确认路径不存在；不会自动启动 Agent 或播放。
7. 日志扫描覆盖 `NETEASE_COOKIE`、`Cookie`、`MUSIC_U`、`__csrf`、`Authorization`、`Bearer`、`token`、完整 HTTP(S) URL、Query 及查询参数模式；命中只返回失败状态，不打印匹配内容。

本轮脚本验证：

| 检查 | 结果 |
|---|---:|
| 四个新增/修改脚本 `bash -n` | 退出码 0 |
| `stop-agent.sh` `bash -n` 回归检查 | 退出码 0 |
| 伪 SSH、临时 HOME、明文测试输入 `111` | 配置、文件属性、状态和清理验证通过；终端回显并在 Return 后完成 |
| 伪终端 6000 字节脱敏长输入 | `read -r` 可复现 Return 卡住；`read -r -e` 可完整提交 |
| Readline 方向键编辑 | 输入 `abc`、左移并插入后得到预期 `abXc` |
| `status-agent.sh` 默认输出 | 仅 Provider 状态行 |
| `status-agent.sh --runtime` 兼容模式 | release/health 汇总与 XEAPI 公钥状态均通过 |
| 真实 Core Mac 配置 | 当前状态检查为 `PROVIDER_CREDENTIAL_STATUS=configured`；未读取或输出文件内容 |
| TASK-003 运行实现 release | `289dbdf329ddeed442081c6923c63540dbfde657`；bundle SHA-256 `cca508bbf816ac57782fad671fb5ba29a8b3220f969a9e87edf6a25b165e377a`；临时产物清理 PASS |
| 最终远程 runtime 状态 | expected/current/running release 一致；Agent 进程存在；Node.js `v22.23.2`；XEAPI 公钥 ready；38501/38502 仅 loopback；health 通过；`activeStreamCount=0`；无 active playback；日志秘密扫描 PASS |
| `191248` 真实 `exhigh` / `standard` 请求 | 均返回 `UNSAFE_UPSTREAM`；无 token、无 active playback、无 Roon Session |
| `191174` 真实 `exhigh` / `standard` 请求 | 均返回 `TRACK_PREVIEW_ONLY`；无 token、无 active playback、无 Roon Session |

## 当前 Gate 与后续动作

Provider 配置、当前 release 部署、XEAPI bootstrap 和 runtime Gate 均已完成。TASK-003 仍为 **BLOCKED**：第一首测试歌曲在两个等级下触发非 HTTPS 安全拒绝，第二首在两个等级下只获得试听片段。Owner 只需提供另一个纯数字歌曲 ID；不得把授权值、账号信息或完整歌曲地址发送到聊天、报告、Git 或命令参数中。

在新的测试歌曲完成真实 Zone 出声、Roon 元数据、完整播放或精确终止、stop/token 清理及日志扫描前，TASK-004 不得开始。
