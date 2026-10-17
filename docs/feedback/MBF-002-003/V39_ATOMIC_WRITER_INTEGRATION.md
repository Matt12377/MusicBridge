# V3.9：完整专辑 MB_ONLY 原子 writer 集成提案

本提案只读核查隔离工作树，基线为 479e746bb7106a4dac158fe616290220de03a53a，分支为 codex/mbf-002-003-local-library。本线主代理准备具体最小 diff，调度 Root 审边界；MusicBridge V3.9 在 MBF-004 封板后串行实施共享 writer、原 Owner/worker、正式 App、保险库与 CUE Actor。**本文接口和带“拟新增”的调用尚未实现，代码块是可实施规格，不是现成生产调用或验证通过证据。**

目标是把一个明确的 AI/封面计划涉及的完整专辑批次，在唯一 Owner 原连接的一次 BEGIN IMMEDIATE 中核验并提交；任何失败均不得留下半张发行、半组标签或孤立选图。SourceWrites 保持 OFF。CUE 独立输出不进入本 MB_ONLY 数据库 writer。原 local-workbench-v1 分块 snapshot/CAS 提案与本业务 writer 分开：其有限边界认可、文件存在与 helper 测试都不构成业务写入或共享登记已完成。

## 1. 实查原文件与可以复用的真实接点

| 实际文件 | 已有符号/事实 | 本次准确边界 |
| --- | --- | --- |
| packages/bridge-core/src/collection/local-catalog-store.ts | createLocalCatalogStore、privateRead、privateBatch、mutate、verifyMutation、verifyHistoryStep、verifyLocalCatalogDatabase、certificateFor | privateBatch 同步回调内已经支持 override-metadata/create-edition/link-edition-track；mutate 保存真实实体和完整子 ledger，再核 request/result/历史修订/预算。 |
| 同文件 | applyOverrideMetadata、applyCreateEdition、applyLinkEditionTrack | 覆盖是整条 fields 替换，annotations 未指定时继承；新 writer 必须先合并保留字段。发行及关系 id 由真实 mutator 创建，不能由 Renderer 代造。 |
| packages/bridge-core/src/collection/local-organizer-store.ts | createLocalOrganizerStore.capture、assertSnapshot、confirm、apply、get | apply 在单个 privateBatch 内写所有 override 及整理事件，提供事务模式；原 editionTracks 和公开整理计划的 100 曲预算不能代替工作台完整组。 |
| packages/bridge-core/src/collection/local-organizer-journal.ts | verifyOrganizerJournalRow、item-applied | 原 item-applied 精确核 decision、operationId、子 request、真实 overrideRevision/fields/annotations；可复用此证明原则，不能借原事件格式承载新 10000 成员或图片。 |
| packages/bridge-core/src/collection/local-artwork-store.ts | schemaObjects、budget、candidate、selection、set、transaction、verifyLocalArtworkDatabase | 原候选/选择/回执共享此数据库，但各 stage/apply 自开事务；需要同步事务内 helper，不能调用其 transaction 嵌套提交。 |
| packages/bridge-core/src/collection/local-artwork-service.ts | createLocalArtworkService.createEdition、commandPart、prepareEdition/completeEdition 调用 | 原流程分别建 intent、createEdition、单首 linkEditionTrack、完成回执，不是完整专辑原子创建。必须保持旧流程，同时给工作台另接有限入口。 |
| packages/bridge-core/src/stream/local-source-fence.ts | withLocalFactsMutation、commitLocalFacts、rollbackLocalFacts、LocalFactsCommitFatal | 原 COMMIT/ROLLBACK fatal 和短派发资格不能绕过。只有确认 ROLLBACK 的 LocalFactsFenceBusy 可以按原规则有界重核，网络/编码/未知提交不重放。 |
| packages/bridge-core/src/collection/local-library-workbench/{types,read-service,plan-registry}.ts | LocalWorkbenchProtectedWriter、ownerRevision、isLocalWorkbenchPlanCapture、registry.apply/readOriginalReceipt | required writer 已有强类型边界，执行尚需 V3.9 真接线；原 request/plan/capture/hash/expiry 与 originalBase64 必须完整保留。 |
| packages/bridge-core/src/collection/local-album-browser/{owner-store,sql-read}.ts | albumCatalogRevision、createLocalAlbumSqlReader 的 members/groups | 当前 catalog 水位排除严格冷核后的纯 WB snapshot；实际 metadata/关系/定位/root/选图仍推进。已发行标题当前取 edition.data.title。 |
| packages/contracts/src/{local-catalog,local-artwork}.ts | LocalTrack/AudioAsset/AlbumEditionTrack/LocalMetadataOverride、isLocalArtworkCandidate | 普通目录子命令 UUID/闭集/修订不能放宽；旧 provider 候选只支持真实 CAA/Commons 证明，不能伪装新来源。 |

