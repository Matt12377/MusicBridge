# MusicBridge V3.0 PRD v0.2

**产品：** MusicBridge
**版本：** V3.0
**文档版本：** PRD v0.2
**状态：** 产品基线 Draft
**核心主题：** Personal Recording + Recording Media Collection
**前置版本：** MusicBridge V2.x

---

# 1. 产品定义

MusicBridge V3.0 在现有 V2 音乐播放能力之上，新增一个独立的 **Recording / 录音工作区**。

V3 不重新设计 MusicBridge，不替换 V2 首页，不改变现有 Search、Library、Playlist、Playback、Lyrics、Settings 等产品逻辑。

V3 的核心目标是：

> 从用户现有 Roon / 本地数字音乐库中选择精确数字版本，制作私人数字母版，可选择通过 Logic Pro 进行响度统一与轻度母带处理，再选择合适的 Cassette / DAT 实体介质完成录音，并永久保存每盘实体录音使用的数字源、最终数字母带、介质、设备、参数、曲目、封面和实体身份。

同时，V3 建立完整的空白磁带收藏体系：

> 以用户提供的《磁带大全（中文版）》为主要 Reference Collection Set，将书中不同型号、年代与版次的空白磁带数字化为收藏目录，建立按年代排列的 Blank Tape Collection Wall，持续记录 Owned / Missing / Unknown / Wanted，最终实现整套参考书收藏 100% 完成。

此外，V3 支持录入已有：

- 商业原版磁带；
- CD；

并与 Roon / 本地数字音乐库建立可见、可追溯的双向关联。

---

# 2. V3 最高级别产品边界

## 2.1 V2 Zero Regression

V3 必须遵守：

> **只增加，不破坏 V2。**

以下 V2 页面和功能保持现状：

- Home；
- Search；
- Roon / Local Library；
- Playlists；
- Favorites；
- 当前播放；
- 播放设备；
- 播放队列；
- 歌词；
- 网易云相关能力；
- Roon 相关能力；
- Settings。

V3 不得以架构升级为由重新设计上述页面。

每个 V3 开发 Slice 合并前必须通过：

**V2 Regression Gate**

---

# 3. V3 入口

V2 现有导航仅新增一个一级入口：

**Recording**

点击后进入独立：

**Recording Workspace**

进入 Recording Workspace：

- 不停止当前播放；
- 不自动改变 Roon Zone；
- 不自动接管播放；
- 仅在正式进入 Formal Recording Mode 后，才允许根据冻结的 Recording Plan 接管播放。

不得增加第二套永久 Sidebar。

---

# 4. Recording Workspace 信息架构

V3 内部仅保留五个一级区域：

1. **Overview**
2. **Masters**
3. **Media**
4. **Recordings**
5. **Equipment**

以下均不得成为新的一级导航：

- Logic；
- Prepared Master；
- Cassette；
- DAT；
- Collection Wall；
- Media Identification；
- Recording Mode；
- J-Card；
- Spreadsheet Import。

以上全部作为上下文工作流存在。

---

# 5. V3 三个核心能力域

V3.0 在产品上以两个录音核心 + 一个收藏核心组成。

## 5.1 Personal Recording System

回答：

> 我要录什么，怎么录？

---

## 5.2 Recording Media Library

回答：

> 我有什么介质可以拿来录？

---

## 5.3 Blank Tape Collection Wall

回答：

> 参考书里有哪些磁带，我已经收集了哪些，还缺哪些？

Recording Media Library 与 Collection Wall 共用基础数据，但解决不同问题。

---

# 6. Recording Overview

Overview 不做大型数据 Dashboard。

核心目标：

> 根据当前工作状态，告诉用户唯一最合理的下一步。

示例：

### Master 尚未完成

**Continue Editing Master**

### Exact Source 未完成

**Resolve Digital Sources**

### 等待 Logic

**Import Prepared Master**

### Prepared Master 已完成

