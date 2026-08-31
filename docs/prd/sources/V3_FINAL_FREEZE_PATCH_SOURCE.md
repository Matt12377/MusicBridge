完全同意。**v0.3 目前仍应保持 `FREEZE_PENDING`，不能按上一版文字直接冻结。**这四处不是措辞优化，而是分别修正了数据建模、正式播放、版本谱系和归档恢复四个基础合同。

下面这套可以作为 **v0.3 最终冻结补丁**。

# 1. 数字源证据改成多维状态，不再使用互斥“证据等级”

原来的：

```text
ROON_REFERENCE
VERIFIED_FILE
ARCHIVED_SOURCE
IMPORTED_EXPORT
```

确实混合了不同维度，应删除这个互斥枚举。

正式对象改为：

```text
DigitalSourceBinding
├─ Reference
├─ Acquisition
├─ Verification
├─ Preservation
├─ Availability
└─ Relationship / Provenance
```

## 1.1 Acquisition Method：文件怎么来的

```text
SOURCE_ROOT_SCAN
USER_FILE_BIND
ROON_DESKTOP_EXPORT
USER_IMPORT
DAW_RENDER_IMPORT
ARCHIVE_RESTORE
```

`ROON_DESKTOP_EXPORT` 只表示获得方式，不代表已经验证，也不代表已经归档。

## 1.2 Verification State：文件验证到什么程度

```text
UNVERIFIED
TECHNICAL_METADATA_PROBED
FILE_HASH_VERIFIED
AUDIO_PAYLOAD_VERIFIED      // 可选增强
```

其中：

* `FILE_HASH_VERIFIED`：已读取完整文件并计算字节级 Hash；
* `AUDIO_PAYLOAD_VERIFIED`：进一步验证音频载荷，避免仅标签变化导致不同文件 Hash；
* 声学指纹只能用于找候选，不升级为档案级验证。

## 1.3 Preservation State：文件保存在哪里

```text
EXTERNAL_REFERENCE_ONLY
ARCHIVED_EXACT_FILE
ARCHIVED_DERIVATIVE
```

例如：

```text
Acquisition       = ROON_DESKTOP_EXPORT
Verification      = FILE_HASH_VERIFIED
Preservation      = ARCHIVED_EXACT_FILE
Availability      = ONLINE
```

这些状态可以同时成立，不再互相排斥。

## 1.4 Availability State

```text
ONLINE
SOURCE_ROOT_OFFLINE
MISSING
CONTENT_CHANGED
```

网络盘暂时离线只能标记为：

```text
SOURCE_ROOT_OFFLINE
```

不得直接判定源文件丢失。

## 1.5 Roon 关系单独保存

还应单独记录：

```text
RoonRelationship
├─ NONE
├─ CANDIDATE
├─ USER_CONFIRMED_COUNTERPART
└─ USER_CONFIRMED_PROVENANCE
```

一份通过 Roon 桌面导出的文件，经过 Hash 验证后，可以成为**本次录音的精确输入文件**；但除非另有证据，不能宣称其文件字节与 Roon Watched Folder 中的原文件完全相同。

## 1.6 Source Lock 改成计算条件

不再看某个单一“等级”，而是满足：

```text
SourceLockEligible =
    concrete_file_bound
    AND availability == ONLINE
    AND technical_metadata_probed
    AND file_hash_verified
    AND track_mapping_user_confirmed
    AND content_not_changed
```

因此：

* 只有 Roon Browse 引用：可以加入 Draft、试听，不可 Source Lock；
* Roon 导出文件但没验证：不可 Source Lock；
* Roon 导出文件已 Hash、技术信息已读取、用户确认版本：可以 Source Lock；
* 已验证并归档：既可以 Source Lock，也能长期重建。

---

# 2. 正式录音冻结“执行格式”和帧级时间边界

这一点我建议进一步收紧：

> **Formal Recording 不应在运行时逐首切换和临时转换文件，而应播放已经编译并验证的 Execution Asset。**

这样 Direct 和 Logic 两条路径最终都进入同一个确定性执行层。

```text
Direct Master
     ↓
Compile Execution Asset
     ↓
SIDE-A.execution.wav
SIDE-B.execution.wav
```

Direct 路径中的“Compile”不做响度、EQ、压缩或母带处理，只做：