原三文件基线 SHA256：local-catalog-store.ts 为 4485d96516b807433c0a3e318ebc662738ed9281431840feb29546025e7040ab；local-artwork-store.ts 为 b09bf9d744e7f851423a563d9453f83b0096d3354f789730f72cbe0746fb0ba1；local-organizer-store.ts 为 f20c01e26f64222f1955ec777bf505bfa375373b6517e08d7a001315e746e549。当前 catalog 相对479只读 diff已核为本线新增专辑读取/完整 metadata provenance accessor；privateBatch/普通 mutator 尚未成为本提案业务 writer。

原目录 schema 沿原表：local_catalog_roots/assets/tracks/editions/edition_tracks/observations/overrides/ledger。目录行文本预算64KiB、总文本16GiB；ledger和observations不可改写，身份表不可删除。封面沿 local_artwork_candidates/selections/ledger/create_intents，无新表、无 schema 迁移；原封面预算为4096选择、12000回执及intent、保留文本512MiB、未选缓存32项/8MiB。候选 bytes 列是 display.bytes，不能改为原图大小后仍沿旧 budget 假称通过。

## 2. 先补冻结执行绑定，旧计划不能应用时补造

当前 LocalWorkbenchAlbumCapture 有完整成功/失败成员、根、asset file/location、metadata视图hash和editionId；**没有显式冻结每个 track.selectionRevision、edition.revision、全 active relation 集及当前封面 selection.revision**。当前总水位可使变化失效，但不能代替 writer 所需的逐对象 expected 字段和子命令证明。V3.9应在准备预览、同一水位完整读取时补一个私有 MB 执行绑定，参与 capture/contextFingerprint/planHash/32MiB snapshot 的严格 codec；它不是 Renderer 的新参数。

拟新增到 packages/bridge-core/src/collection/local-library-workbench/types.ts 的最小形状如下。所有数组需 dense、唯一、完整、预算校验；所有旧实体仍用原 DTO guard。typed children 只能是下列三个普通目录操作和封面选择，不得接受任意 operation/SQL/路径：

~~~ts
interface LocalWorkbenchMbTrackBinding {
  track: LocalTrack
  asset: AudioAsset
  root: LibraryRoot
  currentRelative: string // 原 locator 当前事实，不是打开文件的授权
  metadata: LocalMetadataView
  latestOverrideCommandId: string | null
  activeRelations: readonly AlbumEditionTrack[]
  fieldAuthors: { artistName: LocalWorkbenchNameSource; albumName: LocalWorkbenchNameSource }
}
interface LocalWorkbenchMbAlbumBinding {
  albumId: string
  groupRevision: string
  trackIds: readonly string[]
  tracks: readonly LocalWorkbenchMbTrackBinding[]
  // scan拒绝/无track资产仍由原完整album capture冻结，绝不生成写入目标
  editions: readonly AlbumEdition[]
  editionMembership: readonly AlbumEditionTrack[]
  targetEditionId: string | null // 明确冻结的唯一目标；create-on-apply时为null
  artworkSelection: LocalArtworkSelection | null
  createEditionCommandId: string | null
  linkCommands: readonly { commandId: string; trackId: string; disc: number; trackNumber: number; sequence: number }[]
  overrideCommands: readonly { commandId: string; trackId: string; expectedRevision: string | null; fields: LocalMetadata; annotations: LocalMetadataAnnotations }[]
  storedArtworkCandidateId: string | null
  artworkSelectionCommandId: string | null
}
interface LocalWorkbenchMbExecutionBinding {
  schemaVersion: 1
  commitEventId: string
  catalogRevision: string
  scanRevision: string
  authorRevision: string | null
  sourceRoots: readonly { libraryRoot: LibraryRoot; permissionFingerprint: string }[]
  albums: readonly LocalWorkbenchMbAlbumBinding[]
}
~~~

