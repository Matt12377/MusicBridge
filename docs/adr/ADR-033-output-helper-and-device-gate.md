# ADR-033：共享帧泵、固定输出helper与设备Gate隔离

## 决策

TASK073先建立无设备可执行的synthetic helper与共享C++FramePump，CoreAudio HAL适配只编译为独立object。synthetic链接集合不含HAL object/CoreAudio框架；没有可由Renderer/环境变量切换的设备模式。实际设备入口及认证需要后续明确授权和测量证据。

Core只从已冻结Plan和私有已核验执行目录选定唯一Side/Program文件，保留只读FD至helper关闭与租期末验证。固定二进制协议控制帧泵，实际消费PCM hash与frameCount吻合才能回报无设备检查通过。普通在线播放、Roon、系统扬声器、FFmpeg转换器均不进入此路径。

文件核验、协议解析、哈希与日志在非实时层；未来HAL回调仅调用同一有界预分配帧泵，无文件I/O/动态分配/锁等待。编译期和加载期分别绑定清单与binary/hash，发布不使用PATH或系统二进制回退。

源EOF、合成sink排空、驱动回执、实际输出端无声与实体设备完成人工确认是不同事实。无设备检查始终synthetic-only/deviceOpened=false，Gate B NOT_RUN，formalReady=false；它不是持久admission，也不能提高旧Plan认证状态。

## 证据来源与限制

本机SDK头核对及Apple官方API文档用于编译适配；AudioDeviceStop只承诺停止指定IOProc，不能由此推断输出端无声：
- https://developer.apple.com/documentation/coreaudio/audiodevicestop(_:_:)
- https://developer.apple.com/documentation/coreaudio/audiodeviceioproc

明确设备、格式/缓冲/驱动版本、独立时基与无声判据以及B01～B15故障样本尚待Owner授权；本阶段不枚举或打开真实设备。Prepared经SRC的逐marker精确映射不得简单比例伪造，后续必须有转换映射证据或明确未核验。
