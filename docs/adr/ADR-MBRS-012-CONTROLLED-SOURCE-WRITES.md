# ADR-MBRS-012：受控源文件写回的有限例外

日期：2026-10-08。状态：有限本地writer与自有生产App证据已通过，见MBRS-012/LOCAL_VALIDATION.json；精确源码Gate与自然CI封存另记。此ADR不授予任何具体文件权限。它细化ADR-MBRS-002，保留普通扫描、播放、默认选图、旧SourceEvidence/录音模块只读及历史Frozen/Prepared/Archive合同。

012从014最终报告09370f19d4422be3b387047999a0722961c52e1e接续。Owner已持续授权开发、验证及普通提交推送，不逐步审批；产品实际写回仍由现有具体计划最终按钮触发，不增加第二次代理批准窗口。Node为唯一SQLite作者、schema34、可选Rust只读OFF，library_write_enabled默认OFF，旧011 SOURCE_FILES保持OFF。原18任务/156AT不改，本期015取消后的有效17任务/150AT不改。

## 权限与受理

新localSourceWrites拥有独立preview/get/history/confirm/undo/cancel及metadata-only setPolicy。ON仅允许申请具体grant，不能授权任意文件；OFF阻止新工作，已进入原件保全阶段的操作安全收口后取消未执行项。Renderer只能提交安全ID/标签与最终计划Hash/修订，不持有路径、FD、approval、permissionRef或grant。可信Main捕获实际窗口、origin与最终DTO一次，经独立私有MessagePort请求Owner READY challenge和内部单次grant；普通Core execute、通用Outbox submit/retry均不能生成或借用它。

Owner保留原6键body/9键operation与body planHash规范；dataset、selection/range、全部资源与操作集合、policyRevision、期限、私有Owner UUID nonce独立绑定服务端context。policyRevision为持久正u64十进制TEXT。Schema正确、客户端approval、Main自称可信或此ADR都不能直接授权写入。原普通Core两秒预算不变；昂贵Hash与写回持久受理后异步get，accepted/ACK不表示目标文件写成。UNKNOWN只查询原command，服务端canRetry=false，不重发、不重签；NOT_FOUND也不授予重写许可，撤销和恢复须生成新READY计划。

## 有限格式和资源

allowlist仅Native FLAC固定标签区和严格MPEG1 LayerIII、ID3v2.4.0 flags0、非free bitrate固定标签区；具体资格仍须真实自有样本证明。每计划仅TAGS、EMBEDDED_COVER、DIRECTORY_COVER之一。title/artist/album/year/disc/track按显式set/remove、未选保持；年四位，disc/track为0..100000规范值，不能丢弃选中n/total或完整日期。未知、多值、顺序、编码及非目标原span按字节保持。仅唯一type3前封面PNG/JPEG原件可替换，其他图保持；目录封面独立列出共享影响。前标签区总长/audioStart不变，padding不足即拒绝，不转码。

新写入单源最多256MiB、标签区8MiB、4096个metadata block/frame，plan原始payload I/O最多2GiB。原metadata reader的单文本4096UTF8字节、合计64KiB文本、4MiB图片及原读取/时间预算不变；write资格拒绝不收紧普通播放FLAC allowlist。共享音频/片段、属性或链接关系不能证明的对象拒绝写回。旧活动/暂停/预取/录音、Frozen/Prepared/Archive读者与文件别名均纳入原同SAB物理资源协调器，不强停声音。

## 发布、备份和恢复

首版使用明确非原子的NONATOMIC_QUARANTINE_LINK_V1：实际原FD、stage FD和全部source/parent/target write claims按稳定顺序持有；journal记录意图；同卷库外独占quarantine捕获实际目标；验证dev/ino、birth、完整Hash及原FD；link(stage,target)无覆盖安装；移除自身stage别名后独立回读；同Node事务登记原AssetID、新revision、raw/signature/physical和scan事实。目标可能短暂缺席，应用新读以统一BUSY阻止。没有对任意外部进程的CAS或全局SQLite/文件原子性保证。

