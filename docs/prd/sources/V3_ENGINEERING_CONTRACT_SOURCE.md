这份审查**全部成立**，而且其中第 1、2、3、5 点属于开工阻断项。原来的 PRD v0.2 适合作为产品需求基线，但还不能直接交给 Codex全面实现；应该先升级为 **PRD v0.3「数据真实性与录音执行合同」**。

最关键的架构修正是：

> **Roon负责音乐浏览、匹配和可选的输出通路；MusicBridge负责正式录音的精确源、时间轴、5 秒间隔和执行状态。**
>
> 正式录音不能把普通 Roon 队列或 Smart 播放直接当作权威源。

Roon Browse Item 当前公开合同确实只提供标题、副标题、图像键、Item Key、Hint 等浏览字段，没有原始文件路径、音频内容和文件 Hash；Roon 桌面端的 Export 能复制本地文件并按 Roon 信息写入标签，但这是桌面用户功能，不能推导为扩展 API 能直接获得原文件。([roonlabs.github.io][1])

# 一、建立正式的“数字源证据等级”

现有 `TrackSummary` 和 `LocalTrackSignature` 都不能承担档案级精确源证明。需要增加独立对象：

```text
DigitalSourceEvidence
```

建议分四级：

| 证据等级              | 含义                               | 可以做什么                                                        |
| ----------------- | -------------------------------- | ------------------------------------------------------------ |
| `ROON_REFERENCE`  | 只有 Roon Item 引用和元数据              | 浏览、试听、加入 Draft                                               |
| `VERIFIED_FILE`   | 已绑定实际文件并计算 Hash                  | Source Lock、Master Freeze、Logic Preparation、Direct Recording |
| `ARCHIVED_SOURCE` | 精确源文件已复制到 Recording Archive      | 可长期重建 Digital Replica                                        |
| `IMPORTED_EXPORT` | 用户从 Roon 桌面导出后交给 MusicBridge 的文件 | 作为“导出后的精确文件”使用，但不能宣称证明原始 Watched Folder 文件字节完全相同             |

## Roon Reference 能走到哪一步

只有 `ROON_REFERENCE` 时允许：

```text
选择歌曲
加入 Draft Master
浏览候选版本
试听
```

不允许：

```text
Source Lock
Master Freeze
Prepare in Logic
Formal Direct Recording
```

界面应明确显示：

> 尚未绑定可验证文件，不能冻结为精确数字源。

这比让用户以为已经保存了精确版本、几年后才发现只是一个 Roon Browse 引用安全得多。

## 实际文件怎么绑定

V3 增加只读的：

```text
Source Roots
```

用户选择本地或 NAS 音乐目录后，MusicBridge只读扫描，并记录：

```text
Root ID
Relative Path
File Size
Modified Time
Codec
Bit Depth
Sample Rate
Channels
Duration
SHA-256 File Hash
Audio Payload Hash（支持时）
Acoustic Fingerprint（仅候选匹配）
```

三个概念不能混：

* **文件 SHA-256**：证明是否为完全相同的文件字节；
* **音频内容 Hash**：尽量忽略标签差异，判断音频负载是否相同；
* **声学指纹**：只用于寻找候选，不能作为档案级精确证明。

现有歌词 `LocalTrackSignature` 继续用于原用途，不得重命名后冒充文件 Hash。

## 文件移动后的重新定位

自动重新定位只允许：

1. 在已授权 Source Roots 中扫描；
2. 找到完全一致的文件 Hash；
3. 自动更新路径引用。

如果只有：

* 文件名相同；
* 艺术家和标题相同；
* 时长接近；
* 声学指纹相近；

只能显示：

> 找到候选文件，请确认。

不得静默替换历史源。

网络盘临时离线时显示：

```text
Source Offline
```

而不是立即判断文件已经删除。

---

# 二、正式录音使用独立的确定性播放合同

需要把三个角色拆开：

```text
Source Authority
MusicBridge Recording Engine

Timeline Authority
Frozen Playback Manifest

Output Backend
Roon Bridge 或 Local CoreAudio
```

## 不再使用普通 Roon 队列作为正式音源

正式录音时禁止：

* Smart 自动换源；
* 网易云回退；
* Auto Radio；
* Shuffle；
* 普通播放队列续播；
* 自动寻找“相同标题”的替代曲目；
* 因本地播放失败而降级到在线版本。

正式录音的音频只能来自：

### Direct Path

```text
Frozen Exact Source Files
        ↓
MusicBridge Recording Engine
        ↓
Frozen Timeline + 5s Silence
```

### Prepared Path

```text
Frozen SIDE-A.wav / SIDE-B.wav
        ↓
MusicBridge Recording Engine
```

然后再送往输出后端。

## 输出可以通过 Roon，但Roon不能决定内容

推荐架构：

