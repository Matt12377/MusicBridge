import { localAlbumPhase, localAlbumMatch, localAlbumReject, emitLocalAlbumNodeTrace, captureLocalAlbumContext } from '../../shared/local-album-read-trace-node.js'
import type { LocalAlbumTraceStage } from '../../shared/library-read-trace.js'
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import * as dto from '@music-bridge/contracts'
import type { CollectionRepository } from '../repository.js'
import { isLocalAlbumPrivateRelative, LocalAlbumReadError } from './grouping.js'
import type { LocalAlbumArtworkReadContext, LocalAlbumArtworkReadResult, LocalAlbumGroup, LocalAlbumInspectRequest, LocalAlbumIssue, LocalAlbumNameEnhancementFact } from './types.js'
import type { LocalAlbumArtworkInventory, LocalAlbumSqlArtworkObservation, LocalAlbumSqlMobileQuery, LocalAlbumSqlPort, LocalAlbumSqlScope, LocalAlbumLyricsInventory, LocalAlbumLibraryOrganization } from './sql-types.js'
import { MAX_LOCAL_ALBUM_ARTWORK_OBSERVATIONS } from './artwork-observation-store.js'

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
  /** 只有原 DatasetIdentity 可提供，缺失时仅保留本进程事实。 */
  datasetId?: string
  assertCurrent(): void
  /** 每次公开操作前由原重定位作者实读；不能把 authorized 当作 ONLINE。 */
  readRootViews(): Promise<readonly dto.LocalRootView[]>
  readArtwork(request: dto.LocalAlbumArtworkRequest, context: LocalAlbumArtworkReadContext): Promise<LocalAlbumArtworkReadResult>
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