移动目标前必须证明同卷私有区、硬链接、权限与fsync能力，独立备份可读且Hash匹配，并预留恢复空间。全局新安全原件仓库2GiB合并计量独立backup副本、quarantined original和uncertain stage；最坏预留3×source+原图+元数据与终态journal容量，不能只算backup。原图另有独立64MiB/128张仓库，不扩旧Artwork JSON额度。

移动后DB回滚、未知COMMIT、未证quiet/释放或其他半写保留原件、备份、stage和保护，公开RECOVERY_REQUIRED，不隐瞒半写。冷启动只读对账，不自动重放、交换或覆盖；未确认备份不自动删。撤销前核外部后续变化，冲突停止。旧URL不能返回新revision字节，下一扫描不得重复加revision；历史Hash绑定保持旧精确内容。

## 存储和二进制边界

计划100操作，完整body+context+公开projection最多2MiB；header/item每行全部TEXT64KiB，phase每行全部TEXT16KiB；每operation32事件、每plan4096事件。操作前按最坏编码实算预留每operation4个终态/恢复事件和每plan16个事件；新journal投影总64MiB。容量不足拒绝新工作，不在变更后丢弃回执、不删历史腾空间。旧Outbox2MiB和011的32修订/12M ledger/16GiB保持。

图片原件在Main→Core ElectronMessagePort、Core→唯一Owner worker两个克隆边界只能为单个自有连续Uint8Array/ArrayBuffer，最多4MiB；offset0、backing等长，无Shared/resizable/超大底层view；metadata封套16KiBUTF8，不用base64/数字数组/枚举百万key。Owner重算Hash/MIME/长度/候选和修订。READY、执行及恢复pin在冷启动恢复，不能按TTL/LRU/ACK删除。缺原件沿已有选取/检索/拖入路径重新选择，不能拿显示JPEG冒充原件；原图留存失败不破坏MB-only保存。

## 证据门禁

本ADR和范围文件只证明规则已确定。Root执行真实自有非静音FLAC/MP3与PNG/JPEG正例，独立ffprobe、PCM和非目标span比较，权限/计划Hash/scope/op全集负例，统一claims并发、各发布及DB阶段故障、备份/撤销外部冲突、原ID与revision/旧URL、持久受理与冷启动无重放。测试、构建、生产App、真实账号/Roon/NAS/设备/音频和Owner最终试用分别记录，原九条AT不因设计完整自动通过。具体常量见MBRS-012/EXECUTION_SCOPE.json和RULE_MATRIX.json。

## 精确撤销来源与属性观察补充

新域 item.restoration 仅表示具体逆向计划，绑定 originPlanId/originOperationId；restore-audio-file 与 restore-directory-cover 的输出完整 SHA 来自已读回验证的独立备份，remove-new-directory-cover 绑定已验证的原始不存在事实且输出 SHA 为 null。逆向封面不借当前 candidate 的 SHA/MIME/尺寸冒称旧原件，item.artwork 为 null，具体来源以恢复投影与私有 backupHash/原操作/当前 afterHash 为准。原冻结 WRITE_COVER 操作仍九键，field_patch.artwork_selection_id 为 null；body 仍六键。Tags 逆向精确保留原 artist 的最多32个值和原 span，直接新 set 仍单值。公开 Schema 只能表达预览，服务端仍独立核真实备份、完整操作集合及权限，不能由 restoration 字段授权。具体恢复预览后的最终按钮沿已有流程，不加代理批准。

目标属性采用真实有限观察：macOS 的旧 EMPTY 分支仍要求空 xattr/ACL/flags；新增 PROVENANCE_ONLY 分支只接受唯一系统 com.apple.provenance 的真实11字节opaque值并绑定实际SHA，不解释、不写入或清除系统属性、不硬编码本机Hash，Linux 用固定系统只读工具核真实 FD、空 xattrs（包含 ACL/capabilities）及仅无语义影响的已知 flags；未证工具/文件系统能力即拒写。mode/uid/gid 与原 FD、当前命名 root/祖先/父目录、捕获 quarantine 和最终目标逐段绑定。Source history 后续页维持首轮快照，实际 cursor payload 计入16MiB/128上限，单次捕获仍受2MiB预算。

