import type { LocalAlbumArtworkRequest, LocalAlbumArtworkReply, LocalAlbumSummary, LocalRootView } from '@music-bridge/contracts'
import type { LocalAlbumBackgroundCandidateQuery, LocalAlbumBackgroundCandidatePage } from './artwork-background-candidates.js'
import { logLibraryOperation } from '../../shared/library-operation-log.js'
import { randomUUID } from 'node:crypto'
import type { ArtworkBackgroundClaim, ArtworkDiscoveryCursor, ArtworkPersistedState, LocalAlbumArtworkQueue } from './artwork-background-queue.js'

export interface ArtworkBackgroundReadOptions { purpose: 'background'; signal: AbortSignal }
export interface LocalAlbumArtworkBackgroundOptions {
  datasetId: string
  queue: LocalAlbumArtworkQueue
  assertCurrent(): void
  readRootViews(): Promise<readonly LocalRootView[]>
  readRevision(): string
  /** 前台读者在途或刚完成时，只推迟新的后台入场；不撤销已有Source读取。 */
  isForegroundBusy?(): boolean
  /** 仅同一Core准入作者的当次只读探针；ready不替代后续实际Source Acquire。 */
  readAdmission?(signal: AbortSignal): Promise<'ready' | 'deferred'>
  /** 从主库已提交批次读取；补足主提交后、通知落盘前中断的恢复窗口。 */
  readRootSourceRevision?(rootId: string): string | null
  /** 只查本地资源；null代表缺失或已经明确标记无效，存储不可用须抛错。 */
  readPersistedArtwork?(request: LocalAlbumArtworkRequest): ArtworkPersistedState
  queryCandidates(request: LocalAlbumBackgroundCandidateQuery, signal: AbortSignal): Promise<LocalAlbumBackgroundCandidatePage>
  getArtwork(request: LocalAlbumArtworkRequest, options: ArtworkBackgroundReadOptions): Promise<LocalAlbumArtworkReply>
}

const artworkRequest = (album: LocalAlbumSummary): LocalAlbumArtworkRequest => ({
  albumKey: album.id, rootId: album.rootId, editionId: album.editionId,
  representativeTrackId: album.representativeTrackId, revision: album.revision,
})