**Choose Recording Media**

### 介质和设备已经确认

**Start Recording**

### 录音完成

**Generate J-Card**

Overview 可同时显示：

- New Master；
- Record Existing Master；
- Media Ready 摘要；
- Recent Recordings；
- Needs Attention。

用户正常工作时应主要沿：

**Continue / Next**

向前推进，而不是自行理解系统模块。

---

# 7. Personal Master

Personal Master 是正式私人节目母版，不等同普通 Playlist。

支持基础类型：

- Compilation；
- Concert；
- Continuous Program。

保存：

- Title；
- Master ID；
- Version；
- Tracks；
- Track Order；
- Exact Digital Source；
- Transition；
- Layout；
- Preparation History；
- Physical Recording History。

---

# 8. Exact Digital Source

Personal Master 中每首歌曲最终必须对应具体数字源。

至少保存：

- Artist；
- Track；
- Album；
- Release；
- Roon Item Reference；
- Local File Reference；
- Codec；
- Bit Depth；
- Sample Rate；
- Channels；
- Duration；
- Fingerprint / Hash；
- Snapshot Date。

Draft 阶段允许：

**Source Unresolved**

Master Freeze 前：

> 所有曲目必须完成 Source Lock。

---

# 9. 数字版本选择规则

若同一歌曲存在：

- 原版 CD Rip；
- 精选集版；
- Remaster；
- SACD；
- DSD；
- Live；
- 其他版本；

MusicBridge 应显示候选。

默认原则：

> **版本正确性 > 用户偏好 > 技术规格。**

不得仅因采样率或位深更高自动替换用户选择。

---

# 10. Compilation 默认曲间 5 秒

普通 Compilation 默认：

**Inter-track Gap = 5.0 sec**

例如：

Track 01
→ 5 sec silence
→ Track 02
→ 5 sec silence
→ Track 03

Cassette A/B 时长必须计算：

**Effective Recording Duration = Music Duration + Inter-track Gaps**

另外区分：

- Lead-in；
- Inter-track Gap；
- Tail。

Concert / Live / Gapless Material 可以覆盖默认规则。

---

# 11. Cassette A/B Layout

Cassette Layout 必须分别判断：

- Side A；
- Side B。

不能只根据总时长判断介质是否可用。

支持：

### Manual

用户完全控制。

### Assisted

系统辅助寻找自然换面点。

### Auto Balance

仅调整用户明确授权的未锁定曲目。

可用轻量控制：

- Lock Position；
- Keep With Next；
- Force Side A；
- Force Side B；
- Side Opener；
- Side Closer。

不得静默改变 Frozen Master 曲序。

---

# 12. Master 与 Layout 分离

Personal Master 定义：

- 内容；
- 曲序；
- Exact Source；
- Transition。

Layout 定义：

- Cassette A/B；
- DAT Continuous；
- 其他物理映射。

一个 Master 可以产生多个 Layout。

例如：

- Cassette 90；
- Cassette 60 × 2；
- DAT Continuous。

---

# 13. Master Freeze

状态：

- Draft；
- Ready；
- Frozen；
- Archived。

Master Freeze 锁定：

- Tracks；
- Order；
- Exact Sources；
- Transition Rules。

Frozen Master 不允许原地静默修改。

后续调整：

> 新建 Master Version。

---

# 14. 两种 Recording Path

## 14.1 Direct Recording

Personal Master
→ Exact Digital Sources
→ MusicBridge Playback
→ 5 sec gaps
→ Recording Chain
→ Physical Recording

---

## 14.2 Prepared Master Recording

Personal Master
→ Logic Pro / DAW
→ Loudness Matching
→ Light Master Processing
→ Final Render
→ MusicBridge
→ Recording Chain
→ Physical Recording

---

# 15. Logic Preparation

MusicBridge 不承担 DAW 本身的声音处理职责。

原则：

> **MusicBridge 负责准备和验收，Logic 负责声音。**

