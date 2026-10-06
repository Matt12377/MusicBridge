# MBRS-004 CoverDrop 规则适配表

本轮从003最终报告7570d519接续。实际来源为Matt12377/CoverDrop的93fa28f3提交；执行包CoverMate名称是历史定位线索。9个来源文件的Git blob、字节数及SHA256见[精确来源](upstream-lock.json)。读取Git提交对象，CoverDrop的40处已修改文件及111个未跟踪状态条目保持原样；不是读取这些WIP后的结果。

许可保持UNKNOWN：该提交树未见LICENSE/COPYING/NOTICE，README未见许可声明。本轮独立实现TypeScript纯规则行为，适配合成输入与期望；不宣称MIT或已经取得分发许可。

| 来源 | 本轮处理 | 输出位置 |
| --- | --- | --- |
| AlbumNameCleaning.swift | 歌手、专辑清洗与候选规范化行为 | bridge-core/src/library/local-name-rules.ts |
| AlbumDisplayNameCleaning.swift | 纯成员事实、展示与可信候选 | 同上；输入输出合同在contracts/src/local-name-rules.ts |
| FileSystemLibraryScanner.swift的目录角色、结构、CD/格式/版本判定 | 传入已捕获目录/曲目/读取事实；不读取文件系统 | 同上；目录事实测试 |
| CoverSearchKeyword.make | 纯歌手与专辑搜索词 | 同上；keyword golden |
| AlbumNameCleaningTests | 32个清洗、19个语义保留、9个艺人输入；32+9个幂等断言 | core/test/mbrs004/upstream-golden.test.ts |
| AlbumDisplayNameCleaningTests | 7组，包括5000重复标签小于0.5秒 | 同上 |
| AlbumNameEnhancementTests 122–164 | 4组共享规则；未实现AI JSON/截断建议解析 | 同上 |
| FileSystemLibraryScannerTests 1–343、491–535 | 20组目录事实；读取失败、新增重算、无专辑拒绝及扩展名目录排除按事实适配 | 同上 |
| AppConfigurationTests的coverSearchKeyword | 1组keyword | 同上 |

92个适用输入/组保留来源与区间，完整语料在core/test/mbrs004/golden-facts.json。它是输入与期望的适配记录；实际通过数量须读本届TAP及Gate，不能用此表当测试结果。包内8个示例不替代这些golden。

有意差异：

- 可信度按候选支持成员数/完整专辑成员数计算；另给支持成员数/有效标签数的一致性。缺失、失败和占位计入覆盖缺口，1/20不会高可信。
- 先保留原文、字段来源和首版/重制/格式等版本token，再清洗展示名；canonicalKey只给候选，歌曲和版本ID由现有输入保存，不生成或自动合并。
- 人工覆盖用显式字段表达，包含与原文同文本的手工锁定；不通过文本是否相等推断人工选择。
- Swift的Foundation繁简转换在JavaScript中无同等标准接口；本轮使用58对有限单字符表，`體驗 [首版]`展示为`體驗`且保留raw，不宣称通用ICU/Swift等价。NFKC将`ＡＣ／ＤＣ`折叠为`AC/DC`候选；兼容折叠范围强于仅宽度处理，两个稳定曲目ID及各自原文保持。相关差异有新行为测试。
- 上游raw子串佐证改为清洗后canonical严格等价，避免`a`、`WAV`误替目录名。coverage/consistency达到阈值的候选仍须结合needsConfirmation解读：无目录佐证必须确认，不自动替展示；占位与纯格式不算有效标签，但计入完整专辑覆盖缺口。
- `1989 [Live]`、`1989 [Remix]`及现场/混音语义保留；支持的技术语法保留raw token，包含正反向规格、紧贴bit/kHz、全角、首批和银圈。token的start/end使用原文UTF-16索引；rawNames/rawVersionTokens保存输入目录名，memberEvidence保存各稳定曲目原始标签，source标记字段，人工选择另外保留manual对象。
- 目录结构只上归一层，与全部20组适用golden一致；深层CD/WAV嵌套不扩推断。siblings与歌手事实预建索引，交错多歌手的CD/发行版/散曲不会相互影响。

不移植AppModel、UI、数据库、网络、递归扫描、文件打开/符号链接判断、元数据读取、并发扫描或日志。现有LocalCatalogOwner/Store、持久扫描与唯一writer只在合成集成测试中复用，产品代码不改。可选AI服务和解析器没有加入运行依赖；实际直送播放保留005/006及最终验收边界。

最终软件清单为92个适用输入/组、13项新增规则行为及1项现有coordinator/唯一writer合成集成，共106项；自动Gate另执行两包新编译、两包类型检查。集成的第三轮主动修改自有合成CD1副本，以确实读入新的raw观察，再核对手工名称、稳定曲目、发行版和关联ID；它不是未变文件跳过路径，也不声称真实Reader解析或原件从未改变。aiMode的optional只表达输入模式，本轮没有实现AI请求、建议JSON解析器或联网依赖。

两轮审查后主控处理剩余同根因：格式token的语法与显示噪声范围不一致，以及格式目录只检查词头。新增负例先确认2项行为失败，再共用显示噪声判定保留方括号/后缀原文；格式目录只接受完整格式名或明确技术数字/bit/rate后缀。`Waves`、`Aperitif`、`FlacDream`保持普通目录，原20组目录golden继续适用。这是对上游宽泛hasPrefix的有意收紧；此前105项Gate和被停止的完整检查保留为修订前历史，不替最后106项结果。
