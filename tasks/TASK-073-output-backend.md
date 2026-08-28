# TASK-073：输出后端与 Gate B

基线 `6c94350575ab2a21f7aeef36713b9a3d868e4bdf`，分支 `codex/task-073-output-backend`。Owner持续开发及Sol/High并行授权；TASK072已本地封版。仅合成资料、本地提交，不push、不合并main、不发布；真实设备枚举/open、改格式/路由/缓冲、独占、测试音、强退/拔线与录音测量均未授权。

## 当前自动阶段

1. 独立C++20共享FramePump：预分配有界帧缓冲、准确帧搬运/尾块/数字零、stop与underrun终止。synthetic helper只读继承fd3，通过固定二进制私有协议和实际PCM hash证明消费帧守恒，不做SRC/位宽/声道/电平变换，不加第二份Gap，不自动B面或换源。
2. CoreAudio HAL适配源可以编译为单独object以核API，但不链接进可运行synthetic helper，不提供真实设备运行开关。设备代码的编译不是设备验证，更不是Gate B通过。当前Formal输出继续不可达。
3. Core明确冻结PlanVersion+Side/Program，读取Plan私有目录与精确执行receipt；源/执行/原始Render/归档/当前材料重新验证；只读句柄租期必须覆盖helper直到close及末核验。实际PCM hash/帧数与冻结值一致后才能返回synthetic-only verified。没有库存/schema/Plan写入，不作为后续可复用admission。
4. 单运行、同ID同body单飞/终态原回执，异body拒绝；有界ID与取消先到集合达到上限拒绝，关闭/超时/撤权/文件变化/迟到事件不产成功。跨重启不持久重放或自动恢复。本阶段没有Attempt。
5. 新增三个有限只读公开命令recordingOutput.status/check/cancel；不走outbox，不接受路径/FD/设备认证/任意backend。公开状态固定NOT_RUN/formalReady=false/deviceAccess=not-authorized；check仅无设备检查，结果明确synthetic-only/deviceOpened=false。Backend构建身份来自应用编译期pin，不能信旁边清单自证。
6. 固定helper构建/打包校验、Core/Main/Preload接线及实际Electron合成Gate。仍保留原FFmpeg13文件及权限，不改转换器以支持设备。

## 唯一写入范围

- task071_picker：contracts recording-output.ts、index.ts、ipc.ts、validator.ts及test/recording-output.test.ts；无outbox/schema修改。
- task070_store：Core recording/output-input.ts、output-check.ts、output-error.ts和test/recording-output.test.ts、必要新增测试helper；不改旧store/repository/runtime。
- restore_index_details：native/output-helper/内C++源、私有协议说明、原生测试；scripts/build-output-helper.mjs、scripts/test-output-helper.mjs；编译与native focused测试可单独运行，不build桌面dist。
- root：Core output-helper.ts、output-protocol.ts、bundled-output-helper.ts及相应测试；runtime/utility-main；desktop Main/preload/core-supervisor接线和tests；native打包脚本/electron.vite config/package/gitignore、Electron E2E；任务/ADR033/控制/报告。共享路径先协调，所有最终共享build/Electron/E2E由root单跑。

## 验证和边界

生产前真实RED，GREEN后按SPEC再QUALITY、各最多两轮。native帧泵实际字节、协议/进程治理、真实Core合成资产与取消、固定构建身份、安全/Electron/完整E2E、类型/控制/边界/循环与清洁身份分别验证。禁止把unit替身或编译成功称为设备实测。

自动阶段可交付后端代码和无设备验证工具；TASK073完整验收仍需Owner锁定声卡/录音机/信号电平/独立测量时基/故障矩阵，完成B01～B15及真实延迟分布。未满足前不标整项完成、不开始正式录音，也不跳过Gate让TASK074执行。F01已批准不再重复询问。

并行范围更新：root转交task071_picker实现desktop Main recording-output-ipc.ts/index注册、Preload api/index/publickeys、core-supervisor的check期限及对应tests；root不并发修改这些文件。