用户点击：

**Prepare in Logic**

MusicBridge 创建：

**Preparation Workspace**

包含：

- Source working copies；
- Tracklist；
- Source Lineage；
- Manifest；
- Bounce target folders。

不得直接修改 Roon / 本地音乐库源文件。

---

# 16. Logic 音频处理原则

Logic 主要用于：

- 不同歌曲感知响度统一；
- Region / Track Gain；
- 必要的轻量 EQ；
- 必要的轻量 Compression；
- Limiter / Peak Control；
- Fade；
- 整体轻度 Master Bus Processing。

原则：

> 统一一套精选的听感，而不是把所有商业母带重新压成完全相同的 LUFS。

尽量保留原始音乐的：

- 动态；
- 音色；
- Mastering Character。

---

# 17. Logic Prepared Cassette Master

Cassette Prepared Master 推荐导出：

- SIDE-A.wav
- SIDE-B.wav

默认 5 秒曲间空白直接：

**Baked Into Render**

MusicBridge 不得在正式录音时再次添加 5 秒。

Prepared Master 保存：

- Master ID / Version；
- Preparation ID；
- DAW；
- WAV Format；
- Bit Depth；
- Sample Rate；
- Duration；
- File Hash；
- Created Date；
- Transition Rendering Mode。

---

# 18. Original Source Lineage

Recording Archive 必须同时保存：

### Original Digital Source

例如：

Roon
→ 王菲《唱游》
→ FLAC 16/44.1

### Actual Final Recording Master

例如：

Logic
→ PREP-001
→ SIDE-A.wav
→ 24/96

不得把两者混为同一个对象。

DSD → PCM → Logic 等转换也必须真实记录。

---

# 19. Media 页面结构

Media 内部建议包含：

## Collection Wall

空白磁带收藏年代墙。

## Library

实际库存和实体收藏。

Library 内进一步区分：

### Recording Media

- Blank Cassette；
- DAT。

### Music Releases

- CD；
- Prerecorded Cassette。

---

# 20. Recording Media Catalog 数据结构

正式结构：

Brand
→ Series
→ Edition
→ Collection Model
→ SKU
→ Inventory Lot
→ Physical Copy

---

# 21. Collection Model

Collection Model 是：

> **Blank Tape Collection Wall 的完成度计算单位。**

例如：

**TDK SA · 1990 Edition**

可能包含多个 SKU：

- SA 46；
- SA 54；
- SA 60；
- SA 90；
- SA 120。

这些 SKU 在库存和录音时仍然独立，因为时长不同。

但收藏完成度只计算一个：

**TDK SA · 1990 Edition**

---

# 22. 同型号不同时长收藏规则

正式规则：

> **同一型号、同一 Edition / Generation / Packaging Version，不同时长只算一个收藏型号。**

只要拥有其中任意一个时长：

> Collection Model = Collected

例如用户仅拥有：

**TDK SA 90 · 1990**

则：

**TDK SA · 1990 = Collected**

不要求同时拥有 46 / 60 / 90 / 120 才算完成。

---

# 23. 多时长收藏

虽然完成度只按 Collection Model 计算，不同时长仍完整记录。

例如：

**TDK SA · 1990**

Owned Lengths:

- 46 ×1
- 60 ×2
- 90 ×6

Not Owned:

- 54
- 120

如果所有已知 Length SKU 均拥有，可额外显示：

**All Lengths**

但：

> All Lengths 不影响《磁带大全》主完成度。

它仅代表更深收藏程度。

---

# 24. Edition 差异仍独立计算

例如：

- TDK SA 1988；
- TDK SA 1990；
- TDK SA 1992；

只要参考书将其作为明显不同：

- 年代；
- 包装；
- 代际；
- 版本；

则分别算三个 Collection Model。

原则：

> **Length Difference 不产生新收藏项；Edition / Packaging Difference 可以产生新收藏项。**

---

