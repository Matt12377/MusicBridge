# MusicBridge V3.0 PRD v0.3

**产品：** MusicBridge<br>
**主题：** Personal Recording & Tape Collection<br>
**文档状态：** `FREEZE_PENDING`<br>
**技术 Gate：** A～E 均为 `NOT_RUN`<br>
**实现授权：** Owner 于 2026-08-27 认可 Preview 02 并授权开始开发；按独立任务逐段实现，真实文件、设备及录音操作另行确认<br>
**代码基线：** `codex/v3` / `90d0aa8aa7f156c6ecfc6f366eea698f8e4d6098`<br>
**开发包：** [V3 Development Pack](../../project/V3_DEVELOPMENT_PACK.md)

## 本版来源与使用边界

本版合并用户的 v0.2 产品 PRD、首轮工程合同和最终冻结补丁。保留原有 77 节产品结构与 30 项 MVP 范围；涉及冲突的正文已更新，不将原始提案中的旧规则继续作为并行合同。

2026-08-27 对话中的需求补充已纳入正文：原版磁带/CD 与 Roon 关联的实体音乐库、以实物照片展示且可下钻库存与录音内容的空白磁带收藏库，以及从 Roon 选曲后按现有库存推荐磁带的录音流程。自录磁带同时出现在实体音乐库与所属磁带型号详情，但不复制实体记录、不冒充商业原版。Owner 随后认可 Preview 02 并授权开始开发：收藏、录音为现有侧栏中的两个独立入口，删除 V3 概览页和设备页。开发授权不等于完整文档冻结、真实录音或最终产品验收。

`sources/` 下保留三个来源快照（仅规范行尾空白与文件末尾换行），用于溯源而非执行授权。数字、曲目、设备及收藏数量示例不是已确认的用户数据。本文不将现有 V2 的在线播放边界扩大；新源扫描、归档、转换及硬件输出仅限未来明确授权的 Recording 范围。

正文和附录 A 共同构成冻结候选合同；Development Pack 定义技术取证。文档整理完成不自动标为 Frozen，更不自动使技术 Gate 或 Owner 验收通过。冻结前确认项列于开发包。

---

# 1. 产品定义

MusicBridge V3.0 在现有 V2 音乐播放能力之上，新增独立的 **收藏** 与 **录音** 两个入口。

V3 不重新设计 MusicBridge，不替换 V2 首页，不改变现有 Search、Library、Playlist、Playback、Lyrics、Settings 等产品逻辑。

V3 的核心目标是：

> 从用户现有 Roon / 本地数字音乐库中选择精确数字版本，制作私人数字母版，可选择通过 Logic Pro 进行响度统一与轻度母带处理，再选择合适的 Cassette / DAT 实体介质完成录音，并永久保存每盘实体录音使用的数字源、最终数字母带、介质、设备、参数、曲目、封面和实体身份。

同时，V3 建立完整的空白磁带收藏体系：

> 以用户提供的《磁带大全（中文版）》为主要 Reference Collection Set，将书中不同型号、年代与版次的空白磁带数字化为收藏目录，建立按年代排列的 Blank Tape Collection Wall，持续记录 Owned / Missing / Unknown / Wanted，最终实现整套参考书收藏 100% 完成。

此外，V3 支持录入已有：

- 商业原版磁带；
- CD；

并与 Roon / 本地数字音乐库建立可见、可追溯的双向关联。

用户日常使用的主线是以下三个相互连接的体验，而不是先学习母版、归档和设备等工程对象：

1. **实体音乐库**：收藏原版磁带、CD 和自己录好的磁带，能够查看对应的 Roon 数字音乐。
2. **空白磁带收藏库**：以实体磁带照片为主体，按型号与版次浏览；进入型号后查看未开封空白、已拆空白和已录音数量，以及每盘已录磁带的内容。
3. **录音**：打开录音界面，从 Roon 选音乐，系统按现有空白磁带库存推荐合适介质，确认后完成录音与 J-Card。

“空白磁带收藏库”以磁带产品型号为分类，不意味着一盘录过音后就离开该型号收藏。两个库共享同一盘实物的身份与状态。

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

V2 现有侧栏新增两个一级入口：**收藏** 与 **录音**。这是同一侧栏的两个入口，不是两套侧栏。V2 的 Roon 数字音乐收藏保留，并与实体收藏清楚区分。

进入收藏或录音页面：

- 不停止当前播放；
- 不自动改变 Roon Zone；
- 不自动接管播放；
- 仅在正式进入 Formal Recording Mode 后，才允许根据冻结的 Recording Plan 接管播放。

不得增加第二套永久 Sidebar。

---

# 4. 收藏与录音信息架构

1. **收藏**：页内切换“空白磁带收藏”和“实体音乐库”，详情按需打开。
2. **录音**：独立内容页面，从选曲开始，按库存推荐、确认与预检逐步推进；不以大型录音弹窗承载完整流程。

删除独立 Overview / 概览页、Equipment / 设备页及旧五区域顶部导航。母版、录音记录保留为录音页内的次级入口；录音设备与 Profile 参数在录音设置步骤中处理。删除设备页不删除 V2 播放设备选择，也不取消录音设备兼容与输出认证合同。

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

以上为 Owner 认可的 Preview 02 导航决定，替代来源快照中的单入口与五区域规则；来源快照保持不变以供溯源。默认页面聚焦当前操作，不常驻展示全部库存、母版、设备和历史内容。

---

# 5. V3 三个核心能力域

V3.0 在产品上以实体音乐收藏、空白磁带收藏和录音三个相连的能力域组成。

## 5.1 Personal Recording System

回答：

> 我要录什么，怎么录？

---

## 5.2 Physical Music Library

回答：

> 我有什么原版 CD、原版磁带和自录磁带，它们对应哪些数字音乐？

---

## 5.3 Blank Tape Collection Wall

回答：

> 我有哪些磁带型号，每种有几盘未开封空白、已拆空白和已录音；录过的是什么，还缺哪些收藏？

