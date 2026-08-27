# TASK-059：固定执行格式与确定性 PCM 编译内核

基线 `71f08fc9dab8ea11625d2d282bfcc2ce593a6705`，分支 `codex/task-059-v3-execution-planning`。沿用完整 V3 持续开发授权；0 子代理、隔离合成文件，不 push，不触碰真实 Source Roots、输出设备或账号。

## 范围

1. ExecutionFormat 显式携带采样率、声道/布局、内部精度、输出样本格式、SRC 实现/版本、dither、声道映射、backend 与 profile 版本。没有默认设备或隐式转换。
2. 从 Frozen Master/Layout 生成逐面执行配方，验证引用与内容 Hash；Direct 的 Lead-in、Gap、Tail 是整数帧，空 B 无伪造音频。保留源首尾静音。
3. 首个编译内核支持 RIFF/WAVE 整数 PCM 16/24/32 bit、mono/stereo、相同采样率与声道/位深的字节保持拼接。生成最终 WAV、完整 Hash、PCM Hash 和帧级回执。未实现的解码、SRC、声道/位深转换、浮点、RF64 明确拒绝；后续继续扩展，不取消混合源与 DSD 的 PRD 范围。
4. Prepared 格式符合时校验并引用已保留原始 Render；不重写、不重复插入 Gap。格式不同返回需要独立 Derivative，不覆盖原件。
5. 完整输入 Hash、读取前后身份、取消/撤权、输出回读、大小/帧数、恶意或畸形 WAV、幂等确定性。目标句柄由上层排他创建，内核不接受公开目标路径、不自行删除文件。

## 边界

本任务交付可调用且实际读写文件的 Core 内核及合同，不接入桌面、数据库任务和 Archive Store，不发布可供正式 Plan 引用的资产。下一任务接续持久化编译任务/输出目录和桌面入口。没有声卡输出、音频停止延迟或完整 Gate B 证据；`formalReady` 固定 false。F-01 未确认，不制定保留/清理政策。Profile 管理、RecordingPlan、录音状态机、归档、J-Card、备份和完整 Owner 验收继续保留。

## 允许修改与 Gate

`packages/contracts/src/execution-audio.ts`、index、对应合同测试；Core `recording/execution-*`、`recording/source-files.ts` 的受限只读句柄辅助函数与相关测试；本任务、索引、WAVE-5、STATUS、执行计划、ADR-019、结果报告与忽略证据。无桌面生产/UI变更。TDD 的 API 缺失只记合同接线 RED，不冒充已运行的音频行为 RED；最终音频行为必须检查真实合成 WAV 文件。完整 verify/security/Electron/Playwright 和静态 Gate 后独立三次提交。
