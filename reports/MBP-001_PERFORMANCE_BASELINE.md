# MBP-001 性能基线与跨层诊断结果

- 基线：`e97f9e578beb7c5329d0c59e232b0da568e2f6fa`；分支：`codex/mbp-001-performance-baseline`。
- 实现提交：`d89c3ea3743a81e9afe818d6869dfc02ecb797cf`。本报告在独立提交中保存；报告身份用 `git log -1 --format=%H -- reports/MBP-001_PERFORMANCE_BASELINE.md` 解析。
- 本任务的软件自动 Gate 通过，进度 1/11。真实 Mac/Roon、音频、系统钥匙串、设备录音、Owner 验收、main 合并、App 替换与发布均未执行。

## 实现范围

诊断默认关闭，显式 `MUSIC_BRIDGE_PERFORMANCE_TRACE=1` 开启。纯合同 Trace 记录器固定容量 512、最多 128 个在途 span；记录随机身份、白名单阶段/计数和进程自身单调时钟。不保存业务 payload、SQL、路径、账号、曲目、Zone、URL 或凭据；导出再次复制白名单字段，并保留原脱敏与 0600 权限。

已接通实际 Preload/Main/Core 请求、Controller 现有排队、Roon Browse 回调、网易云 API、收藏数据库语句、Core 事件抽样和 Core 事件循环监测。实际播放入口可关联 UI 交互；其他操作保留请求级 Trace，未宣称全部按钮都有 click 埋点。SQL 覆盖收藏数据库的 get/all/run/exec，不代表所有数据库已覆盖。Renderer 下一帧仅是 IPC 返回后的标记，不代表用户已看见数据或声音开始。

诊断关闭不创建采样 timer/histogram、不序列化进度负载；启用时 Core 每 40 个事件抽样估计 JSON 大小。默认 Core 请求超时仍只是本地超时：本任务不改成远端取消。跨进程不直接相减单调时钟；JSON 字节估计不代表 Electron structured-clone 线上字节。

故障隔离行为检查覆盖诊断时钟与回调抛错，保持原业务返回值、异常身份和资源释放；Browse 本地超时与 SDK 真正返回分别打点，迟到返回保留标记。Preload 将纯合同代码内联，生产包仍只 require Electron。

## 新鲜验证

Node 22.23.2、Corepack pnpm 10.17.1；所有日志、临时库、结果与缓存位于已挂载 LifeWeave 外置卷。全量 verify 使用外置 Node 包装器，仅固定 Node test worker 并发为 1，测试文件范围、断言和已有 skip 条件不变。

| 检查 | 结果 |
| --- | --- |
| 固定实现全量 `pnpm verify` 第五轮 | exit 0；类型、全部测试、生产构建与沙盒 Preload 门禁通过 |
| 合同测试 | 222 pass、0 fail、0 skip |
| Core 测试 | 1581 pass、0 fail、2 原有条件 skip |
| 桌面测试 | 873 pass、0 fail、0 skip |
| 原 Electron 启动/崩溃/凭据恢复 Gate | 4 pass、exit 0，mock 钥匙串；开发/生产启动、崩溃、同进程和双进程恢复 |
| 编译后的生产 Electron Trace | exit 0；隔离合成 Core、mock 钥匙串，三层关联同一随机 Trace，权限/脱敏通过 |
| control-plane / boundaries / cycles | 固定实现分别 exit 0 |
| 固定实现合成结构基线 | 9 场景、exit 0，dirtyImplementation=false，源码运行期间稳定 |
| diff-check | exit 0 |

完整 verify 第五轮源码指纹为 `cdccaf5c766c664fa16cda6d07c6fac6d5073e73c857a11f6c11304289f4c2b5`，793 个源/测试/脚本/打包配置文件；运行结束与固定快照相同。Electron 两组检查在提交前已通过，其源码与实现仅末尾空行不同；第五轮正式构建验证固定提交。未将它们冒称真实 Provider、Roon 或听感。

原始日志与 SHA-256 台账：`/Volumes/LifeWeave/Developer/CommandLine/tmp/mbp-001-integration-9T8mM2/evidence-fixed.json`。固定基线原产物：`/Volumes/LifeWeave/Developer/CommandLine/tmp/mbp-001-fixed-baseline-KtpHRs/baseline.json`，其副本见 `reports/MBP-001_BASELINE.json`。早先运行与失败日志保留，没有覆盖。

## 失败归因与修正

- 第一轮退出 2：新增 Supervisor 测试错用 FakePort.posted，实际夹具是 sent；修正测试字段。
- 第二轮退出 1：Core 全部通过；桌面 5 fail。4 项源代码提取测试仍识别旧 ipcMain.handle / 直接 invoke / finally 形式；改为识别诊断包装后的同一业务函数，保留原行为断言。sidebar-controls 的旧 NavRow 正则在基线 e97 已无法识别收藏展开组；当前 Sidebar 字节与基线一致。补实际 Vue 挂载展开与两个子入口导航检查，保留顺序和当前项保护；归因产物 sidebar-baseline-attribution.json 保留。
- 第三轮退出 2：新增迟到 Browse 回调测试的回调类型过宽；对齐 SDK 的 string|false 类型。
- 第四轮退出 1：所有测试通过；生产沙盒门禁拒绝新增 contracts 外部 require。这是本批打包回归；改为 Preload 内联纯合同代码，未放宽 require 约束。重建 exit 0 后，第五轮原范围完整 verify exit 0。
- 诊断循环依赖在早期静态检查中暴露：将原 IPC 名称/类型按原内容迁到无依赖叶模块，保留原 re-export/API；最终 cycles 通过。
- 外置 Electron smoke 第一轮测试目录名不符合既有隔离规则，未获得有效启动结果；改用已允许的 musicbridge-ui-e2e 前缀并设置启动期限后通过。未改生产目录校验。

## 优化前结构基线

- 250 条上下文、首屏 24 条：实际 Renderer 尚须读完 10 个剩余页才派发播放。
- 实际专辑/艺人/歌单首屏各请求 24 条，Fake SDK 各读取 250 条再返回。
- 50 / 500 / 5000 条队列的两次 tick 共 3 个事件，JSON 估计负载合计 25,662 / 253,371 / 2,570,880 字节。
- 多碟与重复出现的既有身份、顺序语义保存；同引用合并与不同引用重复分别记录。

这些是调用生产模块的合成结构证据，不是实际设备毫秒数据，不表明已经完成性能优化。

## Carryover 与下一基线

播放旧 terminal、停止失败身份、原生同名曲确认、旧分页回填和键盘冒泡仍待 MBR-001；取消与会话超时生命期留给 MBP-002。录音 Gate B 未认证仍保持阻断，其他历史 carryover 未升级。

工作区仅保留任务外未跟踪目录 apps/desktop/test-results/、worktree/。下一分支 `codex/mbr-001-playback-correctness` 从本报告最终 HEAD 创建；此接续由本轮连续实施授权覆盖。远端 push 与 CI 独立核验，报告提交时尚未据远端结果放行。