* 解码；
* 必要的固定采样率转换；
* 固定声道映射；
* 拼接；
* 插入精确 5 秒零样本；
* 生成帧级 Manifest。

Logic 路径则是：

```text
Logic SIDE-A.wav / SIDE-B.wav
        ↓
格式符合执行计划：直接使用
格式不符合：生成明确记录的 Execution Derivative
```

原始 Logic Render 永远保留，不被执行派生文件覆盖。

## 2.1 Recording Execution Format

每个 `RecordingPlanVersion` 必须冻结：

```text
sample_rate
channel_count
channel_layout
internal_processing_precision
output_sample_format
resampler_implementation
resampler_version
dither_policy
output_backend
output_profile_version
```

同一 Side 或同一个 DAT Continuous Program 中：

> **不得中途改变采样率或声道布局。**

不同源规格统一在 Execution Asset 编译阶段转换，并在谱系中记录：

```text
Original: DSD64
↓
Execution Conversion: PCM 24/96 Stereo
↓
Execution Asset
```

## 2.2 5 秒的帧级定义

Direct Compilation 的间隔正式定义为：

```text
silence_frames = sample_rate × 5
```

例如 96 kHz：

```text
480,000 frames of digital zero
```

必须按音频帧计算，不能使用 UI 定时器或“等待约五秒”。

仍然遵循此前规则：

> 不自动裁剪源文件自身的开头或结尾静音。

因此听感上的安静时间可能是：

```text
源歌曲尾部静音
+ 精确 5.000 秒数字零
+ 下一首开头静音
```

要控制实际听感间隔，则走 Logic Prepared Path。

## 2.3 中止延迟拆成四个指标

正式记录：

```text
T_detect
故障实际发生 → MusicBridge 识别

T_engine_cutoff
识别故障 → 引擎停止提交新音频帧

T_backend_tail
引擎停止提交 → 输出端真正无声

T_physical_stop
输出异常 → 用户停止实体录音机
```

建议冻结以下产品合同：

```text
T_engine_cutoff ≤ 100 ms
```

对于一个可标记为：

```text
Formal Recording Certified
```

的输出后端，Gate B 必须测得：

```text
T_total = T_detect + T_engine_cutoff + T_backend_tail
absolute tested maximum ≤ 2000 ms
```

同时保存：

* P50；
* P95；
* P99；
* Maximum；
* 测试环境；
* 缓冲配置；
* 后端版本。

任何后端如果无法得到稳定、有限且不超过验收上限的结果：

> 不得作为 Formal Recording 的认证输出后端。

Roon 的公开 Transport 合同提供 Zone/Queue 订阅和 play、pause、stop 等控制，并写明 stop 会停止播放和释放设备，但公开合同没有提供录音独占锁或排他租约。因此不能仅凭发送 `stop` 就承诺端到端独占与停止时间，必须经过 Gate B 实测；如果实测不合格，Roon 后端只能是非认证路径，正式录音默认改用通过认证的本地输出后端。([Roon Labs][1])

## 2.4 三种“停止”不能混为一谈

故障发生后，MusicBridge只能自动证明：

```text
EngineStoppedSubmittingFrames
```

输出后端何时真正无声，需要测量。

实体磁带机是否已经停止，软件无法自动证明，必须由用户确认：

```text
PhysicalRecorderStopped = UserConfirmed
```

异常提示不能通过正在录音的音频通路发出，否则提示音也会被录进去。应使用：

* 屏幕高优先级警告；
* 系统通知；
* 可选的独立提示设备。

任何异常均使：

```text
RecordingAttempt = Interrupted
```

即使随后成功停止，也不能自动恢复成 `Completed`。

---

# 3. 区分计划时间线与 Logic 最终 Render 时间线

正式增加两个不同对象：

```text
PlannedTimelineManifest
```

和：

```text
RenderTimelineManifest
```

## 3.1 Planned Timeline

由 `MasterVersion + LayoutVersion` 生成，保存：

```text
track_id
source_binding_id
side_or_segment
expected_start_frame
expected_end_frame
expected_gap_frames
lead_in_frames
tail_rule
total_frames
```

它描述：

> 原计划怎么排。

## 3.2 Final Render Timeline

Logic 导回以后，必须建立：

```text
render_file_hash
render_sample_rate
render_channel_layout
render_total_frames

track_id
actual_start_frame
actual_end_frame
actual_gap_to_next_frames
marker_confirmation_method
user_confirmed
```

