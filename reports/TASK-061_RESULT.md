# TASK-061：固定音频转换与独立执行派生

## 身份与结论

- 基线：`87e52bf08b2cd0666333bc5112983fddca3a6237`（TASK-060 最终状态）。
- 分支：`codex/task-061-execution-conversion`。
- 实现提交：`13cfe178e00b698fb1a7a814ae1c56b39cc21419`。
- 报告提交：包含本文件的独立提交；精确 SHA 在下一状态锁定提交写入 `project/STATUS.json`。
- 结论：TASK-061 限定范围本地自动验证通过。完整 V3、真实输出及 Owner 验收未完成；0 子代理，未 push、未合并 main。

## 交付

明确 Direct 转换和独立 PREP Derivative，保留不可变源谱系、固定转换参数、实际解码和输出回执。FFmpeg/SWR 仅由 Core 私有依赖注入；FD 输入输出，完整消费输入并核对帧数、文件/PCM Hash，失败不发布。

Direct 保存逐曲转换文件并拼接逐面成片，冻结留白写入精确数字零，不重复 SRC/dither。PREP 从实际保留 Render 整体派生，原件不覆盖、不再次插入 Gap。任务独占目录、空间预算、撤权、取消、发布清单和冷启动恢复覆盖新路径；发布后提交中断只核验补交，不重放转换。

桌面在既有录音上下文展示明确模式、预算、预测与实际帧数、构建身份、参数及未正式就绪状态。预览不写文件，改变选择撤销旧确认；既有重试、历史和当前文件验证保留。旧同格式整数 Direct 与 PREP 原件引用不被替换。

Owner 本轮授权后，从官方签名源码构建 FFmpeg 8.1.2 / SWR 6.3.102 的 arm64 最小共享库候选。禁用 GPL/nonfree/network/第三方自动发现，仅 FD 协议；二进制与5个 dylib 不依赖 Homebrew。Vite 把清单 Hash 编入 Core，固定路径加载、逐文件核验，缺失或漂移失败关闭。包内包含对应源码、许可证及构建材料。ad-hoc 本地包与实际 Core 转换已验证，不等于发布法律审查、Developer ID/公证或设备认证。

## 最终证据

Node 22.23.2 / pnpm 10.17.1，46 个代码/测试/构建路径的 Git blob 与最终验证候选一致。

| Gate | 结果 | 退出码 |
|---|---|---|
| 完整 verify | 类型、测试、构建通过；Contracts 66、Core 654、Desktop 175 | 0 |
| Security | 22/22 | 0 |
| Electron 生命周期 | 4/4 | 0 |
| Playwright | 49/49，含明确启用的固定原生构建用例 | 0 |
| 控制面 / 边界 / cycles | PASS；148 个源文件；control 仅覆盖 WAVE-3 | 0 |
| 固定源码构建 / 原生加载 | 签名来源、配置、依赖闭包及文件身份通过 | 0 |
| 本地包 / 启动 | 整包签名检查、启动标记通过；7 个原生 Hash 不变 | 0 |
| 包内后端持久任务 | 4 次转换、5 个文件；恢复不重放；Direct/PREP 原件不变 | 0 |
| 打包应用实际 Core 转换 | 432,004 帧，Hash、重新验证、独立 PCM 回读通过 | 0 |
| diff / 允许路径 / 分支基线 | 本地身份通过；远端无对应分支 | 0 |

固定适配器的 12 份输出独立核验通过，截断 FLAC 拒绝且不发布；10 份整数参考逐字节相同。浮点跨构建存在20个近零差异、最大绝对差3.47e-18，同一固定构建重复字节一致；仅对本样本成立，不作为听感或通用误差上界。

打包应用成片为48 kHz、24-bit、stereo，2,592,068字节；整文件 SHA-256 `c2b34ebbc3d7087101fade7575aa9f3e3743d050bedb071ad99ce604bbd0474e`。独立回读核对3段数字零、2段转换 PCM 与回执 Hash。全部合成，不连接真实账号或设备。

详细构建命令、固定 Hash、RED/GREEN、失败尝试和限定条件见 [固定构建检查点](TASK-061_FIXED_BUILD_CHECKPOINT.md)、[持久化集成检查点](TASK-061_INTEGRATION_CHECKPOINT.md)、[内核检查点](TASK-061_CONVERSION_KERNEL.md) 与 [隔离选型](TASK-061_CONVERTER_SPIKE.md)。最终本机证据为 `reports/runtime/task-061-product-build-ukhdz8q6`，生成的原生包、源码和测试产物不提交 Git。

## 审查与后续

按 SPEC 后 QUALITY 完成主代理自查；不是独立审查。未开放任意可执行 IPC，未降低安全 Fuses/Renderer 隔离，未用 fixture 或预测帧数冒充真实输出。原先边界扫描对内部策略模块的误判只增加精确导入例外，外部库、动态导入和 Renderer 导入继续拒绝。

本任务本地三提交后，下一任务必须从最终状态锁定 HEAD 建立分支；不能从实现提交或未提交 WIP 跳接。本轮不创建下一任务。

完整 V3 的正式 Profile Snapshot/RecordingPlan、输出后端与 Gate B、录音完成确认、归档/Replica/J-Card/备份、参考目录/导入、真实 Gate A–E 和 Owner 接受继续保留。F-01 尚未决定，不自动删除、不承诺永久归档，不创建正式 RecordingPlan/Attempt。DSD/特殊格式、其他架构、macOS13实机、分发法律审查和 Developer ID/公证另行处理。

TASK-047 真实验收、跨 Renderer/应用重启 outbox、已有窄窗与对比度视觉 carryover 不自动关闭。自动验证与本地提交不构成 GitHub 交付或公开发布。
