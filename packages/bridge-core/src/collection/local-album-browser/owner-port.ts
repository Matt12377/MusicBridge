import { createArtistIndexSqlWorker, createMobileSqlWorker, type MobileSqlWorkerOptions } from './mobile-sql-worker.js'
import type { MobileProjectionPage } from './mobile-structure.js'
import { catalogTraceEvent } from '../../mobile/catalog-private-trace.js'
import { localAlbumPhase, localAlbumMatch, localAlbumReject, emitLocalAlbumNodeTrace, captureLocalAlbumContext } from '../../shared/local-album-read-trace-node.js'
import type { LocalAlbumTraceStage } from '../../shared/library-read-trace.js'
import { readLocalAlbumArtworkMembershipProjection, type LocalAlbumArtworkMembershipProjection } from './artwork-membership-projection.js'
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import * as dto from '@music-bridge/contracts'
import type { CollectionRepository } from '../repository.js'
import { isLocalAlbumPrivateRelative, LocalAlbumReadError } from './grouping.js'
import type { LocalAlbumArtworkReadContext, LocalAlbumArtworkReadResult, LocalAlbumGroup, LocalAlbumInspectRequest, LocalAlbumIssue, LocalAlbumNameEnhancementFact } from './types.js'
import type { LocalAlbumArtworkInventory, LocalAlbumInventoryRead, LocalAlbumSqlArtworkObservation, LocalAlbumSqlMobileQuery, LocalAlbumSqlPort, LocalAlbumSqlScope, LocalAlbumLyricsInventory, LocalAlbumLibraryOrganization } from './sql-types.js'
import { MAX_LOCAL_ALBUM_ARTWORK_OBSERVATIONS } from './artwork-observation-store.js'
import { logLibraryOperation } from '../../shared/library-operation-log.js'
import { projectLocalAlbumArtworkReply } from './artwork-reply.js'
import { bindLocalAlbumScanScope, captureLocalAlbumQueueReader, continuesLocalAlbumQueueReader } from './scan-delta.js'
import { isLocalAlbumBackgroundCandidateQuery, isLocalAlbumBackgroundCandidatePage,
  type LocalAlbumBackgroundCandidateQuery, type LocalAlbumBackgroundCandidatePage } from './artwork-background-candidates.js'

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const changed = (): never => { throw new LocalAlbumReadError('SNAPSHOT_CHANGED', '来源或音乐库已变化，请重新读取。') }
const unavailable = (): never => { throw new LocalAlbumReadError('UNAVAILABLE', '本地专辑暂时无法读取，请重试。') }
const invalid = (): never => { throw new LocalAlbumReadError('INVALID_REQUEST', '本地专辑请求无效，请重新选择。') }
const overBudget = (): never => { throw new LocalAlbumReadError('CONTENT_LIMIT_EXCEEDED', '本专辑超过工作台计划捕获预算，本次未返回截断范围。') }
const opaque = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,255}$/u.test(value)
function closed(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && required.every(key => Object.hasOwn(value, key)) && Reflect.ownKeys(value).every(key => typeof key === 'string' && [...required, ...optional].includes(key)
      && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))
}
function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equal((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]))
}
function freeze<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }; return value }
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
function noteReadTiming(stage: LocalAlbumTraceStage, outcome: 'begin' | 'ok'): void {
  try {
    const context = captureLocalAlbumContext(); if (!context) return
    const previous = context.stage
    try { localAlbumPhase(stage); emitLocalAlbumNodeTrace(outcome) } finally { context.stage = previous }
  } catch { /* 私有计时旁注不能改变原业务或首拒绝阶段。 */ }
}

