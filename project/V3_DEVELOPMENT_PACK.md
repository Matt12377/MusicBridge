# MusicBridge V3.0 Development Pack

**状态：** `FREEZE_PENDING`<br>
**实现授权：** `OWNER_GRANTED_SEQUENTIAL_SLICES`（2026-08-27）<br>
**技术 Gate：** A / B / C / D / E 全部 `NOT_RUN`<br>
**基线：** `codex/v3` / `90d0aa8aa7f156c6ecfc6f366eea698f8e4d6098`<br>
**正式需求：** [PRD v0.3](../docs/prd/MUSICBRIDGE_V3_PRD_v0.3.md)

本文件将用户最终冻结补丁转为可分配、可取证的技术验证要求。Owner 已认可 Preview 02 并授权开始开发，首个 Slice 为 TASK-048 导航与页面基础；具体代码范围与证据由任务定义和报告承载。文档检查通过不等于以下 Gate 通过。

## 1. 授权与冻结层次

| 层次 | 当前状态 | 退出条件 |
|---|---|---|
| 产品与工程文档 | FREEZE_PENDING | 正文与开发包一致，冻结确认项明确，Owner 确认冻结版本 |
| 技术 Gate A～E | NOT_RUN | 每个 Gate 有独立授权、精确代码身份、实际证据和退出结论 |
| 输出后端认证 | NOT_RUN | Gate B 在指定硬件/软件/配置及故障矩阵中全部通过 |
| 产品功能实现 | OWNER_GRANTED_SEQUENTIAL_SLICES | 已授权启动；首任务 TASK-048，按任务拆分、独立分支及 TDD 推进 |
| V2 回归 | 本轮未重跑 | 每个实现 Slice 都必须执行，不用旧 main 的通过结果替代 |
| 真实录音与 Owner 接受 | NOT_RUN | 实际设备、实体录制和用户确认分别记录 |

文档进入 Frozen 只冻结规则，不自动把 Gate 改成 PASS。通过 Gate 不自动授权完整功能开发、GitHub push、发布、部署或接入真实账号。既有 TASK-047 的真实歌词验收 carryover 继续保留。

## 2. 冻结确认项与技术参数

### F-01：Execution Asset 长期保留

最终补丁新增 Direct Execution WAV，但没有完整指定它与 Reference Dependent / Preserve Exact Sources 的长期保留关系。冻结前需明确：

- 成功录音使用的 Direct Execution Asset 是否永久归档；
- Prepared Execution Derivative 的保存和清理条件；
- 只保留源文件、只保留执行音频、两者都保留时，分别承诺“重建”还是“精确重播”；
- 失败或取消 Attempt 的临时执行资产如何清理；
- 哪些 Content Objects 必须包含在完整备份中。

当前不代替 Owner 选择该策略，不实现自动清理，不把“编译成功”写成“已永久归档”。原始源与原始 Logic Render 的只读/不可覆盖边界不变。

F-01 继续阻断相关录音/归档规则冻结，不阻断不触及源文件、存储和音频执行的 TASK-048 导航基础。开始开发不将整体 `FREEZE_PENDING` 改成已冻结。

### 测试配置在 Gate 启动前锁定

具体声卡/录音设备型号、输出后端、采样率与声道配置、转换器及版本、dither、缓冲、Marker 容差、停止延迟样本数量/持续时长和测量装置，均须在对应 Gate 计划中明确。当前为 `UNSELECTED`，不能杜撰设备能力或认证结果。

`T_engine_cutoff ≤ 100 ms`、`T_total` 的测试最大值 `≤ 2000 ms` 是待验证目标。测试最大值只描述指定矩阵和配置，不是任意环境中的绝对上限。任一必要故障无法测量、缺样本或超限，结果不是 PASS。

## 3. 每个 Gate 的入口纪律

