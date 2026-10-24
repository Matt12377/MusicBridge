# 常驻媒体 Worker

此私有程序负责有界媒体标签解析、内嵌 PNG/JPEG 提取、PNG/JPEG/TIFF/WebP 封面解码、缩放及 JPEG 生成。数据库、根许可、来源身份核对、SourceLock、读取许可与 FileHandle 的关闭权继续由 Node 持有。它不接收真实媒体路径、Node FD 数值、数据库连接或 Provider 凭据。

Node 入口在 `packages/bridge-core/src/library/rust-media-worker.ts`，类型在相邻的 `rust-media-worker-types.ts`。`readMetadata` 与 `readEmbeddedArtwork` 只接收文件长度和调用者提供的 `read(offset,length)`。调用者必须在既有已核源只读句柄及许可内等待整个 Promise，然后才能关闭句柄。Rust 的 `Read + Seek` 适配器通过 NDJSON 请求位置与长度，Node 独立复核范围、单次读取、累计预算和请求序号。

每个池最多两个常驻进程，每个进程同时一个任务，健康进程在任务间复用。队列默认最多 32 项，上限 128 项；排队本身有固定预算期限，出队时重新核对同一期限。进程启动和实际任务分别保留 3 秒上限，父端在 timer、握手、读取回调与最终消息检查相同的单调时钟期限。取消、超时、协议异常及结果闭集校验失败会杀死进程，等待真实 `close` 和全部在途读取回调结束后才返回。成功结果会先撤销本次读取回调，再让进程复用。

单例按 Node isolate 隔离。普通扫描和专辑浏览使用 DatasetOwner 的共享池，最多两个进程；Main 的用户主动图片输入使用另一池，最多两个进程。这不是全应用只有两个子进程的声明；原音乐源文件读取仍由 Core 的全局读取许可控制。普通 Reader 关闭自己的任务，Owner/Main 的生命周期关闭各自单例；关闭期间拒绝新任务，完成后允许新域重新创建池。

## 格式与预算

普通元数据范围保持 FLAC、MPEG Layer 3、MP4 AAC/ALAC、WAVE、AIFF。DSF/DFF 需要原 `dsdMetadataEnabled`；Ogg Vorbis/Opus、WavPack、APE、Musepack、TTA、TAK 需要原 `cueInputMetadataEnabled`。DSF/DFF 有独立容器和尾部 ID3 解析，TTA/TAK 保留原有界头技术事实、空标签与空封面，继续使用 `musicbridge-cue-header/mbrs003-v1`。其余格式使用 `musicbridge-rust-media/v1`，不借 CUE 开关准入 WavPack DSD、Ogg Speex/Theora/OggFLAC。

标签文本单字段最多 4096 字节，总文本 64 KiB；元数据累计读取最多 32 MiB，内嵌封面任务累计读取最多 12 MiB；RPC 单次最多 64 KiB。封面单份最多 4 MiB，独立内嵌封面任务最多三份、总计 8 MiB。Lofty 单个标签分配及作业级全局分配护栏同时生效，解析过程的单次与累计分配沿用调用预算，包含第三方 Vec/String；RPC JSON/base64 缓冲独立受固定帧与 64KiB 上限限制。超过分配预算时直接以保留退出码 86 退出，Node 等待真实关闭后报告 `BUDGET_EXCEEDED`。输出还核对字段、数量和总字节；这些限制不声明整个进程 RSS 恰好等于某个像素预算。

内嵌任务的单次解析分配保留 MetadataReadBudget 的 8MiB 上限，以容纳 4MiB 图片之外的有界标签头和字段；图片本体仍以 4MiB 独立核验，不把标签缓冲上限当成图片上限。

元数据默认读取内嵌封面，并返回 magic 与 SHA-256 证据，不解码音频或封面。可信扫描器可在同目录已有封面证据时传入 `includeEmbeddedArtwork:false`；此时空 `coverEvidence` 表示本次未提取，不能解释为确认缺图。TTA/TAK 的头事实同样不代表完成封面探测。内嵌封面独立任务对不支持或不完整容器返回固定失败，不能冒充确认无图。

图片只接受单帧 PNG/JPEG/TIFF/WebP：输入不超过 4 MiB，宽高不超过 4096，像素不超过 16 Mi，解码像素预算 64 MiB，结构元数据不超过 256 KiB。原 Node 结构、CRC 和压缩元数据检查继续保留；Rust 在同一次解码中生成显示 JPEG 与网格 JPEG，不放大图片。网格默认 336px，应用指定 512px；网格最多 256 KiB。应用显示图预算 768 KiB，两份合计最多 1 MiB。显示与网格变体可能在质量或尺寸上继续收窄，以满足精确输出预算。TIFF/WebP 额外返回全尺寸 `compatible` JPEG，最多 4 MiB，只降编码质量，不允许为满足兼容字节预算缩图；EXIF 旋转可互换宽高。兼容 JPEG 供原公开 PNG/JPEG 合同建立输入身份，原文件保持只读。