子 commandId、候选存储UUID及 commitEventId 由 Owner 在预览签发前生成并持久冻结；它们只是精确寻址，作者资格须由真实父子证明取得，不能看UUID前缀、哈希生成算法或操作名称。apply不能临时换编号。已有缺执行绑定的 ready计划必须 blocked并重新明确预览；已有真实终态/unknown原回执保持可读，不通过重新签发“修复”。

完整组须含 inspectAlbum 的全部真实成员、rejectedFiles、当前目录facts和CUE/scan身份。每组10000成员及capture32MiB原预算先核，不能用200条页面、100首Organizer返回或12首提示摘要截断。零track目录不得建发行。存在失败文件时预览明确成功关联数与保留的失败记录；只有真实成功track进入MB关系，失败文件保持原事实。

已有edition的封面选择会作用于该edition全部成员。须捕获其全部active关系及所有受影响根；若选定组不能覆盖完整发行关系，明确 blocked，要求重新选择完整范围。不能把“当前root的一页曲目”叫完整edition，也不能对另一根的未捕获关系静默选图。

## 3. V3.9具体最小修改点

| 精确文件/拟新增符号 | 必须完成的改动 |
| --- | --- |
| local-library-workbench/types.ts、plan-registry.ts、read-service.ts | 增加上述私有冻结绑定及闭集/identity/hash/budget验证；名称/封面preview读取绑定，不在apply重捕获后填成旧expected值。缺绑定只读恢复兼容、执行阻断。 |
| local-catalog-store.ts：拟新增 privateWorkbenchMbRevalidate/privateWorkbenchApplyMB/privateWorkbenchMbReceipt | 同一guarded连接执行；内部复用privateBatch/mutate的唯一事务引擎。提供有限封面写/业务commit appender，不向Main/Renderer暴露db或通用回调。 |
| 同文件：privateBatch内部审计 | 新 MB action明确核总变化数；mutate已核的每个实体+子ledger，封面helper的有限候选/选择/回执写，以及一个业务commit row都计入。不能借Scanner例外或放宽 action前缀绕过。 |
| local-artwork-store.ts：拟新增 applyWorkbenchCopyInTransaction/verifyWorkbenchCopyReceipt | 同步函数不BEGIN/COMMIT、不访问FS/网络；复用原candidate/selection/set/budget原则，核expectedSelectionRevision并记录真实selection子回执。更新当前候选/选择和ledger须同一事务。 |
| packages/contracts/src/local-artwork.ts 与原artwork冷核 | 增加有限“workbench-frozen-v1”候选JSON变体，见第5节；旧来源变体保持严格。相关原provider分支须显式拒绝借副本获得源写/下载权限。 |
| 拟新增 packages/bridge-core/src/collection/local-library-workbench/mb-business-proof.ts | 有界、闭集业务commit codec与父子历史核验。普通实体子ledger照常核；业务证明是独立于纯snapshot的实际事实。 |
| local-catalog-store.ts：verifyLocalCatalogDatabase/verifyHistoryStep附近 | 严格登记新私有业务操作 local-workbench-mb-commit-v1，按该历史点完整验证父原request、冻结绑定、子request/result及digest；不增加普通公开目录写命令。 |
| local-catalog-store.ts：拟新增 privateWorkbenchNameAuthors/privateWorkbenchNameAuthorRevision | 从当前latest override和已冷核父子证明投影字段级作者，只查原记录，不新增作者表。 |
| local-library-workbench/read-service.ts 的 readOverrideAuthor 端口 | 内部返回改为字段级 artistName/albumName，见第6节；原字符串来源不能错误解锁混合人工/AI字段。 |
| local-album-browser/sql-read.ts 的 groups.title | 推荐优先使用全组一致、非空effective_album，再回退edition.data.title；AI写全组metadata后墙展示采纳值，原发行记录/身份保留。无需新rename-edition公开操作。 |
| dataset-owner-{protocol,worker,client}.ts、dataset-services.ts/dataset-domain.ts | 固定强类型调用/唯一Owner实例/关闭先停受理并等待实际资源；真实required writer注入registry。旧Main/index/Preload/App/LocalLibraryView按V3.9串行装配，不能以空unavailable writer报完成。 |