```text
MusicBridge Recording Engine
        ↓
现有 MusicBridge → Roon Audio Input / Bridge
        ↓
Pinned Roon Zone
```

本地开发或设备不支持时可以：

```text
MusicBridge Recording Engine
        ↓
Selected CoreAudio Output
```

V3.0 可以先完成一个正式后端，但播放引擎和 Output Backend 必须解耦。

Roon Transport API公开了 Zone 状态和 play/pause/stop 等控制，但没有“某次录音独占这个 Zone”的合同。由此可推断：其他 Roon 控制端仍可能改变同一个 Zone，因此 V3 必须监视状态变化，而不能假定拿到了排他锁。([roonlabs.github.io][2])

## 外部干扰的处理

以下任一事件发生时：

* 其他 Roon 控制端切歌；
* Zone 变化；
* Output 被移除；
* 音频设备断连；
* 采样率或输出路由意外改变；
* 文件读取失败；
* 音频 underrun；
* MusicBridge 崩溃；
* 网络中断导致源读取失败；

必须：

```text
立即停止或暂停安全输出
Recording Attempt → Interrupted
记录时间点与原因
禁止自动续播
```

用户排查并手动确认后，才能开始新的 Attempt 或在明确位置继续。

## 5 秒到底是什么意思

V3.0明确为：

> **Direct Recording 在两个源文件边界之间额外插入 5.000 秒数字零样本。**

它不自动分析、裁掉歌曲原文件自带的首尾静音。

所以：

```text
歌曲自身尾部静音
+
MusicBridge 额外 5.000 秒
+
下一首自身开头静音
```

可能产生超过 5 秒的听感间隔。

这是一个确定、非破坏性的规则。

需要精确控制“可听音乐结束到下一首可听音乐开始恰好约 5 秒”时，使用 Logic Prepared Path，由用户在 DAW 中修剪、Fade、排出最终间隔，然后将间隔标记为：

```text
Baked Into Render
```

MusicBridge不再额外添加。

## 软件完成与实体完成分离

每次录音至少保存三个状态：

```text
SoftwarePlaybackComplete
PhysicalRecordingConfirmed
FinalVerificationComplete
```

只有三者全部成立，Recording 才能进入：

```text
Completed
```

软件播放到文件末尾，只能证明：

> MusicBridge完整输出了时间轴。

不能自动证明：

> 磁带机确实录下来了。

后者必须由用户确认。

---

# 三、补齐完整版本依赖图

正式对象关系应调整为：

```text
MasterVersion
      ↓
LayoutVersion
      ↓
PlaybackTimelineManifest
      ↓
PreparedMasterVersion（可选）
      ↓
RecordingPlanVersion
      ↓
RecordingAttempt
      ↓
Completed Recording
```

## LayoutVersion 必须保存

```text
master_version_id
layout_version_id
target_media_format
target_capacity
side / segment assignment
每首曲目的开始时间
每首曲目的结束时间
每段 5 秒间隔
Lead-in
Tail
Side A / B 总时长
Timeline Manifest Hash
```

## Prepared Master 必须绑定具体 Layout

```text
PreparedMaster PREP-001

Master Version: M1
Layout Version: L3
Timeline Manifest Hash: ...
SIDE-A.wav Hash: ...
SIDE-B.wav Hash: ...
```

不能只写：

```text
Master v1
```

否则同一 Master 改成 C60×2 后，旧 C90 的 A/B Render 可能被误用。

任何 Layout 变化都会使旧 Prepared Master显示：

```text
Valid for Layout L3
Not valid for current Layout L4
```

不得进入 Recording Plan。

## Auto Balance 的版本规则

如果 Auto Balance 只是改变：

> A/B 分界点，但全局曲序不变

则创建：

```text
New LayoutVersion
```

如果 Auto Balance 改变：

> 任何歌曲在全局节目中的先后顺序

则必须先生成：

```text
Proposed MasterVersion M2
```

用户确认后才能冻结。

不能把“曲序变化”伪装成单纯 Layout 更新，绕过 Master Freeze。

---

# 四、库存改为正交状态 + 数量账本

## Wanted 不再是 Ownership 状态

应拆成：

```text
OwnershipStatus
Unknown / Missing / Owned

IdentificationStatus
Unidentified / Partial / Candidate / Verified

WantIntent
None / Wanted
```

`Wanted` 可以与 `Owned` 同时存在。

例如用户已经有：

```text
TDK SA 90 · 1990
```

因此 Collection Model 已经 `Owned`，但仍可能想补：

* C46；
* 更好品相；
* 未拆封；
* 另一个市场版本。

这时：

```text
Ownership = Owned
WantIntent = Wanted
Target = C46 / Sealed
```

完全合理。

## Inventory Lot 与 Physical Copy 用“转移”，不能相加

建议采用库存账本：