1. 核对指定工作树、分支、HEAD、远端对应分支、index/untracked、锁与占用，不接管其他工作树 WIP。
2. 指定具体任务、基线 SHA、允许修改文件、测试入口、允许使用的数据和设备；本开发包不预授权这些写入。
3. 先通过实际生产边界构造最小行为 RED，再实现必要能力并验证 GREEN。编译失败、零测试或仅 fixture 通过不能算行为证据。
4. CI 只用合成数据，不连接真实 Roon/Provider，不读取真实音乐库和库存，不向用户目录注入磁盘满或崩溃故障。
5. 真实文件只在用户明确授权的 Source Roots 内只读访问；实际录音与声卡操作必须由 Owner 安排并确认。
6. 每个 Gate 分别记录本地自动结果、远端结果、实际硬件证据、Owner 确认与 Git 状态。

现有可复用回归入口是 `corepack pnpm@10.17.1 verify`、`test:security`、`test:electron`、桌面 `test:e2e` 以及 control-plane / boundaries / cycles 脚本。A～E 的具体新测试尚不存在，不提供虚构的可运行命令。

## 4. Gate A — Source Evidence

**当前状态：NOT_RUN。** 目标：证明源身份不是浏览标签或歌词签名，并确认合法范围内的只读文件绑定。

| 编号 | 输入/操作 | 必须观察的结果 |
|---|---|---|
| A-01 | 只有 Roon Reference | 可 Draft/试听，不可 Source Lock、Freeze 或正式录音 |
| A-02 | 用户确认 Roon 条目对应实际 FLAC | 技术参数、完整文件 SHA-256、映射确认和时间戳齐备后才可 Lock |
| A-03 | Roon 桌面导出文件，尚未验证 | Acquisition 不自动使 Verification 通过 |
| A-04 | 导出文件经过 Hash/技术探测并确认 | 可作为本次精确输入；不宣称与 Watched Folder 原件字节相同 |
| A-05 | 完全相同文件移动到授权 Root 内另一位置 | 通过相同完整 Hash 更新定位，历史内容身份不变 |
| A-06 | 同名、同歌手、相近时长但内容不同 | 不自动重连，仅候选或 CONTENT_CHANGED |
| A-07 | 网络 Root 暂时离线 | SOURCE_ROOT_OFFLINE，不标记 MISSING，不删除绑定 |
| A-08 | 元数据、文件 Hash、音频载荷 Hash、声学指纹 | 用途分离；声学指纹和歌词签名不能升级为精确证据 |
| A-09 | DSD 或特殊格式参与转换 | 源规格、转换器/版本、参数与执行派生谱系如实记录；不支持时明确阻断 |
| A-10 | 校验后源内容变化或读取中变化 | 不使用旧验证标签继续 Freeze/编译；源与编译输入 Hash 可核对 |
| A-11 | 未授权目录、越出 Root 的路径或链接 | 不自动扩展访问范围；返回有界错误，不泄漏私密路径到公开日志 |

退出证据：合成文件可验证的 Hash/规格结果、每个 SourceLockEligible 条件的负例、源文件前后内容未变、授权的实际文件绑定样本。真实文件证明与合成结果分列。

## 5. Gate B — Deterministic Recording Playback

**当前状态：NOT_RUN。** 目标：证明 Formal Recording 使用已编译资产和冻结执行格式，而不是普通队列或 UI 定时器。

### B 的输入前置

提供可丢弃的三首合成源、明确的 Master/Layout/Timeline 和稳定 Execution Asset。先锁定 backend/profile/version、硬件、软件、采样率、声道、缓冲、转换器、dither、测量方法和故障矩阵。集成验证引用 A/D/E 的精确通过身份；隔离 Spike 使用 fixture 时必须明确标注，不能宣称真实集成通过。

