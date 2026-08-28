# TASK-073：无设备输出检查阶段结果

## 身份与完成边界

基线 `6c94350575ab2a21f7aeef36713b9a3d868e4bdf`（TASK072最终HEAD）；分支 `codex/task-073-output-backend`。实现提交`baff4bef0a7890c5ecd0cd19af7d5e6164554232`；报告提交由最终STATUS锁定。

Owner已批准F01保守保留政策并授权持续开发、GPT-5.6 Sol / High按路径并行。本阶段仅合成资料、本地提交，不push、不合并main、不发布，没有访问真实账号、音乐库或设备。

**这是TASK073的无设备自动阶段，不是整个输出后端或Gate B验收完成。** 当前只有共享FramePump、可执行synthetic helper和单独编译的HAL回调适配；没有可用的真实设备注册/启动/配置认证生命周期。TODO仍保留TASK073未完成，TASK074没有开始。formalReady=false、Gate B=NOT_RUN。

## 本阶段交付

1. C++20共享FramePump使用有界预分配SPSC缓冲，准确搬运PCM、尾块补零，停止或欠载后不续播。实际支持s16、packed24、s32、f32及单/双声道；不做转换、增益、额外Gap或换源。合成sink只对实际消费源帧计算hash。
2. 独立helper仅接收固定256字节header、32字节控制和继承的只读fd3；128字节事件逐run/seq/阶段核验。完整文件hash、输入PCM、供帧PCM及实际消费PCM相符才能成功。SOURCE_EOF与SYNTHETIC_DRAINED分开，后者不是设备排空或输出端无声证据。
3. Core明确选择冻结PlanVersion及Side/Program，从私有谱系推导唯一文件；核对所有源、执行资产、保留原始Render、归档及当前预留。输入FD租期覆盖真实child close和末核验；退出码、kill请求或中间事件不提前发布成功。全过程不写schema、旧Plan、库存或outbox。
4. 单活动run、同ID同请求单飞并保留原回执、异请求拒绝；取消先到和失败回执不淘汰后重跑，有界1000个ID。关闭、撤权、变化、超时、迟到事件与协议洪泛均安全失败；跨重启不自动恢复或重放。
5. 三个有限公开读命令status/check/cancel接入Contracts、Preload、Main、Utility与Runtime。没有Start、设备选择或路径/FD公开入参；所有结果明确synthetic-only/deviceOpened=false。固定构建由应用编译期manifest pin约束，缺包或变化即禁用，无PATH/下载/系统后端回退。
6. 固定包只有manifest、helper和HAL object三文件；HAL object不链接进helper，脚本检查音频框架和动态加载入口。保留旧FFmpeg13文件及其hash。桌面构建/打包和真实Electron合成链路已接入；没有新增用户界面或声卡操作入口。

## 自动验证

| 检查 | 结果 | 退出码 |
|---|---|---|
| canonical verify：类型、单元、生产build | Contracts134 / Core956 / Desktop427，显式native开启、零skip | 0 |
| 安全 | 28/28 | 0 |
| Electron启动、crash/restart与合成保险库恢复 | 4/4 | 0 |
| Electron后恢复生产build | PASS | 0 |
| 新增实际Electron合成链路 | 2/2；132300帧及PCM hash守恒，取消/变更/冷启拒绝 | 0 |
| 完整E2E | 77/77，两个原生开关开启、零skip，2.9分钟 | 0 |
| 共享FramePump与实际helper进程 | 19断言；25/25进程/产物测试 | 0 |
| ASan+UBSan / TSan | 各19个共享FramePump断言，无诊断；不覆盖整个helper/HAL | 编译/运行均0 |
| control / boundaries / cycles | PASS / PASS / 215文件PASS | 0 |
| Core / Desktop / E2E类型 | PASS | 0 |
| 本地ad-hoc应用包及整包codesign校验 | PASS；ASAR23文件、原生16文件与候选相同 | 0 |
| 实际应用包内输出检查 | 132300帧及PCM hash与冻结Plan相同，库存/outbox/Plan/源/helper守恒 | 探针0；应用SIGKILL清理 |

