# TASK-071：Source Picker 与双库交互补齐

## 身份与授权

- 基线：`72db8616ddbb461b93e9ffa960576af052c2bdf6`（TASK070最终封版）。
- 分支：`codex/task-071-source-picker`；实现提交：`5672a3928eb12746d55264b5da07967b09627f44`。报告提交由最终STATUS锁定，最终HEAD见本机final-closeout.json；TASK072须从该最终HEAD接续。
- Owner持续开发与GPT-5.6 Sol / High并行授权；仅本地提交，不push、不合并main、不发布。全部账号、Roon、库存、照片和音频为临时合成输入，没有读取真实用户资料或操作硬件。

## 交付

1. Source Picker新增“Roon 浏览 / 已登记收藏关系”局部tab，显示Exact/Probable/Related、数量及Physical Only/Digital Only/未核实。只用当前运行引用，不按标题猜测或自动重定位；离线和冷启保留本地关系。跨来源有序去重、最多100首，明确确认后沿原append/outbox写入，不播放、不增库存、不写关系、不产生Source Lock。
2. 录音页六类只读事实统一代际刷新，主下一步优先处理pending、dirty、读取失败与源状态，再依据用户明确选择的规划/布局/路径/Logic工作区/PREP引导。不拼各集合最新记录；当前源内容、规格、预留及谱系须一致。重开、切库或草稿revision变化清空临时选择；关闭工具刷新仍一致事实。
3. 主按钮把明确上下文传到媒体、版本、执行工具；失效初始编号不回退首条，旧手动入口不复用上次参数。五工具记住实际触发者，关闭后同代且无新交互时恢复焦点，避免迟到抢焦点。下一步不自动预留、导出、编译或开始正式录音。
4. 照片接近可视区才取有界图片字节；观察器不可用时使用滚动/resize与单RAF兜底。id/loader/重试/卸载代际隔离、单飞与监听清理。卡片不嵌按钮，独立大图和安全媒体候选提供单图重试。保留比例、来源、库存及原始文件字节；补齐240字符长名断行。
5. 不新增公开合同、数据库schema、正式RecordingPlan/Attempt、永久导航或照片墙设计。另修正一个旧outbox测试的持有生命周期并增加显式GC压力；生产锁代码未改。

## 最终自动Gate

最终候选23代码/测试/config文件与13固定native文件一致，指纹：`ab0391eaf0fc99bcd80530bb3951beac894cbcb89481c958b4afa1aab8b8ce9a`。

| 检查 | 结果 | 退出码 |
|---|---|---|
| canonical verify：类型、单元、生产build | Contracts118 / Core897 / Desktop395，全部通过 | 0 |
| 安全 | 27/27 | 0 |
| Electron启动、crash/restart、合成保险库与冷启恢复 | 4/4 | 0 |
| Electron后恢复生产构建 | PASS | 0 |
| 完整E2E，MUSIC_BRIDGE_NATIVE_GATE=1 | 73/73，零skip，2.8分钟 | 0 |
| E2E类型 / control / boundaries / cycles | PASS / 旧范围PASS / PASS / 199文件PASS | 0 |
| 最终候选 / native / diff-check | 23/23 / 13/13 / PASS | 0 |

新增七项真实Electron合成场景覆盖关系分类与跨来源原回执重试、离线/冷启、两库照片离屏零读和明确重试、长名窄窗、只读状态失败恢复，以及真实双规划/双布局选择与工具承接。focused9/9同时覆盖两项旧照片适配。Root逐张查看最终12张截图；240字符标题在720与1440均滚入视口检查，窄窗保持垂直滚动。指定区域axe serious/critical为零，不把单张截图视为全部页面或全部键盘路径的证据。

## 审查、失败与裁决

SPEC先QUALITY，各两轮最终PASS，没有第三轮。SPEC修复旧面板丢上下文、媒体候选照片无安全重试；实际E2E另暴露同一mutable state引用使子组件选项不刷新，改为浅快照传播。QUALITY修复关闭后固定旧入口抢焦点；实际Electron RED与根集成6pass/2fail到8/8GREEN分别保留。

首轮新E2E5/7：照片helper未建立可视前提、合成源路径未realpath；修正fixture后继续实际行为验证。首次完整E2E71/73：两个旧照片测试未滚到照片区就等待img/失败状态；只加两行scrollIntoViewIfNeeded，所有原库存、原文件、冷启与恢复断言保留，最终73全绿。

一次最终verify为394/395，旧跨进程outbox测试第二进程意外打开账本。先停止封版；WeakRef/FinalizationRegistry与单变量GC对照证明empty interval只保进程、不保store。root在原测试加入六轮GC稳定复现0/1 RED；仅持续强引用store至SIGKILL后整文件22/22GREEN。正式Main由模块级service及IPC闭包持有store，生产锁实现与基线blob相同。原失败当时没有GC探针，不声称回溯观察到当时GC；此次机制有直接对照及原测试复现证据。该额外测试文件由root作最终Gate有界裁决，独立审查覆盖原22文件，不冒称23文件都被另行第三轮审查。

证据目录：`reports/runtime/task-071-source-picker/`。包含candidate-final、gate-results、各RED/GREEN、SPEC/QUALITY、GC脚本与真实合成SQLite、root裁决、visual-final-observation、final-e2e-artifacts。原失败日志/产物均保留，未用一次重跑成功替代根因证据。

## 接续与未完成

完整TASK064～079 TODO不删减，064～071本地自动Gate完成，072～079及Owner验收仍待完成。TASK072须先明确F-01成功/失败/取消执行资产保留政策与精确重播/重建承诺；未确认前不自动删音频、不冻结正式Plan。已向Owner提出保守保留方案，但没有把未回复写成批准。

真实Roon/Provider、Source Roots、照片、Excel、Logic及设备录音与Owner产品/视觉接受均NOT_RUN。TASK047真实歌词、TASK061发布准入、R020大库容量/Gate E、既有侧栏视觉carryover、签名公证和Beta发布分别保留。当前远端main仍`90d0aa8aa7f156c6ecfc6f366eea698f8e4d6098`，TASK071远端不存在；最终封版再次核验。