若产品另要求修改正式 AlbumEdition.title，原479没有该mutator。必须另外加入严格 request/result、expectedEditionRevision、verifyHistoryStep和完整cold测试；不能裸UPDATE或把只读标题投影当实体改名。此项不是本提案推荐的最小实现。

## 4. 唯一事务的SQL核验与真实调用

文件读取/图片解码/模型请求与真实源观察全部在事务外完成；通过原有限许可取得真实事实。源只读 namespace/physical claims 跨最终复核与COMMIT保留，确认实际FD关闭后才释放；事务内只允许同步原Owner SQL。revalidate仅提前发现问题，apply仍重新核原身份和完整事实；不得把Main临时Map、文件名或opaque sourceIdentity当权限。

拟新增三个有限私有方法签名：

~~~ts
privateWorkbenchMbRevalidate(input: Readonly<{
  plan: LocalWorkbenchPlan; capture: LocalWorkbenchPlanCapture
}>): { valid: true } | { valid: false; reason: string }

privateWorkbenchApplyMB(input: Readonly<{
  original: LocalWorkbenchApplyRequest
  plan: LocalWorkbenchPlan
  capture: LocalWorkbenchPlanCapture
  sourceSession: LocalWorkbenchProtectedCaptureSession
}>): LocalWorkbenchReceipt

privateWorkbenchMbReceipt(original: Readonly<LocalWorkbenchApplyRequest>): LocalWorkbenchReceipt | null
~~~

拟新增私有session和受保护读取端口如下，均只在唯一Owner中流动，不能经过公开合同或接受Renderer/Main自签对象。session必须由真实actor登记并在内部按对象身份核验；assertCurrent同时核根/Owner、真实claims仍持有及冻结观察。普通数据对象或permission=true不能取得此资格：

~~~ts
interface LocalWorkbenchProtectedSourceObservation {
  albumId: string
  assetId: string | null // 扫描拒绝文件仍用真实目录facts，不造资产
  libraryRootId: string
  sourceRootId: string
  rootRevision: string
  currentRelative: string
  rootCapability: RootCapability
  physical: ReadonlySourcePhysicalObservation
}
interface LocalWorkbenchProtectedCaptureSession {
  observations: readonly LocalWorkbenchProtectedSourceObservation[]
  assertCurrent(): void
}
interface LocalWorkbenchProtectedReadPort {
  withCompleteCapture<T>(
    capture: Readonly<LocalWorkbenchPlanCapture>,
    consume: (session: LocalWorkbenchProtectedCaptureSession) => Promise<T>,
  ): Promise<T>
}
~~~

RootCapability、ReadonlySourcePhysicalObservation与withReadonlySourcePublicationClaims为原 `packages/bridge-core/src/recording/source-files.ts` 的真实私有型/函数。现函数单次最多2048物理来源，不能伪称已支持工作台10000成员；去重同物理asset后仍超过原资格时必须在预览明确blocked。若要支持该完整组，V3.9须另外实现有界全集namespace/physical保护与FD调度并实际验证；不能只提高数字、截成员或分段提交数据库。session关闭失败沿原SourcePublicationUnverified保留保护；没有真实来源观察继续明确不可用。MB_ONLY不取得源写权。

