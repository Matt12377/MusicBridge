# MBF-002/003 整理工作台实现与接线边界

基线：`479e746bb7106a4dac158fe616290220de03a53a`；隔离分支：`codex/mbf-002-003-local-library`。本文记录当前模块与验证层次；完整原功能范围以 `COVERDROP_FEATURE_MAP.md/.json` 的 35 个原可见流程、1 个 MB 保留流程及1个原版本不存在项为准。不存在项是歌词：指定 CoverDrop 提交没有该流程，不能用其后脏源码字符串计为原功能。

本线主代理负责隔离模块、统一编译/测试和具体最小diff提案；调度 Root 审边界；MusicBridge V3.9 在 MBF-004 封板后串行实现共享 writer/journal注册/worker路由、旧Main/index/Preload/App/LocalLibraryView、保险库配置与CUE Actor并做最终集成。本作者只写分配的工作台/合同/Core纯计划/只读捕获和对应测试，没有运行 App、真实曲库、数据库、在线图片或真实模型，也没有提交/push。

## 1. 已写模块

| 路径 | 实际职责 |
| --- | --- |
| `packages/contracts/src/local-library-workbench.ts` | 唯一公共 DTO、15 个命令的 request/result 闭集、11 个可取消读 envelope。拒绝隐藏字段、getter、符号键、非普通原型、额外路径/凭据/授权；图像公开副本与原命令回执独立核验。 |
| `apps/desktop/src/renderer/src/composables/application/local-library-workbench/types.ts` | 重导出上述 DTO，保留强类型可注入 ports 与 Renderer 本地 AbortSignal；不复制第二套合同。 |
| 同目录 `controller.ts` | 完整明选专辑批次、真实候选/比较/建议、CUE轨预览、明确应用、取消/迟到围栏、原 command 与逐项失败/unknown恢复查询。能力未接入时显示原内容和具体原因。 |
| `apps/desktop/src/renderer/src/components/library/local-workbench/{LocalLibraryWorkbench,LocalAiReview,LocalCueSplitReview}.vue` 和 `workbench.css` | 复用正式 semantic classes/tokens；候选理由与字段变化、轨序/PCM区间/格式/独立目标、明确保存和原任务结果。没有手工 AI 替代表单、示例曲目或图片占位。 |
| `packages/bridge-core/src/collection/local-library-workbench/types.ts` | 私有完整组/真实失败文件联合类型、名称模型输入/建议、实际PCM探测/编码资格、冻结计划、required protectedWriter/durable CAS 端口。 |
| 同目录 `name-proposal.ts` | `buildLocalNameModelInput`、`localNameModelPrompts`、`parseLocalNameProposal`、`createLocalNamePlanDraft`；纯函数不联网、不读FS、不写DB。 |
| 同目录 `cue-plan.ts` | `localCueCdFramesToPcm`、`buildLocalCuePlan`、`createLocalCuePlanDraft`；真实CD75/PCM输入才产生区间，保留pregap与源，检查空轨/越界/重叠/溢出/格式资格。 |
| 同目录 `read-service.ts` | 原 `inspectAlbum`、catalog、scan与真实根状态读取；签发临时读取引用、完整捕获、准备/验收名称建议、名称/封面预览和原CUE事实，不生成音频或取得源写权。 |
| 同目录 `plan-registry.ts` | 原 plan/capture/command/receipt/cancel 持久 CAS 身份；未知不重签、不重放；快照恢复和明确原图字节恢复。 |

`owner-journal.ts` 与 Main/service/providers/normalizer/IPC/Preload/Renderer ports由其他已分配作者写入，不能把它们的文件存在当作本作者完成了原 Owner/正式 App 集成。共享接点见 `WORKBENCH_SHARED_PORTS.md`。

## 2. 公共命令与取消

| 命令 | 返回事实 |
| --- | --- |
| `localWorkbench.capabilities` / `localWorkbench.read` | 真实能力/格式/原维护入口与完整明选专辑读取。没有已成功音轨时不造 trackId/AudioAsset。 |
| `localWorkbench.artwork.local` / `.search` / `.file` / `.import` | 实际只读本地/内嵌/搜索/选择/拖入的候选；取消文件选择返回 null，候选阶段不建发行。 |
| `localWorkbench.artwork.preview` | 冻结明确选图的规范副本与原完整组；scope MB_ONLY，关系 existing/create-on-apply。零成功音轨或缺实际本地来源证明进入 blocked。 |
| `localWorkbench.ai.suggest` / `.preview` | 原三后端真实名称候选与用户明确选择后的 MB_ONLY 冻结计划。 |
| `localWorkbench.cue.target` / `.preview` | Main实际独立目标公开 choiceId，随后实际轨序/PCM分段/格式/输出名计划。 |
| `localWorkbench.plan.apply` / `.receipt` / `.cancel` | 一个明确原 command 的应用、原回执读取、明确原任务取消；逐项 applied/not-written/failed/cancelled/unknown。 |
| `localWorkbench.existing.open` | 原整理/源标签/源封面/改名/移动/历史/多库/设置/扫描/Finder入口的真实 opened 回报；opened:false不能叫成功。 |