# 25. Blank Tape Reference Collection Set

用户提供的：

**《磁带大全（中文版）》**

作为 V3 第一套正式：

**Reference Collection Set**

Reference Catalog 至少覆盖当前资料中的主要品牌：

- TDK；
- SONY；
- Maxell；
- AXIA；
- DENON；
- 其他参考书内品牌。

DAT Reference Catalog 可后续独立补充。

---

# 26. Book Reference Item

每一书中可区分的型号/Edition 建立：

**Canonical Reference Tape**

保存：

- Reference ID；
- Book ID；
- Brand；
- Series；
- Edition；
- Collection Model；
- Known Lengths；
- IEC Type；
- Year / Period；
- Reference Image；
- Source Page；
- Notes；
- Confidence。

书中重复出现的同一型号必须去重。

不能因为同一型号在三页出现，就要求收藏三次。

---

# 27. Blank Tape Collection Wall

V3.0 核心功能。

主目标：

> 以参考书为完整背景，按年代展示用户已经拥有、尚缺失、尚未确认的磁带。

推荐主结构：

Brand
→ Chronology
→ Collection Model Cards

例如：

## TDK

1986
[SA] [SA-X] [MA]

1988
[SA] [SA-X] [MA] [MA-XG]

1990
...

每张卡代表：

> 一个 Collection Model

而不是每个不同时长占一个卡位。

---

# 28. Collection Wall 状态

至少支持：

### Owned

已确认拥有该 Collection Model 的至少一个时长。

### Missing

确认没有。

### Unknown

尚未检查现有收藏。

### Uncertain

已有疑似实物，但 Edition 尚未确认。

### Wanted

明确列入补藏目标。

---

# 29. Unknown ≠ Missing

由于用户当前库存统计并不完整：

> Excel 未匹配到的参考型号不能自动视为 Missing。

第一次导入后：

**Unknown**

用户明确确认：

> 没有

才变为：

**Missing**

避免虚假完成度。

---

# 30. Book Completion

最终目标：

> **将《磁带大全（中文版）》内所有 Canonical Collection Models 收集齐。**

显示：

### Overall

Collected / Total

例如：

**438 / 623**

### Brand

TDK
86 / 104

SONY
79 / 111

Maxell
...

### Series

TDK SA
12 / 15

TDK SA-X
...

---

# 31. Completion 计算

主完成度：

**Collected Collection Models / Total Collection Models**

不按 SKU 时长数量计算。

如果存在大量 Unknown，UI 必须同时显示：

- Owned；
- Missing；
- Unknown。

不能用 Unknown 静默当 Missing。

---

# 32. Length Coverage

Collection Model Detail 可以显示：

**Length Coverage**

例如：

TDK SA · 1990

Collected: ✓

Known lengths:

- 46 ✓
- 54 —
- 60 ✓
- 90 ✓
- 120 —

该指标为收藏深度信息。

不进入主 Book Completion。

---

# 33. Want List

Missing Collection Model 可以：

**Add to Want List**

保存：

- Reference Item；
- Priority；
- Preferred Condition；
- Notes；
- Optional Price Target。

V3 不负责交易、不负责自动购买。

Want List 只是：

> 我还需要寻找什么。

---

# 34. Collection Wall 与实际库存关系

Reference Catalog 和 My Inventory 必须是独立对象。

关系：

Reference Collection Model
↕ Verified / Candidate Match
My Inventory

如果以后发现版本认错：

> 修改 Match

不得删除：

- Purchase History；
- Quantity；
- Photos；
- Physical IDs；
- Recording History。

---

# 35. 同一收藏型号多个副本

Collection Wall 卡片仍只显示一次：

**TDK SA-X · 1990**

但可显示：

**Owned ×7**

点击后：

- Sealed ×5；
- Opened Blank ×1；
- Recorded ×1。

收藏墙回答：

> 有没有。

Library 回答：

> 有多少、什么状态。

---

