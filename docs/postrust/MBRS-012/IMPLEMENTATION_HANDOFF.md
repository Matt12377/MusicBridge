# MBRS-012 实施交接与有限规则

014源码与报告自然CI、远端和clean已在最终报告09370f19d4422be3b387047999a0722961c52e1e封存；012独立分支已由该HEAD创建。本文冻结实施边界，不是writer资格、测试或产品验收通过证据。

原任务3788字节，SHA256 c77b9d1516a85a50e677c20e028f449ab072fc424032d4cb58e804aac2b427b6；9条原AT、kind和introduced_in保持。硬依赖010/011/014/005按有限软件及逐项真实carryover分层，沿RUST-016已有G0和Owner持续开发/普通提交推送授权，不增加代理审批。默认Node、schema34、可选Rust OFF；旧SourceEvidence/录音读模块和011 SOURCE_FILES继续只读。

## 本轮实施决定

- 独立localSourceWrites域：preview/get/history/confirm/undo/cancel，metadata-only setPolicy；三Outbox动作setPolicy/confirm/undo。MB_ONLY继续复用旧011/010。新公开DTO仅安全ID/标签，不回传旧私有body/item的路径和物理身份。
- 真实Owner持久计划沿原6键body/9键operation规范，planHash只Hash原body；dataset/range/selection/资源/操作全集/policyRevision/期限和Owner nonce另用独立服务端context绑定。policyRevision为持久正u64十进制，Owner epoch继续私有UUID。
- 原普通Core命令2秒预算保持；预览、Hash和执行先持久受理，get查询READY/逐项状态。受理不是写成功。get闭集按context/plan/command选择，command须完整expectedCommand和原请求指纹。只有可信Main最终确认路线可取得Owner challenge并内部签发单次grant，Renderer没有approval/grant/path/FD字段，不再弹独立批准窗口。UNKNOWN服务端禁止重派或重签，get NOT_FOUND也不是重写许可；撤销/恢复生成新READY计划再确认。
- 原Outbox 2MiB、catalog每行全部TEXT 64KiB、旧011 32修订/12M ledger/16GiB保持。新计划100项、整个正文及context/公开投影2MiB；新typed header/item/phase拆行，每行全部TEXT继续64KiB。新独立journal投影64MiB，事件数与终结/恢复预留由Core实算后登记有限常量，不把100×64KiB当计划限额。
- 原图单张自有连续binary buffer最多4MiB、metadata/封套16KiB；两个结构化克隆边界均核长度与buffer所有权，Owner重算Hash及候选/修订。新原图存储独立64MiB/128张，READY/执行/恢复pin不按TTL/LRU删除。保持旧512MiB JSON guard及MB-only选图能力；不声明不存在的合计256MiB共享帽。缺原图复用现有选择/检索/拖入，不由缩小JPEG生成原图；原图留存失败仍允许MB选图。
- 首版publisher为明确非原子的NONATOMIC_QUARANTINE_LINK_V1：同SAB真实原FD、stage FD、原文件/父目录写claims；journal意图→同卷库外独占quarantine捕获实际目标→验证预期身份/完整Hash→link(stage,target)无覆盖安装→移除自身stage别名→独立最终回读→同Node事务登记。目标暂缺窗口用同一协调器BUSY收口；同卷私有区或该生命周期不能闭合的根不准入writer。原规格未要求原子交换；不声称任意外部进程CAS或全局SQLite/文件原子。发布后DB rollback/未知commit/未核quiet或释放保留所有原件、备份、stage及保护，冷启动只读对账，不自动交换/覆盖。
- source-protection新增私有inspectHeld须接受真实FD和真实性持有证明，不加IPC ignoreBusy，不修改旧sourceWriterReady:false/assertMutationAllowed():never。写claims分组保持单调用128/总2048和旧200曲。AudioAsset原ID保留，fileRevision/raw/signature/physical/scan事实同一Owner事务更新，下一扫描不重复增加修订，旧历史Hash不改。
- 本轮格式Native FLAC与严格ID3v2.4.0 MPEG1 LayerIII；前部标签总长度和audioStart不变，padding不足即拒写。6字段title/artist/album/year/disc/track显式set/remove/省略不变；年仅4位，disc/track规范0..100000，选中n/total拒绝丢失，独立总数保持。未选多值、未知frame/comment、顺序、编码和原始span字节保持。唯一type3 front PNG/JPEG可改，其他图片原字节；目录cover.jpg/png独立范围。每计划仅TAGS/EMBEDDED_COVER/DIRECTORY_COVER之一。writer拒绝边界不收紧旧正常FLAC播放/read allowlist。