Contracts 首段锁03已真实 build/typecheck 与32行为用例通过；该证据不覆盖本次 restoration 后继变更，也不提升 writer 资格。格式首段7/7及独立6/6仍绑定各自文件 SHA，JPEG/完整发布服务/备份/撤销另取新鲜证据。

## OFF 排空与未知结果恢复的必要接点

策略排空与旧未知计划的保护分别核对。OFF 后必须等待实际后台 I/O 全部 join，活动 I/O 未结束时拒绝 ON。I/O 已结束后，允许按原 policyRevision CAS/u64 生成新的 ON；DTO 的 draining=false 表示已开启策略且旧 I/O 已排空，不表示旧 claims 已 quiet。原未知计划仍公开 RECOVERY_REQUIRED，原件、备份、stage 与真实保护继续保留。

有未解决的实际发布恢复时，普通新 preview/confirm/undo 均拒绝；只允许服务端核验原计划的具体 recoveryChoices，再生成新的恢复 READY，经现有最终按钮申请新私有 grant。恢复门禁从持久 journal 及实际材料判断，覆盖冷启动，不能只依赖内存 uncertain。未进入发布的冷 PREVIEWING/READY 先只读分类，不冒称已有文件恢复材料。实际恢复后的持久解决事实须精确绑定原操作；旧计划中其他未知操作仍保留门禁。get/history/cancel 与只读核对保持可达，不自动写、重放或重新授予旧命令。

移交旧保护前，必须核真实 retained claims、FD、namespace、完整 Hash 与实际 quiet/release；不以 DTO、字符串或重新构造对象冒充持有证明。本补充是实施决定，完整生命周期仍须新鲜行为证据。

## 012 私有保护内容快照

014 普通 snapshot 的协议与连接计数语义保持。012 新增私有 sourceWritesSnapshot，复用同一事务内的全部24张原保护表、预算、历史完整性和物理引用核验；采用独立域及 schema 身份计算实际保护内容 Hash，不纳入仅连接级的 total_changes/data_version。012 自己的 receipt/item/phase 写入不得使其 READY 自失效，真实保护表变化或损坏仍须失效或 UNKNOWN。同 SAB claims、真实 FD/root/祖先绑定及执行前后重核继续执行；不新增公开 ignoreBusy 或减少表全集。该接点的原回归与新行为证据另取，不提升当前 writer 资格。

## 冷 UNKNOWN 命名保护与完整恢复选择

012 的重启保护必须在唯一 Owner 认证私有 journal 后、prepare 返回和 ACK 之前安装，不能由第一次 get/confirm 或 runtime ready 后懒加载。普通播放、实际 Metadata Reader 与旧录音内容读取共用原 SAB 的命名位置读保护及真实 FD inode 读保护；命名 key 独立于原物理 key，绑定服务器认证的 canonical absolute named path 与实际卷身份，目标暂缺也不能绕过。Root 与真实 parent 卷锚点处理嵌套授权根，真实 old/after/current/quarantine FD 隔离保留跨路径 hardlink 保护。Namespace token 不授予文件写资格，也不能据持久 JSON 或 SAB 负槽复活旧能力；普通 Reader 无 ignoreBusy。源写 OFF、writer 未资格或同根其它文件 UNKNOWN 都不构成全库拒播开关。原 2048 合计槽、128 单批与旧 200 曲上限保持。

真实 writer 在任何 CAPTURE_INTENT/移动前持对应命名独占，直到文件 I/O/FD 确实 quiet 且 QUIET 已持久后才释放；UNKNOWN/释放不明继续保持。显式恢复由新的具体 READY/私有 grant 使用原品牌化 token 的精准命名委托，同时采用真实 retained physical claims 的完整组移交：核实际旧 FD，先取得仅新增资源的 guards，新品牌继承旧 guards 与全部真实 FD，旧品牌失去操作权，旧物理 key 始终保持独占。命名和物理保护均不得 release-await-reacquire；仅封 canonical 路径不能证明另名 hardlink 保护。Token 绑定 origin 的认证 READY context/plan 身份、捕获时真实 journal sequence/投影及精确操作集合；后续状态写入不重签。多代恢复只沿认证父链委托，解决某个后代不能清除仍未解决的祖先或同名义务。