它描述：

> 实际导出的 WAV 里面怎么排。

## 3.3 导入时生成 Conformance Report

```text
RenderConformanceStatus
├─ MATCHED
├─ ACCEPTED_VARIANCE
├─ REQUIRES_NEW_LAYOUT
├─ REQUIRES_NEW_MASTER
└─ REJECTED
```

规则如下。

### MATCHED

* 曲目一致；
* 顺序一致；
* Side 分配一致；
* 实际位置在容差内；
* 总时长可容纳。

### ACCEPTED_VARIANCE

例如用户在 Logic 中：

* 调整 Fade；
* 修改几秒间隔；
* 轻微改变曲目起止点；

但：

* 曲目未替换；
* 全局顺序未改变；
* Side 分配未改变；
* 仍适配选定介质。

此时保留原 `LayoutVersion`，但正式录音以：

```text
RenderTimelineManifest
```

为执行事实。

### REQUIRES_NEW_LAYOUT

以下情况必须建立新 Layout Version：

* A/B 分界改变；
* 曲目换到另一面；
* 总时长不再适配原介质；
* Lead-in/Tail 规则发生结构性变化；
* C90 改为 C60×2。

### REQUIRES_NEW_MASTER

以下情况必须建立新 Master Version：

* 全局曲序改变；
* 替换曲目；
* 增删曲目；
* 更换 Exact Digital Source；
* 把某个 Live 版本换成 Studio 版本。

## 3.4 如何确认实际曲目标记

V3.0 不应假装可以只靠文件总时长自动证明全部内容正确。

Logic 导入验收至少提供：

1. MusicBridge 显示计划 Marker；
2. 用户在最终 WAV 时间线上校正实际开始点；
3. 系统可用波形、时长或声学匹配提出候选；
4. 候选不能自动变为档案事实；
5. 用户确认后冻结 `RenderTimelineManifest`。

以后可以增加 DAW Marker Sidecar 导入，但 V3.0 不依赖该自动化才能工作。

## 3.5 旧 PREP 的有效性规则

`PREP-001` 永久绑定：

```text
Master M1
Layout L1
Planned Timeline P1
Final Render Timeline R1
```

如果当前项目变成：

```text
Master M1
Layout L2
```

UI显示：

```text
PREP-001
Valid for M1 / L1
Not compatible with current L2
```

不能显示为全局 `Invalid`。

它仍然：

* 对原 L1 有效；
* 对已经完成的历史录音有效；
* 可以继续播放历史 Digital Replica；
* 不能被新 Layout 误用。

---

# 4. 增加 Gate E：Archive Recovery

这一项必须进入开工前技术 Gate。SQLite 的事务可以保证数据库内部提交的原子性，但它不会自动把“外部音频文件已经移动到正式目录”和“数据库记录已经提交”变成一个跨资源原子事务；WAL 本身也属于数据库持久状态的一部分。因此 MusicBridge需要自己的、可重复执行的归档恢复协议。([SQLite][2])

## 4.1 Archive Operation 状态机

每次归档建立稳定 `operation_id`：

```text
INTENT_WRITTEN
↓
STAGED
↓
VERIFIED
↓
PROMOTED
↓
DB_COMMITTED
↓
FINALIZED
```

### INTENT_WRITTEN

持久化操作清单：

* 目标对象；
* 预期 Hash；
* 源位置；
* 目标 Content Address；
* 关联 Master/Layout/PREP；
* 恢复动作。

### STAGED

复制到临时区，尚不可被正式 Recording 引用。

### VERIFIED

完成：

* 文件长度检查；
* Hash；
* 格式解析；
* Manifest 验证；
* 磁盘同步。

### PROMOTED

文件已进入正式 Content Store，但数据库可能尚未提交。

### DB_COMMITTED

SQLite 事务已经写入正式对象关系。

### FINALIZED

清理 staging 和操作残留，操作结束。

## 4.2 启动恢复规则

MusicBridge 启动时扫描未完成操作。

### 崩溃发生在 STAGED / VERIFIED

* 正式数据库不得引用该文件；
* 可继续复制或清理 staging；
* 不产生 Frozen Prepared Master。

### 文件已 PROMOTED，但数据库未提交

这是用户指出的关键窗口。

恢复器必须：