前11类读取/候选/预览通过 `LocalWorkbenchReadRequestEnvelope={requestId,command,payload}` 和 `requestLocalWorkbenchRead`。`cancelLocalWorkbenchRead({requestId})` 只取消该 sender+dataset+nonce 已登记的读取；Main仍须等待实际 promise、socket或原生选择器资源退出。标记取消与实际资源退出分开；原生窗口不能立即关闭时丢弃晚到结果，不能声称已关窗。apply/receipt/cancel/existing.open不包装成读，不用关闭面板假撤销写入。

既有 `localWorkbench.read` 的 `LocalWorkbenchReadback.pendingOperations?` 只读投影同 dataset 的原 unknown/running 操作，不新增命令。通用 `isLocalWorkbenchOperation(value,datasetId?)` 可验证包含终态的 registry 完整列表，严格核原request/plan/revision/hash/context/kind/全部receipt项；操作状态沿原registry计算。Main先验证真实列表再筛未确认操作，readback最终拒绝重复command/plan、超过100项或总2MiB，不能截取凑预算。Renderer全部核完后原子恢复；缺字段/空列表不清内存原unknown，改写原计划与错库整项拒绝，已核终态不被旧unknown倒退。界面可直接展示已应用/未知单项并查询原command，恢复不会签新UUID或重发apply。

## 3. 原 Owner 只读端口

`createLocalWorkbenchReadService` 必须接同 dataset 原 repository/localAlbums 和 `assertCurrent`、实际 `readRootViews`。根状态沿原 `ONLINE`、`SOURCE_ROOT_OFFLINE`、`REVOKED`，分别投影 online/offline/unavailable。

| 原端口 | 精确私有事实 |
| --- | --- |
| `localAlbums.inspectAlbum({albumKey,rootId})` | 完整组、全部成员与明确分配的 `rejectedFiles`；不以显示页、代表曲目、某一类失败计数代替完整成员。 |
| `localScan.privateWorkbenchDirectoryFacts({expectedRevision,libraryRootId,directories,maxFiles,maxBytes})` | `{revision,files:[{jobId,rootRevision,sourceRootId,currentRelative,value:ScanFileState}],cues:LocalAlbumSqlCueStored[]}`。当前定位用 currentRelative；value.relative保留历史扫描事实。原guarded read/目录闭集/currentFileState/locator/同水位共同复核，先预算拒绝，不截断。 |
| `localCatalog.privateWorkbenchMetadataProvenance(trackIds)` | `[{trackId,override:null|{commandId,revision,fields:LocalMetadata}}]`；一次最新原override账本读取，不把操作名、UUID或有override推定为human/AI作者。 |
| `readOverrideAuthor(fact)` / `readAuthorRevision()` | 只消费实际同 Owner durable 父子命令/结果证明。无证明明确 unknown，只有明确manual字段锁；已应用AI来源与人工覆盖分开。 |

捕获至多100个明确专辑，每组至多10000个成员，完整捕获/缓存预算32MiB。提示摘要只采前12个原物理音频文件，同一asset多个逻辑段只计一次；完整授权成员不随摘要删去。零Track失败目录仍捕获真实文件名/签名/parser/failure，assetId/trackId及不存在的metadata/file修订保持null，不能补造音轨或安全关系。

实际 `LocalWorkbenchReadService` 方法：

- `readAlbums(request,context)` 返回公共读取；`resolveCapture({datasetId,capture:{albumId,readToken}},context)` 重新核完整组/根/定位/字段/水位，返回私有 `{datasetId,datasetRevision,capture,group,directoryFacts,provenance,availability}`。
- `prepareNameSuggestion(request,context)` 返回私有 `{preparationId,backend,systemPrompt,userPrompt}`；`completeNameSuggestion(id,{backend,content},context)` 消费一次准备并核原捕获，返回真实 ready/failed。捕获变化或离线不会被记成模型失败。
- `prepareNamePreview(request,context)` 返回 `{draft:ai,capture}`；`prepareArtworkPreview({resolved,artwork},context)` 返回 `{draft:artwork,capture}`，随后唯一 registry `issuePlan`。
- `resolveCueFacts({datasetId,capture,cueId},context)` 返回当前真实解析CD75/原asset修订，仍无PCM实读资格；`cancelNamePreparation(id)` 只使准备迟到结果失效。Main必须另收口真实请求资源。
- `close()` 停止临时读取；`inspect()` 是临时捕获/准备/候选数量。持久原操作由registry分开恢复。

