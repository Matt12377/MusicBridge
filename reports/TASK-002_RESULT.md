# TASK-002 — Roon 发现、配对与 Zone Gate 结果

## 最终结论

**PASS**。

TASK-002 已完成 Fake Roon 自动测试、真实 Roon Extension Enable、Zone 选择、Agent 重启和 Zone 持久化复查。未播放歌曲，未调用 Provider，未开始 TASK-003。

## 基线、分支与提交

| 项目 | 结果 |
|---|---|
| Base SHA | `cf0af470d870a736eeeba198825040b1ec0702ac` |
| 分支 | `codex/task-002-roon-pairing-gate` |
| 实现 SHA | `7522a96d4487b90db979b613a08dfe34aeabdb88` |
| 实现 commit | `test: verify Roon pairing and zone persistence` |
| 工作区 | 实现 commit 后干净；运行证据位于 gitignored 路径 |
| 预期报告 commit | `docs: record TASK-002 verification` |

实现 release 使用完整实现 SHA；没有使用报告 commit 或其他工作树状态作为运行版本身份。

## 修改文件

实现 commit 修改：

- `src/roon/adapter.ts`
- `src/roon/sdk.ts`
- `test/roon-adapter.test.ts`

本报告另由允许范围内的 `reports/TASK-002_RESULT.md` 记录。未修改 `src/roon/types.ts`、`src/vendor/roon-modules.d.ts`、`src/main.ts`、`src/control/server.ts`、`package.json`、`package-lock.json`、产品 Provider、Stream Gateway、部署脚本、端口或 Extension ID。

## 实现摘要

- 增加最小 `RoonSdk` 注入边界；生产路径仍使用官方已固定版本的 Roon 模块。
- Fake 测试可注入 API、Settings、Status、Transport、Audio Input 和内存配置存储，不启动真实发现，不触发真实 Audio Input。
- Settings 保存的 output ID 通过 Roon 配置 API 持久化。
- 重建 Adapter 后读取同一配置，等 Zone 订阅返回即可恢复 `ready`、Zone ID 和 Zone 名称。
- Zone changed、Zone removed、Core unpaired 都会更新公开状态并清理失效选择。
- 未配对和未选 Zone 时分别返回明确公开错误，且不会调用 `begin_session`。
- shutdown 会停止发现、断开连接并清空运行状态。
- 现有实现中的 Extension ID、端口、安全绑定和播放行为边界保持不变。

## Fake Roon 自动测试

原有 16 个测试全部保留；TASK-002 新增 12 个测试，总计 **28/28 通过**。

| # | 验收行为 | 结果 |
|---:|---|---|
| 1 | start 调用 `start_discovery` 并进入 discovering | PASS |
| 2 | Core paired、无 Zone 时为 paired | PASS |
| 3 | 已保存 output、收到 zones 后进入 ready | PASS |
| 4 | Settings 保存 output 调用配置保存并持久化 | PASS |
| 5 | 重建 Adapter 后恢复同一 Zone | PASS |
| 6 | zones_changed 更新 selectedZoneName | PASS |
| 7 | zones_removed 当前 Zone 后回到 paired | PASS |
| 8 | Core unpaired 后回到 discovering 并清空 Zone | PASS |
| 9 | 未配对 play 返回 `ROON_NOT_PAIRED` | PASS |
| 10 | 已配对但未选 Zone 返回 `ROON_ZONE_NOT_SELECTED` | PASS |
| 11 | 两种播放前置失败都不调用 `begin_session` | PASS |
| 12 | shutdown 调用 stop discovery、disconnect all 并清空状态 | PASS |

测试没有使用专用测试、跳过测试、私有字段访问、解释不充分的类型逃逸或真实音频地址。

## 开发机与 Core Mac 职责

- 开发机：源码、Fake 测试、typecheck、构建、bundle 生成和部署命令。
- `<CORE-A>`：仅运行脱敏 Agent 与 Roon Core 同机运行时；没有安装 VS Code、Codex 或完整开发环境。
- 两端 CPU 架构均为 `arm64`；生产依赖中原生 `.node` 模块数量为 `0`。

