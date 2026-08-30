# 输出 helper 私有协议 v1

此协议只供可信 Core 启动固定 synthetic 二进制。没有设备模式、设备 ID、路径、任意 FD、JSON 或正式输出许可。输入音频固定 fd3，必须 O_RDONLY、regular、nlink=1；Core 必须在外层持有已核验的执行音频租期至 child close 和租期末核验。一个进程只消费一个 Side/Program，不自动续面或重放。

整数为 LE；UUID16 和 SHA-25632 为原始字节。结构按固定偏移读写，不依赖 ABI padding。reserved 必须为零。

## stdin 首帧：256 字节

| offset | bytes | 字段 |
| --- | ---: | --- |
| 0 | 4 | ASCII MBFP |
| 4 | 2 | version=1 |
| 6 | 2 | headerBytes=256 |
| 8 | 16 | runId，Core 生成 |
| 24 | 16 | planVersionId |
| 40 | 16 | executionAssetId |
| 56 | 32 | planContentHash |
| 88 | 32 | 本侧 recipeHash |
| 120 | 32 | 全文件 sha256 |
| 152 | 32 | PCM sha256 |
| 184 | 8 | fileBytes，44..0xffffffff+8 |
| 192 | 8 | dataOffset，>=20 |
| 200 | 8 | dataBytes |
| 208 | 8 | frameCount，>0 |
| 216 | 4 | sampleRate，8000..384000 |
| 220 | 2 | channels，1/2 |
| 222 | 2 | format，1=s16le、2=packed-s24le、3=s32le、4=f32le |
| 224 | 4 | callbackFrames，1..4096 |
| 228 | 28 | reserved=0 |

`dataBytes=frameCount*channels*sampleBytes`，乘法与范围必须在溢出前校验；PCM 区间不超过文件。helper 不解析 WAV 容器，格式和区间须来自 Core 已核验 receipt，不允许 Renderer 填写这些字段。文件 hash / PCM hash 会在 native 独立重算；f32 拒绝非有限值，不裁剪有限超满幅。

## stdin 后续控制：32 字节

MBFC4 / version u16(1) / opcode u16 / runId16 / seq u32 / reserved u32(0)。

opcode：1 RUN_SYNTHETIC，只能 VERIFIED 后一次；2 STOP，可先于 RUN。seq 从1严格递增：STOP先到为1，RUN后STOP为2。Core合并重复取消；不得发第二配置或第二RUN。stdin必须保持打开，提前EOF视为父进程失联，不是完成。

## stdout 事件：128 字节

| offset | bytes | 字段 |
| --- | ---: | --- |
| 0 | 4 | ASCII MBFE |
| 4 | 2 | version=1 |
| 6 | 2 | kind |
| 8 | 4 | seq，从1递增 |
| 12 | 4 | reasonCode |
| 16 | 16 | runId |
| 32 | 8 | 本进程开始后的 monotonicElapsedNs |
| 40 | 8 | consumedSourceFrames |
| 48 | 8 | zeroFilledFrames，含末块padding，不算源帧 |
| 56 | 8 | callbackCount |
| 64 | 32 | 完整input PCM hash，VERIFIED前全零=未取得 |
| 96 | 32 | 实际sink消费源字节hash，只有terminal有效 |

kind：1 ACCEPTED、2 VERIFIED、3 RUNNING、4 SOURCE_EOF、5 SYNTHETIC_DRAINED、6 STOPPED、7 FAILED。正常顺序1/2/3/4/5；5/6/7为唯一终态。ACCEPTED只证明头和FD通过；VERIFIED才表示输入两hash通过。SOURCE_EOF与合成消费完分开；都不证明硬件排空或实体完成。完整初检、供帧扫描及实际sink消费hash必须一致才可能kind5。

reasonCode：0 NONE、1 STOP_REQUESTED、2 PARENT_CLOSED、3 BAD_PROTOCOL、4 BAD_INPUT_FD、5 UNSUPPORTED_FORMAT、6 RANGE_OR_BUDGET、7 INPUT_CHANGED、8 HASH_MISMATCH、9 READ_FAILED、10 UNDERRUN、11 OUTPUT_SHAPE、12 TIME_LIMIT、13 INTERNAL。

exit0仅kind5；exit2对应kind6；其余失败非零。header未完整到达时没有可回显的run事件。停止hash只是已消费前缀。Core须校验所有kind/seq/run/hash/帧数/退出码和close，stdout总限1024字节、stderr限16KiB且不外泄原文。helper不写stderr。不能仅凭exit0、SOURCE_EOF或旧VERIFIED宣称成功。

首header期限5秒，整体非实时期限15分钟，stdout单次完整写期限1秒。Core额外治理首响应/取消/退出期限并等待close。计时只作同进程相对量，不等于Gate B的实时/声学停止指标。

## 构建边界

`scripts/build-output-helper.mjs` 显式编译四个translation units；synthetic只链接frame-pump.o与synthetic-main.o，HAL只产core-audio-adapter.o。没有CoreAudio框架链接、动态加载或设备调用入口。native unit同样链接唯一frame-pump.o，真实ring不足测试欠载；普通synthetic驱动非实时先供足所需帧，不伪装硬件调度。

产物：`apps/desktop/native/output/darwin-arm64/{manifest.json,bin/output-helper,build/core-audio-adapter.o}`。manifest不含绝对路径。`sourceSha256`算法：源码目录内所有`.cpp/.hpp` basename按JS字符串排序；每项拼接 `basename + NUL + sha256(fileBytes) + LF`，再对整个UTF-8串SHA-256。测试C++也纳入，协议文档和JS测试不纳入。

中间object与unit executable仅写入`reports/runtime/task-073-output-backend/native-build`，不会混入打包产物树。

无设备测试入口：先 `node scripts/build-output-helper.mjs`，再 `node scripts/test-output-helper.mjs`；测试脚本不隐式重构建。只支持darwin-arm64，其他平台明确拒绝，不回退系统工具。构建/合成测试不能改变Gate B NOT_RUN、formalReady=false或deviceOpened=false。