Recording Media 库存与 Collection Wall 共用基础数据，支持照片浏览和可录介质推荐；实体音乐库按音乐内容展示原版与自录实物。两种视图不产生两份库存。

---

# 6. 录音页面与下一步

录音直接打开独立准备页面，不设 Overview 或大型数据 Dashboard。

提供明确的“开始录音”主动作。新建流程先展示 Roon 音乐选择，再展示库存推荐；源验证、母版和布局在流程中逐步呈现。仅打开录音界面或选择曲目不接管当前播放，也不消耗或预留库存。

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

以下动作按当前上下文出现，不作为常驻仪表盘：

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

Personal Master 中每首歌曲必须通过独立的 `DigitalSourceBinding` 绑定具体数字文件，保留 Artist、Track、Album、Release、Roon 辅助引用、文件引用、Codec、Bit Depth、Sample Rate、Channels、Duration、文件 SHA-256 和 Snapshot Date。

Roon Browse 引用只允许浏览、试听和加入 Draft，不能代替档案级源文件证据。现有歌词 `LocalTrackSignature` 保留原用途，不是音频文件 Hash。

用户明确选择 Source Roots 后，MusicBridge 才能只读扫描授权目录。保存 Root ID、Relative Path、File Size、Modified Time、技术参数、完整文件 SHA-256；可选 Audio Payload Hash 和 Acoustic Fingerprint。不得因为用户说明 Mac 能访问文件，就自动扫描未授权目录。

Acquisition、Verification、Preservation、Availability 和 Relationship 分别记录，完整字段与 `SourceLockEligible` 条件见附录 A。Roon 桌面导出文件必须经过同样验证；其精确身份只代表导出后的文件，不能自动证明它与原 Watched Folder 文件字节相同。

文件移动后，只有在授权根内发现完全相同文件 Hash 才能自动重新定位。名称、歌手、时长和声学指纹只能形成待确认候选。Root 暂时不可访问时为 `SOURCE_ROOT_OFFLINE`，不能直接判定 `MISSING`。

Draft 允许 Source Unresolved；Master Freeze 前所有曲目必须完成 Source Lock。

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

普通 Compilation 的 Direct 路径默认在相邻源文件之间额外插入 **5.000 秒数字零样本**，在 Execution Asset 编译时完成：

`silence_frames = execution_sample_rate × 5`

例如 96 kHz 对应 480,000 个音频帧。不得使用 UI 定时器，也不自动裁剪原文件首尾静音，因此可听间隔可能大于五秒。

按每面/连续段实际存在的曲间边界计数，不在最后一首后自动再添加一个曲间 Gap；Lead-in 与 Tail 单独计算。Keep With Next、Concert、Live、Gapless 等覆盖规则必须进入冻结的时间线。

有效录制时长 = 音乐帧数 + 曲间 Gap 帧数 + Lead-in + Tail。A/B 分别计算。Prepared 音频的间隔已经 `Baked Into Render`，正式执行时不得重复添加。

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

Auto Balance 只改 A/B 分界而不改全局曲序时，创建新 LayoutVersion；改变任何全局先后顺序时，先创建 Proposed MasterVersion，经用户确认后冻结。

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

每个 LayoutVersion 绑定 MasterVersion，保存媒体格式/容量、每曲分面或分段、起止帧、Gap、Lead-in、Tail 和 Planned Timeline Hash。源格式尚未统一时，帧位置必须携带其采样率时基，不能直接混用不同采样率下的帧数。

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

两条路径共同使用固定格式的 Execution Asset；正式录音阶段不逐首临时切换、解码或转换源文件。

## 14.1 Direct Recording

Frozen Master + Frozen Layout + Verified Exact Source Files → Compile Execution Asset → 按面冻结的执行 WAV 与帧级 Manifest → Recording Engine → 通过 Gate B 的 Output Backend → Physical Recording。

Compile 只允许解码、必要的固定采样率转换、固定声道映射、拼接和插入冻结的静音；不做响度处理、EQ、压缩或母带加工。转换实现、版本与参数必须可追溯。

## 14.2 Prepared Master Recording

Personal Master → Logic Preparation → 用户在 DAW 中处理 → 导入原始 Render → 验收 Render Timeline → 格式符合则直接引用，不符合则生成有独立身份的 Execution Derivative → Recording Engine → 通过 Gate B 的 Output Backend → Physical Recording。

原始 Logic Render 始终保留。Roon 可以作为输出通路，不能决定内容或替换正式源；CoreAudio 声卡输出是另一后端候选。首版只要求一个正式后端通过验收，不预先把任一后端标记为 Certified。

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

Preparation 只能读取已授权 Source Roots 和已验证的源绑定。工作副本放在独立目录，不自动控制 Logic；将工作副本交给用户后，重新导入音频仍需经过验证，不能信任文件名或上次导出记录。

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

Cassette Prepared Master 推荐导入 `SIDE-A.wav` 和 `SIDE-B.wav`；DAT 使用 `CONTINUOUS.wav`。每个 PREP 永久绑定：

- Master Version；
- Layout Version；
- PlannedTimelineManifest；
- 用户确认后的 RenderTimelineManifest；
- 原始 Render Hash、格式、采样率、声道、总帧数和创建时间；
- Preparation ID、DAW、Processing Lineage；
- Transition Rendering Mode = `Baked Into Render`。

导入后生成 Conformance Report：`MATCHED`、`ACCEPTED_VARIANCE`、`REQUIRES_NEW_LAYOUT`、`REQUIRES_NEW_MASTER` 或 `REJECTED`。逻辑和容差边界见附录 A；只靠 WAV 总时长不能证明全部曲目和版本正确。

用户需要在最终 WAV 时间线上确认实际曲目标记。声学匹配、波形或时长只提出候选，不能自动成为档案事实。后续新增 Layout 时，旧 PREP 对原 Master/Layout 与历史 Recording 继续有效，仅与新 Layout 不兼容。

Execution Format 不匹配时创建独立 Execution Derivative；不能覆盖原始 Render，也不能再次插入已烘焙的五秒间隔。

