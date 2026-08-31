# TASK-061：执行转换与独立 Derivative

基线 `87e52bf08b2cd0666333bc5112983fddca3a6237`，分支 `codex/task-061-execution-conversion`。承接完整 V3 持续开发授权；0 子代理，无 push、main 集成或真实音频输出。

## 目标

为 Direct 的混合格式源与 Prepared 的格式不匹配 Render 接入可追溯解码、固定 SRC、声道和位深转换。输出实际字节、帧数和 Hash 经验证后才能作为独立执行资产使用；不以转换计划、预测时长或进程退出码代替验证。

## 范围

1. 严格的转换器身份、输入证据、参数和转换回执合同。原始 Hash、转换器版本/构建、实际解码和输出规格分别保留；不允许私有路径、任意命令、隐式归一化或伪认证进入公共回执。
2. 在明确选择转换后端之后实现受控本地文件转换。只允许必要的解码、SRC、固定声道映射和样本格式转换；不做 EQ、压缩、响度归一化、裁剪源静音或补齐时长。
3. Direct 保留原 Master/Layout 与源谱系，在固定输出格式下编译并精确插入数字零；Prepared 独立保留 Derivative，不能覆盖原始 Render 或再插入 Gap。旧版本/资产仍可读取。
4. 将转换接入持久任务、目标所有权、发布/恢复、容量检查和桌面明确确认；不开放 Renderer 可指定任意可执行路径或命令参数的接口。
5. 实际合成 WAV/AIFF/FLAC 与转换正反例，独立字节/帧/Hash 核验；安全、V2 与全桌面回归、静态自查及本地三提交。特殊格式/DSD 的支持与未支持原因据实际证据记录，不从完整 V3 范围删除。

## 选择与外部边界

Owner 已确认按固定 FFmpeg + SWR 方案继续；当前 Homebrew FFmpeg 8.1.2 仅作为本机可用候选，其构建含 GPL 配置，不能直接当作产品分发依赖。Owner 后续明确授权从固定源码构建并核验本地可打包 FFmpeg/SWR；仍不发布、不推送。Developer ID/公证、分发法律审查、其他平台及输出 Gate 另行验收。按固定 FFmpeg + SWR 实现适配器；正式输出认证和分发仍独立。

全部测试使用隔离合成文件和目录，无真实 Source Roots、账号、Roon 或硬件操作。F-01 未决，不自动清理执行资产，不承诺永久归档，不创建正式 RecordingPlan/Attempt。归档/Replica/J-Card/备份、目录导入和 Owner 验收仍在后续总范围内。

## 允许路径

Contracts 的执行音频/转换/资产/Profile 及 IPC/validator；Core recording、source-files、repository schema、runtime/utility；Desktop Main/Preload/录音上下文；Desktop 固定构建引导、Vite 打包身份、原生构建/打包脚本、精确内部模块导入的 CI 边界例外及负例、应用内许可说明和生成文件忽略规则；对应单元、文件、IPC/E2E 测试；TASK-061/索引、WAVE-5/STATUS/执行计划、ADR-021、结果报告与忽略证据。先测试再实现；缺 API 的失败只记合同接线 RED。

## 历史检查点：后端确认前（未提交，未收口）

- 转换谱系合同、输出文件回读已实现；实际转换后端、SRC、派生资产集成仍未实现。
- 源探测错误接受 16-bit IEEE 浮点已取得行为 RED 并修复；正常 32/64-bit 浮点容器探测通过。
- 固定 Node 22.23.2 / pnpm 10.17.1，完整 verify 退出 0：Contracts 60/60、Core 631/631、Desktop 169/169；安全 22/22。当前候选未运行 Electron Gate 或 Playwright，不沿用 TASK-060 的测试结果。
- 两份独立 Python 合成 WAV（浮点双声道和 24-bit 单声道）各 4801 帧，Core 与独立回读的大小、PCM 起点及双 Hash 一致。它们不是转换器输出。
- SPEC 自查仅覆盖合同和文件证据层；QUALITY 自查已做，均不是独立审查。14 文件允许列表、分支/base、diff 检查通过。旧 WAVE-3 control 脚本通过不代替 WAVE-5 身份核验。
- 本地证据：`reports/runtime/task-061-checkpoint-28qe0529`。保留 RED、完整回归日志和 8 个代码/测试文件的 Git blob 身份。首次独立夹具生成器数值越界已修正，失败目录保留；未改生产代码迁就夹具。

