import { isLocalLyricsCommandPayload, isLocalLyricsJobOriginalEntry } from '@music-bridge/contracts'
import type { LocalLyricsJobStartRequest, LocalLyricsJobSnapshot, LocalLyricsJobRetryRequest } from '@music-bridge/contracts'
import { LocalLyricsError, lyricsClone, lyricsDigest, lyricsAbort, lyricsLibraryKey } from './types.js'
import type { LocalLyricsPorts, LocalLyricsJobRecord, LocalLyricsJobEntry, LocalLyricsLibraryCapture } from './types.js'
import type { LocalLyricsService } from './service.js'

/** 单库全部已扫描专辑；原commandId即jobId，丢响应后read不产生第二批任务。 */
export class LocalLyricsJob {
  private readonly running = new Map<string, { controller: AbortController; work: Promise<void> }>()
  private readonly accepting = new Map<string, Promise<LocalLyricsJobSnapshot>>()
  private readonly acceptingLibraries=new Map<string,string>()
  private readonly retiredLibraries=new Set<string>()
  private readonly restarting = new Set<string>()
  private closed = false
  constructor(private readonly ports: LocalLyricsPorts, private readonly service: LocalLyricsService) {}
  async start(request: LocalLyricsJobStartRequest): Promise<LocalLyricsJobSnapshot> {
    if (!isLocalLyricsCommandPayload('localLyrics.job.start', request)) throw new LocalLyricsError('INVALID')
    if(this.retiredLibraries.has(request.library.libraryId))throw new LocalLyricsError('CLOSED')
    const pending = this.accepting.get(request.commandId)
    if (pending) { await pending; return this.start(request) }
    const work = this.accept(request); this.accepting.set(request.commandId, work);this.acceptingLibraries.set(request.commandId,request.library.libraryId)
    try { return await work } finally { this.accepting.delete(request.commandId);this.acceptingLibraries.delete(request.commandId) }
  }
  private async accept(request: LocalLyricsJobStartRequest): Promise<LocalLyricsJobSnapshot> {
    this.ports.lifecycle.assertAccepting()
    if (this.closed) throw new LocalLyricsError('CLOSED')
    const original = await this.ports.journal.readJob(request.commandId)
    if (original) {
      if (original.snapshot.jobId !== request.commandId || original.embed !== request.embed || lyricsLibraryKey(original.snapshot.library) !== lyricsLibraryKey(request.library)) throw new LocalLyricsError('CONFLICT')
      return lyricsClone(original.snapshot)
    }
    const c = await this.ports.capture.captureLibrary(request.library)
    if (lyricsLibraryKey(c.library) !== lyricsLibraryKey(request.library)) throw new LocalLyricsError('STALE')
    await this.assert(c)
    if(this.retiredLibraries.has(request.library.libraryId))throw new LocalLyricsError('CLOSED')
    const record: LocalLyricsJobRecord = { snapshot: { jobId: request.commandId, library: lyricsClone(request.library), state: 'queued', totalAlbums: 0, processedAlbums: 0, savedAlbums: 0, reviewAlbumIds: [], failedAlbumIds: [], unknownAlbumIds: [], sidecars: 0, embedded: 0, inspectionFailures: 0, revision: 0 }, entries: [], enumerationComplete: false, embed: request.embed, watermark: c.watermark, deadlineAtMs: c.deadlineAtMs }
    await this.ports.journal.checkpoint(lyricsClone(record), null)
    this.launch(record, c, null)
    return lyricsClone(record.snapshot)
  }
  private async assert(c: LocalLyricsLibraryCapture): Promise<void> {
    await this.ports.capture.assertLibraryCurrent(c)
    if (!Number.isFinite(c.deadlineAtMs) || this.ports.lifecycle.now() >= c.deadlineAtMs) throw new LocalLyricsError('BUDGET')
  }
  private async persist(r: LocalLyricsJobRecord): Promise<void> { const revision = r.snapshot.revision; r.snapshot.revision++; await this.ports.journal.checkpoint(lyricsClone(r), revision) }
  private launch(r: LocalLyricsJobRecord, c: LocalLyricsLibraryCapture, retry: Set<string> | null): void {
    const deadline = lyricsAbort(undefined, c.deadlineAtMs - this.ports.lifecycle.now())
    if (this.closed) deadline.controller.abort()
    const work = Promise.resolve().then(() => this.run(r, c, deadline.controller.signal, retry)).finally(() => { deadline.dispose(); this.running.delete(r.snapshot.jobId) })
    this.running.set(r.snapshot.jobId, { controller: deadline.controller, work })
    void work.catch(() => { /* Owner保留原checkpoint；不输出私有异常。 */ })
  }
  private async enumerate(c: LocalLyricsLibraryCapture): Promise<LocalLyricsJobEntry[]> {
    const entries: LocalLyricsJobEntry[] = [], cursors = new Set<string>(), albums = new Set<string>()
    let cursor: string | null = null, total: number | null = null
    do {
      await this.assert(c)
      const page = await this.ports.capture.libraryPage(c, cursor)
      if (page.watermark !== c.watermark || !Number.isSafeInteger(page.total) || page.total < 0 || (total !== null && total !== page.total)) throw new LocalLyricsError('STALE')
      total = page.total
      for (const scope of page.scopes) {
        if (scope.datasetId !== c.library.datasetId || scope.libraryId !== c.library.libraryId || albums.has(scope.albumId)) throw new LocalLyricsError('STALE')
        albums.add(scope.albumId); entries.push({ scope: lyricsClone(scope), state: 'pending', saveRequest: null, sessionId: null, unresolved: null, sidecars: 0, embedded: 0 })
      }
      if (entries.length > total || Buffer.byteLength(JSON.stringify(entries)) > 32 * 1024 * 1024 || (page.next !== null && cursors.has(page.next))) throw new LocalLyricsError('BUDGET')
      cursor = page.next; if (cursor !== null) cursors.add(cursor)
    } while (cursor !== null)
    if (entries.length !== total) throw new LocalLyricsError('STALE')
    await this.assert(c)
    return entries
  }
  private recount(r: LocalLyricsJobRecord): void {
    r.snapshot.processedAlbums = r.entries.filter(e => e.state !== 'pending').length
    r.snapshot.savedAlbums = r.entries.filter(e => e.state === 'saved').length
    r.snapshot.reviewAlbumIds = r.entries.filter(e => e.state === 'review').map(e => e.scope.albumId)
    r.snapshot.failedAlbumIds = r.entries.filter(e => e.state === 'failed').map(e => e.scope.albumId)
    r.snapshot.unknownAlbumIds = r.entries.filter(e => e.state === 'unknown').map(e => e.scope.albumId)
    r.snapshot.sidecars = r.entries.reduce((sum, e) => sum + e.sidecars, 0)
    r.snapshot.embedded = r.entries.reduce((sum, e) => sum + e.embedded, 0)
  }
  private async process(r: LocalLyricsJobRecord, entry: LocalLyricsJobEntry, signal: AbortSignal, retry: boolean): Promise<void> {
    if (entry.saveRequest !== null) {
      // 一旦原写入intent已登记，cold/resume只查原id；只有明确failed允许显式retry。
      const original = { sessionId: entry.saveRequest.sessionId, commandId: entry.saveRequest.commandId }
      let receipt = await this.service.receipt(original)
      if (retry && receipt && receipt.state !== 'unknown' && receipt.state !== 'running') {
        if ((receipt.snapshot === 'failed' || receipt.snapshot === 'pending') && receipt.state === 'complete') await this.service.retrySnapshot(original)
        else await this.service.retrySave(original)
        await this.service.saves.wait(entry.saveRequest.commandId)
        receipt = await this.service.receipt(original)
      }
      if (receipt) { entry.sidecars = receipt.tracks.filter(t => t.lrc === 'saved').length; entry.embedded = receipt.tracks.filter(t => t.embed === 'saved').length }
      entry.state = !receipt || receipt.state === 'unknown' || receipt.state === 'running' ? 'unknown' : receipt.state === 'complete' && receipt.snapshot !== 'failed' && receipt.snapshot !== 'pending' ? entry.unresolved ?? 'saved' : 'failed'
      return
    }
    const accepted = await this.service.query({ scope: entry.scope }, signal)
    entry.sessionId = accepted.sessionId; await this.persist(r)
    await this.service.wait(accepted.sessionId)
    if (signal.aborted) return
    const session = await this.service.readSession({ sessionId: accepted.sessionId })
    if (session.state !== 'ready') { entry.state = 'failed'; r.snapshot.inspectionFailures++; return }
    for (const t of session.tracks) if (t.match === 'recommended' && t.candidateIds[0]) await this.service.select({ sessionId: session.sessionId, trackId: t.trackId, candidateId: t.candidateIds[0] })
    const selected = (await this.service.readSession({ sessionId: session.sessionId })).tracks.some(t => t.selectedCandidateId !== null)
    const needsReview = session.tracks.some(t => t.match === 'review' || t.match === 'not-found')
    const failed = session.tracks.some(t => t.match === 'failed')
    const unknown = session.tracks.some(t => t.match === 'unknown')
    entry.unresolved = needsReview ? 'review' : failed ? 'failed' : unknown ? 'unknown' : null
    if (!selected) { entry.state = needsReview ? 'review' : failed ? 'failed' : unknown ? 'unknown' : 'saved'; if (failed) r.snapshot.inspectionFailures++; return }
    entry.saveRequest = { commandId: lyricsDigest(`${r.snapshot.jobId}:${entry.scope.albumId}`).slice(0, 40), sessionId: session.sessionId, embed: r.embed }
    await this.persist(r)
    await this.service.save(entry.saveRequest)
    await this.service.saves.wait(entry.saveRequest.commandId)
    const receipt = await this.service.receipt({ sessionId: entry.saveRequest.sessionId, commandId: entry.saveRequest.commandId })
    if (!receipt || receipt.state === 'unknown' || receipt.state === 'running') { entry.state = 'unknown'; return }
    entry.sidecars = receipt.tracks.filter(t => t.lrc === 'saved').length
    entry.embedded = receipt.tracks.filter(t => t.embed === 'saved').length
    entry.state = receipt.state !== 'complete' || receipt.snapshot === 'failed' ? 'failed' : needsReview ? 'review' : failed ? 'failed' : unknown ? 'unknown' : 'saved'
  }
  private async run(r: LocalLyricsJobRecord, c: LocalLyricsLibraryCapture, signal: AbortSignal, retry: Set<string> | null): Promise<void> {
    try {
      if (!r.enumerationComplete) { r.entries = await this.enumerate(c); r.snapshot.totalAlbums = r.entries.length; r.enumerationComplete = true }
      r.snapshot.state = 'running'; await this.persist(r)
      for (const entry of r.entries) {
        if (signal.aborted) break
        if (retry ? !retry.has(entry.scope.albumId) : entry.state !== 'pending' && entry.state !== 'unknown') continue
        await this.assert(c)
        try { await this.process(r, entry, signal, retry !== null) } catch { if (!signal.aborted) { entry.state = entry.saveRequest ? 'unknown' : 'failed'; r.snapshot.inspectionFailures++ } }
        this.recount(r); await this.persist(r)
      }
      this.recount(r)
      r.snapshot.state = signal.aborted ? 'stopped' : r.entries.every(e => e.state === 'saved') ? 'complete' : r.entries.some(e => e.state === 'unknown') ? 'unknown' : 'partial'
    } catch { r.snapshot.state = signal.aborted ? 'stopped' : 'failed' }
    finally {
      if (signal.aborted) for (const e of r.entries) { if (e.sessionId) await this.service.cancel({ sessionId: e.sessionId }).catch(() => {}); if (e.saveRequest) await this.service.saves.stop(e.saveRequest.commandId) }
      await this.persist(r)
    }
  }
  async read(jobId: string, albumId?: string): Promise<LocalLyricsJobSnapshot | null> {
    if (!isLocalLyricsCommandPayload('localLyrics.job.read', albumId === undefined ? { jobId } : { jobId, albumId })) throw new LocalLyricsError('INVALID')
    const r = await this.ports.journal.readJob(jobId)
    if (!r) return null
    const snapshot = lyricsClone(r.snapshot)
    if (albumId === undefined) return snapshot
    // 同SQL原entry保留专辑capture全scope；不从库capture或sourceRootId重建引用。
    const entry = r.entries.find(value => value.scope.albumId === albumId)
    const originalEntry = entry ? lyricsClone({ scope: entry.scope, sessionId: entry.sessionId, saveRequest: entry.saveRequest }) : null
    if (originalEntry !== null && (!isLocalLyricsJobOriginalEntry(originalEntry) || originalEntry.scope.datasetId !== snapshot.library.datasetId || originalEntry.scope.libraryId !== snapshot.library.libraryId)) throw new LocalLyricsError('CONFLICT')
    return { ...snapshot, originalEntry }
  }
  async stop(jobId: string): Promise<LocalLyricsJobSnapshot> {
    if (!isLocalLyricsCommandPayload('localLyrics.job.stop', { jobId })) throw new LocalLyricsError('INVALID')
    await this.accepting.get(jobId)
    const runner = this.running.get(jobId); runner?.controller.abort()
    const record = await this.ports.journal.readJob(jobId)
    if (!record) throw new LocalLyricsError('NOT_FOUND')
    for (const e of record.entries) { if (e.sessionId) await this.service.cancel({ sessionId: e.sessionId }).catch(() => {}); if (e.saveRequest) await this.service.saves.stop(e.saveRequest.commandId) }
    await runner?.work
    return (await this.read(jobId))!
  }
  async resume(jobId: string): Promise<LocalLyricsJobSnapshot> { return this.restart(jobId, null) }
  async retry(request: LocalLyricsJobRetryRequest): Promise<LocalLyricsJobSnapshot> {
    if (!isLocalLyricsCommandPayload('localLyrics.job.retry', request)) throw new LocalLyricsError('INVALID')
    return this.restart(request.jobId, new Set(request.albumIds))
  }
  private async restart(jobId: string, retry: Set<string> | null): Promise<LocalLyricsJobSnapshot> {
    this.ports.lifecycle.assertAccepting()
    if (this.closed || this.running.has(jobId) || this.restarting.has(jobId)) throw new LocalLyricsError('IN_FLIGHT')
    this.restarting.add(jobId)
    try {
      const loaded = await this.ports.journal.readJob(jobId)
      const r = loaded ? lyricsClone(loaded) : null
      if (!r) throw new LocalLyricsError('NOT_FOUND')
      if(this.retiredLibraries.has(r.snapshot.library.libraryId))throw new LocalLyricsError('CLOSED')
      if (retry && (!retry.size || [...retry].some(id => !r.snapshot.failedAlbumIds.includes(id)))) throw new LocalLyricsError('INVALID')
      const c = await this.ports.capture.captureLibrary(r.snapshot.library)
      if (c.watermark !== r.watermark || c.deadlineAtMs !== r.deadlineAtMs || lyricsLibraryKey(c.library) !== lyricsLibraryKey(r.snapshot.library)) throw new LocalLyricsError('STALE')
      await this.assert(c)
      this.launch(r, c, retry)
      return lyricsClone(r.snapshot)
    } finally { this.restarting.delete(jobId) }
  }
  async wait(jobId: string): Promise<void> { await this.accepting.get(jobId); await this.running.get(jobId)?.work }
  async revokeLibrary(libraryId:string,jobIds:readonly string[]):Promise<void>{
    this.retiredLibraries.add(libraryId)
    const accepting=[...this.acceptingLibraries].filter(([,root])=>root===libraryId).map(([id])=>id)
    await Promise.allSettled(accepting.map(id=>this.accepting.get(id)))
    for(const jobId of new Set([...jobIds,...accepting])){
      const original=await this.ports.journal.readJob(jobId)
      if(original){if(original.snapshot.library.libraryId!==libraryId)throw new LocalLyricsError('STALE');await this.stop(jobId)}
    }
  }
  async close(): Promise<void> { this.closed = true; await Promise.allSettled([...this.accepting.values()]); for (const r of this.running.values()) r.controller.abort(); await Promise.allSettled([...this.running.values()].map(r => r.work)); await this.ports.lifecycle.join() }
}