---

# 18. Original Source Lineage

Recording Archive 必须同时保存：

### Original Digital Source

例如：

Roon<br>
→ 王菲《唱游》<br>
→ FLAC 16/44.1

### Actual Final Recording Master

例如：

Logic<br>
→ PREP-001<br>
→ SIDE-A.wav<br>
→ 24/96

不得把两者混为同一个对象。

DSD → PCM → Logic 等转换也必须真实记录。

---

# 19. Media 页面结构

收藏页面内部必须提供两个直接可达的视图：

## 空白磁带收藏库 / Collection Wall

以实物照片展示磁带型号与版次，支持品牌、年代浏览。型号详情包含时长 SKU、库存状态、具体副本及录音内容，用户不必跳到另一份库存表才能查看数量。Cassette / DAT 库存仍由统一的 Recording Media 数据支持。

## 实体音乐库 / Physical Music Library

同一库内支持按类型筛选：

- 原版 CD；
- 商业原版磁带；
- 自录磁带，以及既有范围内的自录 DAT。

原版按发行版与实体收藏信息展示；自录按录音标题、曲目、J-Card 与实体编号展示。已录副本在这里和所属磁带型号详情同时可见，使用同一个 Physical ID。Recordings 是其录音历史视图，不是第三份实体库存。

---

# 20. Recording Media Catalog 数据结构

正式结构：

Brand<br>
→ Series<br>
→ Edition<br>
→ Collection Model<br>
→ SKU<br>
→ Inventory Lot<br>
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

ReferenceSourceVersion 与 CatalogRevision 分开记录；本 PRD 不表示参考书或现有 Excel 已经导入、清洗或验收。

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

Brand<br>
→ Chronology<br>
→ Collection Model Cards

例如：

## TDK

1986<br>
[SA] [SA-X] [MA]

1988<br>
[SA] [SA-X] [MA] [MA-XG]

1990<br>
...

每张卡代表：

> 一个 Collection Model

而不是每个不同时长占一个卡位。

### 照片与展示要求

- 卡片以实体磁带或包装照片为主视觉，品牌、型号、版次与数量为辅助信息；首版不能仅用文字表格替代收藏墙。
- 优先使用用户提供的实物照片；参考目录图片明确标为参考图，没有图片时使用明确占位。不能把参考图或生成图当作用户拥有实物的证据。
- 卡片使用一致的图片展示框和留白，保持原图比例，不能裁掉识别型号、版次的重要区域；具体视觉样式在设计阶段确认。
- 卡片显示可读的拥有数量及主要状态，状态不只依靠颜色表达；点击或键盘操作可进入型号详情。
- 图片缺失、加载失败和长型号名都有可用布局；滚动照片墙时按需加载缩略图，不直接批量加载原始大图。
- “美观”需要后续实物照片样本的界面评审与 Owner 确认。本轮只有需求定义，不代表视觉验收通过。

---

# 28. Collection Wall 状态

收藏状态采用正交维度，不能使用单一互斥枚举：

| 维度 | 值 |
|---|---|
| OwnershipStatus | Unknown / Missing / Owned |
| IdentificationStatus | Unidentified / Partial / Candidate / Verified |
| WantIntent | None / Wanted |

只有已确认的对应关系和至少一个在手时长 SKU 才能使 Collection Model 计入已收藏。疑似实物未确认 Edition 时，保留 Candidate/Uncertain 展示，不计作确认完成。

Wanted 可以与 Owned 同时存在，目标可以是另一时长、更好品相、未拆封或另一市场版。未知库存不能自动判定 Missing。

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

TDK<br>
86 / 104

SONY<br>
79 / 111

Maxell<br>
...

### Series

TDK SA<br>
12 / 15

TDK SA-X<br>
...

---

# 31. Completion 计算

主完成度 = 已确认拥有的 Collection Models / 当前 CatalogRevision 的全部 Canonical Collection Models。

按型号 + Edition 计算，不按时长 SKU 数量计算。Owned、Missing、Unknown 必须分别显示；Wanted 不改变分子，候选关系不能自动贡献分子。

ReferenceSourceVersion 保存参考资料版本和 Source Pack SHA-256；CatalogRevision 保存整理后的目录版本。书籍图片、数量和完成度示例均为说明，不是实际已导入数据。

目录纠错创建新 Revision：去重合并映射既有 Ownership；拆分型号将旧匹配置为 Needs Review，不能把一盘自动计为两个；新增遗漏型号只改变新 Revision 的分母。保留历史完成度 Snapshot，并展示升级前后差异。

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

Want List 也允许针对已拥有型号补某个时长、品相或包装目标，不要求先把 Ownership 改成 Missing。

---

# 34. Collection Wall 与实际库存关系

Reference Catalog 和 My Inventory 必须是独立对象。

关系：

Reference Collection Model<br>
↕ Verified / Candidate Match<br>
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

- Sealed Blank ×5；
- Opened Blank ×1；
- Recorded ×1。

上述数字仅为说明展示与数量守恒的合成示例，不是用户库存。

型号详情必须同时回答“有多少、什么状态、录了什么”：

- 按时长 SKU 展示总拥有量、未开封空白、已拆空白、已录音数量，并另行标示已预留、不可用和待确认数量。
- 未开封空白是 Packaging=Sealed 与已确认 Blank 的交集，不能把未开封数量、空白数量与总拥有量直接相加。未知余量不能推断成可录空白。
- 已实例化副本可打开单盘详情；同质 Pool 仍按数量展示，不为了照片墙给所有未拆封磁带预分配永久 ID。
- 已录音副本显示实体编号、录音标题、封面或 J-Card 预览及 A/B 曲目；详细页可查看录音日期、内容和历史。DAT 按连续 Program 展示。
- 未登记录音内容的旧磁带显示“已录音，内容待补录”，允许人工补录，不虚构曲目或成功录制证据。

从已录磁带跳到实体音乐库或录音档案后，实体身份、内容与数量必须一致。

