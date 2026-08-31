# TASK-059：固定执行格式与 PCM 编译内核

## 身份与结论

- 基线：`71f08fc9dab8ea11625d2d282bfcc2ce593a6705`（TASK-058 最终状态锁定）。
- 分支：`codex/task-059-v3-execution-planning`。
- 实现：`693256466776f44a0cb214c261f935f6588bf203`。
- 报告提交：包含本文件的独立提交，精确 SHA 在下一状态锁定提交写入 `project/STATUS.json`。
- 结论：**本地自动验证通过；Core 编译内核可用，完整 V3 未完成。** 0 子代理；没有 push、main 集成、设备操作、真实账号或 Owner 验收。

## 实现

`ExecutionFormat` 显式携带采样率、声道/布局、内部精度、输出样本格式、SRC 实现/版本、dither、声道映射、backend/版本及 Profile 版本。配方独立绑定 Frozen M/L 内容与 Planned Timeline，Prepared 另绑定 PREP 和 RenderTimeline Hash。无隐式设备、来源或格式替换；所有回执 `formalReady=false`。

`planDirectExecution` 重核版本和源绑定，从真实源帧构建逐面执行清单；Lead-in/Gap/Tail 使用整数有理数计算。`compileDirectPcm` 支持同格式整数 PCM 16/24/32 bit 的单/双声道字节保持拼接，原文件首尾静音不裁剪，默认间隔精确为 Fs×5。DAT 为单 Program；空 B 只有零帧配方，没有伪造文件。

`planPreparedExecution` 核对实际 Marker、Conformance 与原件谱系；`verifyPreparedPcm` 校验并引用完整原始 Render，不复制、不再插入 Gap。格式变化明确要求后续独立 Derivative，不覆盖原件。

输入只读完整 Hash，读取前后检查身份和授权。全部格式预检在写目标之前；实际复制再次校验。目标句柄由上层排他创建，必须为空普通文件且单链接。支持短写、取消和十五分钟循环期限；fsync 后回读完整 Hash、PCM Hash、帧数与规格。错误收敛为有界代码；无自动清理或公开路径。

## 最终验证

环境实测 Node `22.23.2`、pnpm `10.17.1`。最终 Gate 顺序执行，九个代码/测试路径的 SHA-256 在每个 Gate 后均核对未变。

| Gate | 实际结果 | 退出码 |
|---|---|---|
| 根 `verify` | typecheck / test / build 全部通过 | 0 |
| Contracts | 48/48 | 0 |
| Core | 603/603 | 0 |
| Desktop | 169/169 | 0 |
| 聚焦编译/版本测试 | 20/20 | 0 |
| Security | 22/22 | 0 |
| Electron | 4/4 | 0 |
| Playwright | 47/47，约 5.2 分钟，无失败重试 | 0 |
| control-plane / boundaries / cycles | PASS，135 个源文件 | 0 |
| `git diff --check` | 通过 | 0 |

现有控制面脚本仍核对 WAVE-3；另行核对 WAVE-5 任务、分支、基线、允许路径和三提交身份。不以旧控制面 PASS 替代本任务身份。

### 实际文件证据

最终合成 WAV：96 kHz、Stereo、16 bit，三段源各 97 帧，两个 Gap 各 **480000 帧且全部数字零**。总帧数 **960291**，文件 **3841208 字节**。独立 Python 标准库 `wave` 逐段读取最终文件并与原件 PCM 比较，源字节及首尾静音保持。

- 文件 SHA-256：`c60cc4993e67414d15ec04f3313238b2a6ba783beda8bdc404cf6cb07601ab84`。
- PCM SHA-256：`0b770442b5466612f2ceb186b455791afddc1a22aead636166f21fd5a7e21224`。
- 同一配方再次编译，字节、Hash 与回执完全相同。
- 另外覆盖 44.1/48 kHz、16/24/32 bit、mono/stereo、奇数填充、元数据块、Lead-in/Tail、零 Gap、DAT 和空 B。

隔离源/最终 WAV/回执、Python 复核 JSON、最终 Gate 日志、候选指纹和 Playwright 产物保存在 `reports/runtime/task-059-final-7awkal62`，均被 Git 忽略；最终音频证据使用 `pcm-final/`，最终 UI 回归使用 `test-results-final/`。先前检查点保留，不与最终证据混用。

### 失败与修复记录

最初 `isExecutionFormat` 缺失是合同接线 RED，不称为音频行为 RED。真实文件测试随后复现并修正：

1. 输出回读期间撤销 Root 仍返回成功；最终授权复核后转绿。
2. 合法 RIFF 子块顺序被回执误拒绝；改为接受实际 data offset 后转绿。
3. ASCII 解码忽略高位而接受错误 RIFF 魔数；改为逐字节保真标识比较后转绿。

三项均有修复前失败日志与修复后通过结果。FileHandle 重载/可空字节的 TypeScript 夹具错误单独记录，不算产品行为 RED。磁盘满、短写、回读篡改、取消/撤权和时钟超时由合成文件及受控注入覆盖，不宣称是真实设备故障实测。

## 审查与证据边界

先 SPEC、后 QUALITY，自查两轮修正；不是独立审查。核对范围、版本/Hash、帧清单、Prepared 不二次插入间隔、只读来源、排他目标约定、错误收敛和资源上限。无桌面生产/UI 修改；Playwright 是既有 UI 回归，不证明新编译内核已接入 Renderer，也不作新视觉或听感验收声明。

这是 **Core 内核交付**，尚未接入数据库编译任务、目标授权/owned staging/资产发布、桌面编译入口或 Archive Store。回执不是可由正式 RecordingPlan 引用的已发布资产；backend/Profile 字段是显式身份描述，未证明对应设备就绪或已认证。

暂未实现 FLAC/AIFF/DSD 解码、SRC、声道/位深转换、浮点、RF64、扩展 WAV 和 Execution Derivative，明确拒绝，后续范围保留。原件内容/mtime/ctime 不改，不承诺 atime 不变；Node 检查不是同用户恶意并发原子沙箱；循环期限不是阻塞系统调用的硬实时承诺。

## 下一阶段与外部门槛

下一任务从本报告后的**最终状态锁定 HEAD**建立独立工作区，继续 Profile/Overrides 与持久化编译任务、发布/恢复、桌面入口，再扩展转换与 Derivative。RecordingPlan、录音状态机、三层完成确认、归档/双库/Replica/J-Card/备份、参考目录/Excel/Want List、30 项及 U-01～U-10 与 Owner 验收继续保留。

F-01 未收到 Owner 决定；不自动删除执行音频、不宣称档案自包含。真实 Source Roots、设备/接线/输出认证/停止延迟、Provider/Roon、完整 A～E、Owner、main、签名安装和发布均保持独立待验收状态。TASK-047 真实验收、跨 Renderer/应用重启 outbox、既有视觉 carryover 不自动关闭。