| 编号 | 输入/操作 | 必须观察的结果 |
|---|---|---|
| B-01 | 编译三首固定源 | Formal 播放前完成编译、Hash 和帧级 Manifest 验证；录音时不逐首临时转换 |
| B-02 | Direct Compilation 两个默认曲间边界 | 每段零样本恰为 Fs×5 帧；96 kHz 时各 480,000 帧；检查最终执行文件，不只检查中间数组 |
| B-03 | 原文件自带首尾静音 | 原有静音保留；不把听感间隔大于五秒误判为编译错误 |
| B-04 | Prepared Render 已有间隔 | 不再插入 Gap；合规 Render 直接用，不合规时创建独立 Derivative |
| B-05 | 混合采样率/格式源 | 编译时统一固定格式，谱系完整；同一 Side/Program 不在运行时切换布局或采样率 |
| B-06 | Smart、在线回退、Shuffle、Radio、普通队列续播 | 正式路径全部禁用，失败不会换源或换后端 |
| B-07 | A 面播放结束 | 输出进入已定义的结束状态，等待人工翻面，不自动开始 B 面 |
| B-08 | DAT Continuous 执行 | 不走 A/B 翻面流程；配置和容量匹配，不宣称未验证的自动 Track ID 写入 |
| B-09 | Roon 外部切歌、Zone/输出变化 | 标记 Interrupted，按测量合同停止安全输出，不把外部接管当独占控制成功 |
| B-10 | 声卡拔出、路由/采样率变化 | Interrupted；不回退系统扬声器或另一设备，不自动续播 |
| B-11 | 执行资产读取失败、网络读取故障、underrun | Interrupted，记录事件与各测量时间，不播放替代内容 |
| B-12 | 引擎/应用强制退出后重启 | 未结束 Attempt 恢复为 Interrupted，不显示 Completed，不自动开始新录音 |
| B-13 | 故障提示 | 正式音频输出内没有通知音；只使用静默提示或已确认独立通路 |
| B-14 | 源读取结束、设备排空、用户确认实体完成 | 三者分开取证；不到三层确认不可 Completed |
| B-15 | 输出设备/软件/缓冲配置改变 | 原 Certified 记录不覆盖未测试配置；重新匹配证据或降为未验收 |

### 延迟证据

- `T_detect`：实际故障发生到被识别。
- `T_engine_cutoff`：识别后不再提交新帧，目标不超过 100 ms。
- `T_backend_tail`：停止提交后，输出端实际达到规定无声条件的时间。
- `T_total = T_detect + T_engine_cutoff + T_backend_tail`：所有必测样本的最大值不超过 2000 ms。
- `T_physical_stop`：实体设备由用户停止的时间，独立记录，不算成引擎自动控制能力。

测量计划必须定义共同时基或校准关系、故障注入时刻、无声判据、测量误差、每类样本量与超时。先固定计划再运行，不能用测试结果反推有利阈值。报告 P50/P95/P99/Maximum 及样本数，保留失败与超时样本。

已退出进程不能自证停止效果。缓冲尾音与外部 Roon 接管须从输出端独立测量，不能只用控制 API 回调、文件 EOF 或 UI 状态替代。Roon 未过 Gate 时不得作为正式后端；切到另一个已验收后端需要新 Plan/预检，不能自动切换当前 Attempt。

退出证据：编译资产与 Manifest 校验、零样本帧数、禁止回退测试、全部异常矩阵、实际输出测量、精确配置范围的认证或不认证结论。真实声卡/Roon 未测时只能报告合成引擎子项结果。

## 6. Gate C — Inventory Ledger

**当前状态：NOT_RUN。** 目标：证明所有实例化、重复导入和恢复操作保持数量守恒及人工数据优先级。

| 编号 | 输入/操作 | 必须观察的结果 |
|---|---|---|
| C-01 | 同一个 Workbook 导入两次 | 第二次不增加数量或副本，保留 ImportBatch 溯源 |
| C-02 | 总数 10、Legacy Used 3 | Legacy Used 3 + Unclassified Remainder 7 = 10，不能自动把 7 标为 Sealed/Blank |
| C-03 | Pool 8 中实例化一盘 | Pool 7 + Copy 1 = 8，单一事务，无双计数 |
| C-04 | 从 Legacy Used 登记旧录音 | Legacy Used 减一、Copy 加一，总数不变，不凭导入预分配永久 ID |
| C-05 | 已人工确认 Edition/照片/状态后重新导入 | 只给更正建议，人工记录和历史不被覆盖 |
| C-06 | Owned 型号补购另一长度 | Ownership=Owned 与 WantIntent=Wanted 共存，收藏分子不重复增加 |
| C-07 | 表格改动、增删行或重新排序 | Import Revision 比对，不能把 Row Index 单独当库存身份造成重复或误覆盖 |
| C-08 | 相同 Ledger 命令或恢复重复执行 | 幂等；失败回滚；不出现负余额、重复 ID 或额外库存 |
| C-09 | 未匹配或疑似版次 | Unknown/Candidate 不自动成为 Missing 或确认的 Owned |
| C-10 | 同版次多个时长和多个副本 | 收藏分子只加一个 Collection Model，Length Coverage 和实体数量独立 |
| C-11 | 目录合并、拆分、新增 | 新 CatalogRevision、映射或 Needs Review；历史完成度不被覆盖 |