---

# 36. Featured Copy

支持：

**Featured Copy**

允许用户为某个 Collection Model 选择一盘代表性实物，用于收藏墙展示。

V3.0 首版需支持基本的照片添加与代表图指定，以满足照片收藏墙；批量修图、自动抠图和复杂照片管理不在本次补充范围。未指定时可用已有照片或带来源标记的参考图，不伪造实物照片。

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

TDK MA-XG 90<br>
Sealed ×5<br>
Reserve = 3

录音推荐系统不得优先建议使用保留线内的未拆封收藏。

---

# 40. Inventory Quantity

大量同质磁带先在 Inventory Lot / Pool 中按数量管理，不自动创建等量永久 Physical ID。

Lot 保存 `quantity_acquired`、`pooled_balance`、`source_import` 和购买信息；实体副本保存 `source_lot_id`、`physical_id` 和个体状态。

Pool 中实例化一盘必须是同一库存事务内的转移，例如 Pool 8 → 7、Physical Copy +1，总拥有量仍为 8。Ledger 记录 IMPORT、POOL_TO_COPY、COPY_TO_POOL、DISPOSED、LOST、RETURNED、ADJUSTMENT 等动作；恢复或重复命令不能重复记账。

Collector Policy、Minimum Sealed Reserve 和可用数量以当前真实库存状态计算，不能将未知余量当作未拆空白。

---

# 41. Physical Copy

当一盘磁带拆封、Reserved、Recorded、单独收藏、损坏或单独拍照并产生独立历史时，才创建 Physical Copy。

创建必须从对应 Pool 或 Legacy Used 分类转出一盘，保持数量守恒并记录 Ledger Transaction，不得叠加计数。永久 Physical ID 一经分配不复用；归池、擦除或重新录音也不能抹掉已发生的实体历史。

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

V3.0 必须支持现有 Spreadsheet Import；每一源行默认形成 Inventory Lot，保留 Brand、Model、Version Candidate、IEC Type、Length、Quantity、Price、Purchase Date、Used 和 Notes。

每次导入建立 ImportBatch，保存 Workbook SHA-256、Sheet Name、Row Index、Raw Row Hash、Normalized Row Signature 和 Source Row。原始值必须可追溯，Unknown 可直接入库。

相同文件重复导入不得产生新数量；修改后的表格形成 Import Revision 并显示差异。行号只是来源位置，不能单独作为跨 Revision 的库存身份；插入、删除、排序后的对应关系需可靠匹配或人工确认。

---

# 44. Non-destructive Import

导入必须保留 Raw Value 和 Source Row，允许规范品牌与产生 Candidate Catalog Match，不要求用户先清洗全部数据。

再次导入只能提出更正建议。人工确认的 Edition、Physical Copy、状态、照片和历史不被导入覆盖；用户确认数据优先于再次导入的原始表格。更正数量必须通过明确的 Ledger Transaction，不静默重置库存。

---

# 45. Legacy Used

表内已用数量导入为 `Legacy Used — Unregistered`，不自动分配 Physical ID。

例如总数 10、已用 3：Legacy Used = 3、Unclassified Remainder = 7、Total Owned = 10；余下七盘不能自动认定为未拆空白。

以后登记一盘真实旧录音时，Legacy Used 3 → 2、Physical Copy +1，总拥有量仍为 10。无法满足非负或数量守恒的行进入待核对，不伪造可用库存。

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

用户在录音界面选好 Roon 曲目后，即可依据草稿曲序、曲长和默认间隔查看**现有库存**的初步推荐，不必先完成 Logic 处理。正式选择与录音前必须按已确认的源、A/B Layout 或 DAT Program 重新校验。

系统根据：

1. Fit
2. Equipment Compatibility
3. Availability
4. Collection Policy
5. User Preference

推荐合适介质。

候选来自用户已经拥有且确认可用的空白库存，不把参考目录里尚未拥有的型号当作可用介质。已录音、已预留、不可用或状态不明的磁带不自动当作空白；不自动擦除或覆盖已有录音。

Hard Constraint 优先。Cassette 必须分别检查 A/B 两面的可容纳时长，不能只比较总时长；尚未确认的参数显示“待确认”，不能标为可以正式录音。设备兼容性、收藏保护和 Minimum Sealed Reserve 必须参与筛选；默认推荐不使用受保护的封存库存，修改保护须由用户明确操作。

推荐卡显示实物或明确标记的参考照片、型号/版次/时长、可用数量、未拆或已拆状态、适配情况和原因；约束内优先推荐已拆空白，减少拆封收藏。用户可以选择其他合规候选，系统不自动预留或开始录音。

无合适库存时明确解释容量、兼容性或收藏保护等原因，允许调整曲目/分面或补充库存，不能假装推荐成功。曲目、间隔或 Logic 最终输出时长发生变化后必须重新计算推荐和适配性，不能默默换磁带。

例如：

**Sony UX-Pro 90**

- Fits Side A / B；
- 已拆空白；
- Deck Compatible；
- 不影响收藏保留。

---

# 48. Commercial Music Releases

实体音乐库在同一浏览视图内支持原版与自录两类来源：

## CD

## Prerecorded Cassette

## Personal Recording

自己录制的 Cassette / DAT 在登记后自动出现，无需再手工添加一次唱片。新录音按正式完成状态发布；已存在的旧录音可人工登记并保留“历史补录/待核实”标记，不能伪造一次新的 Formal Recording。

CD 与 Prerecorded Cassette 保持商业发行版身份，自录磁带保持录音身份，并明确标为“自录”。同库展示不把三者合并成同一种发行版，也不把空白磁带复制为第二盘实物。自录磁带仍属于其原有 Collection Model，可从两个收藏视图进入同一副本详情。

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

V3.0 的双向可见关系放在 V3 Media → Music Release Detail、V3 Collection Matrix 和 V3 Master Source Picker；可提供 Play/Open in Library。首发不要求在现有 V2 Library、Search 或 Album Detail 加 Badge。相关后续增量必须单独评审且可关闭。