# 36. Featured Copy

数据结构预留：

**Featured Copy**

允许用户为某个 Collection Model 选择一盘代表性实物，用于收藏墙展示。

V3.0 首版可以不实现复杂选择 UI。

---

# 37. Recording Media 基础字段

Recording Media 可记录：

- Brand；
- Series；
- Model；
- Edition；
- Year / Period；
- Length；
- IEC Type；
- Market；
- Country；
- Catalog Number；
- Barcode；
- Packaging Variant。

允许未知。

---

# 38. 收藏属性

支持：

### Packaging

- Sealed
- Opened

### Usage

- Blank
- Reserved
- Recorded
- Erased

### Availability

- Available
- Unavailable

### Condition

- Mint
- Near Mint
- Excellent
- Good
- Fair
- Poor
- Damaged

### Collector Policy

- Normal
- Prefer Opened
- Preserve Sealed
- Collector

---

# 39. Minimum Sealed Reserve

用户可以为型号设置：

**Minimum Sealed Reserve**

例如：

TDK MA-XG 90
Sealed ×5
Reserve = 3

录音推荐系统不得优先建议使用保留线内的未拆封收藏。

---

# 40. Inventory Quantity

大量同质未拆磁带：

> 只按数量管理。

例如：

TDK SA-X 90
Sealed ×12

不得自动创建 12 个永久实体 ID。

---

# 41. Physical Copy

当一盘磁带产生独立历史，例如：

- 拆封；
- Reserved；
- Recorded；
- 单独收藏；
- 损坏；
- 单独拍照；

才实例化：

**Physical Copy**

---

# 42. Permanent Physical ID

Cassette：

**MB-C-00427**

DAT：

**MB-D-00117**

要求：

- 永久；
- 不复用；
- 不携带容易变化的 Metadata；
- 可手写在磁带背面；
- 可印在盒脊；
- 可搜索；
- 可生成 QR。

磁带被擦除重新录制：

> ID 不改变。

---

# 43. Existing Spreadsheet Import

V3.0 必须支持 Spreadsheet Import。

用户现有磁带统计表作为第一版：

**My Recording Media Library Seed**

每一源行默认：

**Inventory Lot**

导入：

- Brand；
- Model；
- Version Candidate；
- IEC Type；
- Length；
- Quantity；
- Price；
- Purchase Date；
- Used；
- Notes。

---

# 44. Non-destructive Import

导入必须：

- 保留 Raw Value；
- 保存 Source Row；
- 可规范品牌名称；
- 可产生 Candidate Catalog Match；
- Unknown 可直接入库；
- 不要求预先清洗完整。

---

# 45. Legacy Used

现有表内“已用”数量：

> 导入为 Legacy Used — Unregistered。

不得自动批量分配 Physical ID。

用户未来拿到某一实际磁带后再登记具体 ID 和内容。

---

# 46. Media Identification

支持：

- Unidentified；
- Partially Identified；
- Candidate Matched；
- Verified。

V3.0 主要支持：

- 人工选择；
- Reference Image 对照；
- Catalog Candidate。

AI 自动图像鉴定延后至 V3.x。

---

# 47. Media Selection Engine

Personal Master Ready 后，系统根据：

1. Fit
2. Equipment Compatibility
3. Availability
4. Collection Policy
5. User Preference

推荐合适介质。

Hard Constraint 优先。

推荐必须说明原因。

例如：

**Sony UX-Pro 90**

- Fits Side A / B；
- 已拆空白；
- Deck Compatible；
- 不影响收藏保留。

---

# 48. Commercial Music Releases

Media Library 同时支持：

## CD

## Prerecorded Cassette

但它们与 Blank Recording Media 属于不同收藏类型。

---

# 49. CD Collection

基础字段：

- Artist；
- Album；
- Year；
- Label；
- Catalog Number；
- Barcode；
- Region；
- Edition；
- Disc Count；
- Tracklist；
- Packaging；
- Condition；
- Quantity；
- Storage；
- Purchase Info；
- Photos。