## 预定文件所有权

Contracts角色：packages/contracts新source-writes域、exports/IPC/type guards/对应测试。Core角色：bridge-core新writer/parser/publisher/service/store/journal、私有原图store，窄claims/保护/catalog scan事实/Owner协议client worker dispatch utility及Core测试。UI角色：desktop Main/preload/CoreSupervisor/Outbox执行与显示、已有标签/选图入口/设置、新Source计划状态组件和Desktop/E2E测试；不直接写Core/Contracts所有者文件。Root：原任务精确副本、有限ADR/有效规则、scope/G0/状态/报告/Gate/CI，所有编译测试App执行、整合和正常Git交付。三个既存gpt-6.1-sol/max角色，无新增代理，跨界先交Root或文件作者。

## 验证与交付

不能以设计/Schema/旧报告/skip writer声称写回通过。Root生成真实自有FLAC/MP3和JPEG/PNG样本，原协议级防伪/Hash/scope/op集/权限负例、真实统一claims并发、每发布/DB阶段受控故障、备份可读Hash/undo外部冲突、原ID新revision及旧URL拒新字节、持久受理与冷启动无自动重放分别核验。独立音频和非目标原span比较；必要格式正例采用原metadata reader/独立工具，测试不镜像writer。最终类型/有界Gate/生产App和自然源码CI按实际风险与任务门禁执行，原9条产品AT逐层填写；真实Roon/NAS/设备/Owner结论不提升。012源码与独立报告两提交，下一013从报告最终HEAD续。

## 新发现的冻结接点

014 Gate严格冻结49个旧验证输入，仅preload.test.ts已认可六方法名单增量。012七个公开接口将再次影响PUBLIC_API_KEYS的显式预期；该测试与014 Gate的精确哈希准入扩展由Root独占。保持原全部case、assertion、loader/context计数和时限，只在原列表末尾添加七名，前后字节/Hash及新负例另留。UI/Contracts角色可各自新增真实实现/接口定义，禁止直接修改该旧测试或Gate。此跨任务接线已向Owner告知冲突，不要求重复代理授权。其余48份原测试继续字节原样；必要新测试放012独立目录。

## 本轮精确补充

新journal每operation最多32阶段事件、每plan最多4096事件，终结/恢复预留每operation四事件及每plan十六事件的最坏编码字节；phase每行全部TEXT最多16KiB，header/item每行64KiB，全部新journal/投影64MiB。拒绝新工作前预留终结空间，不能在磁盘已变更后丢失终结回执；没有删历史或调高旧限额的授权。主模型与三个既存子角色沿已核gpt-6.1-sol/max，不新增派生。Root独占全部执行、Git和共享冻结预期名单；各作者只改授权路径且跨界交文件作者。Core还需登记文件/总I/O/backup容量和实际fsync能力上限，保持原保护/read预算。共享音频/片段及文件属性无法完整证明的对象由writer保守拒绝，普通播放读取合同不变。目录封面共享影响必须完整列入服务端context和预览。

确认授权只经可信Main source-specific入口及私有Owner端口；通用execute/Outbox提交不能获得grant。Final确认不加独立批准弹窗。setPolicy ON仅允许具体grant申请，OFF阻止新工作，已进入保全阶段的操作先安全收口。未知Outbox不可重派，恢复/撤销产生新预览。

Owner只做最终成品试用及必须本人完成的设备接入。真实用户数据写入不会由开发授权自动触发；本轮所有执行使用自有合成样本。

## 写入I/O与原件保全预算定稿

新writer单源256MiB、标签区8MiB、metadata block/frame4096、单plan原始payload I/O2GiB；新全局安全原件仓库2GiB合计backup独立副本、quarantined original、uncertain stage，目标移动前预留最坏3×source+original image+metadata和终态journal。任何实际能力/容量不足在目标移动前拒绝，不能发布后才发现hardlink/fsync不支持，不把可变hardlink当独立backup。真实正例夹具由Root独占packages/bridge-core/test/fixtures/mbrs012-source/，原PCM/ffprobe/解码证据外置；使用这些夹具只证明自有合成行为，不能升级真实曲库或Owner结论。有限有效规则见ADR-MBRS-012-CONTROLLED-SOURCE-WRITES.md和RULE_MATRIX.json。

