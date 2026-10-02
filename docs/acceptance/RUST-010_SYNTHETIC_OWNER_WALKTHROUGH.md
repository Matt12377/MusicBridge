# RUST-010 合成人工验收操作手册

本入口用于在可见的原 Music Bridge 窗口中人工检查收藏界面，以及 Node 单独写库、Rust 只读撤回和显式刷新。每次启动都会生成全新的外置合成资料，默认使用 `node100`，会话最长 30 分钟。它是隔离的开发验收入口，尚未成为安装、签名或发布应用。

机器收据始终写 `ownerAcceptance: NOT_RUN`。自动 smoke、窗口启动成功和自然退出，都不能替代 Owner 在本聊天中的明确验收反馈。

## 启动前确认

- 外置 LifeWeave 卷已挂载、可写；本期源码工作树是 `/Volumes/LifeWeave/VSCode/MusicBridge/worktree/rust-core-010`，分支是 `codex/rust-core-010-synthetic-owner-session`，任务基线为 `5fc369a46b37fec4ad50ebb909aa1f2c4bc09d09`。
- 使用本期交付的启动入口及匹配的 manifest。启动器先检查新 driver、既有组件源码和产物、固定 Rust 二进制及现有 Electron 的身份，再生成资料和启动窗口。拒绝时保留诊断，不通过安装、下载或改用系统 Electron 绕开检查。
- 本期运行资料和证据父目录是 `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-010-9ytao7v6`。每次生成独立 sessionRoot，再生成名称以 `musicbridge-ui-e2e-` 开头的 profile；不能传入既有 profile，也不能复用上一次的合成库。
- 只检查手册列出的收藏控件与合成策略表单。不要输入真实账号或凭据、连接 Roon/远程 Core、播放或录音、导入真实文件、选择真实照片、制作或导出 PDF、迁移用户资料。这些能力没有进入本期人工验收范围。

## 启动入口与模式

本期启动器的冻结交付位置如下；它的实际执行验证与产物 SHA 以最终结果报告为准，本手册本身不声明已完成启动验证。在终端中运行，默认开启 `node100`：

```bash
'/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-010-9ytao7v6/human-gate-06/start-synthetic-owner.command'
```

需要检查可选 Rust 时，明确选择模式并启动全新会话，例如：

```bash
'/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-010-9ytao7v6/human-gate-06/start-synthetic-owner.command' --mode=rust100
```

另外两个可选模式分别使用 `--mode=rust2000` 和 `--mode=rust5000`。启动器绑定 `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-010-9ytao7v6/human-gate-06/driver-manifest.json`，会话父目录为同一 Gate 下的 `owner-sessions`，并固定 Node22、现有 tsx loader 与外置 tmp/cache。启动器不能任意替换 manifest 或 session-parent。不要直接运行旧 RUST-009 wrapper 来替代本入口。

| 模式 | 合成型号数量 | 收藏只读路径 | 选择规则 |
| --- | ---: | --- | --- |
| `node100` | 100 | 默认 Node | 省略 `--mode` 时使用；不创建 Rust，也不导出 Rust 快照 |
| `rust100` | 100 | 可选 Rust | 启动新会话时明确选择 |
| `rust2000` | 2000 | 可选 Rust，默认快照预算 | 启动新会话时明确选择 |
| `rust5000` | 5000 | 可选 Rust，固定大快照预算 | 启动新会话时明确选择 |

模式在同一会话中固定，不能通过环境变量、页面控件或终端指令切换。想比较另一种模式，先让当前会话自然退出，再使用新会话和全新 profile 启动。`refresh` 不改变模式或规模。

窗口标题必须始终明确显示“合成人工验收”。窗口内容是生产 Renderer、原 preload 和原控件，库中照片及目录均为合成资料；示例内容不是本人的收藏或真实账号状态。

本期可信 driver 在显示窗口之前冻结范围外 IPC 与原生文件选择能力，保留原按钮并明确拒绝范围外操作。托盘的上一首、下一首、停止仍走原 Main，背后固定使用 `CORE_TEST_MODE` 的合成播放状态；这三个托盘动作未列入本期人工验收，不能据此声称全部播放入口已阻断、真实音频已验证或完整产品已经验收。

主页音乐库等范围外请求可能显示合成范围限制提示。本轮从“实物收藏”开始检查；收藏读取、策略保存或可信刷新出现错误时，应按具体控件反馈，不能用范围限制解释掉本期目标内的问题。

## 确认已就绪

等终端给出运行就绪结果后，在同一终端单独输入：

```text
status
```

