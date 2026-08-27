# ADR-018：原始 Render、人工时间线与 Frozen PREP

状态：TASK-058 本地实现及自动 Gate 通过；完整 PRD Gate 与 Owner 验收尚未完成。

## 背景与边界

TASK-057 的 Logic 工作区是允许编辑的副本，不能充当原始 Render 或执行资产。V3 PRD §17、附录 A3 要求原始 Render 独立保存，用户确认最终 WAV 的实际曲目标记后生成 Conformance，再冻结到既有 Master / Layout。新布局不反向作废旧 PREP。

本任务不生成 Execution Derivative，不控制 Logic，不开始真实录音，不关闭完整 Archive Gate E。执行派生资产的 F-01 保留策略仍未定；这不免除原始 Render 的保存责任。

## 决策

### 1. 原生文件选择仅授权一个 WAV

Main 原生选择器接收文件路径，Core 保存目录身份与确切相对文件名、选择时的 dev/ino/size/mtime/ctime。该能力不进入 Source Root 注册表，也不授权扫描相邻文件。公开合同只有选择编号、面别、文件名和授权状态。

选择后修改或替换文件会使该选择失效，必须重新选择。完整 Hash 与容器技术信息在预览时读取；确认保存时再次核对提案指纹，复制时验证源与目标全 Hash。文件创建时间优先使用文件系统 birthtime；不可用时记录首次观察时间，并明确标记证据类型，不伪称渲染时间。

V3 此切片仅接受有完整容器帧证据的单声道或立体声 WAV。Hash 与容器声明帧数不等于逐帧解码或声学内容验证。最终曲目与 Exact Source 由用户在 Logic 聆听核实并逐曲确认。

### 2. 原始 Render 独立保留

用户明确确认目标、音频容量及复制边界后，在已授权目标下创建 `MusicBridge-OriginalRender-<operation-id>`，内含 `Originals/A.wav`、`Originals/B.wav` 或 `Originals/Program.wav` 与 Manifest。

Cassette 的空 B 面不需要占位 WAV：只保存 A 面原件，RenderTimeline 的 B 面明确记录零帧、空 Marker、空文件身份与 `none` 声道，并采用计划时间基准。空面不得凭空新增伪造音频资产。

独占目录、随机操作归属标记、目录 dev/ino、无符号链接跟随、排他创建、文件 0600 / 目录 0700、完整目标 Hash、文件与目录 fsync 沿用工作区安全底层。工作副本与原始 Render 分别使用路径白名单，不允许交叉写入。应用不提供覆盖原始 Render 的操作；外部修改在重新核对时检出。

失败、取消、撤权及中断不自动删除目录。系统不把目录存在当作成功，也不清理用户文件。Node 路径检查不声称提供对同用户恶意并发文件系统操作的原子沙箱隔离。

### 3. 文件与数据库之间采用发布意图

SQLite schema 10 新增文件选择、导入任务、Frozen PREP 与幂等账本。顺序为：持久化导入意图 → 独占目录及逐文件进度 → 持久化预期文件/Manifest Hash → 验证并发布 Manifest → 数据库完成回执。

冷启动把未完成复制标为 interrupted，不重放复制。只有已发布 Manifest、操作归属和所有输出字节重新通过校验，且目标仍获授权，才补写完成回执；恢复不重读用户原始 WAV。已完成导入记录、Frozen PREP 与命令账本由不可变触发器保护。

同一命令的回执重试返回原结果；这代表历史操作身份，不代表现在重新验证了文件。新 PREP 冻结会重新核验原始保留副本。源选择撤权会停止读取/复制；保存目标撤权也终止正在进行的副本核对。

### 4. 实际时间线与保守匹配策略

RenderTimeline 独立记录每面的原始文件身份、采样率、声道、总帧数，以及每曲 trackId、Exact Source Hash、实际开始/结束帧、至下一曲 Gap、确认方法和用户确认状态。结束帧为不包含边界；Gap 必须与相邻边界一致。计划坐标只能初始化候选，不能自动成为事实。

策略 `one-render-frame-v1`：跨采样率用 BigInt 有理数比较，每个起点、终点、Gap 与总长允许最多一个 Render 帧偏差。介质容量严格比较，不享受容差。该策略是实现阶段的保守默认，Owner 仍须验收；未来调整应新增策略版本，不改写历史 PREP。

- MATCHED：已人工确认，同曲、同源、同全局顺序、同面，边界在容差内且容量适配。
- ACCEPTED_VARIANCE：上述身份与结构不变，容量适配；超出匹配容差的时间差异必须明确接受并填写原因。
- REQUIRES_NEW_MASTER：换曲、增删、全局顺序或 Exact Source 改变；用户直接声明内容改变也进入此态。
- REQUIRES_NEW_LAYOUT：面别或结构改变、容量不适配，不能被“接受差异”覆盖。
- REJECTED：未确认候选、无效/重叠 Marker、Render 身份不符，或时间差异尚未接受。

系统不通过总时长推断曲目内容。Fade 等未改变标记的处理仍通过处理谱系记录；本阶段不作自动声学认证。

### 5. 冻结与兼容性

Frozen PREP 永久保存 Master/ Layout、两份时间线及 Hash、Preparation 和导入任务身份、原始 Render 技术/Hash、DAW、处理谱系、Conformance 策略/状态与差异理由。只允许 MATCHED 或 ACCEPTED_VARIANCE 冻结。

Transition Rendering Mode 固定为 `Baked Into Render`。后续执行必须以已确认 RenderTimeline 为事实，不能再插一次 Gap。`executionReady` 始终为 false；输出认证、执行资产与录音许可属于后续任务。

“与当前版本兼容”是查询结果，不是修改旧 PREP 的状态。旧 PREP 对原 M/L 继续有效。当前草稿未保存的改动也不用于解释已冻结历史。

### 6. 桌面等待与授权撤销

Main/Preload 只暴露窄业务方法。预览、导入前复核、Conformance 核对和冻结可能读取两份大 WAV，使用独立的 35 分钟有界 IPC 窗口；每份完整 Hash 读取限 15 分钟。普通控制与撤销请求不扩大超时。

面板显示正在核对 Hash，并可明确撤销文件或保存目标授权来终止核对。文件实际复制是可查询、可取消的后台任务。模糊的变更回执保留原命令重试；本切片不宣称已经解决跨 Renderer 重启的通用 outbox 恢复。

## 验证状态

已建立领域、独立文件保存、完整 Core 流程、磁盘满/取消/撤权/回滚/冷启动恢复、IPC 路径隔离与长请求超时测试。桌面正式 Main/Core/SQLite 的 A/B 与空 B 面流程、局部视觉及完整 Playwright Gate 已通过。具体最终计数、失败修复与身份以 TASK-058_RESULT 为准，不能从本 ADR 推断 Owner 或真实录音验收。