七个公共API确名：previewLocalSourceWrites/getLocalSourceWrites/listLocalSourceWritesHistory/confirmLocalSourceWrites/undoLocalSourceWrites/cancelLocalSourceWrites/setLocalSourceWritesPolicy。冻结旧preload bootstrap require map和context采集6次保持；新client从已有api或已加载模块接入，Source分域守卫与授权端口独立，Root仅扩PUBLIC_API_KEYS名称预期。

## 冷启动UNKNOWN回执可达性补充

旧Outbox公开视图不含原payload，新get(command)需要原请求指纹，因此仅三Source命令的CommandOutboxView增加可选sourceRequestFingerprint。Main从持久不可变public payload按共同localSourceWritesRequestCanonical计算；作用域为datasetId+exact command+已捕获原public payload，不含grant/challenge/Owner nonce或Outbox额外字段。Owner受理保存同一指纹，get以原commandId/expectedCommand/指纹只读对账。旧域实际对象不添键，不公开payload或旧内部指纹；NOT_FOUND仍不是重派/重签许可。该增量解决原合同的必要可达性，不增加第八API或新的代理批准。confirm/undo的accepted仅显示已受理，实际写成与恢复状态从get(plan/job)逐项观察；setPolicy保存与源写效果分层。

## 实际remove后的raw与扫描事实补充

原observe-metadata是非空局部patch，直接追加{}不能表示源标签已移除。新SOURCE_WRITES_V1 finalized事实保存独立实际回读fullRaw、签名及修订，形成raw重置锚点，随后原metadata observation按时间继续覆盖。旧事件正文、Hash、原guard和历史保留；详情与SQL搜索采用同一有效raw语义，不用空字符串伪无tag。fullRaw/新Asset revision/signature/physical/scan事实须同唯一Owner事务。仅更新真实已存在scan_file_state的signature/readFacts并保留其job_id/batch_id；没有真实scan row预检拒写，不能伪造ScanJob。后继真实scan需reuse相同已观察签名且不双增revision；每个删除字段的详情/搜索/冷启动与后续观察覆盖均需要行为证据。

## 精确撤销来源与属性观察补充

新域 item.restoration 仅表示具体逆向计划，绑定 originPlanId/originOperationId；restore-audio-file 与 restore-directory-cover 的输出完整 SHA 来自已读回验证的独立备份，remove-new-directory-cover 绑定已验证的原始不存在事实且输出 SHA 为 null。逆向封面不借当前 candidate 的 SHA/MIME/尺寸冒称旧原件，item.artwork 为 null，具体来源以恢复投影与私有 backupHash/原操作/当前 afterHash 为准。原冻结 WRITE_COVER 操作仍九键，field_patch.artwork_selection_id 为 null；body 仍六键。Tags 逆向精确保留原 artist 的最多32个值和原 span，直接新 set 仍单值。公开 Schema 只能表达预览，服务端仍独立核真实备份、完整操作集合及权限，不能由 restoration 字段授权。具体恢复预览后的最终按钮沿已有流程，不加代理批准。

目标属性采用真实有限观察：macOS 必须无 xattr/ACL/flags，Linux 用固定系统只读工具核真实 FD、空 xattrs（包含 ACL/capabilities）及仅无语义影响的已知 flags；未证工具/文件系统能力即拒写。mode/uid/gid 与原 FD、当前命名 root/祖先/父目录、捕获 quarantine 和最终目标逐段绑定。Source history 后续页维持首轮快照，实际 cursor payload 计入16MiB/128上限，单次捕获仍受2MiB预算。

Contracts 首段锁03已真实 build/typecheck 与32行为用例通过；该证据不覆盖本次 restoration 后继变更，也不提升 writer 资格。格式首段7/7及独立6/6仍绑定各自文件 SHA，JPEG/完整发布服务/备份/撤销另取新鲜证据。

## 排空、恢复与保护快照实施决定

