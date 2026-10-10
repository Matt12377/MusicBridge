# MBM-003 正式合同与处理语义

唯一公开合同为`packages/contracts/mobile/openapi.json`，文档1.7.0、原40个操作。服务器握手0.1.0、UI能力1.0.0及原PCM规则不变。本文与实际合同文件按完整字节固定，由iOS按相同身份采纳；合同固定不是软件、App、真机或Owner验收通过。无需Owner重复批准范围。

## 独立协商

`Processing.mode`仅增加`dsd_to_pcm`。`UIContentCapabilities.resourceDsdToPcm`可省略、不可null、缺省false，与`resourceFormatBitDepth`独立；仅真实DSD读取、固定转换后端与有界缓存全部可用时为true。服务端能力、客户端显式采纳、真实DSD源、有效FLAC目标四项同时成立才允许新mode，覆盖ready、preparing及failed全部状态。旧客户端没有采纳字段时，在转换前返回原409 UNSUPPORTED_FORMAT，转换器调用数为零，不发含新mode的202或failed。

两个封闭请求分支均可带`acceptedProcessingModes:["dsd_to_pcm"]`，不可null、空数组、重复或其他mode。DSD请求仍采用`quality.profile=auto`、`allowLossyFallback=false`、`preferredTransport=file`，不增加profile、多档或动态切换。服务端按原server/device/session及能力快照绑定许可；幂等正文包含这个列表。改变声明需要新intent及新key。

`resourceFormatBitDepth=false`而`resourceDsdToPcm=true`时，使用原base请求，不发送`maxBitsPerSample`。客户端采纳的固定DSD mode明确接受24-bit/48kHz PCM→FLAC；仅这条DSD路径可在没有位深字段时接受24-bit输出。`formats`仍须包含codec=`flac`、container=`flac`、maxSampleRateHz至少48000、maxChannels覆盖实际源声道；缺项、低采样率上限、低声道上限或显式位深上限不足24均拒绝。普通PCM沿原位深协商/回退，不因该DSD声明放宽。

## 闭合音频事实

`sourceAudio.codec`固定`dsd`，`container`固定`dsf`或`dff`；三轴必填：`sampleRateHz`为实际1-bit调制时钟，`bitsPerSample=1`，`channels`为实际1至6声道。支持时钟集合为2822400、3072000、5644800、6144000、11289600、12288000、22579200、24576000Hz。超出集合或声道范围返回UNSUPPORTED_FORMAT；不默默降规格或downmix。DSF/DFF及编码事实必须来自真实只读FD的完整容器准入及当前来源证明，不能由扩展名猜测；压缩DST本阶段不准入。

解码器的PCM采样率不能冒充DSD时钟，源MHz不受原PCM格式上限768000Hz限制。实际ready产物三轴全部必填：`actualAudio.codec=flac`、`container=flac`、`sampleRateHz=48000`、`bitsPerSample=24`、`channels=sourceAudio.channels`；transport=file、seekable=true。非DSD不得使用新mode，DSD不得以direct/remux/lossless_conversion/resample伪装。真实物理audio route另取证，不称原生或无损DSD。

原FLAC继续lossless+false，源与实际传输采样率、位深、声道全部相等，最低24-bit/192kHz并保留原16/24-bit与24/44.1矩阵。该路径不进入DSD转换。

## 同资源事实与原回执

同一resource的sourceAudio、实际产物actualAudio、processing.mode、processing.reason、已知durationMs及seekable在GET/renew保持稳定。DSD reason固定“DSD整曲转换为24-bit/48kHz PCM并编码独立FLAC。”；它不包含缓存解释。`fromPreparedCache`只反映实际合格缓存复用，可在准确证据支持下变化；不允许借此更换产物、音频参数或reason。原url/票据到期可以按原规则更新。

preparing没有media，不预填长度或实际产物规格；整曲转换完成、实际成功退出及产物核验全部成立后才ready。原创建202的ack、body和key永远是原回执，重复POST及UNKNOWN恢复不得升级为201。GET读取当前状态；renew继承原创建正文和已采纳mode许可，不能丢失许可，也不能为旧资源重新引入许可。GET不续期，GET/renew均不能让terminal资源复活。

## 独立准备与原期限

私有Owner短begin/status管理独立有界后台job；短begin只捕获真实源身份和音频事实，不在原10秒Main/Owner RPC内等待整曲转换。完整源hash、转换及产物核验在后台完成后才准入ready。普通PCM的准备等待继续原规则；元数据请求15秒/2MiB、原resource/orphan五分钟、session三十分钟、媒体建立10秒/idle5秒、64KiB背压及60秒绝对票据均不放宽。

本阶段DSD使用同entry总预算240000ms，结束点取本阶段总预算与原resource/session剩余期限的最早值。服务端从原resource创建窗口消费剩余时间，短begin、整份hash、转换、产物核验均计入此窗，预留10000ms确认进程、FD和I/O静止；不得在Owner begin结束后另给转换完整240000ms。iOS仅对已采纳的DSD整曲准备使用同一240000ms上限，并继续同时使用原单调和墙钟限制：第一次entry准备即开始计时，协商、UNKNOWN创建恢复、原202、轮询、缓存命中及renew都不重新分配或重置预算。双方各自的已耗时及真实剩余期限继续取更紧边界；客户端取消仍由原release等待服务端静止。不得在截止后复活或签票。普通PCM原120000ms双时钟等待不变。

转换首次只能等整曲合格后首播，后续按准确缓存事实复用。缓存由原唯一Owner管理独立私有目录：一个转换job、最多四个等待resource、32个entry、单entry最多2GiB、总量最多4GiB。key绑定dataset、真实源身份、整份SHA、固定处理参数和后端身份；活动entry不可驱逐。原文件和标签只读，前后身份、长度与整份SHA一致才合格；不完整、损坏或来源已变产物不可注册ready。

release、取消、撤销和退出等待实际子进程close、FD及在途I/O静止后才回执。无法确认静止时保留占有及失败状态，不伪造quiet。真实iPhone播放、seek、必要续租/断线恢复、释放与实际route分别取证，可在同一轮证据映射原六项加新增六项12个验收ID；软件和真机层不互相代替，002原carryover保持。