允许：

> Basic → Partial → Verified

逐步补充。

---

# 50. Prerecorded Cassette Collection

基础字段：

- Artist；
- Album；
- Year；
- Label；
- Catalog Number；
- Region；
- Side A/B；
- Tracklist；
- Tape Type；
- Dolby / NR；
- Tape Condition；
- J-Card Condition；
- Case Condition；
- Storage；
- Photos。

---

# 51. Roon ↔ Physical Release

CD / Original Cassette 必须能够与：

**Roon / Local Digital Release**

建立双向关联。

两者保持独立对象，不合并。

关系类型：

### Exact

确认相同 Release。

### Probable

高度疑似。

### Related

音乐相同或相关，但不是同一发行版。

---

# 52. Physical / Digital 状态

实体收藏可显示：

### Physical + Digital

实体与 Roon 均存在。

### Physical Only

实体存在，Roon 无对应版本。

### Digital Only

Roon 存在，没有实体收藏。

### Unmatched

双方可能存在，但尚未建立关系。

---

# 53. Digital Provenance

如果用户确认某个 Roon 数字版来自自己收藏的 CD：

Physical CD
→ Rip
→ FLAC
→ Roon

可保存正式 Provenance。

不得仅凭 Album Title 自动断言 Rip 来源。

---

# 54. Collection Matrix

支持按 Artist / Album 查看：

| Album | Roon | CD | Cassette |
|---|---|---|---|
| 天空 | ✓ | ✓ | ✓ |
| 浮躁 | ✓ | ✓ | — |
| 唱游 | ✓ | ✓ | ✓ |
| 寓言 | ✓ | — | — |

帮助用户理解：

> 自己的数字与实体收藏覆盖情况。

---

# 55. Equipment

Equipment 只管理录音需要的设备：

- Cassette Deck；
- DAT Recorder；
- DAC；
- Audio Interface；
- Digital Output；
- 必要 Signal Chain Device。

不得扩展为通用 Hi-Fi 器材收藏软件。

---

# 56. Recording Profile

Reusable Recording Profile 保存：

- Ordered Signal Chain；
- Default NR；
- Calibration Habits；
- Pre-roll；
- Media Compatibility；
- 常用连接。

例如：

Prepared Master
→ RME
→ RCA
→ Nakamichi

---

# 57. Session Overrides

每次录音只确认真正变化的内容：

- Record Level；
- Calibration；
- NR；
- Temporary Chain Override。

固定设置不得反复要求填写。

---

# 58. Recording Profile Snapshot

Recording Plan Freeze 时：

> 复制当前有效 Profile + Overrides。

该 Snapshot 永久属于这次 Recording。

以后修改默认 Profile：

> 不得影响历史录音。

---

# 59. Recording Plan Freeze

正式录音前锁定：

- Master Version；
- Prepared Master；
- Layout；
- Physical Copy；
- Recording Profile Snapshot；
- Session Parameters。

---

# 60. Formal Recording Mode

开始前必须 Preflight：

- Master Ready；
- Exact Sources Available；
- Prepared Master Valid；
- Media Bound；
- Equipment Profile Ready；
- Side Fit Valid；
- Playback Ready。

---

# 61. Cassette Recording Flow

Ready
→ Begin Side A
→ Side A Playback
→ Side A Complete
→ Stop
→ Flip Tape
→ Begin Side B
→ Side B Playback
→ Final Verification

A 面结束：

> 不得自动开始 B 面。

---

# 62. Recording Attempts

正式录音支持：

- Completed；
- Aborted；
- Failed。

Setup / Test 不进入正式 Attempt History。

---

# 63. Final Verification

录制完成后：

- Confirm Side A；
- Confirm Side B；
- Confirm Known Interruptions。

可选：

- Playback Checked；
- Quality Notes。

确认后进入：