/** 有界分页与单个后台读者共用原Owner，队列不取得Source能力。 */
export function createLocalAlbumArtworkBackground(options: LocalAlbumArtworkBackgroundOptions) {
  const { queue, datasetId } = options
  let started = false, closed = false, recovered = false, rerun = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let flight: Promise<void> | undefined
  let active: { rootId: string | null; controller: AbortController } | undefined
  let rootOffset = 0
  const sourceChanges = new Map<string, string>()
  const observedSources = new Map<string, string | null>()
  let observedRevision: string | undefined
  let reconcileAfterId: string | null = null, reconcileAtMs = 0
  let foregroundYieldAtMs: number | undefined
  let admissionRetryAtMs = 0

  function foregroundBusy(): boolean {
    if (options.isForegroundBusy?.()) {
      if (foregroundYieldAtMs === undefined) {
        foregroundYieldAtMs = performance.now()
        logLibraryOperation('artwork', 'artwork.background.yield', 'start', { code: 'FOREGROUND_ACTIVE' })
      }
      return true
    }
    if (foregroundYieldAtMs !== undefined) {
      logLibraryOperation('artwork', 'artwork.background.yield', 'complete', { elapsedMs: performance.now() - foregroundYieldAtMs })
      foregroundYieldAtMs = undefined
    }
    return false
  }

  function schedule(delay: number): void {
    if (!started || closed || !queue.available) return
    if (flight) { rerun = true; return }
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = undefined; void run() }, delay)
    timer.unref()
  }
  function refreshRoot(rootId: string, revision: string): void {
    const began = performance.now()
    if (!queue.refreshRoot(datasetId, rootId, revision)) return
    // 真正的来源代次立即撤旧票据；同一扫描中的批次通知不走此分支。
    if (active?.rootId === rootId) active.controller.abort()
    logLibraryOperation('artwork', 'artwork.background.source', 'complete', { id: rootId, code: 'SOURCE_CHANGED', elapsedMs: performance.now() - began })
  }
  async function processClaim(claim: ArtworkBackgroundClaim, controller: AbortController): Promise<void> {
    const began = performance.now()
    logLibraryOperation('artwork', 'artwork.background.item', 'start', { id: claim.id })
    try {
      const result = await options.getArtwork(claim.request, { purpose: 'background', signal: controller.signal })
      options.assertCurrent()
      if (controller.signal.aborted || closed) {
        queue.retry(claim, Date.now())
        logLibraryOperation('artwork', 'artwork.background.item', 'cancelled', { id: claim.id, elapsedMs: performance.now() - began })
      } else if (result.status === 'source-unavailable') {
        queue.retry(claim, Date.now() + 30_000)
        logLibraryOperation('artwork', 'artwork.background.item', 'skipped', { id: claim.id, code: 'SOURCE_UNAVAILABLE', elapsedMs: performance.now() - began })
      } else {
        // runtime返回ready前必须已完成资源COMMIT；无图也只能来自成功探测。
        queue.complete(claim)
        logLibraryOperation('artwork', 'artwork.background.item', 'complete', { id: claim.id, count: result.image ? 1 : 0, elapsedMs: performance.now() - began, slowAfterMs: 100 })
      }
    } catch (error) {
      const aborted = controller.signal.aborted || closed
      let code: unknown = null
      try {
        const descriptor = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : undefined
        if (descriptor && 'value' in descriptor) code = descriptor.value
      } catch { /* 错误诊断不改变原领取的重试与落盘资格。 */ }
      if (!aborted && code === 'SNAPSHOT_CHANGED') queue.dirtyDiscovery(datasetId, claim.request.rootId, options.readRevision())
      queue.retry(claim, Date.now() + (aborted ? 0 : Math.min(60_000, 5000 * claim.attempts)))
      logLibraryOperation('artwork', 'artwork.background.item', aborted ? 'cancelled' : 'error', { id: claim.id, code: code === 'SNAPSHOT_CHANGED' ? 'SNAPSHOT_CHANGED' : 'BACKGROUND_READ_FAILED', elapsedMs: performance.now() - began })
    }
  }
  function run(): Promise<void> {
    if (flight) return flight
    if (!started || closed || !queue.available) return Promise.resolve()
    if (foregroundBusy()) { schedule(50); return Promise.resolve() }
    if (performance.now() < admissionRetryAtMs) { schedule(admissionRetryAtMs - performance.now()); return Promise.resolve() }
    rerun = false
    let progressed = false, failed = false
    const controller = new AbortController()
    active = { rootId: null, controller }
    const work = (async () => {
      options.assertCurrent()
      if (queue.mode(datasetId) !== 'running') return
      if (options.readAdmission) {
        const admission = await options.readAdmission(controller.signal)
        if (closed || controller.signal.aborted || queue.mode(datasetId) !== 'running') return
        options.assertCurrent()
        if (admission === 'deferred') {
          admissionRetryAtMs = performance.now() + 1000
          logLibraryOperation('artwork', 'artwork.background.admission', 'skipped', { code: 'CORE_READ_DEFERRED' })
          return
        }
        if (admission !== 'ready') throw new Error('后台来源准入状态无效。')
        admissionRetryAtMs = 0
        if (foregroundBusy()) { rerun = true; return }
      }
      const views = (await options.readRootViews()).filter(view => view.root.role === 'library' && !queue.isRootRetired(datasetId, view.root.id))
      if (closed || controller.signal.aborted || queue.mode(datasetId) !== 'running') return
      if (foregroundBusy()) { rerun = true; return }
      options.assertCurrent()
      const revision = options.readRevision()
      const cursors = new Map<string, ArtworkDiscoveryCursor>()
      for (const view of views) {
        const explicit = sourceChanges.get(view.root.id)
        if (explicit) refreshRoot(view.root.id, explicit)
        if (revision !== observedRevision || !observedSources.has(view.root.id)) {
          const sourceRevision = options.readRootSourceRevision?.(view.root.id) ?? null
          if (sourceRevision && sourceRevision !== observedSources.get(view.root.id) && !explicit) refreshRoot(view.root.id, sourceRevision)
          observedSources.set(view.root.id, sourceRevision)
        }
        sourceChanges.delete(view.root.id)
        const began = performance.now()
        const cursor = queue.cursor(datasetId, view.root.id, `${view.root.sourceRootId}:${view.root.revision}`, revision)
        cursors.set(view.root.id, cursor)
        if (cursor.code !== 'CURSOR_CONTINUE') logLibraryOperation('artwork', 'artwork.background.cursor', 'complete', { id: view.root.id, code: cursor.code, offset: cursor.offset, elapsedMs: performance.now() - began })
      }
      observedRevision = revision
      if (options.readPersistedArtwork && Date.now() >= reconcileAtMs) {
        const began = performance.now()
        const result = queue.reconcileCompleted(datasetId, reconcileAfterId, views.map(view => view.root.id), request => {
          options.assertCurrent(); controller.signal.throwIfAborted()
          return options.readPersistedArtwork!(request)
        })
        reconcileAfterId = result.afterId
        // 冷开分批走完；健康资源每五分钟才重新对账，不随每个任务反复核整库。
        if (result.done) { reconcileAfterId = null; reconcileAtMs = Date.now() + 5 * 60_000 }
        else progressed = true
        if (result.checked) logLibraryOperation('artwork', 'artwork.background.reconcile', 'complete', { visited: result.checked, count: result.requeued, elapsedMs: performance.now() - began, slowAfterMs: 100 })
      }
      // 先轮流处理每个库的首页，再逐页发现；每次最多50张，不构造全库DTO。
      for (let n = 0; n < views.length; n++) {
        const view = views[(rootOffset + n) % views.length]!
        const cursor = cursors.get(view.root.id)!
        if (cursor.done) continue
        active!.rootId = view.root.id
        const discoveredAt = performance.now()
        logLibraryOperation('artwork', 'artwork.background.discover', 'start', { id: view.root.id, offset: cursor.offset, code: cursor.code })
        const page = await options.queryCandidates({ rootId: view.root.id, offset: cursor.offset, limit: 50 }, controller.signal)
        if (closed || controller.signal.aborted || queue.mode(datasetId) !== 'running') return
        options.assertCurrent()
        queue.enqueue(datasetId, page.items, cursor.offset === 0 ? 100 : 10)
        if (!queue.advance(datasetId, view.root.id, cursor, { offset: cursor.offset + page.items.length, done: !page.hasMore }, page.total, options.readRevision())) return
        logLibraryOperation('artwork', 'artwork.background.discover', 'complete', { id: view.root.id, offset: cursor.offset, code: cursor.code, elapsedMs: performance.now() - discoveredAt, count: page.items.length, total: page.total, slowAfterMs: 100 })
        rootOffset = (rootOffset + n + 1) % Math.max(1, views.length)
        progressed = true
        break
      }
      if (closed || controller.signal.aborted || queue.mode(datasetId) !== 'running') return
      if (foregroundBusy()) { rerun = true; return }
      const claim = queue.claim(datasetId, Date.now(), views.filter(view => view.availability === 'ONLINE').map(view => view.root.id))
      if (claim) {
        active!.rootId = claim.request.rootId
        progressed = true
        await processClaim(claim, controller)
      }
    })().catch(() => {
      failed = true
      if (!closed && !controller.signal.aborted) logLibraryOperation('artwork', 'artwork.background', 'error', { code: 'BACKGROUND_QUEUE_FAILED' })
    }).finally(() => {
      if (active?.controller === controller) active = undefined
      if (flight === work) flight = undefined
      try {
        // 成功后在下一事件轮补位；仍由真实读取与quiet背压，不在本轮递归消费。
        if (!closed && started && queue.available && queue.mode(datasetId) === 'running') {
          const admissionDelay = Math.max(0, admissionRetryAtMs - performance.now())
          schedule(failed ? 5000 : admissionDelay > 0 ? admissionDelay : progressed || rerun ? 0 : 30_000)
        }
      } catch { logLibraryOperation('artwork', 'artwork.background', 'error', { code: 'QUEUE_STORAGE_FAILED' }) }
    })
    flight = work
    return work
  }
  async function stop(mode: 'paused' | 'cancelled'): Promise<void> {
    if (closed) return
    queue.setMode(datasetId, mode)
    if (timer) clearTimeout(timer)
    timer = undefined
    active?.controller.abort()
    await flight
    logLibraryOperation('artwork', 'artwork.background', mode === 'paused' ? 'paused' : 'cancelled')
  }
  return {
    start(): void {
      if (closed || started || !queue.available) return
      try {
        if (!recovered) { queue.recover(datasetId); recovered = true }
        started = true
        logLibraryOperation('artwork', 'artwork.background', 'start')
        if (queue.mode(datasetId) === 'running') schedule(150)
      } catch { logLibraryOperation('artwork', 'artwork.background', 'error', { code: 'QUEUE_STORAGE_FAILED' }) }
    },
    notifyChanged(rootId?: string, sourceRevision?: string): void {
      if (closed || !queue.available) return
      // 同来源批次只合并补扫；新来源代次同步撤旧令牌，冷开仍由主库水位补足。
      try {
        if (rootId) {
          const revision = sourceRevision ?? randomUUID()
          sourceChanges.set(rootId, revision)
          refreshRoot(rootId, revision)
          queue.dirtyDiscovery(datasetId, rootId)
        } else queue.dirtyDiscovery(datasetId)
      } catch { logLibraryOperation('artwork', 'artwork.background', 'error', { code: 'QUEUE_STORAGE_FAILED' }) }
      if (started) schedule(150)
    },
    prioritize(albums: readonly LocalAlbumSummary[]): void {
      if (closed || !queue.available || !started) return
      try {
        queue.enqueue(datasetId, albums.map(artworkRequest), 1000)
        if (queue.mode(datasetId) === 'running') schedule(150)
      } catch { logLibraryOperation('artwork', 'artwork.background', 'error', { code: 'QUEUE_STORAGE_FAILED' }) }
    },
    pause: () => stop('paused'),
    cancel: () => stop('cancelled'),
    resume(): void {
      if (closed || !queue.available) return
      if (!recovered) { queue.recover(datasetId); recovered = true }
      queue.setMode(datasetId, 'running'); started = true
      reconcileAfterId = null; reconcileAtMs = 0
      logLibraryOperation('artwork', 'artwork.background', 'resumed')
      schedule(0)
    },
    async removeRoot(rootId: string): Promise<void> {
      if (closed || !queue.available) return
      queue.removeRoot(datasetId, rootId)
      if (active?.rootId === rootId) { active.controller.abort(); await flight }
    },
    inspect() { return queue.inspect(datasetId) },
    /** 私有单步亦用于有界诊断；正常运行由计时器推进，不要求页面触发。 */
    async runPending(): Promise<void> {
      if (timer) clearTimeout(timer)
      timer = undefined
      await run()
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true; started = false
      if (timer) clearTimeout(timer)
      timer = undefined
      active?.controller.abort()
      await flight
      logLibraryOperation('artwork', 'artwork.background', 'complete')
    },
  }
}

export type LocalAlbumArtworkBackground = ReturnType<typeof createLocalAlbumArtworkBackground>