运行就绪要求窗口实际可见、原 `musicbridge` 页面已加载、Node Owner/Core 已准备，原 1500ms 后台 worker 至少完成两次公开空领取；Rust 模式还必须具有完整的准备和启动 ACK，以及正确的 profile/scope。默认 Node 没有 Rust controller 是正常状态。

`preflight`、`starting`、`ready`、`closing`、`closed` 和 `failed` 表示不同阶段。`ready` 只证明本会话已具备交互条件，尚未有完整退出证据，不能记为最终通过。若窗口看不到、标题标识消失、数量与模式不符或终端报错，停止本轮操作，保留 session 路径与错误反馈。

## 人工查看原收藏控件

1. 在侧栏进入“实物收藏”，选择空白磁带视图，确认型号数量与启动模式一致。
2. 使用“下一页”和“上一页”，在搜索框“搜索品牌、型号、版次…”输入合成品牌或型号，检查筛选和“清除”；检查状态、年代等现有筛选项。
3. 在“磁带墙”和“我的库存”之间切换。打开首个合成型号，在详情内查看“我的库存”的分页和“资料照片”；这些照片是本期生成的合成小图。
4. 返回收藏，进入“完成度与求购”，选择“参考书籍”和“目录修订”，查看求购清单、求购历史、完成度快照历史以及旧目录快照。
5. 打开“参考目录与版次”，查看来源、历史快照、版次，并用原有前一/后一快照选择器进行只读比较。

上述点击必须由 Owner 完成。本期自动 smoke 只覆盖其报告列明的动作；不能从一次 smoke 推定所有页面、全部数量或人工操作已经验收。

## 合成写入、Node 回退与显式刷新

在首个合成型号详情中展开“收藏保护设置”，选择“收藏策略”为“仅收藏，不用于录音”，把“最低未开封保留数量”设为 `1`，点击“保存保护设置”。这是原表单经原 durable outbox 的合成写入，写库仍由 Node 独占。

保存后再次执行 `status`。在 Rust 模式中，写入会撤回旧 Rust 快照，路由进入 `stale`，随后收藏读取回退到 Node；这属于预期行为。返回列表翻页，再进入详情确认新策略保留。默认 `node100` 一直使用 Node，不需要 Rust 撤回。

需要恢复 Rust 只读时，在终端单独输入：

```text
refresh
```

每条 `refresh` 仅执行一次可信显式刷新，没有自动重试或重放。Rust 刷新完成后执行 `status`，确认新 scope/generation 以及回到 `rust`，再通过原收藏控件读取资料。默认 `node100` 没有 Rust controller，因此 `refresh` 明确拒绝为 `NOT_READY`，不会创建 Rust 或导出快照；这不代表 Node 会话未就绪。Rust 刷新失败时保留错误，不连续反复敲指令代替诊断。

终端仅接受精确的 `status`、`refresh`、`quit`；每条操作串行执行。它没有 `accept`、模式切换、任意 IPC、导入或写数据指令。

## 自然退出与完整证据

完成后，在启动会话的终端输入：

```text
quit
```

也可通过 `Music Bridge for Roon` 应用菜单的退出项（`⌘Q`）或托盘 `Quit Music Bridge` 退出，或等待默认 30 分钟会话到期。这些路径均须通过原 `app.quit()` 进入 Main 的 `before-quit` 收口：Owner 关闭并自然退出、Core 退出 0、每个 Rust 子进程收到关闭 ACK 后自然退出 0、Electron 退出 0 且信号为空，最终 `forcedCleanup=false`。

macOS 窗口左上角红色关闭按钮只隐藏窗口，后台会话仍可能继续。隐藏窗口不是 `closed`，不能作为验收结束。关掉终端、强制退出或杀进程同样不能作为自然收口证据。正常退出后保留全部 session profile、日志和收据，不手动清理。

最终收据必须区分运行就绪与 `closed` 的完整验证。退出不完整、超时或被中断时，应记录失败和仍未关闭的资源；不得用强制清理后的状态补写自然退出通过。

## Owner 反馈

请在本聊天说明实际模式、是否看见带合成标识的窗口、人工查看了哪些控件、策略保存与回退/刷新是否符合预期，以及使用哪种方式退出。若发现问题，附 session 路径、控件名称和复现步骤即可，不提供凭据或真实用户资料。

这份反馈仅用于本期合成界面与只读路由验收。真实 Roon/Provider/账号/音频/录音、设备/PDF、用户库迁移、系统钥匙串、安装签名及发布仍须另立证据；既有 MBR-004、Gate B P4/P5 等 carryover 保留。