```text
Inventory Pool
        ↓ Transfer 1
Physical Copy
```

例如：

```text
TDK SA-X 90
Pooled Quantity = 8
```

实例化一盘：

```text
Pooled Quantity 8 → 7
Physical Copy MB-C-00427 +1
```

总拥有量仍然是：

```text
7 + 1 = 8
```

不能显示成 9。

Lot 应保存：

```text
quantity_acquired
pooled_balance
source_import
purchase_info
```

Physical Copy 保存：

```text
source_lot_id
physical_id
individual_state
```

所有数量变化通过 Ledger Transaction 完成：

```text
IMPORT
POOL_TO_COPY
COPY_TO_POOL（原则上少用）
DISPOSED
LOST
RETURNED
ADJUSTMENT
```

## Legacy Used 与总数关系

假设 Excel 一行：

```text
总数 10
已用 3
```

导入后应成为：

```text
Legacy Used — Unregistered = 3
Unclassified Remainder = 7
Total Owned = 10
```

那 7 盘不能因为备注为空就自动变为“未拆封空白”。

以后登记一盘旧录音：

```text
Legacy Used 3 → 2
Physical Copy MB-C-00427 +1
```

总数仍然是 10。

## 重复导入

每次导入建立：

```text
ImportBatch
Workbook SHA-256
Sheet Name
Row Index
Raw Row Hash
Normalized Row Signature
```

规则：

* 完全相同文件再次导入：直接识别为已导入，不产生新数量；
* 修改后的统计表：创建新 Import Revision，显示差异；
* 已经人工确认的 Edition、Physical Copy、状态和照片：绝不被新导入覆盖；
* 新导入只能提出更正建议；
* 用户确认数据的权威级别高于再次导入的原始表格。

---

# 五、正式定义档案完整度

“原始音乐只读”不等于“永远不能制作归档副本”。

它真正的含义是：

> MusicBridge不得修改原始音乐库，但可以在用户明确选择后，复制所用源文件到 Recording Archive。

Direct Recording 增加两种归档策略：

## Reference Dependent

```text
只保存路径、Hash和Source Snapshot
不复制源文件
```

优点：

* 节省空间。

风险：

* 原文件删除或内容变化后，Digital Replica无法完整重建。

此时必须显示：

```text
Source Unavailable
或
Source Changed
```

不得自动找同名歌曲替代。

## Preserve Exact Sources

```text
将本次使用的精确源文件复制到
Recording Archive Content Store
```

建议作为正式 Direct Recording 的默认选项。

这些文件：

* 内容寻址；
* 按 Hash 去重；
* 不会因为多盘磁带用了同一个文件而重复保存多份；
* 永久只读；
* 与原始音乐库完全分离。

这样仍然没有复制整个 Roon Library，只归档真正用于个人录音的源。

Prepared Path 则始终归档：

```text
SIDE-A.wav
SIDE-B.wav
```

所以天然是自包含的数字副本。

## 归档导入必须是原子的

Prepared Render 或 Source Bundle 导入流程：

```text
检查 Archive Root 可写
检查剩余空间和安全余量
复制到 staging
计算 Hash
验证文件
写临时 Manifest
原子重命名到正式目录
提交数据库索引
```

任何一步失败：

* 不产生 Frozen Prepared Master；
* 不产生半成品 Recording；
* 原始文件不受影响；
* staging 可清理或恢复。

## V3.0 必须包含的基础备份能力

不能全部推给 V3.x。

V3.0 至少需要：

* Archive Root 可用性检查；
* 磁盘空间预检；
* 数据库事务和启动恢复；
* `Backup Archive Now`；
* 从备份恢复数据库与 Manifest；
* 扫描 Manifest 重新建立基本索引的能力；
* 崩溃后将未结束 Recording Attempt 恢复为 `Interrupted`。

定期全量 Hash 巡检和漂亮的健康 Dashboard仍然可以放到 V3.x。

---

# 六、修正 Preflight、DAT 和参考目录版本

## Direct 与 Prepared 分支 Preflight

公共检查：

```text
Master Version Frozen
Layout Version Frozen
Physical Copy Bound
Recording Profile Snapshot Ready
Archive Root Available
Output Backend Ready
```

Direct Path额外检查：

```text
Exact Source Files Verified
Playback Manifest Valid
No Smart / Fallback
Archive Policy Satisfied
```

Prepared Path额外检查：

```text
Prepared Master Valid
Master + Layout IDs Match
Timeline Manifest Hash Match
Render Hash Match
```

所以不再统一要求：

```text
Prepared Master Valid
```

## DAT 的 V3.0 最小完整流程

DAT不能只挂一个名字。

至少需要：

```text
DAT Continuous Layout
```

保存：