在同一事务中先从真实snapshot/原command加载冻结计划，按原所有字段逐项相等核验，检查ready/expiry/MB_ONLY。随后完整SQL核验；只读页查询可复用原SQL reader，但所有页面必须在该事务同水位读完，先计数/字节拒绝，禁止异步inspect嵌进callback。以下是实际表上的参数化核心读取，仍须用原readTrack/readAsset/readRoot/metadata/DTO guard解码并补全部组/scan核：

~~~sql
WITH requested(id) AS (SELECT value FROM json_each(?))
SELECT t.id,t.data track_data,a.id asset_id,a.data asset_data,a.relative,a.sha256,
       r.id root_id,r.data root_data,o.data override_data
FROM requested x
JOIN local_catalog_tracks t ON t.id=x.id
JOIN local_catalog_assets a ON a.id=t.asset_id
JOIN local_catalog_roots r ON r.id=a.root_id
LEFT JOIN local_catalog_overrides o ON o.track_id=t.id;

WITH requested(id) AS (SELECT value FROM json_each(?))
SELECT l.id,l.edition_id,l.track_id,l.data relation_data,e.data edition_data
FROM local_catalog_edition_tracks l
JOIN local_catalog_editions e ON e.id=l.edition_id
WHERE json_extract(l.data,'$.active')=1
  AND (l.track_id IN (SELECT id FROM requested)
       OR l.edition_id IN (SELECT value FROM json_each(?)));

SELECT data FROM local_artwork_selections WHERE edition_id=?;
SELECT * FROM local_catalog_ledger WHERE command_id=?;
SELECT fingerprint,result FROM local_artwork_ledger WHERE command_id=?;
~~~

核验须同时满足：成员集合/失败文件集合与原捕获完全一致；所有根/source绑定/许可事实一致；track id/assetId/selectionRevision/segment相等；asset root/file/location及当前relative相等；raw/effective/override及latestoverridecommand相等；所有edition revision及active relation完整集合/顺序相等；封面selection id/revision相等；catalog/scan/字段作者修订相等。extra成员、改根、改位置、换asset、raw变化、人工覆盖、增删关系、封面变化都拒绝旧计划。

V3.9内部实现轮廓如下。runWorkbenchMbBatch是拟新增的有限包装，复用原privateBatch事务引擎并加第3节audit接点；图中mutate为**原真实函数**，不能替换为每曲 catalog.overrideMetadata/createEdition 独立事务。typed helper必须先实现且真实注入，不能留空stub：

~~~ts
return runWorkbenchMbBatch((db, mutate, tx) => {
  const repeated = tx.readVerifiedOriginalBusinessReceipt(input.original)
  if (repeated) return repeated
  const frozen = tx.loadExactFrozenOriginal(input.original, input.plan, input.capture)
  tx.assertReadyAndComplete(frozen, input.sourceSession)
  const children: VerifiedMbChildResult[] = []
  for (const album of frozen.mb.albums) {
    if (frozen.plan.kind === 'ai') {
      for (const child of album.overrideCommands) {
        const result = mutate('override-metadata', { ...child })
        children.push(tx.verifyOverrideChild(album, child, result))
      }
    } else {
      let editionId = album.targetEditionId
      if (album.createEditionCommandId !== null) {
        const edition = mutate('create-edition', {
          commandId: album.createEditionCommandId,
          title: tx.frozenAlbumName(album.albumId), edition: '',
        })
        editionId = tx.verifyCreatedEdition(album, edition).id
        children.push(tx.createdEditionChild(album, edition))
        for (const link of album.linkCommands) {
          const result = mutate('link-edition-track', { ...link, editionId })
          children.push(tx.verifyLinkedChild(album, link, result))
        }
      }
      if (editionId === null) throw tx.invalid('没有真实发行或可关联音轨。')
      const selection = tx.applyArtworkCopy({
        album, editionId, artwork: tx.frozenArtwork(album.albumId),
      })
      children.push(tx.verifyArtworkChild(album, selection))
    }
  }
  const receipt = tx.exactSuccessfulReceipt(frozen)
  tx.appendBusinessCommit(frozen, children, receipt)
  return receipt
}, 'local-workbench:mb-apply')
~~~

