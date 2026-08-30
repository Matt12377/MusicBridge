# ADR-014：授权目录、只读源证据与可恢复校验任务

状态：TASK-054 实现；真实源目录样本、最终 Freeze/编译输入复核仍待后续 Gate。

## 决策

源文件选择由 Main 原生目录/文件选择器承接。Renderer 只提交本地 Root、Draft、Track UUID 和明确的取得方式；绝对路径只经内部 Main→Core 通道进入本地源仓库。Root 能力记录规范路径、设备与目录身份。撤销授权不删除文件或历史，Root 离线和单文件丢失分别报告。

Schema 6 在既有 SQLite 中加入 Root、Binding、Draft Link、Job 和不可变 Source Ledger。绑定内容 SHA-256 与定位分开：新文件产生新内容身份；明确重新定位且完整 Hash 相同才复用身份，并追加定位/证据快照。人工确认必须针对当前草稿曲目和当前绑定；相似歌曲元数据、Roon 运行引用、歌词签名、导出方式均不能替代完整文件证据。

后台校验最多两个并行任务，有稳定命令编号。重复调用返回原任务；查询恢复无需重新打开文件选择器。取消和撤销授权先提交终态，再拒绝迟到结果。数据库暂时拒绝结果写入时，Core 保留待补记失败并阻止新的校验；恢复后只补记失败，不重读音频。Core 重启把未完成任务标记为 interrupted，不自动重放。关闭面板不会取消任务。通用跨应用 outbox 尚未实现；源任务本身及回执已持久化，不能据此宣称所有库存操作已实现 outbox。

## 文件读取与参数边界

Core 检查 Root 身份、路径点段、目录归属、全部中间组件和最终普通文件；拒绝符号链接。用 O_RDONLY/O_NOFOLLOW 打开，比较打开前、FD 和路径身份，再按 1 MiB 分块 Hash。完成后再比对文件大小、设备、inode、mtime、ctime；提交前再次检查 Root、当前文件和草稿归属。此模块不写入用户音频。

完整 Hash 最多处理 64 GiB，循环读取期限 15 分钟；取消停止后续读取并拒绝结果，不承诺强行终止操作系统中已经挂起的网络文件 I/O。头部缓存最多 16 MiB、技术块遍历最多 2048 个。仅将有界 WAV fmt/data、AIFF COMM/SSND、FLAC STREAMINFO 技术块交给固定 music-metadata 11.15.0（MIT）；用户标签、封面和文本不进入解析器。WAV 时长由真实边界内数据块的帧数和采样率计算，避免 Buffer 探测器按缓存长度裁短时长。

首批支持标准 PCM/IEEE float WAV、未压缩 AIFF 和 FLAC 技术探测。RF64、扩展 WAV、AIFF-C、ALAC、MP3、DSD 及尚未支持的转换明确阻断。完整 Hash 证明已读取的文件字节；技术头部探测不等于逐帧解码、音频载荷 Hash 或声学指纹验证。后续执行编译需实际解码并校验输出，不能把当前技术探测当作已完成执行认证。

公开绑定分别提供 Acquisition、Verification、Preservation、Availability、修改时间、校验时间和人工确认状态。当前 Preservation 仅 externalReferenceOnly，不宣称音频已被归档。SourceLockEligible 是当前可访问、身份未变且技术/Hash/映射齐备的展示条件；它不是已冻结状态。最终 Freeze/编译必须再次核对完整输入 Hash。

## 未解决边界

原件同一性不从 Roon Desktop Export 推导。Source Picker 的实体/数字关联入口仍需集成。F-01 执行资产长期保留策略、Gate B 输出认证、归档/备份及真实 Source Root/Owner 验收不在此 ADR 中推定通过。