自录磁带沿 Recording → 冻结的 Master/曲目 → 数字源及 Roon 辅助关系查看所录音乐。跨专辑精选允许关联多张专辑与多首曲目，不能强制匹配为一个商业 Release，也不能仅因录了某张专辑就自动创建 Exact 原版关系。Roon 暂时不可用时保留实体和录音记录，显示链接不可用，不删除收藏。

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

Physical Only / Digital Only 表达经确认的缺少状态，未检查或未匹配不能自动成为不存在的证据。

---

# 53. Digital Provenance

如果用户确认某个 Roon 数字版来自自己收藏的 CD：

Physical CD<br>
→ Rip<br>
→ FLAC<br>
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

矩阵中的原版磁带与自录磁带必须分别标示；自录某张专辑不增加“拥有商业原版磁带”的数量或完成度。跨专辑自录内容可按曲目关联查看，不伪造整张原版专辑拥有状态。

---

# 55. 录音设备参数（无独立设备页）

设备参数在录音设置上下文中管理，不建立独立 Equipment 页面。只管理录音需要的设备：

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

Prepared Master<br>
→ RME<br>
→ RCA<br>
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

正式录音前冻结 RecordingPlanVersion，至少引用：

- MasterVersion、LayoutVersion；
- PlannedTimelineManifest；
- PreparedMasterVersion 与 RenderTimelineManifest（Prepared 路径）；
- 已编译并验证的 Execution Asset / Derivative、Hash 和执行 Manifest；
- Physical Copy；
- Recording Profile Snapshot 与 Session Parameters；
- 固定 Execution Format、Output Backend、Output Profile Version；
- Archive Policy 与相关归档操作结果。

同一 Side 或 DAT Continuous Program 不得中途改变采样率或声道布局。Backend、格式或执行内容改变时必须重新预检并冻结相应新版本，不能修改正在执行的 Plan。

---

# 60. Formal Recording Mode

公共 Preflight：Master/Layout 已冻结、Physical Copy 已绑定、Profile Snapshot 就绪、Archive Root 可用、Execution Asset 已验证、输出后端在已验收配置范围内且就绪。

Direct 额外检查：精确源绑定与谱系已验证、编译 Manifest 与 Execution Asset 匹配、Archive Policy 满足、Smart/在线回退禁用。

Prepared 额外检查：PREP 与 Master/Layout/Planned Timeline 匹配，Render Timeline 已确认，原始 Render Hash 及 Execution Derivative 谱系匹配，不重复插入 Gap。

正式输出只读取冻结的 Execution Asset，不在运行时逐首打开和转换原源文件。引擎不得把普通 Roon/Smart 队列当作录音内容权威。

若没有通过 Gate B 的正式后端，只允许标明非正式的 Setup/Test，不得进入正式录音。失败后选择另一后端只能在新的显式计划/预检中进行，不能中途自动切换设备、Roon Zone、系统扬声器或在线来源。

---

# 61. Cassette Recording Flow

Ready<br>
→ Begin Side A<br>
→ Side A Playback<br>
→ Side A Complete<br>
→ Stop<br>
→ Flip Tape<br>
→ Begin Side B<br>
→ Side B Playback<br>
→ Final Verification

A 面结束：

> 不得自动开始 B 面。

---

# 62. Recording Attempts

Recording Attempt 记录运行状态与终态，至少区分 In Progress、Completed、Aborted、Failed、Interrupted。

外部切歌、Zone/路由变化、设备断连、读取失败、underrun、崩溃等使当前 Attempt 进入 Interrupted；成功停止后也不能自动改回 Completed。重启后发现未结束 Attempt，必须恢复为 Interrupted，禁止自动续播。

恢复播放或重新录制需要用户明确确认位置和新的执行边界；不得改写旧 Attempt 的中断事实。Setup/Test 不进入正式 Attempt History，但技术测试证据单独保留。

---

# 63. Final Verification

每次录音分别保存 `SoftwarePlaybackComplete`、`PhysicalRecordingConfirmed`、`FinalVerificationComplete`。三者全部成立且没有未解决中断，才能成为 Completed。

软件源文件读完不等于输出设备排空；软件完整输出时间线也不等于实体磁带机确实录下。用户分别确认 Side A、Side B 或 DAT Program、已知中断与实体录制完成；可补充 Playback Checked 和 Quality Notes。

异常时自动可证明的引擎状态、输出端实际无声的测量结果、用户确认的实体停止状态必须分开。错误提示不得经正式录音音频通路播放；系统通知也必须无声或使用已确认独立的提示设备。

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

还须记录 Plan/Attempt 身份、Planned 与 Render Timeline、实际 Execution Asset Hash、转换谱系、输出后端及配置、归档策略和各层确认依据。历史快照不可被后续默认配置、Metadata 或模板修改。

满足正式完成条件后，同一 Physical Copy 自动在实体音乐库中以“自录”显示，并在磁带型号详情中展示录音内容与 J-Card；这是同一实体记录的两个视图，不新增一盘库存。重复完成通知、应用重启或归档恢复不得重复登记。

失败或中断不能显示为已完成的新录音。可能已写入实体磁带的副本不能自动回归空白可用库存，必须保留状态与人工核实入口。重新录制仍使用原实体编号，保留旧录音历史；未核实当前内容时，不把旧档案当作磁带此刻仍含有该内容的证明。

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

Digital Replica 必须依据该次 Recording 冻结的执行事实播放，不按当前 Master、当前默认 Profile 或新发现的同名歌曲重新解释历史。

Prepared Recording 保留原始 Render；使用了 Execution Derivative 时还需保留其谱系与 Hash，并明确播放原始 Render 还是当年实际执行版本。Direct Recording 依据 Execution Asset 或完整的冻结源、执行格式和 Manifest 重建；已编译/已烘焙的静音不得重复添加。

Reference Dependent 不能承诺在外部源丢失后仍可重建；Preserve Exact Sources 在所需源和依赖齐备时提供重建基础。缺失、变化或恢复异常必须明确显示，不得自动替换。