完整明确批次只开一次BEGIN IMMEDIATE。已有edition按冻结targetEditionId选择，不能随意取trackDetail第一个edition；该目标必须在冻结editions及完整关系集合中，create-on-apply时目标为null且createEditionCommandId非null，多目标歧义在assertReadyAndComplete拒绝。所有overrideCommands.fields由预览时的原override合并**仅候选实际改变的artist/album**得到，title/year/disc/track及annotations原样保留，不能只传两键抹掉旧字段。metadata不存在的字段不凭空制造。

最终COMMIT沿原commitLocalFacts/beforeLocalFactsCommit/onLocalFactsFatal；成功后才发布catalog/artwork/作者projection。任何中途失败沿原rollbackLocalFacts，只有确认回滚后才能返回全组not-written，不能逐曲报成功。不得在事务内调用registry.save、原artwork.stage/apply/transaction、原Organizer.confirm或原createEdition service，避免嵌套事务/提前回执。

protected writer装配的实际边界为：

~~~ts
const writer: LocalWorkbenchProtectedWriter = {
  revalidate: async (capture, plan) =>
    catalog.privateWorkbenchMbRevalidate({ capture, plan }),
  apply: async (original, plan, capture) => {
    const repeated = catalog.privateWorkbenchMbReceipt(original)
    if (repeated !== null) return repeated
    return protectedReads.withCompleteCapture(capture, sourceSession => withLocalFactsMutation(
      () => catalog.privateWorkbenchApplyMB({
        original, plan, capture, sourceSession,
      }),
      () => { assertCurrent(); sourceSession.assertCurrent() },
    ))
  },
  readOriginalReceipt: async original =>
    catalog.privateWorkbenchMbReceipt(original),
}
~~~

withCompleteCapture也是待V3.9注入的真实受保护读取。只有实际资源收口确认后才能将成功回执返回调用者；业务COMMIT后关闭/释放未知仍保留原可查询业务证明并封口，不能回退为not-written或重发。CUE另接真实输出actor，不能让该factory把cue当MB metadata写或返回假成功。

## 5. 冻结原图、旧候选JSON和全组关系

originalBase64与image.original的canonical字节/实际SHA256/长度完全一致，原图≤4MiB；display是独立JPEG缩略图≤1MiB，二者可以尺寸/hash不同。完整artifact在原32MiB工作台snapshot，封面表只保存原图metadata与display；不能把4MiB Base64塞入64KiB目录ledger，也不能重启从display或provider再下载“补回”原图。

原isLocalArtworkCandidate对origin='provider'只认可CAA/Commons证明，所有旧变体sourceIdentity要求64hex。新的豆瓣/iTunes/手选/其他冻结候选来源不能伪装manual，不能编造remoteSource、CC0或sourceIdentity。建议在原候选JSON新增明确discriminator provider='workbench-frozen-v1'，保留实际origin/sourceLabel/licenseLabel，附严格copyProvenance：

~~~ts
interface WorkbenchArtworkCopyProvenance {
  schemaVersion: 1
  datasetId: string
  planId: string
  planHash: string
  contextFingerprint: string
  albumId: string
  candidateId: string
  artworkRevision: string
  sourceIdentity?: string // 仅原artifact确实提供时原样保留
  licenseLabel: string
}
interface LocalWorkbenchFrozenArtworkCandidate extends LocalArtworkImage {
  id: string
  editionId: string
  origin: LocalArtworkOrigin
  provider: 'workbench-frozen-v1'
  sourceLabel: string
  licenseLabel: string
  expiresAt: string
  copyProvenance: WorkbenchArtworkCopyProvenance
}
~~~

