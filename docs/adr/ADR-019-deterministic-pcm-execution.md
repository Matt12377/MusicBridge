# ADR-019：显式执行格式与 PCM 编译内核

状态：TASK-059 实施；不代表 Gate B、F-01 或正式录音批准。

## 决策

`ExecutionFormat` 完整保存采样率、声道布局、内部精度、输出样本格式、SRC 实现/版本、dither、声道映射、输出后端/版本和 Profile 版本。不从 V2 播放状态推断，不默认选择系统扬声器，不把任意 backend 字符串当作已认证实现。

`planDirectExecution` 校验 Frozen M/L 的引用、内容 Hash、时间线 Hash、逐曲源绑定与 Gap。执行时基可与规划时基不同：音乐帧来自真实源，Lead-in/Gap/Tail 以整数有理数换算，默认五秒严格为 Fs×5。规划时基换算不是 SRC；源的采样率、声道、位深与执行格式不相同时明确要求转换。源自身首尾静音不裁剪，面尾不加曲间 Gap，空 B 仅保留零帧配方，不生成 WAV。

`planPreparedExecution` 重新核对 PREP 与 M/L/Planned/Render Timeline、原始资产及人工 Marker 的一致性，保留已接受的实际时间线。格式符合时只包含整个原始 Render 的单段引用，禁止追加 Gap；不符合时拒绝并要求后续独立 Derivative。旧 PREP 不被改写。

首个内核 `musicbridge-pcm-copy-v1` 支持 RIFF/WAVE 的整数 PCM 16/24/32 bit、mono/stereo、相同输入输出格式。只做字节保持拼接与数字零填充，无响度、EQ、压缩或 dither。浮点、压缩、RF64、WAVE_FORMAT_EXTENSIBLE、SRC、声道与位深转换仍未实现，明确返回有界错误；混合源/DSD 不从完整 V3 范围删去。

WAV 逐块验证 RIFF 长度、fmt/data 唯一性、采样率、声道、位深、块对齐和字节率；接受合法的块顺序和奇数字节填充。未知普通元数据块跳过、不解析标签；wavl/slnt/fact 及未知编码拒绝。最多 2048 块，不将文件全部读入内存。参考 [Microsoft RIFF 格式](https://learn.microsoft.com/en-us/windows/win32/xaudio2/resource-interchange-file-format--riff-) 对块长度、WORD 填充及 fmt/data 的定义。

## 文件与证据边界

Core 内部只读句柄租期验证完整输入 SHA-256、文件身份及授权；编译读取同一个只读句柄，完成后核对 stat 与定位。全部输入的格式预检在写目标之前；正式复制时再次完整 Hash。输出句柄必须是上层排他创建的空普通文件、单硬链接且不与源同 inode。内核不接收公开输出路径、不创建目录、不发布资产、不删除半成品。

每个写循环支持短写并检查取消；文件 fsync 后完整回读 SHA-256、PCM Hash、大小、规格及帧数，之后核对授权与文件状态。执行配方和回执只含匿名身份、版本与技术字段，无源路径、内部句柄或在线 URL。`formalReady` 始终 false。相同配方和源产生相同字节与回执；上层幂等命令/数据库事务仍须另行实现。

十五分钟是应用循环期限，不是对操作系统阻塞 I/O 的硬实时保证。Node 路径/句柄检查不宣称对同用户恶意并发提供原子沙箱。原件内容、mtime、ctime 不改写；不承诺文件系统 atime 不变。取消/撤权/失败不返回成功资产，不自动清理目录。

## 后续

接入持久化编译任务、原生目标授权、owned staging/发布、恢复/隔离、桌面确认，以及显式 Profile/Overrides。再扩展已选且可验证的解码/SRC/Derivative 路径。只有满足 F-01、Archive Policy、资产发布、Physical Copy、Profile Snapshot 和 Gate B 后端认证，才可冻结正式 RecordingPlan。播放与三层完成确认另有状态机；本内核没有实际音频输出，也没有停止延迟证据。