本期运行恢复只接受服务器 choice 中该 origin 的完整实际 unresolved 集合。执行器在移交原 physical 整组前再次独立核 inverse origin-op 集合精确相等；客户端不能覆写 operationIds。部分作业失败不写 resolved、不释放原命名保护。Journal 按真实逐 op union 投影，重复/非未解决项拒绝，部分 resolved 不能清全 plan。若未来支持任意部分运行恢复，需额外完成真实 physical split/delegate，不能以本期完整组 transfer 推定已支持。根/path、FD、容量或 lineage 不完整时不报 ready；没有冷 barrier、真实新 lease/worker/录音对照及恢复后再读证据，不宣称该修复通过。

多代 UNKNOWN 使用唯一根原计划的恢复原件选择。原始计划 R 的认证 family 尚有未解义务时，新的恢复 B 仍由 R 当前完整 unresolved choice 创建，B 的 recoveryOf 与全部 inverse.originPlanId 均为 R，恢复材料始终为 R 已验证的原备份或原缺失；未知后代 A 不提供恢复 A 自身备份的选择。当前 Asset、revision、物理观察和可接受文件 Hash 来自同 dataset、同根操作严格映射的认证恢复链最新实际事实，外部后续修改仍拒绝。

B 的真实 COMPLETED/applied、QUIET 与恢复后 full SHA/原缺失核实后，在同一 Owner 持久事务中分别记录 R 及被精确覆盖的未解后代 operationIds 的 recovery-resolved。重放守卫认证同根 READY、inverse 原操作/目标/材料映射并拒绝重复、已解、跨根或未实际恢复项，不以一个后代完成推定全链解决。QUIET 精确记录实际 I/O join 与 FD close，不提前声称 guards 已释放；普通写在 QUIET 持久确认后释放 guards，恢复在全部对应 resolved 持久确认后释放移交组，最后分别解除 B、A 与 R 的命名义务。命名位上还有任何未解引用便继续持锁，ACK、close 或 release 未明不得释放未解保护。

最终 release 再次 UNKNOWN 时，根 choice 仍须覆盖认证后代的未解操作映射并绑定最新 family 投影；已解决的根操作不重复追加 resolved，只闭合新未解后代。不能因 R 较早已解决并保留 FAILED 历史状态就失去恢复入口。已真关闭的登记 FD 只能核 handle 关闭状态及原号码 EBADF，不能伪造活 FD；部分 guard 释放不满足 full transfer 时 fail closed，要求完整 Core 与 fresh SAB 生命周期重建，不能收养负槽。物理委托可以从最新真实 retained 后代取得，但公开恢复身份与最初备份不变。这是必要恢复实施决定，尚须 Root 新鲜行为与真实文件证据。

## 真实保护闭合与终结状态

私有 journal 新增有限 protection-closed 事件，仅包含经认证的精确 operationIds；它必须在真实 I/O/FD quiet、整组物理 guards 原子释放、对应命名义务解除后记录，不由 COMPLETED、resolved、返回值或合成标记代替。普通写先 QUIET 持久、实际释放、闭合，再 COMPLETED；恢复先实际输出核实及 COMPLETED/逐计划 resolved 同事务持久，再释放整组及各命名义务，最后闭合。物理组释放先在原协调器同一事务中核完整真实 write guards 集合再全部清除；任一验证或 Busy 失败不得先释放其中一部分。

冷启动中实际捕获/发布过却缺少闭合的 COMPLETED 后代仍按未解保护映射回唯一原根，保留真实材料与恢复入口。闭合持久 ACK 不明但 token 已实际释放时，不得再 retain 或声称原 guards 仍持有；保留材料与精确未知边界，必要时通过完整 Core 与 fresh SAB 的认证冷重建恢复保护。

