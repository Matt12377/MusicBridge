import type { MobileSqlWorkerOptions } from './mobile-sql-worker.js'
import { randomUUID } from 'node:crypto'
import { isScanJobRecord, type LocalRootView } from '@music-bridge/contracts'
import type { CollectionRepository } from '../repository.js'
import { isDatasetProjectionResult, type DatasetProjectionPort } from '../dataset-owner-protocol.js'
import { createLocalAlbumArtworkReader } from './artwork-read-port.js'
import { createLocalAlbumOwnerService } from './owner-port.js'
import { createLocalAlbumArtworkBackground, type LocalAlbumArtworkBackground } from './artwork-background.js'
import type { LocalAlbumArtworkReadResult, LocalAlbumNameEnhancementFact } from './types.js'
import type { LocalAlbumLyricsInventory, LocalAlbumLibraryOrganization } from './sql-types.js'
import { MOBILE_PLAYBACK_ACTIVITY_LEASE_MS, MOBILE_PLAYBACK_ACTIVITY_MAX_LEASES } from '../../mobile/types.js'

/** 原 Owner 生命周期内组合；Main 只解码副本，许可与源 FD 始终由原作者收口。 */
export function createLocalAlbumOwnerRuntime(options: {
  mobileSqlWorker?: MobileSqlWorkerOptions
  repository: CollectionRepository; projection?: DatasetProjectionPort; datasetId?: string; assertCurrent(): void
  assertReadActive?(): void
  readRootViews(): Promise<readonly LocalRootView[]>
  nameEnhancements?: { revision(): string; read(): readonly LocalAlbumNameEnhancementFact[] }
  lyricsInventory?: LocalAlbumLyricsInventory
  readLibraryOrganizations?(): readonly LocalAlbumLibraryOrganization[]
}) {
  const artwork = createLocalAlbumArtworkReader(options)
  let background: LocalAlbumArtworkBackground | undefined
  let foregroundReads = 0, foregroundQuietUntilMs = 0
  let playbackReads = 0, playbackQuietUntilMs = 0
  let closed = false
  const controlLeases = new Map<string, { release(): void; timer: ReturnType<typeof setTimeout> }>()
  // 仅同Owner的RAM调度提示，不授予读权限；旧token只能归还自身一次。
  function beginMobileActivity(): () => void {
    if (closed) return () => {}
    foregroundReads++
    let released = false
    return () => {
      if (released) return
      released = true; foregroundReads--; foregroundQuietUntilMs = performance.now() + 100
    }
  }
  // 独立于目录自己的foreground标记，避免目录current/revision让本页自锁。
  function beginMobilePlaybackActivity(): () => void {
    if (closed) return () => {}
    const releaseForeground = beginMobileActivity()
    playbackReads++
    let released = false
    return () => {
      if (released) return
      released = true; playbackReads--; playbackQuietUntilMs = performance.now() + 100
      releaseForeground()
    }
  }
  const isPlaybackBusy = (): boolean => playbackReads > 0 || performance.now() < playbackQuietUntilMs
  async function foreground<T>(read: () => Promise<T>): Promise<T> {
    const release = beginMobileActivity()
    try { return await read() }
    finally { release() }
  }
  function foregroundSync<T>(read: () => T): T {
    const release = beginMobileActivity()
    try { return read() }
    finally { release() }
  }
  function endMobileControlActivity(leaseId: string): void {
    const lease = controlLeases.get(leaseId)
    if (!lease) return
    controlLeases.delete(leaseId); clearTimeout(lease.timer); lease.release()
  }
  function beginMobileControlActivity(): string | null {
    if (closed || controlLeases.size >= MOBILE_PLAYBACK_ACTIVITY_MAX_LEASES) return null
    const leaseId = randomUUID(), release = beginMobilePlaybackActivity()
    // Main断开或ACK丢失也只暂缓后台；期限不续租，不建立任何持久回执。
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      timer = setTimeout(() => endMobileControlActivity(leaseId), MOBILE_PLAYBACK_ACTIVITY_LEASE_MS)
      timer.unref(); controlLeases.set(leaseId, { release, timer }); return leaseId
    } catch {
      if (timer) clearTimeout(timer)
      release(); return null
    }
  }
  const acceptedSources = new WeakMap<LocalAlbumArtworkReadResult, Awaited<ReturnType<typeof artwork.readSources>>>()
  const service = createLocalAlbumOwnerService({
    ...(options.mobileSqlWorker ? { mobileSqlWorker: options.mobileSqlWorker } : {}), ...options,
    readCachedArtwork: request => artwork.readCached(request),
    readPreparedArtwork: request => artwork.persistedState(request) === 'available',
    savedArtworkInventory: { revision: () => artwork.cacheRevision(), read: (albumKey, rootId) => artwork.cachedState(albumKey, rootId), readProjected: projection => artwork.cachedStateProjected(projection) },
    withArtworkInventoryRead: read => artwork.withInventoryRead(read),
    async readArtwork(request, context) {
      const sources = await artwork.readSources({ request, context }, randomUUID(), context.readSignal, context.readDeadlineAtMs, context.readPurpose === 'background' ? 'background' : 'display')
      context.readSignal?.throwIfAborted()
      options.assertCurrent()
      if (sources.image) {
        const result = { image: sources.image, status: 'ready' as const, ...(sources.grid ? { grid: sources.grid } : {}) }
        acceptedSources.set(result, sources); return result
      }
      if (sources.copies.status === 'source-unavailable') return { image: null, status: 'source-unavailable' }
      if (!sources.copies.items.length) return { image: null, status: 'ready' }
      if (!options.projection) throw new Error('封面规范化服务尚未就绪。')
      const result = await options.projection.call('normalizeLocalAlbumArtwork', { copies: sources.copies }, {
        ...(context.readDeadlineAtMs === undefined ? {} : { deadlineAtMs: context.readDeadlineAtMs }),
        ...(context.readSignal ? { signal: context.readSignal } : {}),
      })
      context.readSignal?.throwIfAborted()
      options.assertCurrent(); if (result.image) acceptedSources.set(result, sources); return result
    },
    async acceptArtwork(_request, context, result, seal) {
      const sources = acceptedSources.get(result); acceptedSources.delete(result)
      if (sources && result.image) await artwork.retainDisplay(sources, result.image, () => { context.readSignal?.throwIfAborted(); seal() }, result.grid)
    },
  })
  const { privateBackgroundCandidates, ...publicService } = service
  // 自动目录分页保持只读，不能把每张离屏专辑都写成前台优先任务。
  // Core独立发现并落盘；真实前台getArtwork继续沿原display读取许可。
  const localAlbums = { ...publicService,
    privateMobile: {
      ...(service.privateMobile.prepare ? { prepare: () => foreground(() => service.privateMobile.prepare!()) } : {}),
      ...(service.privateMobile.memberIdentity ? { memberIdentity: (...args: Parameters<NonNullable<typeof service.privateMobile.memberIdentity>>) => foregroundSync(() => service.privateMobile.memberIdentity!(...args)) } : {}),
      ...(service.privateMobile.structure ? { structure: (...args: Parameters<NonNullable<typeof service.privateMobile.structure>>) => foreground(() => service.privateMobile.structure!(...args)) } : {}),
      ...(service.privateMobile.indexRead ? { indexRead: (...args: Parameters<NonNullable<typeof service.privateMobile.indexRead>>) => foreground(() => service.privateMobile.indexRead!(...args)) } : {}),
      refresh: () => foreground(() => service.privateMobile.refresh()),
      read: (...args: Parameters<typeof service.privateMobile.read>) => foreground(() => service.privateMobile.read(...args)),
      current: (...args: Parameters<typeof service.privateMobile.current>) => foregroundSync(() => service.privateMobile.current(...args)),
      revision: () => foregroundSync(() => service.privateMobile.revision()),
    },
    queryAlbums: (...args: Parameters<typeof service.queryAlbums>) => args[1]?.purpose === 'background'
      ? service.queryAlbums(...args) : foreground(() => service.queryAlbums(...args)),
    queryAlbumTracks: (...args: Parameters<typeof service.queryAlbumTracks>) => foreground(() => service.queryAlbumTracks(...args)),
    inspectAlbum: (...args: Parameters<typeof service.inspectAlbum>) => foreground(() => service.inspectAlbum(...args)),
    getArtwork: (...args: Parameters<typeof service.getArtwork>) => args[1]?.purpose === 'background'
      ? service.getArtwork(...args) : foreground(() => {
        // 仅已证明的旧CD缺图沿原只读refresh路径重探，避免旧missing观察阻止新发现策略。
        const request = artwork.needsDiscParentReprobe(args[0]) ? { ...args[0], refresh: true as const } : args[0]
        return service.getArtwork(request, args[1])
      }),
  }
  const queue = options.repository.privateLocalAlbumArtworkQueue
  if (options.datasetId && options.projection && queue) background = createLocalAlbumArtworkBackground({
    datasetId: options.datasetId, queue, assertCurrent: options.assertCurrent,
    isForegroundBusy: () => foregroundReads > 0 || performance.now() < foregroundQuietUntilMs,
    async readAdmission(signal) {
      const result = await options.projection!.call('scanReadStatus', {}, { signal })
      if (!isDatasetProjectionResult('scanReadStatus', result)) throw new Error('后台来源准入状态无效。')
      return result.status
    },
    async readRootViews() {
      return (await options.readRootViews()).filter(view => options.repository.localCatalog.privateLibraryManagementRootAvailable(view.root.id))
    },
    readRevision: () => `${options.repository.localCatalog.privateAlbumBrowserRevision()}:${options.repository.localScan.privateAlbumBrowserRevision()}`,
    readPersistedArtwork: request => artwork.persistedState(request),
    readRootSourceRevision(rootId) {
      const row = options.repository.localCatalog.privateRead(db => db.prepare("SELECT j.data FROM local_scan_jobs j WHERE j.dataset_id=? AND j.library_root_id=? AND EXISTS(SELECT 1 FROM local_scan_batches b WHERE b.job_id=j.id AND b.phase='committed') ORDER BY j.rowid DESC LIMIT 1").get(options.datasetId!, rootId))
      if (!row) return null
      const job: unknown = JSON.parse(String(row.data))
      if (!isScanJobRecord(job)) throw new Error('封面补齐的原扫描批次身份无效。')
      return `${job.jobId}:${job.phase === 'completed' ? 'completed' : 'scanning'}`
    },
    queryCandidates: (request, signal) => privateBackgroundCandidates(request, signal),
    getArtwork: (request, read) => service.getArtwork(request, read),
  })
  return { localAlbums, artwork, background, beginMobileActivity, beginMobilePlaybackActivity, isPlaybackBusy, beginMobileControlActivity, endMobileControlActivity,
    async close() {
      closed = true
      for (const leaseId of controlLeases.keys()) endMobileControlActivity(leaseId)
      await Promise.all([service.privateMobile.closeStructure?.(), service.privateMobile.closeIndex?.()]); await background?.close(); await artwork.close(); localAlbums.close()
    },
  }
}