export interface LocalAlbumOwnerPortOptions {
  repository: CollectionRepository
  mobileSqlWorker?: MobileSqlWorkerOptions
  /** 只有原 DatasetIdentity 可提供，缺失时仅保留本进程事实。 */
  datasetId?: string
  assertCurrent(): void
  /** 同Owner只读查询的撤销检查，不授予Source能力。 */
  assertReadActive?(): void
  /** 每次公开操作前由原重定位作者实读；不能把 authorized 当作 ONLINE。 */
  readRootViews(): Promise<readonly dto.LocalRootView[]>
  readArtwork(request: dto.LocalAlbumArtworkRequest, context: LocalAlbumArtworkReadContext): Promise<LocalAlbumArtworkReadResult>
  /** 已落盘资源只核本地库身份；不要求音乐源在线，也不占源文件读取许可。 */
  readCachedArtwork?(request: dto.LocalAlbumArtworkRequest): LocalAlbumArtworkReadResult | null
  /** 默认资源与主库手选副本分别核实持久身份，不要求源目录在线。 */
  readPreparedArtwork?(request: dto.LocalAlbumArtworkRequest): boolean
  savedArtworkInventory?: { revision(): string; read(albumKey: string, rootId: string): 'available' | 'missing' | null; readProjected?(projection: LocalAlbumArtworkMembershipProjection): 'available' | 'missing' | null | undefined }
  /** 只包refresh后的同步库存读取；末核位于savedInventory逐项降级之外。 */
  withArtworkInventoryRead?: LocalAlbumInventoryRead
  /** 仅私有派生缓存；所有await后仍由原Owner重新seal，证明不进入公开reply。 */
  acceptArtwork?(request: dto.LocalAlbumArtworkRequest, context: LocalAlbumArtworkReadContext, result: LocalAlbumArtworkReadResult, seal: () => void): Promise<void>
  /** AI 实际结果作者提供；扫描拒绝、取消与未运行不能冒充名称增强失败。 */
  nameEnhancements?: { revision(): string; read(): readonly LocalAlbumNameEnhancementFact[] }
  lyricsInventory?: LocalAlbumLyricsInventory
  /** 当前DatasetIdentity下同SQL管理绑定；旧库无绑定时保持原组织。 */
  readLibraryOrganizations?(): readonly LocalAlbumLibraryOrganization[]
  /** 可在测试中收紧，不能超过原工作台10000成员/32MiB计划域。 */
  captureBudget?: { maxMembers: number; maxBytes: number }
}

/** 只存在于原 Owner 内，不进入 Renderer 或公开命令合同。 */
export interface LocalAlbumPrivateReadOptions { purpose?: 'background'; signal?: AbortSignal }