* 单个连续 Program；
* 总时长；
* Lead-in；
* 目标 DAT 容量；
* Recording Mode / Sample Rate；
* Recorder Compatibility；
* 可选 Track Cue List；
* 多盘 DAT 时的 Segment Split。

Prepared DAT：

```text
CONTINUOUS.wav
```

Direct DAT：

```text
Frozen Continuous Playback Manifest
```

Formal Recording 流程：

```text
Preflight
→ Begin DAT Recording
→ Continuous Playback
→ Playback End
→ User Confirms Recorder Stopped and Tape Completed
→ Final Verification
```

V3.0 可以提供 Index/Cue 提醒，但不宣称能自动向 DAT 机器写 Track ID，除非具体硬件通路以后被验证。

## 参考书和目录版本

需要两个不同版本对象：

```text
ReferenceSourceVersion
CatalogRevision
```

例如：

```text
Source:
《磁带大全（中文版）》扫描包
Source Pack SHA-256: ...
```

以及：

```text
Collection Set:
BOOK-CASSETTE-CN
Catalog Revision: 1.0.0
Canonical Models: 623
```

完成度永远绑定某个 Revision：

```text
438 / 623
Catalog Revision 1.0.0
```

纠错规则：

* 去重合并：新 Revision 分母减少，已有 Ownership 映射到合并项；
* 一个型号拆成两个：旧匹配进入 `Needs Review`，不得静默把一盘算成两个；
* 新增遗漏型号：仅新 Revision 分母增加；
* 历史完成度 Snapshot 保留；
* UI显示目录升级前后差异。

这样不会出现参考目录一修正，用户昨天 70% 今天莫名其妙变成 67%，却不知道原因。

---

# 七、实体收藏与Roon关联的显示位置

为了遵守已经冻结的：

> V2 页面绝对不破坏

V3.0 中双向关系显示在：

### V3 Media → Music Release Detail

显示：

```text
Physical Release
Roon Digital Matches
Exact / Probable / Related
Play
Open in Library
```

### V3 Collection Matrix

显示：

```text
Roon
CD
Prerecorded Cassette
```

### V3 Master Source Picker

选数字源时可以显示：

```text
Owned Physical CD
Rip Provenance
```

V3.0 **不要求在现有 V2 Library、Search 或 Album Detail 增加实体收藏 Badge**。

任何 V2 页面上的实体标识以后都必须作为单独、可关闭、经过 Regression Gate 的增量提案，不捆绑在 V3.0 首发中。

---

# 开工前应新增四个技术 Gate

## Gate A：Source Evidence Spike

必须证明：

* 从一个 Roon Reference 找到用户确认的真实 FLAC；
* 计算文件 Hash和技术参数；
* 移动文件后通过 Hash重新定位；
* 同名不同内容不能自动重连；
* Roon-only曲目不能 Source Lock；
* DSD或特殊格式能如实记录转换谱系。

## Gate B：Deterministic Recording Playback Spike

必须证明：

* 冻结三首本地文件；
* 两首之间精确插入 5.000 秒数字零；
* 禁用 Smart 和在线回退；
* 输出到正式后端；
* 外部切歌、设备断连或源读取失败时立即进入 Interrupted；
* 崩溃重启后不能显示 Completed。

## Gate C：Inventory Ledger Spike

必须证明：

* 同一个 Excel 导入两次，总数不变；
* 总数 10、Legacy Used 3 的账目正确；
* 实例化 Physical Copy 后总数仍为 10；
* 用户确认的 Edition 不被再次导入覆盖；
* Wanted 与 Owned 可以同时成立。

## Gate D：Version Lineage Spike

必须证明：

* PREP-001 绑定 Master M1 + Layout L1；
* Layout改成 L2 后 PREP-001 自动失效；
* 仅改变换面点产生 Layout Version；
* 改变全局曲序必须产生新 Master Version；
* Recording Plan不能引用不匹配的 Render。

# 结论

这份审查不是在否定 V3，而是在把 V3 从“功能看起来完整”提升成：

> **档案可信、数量可信、录音内容可信、几年以后仍然能够解释清楚。**

我建议正式接受全部六点，并把 PRD 从 **v0.2** 升为：

> **MusicBridge V3.0 PRD v0.3 — Source Evidence, Deterministic Recording, Versioning & Archive Contract**

在四个技术 Gate通过前：

* `Media / Collection Wall / Spreadsheet Import` 可以按修正后的库存模型启动；
* `Personal Master / Logic / Formal Recording` 不应直接进入完整功能开发；
* 尤其不能继续沿用普通 Smart/Roon 播放逻辑去实现正式录音。

[1]: https://roonlabs.github.io/node-roon-api/Item.html "JSDoc: Class: Item"
[2]: https://roonlabs.github.io/node-roon-api/other_node-roon-api-transport_lib.js.html?utm_source=chatgpt.com "JSDoc: Source: other/node-roon-api-transport/lib.js"
