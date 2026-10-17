import { isLocalLyricsCommandPayload, isLocalLyricsSafeText, isLocalLyricsScope, LOCAL_LYRICS_LIMITS, LOCAL_LYRICS_SOURCES } from '@music-bridge/contracts'
import type { LocalLyricsSaveRequest, LocalLyricsReceiptRequest, LocalLyricsSaveReceipt, LocalLyricsWriteState } from '@music-bridge/contracts'
import { LocalLyricsError, lyricsClone, lyricsDigest, lyricsCanonical } from './types.js'
import type { LocalLyricsCapture, LocalLyricsPorts, LocalLyricsSaveIntent, LocalLyricsSaveRecord, LocalLyricsSelectedBody, LocalLyricsProtectedWriteResult } from './types.js'

export function localLyricsIntentFingerprint(intent: Omit<LocalLyricsSaveIntent, 'fingerprint'>): string {
  return lyricsDigest(lyricsCanonical({ request: { sessionId: intent.request.sessionId, commandId: intent.request.commandId, embed: intent.request.embed }, scope: { datasetId: intent.scope.datasetId, libraryId: intent.scope.libraryId, albumId: intent.scope.albumId, captureId: intent.scope.captureId }, captureFingerprint: intent.captureFingerprint, selected: intent.selected }))
}
const states: readonly LocalLyricsWriteState[] = ['not-requested', 'pending', 'saved', 'existing', 'failed', 'unknown', 'cancelled']
const exact = (v: object, keys: readonly string[]): boolean => Reflect.ownKeys(v).length === keys.length && keys.every(k => Object.getOwnPropertyDescriptor(v, k)?.value !== undefined)
export function assertLocalLyricsSaveRecord(record: LocalLyricsSaveRecord): void {
  const i = record.intent
  if (!exact(record, ['intent', 'receipt', 'revision', 'physicalClosed', 'discarded']) || typeof record.discarded !== 'boolean' || (record.discarded && (!record.physicalClosed || record.receipt.state === 'unknown' || record.receipt.state === 'running')) || !exact(i, ['request', 'scope', 'captureFingerprint', 'selected', 'fingerprint']) || !exact(record.receipt, ['commandId', 'sessionId', 'state', 'cover', 'tracks', 'snapshot']) || !isLocalLyricsScope(i.scope) || !['running', 'complete', 'partial', 'unknown', 'cancelled', 'failed'].includes(record.receipt.state) || !states.includes(record.receipt.cover) || !['not-requested', 'pending', 'saved', 'failed'].includes(record.receipt.snapshot) || record.receipt.tracks.some(t => !exact(t, ['trackId', 'lrc', 'embed']) || !states.includes(t.lrc) || !states.includes(t.embed))) throw new LocalLyricsError('CONFLICT')
  if (!isLocalLyricsCommandPayload('localLyrics.save', i.request) || i.fingerprint !== localLyricsIntentFingerprint(i) || record.receipt.commandId !== i.request.commandId || record.receipt.sessionId !== i.request.sessionId || record.receipt.tracks.length !== i.selected.length || i.selected.length > 10000 || new Set(i.selected.map(s => s.track.trackId)).size !== i.selected.length || !Number.isSafeInteger(record.revision) || record.revision < 0 || typeof record.physicalClosed !== 'boolean') throw new LocalLyricsError('CONFLICT')
  let bytes = 0
  for (const [index, s] of i.selected.entries()) {
    if (!exact(s, ['track', 'candidateId', 'source', 'body', 'sha256']) || !LOCAL_LYRICS_SOURCES.includes(s.source) || !isLocalLyricsSafeText(s.body, LOCAL_LYRICS_LIMITS.bodyBytes, true) || !s.body.trim() || s.sha256 !== lyricsDigest(s.body) || record.receipt.tracks[index]?.trackId !== s.track.trackId) throw new LocalLyricsError('CONFLICT')
    bytes += Buffer.byteLength(s.body)
  }
  if (bytes > LOCAL_LYRICS_LIMITS.sessionBodyBytes) throw new LocalLyricsError('BUDGET')
}
const saved = (state: LocalLyricsWriteState): boolean => state === 'saved' || state === 'existing' || state === 'not-requested'
export class LocalLyricsSaveCoordinator {
  private readonly running = new Map<string, { controller: AbortController; promise: Promise<void> }>()
  private readonly accepting = new Map<string, Promise<LocalLyricsSaveReceipt>>()
  private closed = false
  constructor(private readonly ports: LocalLyricsPorts, private readonly resolve: (sessionId: string) => Promise<{ capture: LocalLyricsCapture; selected: LocalLyricsSelectedBody[] }>) {}
  async save(request: LocalLyricsSaveRequest): Promise<LocalLyricsSaveReceipt> {
    if (!isLocalLyricsCommandPayload('localLyrics.save', request)) throw new LocalLyricsError('INVALID')
    const pending = this.accepting.get(request.commandId)
    if (pending) { await pending; return this.save(request) }
    const work = this.accept(request)
    this.accepting.set(request.commandId, work)
    try { return await work } finally { this.accepting.delete(request.commandId) }
  }
  private async accept(request: LocalLyricsSaveRequest): Promise<LocalLyricsSaveReceipt> {
    this.ports.lifecycle.assertAccepting()
    if (this.closed) throw new LocalLyricsError('CLOSED')
    const existing = await this.ports.journal.readSave(request.commandId)
    if (existing) {
      assertLocalLyricsSaveRecord(existing)
      if (existing.intent.request.sessionId !== request.sessionId || existing.intent.request.embed !== request.embed) throw new LocalLyricsError('CONFLICT')
      return (await this.receipt({ sessionId: request.sessionId, commandId: request.commandId }))!
    }
    const { capture, selected } = await this.resolve(request.sessionId)
    await this.ports.capture.assertCurrent(capture)
    const pending = await this.ports.journal.pendingSaves(capture.scope)
    if (Buffer.byteLength(lyricsCanonical(pending)) > 32 * 1024 * 1024) throw new LocalLyricsError('BUDGET')
    for (const r of pending) {
      assertLocalLyricsSaveRecord(r)
      if (r.intent.scope.datasetId !== capture.scope.datasetId || r.intent.scope.libraryId !== capture.scope.libraryId || r.intent.scope.albumId !== capture.scope.albumId) throw new LocalLyricsError('CONFLICT')
      if (!r.discarded && r.intent.request.commandId !== request.commandId && (r.receipt.state !== 'complete' || !r.physicalClosed || r.receipt.snapshot === 'failed' || r.receipt.snapshot === 'pending')) throw new LocalLyricsError('IN_FLIGHT')
    }
    if (!selected.length) throw new LocalLyricsError('INVALID')
    if (request.embed && selected.some(s => s.track.format !== 'wav' && s.track.format !== 'flac')) throw new LocalLyricsError('INVALID')
    const draft = { request: lyricsClone(request), scope: lyricsClone(capture.scope), captureFingerprint: capture.fingerprint, selected: lyricsClone(selected) }
    const record: LocalLyricsSaveRecord = {
      intent: { ...draft, fingerprint: localLyricsIntentFingerprint(draft) }, revision: 0, physicalClosed: false, discarded: false,
      receipt: { commandId: request.commandId, sessionId: request.sessionId, state: 'running', cover: 'pending', snapshot: 'not-requested', tracks: selected.map(s => ({ trackId: s.track.trackId, lrc: 'pending', embed: request.embed ? 'pending' : 'not-requested' })) },
    }
    assertLocalLyricsSaveRecord(record)
    await this.ports.journal.save(lyricsClone(record), null)
    this.launch(record, capture, false)
    return lyricsClone(record.receipt)
  }
  private launch(record: LocalLyricsSaveRecord, capture: LocalLyricsCapture, retry: boolean): void {
    record.physicalClosed = false
    const controller = new AbortController()
    if (this.closed) controller.abort()
    // 调用run前先注册，防同步端口触发重复请求。
    const promise = Promise.resolve().then(() => this.run(record, capture, controller.signal, retry)).finally(() => this.running.delete(record.intent.request.commandId))
    this.running.set(record.intent.request.commandId, { controller, promise })
    void promise.catch(() => { /* 原账保留；查询只读原回执，错误不进入公开文本。 */ })
  }
  private async persist(record: LocalLyricsSaveRecord): Promise<void> {
    const before = record.revision
    record.revision++
    await this.ports.journal.save(lyricsClone(record), before)
  }
  private checkedOutcome(result: LocalLyricsProtectedWriteResult, selected: LocalLyricsSelectedBody): LocalLyricsWriteState {
    if (!['saved', 'existing', 'failed', 'unknown', 'cancelled'].includes(result.state)) throw new LocalLyricsError('CONFLICT')
    if ((result.state === 'saved' || result.state === 'existing') && result.bodySha256 !== selected.sha256) return 'failed'
    return result.state
  }
  private finish(record: LocalLyricsSaveRecord): void {
    const states = [record.receipt.cover, ...record.receipt.tracks.flatMap(t => [t.lrc, t.embed])]
    record.receipt.state = states.includes('unknown') ? 'unknown' : states.every(saved) ? record.physicalClosed ? 'complete' : 'running' : states.some(saved) || states.includes('pending') ? 'partial' : states.includes('cancelled') ? 'cancelled' : 'failed'
  }
  private async run(record: LocalLyricsSaveRecord, capture: LocalLyricsCapture, signal: AbortSignal, retry: boolean): Promise<void> {
    try {
      await this.ports.capture.assertCurrent(capture, record.intent.request.commandId)
      if (capture.fingerprint !== record.intent.captureFingerprint || signal.aborted) throw new LocalLyricsError('STALE')
      if (!retry) {
        // 先持久unknown再调用外部writer，冷恢复不得把未确认的调用再发一遍。
        record.receipt.cover = 'unknown'; await this.persist(record)
        const cover = await this.ports.cover.save(capture, record.intent.request.commandId, signal)
        record.receipt.cover = states.includes(cover) ? cover : 'unknown'
        await this.persist(record)
      }
      if (!saved(record.receipt.cover)) { this.finish(record); await this.persist(record); return }
      for (const [index, selected] of record.intent.selected.entries()) {
        const row = record.receipt.tracks[index]!
        for (const kind of ['lrc', 'embed'] as const) {
          if (saved(row[kind]) || row[kind] === 'cancelled') continue
          if (kind === 'embed' && !saved(row.lrc)) continue
          if (signal.aborted) { row[kind] = 'cancelled'; await this.persist(record); continue }
          const retryFailure = retry && row[kind] === 'failed'
          if (retry) {
            if (!retryFailure && row[kind] !== 'pending') continue
          }
          if (retryFailure) {
            const original = await this.ports.writer.readOriginal(kind, record.intent, selected)
            if (!original || original.state !== 'failed') { row[kind] = original ? this.checkedOutcome(original, selected) : 'unknown'; await this.persist(record); continue }
          }
          row[kind] = 'unknown'; await this.persist(record)
          try {
            const r = retryFailure ? await this.ports.writer.retryFailed(kind, record.intent, selected, signal) : await this.ports.writer.write(kind, record.intent, selected, signal)
            row[kind] = this.checkedOutcome(r, selected)
          } catch { row[kind] = 'unknown' }
          await this.persist(record)
        }
      }
      this.finish(record)
      if (record.receipt.tracks.some(t => t.lrc === 'saved' || t.embed === 'saved')) {
        record.receipt.snapshot = 'pending'; await this.persist(record)
        try { const result = await this.ports.inventory.snapshot(capture, record.intent.request.commandId); record.receipt.snapshot = result === 'saved' ? 'saved' : 'failed' } catch { record.receipt.snapshot = 'failed' }
      }
      await this.persist(record)
    } catch {
      this.finish(record)
      if (record.receipt.state === 'complete') record.receipt.state = 'unknown'
      await this.persist(record)
    } finally {
      try { await this.ports.writer.join(record.intent.request.commandId); record.physicalClosed = true; this.finish(record) }
      catch { record.physicalClosed = false; record.receipt.state = 'unknown' }
      await this.persist(record)
    }
  }
  async receipt(request: LocalLyricsReceiptRequest): Promise<LocalLyricsSaveReceipt | null> {
    if (!isLocalLyricsCommandPayload('localLyrics.receipt', request)) throw new LocalLyricsError('INVALID')
    const loaded = await this.ports.journal.readSave(request.commandId)
    const record = loaded ? lyricsClone(loaded) : null
    if (!record) return null
    assertLocalLyricsSaveRecord(record)
    if (record.intent.request.sessionId !== request.sessionId) throw new LocalLyricsError('CONFLICT')
    if (this.running.has(request.commandId)) return lyricsClone({ ...record.receipt, state: 'running' })
    const before = JSON.stringify(record.receipt), beforeClosed = record.physicalClosed
    if (record.receipt.cover === 'unknown' || record.receipt.cover === 'pending' || record.receipt.cover === 'failed') {
      const capture = await this.ports.capture.capture(record.intent.scope)
      record.receipt.cover = await this.ports.cover.readOriginal(capture, request.commandId) ?? 'unknown'
    }
    if (!record.physicalClosed) {
      try { await this.ports.writer.join(request.commandId); record.physicalClosed = true }
      catch { record.receipt.state = 'unknown'; await this.persist(record); return lyricsClone(record.receipt) }
    }
    for (const [index, selected] of record.intent.selected.entries()) {
      for (const kind of ['lrc', 'embed'] as const) {
        const row = record.receipt.tracks[index]!
        if (row[kind] !== 'unknown') continue
        const original = await this.ports.writer.readOriginal(kind, record.intent, selected)
        row[kind] = original ? this.checkedOutcome(original, selected) : 'unknown'
      }
    }
    if (record.receipt.snapshot === 'not-requested' && record.receipt.tracks.some(t => t.lrc === 'saved' || t.embed === 'saved')) record.receipt.snapshot = 'pending'
    this.finish(record)
    // 原读回事实也由Owner CAS持久化，绝不重发写源。
    if (before !== JSON.stringify(record.receipt) || beforeClosed !== record.physicalClosed) await this.persist(record)
    return lyricsClone(record.receipt)
  }
  async retry(request: LocalLyricsReceiptRequest): Promise<LocalLyricsSaveReceipt> {
    if (!isLocalLyricsCommandPayload('localLyrics.save.retry', request)) throw new LocalLyricsError('INVALID')
    if (this.running.has(request.commandId)) throw new LocalLyricsError('IN_FLIGHT')
    await this.receipt(request)
    const loaded = await this.ports.journal.readSave(request.commandId)
    const record = loaded ? lyricsClone(loaded) : null
    if (!record) throw new LocalLyricsError('NOT_FOUND')
    assertLocalLyricsSaveRecord(record)
    if (record.discarded) throw new LocalLyricsError('STALE')
    if (record.receipt.state === 'unknown' || record.receipt.state === 'running' || !saved(record.receipt.cover)) return lyricsClone(record.receipt)
    const c = await this.ports.capture.capture(record.intent.scope, record.intent.request.commandId)
    await this.ports.capture.assertCurrent(c, record.intent.request.commandId)
    if (c.fingerprint !== record.intent.captureFingerprint) throw new LocalLyricsError('STALE')
    this.launch(record, c, true)
    return lyricsClone(record.receipt)
  }
  async retrySnapshot(request: LocalLyricsReceiptRequest): Promise<LocalLyricsSaveReceipt> {
    if (!isLocalLyricsCommandPayload('localLyrics.snapshot.retry', request)) throw new LocalLyricsError('INVALID')
    if (this.running.has(request.commandId)) throw new LocalLyricsError('IN_FLIGHT')
    const loaded = await this.ports.journal.readSave(request.commandId)
    const record = loaded ? lyricsClone(loaded) : null
    if (!record || record.intent.request.sessionId !== request.sessionId) throw new LocalLyricsError('NOT_FOUND')
    assertLocalLyricsSaveRecord(record)
    if (record.discarded) throw new LocalLyricsError('STALE')
    if (record.receipt.snapshot !== 'failed' && record.receipt.snapshot !== 'pending') return lyricsClone(record.receipt)
    const c = await this.ports.capture.capture(record.intent.scope, record.intent.request.commandId)
    await this.ports.capture.assertCurrent(c, record.intent.request.commandId)
    const snapshot = await this.ports.inventory.snapshot(c, request.commandId)
    record.receipt.snapshot = snapshot === 'saved' ? 'saved' : 'failed'
    await this.persist(record)
    return lyricsClone(record.receipt)
  }
  async discard(request: LocalLyricsReceiptRequest): Promise<void> {
    await this.stop(request.commandId)
    await this.receipt(request)
    const loaded = await this.ports.journal.readSave(request.commandId)
    if (!loaded || loaded.intent.request.sessionId !== request.sessionId) throw new LocalLyricsError('NOT_FOUND')
    const r = lyricsClone(loaded); assertLocalLyricsSaveRecord(r)
    if (!r.physicalClosed || r.receipt.state === 'unknown' || r.receipt.state === 'running') throw new LocalLyricsError('IN_FLIGHT')
    r.discarded = true; await this.persist(r)
  }
  async wait(commandId: string): Promise<void> { await this.accepting.get(commandId); await this.running.get(commandId)?.promise }
  async stop(commandId: string): Promise<void> { await this.accepting.get(commandId); this.running.get(commandId)?.controller.abort(); await this.wait(commandId) }
  async close(): Promise<void> { this.closed = true; await Promise.allSettled([...this.accepting.values()]); for (const r of this.running.values()) r.controller.abort(); await Promise.allSettled([...this.running.values()].map(r => r.promise)); await this.ports.lifecycle.join() }
}