/** 使用原 guarded SQL 聚合/分页；128MiB约束缓存，合法30万轨道不变成全库DTO。 */
export function createLocalAlbumOwnerService(options: LocalAlbumOwnerPortOptions) {
  const catalog = options.repository.localCatalog, scan = options.repository.localScan, sql = catalog as typeof catalog & LocalAlbumSqlPort
  let queueAuditEpoch = Object.freeze({})
  const workerOptions = options.mobileSqlWorker ? { ...options.mobileSqlWorker, queueAudit: {
    capture: (scope: LocalAlbumSqlScope) => catalog.privateRead(db => captureLocalAlbumQueueReader(db, scope, queueAuditEpoch)),
    continues: (before: object, after: object) => catalog.privateRead(db => continuesLocalAlbumQueueReader(db, before, after)),
  } } : undefined
  const mobileSql = workerOptions ? createMobileSqlWorker(workerOptions) : undefined
  let views: readonly dto.LocalRootView[] | null = null, closedService = false, generation = 0, lastRevision: string | null = null, refreshing: Promise<void> | null = null
  const fences = new WeakMap<LocalAlbumSqlScope, number>(), scanScopeOwner = Object.freeze({})
  const observations = new Map<string, LocalAlbumSqlArtworkObservation>(), pending = new Map<string, LocalAlbumSqlArtworkObservation>()
  let observationSourceRevision: string | null = null, observationEpoch = 0, observationCount = 0
  let savedInventoryFailure: string | null = null
  const observationKey = (rootId: string, albumKey: string): string => JSON.stringify([rootId, albumKey])
  const datasetId = dto.isCollectionId(options.datasetId) ? options.datasetId : null
  // 单独的惰性 actor 不占原移动目录队列，也不加入启动 prepare；无持久组合的组件保留原同步读口。
  const indexSql = options.mobileSqlWorker && datasetId && options.lyricsInventory
    ? createArtistIndexSqlWorker(workerOptions!, datasetId) : undefined
  const withInventoryRead: LocalAlbumInventoryRead = read => {
    const artworkRead = () => options.withArtworkInventoryRead ? options.withArtworkInventoryRead(read) : read()
    // 歌词末核在资源最后inspect和主库末点之后；两个scope都只属于本次同步回调。
    return options.lyricsInventory?.withRead ? options.lyricsInventory.withRead(artworkRead) : artworkRead()
  }
  function savedInventory<T>(read: () => T, fallback: (code: string) => T): T {
    try { return read() } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null
      if (code !== 'ARTWORK_STORE_UNAVAILABLE' && code !== 'ARTWORK_RECORD_INVALID') throw error
      if (savedInventoryFailure !== code) {
        savedInventoryFailure = code
        logLibraryOperation('cache', 'artwork.inventory', 'error', { code })
      }
      // 派生资源损坏不能拖垮主音乐库；不把失败冒充已准备或缺图。
      return fallback(code)
    }
  }
  const readSavedState = (albumKey: string, rootId: string): 'available' | 'missing' | null =>
    savedInventory(() => options.savedArtworkInventory?.read(albumKey, rootId) ?? null, () => null)
  const inventory: LocalAlbumArtworkInventory = {
    revision: () => hash([observationSourceRevision, observationEpoch, savedInventory(() => options.savedArtworkInventory?.revision() ?? null, code => `unavailable:${code}`)]),
    read: (albumKey, rootId) => readSavedState(albumKey, rootId) ?? observations.get(observationKey(rootId, albumKey))?.state ?? 'unknown',
    readPersisted: readSavedState,
    ...(options.savedArtworkInventory?.readProjected ? { readPersistedProjected: (projection: LocalAlbumArtworkMembershipProjection) => {
      if (!readLocalAlbumArtworkMembershipProjection(projection, inventory)) return undefined
      return savedInventory(() => options.savedArtworkInventory!.readProjected!(projection), () => null)
    } } : {}),
  }
  function restoreObservations(revision: string): void {
    if (observationSourceRevision === revision) return
    observations.clear(); pending.clear(); observationSourceRevision = revision; observationEpoch++; observationCount = 0
    if (datasetId) for (const fact of options.repository.privateLocalAlbumArtworkObservations?.read(datasetId, revision) ?? []) {
      observations.set(observationKey(fact.rootId, fact.albumKey), fact)
    }
    observationCount = observations.size
  }
  const maxMembers = options.captureBudget?.maxMembers ?? 10_000, maxBytes = options.captureBudget?.maxBytes ?? 32 * 1024 * 1024
  if (!Number.isSafeInteger(maxMembers) || maxMembers <= 0 || maxMembers > 10_000 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 32 * 1024 * 1024) invalid()
  const check = (): void => { options.assertCurrent(); if (closedService || !views) changed() }
  function rootViews(): readonly dto.LocalRootView[] {
    check()
    const roots = catalog.roots()
    const rootsMatched = roots.length === views!.length && !roots.some(root => !views!.some(view => equal(view.root, root))); localAlbumMatch('root', rootsMatched)
    if (!rootsMatched) changed()
    return views!.filter(view=>catalog.privateLibraryManagementRootVisible(view.root.id))
  }
  function organizations(): readonly LocalAlbumLibraryOrganization[] { return options.readLibraryOrganizations?.() ?? [] }
  function readRevisionState() {
    const catalogRevision=catalog.privateAlbumBrowserRevision(),scanRevision=scan.privateAlbumBrowserRevision()
    const other=[rootViews(),options.nameEnhancements?.revision() ?? null,options.lyricsInventory?.revision() ?? null]
    const original = [catalogRevision,scanRevision,...other],organization = organizations()
    return { revision:hash(organization.length ? [...original, organization] : original),catalog:catalogRevision,scan:scanRevision,
      stable:hash([other,organization]) }
  }
  function readRevision(): string { return readRevisionState().revision }
  function scope(promote: boolean): LocalAlbumSqlScope {
    const origin = readRevisionState(), revision = origin.revision
    restoreObservations(revision)
    if (promote && pending.size) { for (const [key, value] of pending) observations.set(key, value); pending.clear(); observationEpoch++ }
    const result = { revision, roots: rootViews(), nameEnhancements: options.nameEnhancements?.read() ?? [],
      ...(options.assertReadActive ? { assertReadActive: options.assertReadActive } : {}),
      artworkInventory: inventory,
      ...(options.lyricsInventory ? { lyricsInventory: options.lyricsInventory } : {}),
      ...(options.readLibraryOrganizations ? { libraryOrganizations: organizations() } : {}) }
    if (readRevision() !== revision) changed()
    bindLocalAlbumScanScope(result,{...origin,owner:scanScopeOwner})
    fences.set(result, generation)
    lastRevision = revision
    return result
  }
  function seal(current: LocalAlbumSqlScope): void {
    const generationMatched = fences.get(current) === generation; localAlbumMatch('generation', generationMatched)
    if (!generationMatched) changed()
    const revisionMatched = readRevision() === current.revision; localAlbumMatch('revision', revisionMatched)
    if (!revisionMatched) changed()
  }
  async function refresh(): Promise<void> {
    options.assertCurrent(); if (closedService) changed()
    if (refreshing) return refreshing
    const captured = generation
    refreshing = (async () => {
      const result = await options.readRootViews(); options.assertCurrent()
      if (closedService) changed()
      const generationMatched = captured === generation; localAlbumMatch('generation', generationMatched)
      if (!generationMatched || result.length > 100) changed()
      const viewsValid = result.every(dto.isLocalRootView); localAlbumMatch('dto', viewsValid)
      if (!viewsValid || new Set(result.map(view => view.root.id)).size !== result.length) changed()
      views = structuredClone(result); rootViews()
    })()
    try { await refreshing } finally { refreshing = null }
  }
  async function protect<T>(action: () => Promise<T>): Promise<T> {
    try { return await action() } catch (error) {
      localAlbumReject(error, error instanceof LocalAlbumReadError ? error.code : 'UNAVAILABLE')
      if (error instanceof LocalAlbumReadError) throw error
      return unavailable()
    }
  }
  function readCurrentMobile(request: LocalAlbumSqlMobileQuery): ReturnType<LocalAlbumSqlPort['privateAlbumBrowserMobile']> {
    return withInventoryRead(() => {
      const current = scope(false)
      const page = sql.privateAlbumBrowserMobile(request, current)
      seal(current)
      // 目录身份只用原来源修订；封面观察epoch和图片LRU不参与目录分页身份。
      return { ...page, revision: current.revision }
    })
  }
  function captureMobileScope(signal?: AbortSignal) {
    const assertSignal = () => { if (signal?.aborted) changed() }
    const captured = withInventoryRead(() => {
      assertSignal()
      const current = scope(false)
      options.assertReadActive?.(); seal(current)
      return { current, stamp: options.repository.readonlySnapshotStamp() }
    })
    const assertCapturedFrame = () => {
      assertSignal(); options.assertCurrent(); options.assertReadActive?.(); seal(captured.current)
      const stamp = options.repository.readonlySnapshotStamp()
      if (stamp.dataVersion !== captured.stamp.dataVersion || stamp.totalChanges !== captured.stamp.totalChanges) changed()
    }
    const assertCaptured = () => withInventoryRead(assertCapturedFrame)
    return { current: captured.current, stamp: captured.stamp, assertCapturedFrame, assertCaptured }
  }
  async function prepareMobileStructure(): Promise<void> {
    if (!mobileSql) return unavailable()
    await refresh()
    let captured = captureMobileScope()
    for (;;) {
      try {
        await mobileSql.prepare(captured.current, captured.assertCaptured)
        captured.assertCaptured()
        return
      } catch (error) {
        if (!(error instanceof LocalAlbumReadError) || error.code !== 'SNAPSHOT_CHANGED') throw error
        // 原作业已真实回滚。只在同 Owner 资格仍有效且实读水位确已推进时重做完整准备。
        options.assertCurrent(); options.assertReadActive?.(); if (closedService) throw error
        await refresh()
        const next = captureMobileScope()
        if (next.current.revision === captured.current.revision
          && next.stamp.dataVersion === captured.stamp.dataVersion && next.stamp.totalChanges === captured.stamp.totalChanges) throw error
        captured = next
      }
    }
  }
  async function readMobileStructure(request: LocalAlbumSqlMobileQuery): Promise<MobileProjectionPage> {
    if (!mobileSql) return unavailable()
    const captured = captureMobileScope()
    const { assertCapturedFrame, assertCaptured } = captured
    const page = await mobileSql.read(request, captured.current, assertCaptured)
    // await只跨纯候选与原Owner水位；库存作者始终在新的同步frame中读取。
    return withInventoryRead(() => {
      catalogTraceEvent('owner.inventory-reenter', 'begin')
      assertCapturedFrame()
      const current = scope(false)
      if (current.revision !== captured.current.revision || page.revision !== current.revision) changed()
      const items = page.items.map(row => {
        // 持久作者优先；离线来源不得借 RAM 观察覆盖原始封面事实。
        const persisted = inventory.readPersisted?.(row.album.id, row.album.rootId) ?? null
        const saved = persisted ?? (row.online ? inventory.read(row.album.id, row.album.rootId) : 'unknown')
        const available = saved === 'available' || saved !== 'missing' && row.sourceHasArtwork
        const state: dto.LocalAlbumSummary['artworkState'] = available ? 'available' : !row.online ? 'source-unavailable'
          : saved === 'missing' ? 'missing' : 'unknown'
        return { ...row, album: { ...row.album, artworkState: state } }
      })
      assertCapturedFrame(); seal(current)
      catalogTraceEvent('owner.inventory-reenter', 'ok', { count: items.length })
      catalogTraceEvent('owner.structure-seal', 'ok', { matched: true, count: items.length })
      return { revision: current.revision, total: page.total, items }
    })
  }
  async function readArtistIndex(request: LocalAlbumSqlMobileQuery, signal?: AbortSignal): Promise<ReturnType<LocalAlbumSqlPort['privateAlbumBrowserMobile']>> {
    if (!indexSql) return unavailable()
    const captured = captureMobileScope(signal), page = await indexSql.read(request, captured.current, captured.assertCaptured)
    // 原 SQL 已给出完整摘要、真实歌词和成员；仅封面库存必须在 await 后回原 Owner 重新实读。
    return withInventoryRead(() => {
      captured.assertCapturedFrame()
      const current = scope(false)
      if (current.revision !== captured.current.revision || page.revision !== current.revision) changed()
      const roots = new Map(current.roots.map(view => [view.root.id, view]))
      const items = page.items.map(row => {
        const view = roots.get(row.album.rootId)
        if (!view) return changed()
        const online = view.availability === 'ONLINE'
        const persisted = inventory.readPersisted?.(row.album.id, row.album.rootId) ?? null
        const saved = persisted ?? (online ? inventory.read(row.album.id, row.album.rootId) : 'unknown')
        // 独立索引作用域没有封面观察/库存；原 SQL 的布尔值就是扫描 source_has_artwork。
        const available = saved === 'available' || saved !== 'missing' && row.album.artworkAvailable
        const artworkState: dto.LocalAlbumSummary['artworkState'] = available ? 'available' : !online ? 'source-unavailable'
          : saved === 'missing' ? 'missing' : 'unknown'
        const statuses = dto.LOCAL_ALBUM_STATUSES.filter(status => status === 'has-artwork' ? available
          : status === 'missing-artwork' ? online && saved === 'missing' : row.album.statuses.includes(status))
        const album = { ...row.album, artworkAvailable: available, artworkState, statuses }
        if (!dto.isLocalAlbumSummary(album)) return unavailable()
        return { ...row, album }
      })
      captured.assertCapturedFrame(); seal(current)
      return { revision: current.revision, total: page.total, items }
    })
  }
  const privateMobile = {
    ...(sql.privateAlbumBrowserSourceMember ? { memberIdentity: (request: import('./source-member-identity.js').LocalAlbumSourceMemberRequest) => withInventoryRead(() => {
      const current = scope(false)
      const result = sql.privateAlbumBrowserSourceMember!(request, current)
      seal(current)
      return result
    }) } : {}),
    ...(mobileSql ? { prepare: () => protect(prepareMobileStructure),
      structure: (request: LocalAlbumSqlMobileQuery) => protect(() => readMobileStructure(request)), closeStructure: () => mobileSql.close() } : {}),
    ...(indexSql ? { indexRead: (request: LocalAlbumSqlMobileQuery, signal?: AbortSignal) => protect(() => readArtistIndex(request, signal)),
      closeIndex: () => indexSql.close() } : {}),
    refresh: (): Promise<void> => protect(refresh),
    // 修订核验沿用当前 Owner、Root 和库存守门，不为读取版本重算整库分页。
    revision: (): string => withInventoryRead(() => {
      const current = scope(false)
      options.assertReadActive?.()
      seal(current)
      return current.revision
    }),
    read: (request: LocalAlbumSqlMobileQuery): Promise<ReturnType<LocalAlbumSqlPort['privateAlbumBrowserMobile']>> => protect(async () => {
      await refresh()
      return readCurrentMobile(request)
    }),
    current: readCurrentMobile,
  }
  function assertRead(read: LocalAlbumPrivateReadOptions): void {
    options.assertCurrent()
    if (closedService) changed()
    if (read.signal?.aborted) { const error = new Error('后台封面读取已取消。'); error.name = 'AbortError'; throw error }
  }
  async function queryAlbums(request: dto.LocalAlbumQuery, read: LocalAlbumPrivateReadOptions = {}): Promise<dto.LocalAlbumPage> {
    return protect(async () => {
      assertRead(read)
      localAlbumPhase('owner.input'); const requestValid = dto.isLocalAlbumQuery(request); localAlbumMatch('dto', requestValid)
      if (!requestValid) return invalid()
      localAlbumPhase('owner.refresh'); await refresh(); assertRead(read)
      return withInventoryRead(() => {
        localAlbumPhase('owner.scope'); const current = scope(true)
        localAlbumPhase('owner.sql'); noteReadTiming('owner.sql.albums', 'begin')
        const originalPage = sql.privateAlbumBrowserQuery(request, current)
        const page = options.savedArtworkInventory || options.readPreparedArtwork ? { ...originalPage, items: originalPage.items.map(album => ({ ...album,
          artworkPrepared: options.readPreparedArtwork ? savedInventory(() => options.readPreparedArtwork!({ albumKey: album.id, rootId: album.rootId,
            editionId: album.editionId, representativeTrackId: album.representativeTrackId, revision: album.revision }), () => false)
            : readSavedState(album.id, album.rootId) === 'available' })) } : originalPage
        noteReadTiming('owner.sql.albums', 'ok')
        localAlbumPhase('owner.seal'); seal(current)
        localAlbumPhase('owner.dto'); const pageValid = dto.isLocalAlbumPage(page, request); localAlbumMatch('dto', pageValid)
        if (!pageValid) return unavailable()
        emitLocalAlbumNodeTrace('ok'); noteReadTiming('owner.return', 'ok'); return page
      })
    })
  }
  /** 只交给同Owner后台闭包；public query的purpose字段不能选择此读取。 */
  async function privateBackgroundCandidates(request: LocalAlbumBackgroundCandidateQuery, signal: AbortSignal): Promise<LocalAlbumBackgroundCandidatePage> {
    return protect(async () => {
      assertRead({ signal })
      if (!isLocalAlbumBackgroundCandidateQuery(request)) return invalid()
      await refresh(); assertRead({ signal })
      return withInventoryRead(() => {
        const current = scope(true)
        const page = sql.privateAlbumBrowserBackgroundCandidates(request, current)
        seal(current); assertRead({ signal })
        if (!isLocalAlbumBackgroundCandidatePage(page, request)) return unavailable()
        return page
      })
    })
  }
  async function queryAlbumTracks(request: dto.LocalAlbumTrackQuery): Promise<dto.LocalAlbumTrackPage> {
    return protect(async () => {
      localAlbumPhase('owner.input'); if (!dto.isLocalAlbumTrackQuery(request)) return invalid()
      localAlbumPhase('owner.refresh'); await refresh()
      return withInventoryRead(() => {
        localAlbumPhase('owner.scope'); const current = scope(true)
        localAlbumPhase('owner.sql'); noteReadTiming('owner.sql.tracks', 'begin')
        const page = sql.privateAlbumBrowserMembers(request, current); noteReadTiming('owner.sql.tracks', 'ok')
        const factsStartedAtMs = performance.now()
        let detailMs = 0, parametersMs = 0, compareMs = 0
        const items: dto.LocalAlbumTrackItem[] = page.items.map(member => {
          let startedAtMs = performance.now()
          const detail = catalog.trackDetail(member.fact.summary.track.id), summary = member.fact.summary
          detailMs += performance.now() - startedAtMs; startedAtMs = performance.now()
          if (!dto.isLocalLibraryTrackDetail(detail) || !equal(detail.track, summary.track) || !equal(detail.asset, summary.asset)
            || !equal(detail.metadata.effective, summary.metadata) || !equal(detail.metadata.raw, member.fact.rawMetadata) || !equal(detail.versionTokens, summary.versionTokens)) return changed()
          compareMs += performance.now() - startedAtMs; startedAtMs = performance.now()
          const fileParameters = scan.privateDisplayFileParameters(detail.track.id, detail.asset)
          parametersMs += performance.now() - startedAtMs
          return { facts: { ...detail, fileParameters }, disc: member.disc, trackNumber: member.trackNumber, sequence: member.sequence, statuses: member.statuses }
      })
      for (const [action, elapsedMs] of [['albums.track-details', detailMs], ['albums.file-parameters', parametersMs], ['albums.track-compare', compareMs]] as const)
        logLibraryOperation('library', action, 'complete', { elapsedMs, count: items.length, slowAfterMs: 50 })
      logLibraryOperation('library', 'albums.track-facts', 'complete', { elapsedMs: performance.now() - factsStartedAtMs, count: items.length, slowAfterMs: 50 })
      const result = { ...request, album: page.album, total: page.total, hasMore: page.hasMore, items }
      localAlbumPhase('owner.seal'); seal(current); localAlbumPhase('owner.dto'); if (!dto.isLocalAlbumTrackPage(result, request, page.album)) return unavailable()
      noteReadTiming('owner.return', 'ok'); return result
      })
    })
  }
  async function getArtwork(request: dto.LocalAlbumArtworkRequest, read: LocalAlbumPrivateReadOptions = {}): Promise<dto.LocalAlbumArtworkReply> {
    const startedAtMs = performance.now(), readDeadlineAtMs = startedAtMs + (read.purpose === 'background' ? 10_000 : 2000)
    return protect(async () => {
      assertRead(read)
      localAlbumPhase('owner.input'); if (!dto.isLocalAlbumArtworkRequest(request)) return invalid()
      if (request.refresh !== true && options.readCachedArtwork) {
        const cached = options.readCachedArtwork(request)
        if (cached) {
          assertRead(read)
          const reply = projectLocalAlbumArtworkReply(request, cached)
          if (!dto.isLocalAlbumArtworkReply(reply, request)) return unavailable()
          logLibraryOperation('cache', 'artwork.local-reply', 'hit', { elapsedMs: performance.now() - startedAtMs, count: cached.image ? 1 : 0, slowAfterMs: 50 })
          return reply
        }
      }
      localAlbumPhase('owner.refresh'); await refresh()
      const { current, context } = withInventoryRead(() => {
        localAlbumPhase('owner.scope'); const current = scope(false)
        localAlbumPhase('owner.sql'); noteReadTiming('owner.sql.artwork', 'begin')
        const context: LocalAlbumArtworkReadContext = { ...sql.privateAlbumBrowserArtwork(request, current), readDeadlineAtMs,
          ...(read.purpose ? { readPurpose: read.purpose } : {}), ...(read.signal ? { readSignal: read.signal } : {}) }; noteReadTiming('owner.sql.artwork', 'ok')
        assertRead(read)
        localAlbumPhase('owner.seal'); seal(current)
        return { current, context }
      })
      let result: LocalAlbumArtworkReadResult = { image: null, status: 'ready' }
      if (read.purpose === 'background' || context.album.artworkState !== 'missing' || request.refresh === true) { localAlbumPhase('owner.artwork'); result = await options.readArtwork(request, context) }
      if (!closed(result, Object.hasOwn(result, 'grid') ? ['image','status','grid'] : ['image','status']) || !['ready','source-unavailable'].includes(result.status)
        || Object.hasOwn(result, 'grid') && (result.image === null || !dto.isLocalAlbumArtworkGrid(result.grid))
        || result.image !== null && !dto.isLocalArtworkImage(result.image) || result.status === 'source-unavailable' && result.image !== null) return unavailable()
      // 实际来源探测结束后再次读取availability；迟到回复不能给新来源留下证据。
      await refresh(); assertRead(read); seal(current)
      const reply = projectLocalAlbumArtworkReply(request, result); if (!dto.isLocalAlbumArtworkReply(reply, request)) return unavailable()
      if (result.image && options.acceptArtwork) { await options.acceptArtwork(request, context, result, () => seal(current)); seal(current) }
      if (result.status === 'ready' && (read.purpose === 'background' || context.album.artworkState !== 'missing' || request.refresh === true)) {
        const state = result.image ? 'available' as const : 'missing' as const, key = observationKey(request.rootId, request.albumKey)
        const fact = { albumKey: request.albumKey, rootId: request.rootId, sourceRevision: current.revision, state,
          revision: hash([state, result.image?.original.sha256 ?? null, result.image?.display.sha256 ?? null]) }
        const previous = pending.get(key) ?? observations.get(key)
        if (!previous && observationCount >= MAX_LOCAL_ALBUM_ARTWORK_OBSERVATIONS) throw new LocalAlbumReadError('CONTENT_LIMIT_EXCEEDED', '封面计数事实超过本机派生状态预算，原事实保留。')
        // 同值的内存观察未必已落盘；幂等put允许后续有效读取补足此前过期或写入失败的事实。
        if (datasetId && performance.now() < readDeadlineAtMs) options.repository.privateLocalAlbumArtworkObservations?.put(datasetId, fact)
        if (!equal(previous, fact)) {
          pending.set(key, fact)
          if (!previous) observationCount++
        }
      }
      noteReadTiming('owner.return', 'ok'); return reply
    })
  }
  async function inspectAlbum(request: LocalAlbumInspectRequest): Promise<LocalAlbumGroup> {
    return protect(async () => {
      if (!closed(request, ['albumKey','rootId'], ['revision']) || !dto.isLocalAlbumTrackQuery({ albumKey: request.albumKey, rootId: request.rootId, offset: 0, limit: 1 })
        || Object.hasOwn(request, 'revision') && !opaque(request.revision)) return invalid()
      function measured<T>(code: 'INVENTORY' | 'SCOPE' | 'MEMBERS' | 'ISSUES' | 'SEAL', read: () => T): T {
        const started = performance.now()
        try { const value = read(); logLibraryOperation('cache', 'albums.queue-inspect.phase', 'complete', { code, elapsedMs: performance.now() - started }); return value }
        catch (error) { logLibraryOperation('cache', 'albums.queue-inspect.phase', 'error', { code: code + '_FAILED', elapsedMs: performance.now() - started }); throw error }
      }
      const refreshStarted = performance.now()
      try { await refresh(); logLibraryOperation('cache', 'albums.queue-inspect.phase', 'complete', { code: 'REFRESH', elapsedMs: performance.now() - refreshStarted }) }
      catch (error) { logLibraryOperation('cache', 'albums.queue-inspect.phase', 'error', { code: 'REFRESH_FAILED', elapsedMs: performance.now() - refreshStarted }); throw error }
      return measured('INVENTORY', () => withInventoryRead(() => {
        const current = measured('SCOPE', () => scope(false)), initialRequest = { albumKey: request.albumKey, rootId: request.rootId, offset: 0, limit: 200 }
        const first = measured('MEMBERS', () => sql.privateAlbumBrowserMembers(initialRequest, current)), firstIssues = measured('ISSUES', () => sql.privateAlbumBrowserIssues(initialRequest, current, { buildDerivedIndex: false }))
        if (request.revision !== undefined && request.revision !== first.album.revision) return changed()
        if (!count(first.total) || !count(firstIssues.total) || !count(firstIssues.rejectedTotal)) return unavailable()
        if (first.total > maxMembers || first.total + firstIssues.rejectedTotal > maxMembers) return overBudget()
        let bytes = Buffer.byteLength(JSON.stringify({ summary: first.album, directory: first.directory }))
        const members: LocalAlbumGroup['members'][number][] = [], issues: LocalAlbumIssue[] = [], rejectedFiles: Array<{ relative: string; revision: string }> = []
        const ids = new Set<string>(), rejected = new Set<string>()
        const account = (value: unknown): void => { bytes += Buffer.byteLength(JSON.stringify(value)); if (bytes > maxBytes) overBudget() }
        for (let offset = 0; offset < Math.max(1, first.total, firstIssues.total, firstIssues.rejectedTotal); offset += 200) {
          const pageRequest = { ...initialRequest, offset }, page = offset === 0 ? first : offset < first.total ? measured('MEMBERS', () => sql.privateAlbumBrowserMembers(pageRequest, current)) : null
          if (page) {
            if (page.total !== first.total || !equal(page.album, first.album) || page.directory !== first.directory || page.items.length !== Math.min(200, Math.max(0, first.total - offset))) return changed()
            for (const member of page.items) { const id = member.fact.summary.track.id; if (ids.has(id)) return changed(); ids.add(id); account(member); members.push(member) }
          }
          if (offset === 0 || offset < Math.max(firstIssues.total, firstIssues.rejectedTotal)) {
            const value = offset === 0 ? firstIssues : measured('ISSUES', () => sql.privateAlbumBrowserIssues(pageRequest, current, { buildDerivedIndex: false }))
            if (!count(value.total) || !count(value.rejectedTotal) || value.total !== firstIssues.total || value.rejectedTotal !== firstIssues.rejectedTotal
              || value.items.length !== Math.min(200, Math.max(0, value.total - offset)) || value.rejectedFiles.length !== Math.min(200, Math.max(0, value.rejectedTotal - offset))) return changed()
            for (const issue of value.items) { account(issue); issues.push(issue) }
            for (const file of value.rejectedFiles) { if (!isLocalAlbumPrivateRelative(file.relative) || !opaque(file.revision) || rejected.has(file.relative)) return changed(); rejected.add(file.relative); account(file); rejectedFiles.push(file) }
          }
          measured('SEAL', () => seal(current))
        }
        if (members.length !== first.total || issues.length !== firstIssues.total || rejectedFiles.length !== firstIssues.rejectedTotal) return changed()
        return freeze({ summary: first.album, directory: first.directory, members, issues, rejectedFiles })
      }))
    })
  }
  function clearObservations(): void { queueAuditEpoch = Object.freeze({}); generation++; observations.clear(); pending.clear(); observationSourceRevision = null; observationEpoch++; observationCount = 0; lastRevision = null }
  function invalidate(): void { clearObservations(); if (datasetId) options.repository.privateLocalAlbumArtworkObservations?.removeDataset(datasetId) }
  function invalidateRoot(libraryId:string):void{queueAuditEpoch = Object.freeze({});for(const values of [observations,pending])for(const [key,value]of values)if(value.rootId===libraryId)values.delete(key);observationCount=new Set([...observations.keys(),...pending.keys()]).size;options.repository.privateLocalAlbumArtworkObservations?.removeRoot(libraryId);observationEpoch++;lastRevision=null}
  return { queryAlbums, queryAlbumTracks, getArtwork, inspectAlbum, invalidate,invalidateRoot, privateMobile, privateBackgroundCandidates,
    getCacheInfo: () => ({ mode: 'sql-paged' as const, revision: lastRevision, observationCount, bytes: Buffer.byteLength(JSON.stringify([...observations.values(), ...pending.values()])) }),
    close() { closedService = true; views = null; clearObservations() },
  }
}
export type LocalAlbumOwnerService = Omit<ReturnType<typeof createLocalAlbumOwnerService>, 'privateBackgroundCandidates'>
export type LocalAlbumPrivateMobilePort = LocalAlbumOwnerService['privateMobile']