新增 Execution Asset 之后，其长期保留与清理策略仍需与两种源归档策略明确对应。在该策略确认前，不实现自动删除，也不宣称所有 Direct Recording 都已成为自包含档案；见 Development Pack 的 F-01。

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

MusicBridge 使用独立 Recording Archive Root，保存 Prepared Renders、Execution Assets/Derivatives（按明确保留策略）、Manifests、Artwork、J-Cards、Metadata、Physical Photos 和操作恢复清单。

原始 Roon / Local Music 始终只读，严禁删除、移动、重命名、修改或覆盖原件。用户明确选择后，可以复制实际用于录音的源文件到独立归档，不复制整库。

Direct 提供 Reference Dependent 与 Preserve Exact Sources 两种策略；后者作为默认候选但复制前仍需明确选择。内容按 Hash 寻址去重，不覆盖既有不可变对象。Prepared 原始 Render 必须归档，执行派生文件不能冒充原始 Render。

归档协议使用稳定 operation_id：INTENT_WRITTEN → STAGED → VERIFIED → PROMOTED → DB_COMMITTED → FINALIZED。文件 Promote 与数据库提交之间的崩溃窗口由幂等恢复器处理，不能把单次 rename 当作跨资源事务。

V3.0 必须具备空间/可用性预检、启动恢复、Backup Archive Now、数据库与 Manifest 恢复以及根据 Manifest 重建基本索引。完整档案备份必须覆盖声明范围内的 Content Object 字节；只备份数据库、Manifest 和索引不得标为可独立恢复的完整音频备份。SQLite 一致性要求及完整故障矩阵见附录 A 与 Gate E。

技术验证只使用可丢弃测试目录与合成数据，不向真实音乐库或用户库存注入故障。

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

同一 PREP 的原始 Logic Render 与 Execution Derivative 分开保存和寻址。旧 PREP 继续对原 Master/Layout 和历史 Recording 有效，UI 只标注其与当前新版本不兼容。

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

用户主流程：**开始录音 → 从 Roon 选择音乐 → 按现有空白磁带库存推荐 → 用户选择磁带 → 确认曲序/分面与录音设置 → 预检 → 录音 → 确认完成 → 自动进入实体音乐库，并在磁带型号下展示曲目与 J-Card。**

工程准备：选曲形成 Draft Master → 用草稿曲长/间隔估算库存适配 → 用户选择候选并显式预留副本 → 绑定并验证 Exact Sources → 确认曲序、间隔及最终 Layout → 重新校验介质适配 → Master/Layout Freeze。初步推荐不是 Source Lock 或正式开录许可。

执行准备：确认 Profile、Overrides、Execution Format 与已验收 Backend，再按以下 Direct 或 Prepared 路径生成执行资产；不能先编译再悄悄更换输出格式。

Direct 分支：冻结源 + Layout/Timeline → Compile Execution Asset → 验证执行音频与帧级 Manifest。

Prepared 分支：Prepare in Logic → 用户声音处理 → 导入 Cassette A/B 或 DAT Continuous Render → 用户确认实际 Marker → Conformance Report → Prepared Master Freeze → 直接使用合规 Render 或生成 Execution Derivative。

共同执行：最终输出与选定介质重新匹配 → Recording Plan Freeze → Preflight → Formal Recording → 三层 Final Verification → Recording Archive → J-Card → 同一实体在两个收藏视图中更新。Logic 处理改变实际时间线时回到布局/容量确认，不自动更换已选磁带。

Cassette A 面完成必须等待用户翻面，不能自动播放 B 面。DAT 为 Continuous Layout，保存总时长、Lead-in、容量、录制模式/采样率、设备兼容性、可选 Cue 和多盘 Segment Split；流程为 Preflight → Begin → Continuous Playback → Playback End → 用户确认实体停止和完成 → Final Verification。未验证具体硬件通路前，不宣称自动写 DAT Track ID。

---

# 74. Blank Tape Collection 主流程

Reference Book Catalog<br>
→ Build Canonical Collection Models<br>
→ Import Existing Spreadsheet<br>
→ Candidate Match Existing Inventory<br>
→ User Verify<br>
→ Blank Tape Collection Wall<br>
→ Owned / Missing / Unknown / Wanted<br>
→ Want List<br>
→ Add Newly Purchased Tape<br>
→ Model Becomes Collected<br>
→ Completion Progress Updates<br>
→ Eventually Book Collection = 100%。

日常浏览不要求先完成整本参考书建档：打开照片收藏库 → 选择已有型号 → 查看各时长及未开封空白/已拆空白/已录音数量 → 打开某盘已录磁带 → 查看 J-Card 式曲目详情与数字源关联。参考目录匹配和完成度规则继续独立生效。

---

# 75. V3.0 MVP 成功标准

V3.0 首版至少必须实现：

1. 现有侧栏增加收藏、录音两个独立入口，不增加第二套永久侧栏。
2. V2 原有页面和播放能力无回归。
3. 收藏双视图与独立录音页可用；无 V3 概览页或设备页，母版和录音记录为录音页内的次级入口。
4. Personal Master 可创建。
5. Exact Digital Sources 可锁定。
6. Compilation 默认 5 秒间隔。
7. Cassette A/B Layout 可生成。
8. Logic Preparation Workspace 可生成。
9. Logic A/B WAV 可重新导入。
10. Prepared Master 可冻结。
11. 现有磁带 Excel 可批量导入。
12. Blank Cassette / DAT 可库存管理，型号详情显示未开封空白、已拆空白、已录音及待确认数量与单盘录音内容。
13. Physical Copy 可分配永久 ID。
14. 从 Roon 选曲后按现有空白库存推荐介质，显示原因、可用数量和分面适配，正式录音前重新验证。
15. Equipment / Recording Profile 可复用。
16. Formal Recording Mode 可完成 A/B 流程。
17. Recording Archive 可保存并查询；自录磁带自动进入同一实体音乐库，同时保留型号归属和唯一实体身份，不双计库存。
18. Digital Replica 可播放。
19. 基础 J-Card 可生成。
20. CD 可录入。
21. 原版磁带可录入。
22. 原版 Physical Release 可关联 Roon Digital Release，自录磁带可追溯各曲目数字源；原版关联与自录谱系不混淆。
23. 《磁带大全》可建立 Canonical Collection Set。
24. Blank Tape Collection Wall 以实物照片为主，按品牌与年代展示；照片卡片、型号详情和 J-Card 式录音内容需独立视觉验收。
25. 同型号同版次不同时长只计算一个收藏项目。
26. 拥有任一时长即视为该 Collection Model 已收藏。
27. 多时长收藏信息仍可查看。
28. Owned / Missing / Unknown / Wanted 可管理。
29. Series / Brand / Book Completion 可计算。
30. Missing Collection Models 可进入 Want List。