本机原生测试使用`MUSIC_BRIDGE_OUTPUT_NATIVE_GATE=1`；完整E2E另启用`MUSIC_BRIDGE_NATIVE_GATE=1`运行原FFmpeg用例。默认跨平台unit及普通CI明确skip本地native用例，不把跳过算通过；显式开启后缺包或校验失败必须失败。测试开关不构成设备授权。

本阶段没有新增UI，E2E实际通过公开API跨Preload/Main/Core/helper验证，不用截图代替行为证据。既有UI由完整E2E回归，Owner视觉接受仍未完成。

## RED/GREEN与审查

- 合同初始1/7 RED到7/7 GREEN，Core输入/治理15项，桌面接口41项、打包/加载9项均先有实际RED。Runtime/Utility新增2项从RED到完整组合63/63；总回归包含这些用例。
- 实际native联调发现Core把SOURCE_EOF误当完整消费；新测试4/5 RED后只在DRAINED强制完整帧，5/5 GREEN。原生实际2051帧测试随后通过，不降低成功hash/帧数要求。
- helper读取期间替换父目录可让旧FD认证同名新文件：真实文件替换测试3/4 RED；增加当前named identity与FD比对后4/4 GREEN。
- runner实际RED覆盖取消后的stdout洪泛和RUN发出前伪造RUNNING；保持首次失败原因并立即kill，所有结果仍等close。
- native SPEC1发现运行后的7字节控制残片可能被成功收口忽略，实际RED旧helper exit0；最小修复在成功前拒绝残片BAD_PROTOCOL。原24项加该场景25/25 GREEN，不凭残片猜STOP。
- Core SPEC1→QUALITY1、Contracts/Desktop SPEC1→QUALITY1通过；native最终SPEC2→QUALITY1通过，SPEC1的P2已关闭。每组最多两轮，没有第三轮。

候选51代码文件、16固定原生产物；候选JSON SHA256为`d6e1061a97a27ababb015f7e2d1206f383d6af6ffc6ceebc3bc3ad48299392f3`。源码和最终原生候选逐文件身份见本机`reports/runtime/task-073-output-backend/candidate-final.json`。所有RED、GREEN、审查、原生构建及sanitizer完整命令、E2E产物保留于同runtime目录；运行产物不提交Git。

## 固定构建与后续

- output manifest SHA256：`d9641cd76bb6c93633b3e026ea329d9a4121d123d9a1f1646f86a8bb27fad22a`
- helper SHA256：`32952d5bbc11af471c8168bd17df9e471abbc730859e5b25f1b5d13fe223eec8`
- HAL object SHA256：`9bb95ea60191ea9630dee0417a00b8f142412dfde3e3f7478a166b63f7d4dadc`
- C++/HPP源集合SHA256：`cfeaf6b4ad8bd85a8657d4e0da304c5e9a13cf3c7a0a77ff46a9d9aca97d9c37`

后续仍在TASK073：先明确设备、录音机/采集回路、格式/缓冲、测试电平、独立时基和故障操作授权，再完成实际设备生命周期及B01～B15测量。现有只读输入/合成帧证据不能直接升级为设备认证；100ms引擎切断和2000ms总停止上限均未实测，不能以进程期限替代。

Prepared经SRC的逐marker精确映射仍需转换映射证据，不按时长比例伪造。TASK074 Attempt、实体完成三层确认与后续075～079仍按完整队列推进，不能跨过Gate将正式录音启用。F01已批准不再列为待决条件。

TASK047真实歌词、TASK061发布准入、R020大库/Gate E、TASK072预检版本误归因P3、既有视觉carryover、Owner验收、签名公证和发布继续保留。下一任务分支尚未建立；后续须从本阶段最终HEAD接续且先满足TASK073剩余前置。

实际包探针首轮将自定义协议误判为file://，修正验证脚本前提后复用原合成fixture，未改生产代码；第二轮通过。实际页面为musicbridge://app/index.html，Main堆栈明确来自包内app.asar。清理最终使用SIGKILL并等child close、确认无残留；正常包退出未验证，另列TASK078有界carryover。stderr中trusted-sender的NOT_READY拒绝原样保留，不冒称无日志错误或正常退出通过。没有第三次实验。