**Completed**

---

# 64. Recording Archive

每个 Completed Recording 至少保存：

- Physical ID；
- Personal Master；
- Prepared Master；
- Physical Media；
- Date；
- A/B Layout；
- Tracklist；
- Exact Digital Sources；
- Recording Profile Snapshot；
- Processing Lineage；
- Artwork；
- J-Card；
- Photos；
- History。

---

# 65. Archive Search

必须支持：

- 427；
- C-0427；
- MB-C-00427；

直接找到实体介质。

也支持：

- Track；
- Artist；
- Master；
- Media Brand；
- Series；
- Equipment；
- Date。

---

# 66. Digital Replica

Completed Recording 支持：

**Play Digital Replica**

Prepared Recording：

> 播放当年冻结的 Side A / Side B Render。

Direct Recording：

> 按 Frozen Sources + 5 秒 Gap 重建。

---

# 67. J-Card

Cassette Recording 完成后自动生成基础 J-Card。

内容：

- Artwork；
- Title；
- Spine；
- Physical ID；
- Side A；
- Side B；
- Duration；
- Tape Model；
- Date；
- Optional QR；
- Optional Technical Info。

所有事实数据只能来自 Recording Archive。

---

# 68. Artwork 与 Printed Artifact

Artwork：

> 属于 Personal Master。

J-Card Render：

> 属于具体 Physical Recording。

后续更换 Artwork 或模板：

> 不得改变历史磁带已使用的 Printed Artifact。

---

# 69. V3.0 J-Card Scope

必须：

- 正确物理尺寸 PDF；
- Artwork；
- Spine；
- Recording ID；
- A/B Tracklist；
- Tape Model；
- Date。

可选：

- QR；
- Minimal ID Label。

延后：

- 高级设计器；
- 大量模板；
- 复杂打印校准。

---

# 70. Recording Archive File Management

MusicBridge 使用独立：

**Recording Archive Root**

正式保存：

- Prepared Master Renders；
- Manifests；
- Artwork；
- J-Cards；
- Recording Metadata；
- Physical Photos。

Roon / Local 原始文件：

> 只引用。

严禁：

- Delete；
- Move；
- Rename；
- Modify；
- Overwrite。

---

# 71. Logic Project

`.logicx`：

默认保存 External Reference。

不强制归档。

真正用于录制的：

- SIDE-A.wav；
- SIDE-B.wav；

必须归档。

已经关联正式 Recording 的 PREP：

> 不允许覆盖。

重新导出不同内容：

> 创建 PREP-002。

---

# 72. V3.0 明确不做

以下延后至 V3.x：

- 模拟磁带数字化；
- AI 全自动磁带识别；
- 市场价格；
- 自动购买；
- 收藏交易；
- Discogs 社交；
- 高级 LUFS 分析系统；
- 自动 Logic 控制；
- 自动复杂 DAW 工程生成；
- Test Tone 系统；
- 高级磁带机测量；
- 高级 Shelf 动画；
- 收藏排行榜 / 成就系统；
- 高级打印机校准；
- 自动 Archive Hash 健康巡检 UI。

---

# 73. V3.0 核心主流程

Recording
→ New Personal Master
→ Select Tracks
→ Lock Exact Digital Sources
→ Arrange Program
→ Add Default 5 sec Gaps
→ Cassette A/B Layout
→ Master Freeze
→ Direct Recording **或** Prepare in Logic
→ Logic Loudness / Light Mastering
→ Import SIDE-A / SIDE-B
→ Prepared Master Freeze
→ Media Selection
→ Choose Cassette / DAT
→ Create / Reserve Physical Copy
→ Recording Profile
→ Session Overrides
→ Recording Plan Freeze
→ Formal Recording Mode
→ Final Verification
→ Recording Archive
→ Generate J-Card。

---

# 74. Blank Tape Collection 主流程