以上 30 项产品范围继续保留，并受以下新增退出条件约束：数字源多维证据与 Source Lock；固定格式 Execution Asset 与帧级静音；输出后端配置范围内的实测验收；Planned/Render Timeline 独立确认；库存幂等账本；归档幂等恢复与一致性备份。Gate A～E 均以 Development Pack 的矩阵逐项取证，不能凭本文存在或 V2 测试通过标为完成。

---

# 76. 产品原则

1. **V2 Zero Regression。**
2. **收藏与录音分开，保留同一套应用侧栏。**
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

19. 正式录音内容与时间线由 MusicBridge 冻结合同决定，输出后端不决定曲目。
20. 证据来源、验证、保存、可用性和关系分别记录。
21. 正式录音只播放已验证 Execution Asset，禁止临时 Smart/在线回退。
22. 软件、设备输出与实体录制完成分别验证。
23. 文档冻结、技术 Gate、实现、集成与 Owner 产品接受分别记录。

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

**Roon Digital Library**<br>
↕<br>
**Physical CD / Original Cassette**<br>
↕<br>
**Personal Master / Logic Prepared Master**<br>
↕<br>
**Blank Cassette / DAT Collection**<br>
↕<br>
**Personal Physical Recording Archive**

MusicBridge 从“播放桥梁”进一步成为：

> **连接数字音乐、实体音乐收藏和个人录音行为的私人音乐系统。**

---

# 附录 A：数据真实性、执行、谱系与恢复合同

以下整合最终补丁的四组详细合同。Certified 仅表示在明确记录的硬件、软件、缓冲及故障矩阵中通过项目验收，不是第三方认证或对所有运行环境的绝对保证。100 ms / 2000 ms 是待验证目标，不是已有结果。

## 1. 数字源证据改成多维状态，不再使用互斥“证据等级”

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

### 1.1 Acquisition Method：文件怎么来的

```text
SOURCE_ROOT_SCAN
USER_FILE_BIND
ROON_DESKTOP_EXPORT
USER_IMPORT
DAW_RENDER_IMPORT
ARCHIVE_RESTORE
```

`ROON_DESKTOP_EXPORT` 只表示获得方式，不代表已经验证，也不代表已经归档。

### 1.2 Verification State：文件验证到什么程度

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

### 1.3 Preservation State：文件保存在哪里

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

### 1.4 Availability State

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

### 1.5 Roon 关系单独保存

还应单独记录：

```text
RoonRelationship
├─ NONE
├─ CANDIDATE
├─ USER_CONFIRMED_COUNTERPART
└─ USER_CONFIRMED_PROVENANCE
```

一份通过 Roon 桌面导出的文件，经过 Hash 验证后，可以成为**本次录音的精确输入文件**；但除非另有证据，不能宣称其文件字节与 Roon Watched Folder 中的原文件完全相同。

### 1.6 Source Lock 改成计算条件

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

## 2. 正式录音冻结“执行格式”和帧级时间边界

本版采用以下执行边界：

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

### 2.1 Recording Execution Format

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

### 2.2 5 秒的帧级定义

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

### 2.3 中止延迟拆成四个指标

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

冻结候选验收指标如下（尚未实测，不表示当前后端具备该能力）：

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

Roon 的公开 Transport 合同提供 Zone/Queue 订阅和 play、pause、stop 等控制，并写明 stop 会停止播放和释放设备，但公开合同没有提供录音独占锁或排他租约。因此不能仅凭发送 `stop` 就承诺端到端独占与停止时间，必须经过 Gate B 实测；如果实测不合格，Roon 后端只能是非认证路径，只有在新建计划和重新预检时，才可选择已通过验收的本地输出后端；不得在当前 Attempt 中自动换后端。([Roon Labs][1])

### 2.4 三种“停止”不能混为一谈

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

## 3. 区分计划时间线与 Logic 最终 Render 时间线

正式增加两个不同对象：

```text
PlannedTimelineManifest
```

和：

```text
RenderTimelineManifest
```

### 3.1 Planned Timeline

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

### 3.2 Final Render Timeline

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

### 3.3 导入时生成 Conformance Report

```text
RenderConformanceStatus
├─ MATCHED
├─ ACCEPTED_VARIANCE
├─ REQUIRES_NEW_LAYOUT
├─ REQUIRES_NEW_MASTER
└─ REJECTED
```

规则如下。

#### MATCHED

* 曲目一致；
* 顺序一致；
* Side 分配一致；
* 实际位置在容差内；
* 总时长可容纳。

#### ACCEPTED_VARIANCE

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

#### REQUIRES_NEW_LAYOUT

以下情况必须建立新 Layout Version：

* A/B 分界改变；
* 曲目换到另一面；
* 总时长不再适配原介质；
* Lead-in/Tail 规则发生结构性变化；
* C90 改为 C60×2。

#### REQUIRES_NEW_MASTER

以下情况必须建立新 Master Version：

* 全局曲序改变；
* 替换曲目；
* 增删曲目；
* 更换 Exact Digital Source；
* 把某个 Live 版本换成 Studio 版本。

### 3.4 如何确认实际曲目标记