当时下一步为确认转换后端；Owner 后续回复“继续”已确认 FFmpeg/SWR 方向。未作实现/报告/状态锁定提交，不进入下一任务，不 push 或合并 main。

### 隔离选型验证补充

为后端选择补充了真实合成转换证据，未接入生产实现或改依赖。FFmpeg 8.1.2 + SWR 6.3.102 的四种源、13 份成功输出通过独立/Core 文件回读；SoXR 实测不可用，截断 FLAC 留下部分 WAV 并以失败退出。证据见 `reports/TASK-061_CONVERTER_SPIKE.md`。当时后端仍为 `OWNER_REPLY_PENDING`，不替代转换质量、正式输出或 TASK-061 完整 Gate。

## 历史等待记录（已解除）

后端方向连续三轮 goal 执行仍未收到明确答复。后端无关合同、文件回读与候选隔离验证已推进；当前剩余生产适配器、Direct/PREP 派生集成需要先确定后端，不能把自动续跑当作确认。自动推进标为等待 Owner 后端决定，完整 V3 目标不变。全部代码、RED/GREEN 日志和失败产物保留；未提交、未进入下一任务、未 push 或合并 main。

## 历史内核检查点

Owner 已确认固定 FFmpeg + SWR 方向，原后端选择阻塞已解除。适配器、V2 Direct/PREP 配方规划、Direct 字节拼接和 Derivative 回执内核已实现；整库 verify 退出 0（Contracts 64、Core 644、Desktop 169），安全 22/22。真实合成转换 11 份、编译文件 2 份及 Derivative 回执 2 份通过独立 Python 核验。见 `reports/TASK-061_CONVERSION_KERNEL.md`。

当时持久任务/目标所有权/发布恢复/桌面确认尚未接入新内核；该边界已由下述集成检查点推进。

## 历史集成检查点

新内核已接入任务拥有的文件、空间预算、持久化、发布/恢复、撤权与取消，以及私有运行时依赖和桌面四种明确选择。完整 verify 退出 0（Contracts 66、Core 652、Desktop 170），安全 22/22；真实 FFmpeg 合成持久任务的 5 份文件经独立 Python 核验，提交恢复未重新转换，原件保持不变。完整桌面与 Electron Gate 结果以 `reports/TASK-061_INTEGRATION_CHECKPOINT.md` 为准。

产品固定转换器构建尚未准入，默认启动仍明确拒绝转换，不启用或打包 Homebrew 候选。本任务未完成、未提交，未进入下一任务，未 push 或合并 main。完整 V3 后续范围保持不变。

## 当前固定构建检查点

Owner 已明确授权制作并核验可打包的固定 FFmpeg/SWR，仍不发布或推送。从官方签名源码构建 arm64 最小共享库候选，禁止 GPL/nonfree/network/autodetect，并把清单 Hash 编入 Core。普通启动仅从固定资源目录加载，缺失或漂移时转换失败关闭，不影响 V2 启动。合成验证、打包与剩余边界见 `reports/TASK-061_FIXED_BUILD_CHECKPOINT.md`；本任务本地自动验证已通过；三提交身份见最终 `reports/TASK-061_RESULT.md` 与 `project/STATUS.json`。未推进下一任务。

## 本地退出结论

固定转换、独立 Derivative、持久化/恢复和桌面确认完成本任务限定范围；最终 verify 为 Contracts 66、Core 654、Desktop 175，安全 22、Electron 4、Playwright 49 全通过。固定包和打包应用实际合成转换、独立 Hash/帧数/数字零核验通过。主代理先 SPEC 后 QUALITY 自查通过，不是独立审查。正式签名/公证和法律审查不属于本地退出证据；不把本任务通过写成完整 V3、Gate A–E 或 Owner 接受。
