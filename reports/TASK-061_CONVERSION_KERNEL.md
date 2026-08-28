# TASK-061 转换内核检查点（未收口）

> 历史检查点：以下提交状态描述当时取证时点；最终本地收口身份见 `TASK-061_RESULT.md` 和 `project/STATUS.json`。

基线：`87e52bf08b2cd0666333bc5112983fddca3a6237`。
工作分支：`codex/task-061-execution-conversion`。
实现/报告提交：均未创建；下一分支基线尚未确定。当前仍为 TASK-061 WIP。

## 已推进

Owner 对固定 FFmpeg + SWR 确认问题回复“继续”，后端选择阻塞已解除。新增固定构建适配器、完整源解码核验、受控 FD 转换、输出回读和版本化 V2 配方/编译内核。Direct 保留原始源证据并按实际转换帧数拼接；PREP Derivative 回执保留原 Render 谱系与独立输出 Hash，不加入 Gap。

行为 RED 发现并修复了回读后撤权、同尺寸输出改写、源后期改写、构建文件校验后路径被替换，以及合同错误接受转换后时基作为源解码事实。新 API 缺失的失败仅记接线 RED，不当作音频行为证据。编译夹具最初只有 7 帧，时长舍入为 0 毫秒而不满足现有源合同；改用 48 帧夹具，未放宽生产校验。

## 新鲜验证

| 验证 | 结果 |
|---|---|
| Node 22.23.2 / pnpm 10.17.1 整库 `verify` | exit 0；Contracts 64、Core 644、Desktop 169 全通过，无跳过 |
| 安全测试 | exit 0；22/22 |
| FFmpeg 适配器真实合成文件验证 | exit 0；11 份输出逐字节匹配已独立核验的参考文件 |
| 新编译内核真实合成文件验证 | exit 0；24-bit、float32 各 864006 帧；Gap 各 480000 帧 |
| 独立 Python RIFF/PCM/Hash 核验 | exit 0；11 份转换输出、2 份编译文件、2 份 Derivative 回执 |
| 截断 FLAC | `DECODE_FAILED`；目标保持 0 字节 |
| 取消/停滞进程、版本/依赖 Hash、源/输出变化 | 受控进程和文件故障测试通过，不作为真实设备证据 |
| control / boundaries / cycles | exit 0；control 仅 WAVE-3，cycles 145 文件 |
| Electron / Playwright | 当前 TASK-061 未运行 |

所有输入均为隔离合成文件。真实 FFmpeg 输出和进程替身的测试证据分开保存。Derivative 的两项是对独立转换文件的回执绑定，不是两份新增编译文件。

证据目录：`reports/runtime/task-061-adapter-ltgomvhb`。`results.json`、`assembly-results.json`、`independent-adapter-validation.json` 保存实际文件数据；`code-blobs.json` 固定 15 个代码/测试文件身份；目录内保留 RED/GREEN、回归和验证脚本。Homebrew 构建固定为 FFmpeg 8.1.2 / SWR 6.3.102；观察到的组件 Hash 不代表完整传递依赖准入。

## 自查与未完成范围

SPEC 自查：当前内核覆盖固定身份、完整解码、源只读、取消、明确转换参数、实际 PCM/帧/Hash 和 V1 兼容边界；TASK-061 的持久化与桌面需求尚未满足，因此不判任务完成。

QUALITY 自查：无 Shell 参数拼接、无任意命令入口、无源/目标路径进入公共回执；有墙钟和单调时钟限制、分块读写、等待子进程关闭及末次身份复核。这是自查，不是独立审查。

接续顺序：目标所有权与转换文件写入 → 持久任务/发布/恢复 → IPC/桌面明确确认 → 完整自动 Gate → 实现/报告/状态锁定三提交。现有应用尚未调用新内核，没有默认启用系统 FFmpeg。

产品分发构建、完整动态依赖与许可准入、真实输出/音质、F-01、正式 RecordingPlan/Attempt、真实 Source Roots/账号/Roon/硬件、Owner 验收均未放行或未执行。未自动清理任何执行资产；没有 push、main 集成或发布。完整 V3 后续目标保持不变。