## 远程运行环境与 Release

远程环境已脱敏记录为：macOS `26.5.2`、`arm64`、用户级 Node.js `v22.23.2`。新登录 zsh 验证结果为 Node `v22.23.2`，路径来自用户级 nvm，默认 alias 为 22。

远程目录结构保持既定边界：

```text
~/Library/Application Support/MusicBridgeAgent/
├── releases/<implementation-sha>/
├── current
├── data/
└── logs/
```

bundle SHA-256：

`ddb946fd16d4954cb9790f64e5c870b28a37a2c32adafd20cc72e658be23e039`

bundle 仅包含：

- `dist`
- production `node_modules`
- `package.json`
- `package-lock.json`

bundle 不包含源码、测试、文档、任务、报告、Git 元数据、环境文件、音频或运行日志。bundle 构建使用 Node `v22.23.2`；开发机与 Core Mac 架构一致。

最终远程运行身份全部一致：

```text
expected/current/running/agent.release = 7522a96d4487b90db979b613a08dfe34aeabdb88
RELEASE_IDENTITY_CONSISTENT=true
```

`agent.release` 权限为 `600`。最终 `status-agent.sh` 返回 `STATUS_RESULT=PASS`。

## 真实 Roon Gate

Owner 已在 Roon 客户端完成 Extension Enable 并选择 Zone。以下报告只使用别名：Core 为 `<CORE-A>`，Zone 为 `<ZONE-A>`；真实名称没有写入本报告。

通过仅转发控制端口的 SSH 隧道检查了 health 和 state；流端口没有转发或暴露。Owner 操作后首次状态：

```text
health_ok=true
roon_status=ready
core_name=present-but-redacted
selected_zone_id_sha256=43db3ff97f5fb98bb8b6eaba08a7e74bcad36ec849240f500c2e23facbce655c
selected_zone_name_sha256=93d68f16290608ec888bdd9bd36d4fe7c841c5a310fe3e4416fb3f8acab087c8
neteaseConfigured=false
activeStreamCount=0
activePlayback_present=false
```

实际首次输出中的 Zone ID 哈希与上面的脱敏记录一致；真实 ID、真实名称和任何持久化配置内容未写入报告。

## 重启与持久化 Gate

验证序列：

1. 停止 implementation release，退出码 `0`。
2. 远程 `38501` 和 `38502` 均 free；PID 与 release 标识文件均已按 stop 流程清理。
3. 使用同一 implementation release 启动，退出码 `0`。
4. `status-agent.sh` 验证 expected/current/running/agent.release 一致，退出码 `0`。
5. 通过控制端口隧道再次读取 state，无需重复 Enable 或 Zone 选择，状态仍为 ready。
6. 再进行一次不播放的 stop/start 以形成清晰的 UI 前后证据，端口释放、启动和最终 status 均通过。

重启后状态：

```text
health_ok=true
roon_status=ready
selected_zone_id_sha256=43db3ff97f5fb98bb8b6eaba08a7e74bcad36ec849240f500c2e23facbce655c
selected_zone_name_sha256=93d68f16290608ec888bdd9bd36d4fe7c841c5a310fe3e4416fb3f8acab087c8
same_zone_identity_as_before=true
neteaseConfigured=false
activeStreamCount=0
activePlayback_present=false
```

## 运行证据

以下文件均位于 `reports/runtime/TASK-002/`，该目录已被 `.gitignore` 忽略，不进入 Git commit：