V3.0 不应假装可以只靠文件总时长自动证明全部内容正确。

Logic 导入验收至少提供：

1. MusicBridge 显示计划 Marker；
2. 用户在最终 WAV 时间线上校正实际开始点；
3. 系统可用波形、时长或声学匹配提出候选；
4. 候选不能自动变为档案事实；
5. 用户确认后冻结 `RenderTimelineManifest`。

以后可以增加 DAW Marker Sidecar 导入，但 V3.0 不依赖该自动化才能工作。

### 3.5 旧 PREP 的有效性规则

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

## 4. 增加 Gate E：Archive Recovery

这一项必须进入开工前技术 Gate。SQLite 的事务可以保证数据库内部提交的原子性，但它不会自动把“外部音频文件已经移动到正式目录”和“数据库记录已经提交”变成一个跨资源原子事务；WAL 本身也属于数据库持久状态的一部分。因此 MusicBridge需要自己的、可重复执行的归档恢复协议。([SQLite][2])

### 4.1 Archive Operation 状态机

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

#### INTENT_WRITTEN

持久化操作清单：

* 目标对象；
* 预期 Hash；
* 源位置；
* 目标 Content Address；
* 关联 Master/Layout/PREP；
* 恢复动作。

#### STAGED

复制到临时区，尚不可被正式 Recording 引用。

#### VERIFIED

完成：

* 文件长度检查；
* Hash；
* 格式解析；
* Manifest 验证；
* 磁盘同步。

#### PROMOTED

文件已进入正式 Content Store，但数据库可能尚未提交。

#### DB_COMMITTED

SQLite 事务已经写入正式对象关系。

#### FINALIZED

清理 staging 和操作残留，操作结束。

### 4.2 启动恢复规则

MusicBridge 启动时扫描未完成操作。

#### 崩溃发生在 STAGED / VERIFIED

* 正式数据库不得引用该文件；
* 可继续复制或清理 staging；
* 不产生 Frozen Prepared Master。

#### 文件已 PROMOTED，但数据库未提交

这是用户指出的关键窗口。

恢复器必须：

1. 读取持久化 Operation Manifest；
2. 验证正式文件 Hash；
3. 幂等完成数据库提交；
4. 或将对象移入 Quarantine；
5. 绝不能重复增加记录或库存数量。

#### 数据库已提交，但尚未 FINALIZED

* 验证正式对象存在且 Hash 正确；
* 完成清理；
* 标记 FINALIZED。

#### 数据库引用存在，但文件缺失

不得静默继续。

标记：

```text
ArchiveRecoveryRequired
```

并阻止依赖它的 Formal Recording 或 Digital Replica。

### 4.3 恢复必须幂等

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

### 4.4 Gate E 测试矩阵

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

### 4.5 备份规则

不能只复制一个正在使用的 SQLite 主文件。

备份应使用：

* SQLite Backup API；或
* 应用进入 quiescent 状态后的一致性快照；
* 同时备份 Archive Manifests 与 Content Store 索引。

如果使用 WAL，必须按 SQLite 的一致性要求处理数据库及其相关状态，不能把活跃数据库主文件和 WAL随意拆开复制。([SQLite][3])

---

## 附录 A 的解释与待确认边界

- 运行 Source Lock 时必须同时具备技术参数探测与完整文件 Hash 证据，不能因某个较高验证标签存在而丢失其他条件。
- Hash 计算完成只证明当次读到的字节；编译前和归档/执行前仍需按冻结输入检查变化，不能只信任文件名或旧标签。
- 系统通知不得发出会进入正式音频路径的提示音。
- 引擎文件读完、设备排空与实体完成不可互相替代；崩溃测试需要独立观察，不能依赖已退出进程自证。
- Execution Asset 编译不等于永久归档；源文件与执行派生文件的保留和备份策略见开发包 F-01。该确认完成前不自动清理。
- 正式档案备份需区分元数据备份与包含音频内容对象的完整备份；恢复指标按声明范围验收。

# 附录 B：来源身份

| 来源 | 原文件 SHA-256 | 规范化快照 SHA-256 | 用途 |
|---|---|---|---|
| [v0.2 产品范围](sources/V3_PRD_v0.2_SOURCE.md) | `e82fba984e160be8d35a365e51c59ae279273a470d346bc97f83ce3dd1e616b9` | `c11c5c3083378adb58197bd4db2abb4ec48f1b765ca7240b5b57c3a5ebb58cd2` | 只读原始提案快照 |
| [首轮工程合同](sources/V3_ENGINEERING_CONTRACT_SOURCE.md) | `f06eaa4179a8d66a41b12f5eba0ffd15c5e32d8ee334196505f4c8db1c71ba13` | `f06eaa4179a8d66a41b12f5eba0ffd15c5e32d8ee334196505f4c8db1c71ba13` | 只读原始提案快照 |
| [最终冻结补丁](sources/V3_FINAL_FREEZE_PATCH_SOURCE.md) | `ef2238f737d3d4993f7cfd9678f91a373ad70ebfc3536766f5ded99bdc170fbd` | `ef2238f737d3d4993f7cfd9678f91a373ad70ebfc3536766f5ded99bdc170fbd` | 只读原始提案快照 |

## 官方技术参考

- [Roon Transport 合同](https://roonlabs.github.io/node-roon-api/other_node-roon-api-transport_lib.js.html)：仅支持公开接口能力判断，不提供本项目停止延迟或设备独占的实测证据。
- [SQLite Atomic Commit](https://www.sqlite.org/atomiccommit.html)：数据库事务边界。
- [SQLite WAL](https://www.sqlite.org/wal.html)：WAL 与数据库持久状态的一致性要求。
- [SQLite Backup API](https://www.sqlite.org/backup.html)：一致性数据库备份入口；外部内容文件仍需应用自己的备份协议。

[1]: https://roonlabs.github.io/node-roon-api/other_node-roon-api-transport_lib.js.html
[2]: https://www.sqlite.org/atomiccommit.html
[3]: https://www.sqlite.org/wal.html