后续明确转交：task070_store在Core4文件交回后负责output-helper.ts及其test/fixture；task071_picker在桌面接线交回后负责native-output-package脚本/声明、output-bootstrap/core-entry、构建pin/extraResources接线及对应测试。root保留output-service/runtime/utility与E2E；私有协议/loader已由root实现。最终原生候选9源码及3产物冻结后独立审查。

本地固定原生Gate入口：先运行`node scripts/build-output-helper.mjs`与`node scripts/test-output-helper.mjs`，核对三文件pin；再以`MUSIC_BRIDGE_OUTPUT_NATIVE_GATE=1`运行Core verify及桌面E2E。该变量仅控制测试选择，无真实设备授权含义；未开启时真实native用例明确skip而不伪报执行。桌面测试内部的BUNDLED_OUTPUT_GATE只启用合成helper加载。完整E2E另保留MUSIC_BRIDGE_NATIVE_GATE=1用于原FFmpeg用例。

## 2026-08-29 继续开发：无设备检查交互与既有边界复核

第二阶段基线`0a9ec3520b01066260df6f593e26c7b21167b83f`，仍在TASK073同一独立分支；上一阶段报告不改写。Owner继续开发授权不扩展为真实设备/测试音授权。

- task071_picker：新RecordingOutputPanel与controller及相邻单元测试，RecordingPlanPanel最小接入。用户明确选择冻结Plan和非空Side/Program后才能手动无设备检查；运行/取消/失败/通过区分，切换与卸载使迟到结果失效，不提升Formal或Gate B。沿用既有tokens、焦点、可访问性与720窗口。
- task070_store：包内正常退出未验证的根因调查；先只读确认probe/产品边界，若产品bug先真实RED，再经root批准最小改动。不新增测试后门，不放松Fuses或sender，不执行第三轮旧probe。
- restore_index_details：旧TASK072的同内容revision变化预检误分类P3，先真实业务RED再最小分类修复，不改变保守阻断和不可变Plan。
- root：新UI实际Electron E2E/截图/axe、统一build与所有Gate、阶段报告与完整TODO；共享Main/runtime/合同改动须先分配单一writer。

每个新增模块或delta先SPEC再QUALITY、最多两轮；不重开上一已封版候选的第三轮审查。真实Gate B仍NOT_RUN，TASK074仍未启动。证据保留`reports/runtime/task-073-output-ui/`；不push、合并、安装或发布。

## 2026-08-29 第三阶段：隔离的输出会话生命周期内核

第二阶段已本地封版，基线`a9090f247cdf2db553f95e9a4f63c041563e33ac`，继续TASK073原分支。无设备面板80/80 E2E通过不改变包退出FAIL或Gate B未认证。此阶段只开发和执行合成驱动测试，不触设备，不重试包退出。

- restore_index_details唯一代码writer：`native/output-lifecycle/device-session.hpp`、`device-session.cpp`、`device-session.test.cpp`，以及`scripts/test-output-lifecycle.mjs`。单次会话的注册/启动/停止/回调静止/释放；终止原因与清理阶段分开，取消先到、重复调用、旧代际、失败与超时均不重启。复用原FramePump，不复制帧搬运。
- Driver接口仅显式注入；唯一可执行driver实现留在测试。无设备ID、系统枚举、默认设备、CoreAudio控制调用、格式修改、动态加载或fallback。停止ACK不能充当回调静止或设备排空证据；未明确静止前不得释放回调可用资源。
- 新目录不属于现有helper源码pin或打包集合。测试脚本只在`reports/runtime/task-073-output-lifecycle/`输出独立测试产物；原FramePump和HAL源只读，必要时HAL仅`-c`，不链接设备框架或改现有构建脚本/16个原生文件。
- root唯一控制文档与最终报告writer（本任务、ADR033、STATUS、V3_TODO、RISK_REGISTER和阶段结果）、统一验证；task070_store和task071_picker承担非作者的限定SPEC→QUALITY，最多两轮。没有Main/Core/Contracts/Renderer接线，不新增Attempt或认证回执。

真实RED先于生产行为；正常与故障顺序、资源计数、迟到回调、帧泵尾块/欠载/停止、sanitizer分别给出新鲜证据。只称合成生命周期测试，formalReady=false/Gate B NOT_RUN保持；真实HAL资源静止保证和B01～B15仍需后续专门授权与测量。