原 4/op、16/plan 终结预留、64MiB journal 与全部既定预算保持。终结预留按允许的整行全部 TEXT 最坏 64KiB 保守计量，不将 phase 的 16KiB 上限扩大为 64KiB。存在真实 publisher/保护且尚未闭合的 COMPLETED 保留终结额度；从未 CAPTURE 或进行真实 I/O 的旧合成 history COMPLETED 不推定为活动发布。get 将同一活动恢复的暂时持久 COMPLETED 映射为 RUNNING，实际闭合后才展示终结；冷缺闭合展示 RECOVERY_REQUIRED。history 只在首次快照捕获应用同一内部状态映射，后续页保留已捕获值、真实 SQL 游标及原公共 limit 100、128 个游标、16MiB 合计缓存、2MiB 单快照与 600000ms TTL，公共 DTO 不扩展。本节是实施决定，须由新鲜故障窗口及正常闭合测试证明。

## 有限系统属性的实际保全

所有其它xattr、ACL、flags、工具缺失/超时/未知输出和FD/命名身份变化仍拒写。独立backup固定0600与本机owner，分别核其真实proof与原件proof；phase BACKUP.backupAttributes 和 facts backup.attributes 绑定同项路径与真实属性，新逆向 inverse.restoreAttributes 绑定唯一原R对应原件mode/uid/gid/proof并计入新READY/context。旧私有四/七/五键事件仍可读，缺证明不能默认补当前属性升级执行；公开DTO、原Frozen六/九键及全部预算不变。

移动前真实回读原件、backup、stage全属性与内容；移动后quarantine对原捕获、final对真实stage，属性变异按实际路径是否已移动保留not-performed或UNKNOWN边界。已有cover当前pathgap不等于原属性为null，恢复保持R原权限和proof；首次新增cover在当次创建时真实核stage/final与哨兵proof一致，后继current由这一持久证据及明确创建权限核对，哨兵不被解释为原不存在cover的属性。

有限基础Source服务7/7与独立音频/span/PCM、备份/权限属性各2/2已有真实证据，见SOURCE_SERVICE_PHASE_VALIDATION.json；这些正例原mode为0600，不替代封面非默认权限、冷Owner或多代故障/App/Owner验收。

## 已发布私有暂存链接的恢复收尾

中断后，目标与私有stage可能仍是同一inode的两条链接。只有明确恢复原计划的预览才可消费同dataset、唯一根R family及精确原operation的认证STAGED/PUBLISH_INTENT，二者after SHA必须一致且非空，先核真实独立原备份。持有真实retained physical claims及namespace之后，持续核源祖先与私有700目录FD、确名target/stage同inode与birth、恰好nlink2、完整内容Hash，再只去除该私有stage别名并sync；随后核同inode/nlink1及完整Hash，继续原单链接属性、独立格式回读与lineage守卫。冷启动准备自身不执行该清理。它收尾的是旧已授权发布的私有残留，不能成为新的源内容修改grant；最终恢复源内容仍须新READY的具体确认。额外链接、私有stage替换、内容变化或任何未核close均拒绝并保留保护。Node路径unlink沿原可观测外部修改边界处理，不宣称expected-inode原子CAS。

恢复完成的原R及被精确解决的旧后代保留FAILED历史状态及applied/unknown item、原受理回执和阶段事实；独立恢复计划记录COMPLETED。不得为满足CANCELLED合同抹去曾经发布或未知的历史。资源与命名义务真实解除及protection-closed确认之前仍沿原未解family联合判断。

同一2048槽/128单批/原四word共享表中，物理与命名使用独立计数域，原物理digest、read1..65535/write-1及旧snapshot三字段含义保持。新命名read65536+n/write-2，域碰撞或非法计数只保守拒绝；新combinedSnapshot核两域合计，协调器替换必须消费该完整占用。命名释放核同作者真实品牌和全部域计数后才批次收口，不由负槽值重新认领能力。源保护检查与新Source测试均明确核两域，没有增加第二张锁表或总容量。