退出证据：库存守恒前后快照、账本事务/幂等标识、Import Revision 比对、人工覆盖保护和完成度测试。真实 Excel 尚未提供，合成表格通过不代表实际导入验收。

## 7. Gate D — Version Lineage

**当前状态：NOT_RUN。** 目标：证明版本与时间线的兼容性按明确引用判断，不随当前项目变化改写历史。

| 编号 | 输入/操作 | 必须观察的结果 |
|---|---|---|
| D-01 | PREP-001 绑定 M1/L1/P1/R1 | 所有身份、Hash 和实际 Timeline 引用可核对 |
| D-02 | 只改 A/B 分界，曲序不变 | 新 LayoutVersion，MasterVersion 不变 |
| D-03 | 改全局曲序、增删曲、换源或换 Live/Studio | 生成 Proposed MasterVersion，经确认后冻结，不伪装成 Layout 更新 |
| D-04 | 当前项目改为 L2 | 旧 PREP 不兼容 L2，仍对 L1 与历史 Recording 有效 |
| D-05 | Logic 改 Fade/Gap 或曲目边界 | 重新建立 RenderTimeline、用户确认及 Conformance Report，不只比较文件总时长 |
| D-06 | 曲序/曲目/分面不变，时序变化且仍适配 | 明确 ACCEPTED_VARIANCE，保留计划时间线，实际执行引用确认后的 RenderTimeline |
| D-07 | 分面改变、容量不适配、结构性 Lead-in/Tail 改变 | REQUIRES_NEW_LAYOUT，旧 PREP 不能直接投入新 Plan |
| D-08 | Marker 候选或未确认导出 | 不自动变为档案事实；未达导入条件则阻断 Freeze |
| D-09 | Prepared 与 Execution Format 不同 | 保留原 Render，创建带转换谱系的独立 Execution Derivative |
| D-10 | Plan 引用不匹配的 M/L/P/R/Execution Hash | Preflight 拒绝，不自行修正或替换 |
| D-11 | 更新默认 Profile、Artwork 或 J-Card 模板 | 已完成 Recording Snapshot 与 Printed Artifact 不变 |

MATCHED 的帧容差、标记规则和时基在测试计划中先明确；不能以“微小变化”代替可验收条件。Audio Fingerprint 可以提出候选，但用户确认仍与自动证据分列。

退出证据：正反版本兼容矩阵、冻结对象不可变性、Conformance 结果、源到 Render/Derivative 的谱系及历史重播/J-Card 快照一致性。

## 8. Gate E — Archive Recovery

**当前状态：NOT_RUN。** 目标：证明文件系统与数据库之间的操作可恢复且幂等。

稳定 `operation_id` 驱动：`INTENT_WRITTEN → STAGED → VERIFIED → PROMOTED → DB_COMMITTED → FINALIZED`。操作清单记录对象、预期 Hash、源/目标、关联版本和恢复动作。只有合规正式对象才能被冻结 Plan 引用。

