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