1. 读取持久化 Operation Manifest；
2. 验证正式文件 Hash；
3. 幂等完成数据库提交；
4. 或将对象移入 Quarantine；
5. 绝不能重复增加记录或库存数量。

### 数据库已提交，但尚未 FINALIZED

* 验证正式对象存在且 Hash 正确；
* 完成清理；
* 标记 FINALIZED。

### 数据库引用存在，但文件缺失

不得静默继续。

标记：

```text
ArchiveRecoveryRequired
```

并阻止依赖它的 Formal Recording 或 Digital Replica。

## 4.3 恢复必须幂等

同一个恢复动作运行：

```text
1次
2次
10次
```

最终结果必须完全相同：

* 不重复创建 Prepared Master；
* 不重复增加 Physical Copy；
* 不重复生成 Recording；
* 不产生第二份 Content Object；
* 不覆盖用户已完成的数据。

## 4.4 Gate E 测试矩阵

Gate E 至少验证：

| 故障注入点                          | 验收结果                       |
| ------------------------------ | -------------------------- |
| 开始复制前磁盘已满                      | 不产生正式对象                    |
| 复制中磁盘写满                        | staging 可恢复/清理             |
| 复制过程中强制结束进程                    | 重启后不出现半成品                  |
| Hash 完成后崩溃                     | 可继续 Promote 或清理            |
| Rename/Promote 后、DB Commit 前崩溃 | 可幂等补交数据库                   |
| DB Commit 后、清理前崩溃              | 重启后完成 Finalize             |
| 同一恢复重复执行                       | 结果不重复                      |
| Archive Root 中途断开              | 归档失败且源文件不受影响               |
| 文件 Hash 不符                     | Quarantine，不冻结             |
| 完全相同文件重复导入                     | 内容寻址去重                     |
| 备份后恢复                          | Master/PREP/Recording 关系一致 |
| 恢复后再次执行备份还原                    | 不重复、不丢关系                   |

## 4.5 备份规则

不能只复制一个正在使用的 SQLite 主文件。

备份应使用：

* SQLite Backup API；或
* 应用进入 quiescent 状态后的一致性快照；
* 同时备份 Archive Manifests 与 Content Store 索引。

如果使用 WAL，必须按 SQLite 的一致性要求处理数据库及其相关状态，不能把活跃数据库主文件和 WAL随意拆开复制。([SQLite][3])

---

# 更新后的开工 Gate

v0.3 的 Gate 正式变成：

```text
Gate A
Source Evidence

Gate B
Deterministic Recording Playback

Gate C
Inventory Ledger

Gate D
Version Lineage

Gate E
Archive Recovery
```

其中 Gate B 需要新增验证：

* 固定 Execution Format；
* 帧级 5 秒零样本；
* 固定采样率与声道；
* 转换器版本可追溯；
* `T_detect / T_engine_cutoff / T_backend_tail / T_total`；
* Roon 外部切歌；
* Zone 改变；
* 设备断连；
* 引擎崩溃；
* 输出后端认证结果。

Gate D 需要新增验证：

* Planned Timeline 与 Final Render Timeline 分离；
* Logic 修改 Fade/Gap 后必须重新验收；
* PREP只对绑定的 M/L 有效；
* 旧 PREP 对历史关系永久有效；
* 改 Side 分配产生新 Layout；
* 改全局顺序产生新 Master。

# 冻结结论

这四点应全部接受。修正后，v0.3 的核心合同会变成：

> **来源证据是多维组合，而不是等级标签；正式录音以固定格式、帧级时间线和经过认证的输出后端执行；Logic 导出的实际时间线必须独立验收；文件系统与数据库之间的归档提交必须可崩溃恢复且幂等。**

在上述文字并入正式 PRD、Gate A～E 的验收条件写入 Development Pack 后，**v0.3 才适合标记为 Frozen**。就目前讨论到的范围看，这四处补齐后，已经没有我能看到的同级产品架构阻断项；后续不确定性主要应通过五个 Spike/Gate 实测解决，而不是继续靠文档假定。

[1]: https://roonlabs.github.io/node-roon-api/other_node-roon-api-transport_lib.js.html "JSDoc: Source: other/node-roon-api-transport/lib.js"
[2]: https://www.sqlite.org/atomiccommit.html "Atomic Commit In SQLite"
[3]: https://www.sqlite.org/wal.html?utm_source=chatgpt.com "Write-Ahead Logging - SQLite"