| 编号 | 故障注入点/操作 | 必须观察的结果 |
|---|---|---|
| E-01 | 复制开始前空间不足 | 不产生正式对象，源文件不变 |
| E-02 | 复制中空间耗尽 | staging 可恢复或清理，没有可引用的半成品 |
| E-03 | 复制中强制结束进程 | 重启恢复未完成操作，不伪造 Frozen PREP |
| E-04 | Hash/同步完成后崩溃 | 可验证后继续 Promote 或清理，不重复创建对象 |
| E-05 | Promote 后、DB Commit 前崩溃 | 读取 Operation Manifest，验证正式 Hash，幂等补交或 Quarantine |
| E-06 | DB Commit 后、Finalize 前崩溃 | 验证对象后完成清理，不重复关联或计数 |
| E-07 | 同一恢复执行 1/2/10 次 | 最终对象、引用和库存相同，无重复 Content Object |
| E-08 | Archive Root 中途离线 | 明确失败/待恢复，原始源不受影响 |
| E-09 | 正式文件 Hash 不符 | Quarantine，阻止 Freeze/执行，不覆盖既有正常共享对象 |
| E-10 | 完全相同内容重复导入 | 内容去重、引用正确，业务对象身份不混淆 |
| E-11 | 数据库有引用但文件缺失 | ArchiveRecoveryRequired；相关 Formal/Replica 阻断 |
| E-12 | 一致性备份后恢复 | Master/PREP/Recording/Inventory 关系完整，已声明包含的内容文件可用 |
| E-13 | 同一备份恢复两次 | 不重复、不丢关系、不覆盖恢复后更新的用户数据，冲突显式处理 |
| E-14 | 从 Manifest 重建基本索引 | 不伪造已完成状态；无法恢复字段明确标记缺失 |
| E-15 | 源文件和既有归档对象前后比对 | 故障注入不修改源或无关对象；清理受 operation 所有权约束 |

文件同步、目录发布和 DB 提交各自留证；不能仅用一次 rename 成功推断端到端事务。恢复路径要验证 Hash 和对象归属，不根据文件名信任内容。

备份使用 SQLite Backup API 或已验证的一致性静止快照；不得随意拆开复制活动主数据库与 WAL。另有 Manifest、Content Store 引用及内容字节的一致性检查。仅元数据备份必须明确标注依赖外部音频对象，不能通过“完整档案恢复”验收。

退出证据：每个故障窗口的重启前后证据、重复恢复结果、源数据保护、备份范围及恢复校验。磁盘满和终止测试只在隔离环境，不针对用户真实音乐、收藏或归档。

## 9. V2 Regression 与产品验收范围

每个实现 Slice 必须检查 Home、Search、Roon/Local Library、Playlists、Favorites、Now Playing、设备/队列、Lyrics、NetEase、Settings。现有侧栏新增“收藏”和“录音”两个独立入口，不增加第二套永久侧栏；进入任一页面不自动接管播放或换 Zone。删除 V3 概览页、设备页与旧五区域导航；V2 播放设备选择保留。

| v0.2 MVP 编号 | 保留范围 | 主要技术前置 |
|---|---|---|
| 1～3 | 收藏/录音双入口、V2 无回归、两个收藏视图与独立录音页 | V2 Regression + 导航隔离 |
| 4～7 | Master、Source Lock、Gap、A/B Layout | A、D、B |
| 8～10 | Logic Preparation、导入、PREP Freeze | A、D、E |
| 11～13 | 表格导入、Cassette/DAT 库存、永久 ID | C、E |
| 14～16 | 介质推荐、Profile、Formal Recording | A、B、C、D、E |
| 17～19 | Archive、Digital Replica、J-Card | D、E、真实录音确认 |
| 20～22 | CD、原版磁带、Roon 发行版关系 | A 的关系证据、C/D 的身份边界 |
| 23～30 | 参考目录、年代墙、型号完成度、Want List | C、CatalogRevision |

收藏墙仍是 V3.0 核心，不因技术拆分被降级为装饰或取消。30 项是最终产品验收范围，不因某个 Spike 通过而整体完成。

### 9.1 用户补充的双库与录音体验验收

来源：2026-08-27 对话补充及随后认可的 Preview 02，已合入 PRD。产品主线为实体音乐库、实物照片空白磁带收藏库和从 Roon 选曲后按库存推荐的录音流程。导航以最新两个入口决定替代旧五区域，30 项 MVP 与 A～E 技术要求继续保留。

**以下 U-01～U-10 均为 NOT_RUN；视觉与真实设备验证仍须独立执行。**