## 协议与诊断

stdout 只承载逐行 JSON：`ready` 握手、`read` 请求和单次 `result` 终态。stdin 只接受 `job` 和对应 `read-result`，不接受路径字段。任务编号与读取序号不能跨任务复用，协议帧本身最多 12 MiB。最终结果前 Rust 适配器与缓存已经销毁；Node 收到终态后撤销回调。

stderr 使用中文结构化诊断，含 `jobId`、`stage`、`elapsedMs`、`queueWaitMs`、慢阈值。Node 不透传第三方错误文本，只把闭集阶段、编号、计时和失败码重发到 `shared/library-operation-log.ts` 的常开日志。标签、目录、源路径、图片、原始错误栈和凭据不写入日志。

## 二进制与构建

可信 bootstrap 可显式提供 `binaryPath`、`binarySha256`，或私有环境 `MB_MEDIA_WORKER_BINARY`、`MB_MEDIA_WORKER_BINARY_SHA256`。缺省定位依次检查 Electron `resources/media-worker/<platform>-<arch>/bin/`、工作树 `native/media-worker/bin/<platform>-<arch>/` 及桌面 staging 资源。未显式 pin 时核对同目录构建清单。resolver 拒绝符号链接、多个硬链接和组/全员可写二进制，使用同一个只读 FD 做 SHA-256 与前后身份检查，再核对路径身份。

Node 的标准 `spawn` 只支持可执行路径，这不是原子 `fexecve`；摘要检查与最终系统执行间仍有本地路径替换的系统边界。子进程环境清空，只保留语言设置。源码没有媒体文件打开或数据库写入入口，这也不是额外的操作系统沙箱声明。

```sh
node native/media-worker/scripts/build.mjs
node native/media-worker/scripts/build.mjs --target aarch64-apple-darwin --output-root /Volumes/LifeWeave/Developer/CommandLine/tmp/musicbridge-media-output
node native/media-worker/scripts/stage.mjs
```

构建使用 `cargo build --locked --release`。Cargo 依赖缓存与按工作树身份、目标隔离的持久编译缓存位于外置 `Developer/CommandLine/Caches/`；每次日志独立保存在外置 `tmp/`。缺省构建输出 `native/media-worker/bin/<platform>-<arch>/`，staging 输出 `apps/desktop/native/media-worker/<platform>-<arch>/bin/`。输出目录带工作树归属标记，遇到其他文件、其他归属或链接会停止，不清理已有目录。

Hosted CI 仅在 `GITHUB_ACTIONS=true`、`RUNNER_ENVIRONMENT=github-hosted` 且 `GITHUB_WORKSPACE` 实际路径等于模块推导的工作树根时采用现有 `build-storage-root.mjs` 策略。缓存、临时文件、日志放到 `RUNNER_TEMP/musicbridge-media-worker/`；只允许当前工作树的 `native/media-worker/bin/` 和 `apps/desktop/native/media-worker/` 两个精确资源子树作为 staging 输出。任意 `CI=true` 不能绕过本机外置卷要求。

构建清单包含 `schemaVersion`、`protocolVersion`、`parserVersion`、`sourceIdentity`、`platform`、`arch`、`target` 和 `binary:{relativePath,size,sha256}`；staging 把 `binary.relativePath` 改为 `bin/musicbridge-media-worker`。依赖与锁文件已经固定。初次代码交付只生成锁文件，之后 Owner 已授权并执行构建及真实 Worker 针对性测试；后续记录见 `docs/local-library-rust-worker.md`。没有启动应用窗口或读取真实音乐库。

## 固定依赖的一手 API 依据

- [Lofty 0.22.4：格式、Read/Seek Probe](https://docs.rs/lofty/0.22.4/lofty/)，[ParseOptions](https://docs.rs/lofty/0.22.4/lofty/config/struct.ParseOptions.html)，[GlobalOptions 分配限制](https://docs.rs/lofty/0.22.4/lofty/config/struct.GlobalOptions.html)
- [image 0.25.9：解码与编码](https://docs.rs/image/0.25.9/image/)，[解码 Limits 的具体边界](https://docs.rs/image/0.25.9/image/struct.Limits.html)
- [base64 0.22.1](https://docs.rs/base64/0.22.1/base64/)，[SHA-2 0.10.9](https://docs.rs/sha2/0.10.9/sha2/)
- [Rust GlobalAlloc 的安全与重入约定](https://doc.rust-lang.org/std/alloc/trait.GlobalAlloc.html)
