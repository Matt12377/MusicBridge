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

## 隔离生命周期内核（TASK073第三阶段）

在独立`native/output-lifecycle/`开发单次会话控制层，复用原FramePump，但不纳入现有synthetic构建、源码pin或应用包。Driver仅显式注入，唯一可执行实现属于测试；没有设备ID、系统API或正式输出入口。未来接入真实HAL必须另行实现、审查、重建和更新pin，不能用当前helper身份覆盖新模块。

Session独占Driver及预分配回调上下文/帧泵，不允许复制或移动。控制API仅由一个非实时控制线程调用；维持FramePump的单生产者/单消费者约束，回调不能并发或重入pull，实时侧不调用driver控制操作、不分配或等待锁。

停止请求回执与回调静止分离。Driver的非实时`shutdownAndJoin() noexcept`必须先封闭新回调入口，再等待全部已派发回调退出，包含已取得上下文但尚未进入回调计数的窗口。瞬时inFlight为0、stop ACK或普通清理超时都不是静止证明。Session析构先停止供帧并经过该屏障，之后才释放上下文；部分注册/启动失败也不能跳过屏障。测试Driver以真实线程join兑现，而不是靠泄漏、detach或终止进程规避生命周期。

常规清理超时保留cleanupPending，析构屏障不承诺硬件有界延迟。真实HAL的stop/destroy是否满足此契约仍未证明。FakeDriver证据只覆盖被实现的同步和资源顺序，源帧消费结束不等于设备排空或实体录制完成；Gate B仍NOT_RUN。