/** 使用原 guarded SQL 聚合/分页；128MiB约束缓存，合法30万轨道不变成全库DTO。 */
export function createLocalAlbumOwnerService(options: LocalAlbumOwnerPortOptions) {
  const catalog = options.repository.localCatalog, scan = options.repository.localScan, sql = catalog as typeof catalog & LocalAlbumSqlPort
  let views: readonly dto.LocalRootView[] | null = null, closedService = false, generation = 0, lastRevision: string | null = null, refreshing: Promise<void> | null = null
  const fences = new WeakMap<LocalAlbumSqlScope, number>()
  const observations = new Map<string, LocalAlbumSqlArtworkObservation>(), pending = new Map<string, LocalAlbumSqlArtworkObservation>()
  let observationSourceRevision: string | null = null, observationEpoch = 0, observationCount = 0
  const observationKey = (rootId: string, albumKey: string): string => JSON.stringify([rootId, albumKey])
  const datasetId = dto.isCollectionId(options.datasetId) ? options.datasetId : null
  const inventory: LocalAlbumArtworkInventory = {
    revision: () => hash([observationSourceRevision, observationEpoch]),
    read: (albumKey, rootId) => observations.get(observationKey(rootId, albumKey))?.state ?? 'unknown',
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
  function readRevision(): string {
    const original = [catalog.privateAlbumBrowserRevision(), scan.privateAlbumBrowserRevision(), rootViews(), options.nameEnhancements?.revision() ?? null, options.lyricsInventory?.revision() ?? null]
    const organization = organizations()
    return hash(organization.length ? [...original, organization] : original)
  }
  function scope(promote: boolean): LocalAlbumSqlScope {
    const revision = readRevision()
    restoreObservations(revision)
    if (promote && pending.size) { for (const [key, value] of pending) observations.set(key, value); pending.clear(); observationEpoch++ }
    const result = { revision, roots: rootViews(), nameEnhancements: options.nameEnhancements?.read() ?? [],
      artworkInventory: inventory,
      ...(options.lyricsInventory ? { lyricsInventory: options.lyricsInventory } : {}),
      ...(options.readLibraryOrganizations ? { libraryOrganizations: organizations() } : {}) }
    if (readRevision() !== revision) changed()
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
    const current = scope(false)
    const page = sql.privateAlbumBrowserMobile(request, current)
    seal(current)
    // 目录身份只用原来源修订；封面观察epoch和图片LRU不参与目录分页身份。
    return { ...page, revision: current.revision }
  }
  const privateMobile = {
    refresh: (): Promise<void> => protect(refresh),
    read: (request: LocalAlbumSqlMobileQuery): Promise<ReturnType<LocalAlbumSqlPort['privateAlbumBrowserMobile']>> => protect(async () => {
      await refresh()
      return readCurrentMobile(request)
    }),
    current: readCurrentMobile,
  }
  async function queryAlbums(request: dto.LocalAlbumQuery): Promise<dto.LocalAlbumPage> {
    return protect(async () => {
      localAlbumPhase('owner.input'); const requestValid = dto.isLocalAlbumQuery(request); localAlbumMatch('dto', requestValid)
      if (!requestValid) return invalid()
      localAlbumPhase('owner.refresh'); await refresh()
      localAlbumPhase('owner.scope'); const current = scope(true)
      localAlbumPhase('owner.sql'); noteReadTiming('owner.sql.albums', 'begin')
      const page = sql.privateAlbumBrowserQuery(request, current); noteReadTiming('owner.sql.albums', 'ok')
      localAlbumPhase('owner.seal'); seal(current)
      localAlbumPhase('owner.dto'); const pageValid = dto.isLocalAlbumPage(page, request); localAlbumMatch('dto', pageValid)
      if (!pageValid) return unavailable()
      emitLocalAlbumNodeTrace('ok'); noteReadTiming('owner.return', 'ok'); return page
    })
  }
  async function queryAlbumTracks(request: dto.LocalAlbumTrackQuery): Promise<dto.LocalAlbumTrackPage> {
    return protect(async () => {
      localAlbumPhase('owner.input'); if (!dto.isLocalAlbumTrackQuery(request)) return invalid()
      localAlbumPhase('owner.refresh'); await refresh(); localAlbumPhase('owner.scope'); const current = scope(true)
      localAlbumPhase('owner.sql'); noteReadTiming('owner.sql.tracks', 'begin')
      const page = sql.privateAlbumBrowserMembers(request, current); noteReadTiming('owner.sql.tracks', 'ok')
      const items: dto.LocalAlbumTrackItem[] = page.items.map(member => {
        const detail = catalog.trackDetail(member.fact.summary.track.id), summary = member.fact.summary
        if (!dto.isLocalLibraryTrackDetail(detail) || !equal(detail.track, summary.track) || !equal(detail.asset, summary.asset)
          || !equal(detail.metadata.effective, summary.metadata) || !equal(detail.metadata.raw, member.fact.rawMetadata) || !equal(detail.versionTokens, summary.versionTokens)) return changed()
        return { facts: { ...detail, fileParameters: scan.privateDisplayFileParameters(detail.track.id, detail.asset) }, disc: member.disc, trackNumber: member.trackNumber, sequence: member.sequence, statuses: member.statuses }
      })
      const result = { ...request, album: page.album, total: page.total, hasMore: page.hasMore, items }
      localAlbumPhase('owner.seal'); seal(current); localAlbumPhase('owner.dto'); if (!dto.isLocalAlbumTrackPage(result, request, page.album)) return unavailable()
      noteReadTiming('owner.return', 'ok'); return result
    })
  }
  async function getArtwork(request: dto.LocalAlbumArtworkRequest): Promise<dto.LocalAlbumArtworkReply> {
    const readDeadlineAtMs = performance.now() + 2000
    return protect(async () => {
      localAlbumPhase('owner.input'); if (!dto.isLocalAlbumArtworkRequest(request)) return invalid()
      localAlbumPhase('owner.refresh'); await refresh(); localAlbumPhase('owner.scope'); const current = scope(false)
      localAlbumPhase('owner.sql'); noteReadTiming('owner.sql.artwork', 'begin')
      const context = { ...sql.privateAlbumBrowserArtwork(request, current), readDeadlineAtMs }; noteReadTiming('owner.sql.artwork', 'ok')
      localAlbumPhase('owner.seal'); seal(current)
      let result: LocalAlbumArtworkReadResult = { image: null, status: 'ready' }
      if (context.album.artworkState !== 'missing' || request.refresh === true) { localAlbumPhase('owner.artwork'); result = await options.readArtwork(request, context) }
      if (!closed(result, ['image','status']) || !['ready','source-unavailable'].includes(result.status)
        || result.image !== null && !dto.isLocalArtworkImage(result.image) || result.status === 'source-unavailable' && result.image !== null) return unavailable()
      // 实际来源探测结束后再次读取availability；迟到回复不能给新来源留下证据。
      await refresh(); seal(current)
      const reply = { albumKey: request.albumKey, rootId: request.rootId, editionId: request.editionId, representativeTrackId: request.representativeTrackId, revision: request.revision, ...result }; if (!dto.isLocalAlbumArtworkReply(reply, request)) return unavailable()
      if (result.image && options.acceptArtwork) { await options.acceptArtwork(request, context, result, () => seal(current)); seal(current) }
      if (result.status === 'ready' && (context.album.artworkState !== 'missing' || request.refresh === true)) {
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
      await refresh(); const current = scope(false), initialRequest = { albumKey: request.albumKey, rootId: request.rootId, offset: 0, limit: 200 }
      const first = sql.privateAlbumBrowserMembers(initialRequest, current), firstIssues = sql.privateAlbumBrowserIssues(initialRequest, current, { buildDerivedIndex: false })
      if (request.revision !== undefined && request.revision !== first.album.revision) return changed()
      if (!count(first.total) || !count(firstIssues.total) || !count(firstIssues.rejectedTotal)) return unavailable()
      if (first.total > maxMembers || first.total + firstIssues.rejectedTotal > maxMembers) return overBudget()
      let bytes = Buffer.byteLength(JSON.stringify({ summary: first.album, directory: first.directory }))
      const members: LocalAlbumGroup['members'][number][] = [], issues: LocalAlbumIssue[] = [], rejectedFiles: Array<{ relative: string; revision: string }> = []
      const ids = new Set<string>(), rejected = new Set<string>()
      const account = (value: unknown): void => { bytes += Buffer.byteLength(JSON.stringify(value)); if (bytes > maxBytes) overBudget() }
      for (let offset = 0; offset < Math.max(1, first.total, firstIssues.total, firstIssues.rejectedTotal); offset += 200) {
        const pageRequest = { ...initialRequest, offset }, page = offset === 0 ? first : offset < first.total ? sql.privateAlbumBrowserMembers(pageRequest, current) : null
        if (page) {
          if (page.total !== first.total || !equal(page.album, first.album) || page.directory !== first.directory || page.items.length !== Math.min(200, Math.max(0, first.total - offset))) return changed()
          for (const member of page.items) { const id = member.fact.summary.track.id; if (ids.has(id)) return changed(); ids.add(id); account(member); members.push(member) }
        }
        if (offset === 0 || offset < Math.max(firstIssues.total, firstIssues.rejectedTotal)) {
          const value = offset === 0 ? firstIssues : sql.privateAlbumBrowserIssues(pageRequest, current, { buildDerivedIndex: false })
          if (!count(value.total) || !count(value.rejectedTotal) || value.total !== firstIssues.total || value.rejectedTotal !== firstIssues.rejectedTotal
            || value.items.length !== Math.min(200, Math.max(0, value.total - offset)) || value.rejectedFiles.length !== Math.min(200, Math.max(0, value.rejectedTotal - offset))) return changed()
          for (const issue of value.items) { account(issue); issues.push(issue) }
          for (const file of value.rejectedFiles) { if (!isLocalAlbumPrivateRelative(file.relative) || !opaque(file.revision) || rejected.has(file.relative)) return changed(); rejected.add(file.relative); account(file); rejectedFiles.push(file) }
        }
        seal(current)
      }
      if (members.length !== first.total || issues.length !== firstIssues.total || rejectedFiles.length !== firstIssues.rejectedTotal) return changed()
      return freeze({ summary: first.album, directory: first.directory, members, issues, rejectedFiles })
    })
  }
  function clearObservations(): void { generation++; observations.clear(); pending.clear(); observationSourceRevision = null; observationEpoch++; observationCount = 0; lastRevision = null }
  function invalidate(): void { clearObservations(); if (datasetId) options.repository.privateLocalAlbumArtworkObservations?.removeDataset(datasetId) }
  function invalidateRoot(libraryId:string):void{for(const values of [observations,pending])for(const [key,value]of values)if(value.rootId===libraryId)values.delete(key);observationCount=new Set([...observations.keys(),...pending.keys()]).size;options.repository.privateLocalAlbumArtworkObservations?.removeRoot(libraryId);observationEpoch++;lastRevision=null}
  return { queryAlbums, queryAlbumTracks, getArtwork, inspectAlbum, invalidate,invalidateRoot, privateMobile,
    getCacheInfo: () => ({ mode: 'sql-paged' as const, revision: lastRevision, observationCount, bytes: Buffer.byteLength(JSON.stringify([...observations.values(), ...pending.values()])) }),
    close() { closedService = true; views = null; clearObservations() },
  }
}
export type LocalAlbumOwnerService = ReturnType<typeof createLocalAlbumOwnerService>
export type LocalAlbumPrivateMobilePort = LocalAlbumOwnerService['privateMobile']