OFF 后实际后台 I/O 全部 join 前拒绝 ON。已 join 后可按原 policyRevision CAS/u64 开启；旧未知计划仍 RECOVERY_REQUIRED，原件、备份、stage 与真实 claims 保留，ON/draining=false 不证明旧保护已 quiet。有未解决的实际发布恢复时拒绝普通新 preview/confirm/undo，仅允许服务端核具体 recoveryChoices 后创建恢复 READY、新私有 grant 和明确恢复。冷启动按持久 journal 与实际材料判断，未发生发布的冷预览先只读分类；恢复解决事实精确绑定原操作，不能因一个恢复完成而解锁其他未知操作。真实 retained claims、FD/namespace/Hash 和 quiet/release 核验后才能移交，get/history/cancel 保持可达，不自动重放或补 grant。完整生命周期由 Root 执行真实检查。

014 普通保护 snapshot、表全集、预算与冷核保持；012 私有 sourceWritesSnapshot 采用独立域/schema 与同事务全部24表实际内容 Hash，不含仅连接级 total_changes/data_version，避免自身 journal 写入使 READY 自失效。真实保护内容变化/损坏、同 SAB claims 与实际 FD/祖先冲突仍拒绝。作者添加静态接点与用例，Root 新鲜执行原回归及行为检查；本决定不等于资格已通过。

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

### Root属性LOCK07与基础真实服务收口

新增私有有限Mac PROVENANCE_ONLY合同、backup/phase proof、原R restoreAttributes均已实施；三产品静态限定审查与实际Core编译/cycles通过。基础真实服务7/7；Source02两个已通过正例的独立PCM/raw与真实属性/独立备份各2/2，见SOURCE_SERVICE_PHASE_VALIDATION.json。新字段已入完整context/联合预算；旧私有记录只读兼容但缺证明拒执行，不清系统属性，不借absence或备份600补原cover权限。接下来先执行已交锁的剩余实际Owner/故障/cover/容量测试、全types/旧回归与正式App，再冻结实测3组计数和正常源码/报告自然CI。不要把有限基础正例升为全writer资格；整个既有授权持续有效。

## 已发布私有暂存链接的恢复收尾

中断后，目标与私有stage可能仍是同一inode的两条链接。只有明确恢复原计划的预览才可消费同dataset、唯一根R family及精确原operation的认证STAGED/PUBLISH_INTENT，二者after SHA必须一致且非空，先核真实独立原备份。持有真实retained physical claims及namespace之后，持续核源祖先与私有700目录FD、确名target/stage同inode与birth、恰好nlink2、完整内容Hash，再只去除该私有stage别名并sync；随后核同inode/nlink1及完整Hash，继续原单链接属性、独立格式回读与lineage守卫。冷启动准备自身不执行该清理。它收尾的是旧已授权发布的私有残留，不能成为新的源内容修改grant；最终恢复源内容仍须新READY的具体确认。额外链接、私有stage替换、内容变化或任何未核close均拒绝并保留保护。Node路径unlink沿原可观测外部修改边界处理，不宣称expected-inode原子CAS。

恢复完成的原R及被精确解决的旧后代保留FAILED历史状态及applied/unknown item、原受理回执和阶段事实；独立恢复计划记录COMPLETED。不得为满足CANCELLED合同抹去曾经发布或未知的历史。资源与命名义务真实解除及protection-closed确认之前仍沿原未解family联合判断。

同一2048槽/128单批/原四word共享表中，物理与命名使用独立计数域，原物理digest、read1..65535/write-1及旧snapshot三字段含义保持。新命名read65536+n/write-2，域碰撞或非法计数只保守拒绝；新combinedSnapshot核两域合计，协调器替换必须消费该完整占用。命名释放核同作者真实品牌和全部域计数后才批次收口，不由负槽值重新认领能力。源保护检查与新Source测试均明确核两域，没有增加第二张锁表或总容量。

## 当前有限实现收口

本地426项声明分组零skip，真实Owner冷保护、多代故障恢复、封面与容量、Reader四上下文、同次新旧HTTP lease及undo冲突窗口已实际通过。生产App37与独立6音频/14安全材料/7恢复操作已通过；App37仍绑定build33，历史阶段各自锁不改。完整标准回归、Rust55、Electron57与全部E2E分层见LOCAL_VALIDATION.json。具体source写回继续默认OFF且逐最终计划授权，原旧读链/Frozen/历史不改。精确源码10阶段Gate、源码与独立报告自然CI及远端clean在报告层收据兑现；真实Roon/NAS/设备/听感/Owner及旧010、录音Gate继续carryover。012交付封存后从最后report HEAD进入013，不逐步审批。
