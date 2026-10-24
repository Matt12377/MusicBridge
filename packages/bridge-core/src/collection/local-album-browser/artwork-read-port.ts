import { readLocalAlbumArtworkMembershipProjection, type LocalAlbumArtworkMembershipProjection, type LocalAlbumArtworkMembershipFact } from './artwork-membership-projection.js'
import { noteDesktopArtwork, desktopArtworkStarted, desktopArtworkElapsed, desktopArtworkKey } from '../../shared/desktop-artwork-trace-node.js'
import path from 'node:path'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import * as dto from '@music-bridge/contracts'
import type { CollectionRepository } from '../repository.js'
import type { DatasetProjectionPort } from '../dataset-owner-protocol.js'
import type { RootCapability } from '../../recording/source-files.js'
import { readonlySourceCandidateMetadata, sourceRootAvailability, withCheckedReadonlyMetadataSource, MetadataLeaseReleaseError, SourceFileError } from '../../recording/source-files.js'
import { readRustEmbeddedArtwork } from '../../library/rust-embedded-artwork-reader.js'
import { RustMediaWorkerError } from '../../library/rust-media-worker.js'
import { LocalArtworkImageError, normalizeLocalArtworkInWorker } from '../../library/artwork-image.js'
import { logLibraryOperation } from '../../shared/library-operation-log.js'
import { readonlyLocalArtworkCandidateNames, localArtworkDiscParentDirectory, type LocalArtworkDiscoveryIssue } from '../../library/local-artwork-directory-candidates.js'
import type { LocalAlbumArtworkReadContext, LocalAlbumArtworkReadResult } from './types.js'
import { isLocalAlbumPrivateRelative, LocalAlbumReadError } from './grouping.js'
import type { LocalAlbumDisplayCacheEvidence, LocalAlbumDisplayCacheRecord } from './display-cache.js'
import { LocalAlbumArtworkResourceError, type LocalAlbumArtworkResourceBinding } from './artwork-resource-store.js'
import { captureLocalAlbumContext, localAlbumPhase, emitLocalAlbumNodeTrace } from '../../shared/local-album-read-trace-node.js'
import type { LocalAlbumLibraryOrganization } from './sql-types.js'
import { sourceWritesProjectionForDatabase } from '../local-catalog-store.js'
import { localAlbumScanPath, localAlbumScanPoint, type LocalAlbumScanPoint } from './scan-delta.js'

type ReadContext = { request: dto.LocalAlbumArtworkRequest; context: LocalAlbumArtworkReadContext }
type Capture = { target: ReadContext; root: RootCapability; relative: string; signature: string; expires: number }
type ReadMode = 'candidate' | 'display' | 'background'
export interface LocalAlbumArtworkSources { image: dto.LocalArtworkImage | null; copies: dto.LocalArtworkSourceCopies; grid?: dto.LocalAlbumArtworkGrid }
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const same = (left: unknown, right: unknown): boolean => isDeepStrictEqual(left, right)
type PermitTraceStage = 'localAlbum.artwork.permit-granted' | 'localAlbum.artwork.permit-deferred' | 'localAlbum.artwork.no-permit-unavailable'

/** 仅旁注原许可结果；诊断故障不改变业务，离开时恢复原首拒绝阶段。 */
function notePermitTrace(stage: PermitTraceStage): void {
  try {
    const context = captureLocalAlbumContext()
    if (!context) return
    const previousStage = context.stage
    try {
      localAlbumPhase(stage)
      emitLocalAlbumNodeTrace('ok')
    } finally {
      context.stage = previousStage
    }
  } catch { /* 诊断自己的故障不能改变原返回、异常或许可生命周期。 */ }
}