Reference Book Catalog
→ Build Canonical Collection Models
→ Import Existing Spreadsheet
→ Candidate Match Existing Inventory
→ User Verify
→ Blank Tape Collection Wall
→ Owned / Missing / Unknown / Wanted
→ Want List
→ Add Newly Purchased Tape
→ Model Becomes Collected
→ Completion Progress Updates
→ Eventually Book Collection = 100%。

---

# 75. V3.0 MVP 成功标准

V3.0 首版至少必须实现：

1. V2 仅增加 Recording 入口。
2. V2 原有页面和播放能力无回归。
3. Recording Workspace 五个一级区域可用。
4. Personal Master 可创建。
5. Exact Digital Sources 可锁定。
6. Compilation 默认 5 秒间隔。
7. Cassette A/B Layout 可生成。
8. Logic Preparation Workspace 可生成。
9. Logic A/B WAV 可重新导入。
10. Prepared Master 可冻结。
11. 现有磁带 Excel 可批量导入。
12. Blank Cassette / DAT 可库存管理。
13. Physical Copy 可分配永久 ID。
14. Media Selection 可根据 Master 推荐介质。
15. Equipment / Recording Profile 可复用。
16. Formal Recording Mode 可完成 A/B 流程。
17. Recording Archive 可保存并查询。
18. Digital Replica 可播放。
19. 基础 J-Card 可生成。
20. CD 可录入。
21. 原版磁带可录入。
22. Physical Release 可关联 Roon Digital Release。
23. 《磁带大全》可建立 Canonical Collection Set。
24. Blank Tape Collection Wall 可按品牌与年代展示。
25. 同型号同版次不同时长只计算一个收藏项目。
26. 拥有任一时长即视为该 Collection Model 已收藏。
27. 多时长收藏信息仍可查看。
28. Owned / Missing / Unknown / Wanted 可管理。
29. Series / Brand / Book Completion 可计算。
30. Missing Collection Models 可进入 Want List。

---

# 76. 产品原则

1. **V2 Zero Regression。**
2. **Recording 是 V3 唯一入口。**
3. **录音和空白介质收藏是 V3 核心。**
4. **空白磁带年代墙属于 V3.0 核心，而非装饰功能。**
5. **《磁带大全》是明确、有限、可达到 100% 的收藏 Reference Scope。**
6. **Collection Completion 按型号 + Edition 计算，不按时长计算。**
7. **拥有任一时长即可完成该 Collection Model。**
8. **Edition / Packaging 明显不同仍视为不同收藏项目。**
9. **未知库存不自动判定为 Missing。**
10. **Reference Catalog 与用户 Inventory 永远分离。**
11. **原始 Roon / Local Music 永远只读。**
12. **Exact Digital Source 必须可追溯。**
13. **Original Source 与 Prepared Recording Master 分离。**
14. **Physical Copy 使用永久 ID。**
15. **Recording History 不允许被后续 Metadata 静默改写。**
16. **实体 CD / 原版磁带与 Roon 数字版保持独立对象，通过关系连接。**
17. **系统复杂度隐藏在后台，正常工作通过 Next Action 前进。**
18. **V3 不发展成 DAW、Discogs、ERP 或交易平台。**

---

# 77. V3.0 产品定位

MusicBridge V3.0 最终解决三个长期问题：

## Listen

V2 继续负责正常音乐播放。

## Record

把本地数字音乐制作成真正的 Cassette / DAT 实体录音，并保留完整数字谱系。

## Collect

管理空白磁带、CD、商业磁带，并以《磁带大全》为基准逐步完成整个空白磁带收藏。

最终形成：

**Roon Digital Library**
↕
**Physical CD / Original Cassette**
↕
**Personal Master / Logic Prepared Master**
↕
**Blank Cassette / DAT Collection**
↕
**Personal Physical Recording Archive**

MusicBridge 从“播放桥梁”进一步成为：

> **连接数字音乐、实体音乐收藏和个人录音行为的私人音乐系统。**