该有限变体沿旧image guard、UUID存储身份、字段/文本/预算闭集；copyProvenance不是源路径、网络地址、授权或许可证推断。旧来源variant仍要求原64hex/remoteSource证明；“workbench-frozen-v1”不能进入原网络fetch或源写分支。原SourceFiles写封面另走原保护/许可/资格；没有资格继续明确不可用。

事务内helper以预览冻结的storedArtworkCandidateId创建选择用候选，按真实edition FK、expectedSelectionRevision写selection，再写selection子ledger。新edition必须同事务先create，再把完整真实track逐项link；候选阶段不预建edition。选择mode='manual'表示用户明确选图，不改变candidate.origin实际来源。旧候选/历史/当前选中保留和缓存budget仍按原政策；不能为满足预算删除被选候选或历史回执。

## 6. durable父子证明与字段级作者

推荐新增一个私有业务marker操作 local-workbench-mb-commit-v1，仍使用原local_catalog_ledger，**不属于被排除的纯snapshot operation**。单行仅存原request、plan/context/binding hash、完整实际children结果hash/count及时间；不复制图片、全部labels或10000项request。精确子映射已在32MiB冻结binding中；每个子request/result由原ledger持久，业务marker引用完整canonical digest。父marker、所有catalog子实体/子ledger、封面selection及其子ledger必须在同一事务提交。

冷核按原ledger历史点取得该dataset当时已严格验证的workbench snapshot/原command，枚举冻结的完整childId集合，验证每条普通子request/result和封面子回执。create结果真实editionId用于精确校验link引用；override字段、annotations、revision与冻结patch完全一致。须拒绝缺child、错父/plan/DS、额外或重复child、跨album、错hash/来源、只改terminal副本、只有marker没有实体证明。历史证明对当时结果核验，不拿后来覆盖的当前行否定旧已应用回执。

原privateWorkbenchMetadataProvenance已经按latest override核当前row、commandId、revision和fields；它没有人工/AI author。workbench-ai只能从冷核通过的父plan.kind='ai'、本次确实改动字段及真实override子结果证明取得。保留的旧字段继承**旧真实字段作者证明**，没有证明就unknown；旧普通override不能因为名称或UUID被标manual。

当前readOverrideAuthor整条override一个NameSource不足以表示“人工artist保持、AI只改album”。建议V3.9把此私有返回细化为：

~~~ts
type LocalWorkbenchFieldAuthors = {
  artistName: LocalWorkbenchNameSource
  albumName: LocalWorkbenchNameSource
}
readOverrideAuthor(fact: LocalWorkbenchMetadataProvenanceFact):
  LocalWorkbenchFieldAuthors | Promise<LocalWorkbenchFieldAuthors>
~~~

artist/album没有override字段时分别raw；本次真实改artist/album的字段分别workbench-ai；明确人工入口若要产生manual，须登记其真实parent/child与具体字段，不能靠原Organizer operation名猜。单字段unknown只锁该字段；一个manual不能把整条AI override都说人工，一个AI也不能解掉未改人工字段的锁。

read-service.ownerRevision真实hash含catalog.privateAlbumBrowserRevision、scan.privateAlbumBrowserRevision及可选readAuthorRevision。localAlbums.nameEnhancements.revision也可注入实际状态源。**不得把registry.snapshot.revision或operations()修订填进任一作者/AI状态修订**：纯preview、原command落账、原receipt查询、取消准备及snapshot CAS不改变目录/字段作者事实，不得令原plan自己失效。作者修订只随实际metadata父子证明变更；AI状态修订只随实际候选ready/failed等结果变化，原计划snapshot不推进。真正metadata/关系/定位/root/封面变化仍正常拒旧捕获。

## 7. stale、未知提交、重开和原回执