/** 未建立发行的目录也能读图；不会调用 stage/apply/createEdition。所有字节仅进入可信 Main。 */
export function createLocalAlbumArtworkReader(options: {
  repository: CollectionRepository; projection?: DatasetProjectionPort; datasetId?: string; assertCurrent(): void
  assertReadActive?(): void
  readLibraryOrganizations?(): readonly LocalAlbumLibraryOrganization[]
}) {
  const catalog = options.repository.localCatalog, captures = new Map<string, Capture>()
  type DisplayProof = { target: ReadContext; key: string; evidence: LocalAlbumDisplayCacheEvidence; deadline: number }
  const displayProofs = new WeakMap<LocalAlbumArtworkSources, DisplayProof>()
  const persisted = new WeakSet<LocalAlbumArtworkSources>()
  const invalidResources = new Set<string>()
  const invalidSelections = new Set<string>()
  let invalidRevision = 0
  const retiredLibraries=new Set<string>()
  let retiredLibraryEpoch = 0
  type AuthorityFact = { value: string | null; fingerprint: string }
  type MembershipFrame = { db: DatabaseSync; point: LocalAlbumScanPoint | null; transaction: boolean; sourceAuthor: object | null; sourceRevision: string | null; authors: readonly unknown[] }
  type MembershipFact = { value: string; authority: string; rootId: string; sourceRootId: string; rootRevision: string; directory: string; encoded: number; estimated: number }
  type MembershipCache = { frame: MembershipFrame; organizations: string; entries: Map<string, MembershipFact>; encoded: number; estimated: number }
  // 仅保留成功冷核的摘要和直属物理目录；不保存来源许可、图片、负结果或完整详情。
  const membershipLimit = { tuples: 16_384, encoded: 4 * 1024 * 1024, estimated: 16 * 1024 * 1024 }
  let membershipCache: MembershipCache | undefined
  type InventoryScope = { organizations: readonly LocalAlbumLibraryOrganization[]; organizationMap: Map<string, LocalAlbumLibraryOrganization>; authorities: Map<string, AuthorityFact>;
    membership: Map<string, string | null>; cached: Map<string, 'available' | 'missing' | null>; persisted: Map<string, 'available' | 'missing' | null>; retiredEpoch: number; invalid: boolean; retained?: MembershipCache;
    guardCurrent: () => void; guardActive: (() => void) | undefined; frame?: MembershipFrame }
  let inventoryScope: InventoryScope | undefined
  const active = new Map<string, { libraryId:string; abort: AbortController; task: Promise<LocalAlbumArtworkSources> }>()
  const permitReleases = new Map<string, Promise<boolean>>()
  type SourceWaiter = { foreground: boolean; grant(): void; stop(): void }
  const sourceQueue: SourceWaiter[] = []
  let sourceActive = 0
  let closed = false, fatal = false
  const check = (): void => { options.assertCurrent(); if (closed || fatal) throw new Error('专辑封面读取已停止。') }
  const inventoryChanged = (): never => { if (inventoryScope) inventoryScope.invalid = true; throw new LocalAlbumReadError('SNAPSHOT_CHANGED', '封面库存或来源授权已变化，请重新读取。') }
  function checkInventory(): void {
    const current = inventoryScope
    if (current && (current.guardCurrent !== options.assertCurrent || current.guardActive !== options.assertReadActive)) return inventoryChanged()
    // 仅本次同步纯库存读省去每组重复的文件身份检查；跨线程撤销与本地停止/退役仍立即检查。
    // 显式事务、未安装原撤销闩的旧作者及scope外调用保持原完整check，不取得文件或源写许可。
    if (current?.guardActive && current.frame && !current.frame.transaction && !current.frame.db.isTransaction) {
      current.guardActive()
      if (closed || fatal) throw new Error('专辑封面读取已停止。')
    } else check()
    if (current && (current.invalid || current.retiredEpoch !== retiredLibraryEpoch)) inventoryChanged()
  }
  const tupleKey = (request: dto.LocalAlbumArtworkRequest): string => JSON.stringify([options.datasetId, request.rootId, request.albumKey, request.editionId, request.representativeTrackId])
  function membershipFrame(): MembershipFrame {
    return catalog.privateRead(db => {
      const source = sourceWritesProjectionForDatabase(db)
      return { db, point: localAlbumScanPoint(db), transaction: db.isTransaction, sourceAuthor: source?.fullRaw ?? null, sourceRevision: source?.fingerprint ?? null,
        authors: [catalog.privateRead, catalog.trackDetail, catalog.privateAssetLocator, catalog.root] }
    })
  }
  const sameMembershipAuthor = (before: MembershipFrame, after: MembershipFrame): boolean => before.db === after.db && before.transaction === after.transaction
    && before.sourceAuthor === after.sourceAuthor && before.sourceRevision === after.sourceRevision && before.authors.every((value, index) => value === after.authors[index])
  const sameMembershipPoint = (before: MembershipFrame, after: MembershipFrame): boolean => sameMembershipAuthor(before, after)
    && before.point?.changes === after.point?.changes && before.point?.version === after.point?.version && before.point?.schema === after.point?.schema
  function retainedMembership(frame: MembershipFrame, organizations: readonly LocalAlbumLibraryOrganization[]): MembershipCache | undefined {
    if (frame.transaction || !frame.point || !frame.sourceAuthor || !frame.sourceRevision) { membershipCache = undefined; return undefined }
    const organizationKey = hash(organizations), previous = membershipCache
    const current: MembershipCache = { frame, organizations: organizationKey, entries: new Map(), encoded: 0, estimated: 0 }
    if (!previous || previous.organizations !== organizationKey || !previous.frame.point || !sameMembershipAuthor(previous.frame, frame)) return current
    const delta = localAlbumScanPath(frame.db, previous.frame.point, frame.point)
    // 原membership只取audio/catalog事实，不含CUE字段；原已核写集仍覆盖每个audio item及侧车/引用直属目录。
    // 因而CUE也只剔脏目录，无需复用SQL的派生分组闭包；缺链绝不把后缀当完整证明。
    if (!delta) return current
    const dirty = new Map<string, { sourceRootId: string; rootRevision: string; directories: Set<string> }>()
    for (const item of delta.directories) {
      const old = dirty.get(item.rootId)
      if (old && (old.sourceRootId !== item.sourceRootId || old.rootRevision !== item.rootRevision)) return current
      const entry = old ?? { sourceRootId: item.sourceRootId, rootRevision: item.rootRevision, directories: new Set<string>() }
      entry.directories.add(item.directory); dirty.set(item.rootId, entry)
    }
    for (const [key, entry] of previous.entries) {
      const changed = dirty.get(entry.rootId)
      if (changed && (changed.sourceRootId !== entry.sourceRootId || changed.rootRevision !== entry.rootRevision || changed.directories.has(entry.directory))) continue
      current.entries.set(key, entry); current.encoded += entry.encoded; current.estimated += entry.estimated
    }
    return current
  }
  function forgetMembership(current: MembershipCache, key: string): void {
    const saved = current.entries.get(key)
    if (saved) { current.entries.delete(key); current.encoded -= saved.encoded; current.estimated -= saved.estimated }
  }
  /** 资源/授权memo只属于同步回调；成员摘要须有同连接连续物理证明，且末屏障成功才发布。 */
  function withInventoryRead<T>(read: () => T): T {
    check()
    if (inventoryScope) return inventoryChanged()
    const epoch = retiredLibraryEpoch, organizations = structuredClone(options.readLibraryOrganizations?.() ?? [])
    const organizationMap = new Map<string, LocalAlbumLibraryOrganization>()
    for (const item of organizations) if (!organizationMap.has(item.rootId)) organizationMap.set(item.rootId, item)
    const current: InventoryScope = { organizations, organizationMap, authorities: new Map(), membership: new Map(), cached: new Map(), persisted: new Map(), retiredEpoch: epoch, invalid: false,
      guardCurrent: options.assertCurrent, guardActive: options.assertReadActive }
    inventoryScope = current
    const action = (): T => {
      const result = read()
      if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') return inventoryChanged()
      checkInventory()
      // 末端必须实读组织表与每个根的完整本地授权事实，不从operation memo回读。
      const latest = options.readLibraryOrganizations?.() ?? []
      if (!same(current.organizations, latest)) return inventoryChanged()
      const latestMap = new Map<string, LocalAlbumLibraryOrganization>()
      for (const item of latest) if (!latestMap.has(item.rootId)) latestMap.set(item.rootId, item)
      for (const [rootId, before] of current.authorities) if (!same(before, readAuthority(rootId, latestMap))) return inventoryChanged()
      checkInventory()
      return result
    }
    try {
      const before = membershipFrame(), retained = retainedMembership(before, organizations)
      current.frame = before
      if (retained) current.retained = retained
      const store = options.repository.privateLocalAlbumArtworkResources
      const result = store ? store.withInventoryRead(action) : action()
      // 包含资源库末端真实inspect之后再核主库；失败scope不能发布部分新摘要。
      checkInventory()
      const after = membershipFrame()
      if (!sameMembershipPoint(before, after)) return inventoryChanged()
      // 资源末inspect与主库末水位均完成后，强制实核Dataset身份，再查撤销/退役才发布摘要。
      check(); checkInventory()
      membershipCache = retained
      return result
    } catch (error) {
      membershipCache = undefined
      if (error instanceof LocalAlbumArtworkResourceError && error.code === 'ARTWORK_INVENTORY_CHANGED') return inventoryChanged()
      throw error
    } finally { current.authorities.clear(); current.membership.clear(); current.cached.clear(); current.persisted.clear(); inventoryScope = undefined }
  }
  function locate(target: ReadContext) {
    check()
    const { request, context } = target, { album, representative, directory } = context
    if (!dto.isLocalAlbumArtworkRequest(request) || !dto.isLocalAlbumSummary(album)
      || request.albumKey !== album.id || request.rootId !== album.rootId || request.revision !== album.revision
      || request.editionId !== album.editionId || request.representativeTrackId !== album.representativeTrackId
      || directory !== null && !isLocalAlbumPrivateRelative(directory, true)) throw new Error('专辑封面身份无效。')
    if(retiredLibraries.has(album.rootId)||!catalog.privateLibraryManagementRootAvailable(album.rootId))throw new Error('原库专辑封面读取已撤销。')
    const root = catalog.root(album.rootId), capability = options.repository.sources.root(root.sourceRootId)
    if (representative) {
      const detail = catalog.trackDetail(representative.summary.track.id), locator = catalog.privateAssetLocator(detail.asset.id)
      if (!same(detail.track, representative.summary.track) || !same(detail.asset, representative.summary.asset)
        || !same(detail.metadata.raw, representative.rawMetadata) || !same(detail.metadata.effective, representative.summary.metadata)
        || locator.relative !== representative.relative || detail.asset.libraryRootId !== root.id
        || detail.asset.sourceRootId !== capability.id || detail.asset.rootRevision !== root.revision) throw new Error('专辑封面来源已改变。')
      return { root, capability, relative: locator.relative, directory: directory ?? path.posix.dirname(locator.relative) }
    }
    if (album.trackCount !== 0 || album.representativeTrackId !== null || directory === null) throw new Error('专辑目录来源不可读取。')
    return { root, capability, relative: null, directory: directory || '.' }
  }
  // 版本覆盖图源优先级、嵌入解析及Main规范化；这些规则变化必须同步更新。
  function displayCacheKey(target: ReadContext, value: ReturnType<typeof locate>): string | null {
    if (!options.repository.privateLocalAlbumDisplayCache || !dto.isCollectionId(options.datasetId)
      || !/^[a-f0-9]{64}$/u.test(target.context.artworkSourceRevision ?? '')) return null
    return hash(['local-album-display-rust-grid-v3', options.datasetId, target.context.artworkSourceRevision, value.root, value.capability,
      target.request.albumKey, target.request.rootId, target.request.editionId, target.request.representativeTrackId, value.directory])
  }
  function readAuthority(rootId: string, organizations?: ReadonlyMap<string, LocalAlbumLibraryOrganization>): AuthorityFact {
    check()
    if (retiredLibraries.has(rootId) || !catalog.privateLibraryManagementRootAvailable(rootId)) return { value: null, fingerprint: hash([false]) }
    const root = catalog.root(rootId), capability = options.repository.sources.root(root.sourceRootId)
    const organization = organizations ? organizations.get(rootId) : options.readLibraryOrganizations?.().find(item => item.rootId === rootId)
    return { value: capability.authorized ? hash(['local-album-resource-authority-v1', root.id, root.sourceRootId, root.revision, capability.id, capability.path, capability.dev, capability.ino,
      organization ? [organization.sourceRootId, organization.rootRevision, organization.role, organization.bindingRevision, organization.recordSha256] : null]) : null,
      fingerprint: hash([true, root, capability]) }
  }
  function authority(rootId: string): string | null {
    checkInventory()
    if (retiredLibraries.has(rootId)) return null
    const current = inventoryScope, saved = current?.authorities.get(rootId)
    if (saved) return saved.value
    const fact = readAuthority(rootId, current?.organizationMap)
    if (current && current.authorities.size < 100) current.authorities.set(rootId, fact)
    return fact.value
  }
  function membership(request: dto.LocalAlbumArtworkRequest): string | null {
    checkInventory()
    const current = inventoryScope, key = tupleKey(request)
    if (current?.membership.has(key)) return current.membership.get(key)!
    const retained = current?.retained, saved = retained?.entries.get(key)
    // authority仍由本scope首端真实读取，并在末端重新读取；摘要不带入上一操作的许可。
    if (saved && saved.authority === authority(request.rootId)) {
      if (current && current.membership.size < 100_000) current.membership.set(key, saved.value)
      return saved.value
    }
    if (retained && saved) forgetMembership(retained, key)
    const value = readMembership(request)
    if (current && current.membership.size < 100_000) current.membership.set(key, value)
    return value
  }
  function readMembership(request: dto.LocalAlbumArtworkRequest): string | null {
    if (!request.representativeTrackId) return hash(['empty-album', request.albumKey])
    const detail = catalog.trackDetail(request.representativeTrackId), locator = catalog.privateAssetLocator(detail.asset.id), root = catalog.root(request.rootId)
    if (detail.asset.libraryRootId !== request.rootId || detail.asset.sourceRootId !== root.sourceRootId || detail.asset.rootRevision !== root.revision
      || request.editionId === null && detail.editions.length > 0 || request.editionId !== null && !detail.editions.some(edition => edition.id === request.editionId)) return null
    const versions = [...new Set(detail.versionTokens.filter(token => token.source === 'album' && (token.kind === 'edition' || token.kind === 'format')).map(token => token.raw))].sort()
    const value = hash(['album-membership-v1', detail.track.id, detail.track.assetId, locator.relative, detail.asset.locationRevision,
      request.editionId, detail.metadata.raw.album?.trim() ?? '', versions])
    const current = inventoryScope, retained = current?.retained, organization = current?.organizationMap.get(request.rootId)
    if (retained && request.editionId === null && detail.editions.length === 0 && root.role === 'library' && isLocalAlbumPrivateRelative(locator.relative)
      && (!organization || organization.role === 'catalog' && organization.datasetId === options.datasetId && organization.sourceRootId === root.sourceRootId && organization.rootRevision === root.revision)) {
      const directory = locator.relative.includes('/') ? locator.relative.slice(0, locator.relative.lastIndexOf('/')) : ''
      // 精确复用原SQL的null/catalog分组公式；版本词来自原详情的title→artist→album共64项预算。
      const albumKey = `directory-${hash([request.rootId, directory, directory === '' ? '' : detail.metadata.raw.album?.trim() ?? '', directory === '' ? [] : versions])}`
      const currentAuthority = authority(request.rootId)
      if (request.albumKey === albumKey && currentAuthority) {
        const key = tupleKey(request), encoded = Buffer.byteLength(JSON.stringify([key, value, currentAuthority, root.id, root.sourceRootId, root.revision, directory]))
        const estimated = encoded * 4 + 384
        forgetMembership(retained, key)
        if (retained.entries.size < membershipLimit.tuples && retained.encoded + encoded <= membershipLimit.encoded && retained.estimated + estimated <= membershipLimit.estimated) {
          retained.entries.set(key, { value, authority: currentAuthority, rootId: root.id, sourceRootId: root.sourceRootId, rootRevision: root.revision, directory, encoded, estimated })
          retained.encoded += encoded; retained.estimated += estimated
        }
      }
    }
    return value
  }
  function resourceBinding(request: dto.LocalAlbumArtworkRequest): LocalAlbumArtworkResourceBinding | null {
    if (!dto.isLocalAlbumArtworkRequest(request) || !dto.isCollectionId(options.datasetId)) return null
    const current = authority(request.rootId), identity = current ? membership(request) : null
    return current && identity ? { datasetId: options.datasetId, rootId: request.rootId, albumKey: request.albumKey, authority: current, membership: identity,
      editionId: request.editionId, representativeTrackId: request.representativeTrackId } : null
  }
  /** 旧请求、已撤权或已解绑成员只失去缓存资格；Owner生命周期错误仍向上抛。 */
  function cachedBinding(request: dto.LocalAlbumArtworkRequest): LocalAlbumArtworkResourceBinding | null {
    try { return resourceBinding(request) } catch { check(); return null }
  }
  function selectedIdentity(request: dto.LocalAlbumArtworkRequest): { authority: string; membership: string } | null {
    try {
      const current = authority(request.rootId), member = current ? membership(request) : null
      return current && member ? { authority: current, membership: member } : null
    } catch { check(); return null }
  }
  /** 主库选图本身就是持久副本；专辑派生身份、真实成员和本地授权必须同时成立。 */
  function selectedArtwork(request: dto.LocalAlbumArtworkRequest): { state: 'ready'; image: dto.LocalArtworkImage } | { state: 'invalid' } | null {
    if (!dto.isLocalAlbumArtworkRequest(request) || !request.editionId || !request.representativeTrackId
      || request.albumKey !== `edition-${hash([request.rootId, request.editionId])}`) return null
    const identity = selectedIdentity(request)
    if (!identity) return null
    const key = hash([request.rootId, request.albumKey])
    try {
      const context = options.repository.localArtwork.context({ trackId: request.representativeTrackId, editionId: request.editionId })
      if (!dto.isLocalArtworkContext(context) || context.trackId !== request.representativeTrackId
        || context.target?.editionId !== request.editionId) throw new LocalAlbumArtworkResourceError('ARTWORK_RECORD_INVALID')
      check(); if (!same(identity, selectedIdentity(request))) return null
      const candidate = context.selection?.candidate
      invalidSelections.delete(key)
      if (!candidate) return null
      const image = { original: structuredClone(candidate.original), display: structuredClone(candidate.display) }
      if (!dto.isLocalArtworkImage(image)) throw new LocalAlbumArtworkResourceError('ARTWORK_RECORD_INVALID')
      return { state: 'ready', image }
    } catch {
      check(); if (!same(identity, selectedIdentity(request))) return null
      if (!invalidSelections.has(key)) {
        if (invalidSelections.size >= 4096) invalidSelections.delete(invalidSelections.values().next().value!)
        invalidSelections.add(key); invalidRevision++
        logLibraryOperation('cache', 'artwork.selection-invalid', 'miss', { id: key, code: 'ARTWORK_RECORD_INVALID' })
      }
      return { state: 'invalid' }
    }
  }
  const resourceIdentity = (rootId: string, albumKey: string): string => hash([options.datasetId, rootId, albumKey])
  function localResource<T>(rootId: string, albumKey: string, read: () => T): T | null {
    const identity = resourceIdentity(rootId, albumKey)
    if (invalidResources.has(identity)) return null
    try { return read() }
    catch (error) {
      if (!(error instanceof LocalAlbumArtworkResourceError) || error.code !== 'ARTWORK_RECORD_INVALID') throw error
      if (invalidResources.size < 100_000) { invalidResources.add(identity); invalidRevision++ }
      logLibraryOperation('cache', 'artwork.resource-invalid', 'miss', { id: identity, code: error.code })
      return null
    }
  }
  function legacyDiscNegativeNeedsProbe(request: dto.LocalAlbumArtworkRequest, binding: LocalAlbumArtworkResourceBinding,
    entry: { binding: LocalAlbumArtworkResourceBinding; state: 'available' | 'missing'; legacyDiscAudioRelative?: string }): boolean {
    if (entry.state !== 'missing' || !entry.legacyDiscAudioRelative || request.editionId !== null || !request.representativeTrackId
      || !same(entry.binding, binding)) return false
    const organization = inventoryScope ? inventoryScope.organizationMap.get(request.rootId) : options.readLibraryOrganizations?.().find(item => item.rootId === request.rootId)
    // 仅表示旧发现策略需要沿原完整读口再判定；不读取详情、不证明父目录、更不赋予Source许可。
    return !organization || organization.role === 'catalog' && organization.datasetId === options.datasetId && organization.rootId === request.rootId
  }
  function needsDiscParentReprobe(request: dto.LocalAlbumArtworkRequest): boolean {
    checkInventory()
    if (!dto.isLocalAlbumArtworkRequest(request) || request.refresh === true || !dto.isCollectionId(options.datasetId)) return false
    const store = options.repository.privateLocalAlbumArtworkResources
    if (!store) return false
    // available和普通negative只查原轻量元组，不为此预检新增逐张catalog详情读取。
    const entry = localResource(request.rootId, request.albumKey, () => store.lookup(options.datasetId!, request.rootId, request.albumKey))
    if (entry?.state !== 'missing' || !entry.legacyDiscAudioRelative) return false
    const binding = cachedBinding(request)
    return !!binding && legacyDiscNegativeNeedsProbe(request, binding, entry)
  }
  /** 只核本地授权与已持久绑定；临时离线不使已验证资源失效。 */
  function readCached(request: dto.LocalAlbumArtworkRequest, allowEmpty = false): LocalAlbumArtworkReadResult | null {
    check()
    if (!dto.isLocalAlbumArtworkRequest(request) || request.refresh === true || request.representativeTrackId === null && !allowEmpty) return null
    const selected = selectedArtwork(request)
    if (selected) return selected.state === 'ready' ? { image: selected.image, status: 'ready' } : null
    const binding = cachedBinding(request), store = options.repository.privateLocalAlbumArtworkResources
    if (!binding || !store) return null
    const mapped = localResource(binding.rootId, binding.albumKey, () => store.lookup(binding.datasetId, binding.rootId, binding.albumKey))
    if (!mapped || !same(mapped.binding, binding) || legacyDiscNegativeNeedsProbe(request, binding, mapped)) return null
    const saved = localResource(binding.rootId, binding.albumKey, () => store.get(binding))
    if (!saved) return null
    check(); if (authority(request.rootId) !== binding.authority) return null
    return { image: saved.record?.image ?? null, status: 'ready', ...(saved.record?.grid ? { grid: saved.record.grid } : {}) }
  }
  function save(target: ReadContext, record: LocalAlbumDisplayCacheRecord | { image: null; evidence: LocalAlbumDisplayCacheEvidence }, seal: () => void): void {
    const binding = resourceBinding(target.request), store = options.repository.privateLocalAlbumArtworkResources
    if (!binding || !store) throw new LocalAlbumArtworkResourceError('ARTWORK_STORE_UNAVAILABLE')
    store.put(binding, record, () => { check(); seal(); locate(target); if (!same(resourceBinding(target.request), binding)) throw new LocalAlbumArtworkResourceError('ARTWORK_ROOT_RETIRED') })
    invalidResources.delete(resourceIdentity(binding.rootId, binding.albumKey))
  }
  function migrateLegacy(target: ReadContext, value: ReturnType<typeof locate>): LocalAlbumArtworkSources | null {
    const legacy = options.repository.privateLocalAlbumDisplayCache
    if (!legacy || target.request.refresh) return null
    const key = displayCacheKey(target, value)
    let record = key ? legacy.get(key, value.root.id) : null
    if (!record && value.relative && target.context.representative) {
      const state = options.repository.localScan.privateCurrentFileState(value.root.id, value.relative)?.value
      if (state?.outcome === 'accepted' && state.assetId === target.context.representative.summary.asset.id
        && state.trackId === target.context.representative.summary.track.id) record = legacy.findTrusted(value.root.id, { relative: value.relative, signature: state.signature, directory: value.directory })
    }
    if (!record) return null
    const started = performance.now()
    save(target, record, () => {})
    const result: LocalAlbumArtworkSources = { image: record.image, ...(record.grid ? { grid: record.grid } : {}), copies: { status: 'ready', items: [] } }
    persisted.add(result)
    logLibraryOperation('cache', 'artwork.resource-migrate', 'complete', { id: record.image.display.sha256, elapsedMs: performance.now() - started, bytes: record.image.display.bytes + (record.grid?.bytes ?? 0), slowAfterMs: 50 })
    return result
  }
  async function revalidateCapture(captured: Capture, readCurrent?: () => void): Promise<void> {
    check(); readCurrent?.()
    if (captured.expires <= Date.now()) throw new Error('封面捕获已过期，请重新读取。')
    const current = locate(captured.target)
    if (!same(current.capability, captured.root) || await sourceRootAvailability(current.capability) !== 'ONLINE') throw new Error('封面来源许可或目录已改变。')
    check(); readCurrent?.()
    const observed = await readonlySourceCandidateMetadata(current.capability, captured.relative)
    check(); readCurrent?.(); if (observed.signature !== captured.signature) throw new Error('封面来源文件已改变。')
  }
  async function revalidate(sourceIdentity: string): Promise<void> {
    check()
    const captured = captures.get(sourceIdentity)
    if (!captured) throw new Error('封面捕获已过期，请重新读取。')
    await revalidateCapture(captured)
  }
  /** 只等本实例实际释放一次；不轮询其它读者、不增加许可或延长原请求期限。 */
  async function waitForPermitRelease(signal: AbortSignal, deadlineAtMs: number): Promise<boolean> {
    check()
    const releases = [...permitReleases.values()]
    if (!releases.length || signal.aborted || performance.now() >= deadlineAtMs) return false
    return new Promise<boolean>(resolve => {
      let settled = false
      const finish = (released: boolean): void => {
        if (settled) return
        settled = true; clearTimeout(timer); signal.removeEventListener('abort', stop)
        resolve(released && !signal.aborted && performance.now() < deadlineAtMs)
      }
      const stop = (): void => finish(false)
      const timer = setTimeout(stop, Math.max(1, Math.ceil(deadlineAtMs - performance.now())))
      signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop()
      void Promise.race(releases).then(finish, stop)
    })
  }
  async function read(target: ReadContext, signal: AbortSignal, readDeadlineAtMs: number, mode: ReadMode): Promise<LocalAlbumArtworkSources> {
    const value = locate(target), empty = (): LocalAlbumArtworkSources => ({ image: null, copies: { status: 'source-unavailable', items: [] } })
    if (signal.aborted || performance.now() >= readDeadlineAtMs) return empty()
    const selected = selectedArtwork(target.request)
    if (selected) {
      if (selected.state === 'invalid') throw new LocalAlbumArtworkResourceError('ARTWORK_RECORD_INVALID')
      check(); locate(target); if (signal.aborted || performance.now() >= readDeadlineAtMs) throw new Error('专辑封面读取已取消或超时。')
      return { image: selected.image, copies: { status: 'ready', items: [] } }
    }
    if (mode !== 'candidate') { const legacy = migrateLegacy(target, value); if (legacy) return legacy }
    const projection = options.projection
    if (!projection || signal.aborted) return empty()
    const online = await sourceRootAvailability(value.capability) === 'ONLINE'
    if (!online) return empty()
    if (signal.aborted || performance.now() >= readDeadlineAtMs) return empty()
    let acquired = await projection.call('scanReadAcquire', mode === 'display' ? { purpose: 'local-album-display' } : {}, { signal, deadlineAtMs: readDeadlineAtMs })
    if (acquired.status === 'granted') notePermitTrace('localAlbum.artwork.permit-granted')
    else if (acquired.status === 'deferred') notePermitTrace('localAlbum.artwork.permit-deferred')
    if (acquired.status !== 'granted') {
      const released = await waitForPermitRelease(signal, readDeadlineAtMs)
      check(); const current = locate(target)
      if (!same(current.root, value.root) || !same(current.capability, value.capability)
        || current.relative !== value.relative || current.directory !== value.directory) throw new Error('等候期间封面来源已改变。')
      if (!released || signal.aborted || performance.now() >= readDeadlineAtMs
        || await sourceRootAvailability(value.capability) !== 'ONLINE') {
        notePermitTrace('localAlbum.artwork.no-permit-unavailable'); return empty()
      }
      check(); locate(target)
      if (signal.aborted || performance.now() >= readDeadlineAtMs) {
        notePermitTrace('localAlbum.artwork.no-permit-unavailable'); return empty()
      }
      acquired = await projection.call('scanReadAcquire', mode === 'display' ? { purpose: 'local-album-display' } : {}, { signal, deadlineAtMs: readDeadlineAtMs })
      if (acquired.status === 'granted') notePermitTrace('localAlbum.artwork.permit-granted')
      else if (acquired.status === 'deferred') notePermitTrace('localAlbum.artwork.permit-deferred')
      if (acquired.status !== 'granted') { check(); notePermitTrace('localAlbum.artwork.no-permit-unavailable'); return empty() }
    }
    const permit = acquired
    let finishPermit!: (released: boolean) => void
    permitReleases.set(permit.permitId, new Promise<boolean>(resolve => { finishPermit = resolve }))
    const abort = new AbortController(), forward = (): void => abort.abort()
    signal.addEventListener('abort', forward, { once: true }); if (signal.aborted || performance.now() >= readDeadlineAtMs) forward()
    let finished = false, leaseFailed = false, watchFailed = false
    const watch = (async () => { while (!finished) { const result = await projection.call('scanReadWatchRevocation', { permitId: permit.permitId });
      if (result.reason === 'renew') continue
      if (result.reason !== 'permit-released') abort.abort()
      break
    } })().catch(() => { watchFailed = true; abort.abort() })
    const deadline = Date.now() + 10_000, items: dto.LocalArtworkSourceCopies['items'] = [], pendingCaptures = new Map<string, Capture>()
    const sourceStarted = performance.now()
    const displayKey = mode !== 'candidate' ? displayCacheKey(target, value) ?? hash(['artwork-resource', target.request.rootId, target.request.albumKey]) : null
    const traceKey = desktopArtworkKey(JSON.stringify([target.request.albumKey, target.request.rootId, target.request.editionId, target.request.representativeTrackId, target.request.revision]))
    let cacheProofComplete = true
    const independentProof: LocalAlbumDisplayCacheEvidence['independent'][number][] = []
    let embeddedProof: LocalAlbumDisplayCacheEvidence['embedded'] = null
    let result!: LocalAlbumArtworkSources
    const alive = (): void => { check(); locate(target); if (abort.signal.aborted || signal.aborted || performance.now() >= readDeadlineAtMs || Date.now() > deadline) throw new Error('专辑封面读取已取消或超时。') }
    let total = 0, embeddedConfirmed = value.relative === null, independentUnresolved = false
    const independentIssues = new Set<LocalArtworkDiscoveryIssue>()
    let resolvedImage: dto.LocalArtworkImage | undefined, resolvedGrid: dto.LocalAlbumArtworkGrid | undefined
    const remember = (bytes: Uint8Array, relative: string, signature: string, origin: 'local-independent' | 'embedded', label: string, index: number): void => {
      alive()
      if (!bytes.length || bytes.length > dto.LOCAL_ARTWORK_INPUT_BYTES || total + bytes.length > 8 * 1024 * 1024 || items.length >= 4) return
      if (mode === 'candidate') for (const [key, entry] of captures) if (entry.expires <= Date.now()) captures.delete(key)
      const digest = createHash('sha256').update(bytes).digest('hex')
      const sourceIdentity = hash([target.request, value.root, relative, signature, origin, index, digest])
      const additions = [...pendingCaptures.keys()].filter(key => !captures.has(key)).length
      if (mode === 'candidate' && !captures.has(sourceIdentity) && !pendingCaptures.has(sourceIdentity) && captures.size + additions >= 64) throw new Error('封面来源缓存已满，请稍后重新查找。')
      const captured = { target: structuredClone(target), root: value.capability, relative, signature, expires: Date.now() + 10 * 60_000 }, base64 = Buffer.from(bytes).toString('base64')
      alive(); pendingCaptures.set(sourceIdentity, captured)
      total += bytes.length; items.push({ origin, sourceIdentity, sourceLabel: label, base64 })
    }
    try {
      logLibraryOperation('cache', 'artwork.display', 'miss')
      if (mode !== 'candidate') noteDesktopArtwork('disk-miss', traceKey, { reason: 'not-found' })
      const independentSignatures = new Set<string>()
      const readIndependent = async (directory: string, preferredOnly = false): Promise<void> => {
        for await (const file of readonlyLocalArtworkCandidateNames({ root: value.capability, directory, ...(preferredOnly ? { preferredOnly: true as const } : {}), signal: abort.signal,
          deadlineMs: Math.min(deadline, Date.now() + Math.max(0, readDeadlineAtMs - performance.now())), assertCurrent: alive,
          hasCandidateSlot: () => items.length < (mode !== 'candidate' ? 1 : 2), unresolved: code => {
            independentUnresolved = true; independentIssues.add(code)
            logLibraryOperation('artwork', 'independent.discovery', 'skipped', { code })
          } })) {
          alive(); if (items.length >= (mode !== 'candidate' ? 1 : 2)) break
          const relative = path.posix.join(directory, file)
          try {
            const observed = await readonlySourceCandidateMetadata(value.capability, relative); alive()
            const proof = { relative, signature: observed.signature, size: observed.size, included: false }
            if (independentProof.length < 32) independentProof.push(proof); else cacheProofComplete = false
            if (observed.size > dto.LOCAL_ARTWORK_INPUT_BYTES || independentSignatures.has(observed.signature)) continue
            const extractionStarted = desktopArtworkStarted()
            const bytes = await withCheckedReadonlyMetadataSource(value.capability, relative, observed.signature, abort.signal, async (fd, size) => {
              if (mode !== 'candidate') noteDesktopArtwork('source-extract', traceKey)
              const bytes = Buffer.alloc(size)
              for (let offset = 0; offset < size;) { alive(); const result = await fd.read(bytes, offset, Math.min(64 * 1024, size - offset), offset); alive()
                if (!result.bytesRead) throw new Error('封面来源被截断。'); offset += result.bytesRead }
              return bytes
            }, alive)
            if (mode !== 'candidate') noteDesktopArtwork('source-extract', traceKey, { count: 0, elapsedMs: desktopArtworkElapsed(extractionStarted), bytes: bytes.length })
            if (mode !== 'candidate') {
              const normalized = await normalizeLocalArtworkInWorker(bytes, abort.signal); alive()
              resolvedImage = normalized.image; resolvedGrid = normalized.grid
            }
            const previousCount = items.length
            remember(bytes, relative, observed.signature, 'local-independent', file, 0)
            if (items.length > previousCount) { independentSignatures.add(observed.signature); proof.included = true }
          } catch (error) { if (error instanceof LocalArtworkImageError || error instanceof SourceFileError && error.code === 'MISSING') continue; throw error }
        }
      }
      await readIndependent(value.directory)
      const physicalDirectory = value.relative ? path.posix.dirname(value.relative) : null
      const parentDirectory = target.context.directory !== null && physicalDirectory !== null
        && (target.context.directory || '.') === physicalDirectory ? localArtworkDiscParentDirectory(physicalDirectory) : null
      // 明确CD自身独立图优先；完整无歧义后只探同Root父一级固定名，之后仍沿原embedded。
      if (!items.length && !independentUnresolved && parentDirectory !== null) await readIndependent(parentDirectory, true)
      // 目录封面完整解码成功后只核代表音频身份，不再读取其内嵌图。
      if (value.relative && mode !== 'candidate' && resolvedImage) {
        const observed = await readonlySourceCandidateMetadata(value.capability, value.relative); alive()
        embeddedProof = { relative: value.relative, signature: observed.signature, size: observed.size }
        logLibraryOperation('artwork', 'embedded.directory-hit', 'skipped')
      }
      if (value.relative && items.length < 4 && !(mode !== 'candidate' && resolvedImage)) {
        try {
          const observed = await readonlySourceCandidateMetadata(value.capability, value.relative); alive()
          embeddedProof = { relative: value.relative, signature: observed.signature, size: observed.size }
          const extractionStarted = desktopArtworkStarted()
          const pictures = await withCheckedReadonlyMetadataSource(value.capability, value.relative, observed.signature, abort.signal,
            (fd, size) => { if (mode !== 'candidate') noteDesktopArtwork('source-extract', traceKey); return readRustEmbeddedArtwork(fd, size, abort.signal) }, alive)
          if (mode !== 'candidate') noteDesktopArtwork('source-extract', traceKey, { count: 0, elapsedMs: desktopArtworkElapsed(extractionStarted) })
          embeddedConfirmed = true
          for (const picture of pictures) {
            if (mode !== 'candidate') {
              try { const normalized = await normalizeLocalArtworkInWorker(picture.bytes, abort.signal); alive(); resolvedImage = normalized.image; resolvedGrid = normalized.grid }
              catch (error) { if (error instanceof LocalArtworkImageError) continue; throw error }
            }
            remember(picture.bytes, value.relative, observed.signature, 'embedded', `内嵌图片 ${picture.pictureIndex + 1}`, picture.pictureIndex)
            if (mode !== 'candidate' && resolvedImage) break
          }
        } catch (error) {
          if (error instanceof MetadataLeaseReleaseError || error instanceof SourceFileError || abort.signal.aborted) throw error
          // 仅媒体解析失败可保留未知；基础设施和程序异常必须交回 Owner，不能伪装为缺图。
          if (!(error instanceof RustMediaWorkerError) || !['PARSE_FAILED', 'UNSUPPORTED', 'BUDGET_EXCEEDED'].includes(error.code)) throw error
          logLibraryOperation('artwork', 'embedded.unavailable', 'skipped', { code: error.code, elapsedMs: performance.now() - sourceStarted, slowAfterMs: 100 })
        }
      }
      for (const item of items) { alive(); await revalidateCapture(pendingCaptures.get(item.sourceIdentity)!, alive); alive() }
      alive(); result = { image: resolvedImage ?? null, ...(resolvedGrid ? { grid: resolvedGrid } : {}), copies: { status: items.length || (embeddedConfirmed && !independentUnresolved) ? 'ready' : 'source-unavailable', items } }
    } catch (error) {
      if (error instanceof MetadataLeaseReleaseError) { fatal = true; leaseFailed = true }
      throw error
    } finally {
      finished = true; signal.removeEventListener('abort', forward)
      if (!leaseFailed) {
        let released = false
        const quietStarted = performance.now()
        try { await projection.call('scanReadRelease', { permitId: permit.permitId }); await watch
          if (watchFailed) throw new Error('专辑封面许可收口未确认。')
          released = true
          logLibraryOperation('artwork', 'source.quiet', 'complete', { elapsedMs: performance.now() - quietStarted })
        } catch (error) { fatal = true; logLibraryOperation('artwork', 'source.quiet', 'error', { code: 'SOURCE_QUIET_FAILED', elapsedMs: performance.now() - quietStarted }); throw error }
        finally { if (released) permitReleases.delete(permit.permitId); finishPermit(released) }
      } else { finishPermit(false); void watch }
    }
    // 原FD与许可真正闭后再发布；截止到达不能把未完成捕获塞入共享来源缓存。
    alive()
    // 显示仍保本次完整来源回核；真实资源已闭后返回，既不触共享门槛也不发布/清理候选。
    if (mode !== 'candidate') {
      const independentOnly = items.length > 0 && items.every(item => item.origin === 'local-independent')
      // 完整枚举已证明原规则不选择这些非固定名图；只为实际读出并回核的内嵌图建立正证明。
      // 截断、IO、固定名歧义或多个原因不能借此通过；无图仍沿原未知分支，绝不写missing。
      const embeddedPositiveProof = independentIssues.size === 1 && independentIssues.has('NONPREFERRED_NAMES_AMBIGUOUS')
        && result.image !== null && embeddedConfirmed && embeddedProof !== null
        && items.length > 0 && items.every(item => item.origin === 'embedded')
      if (displayKey && cacheProofComplete && (!independentUnresolved || embeddedPositiveProof) && (embeddedConfirmed || independentOnly)) {
        displayProofs.set(result, { target: structuredClone(target), key: displayKey, deadline: readDeadlineAtMs,
          evidence: { independent: independentProof, embedded: embeddedProof, unresolved: false, embeddedConfirmed, independentOnly, discoveryPolicy: 'disc-parent-v1' } })
      }
      if (result.copies.status === 'ready') {
        const proof = displayProofs.get(result)
        if (!proof) {
          const code = !cacheProofComplete ? 'DISPLAY_PROOF_BUDGET' : independentIssues.size > 1 ? 'DISPLAY_PROOF_MULTIPLE_ISSUES'
            : independentIssues.has('DIRECTORY_UNAVAILABLE') ? 'DISPLAY_PROOF_DIRECTORY_UNAVAILABLE'
              : independentIssues.has('DIRECTORY_TRUNCATED') ? 'DISPLAY_PROOF_DIRECTORY_TRUNCATED'
                : independentIssues.has('PREFERRED_NAMES_AMBIGUOUS') ? 'DISPLAY_PROOF_PREFERRED_AMBIGUOUS'
                  : independentIssues.has('NONPREFERRED_NAMES_AMBIGUOUS') ? 'DISPLAY_PROOF_EMBEDDED_UNCONFIRMED'
                    : !displayKey ? 'DISPLAY_PROOF_KEY_UNAVAILABLE' : 'DISPLAY_PROOF_SOURCE_UNCONFIRMED'
          logLibraryOperation('cache', 'artwork.display-proof', 'miss', { code })
          throw new LocalAlbumArtworkResourceError('ARTWORK_RECORD_INVALID')
        }
        save(target, result.image ? { image: result.image, evidence: proof.evidence, ...(result.grid ? { grid: result.grid } : {}) } : { image: null, evidence: proof.evidence }, alive)
        persisted.add(result)
      }
      noteDesktopArtwork('source-read', traceKey, { count: 0, elapsedMs: desktopArtworkElapsed(sourceStarted), bytes: total })
      logLibraryOperation('artwork', 'source.read', 'complete', { elapsedMs: performance.now() - sourceStarted, bytes: total, count: items.length, slowAfterMs: 100 })
      return result
    }
    for (const [key, entry] of captures) if (entry.expires <= Date.now()) captures.delete(key)
    const additions = [...pendingCaptures.keys()].filter(key => !captures.has(key)).length
    if (captures.size + additions > 64) throw new Error('封面来源缓存已满，请稍后重新查找。')
    const previous = new Map([...pendingCaptures.keys()].map(key => [key, captures.get(key)] as const))
    try {
      alive()
      for (const [key, captured] of pendingCaptures) captures.set(key, captured)
      alive(); return result
    } catch (error) {
      // 此同步段没有await；只撤回本次尚未返回的发布，保留先前同来源捕获。
      for (const [key, captured] of previous) { if (captured) captures.set(key, captured); else captures.delete(key) }
      throw error
    }
  }
  function sourceSlot(signal: AbortSignal, deadlineAtMs: number, foreground: boolean): Promise<(() => void) | null> {
    if (signal.aborted || performance.now() >= deadlineAtMs) return Promise.resolve(null)
    if (sourceQueue.length >= 32) throw new RustMediaWorkerError('QUEUE_FULL')
    return new Promise(resolve => {
      let settled = false
      const cleanup = (): void => { clearTimeout(timer); signal.removeEventListener('abort', waiter.stop); const index = sourceQueue.indexOf(waiter); if (index >= 0) sourceQueue.splice(index, 1) }
      const waiter: SourceWaiter = {
        foreground,
        grant() {
          if (settled) return
          if (signal.aborted || performance.now() >= deadlineAtMs) { waiter.stop(); return }
          settled = true; cleanup(); sourceActive++
          let released = false
          resolve(() => {
            if (released) return
            released = true; sourceActive--
            while (sourceActive < 2 && sourceQueue.length) sourceQueue[0]!.grant()
          })
        },
        stop() { if (settled) return; settled = true; cleanup(); resolve(null) },
      }
      const timer = setTimeout(waiter.stop, Math.max(1, Math.ceil(deadlineAtMs - performance.now())))
      signal.addEventListener('abort', waiter.stop, { once: true })
      if (sourceActive < 2) waiter.grant()
      else { const background = foreground ? sourceQueue.findIndex(entry => !entry.foreground) : -1
        if (background >= 0) sourceQueue.splice(background, 0, waiter); else sourceQueue.push(waiter) }
      if (signal.aborted) waiter.stop()
    })
  }
  function readTask(target: ReadContext, lookupId: string, signal?: AbortSignal, deadlineAtMs?: number, mode: ReadMode = 'candidate'): Promise<LocalAlbumArtworkSources> {
    check(); if (!dto.isCollectionId(lookupId) || active.has(lookupId)) throw new Error('专辑封面读取身份无效。')
    if (!['candidate', 'display', 'background'].includes(mode)) throw new Error('专辑封面私有读取用途无效。')
    if (deadlineAtMs !== undefined && !Number.isFinite(deadlineAtMs)) throw new Error('封面读取原期限无效。')
    locate(target)
    if (mode === 'display') {
      const cached = readCached(target.request, true)
      if (cached) { const result = { image: cached.image, ...(cached.grid ? { grid: cached.grid } : {}), copies: { status: 'ready' as const, items: [] } }; persisted.add(result); return Promise.resolve(result) }
    }
    const acceptedAtMs = performance.now(), queueDeadline = Math.min(deadlineAtMs ?? acceptedAtMs + (mode === 'background' ? 10_000 : 2000), acceptedAtMs + (mode === 'background' ? 10_000 : 2000))
    const abort = new AbortController(), forward = (): void => abort.abort()
    signal?.addEventListener('abort', forward, { once: true }); if (signal?.aborted) forward()
    logLibraryOperation('artwork', 'album.read', 'start', { id: lookupId, active: sourceActive, pending: sourceQueue.length })
    const task = (async () => {
      const release = await sourceSlot(abort.signal, queueDeadline, mode !== 'background')
      if (!release) return { image: null, copies: { status: 'source-unavailable' as const, items: [] } }
      // 后台沿用 Owner 的十秒总期限余量；排队和源读取共用原绝对期限，前台仍是两秒。
      const started = performance.now(), readDeadline = mode === 'background' ? queueDeadline : Math.min(queueDeadline, started + 2000)
      const timer = setTimeout(forward, Math.max(1, Math.ceil(readDeadline - performance.now())))
      try {
        check(); locate(target)
        logLibraryOperation('artwork', 'source.queue', 'complete', { id: lookupId, queueWaitMs: started - acceptedAtMs, active: sourceActive, pending: sourceQueue.length })
        const result = await read(target, abort.signal, readDeadline, mode)
        if (abort.signal.aborted || performance.now() >= readDeadline) throw new Error('专辑封面读取已取消或超时。')
        return result
      } finally { clearTimeout(timer); release() }
    })().then(result => {
      logLibraryOperation('artwork', 'album.read', result.copies.status === 'source-unavailable' ? 'skipped' : 'complete', { id: lookupId, elapsedMs: performance.now() - acceptedAtMs,
        count: result.image ? 1 : result.copies.items.length, ...(result.copies.status === 'source-unavailable' ? { code: 'SOURCE_UNAVAILABLE' } : {}), slowAfterMs: 100 })
      return result
    }, error => {
      logLibraryOperation('artwork', 'album.read', abort.signal.aborted ? 'cancelled' : 'error', { id: lookupId, elapsedMs: performance.now() - acceptedAtMs,
        code: error instanceof RustMediaWorkerError || error instanceof LocalAlbumArtworkResourceError ? error.code : 'ARTWORK_READ_FAILED', slowAfterMs: 100 })
      throw error
    }).finally(() => { active.delete(lookupId); signal?.removeEventListener('abort', forward) })
    active.set(lookupId, { libraryId: target.request.rootId, abort, task }); return task
  }
  function readCachedState(albumKey: string, rootId: string, projected?: Readonly<LocalAlbumArtworkMembershipFact>): 'available' | 'missing' | null {
    checkInventory()
    if (!dto.isCollectionId(options.datasetId)) return null
    const store = options.repository.privateLocalAlbumArtworkResources
    if (!store || !authority(rootId)) return null
    const currentScope = inventoryScope, key = JSON.stringify([options.datasetId, rootId, albumKey])
    if (currentScope?.cached.has(key)) return currentScope.cached.get(key)!
    const remember = (state: 'available' | 'missing' | null): 'available' | 'missing' | null => { if (currentScope && currentScope.cached.size < 100_000) currentScope.cached.set(key, state); return state }
    const entry = localResource(rootId, albumKey, () => store.lookup(options.datasetId!, rootId, albumKey))
    if (!entry) return remember(null)
    // SQL当前代表与资源原代表精确相同才省membership读取；旧代表仍可能合法，错配必须走原完整核验。
    const currentAuthority = projected ? authority(rootId) : null
    const current = projected && projected.albumKey === albumKey && projected.rootId === rootId && projected.editionId === entry.binding.editionId
      && projected.representativeTrackId === entry.binding.representativeTrackId && currentAuthority
      ? { datasetId: options.datasetId!, rootId, albumKey, authority: currentAuthority, membership: projected.membership, editionId: projected.editionId, representativeTrackId: projected.representativeTrackId }
      : resourceBinding({ albumKey, rootId, editionId: entry.binding.editionId, representativeTrackId: entry.binding.representativeTrackId, revision: '0'.repeat(64) })
    return remember(current && same(current, entry.binding) && !legacyDiscNegativeNeedsProbe({ albumKey, rootId, editionId: entry.binding.editionId,
      representativeTrackId: entry.binding.representativeTrackId, revision: '0'.repeat(64) }, current, entry) ? entry.state : null)
  }
  return {
    withInventoryRead,
    readCached,
    needsDiscParentReprobe,
    /** 只核本地持久事实；主库选图与NAS派生资源不互相冒充来源证据。 */
    persistedState(request: dto.LocalAlbumArtworkRequest): 'available' | 'missing' | null {
      checkInventory()
      if (!dto.isLocalAlbumArtworkRequest(request)) return null
      const current = inventoryScope, key = tupleKey(request)
      if (current?.persisted.has(key)) return current.persisted.get(key)!
      const remember = (state: 'available' | 'missing' | null): 'available' | 'missing' | null => { if (current && current.persisted.size < 100_000) current.persisted.set(key, state); return state }
      const selected = selectedArtwork(request)
      if (selected) return remember(selected.state === 'ready' ? 'available' : null)
      const binding = cachedBinding(request), store = options.repository.privateLocalAlbumArtworkResources
      if (!binding || !store) return remember(null)
      const entry = localResource(binding.rootId, binding.albumKey, () => store.lookup(binding.datasetId, binding.rootId, binding.albumKey))
      checkInventory()
      return remember(entry && same(entry.binding, binding) && !legacyDiscNegativeNeedsProbe(request, binding, entry) && same(cachedBinding(request), binding) ? entry.state : null)
    },
    cachedState: readCachedState,
    cachedStateProjected(projection: LocalAlbumArtworkMembershipProjection): 'available' | 'missing' | null | undefined {
      checkInventory()
      const frame = inventoryScope?.frame
      if (!frame || frame.transaction || frame.db.isTransaction || !frame.point || !frame.sourceAuthor || !frame.sourceRevision) return undefined
      const projected = readLocalAlbumArtworkMembershipProjection(projection, undefined, frame.db, frame.point)
      return projected ? readCachedState(projected.albumKey, projected.rootId, projected) : undefined
    },
    cacheRevision(): string { check(); return `${options.repository.privateLocalAlbumArtworkResources?.revision() ?? '0'}:${invalidRevision}:${retiredLibraryEpoch}` },
    async readSources(target: ReadContext, lookupId: string, signal?: AbortSignal, deadlineAtMs?: number, mode: ReadMode = 'candidate'): Promise<LocalAlbumArtworkSources> { return readTask(target, lookupId, signal, deadlineAtMs, mode) },
    async retainDisplay(sources: LocalAlbumArtworkSources, image: dto.LocalArtworkImage, seal: () => void, grid?: dto.LocalAlbumArtworkGrid): Promise<boolean> {
      const proof = displayProofs.get(sources); displayProofs.delete(sources)
      if (persisted.has(sources)) { check(); if (proof) locate(proof.target); seal(); return true }
      if (!proof) { check(); seal(); return false }
      check(); locate(proof.target); seal()
      save(proof.target, { image, evidence: proof.evidence, ...(grid ? { grid } : {}) }, seal)
      persisted.add(sources); check(); seal(); return true
    },
    revalidate,
    cancel(lookupId: string) { active.get(lookupId)?.abort.abort() },
    async removeLibrary(libraryId:string){check();membershipCache=undefined;if(!retiredLibraries.has(libraryId)){retiredLibraries.add(libraryId);retiredLibraryEpoch++}const selected=[...active.values()].filter(value=>value.libraryId===libraryId)
      for(const entry of selected)entry.abort.abort();await Promise.allSettled(selected.map(entry=>entry.task))
      if(fatal)throw new Error('本库专辑封面许可关闭未确认，捕获继续保留。')
      for(const [key,capture]of captures)if(capture.target.request.rootId===libraryId)captures.delete(key)
      options.repository.privateLocalAlbumDisplayCache?.removeRoot(libraryId)
      options.repository.privateLocalAlbumArtworkResources?.removeRoot(libraryId)
    },
    async close() { closed = true; membershipCache = undefined; for (const entry of active.values()) entry.abort.abort()
      await Promise.allSettled([...active.values()].map(entry => entry.task))
      if (fatal) throw new Error('专辑封面资源关闭未确认，原工作库连接必须保留。')
      captures.clear()
    },
  }
}