| 文件 | SHA-256 |
|---|---|
| `01-extension-enabled.png` | `babea5bb8ba9f8b6779809a708d13ea130bc44489b1bc47a2528a79a43eda0d5` |
| `02-zone-selected.png` | `07df73f2f5ccfb9a9a758aa6b89fe90cafd22be512fe87dde3b8d935575dc03f` |
| `03-zone-restored-after-restart.png` | `07df73f2f5ccfb9a9a758aa6b89fe90cafd22be512fe87dde3b8d935575dc03f` |
| `agent-log-redacted.txt` | `ced8fc2bfac54282bb9b30854b4f72b3ea1ebc0d9b6102928503c6dc386fb11d` |
| `state-before-restart.txt` | `380b1c278fdc55fa4156dc3653e5e5715ff05daca3681bc41e23f46b04f0b8fd` |
| `state-after-restart.txt` | `6820c6ef4d87efb014636096796c28b303657c03e0aed272aa544c3af747aaf6` |

两个 Zone UI 截图像素内容一致是预期的：第二张是在第二次无播放重启前保留的设置画面，第三张是在第二次重启后保存的同一设置画面；实际“恢复”由前后 state 的哈希和 ready 状态证明。截图不在报告中展开真实界面内容。

脱敏日志证据只保留秘密扫描结果和行数：`LOG_SECRET_SCAN=pass`，原始远程日志没有复制到 Git 或报告。

## 验证命令与退出码

| 命令/操作 | 退出码或结果 |
|---|---:|
| `bash -n` 五个部署脚本 | 0 |
| `npm ci`（bundle 构建阶段） | 0 |
| `npm ci --omit=dev --ignore-scripts`（staging production 依赖） | 0 |
| `npm run doctor`（最终本地复查） | 0 |
| `npm run typecheck` | 0 |
| `npm test` | 0，28/28 |
| `npm run build` | 0 |
| `npm run verify` | 0 |
| `git diff --check` | 0 |
| `deploy-agent.sh` | 0，`DEPLOY_RESULT=PASS` |
| staging/archive 清理 | `DEPLOY_TEMP_CLEANUP=PASS` |
| `start-agent.sh`（implementation release） | 0 |
| `status-agent.sh`（implementation release） | 0，`STATUS_RESULT=PASS` |
| 控制端口 SSH 隧道首次 state 检查 | 0，`SSH_TUNNEL_CONTROL_ONLY=PASS` |
| 停止 Agent、端口释放、同 release 重启 | 0，全部通过 |
| 控制端口 SSH 隧道重启后 state 检查 | 0，Zone 哈希一致 |
| 第二次无播放重启与最终 status | 0，`STATUS_RESULT=PASS` |
| 最终控制端口 state 检查 | 0，`FINAL_STATE_TUNNEL_CHECK=PASS` |
| SSH 隧道取消及本机端口清理 | 0 |

曾有一次本地 `npm run doctor` 在 SSH multiplexed 隧道仍占用本机控制端口时退出 `1`；使用精确的 SSH forward cancel 清理本次转发后再次执行，退出 `0`。最终本机 `38501`、`38502` 均空闲。

`npm run doctor` 的 Provider 配置提示保持未配置，这是本任务禁止填入凭据且不播放的预期状态；远程 Gate 同时验证 `neteaseConfigured=false`。

## 安全与范围检查

- 没有播放歌曲，没有执行播放 POST，没有调用网易云或其他 Provider。
- 没有读取、输出或提交持久化敏感配置内容。
- 没有开放 LAN 监听，没有绑定 `0.0.0.0`，没有修改防火墙。
- 没有转发流端口；SSH 隧道仅用于控制端口 state/health 检查。
- 没有修改产品架构、依赖声明、lockfile、进程模型、端口、安全边界或 Extension ID。
- 没有安装新依赖；bundle 阶段只使用既有 lockfile 构建。
- 没有创建环境文件，没有保存 Provider 凭据，没有提交运行日志或音频文件。
- `reports/runtime/TASK-002/` 已被忽略；源码、测试和报告外的工作区没有未授权差异。
- 没有创建 PR，没有合并，没有修改默认分支，没有 force-push。

## 发布状态与后续边界

本任务按要求使用两个本地 commit：实现 commit 和本报告 commit。报告 commit 完成后推送当前分支；不创建 PR、不合并。

**TASK-002：PASS**

**TASK-003：NO。** 在 Owner 明确放行前不得开始 TASK-003。