- apply先读同原request的业务receipt，已提交则按冻结plan重建原逐项applied结果，零重签/重放；不能先用“当前水位已变化”拒读自己的已应用原回执。
- 无receipt才核旧expected/expiry。stale在首个mutate前失败；事务中发现任何问题都整体回滚。只有confirmed ROLLBACK才返回全组not-written。新回执仍原command/DS/planHash和完整item集合，不制造partial applied。
- COMMIT或ROLLBACK失败触发LocalFactsCommitFatal并封口Owner/相关本地派发；不能写普通failed、重试create/link、清账本或换UUID。连接结果未确认保留unknown。
- 重开先完整冷核原catalog、artwork、WB snapshot及业务父子证明。业务marker存在且全部子事实匹配才返回原成功；损坏/缺子是fatal保留数据。冷开后确认没有活动actor、原child与marker全部不存在，才可有证据报告原not-written；无法确认仍null/unknown。
- registry原请求在调用writer前已durable CAS保存。业务COMMIT成功但后续registry receipt CAS响应丢失，writer.readOriginalReceipt从真实业务marker恢复，不能把UI或registry内存unknown视为可重发。
- 已应用终态不被迟到unknown/异常倒退；取消UI只结束读取。同步MB事务提交后不能伪造“取消撤销”，真回滚/撤销须另行明确新预览，原SourceWrites/Organizer历史保持。

## 8. V3.9必须执行的定向行为

1. 原真实DB建两张完整专辑、多曲与混合失败文件；一次MB_ONLY明确采纳写所有真实曲目的目标字段，保留其它fields/annotations/失败事实，零源文件写。计划准备/原command落账不使自己失效。
2. 每个mutation/封面helper/marker边界故障注入：confirmed rollback后edition/link/override/selection/子ledger/marker全部为提交前状态，无半组。包括beforeCommit注入的额外未登记SQL被总变化审计拒绝。
3. 预览后增删成员/关系、改selectionRevision、换asset、root/source授权变化、定位/原字段/人工锁/选图变化：在同一事务拒旧捕获，零写；不截完整成员。
4. 无edition全组明确选图：候选不建发行，应用一事务创建一个真实edition、完整真实track关系与选择；零track拒绝，跨根/未捕获edition成员拒绝。双多edition歧义不能取首项。
5. 原图与缩略图使用真实不同owned样本，关闭Owner/重建registry/Main后恢复canonical原图；hash/长度/隐藏字段/错plan或sourceIdentity完整拒绝，display不能冒充原图。
6. 已提交业务、registry响应丢失→新Owner/Main/Controller读取原unknown并查同原command终态，零新UUID/重validate/apply/子写。未知COMMIT/ROLLBACK封口，恢复未核前无成功。
7. 伪造parent/child/metadata author、混合人工artist+AI album、未改字段无旧证明：逐字段来源与人工锁准确。pure snapshot/普通查询不推进author revision，真实metadata/proof变化推进。
8. 完整name字段采纳后现有edition墙标题显示全组effective album consensus，原editionId/record title仍保留；冲突/空共识回退原title。
9. 原catalog/Organizer/artwork全部cold验证、旧012/013源写/改名移动/恢复与播放回归分别验证。合成DB/actor证据不替代正式App、真实模型质量、真实媒体、成品试用或Owner接受。

本线当前已通过的pure计划/恢复定向测试仅证明对应模块。本文业务writer、执行binding、新候选codec、字段作者proof和正式装配都尚未实现/验证，必须由MusicBridge V3.9完成并给出新鲜实际日志；不能用原分块journal helper的通过数代替以上行为。

正式私有worker/client/domain/Main、normalize utility桥与页面装配另见 [V39_ROUTE_AND_PAGE_INTEGRATION.md](./V39_ROUTE_AND_PAGE_INTEGRATION.md)；原多库/扫描/云端与保险库设置另见 [V39_NATIVE_SETTINGS_INTEGRATION.md](./V39_NATIVE_SETTINGS_INTEGRATION.md)。这些文档同样是后续串行集成提案，调度Root对journal V2的有限认可不延伸为业务writer或Actor授权/完成。
