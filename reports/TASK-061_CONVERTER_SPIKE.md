# TASK-061：转换后端隔离选型验证

> 历史检查点：以下提交状态描述当时取证时点；最终本地收口身份见 `TASK-061_RESULT.md` 和 `project/STATUS.json`。

状态：选型证据，不是产品后端准入、TASK-061 完成或 Gate B/D 通过。Owner 尚未确认转换后端；产品代码、依赖及生产入口本轮未改变。

基线 `87e52bf08b2cd0666333bc5112983fddca3a6237`，分支 `codex/task-061-execution-conversion`。继承的 8 个代码/测试文件均与上一检查点的 Git blob 身份一致。未提交、未 push、未合并 main。

## 实验范围与身份

全部音频在新的忽略目录中生成，仅含合成双音、首尾静音。没有真实 Source Roots、账号、Roon、声卡或录音设备操作。实验工具为本机 FFmpeg 8.1.2，libswresample 6.3.102；二进制、版本输出和 FFmpeg 组件文件 Hash 已保存，但未完成全部动态依赖准入。Homebrew 构建不作为可分发产品构建。

使用已打开的只读输入与排他创建的输出句柄，通过 `fd` 协议传给子进程；不向转换参数传源/目标路径。限制单线程、协议集合、进程时长和日志大小。官方说明 `fd` 对普通文件支持 seek；本轮已实际验证本机候选的输入与输出使用方式。参见 [FFmpeg fd 协议](https://ffmpeg.org/ffmpeg-protocols.html#fd)。

SRC 实验固定 SWR、双精度内部格式、filter_size 32、phase_shift 10、exact_rational、Kaiser 参数和 cutoff 0.97；关闭时间戳补偿，不裁剪或补齐文件时长。16-bit 单声道实验显式取双声道均值，分别测试不加 dither 与 triangular dither。参数保存在每次运行的完整参数数组中，没有冻结为产品 Profile。参数含义参见 [FFmpeg Resampler](https://ffmpeg.org/ffmpeg-resampler.html)。

## 实测结果

| 用例 | 结果 |
|---|---|
| WAV、AIFF、FLAC、浮点 WAV 四种合成源 | 实际解码均为 44,101 帧；还原的 16-bit PCM 与原始合成 PCM 完全一致 |
| 四种源各转换两次至 96 kHz / stereo / 24-bit | 8 份输出均为 96,003 帧，整文件字节一致；与精确采样率比例的差值小于一输出帧 |
| 48 kHz / mono / 16-bit，不加 dither 与 triangular 各两次 | 各 48,002 帧；同配置两次字节一致，两种配置的 PCM Hash 不同 |
| 96 kHz / stereo / 32-bit 浮点 | 96,003 帧，全部样本有限，fact 与实际数据块一致 |
| 截断 FLAC | 转换退出 183，留下 481,352 字节部分 WAV；不能据“文件存在”接纳资产 |
| 显式指定 SoXR | 退出 234，输出 0 字节，实际报引擎不可用；帮助列出选项不证明构建含该引擎 |

共 13 份成功转换输出的结构、实际帧数、格式、整文件及 PCM Hash，经独立 Python 读取器和 Core `inspectConversionOutput` 交叉一致。4 份源也通过 Core 容器帧探测。所有输入转换前后完整 Hash 相同。以上一致性只适用于本批合成资料、本机构建和记录的参数，不是全格式、跨平台或音质认证。

## 后续必须实现与验证

1. Owner 确认后端方向，再实现生产适配器、固定构建准入及实际解码证据。建议方向仍为固定 FFmpeg + SWR；不能在 SoXR 不可用时静默回退。
2. 进程失败、超时、取消、解码警告/错误和帧不一致都不得接纳部分输出；输出回读不能独立决定转换成功。
3. 接入 Direct 新版本配方、PREP 独立 Derivative、持久化/恢复及桌面确认；保留原件和历史谱系，不重复插入 Gap。
4. 完整转换质量/格式/资源/故障矩阵、Electron/Playwright 和 TASK-061 三提交仍未完成。F-01、真实输出认证及完整 V3 的后续阶段仍待推进。

## 可复核证据

目录：`reports/runtime/task-061-converter-spike-bow5im31`。

- `candidate-spike.mjs` 与 `candidate-results.json`：固定实验流程、参数、退出码、日志、输入前后及输出 Hash。
- `decoded-probes.json`：逐解码帧的 nb_samples 与总帧数。
- `verify-candidate.py`、`independent-validation.json`：独立实际文件读取。
- `verify-core.mjs`、`core-validation.json`：Core 回读交叉核验。
- `source-manifest.json`、`ffmpeg-version.txt`、`candidate-binary-identities.json`：合成源和候选工具身份。

所有失败产物均保留在该隔离目录，没有自动清理。