## 4. 原图、名称与CUE冻结

封面 private `LocalWorkbenchArtworkCapture` 的 required `originalBase64` 是与 `image.original` 完全一致的兼容PNG/JPEG原图字节。原图与 `image.display.dataUrl` 缩略图分别核 canonical Base64、实际长度、SHA256、mime签名和预算；原图≤4MiB、display≤1MiB，capture整体≤32MiB。TIFF/WebP经真实Main解码转换后的兼容原图保存在该字段，原输入mime/bytes/hash/converted保留于input。sourceIdentity缺失不补造，不透明来源标记不等于FS权限。

`registry.readArtworkCapture({datasetId,planId,candidateId})` 同步返回freeze的 `LocalWorkbenchFrozenArtwork|null`，含 datasetRevision/planHash/contextFingerprint、原完整AlbumCapture及原图artifact。精确plan寻址避免同候选不同捕获歧义；过期也可只读对账原图，不能据此应用。Main重启恢复只能解码该原图，不能把display替代原图或重新provider下载。完整image/originalBase64参与contextFingerprint与持久CAS，不能只保存imageSha或临时Map。

名称parser接受原 `artistName/albumName` 两键JSON和真实可选reason，拒绝重复/额外键、嵌套授权、指令/角色输出、坏JSON与预算越界。没有reason时明确后端来源和“模型未提供理由”，不虚构模型推理。公共候选显示字段before/after与原因，人工锁/unknown来源变化进入blocked。

CUE必须从原真实 `parseCueText` 得到CD75索引，并由真实读许可取得PCM总帧/采样率与实读revision。`NOT_VERIFIED`、文本时长、`endFrames:null`或缺总帧不能变成可执行计划。纯换算为 `floor(CDFrames*sampleRate/75)`，BigInt检查溢出；末轨结束采用实际PCM总帧。格式必须有实际编码/标签/音频回读资格；FLAC、ALAC、MP3、Vorbis、Opus、WavPack、PCM WAV/AIFF保留原能力位置，未资格显示不可用。最终scope为INDEPENDENT_OUTPUT、sourceDisposition为retain；真实writer只输出独立目标。

## 5. 唯一持久 registry 与执行端口

`createLocalWorkbenchPlanRegistry({datasetId,persistence,writer,now?,makePlanId?,ttlMs?})` 是异步工厂。持久snapshot schemaVersion=1；每次save要求expectedRevision CAS；没有production内存或文件fallback。

| 方法/端口 | 必要行为 |
| --- | --- |
| `issuePlan(draft,capture)` | 冻结完整上下文、revision/hash/expiry；仅预览，不调用writer。 |
| `apply(original)` | CAS保存唯一原命令后才允许writer。重复同原命令共享正在执行/原回执；同plan新UUID、同资源未确认原操作都拒绝绕过。 |
| `readOriginalReceipt(original)` / `cancel({original,cancelCommandId})` | 身份必须与已存原请求完全一致；取消ID先持久化且只签一次。unknown不补发，迟到unknown/异常/错身份不使已知终态回退。 |
| `operations()` / `getPlan(planId)` / `readArtworkCapture(...)` | 读取持久原操作/计划/真实原图；恢复不自动执行。 |
| `isLocalWorkbenchRegistrySnapshot(value,datasetId)` | 直接调用原完整内部validator，包含原图实际字节、全部plan/capture哈希、原command/receipt/cancel与预算；不复制简化校验。 |
| `LocalWorkbenchRegistryPersistence.load/save` | 唯一Owner原连接读/CAS，事务不确定时停止后续变更，保留原命令；不能用存储错误解释为可安全重签。 |
| `LocalWorkbenchProtectedWriter.revalidate/apply/readOriginalReceipt/cancel?` | required真实受保护端口。revalidate只确认事实；apply仍重核完整组/根/track/asset/metadata/水位及实际许可/claims/FD。CUE actor生命周期与源写grant分别保留，不能用空unavailable适配宣称交付。 |

本线主代理新增的 `owner-journal.ts` 用12KiB字节分块满足原ledger单行64KiB，操作名 `local-workbench-v1`。必须在原Owner一个事务内核CAS、提交全部chunks+commit并冷核完整链，损坏/未commit尾部不丢弃。本线准备原 operation 闭集/Owner事务/受保护MB_ONLY writer/Main actor最小diff，调度 Root 审边界，MusicBridge V3.9 在004封板后串行实施；本作者没有改旧共享存储/Owner入口。