| 编号 | 输入/操作 | 必须观察的结果 | 对应验收 |
|---|---|---|---|
| U-01 | 录入原版 CD 与原版磁带，并确认 Roon 关系 | 同一实体音乐库可浏览和筛选；Exact/Probable/Related 有区别，未匹配不当作不存在 | MVP 20～22、Gate A |
| U-02 | 打开含实物照片、参考图、缺图、长名称的收藏库 | 照片是主体，型号/版次/数量可读；图片来源清楚，图框稳定、不误裁；可用键盘进入详情 | MVP 24、视觉及 Owner |
| U-03 | 合成型号拥有 7 盘：未开封空白 5、已拆空白 1、已录音 1 | 型号只占一个收藏卡位；详情数量为 7，按时长可展开，未知数量不算空白；不为了展示批量实例化 | MVP 12、25～27、Gate C |
| U-04 | 从型号详情打开已录音副本 | 显示实体编号、标题、J-Card/封面及 A/B 曲目；未知旧录音显示待补录；跳到实体音乐库仍是同一副本 | MVP 17、19、Gate D/E |
| U-05 | U-03 的已拆空白完成录音后重复发送完成通知或重启恢复 | 总数仍为 7：未开封空白 5、已拆空白 0、已录音 2；实体音乐库自动出现一次自录条目，型号下内容一致 | MVP 12、17、Gate C/E |
| U-06 | 新增跨多张 Roon 专辑的自录精选 | 可追溯每首录音源；类型为自录，不自动生成商业 Exact 关系或增加原版拥有数量 | MVP 22、Gate A/D |
| U-07 | 开始录音并从 Roon 选曲，尚未完成源验证或 Logic | 可先看标为初步估算的库存推荐及理由；不自动接管播放、预留介质或允许正式开录 | MVP 4、14、V2 Regression |
| U-08 | 候选含已拆空白、封存收藏、已录音、预留、未知和不适配时长 | 只推荐已拥有且合规可用库存；约束内优先已拆空白；逐面检查容量；无候选时明确原因、不自动擦除 | MVP 12、14、Gate C |
| U-09 | 选定磁带后改变曲序/间隔，或导入更长的 Logic Render | 重新计算布局、推荐与容量；不自动换磁带，不用旧适配结论进入正式录音 | MVP 7、9、14、Gate B/D |
| U-10 | 录音中断、旧录音人工补录或 Roon 暂时离线 | 不伪造 Completed、不把可能写入的磁带自动退为空白；旧录音保留补录标记；实体记录和历史不因数字链接离线被删除 | MVP 12、17、22、Gate B/C/E |

U-03/U-05 的数字仅为合成验收样例。两个库是同一实物的不同视图；原版发行关系、自录谱系、收藏型号归属分别保留。技术验证不能替代照片墙的实际视觉评审或 Owner 对美观程度的确认。

## 10. 证据记录模板与停止点

每个 Gate 报告至少包含：任务/分支/基线 SHA、候选与实现 SHA、允许文件、实际测试入口、用例数与退出码、逐项结果、故障环境、日志/测量产物摘要、真实与合成证据区别、carryover、Owner 确认、下一阶段基线。

记录私密源位置、真实目录根或设备内部引用时使用本地受控证据；公开报告只存匿名样本 ID、必要技术参数及有界摘要。歌词正文、账号、凭据、Roon Session、真实媒体路径不进入公开报告或 CI。

- 存在未验证源、版本错配、未恢复归档或未验收输出后端：阻断正式录音。
- 任一必测 Gate 未通过：不得把完整录音能力标为可交付。
- 同一问题三次修复仍失败：停止并审视架构，不自动继续第四次。
- 文档整理完成：只更新文档检查结果，不更新 Gate PASS、Owner 接受或生产能力。

## 11. 官方参考

- [Roon Transport API](https://roonlabs.github.io/node-roon-api/other_node-roon-api-transport_lib.js.html)
- [SQLite Atomic Commit](https://www.sqlite.org/atomiccommit.html)
- [SQLite WAL](https://www.sqlite.org/wal.html)
- [SQLite Backup API](https://www.sqlite.org/backup.html)