本线已补合同/Controller/Main新service的只读恢复接点：registry由原durable请求重建，Main投影 `operations()`，全新Controller从readback恢复原操作后只查询原回执。新增合成冷开/错身份/迟到恢复已由主代理定向复验合同7/7与Main/UI/IPC37/37；它们不代表正式App或原Owner共享登记已完成。最终集成仍必须连接实际Owner持久端口并验证App冷启动。本线主代理的 `checks/SHARED_WORKBENCH_JOURNAL_PROPOSAL.patch` 为未应用最小SQL提案，按原dataset-identity实读区分恢复后多个dataset各自CAS链；调度Root审界、MusicBridge V3.9后续落实。完整专辑业务原子writer的精确共享修改提案另见 `V39_ATOMIC_WRITER_INTEGRATION.md`，不能把snapshot helper当作其实现。

## 6. 当前验证证据

当前自有测试源码共 Core48（名称8、CUE7、registry15、合同7、读取11）与 Renderer21，均为合成行为；同Owner journal6由主代理另写。恢复接点新增合同2项、Renderer3项，Mainservice另有作者新增1项；主代理必要复验已取得合同7/7、Main11/UI21/IPC5共37/37、contracts build及Core tsc exit0。没有重放未改的名称/CUE/registry/read模块；源码计数不代替实际执行。

本线主代理 `workbench-core-artifact-current` 实跑52：41通过、11读取用例失败、无skip、exit1。名称/CUE/registry/合同与journal在该快照通过；失败均在初次捕获，合成正例短ID/旧离线枚举不符合原闭集。随后本作者只修读取夹具为真实v4 UUID、原root/track/asset/metadata/源状态，保留11条行为断言；本线主代理定向 `workbench-read-fixture-current` 复验11/11、fail0、skip0、exit0，未重跑无改动的41项。原52批失败证据保留，不伪称后修重新跑整52。

本作者已回读以下任务目录日志及对应JSON，检查真实命令、退出状态、测试总数/失败/跳过：

| `checks/` 日志 | 实际结果与范围 |
| --- | --- |
| `workbench-core-artifact-current.log` | 原52批41pass/11fail、无skip、exit1，历史失败原样保留；原图/registry/名称/CUE/合同/journal在该快照通过。 |
| `workbench-read-fixture-current.log` | 只重验修改的读取夹具，11/11、fail0、skip0、exit0。 |
| `core-tsc-current.log` | 恢复接点改动前Core tsc `--noEmit` exit0。 |
| `desktop-tsc-current.log` | 恢复接点改动前desktop vue-tsc `--noEmit` exit0（2026-10-11 02:27:56–02:28:09 UTC）。 |
| `workbench-ipc-types-current.log` | IPC/Renderer/规范图像导入35/35、fail0、skip0、exit0，确含工作台Renderer18。 |
| `workbench-main-service-current.log` | 新Mainservice10 + provider/名称transport29，共39/39、fail0、skip0、exit0。 |
| `contracts-build-recovery-current.log` | 恢复接点合同build真实exit0（2026-10-11 02:42:27–02:42:31 UTC）。 |
| `workbench-recovery-core-current.log` | 当前合同7/7、fail0、skip0、exit0，含新增恢复闭集/预算行为。 |
| `workbench-recovery-ui-main-current.log` | Main11 + Renderer21 + IPC5，共37/37、fail0、skip0、exit0，含真正registry重建的Main投影和全新Controller原回执恢复。 |
| `core-tsc-recovery-current.log` | 当前Core tsc `--noEmit` exit0。 |
| `desktop-tsc-recovery-current.log` | 本次desktop类型检查exit1；新Main合成fixture错误把拒绝成员扩成有track的资产，原精确union拒绝。对应作者已修并继续真实RPC async ports适配；新鲜复验尚待，旧desktop exit0不覆盖此快照。 |

日志根为 `/Volumes/LifeWeave/Developer/CommandLine/tmp/mbf-002-003-7tvk_82n/checks`。命令由本线主代理执行，本作者只回读；没有把分别定向通过伪称为一次重跑52。正式App/旧入口与真实protected writer/保险库/CUE Actor仍需MusicBridge V3.9装配，不能由type、合成IPC和provider测试代替。

此前Main统一type检查发现 read-service离线枚举/controller隐式回调类型，已按精确原枚举与CueRef/FieldChange闭集类型修正；不放宽为any。限定路径 `git diff --check` exit0只覆盖已跟踪变更，是静态格式证据；新增文件另按逐文件检查记录。合同build、当前Core/Renderer定向行为、正式App接线、真实模型质量、真实CUE产物及Owner成品试用分别记录。普通浏览不建发行；SourceWrites保持OFF；原MB标签/封面写回、改名/移动/预览/恢复入口与多库/并发1–24/局刷/云端配置仍需MusicBridge V3.9实际装配，不能据控件或源字符串存在结项。
