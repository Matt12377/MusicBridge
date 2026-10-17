import { randomUUID } from 'node:crypto'
import { isLocalLyricsCommandPayload, isLocalLyricsCandidateDetail } from '@music-bridge/contracts'
import type { LocalLyricsSession, LocalLyricsQueryRequest, LocalLyricsSelectionRequest, LocalLyricsDetailRequest, LocalLyricsCandidateDetail, LocalLyricsSaveRequest, LocalLyricsReceiptRequest, LocalLyricsSessionRequest, LocalLyricsSaveReceipt, LocalLyricsDiscardRequest } from '@music-bridge/contracts'
import { LocalLyricsProviderSession } from './providers.js'
import type { LocalLyricsResolvedCandidate } from './providers.js'
import { LocalLyricsError, checkLyricsCapture, lyricsClone, lyricsDigest, lyricsCanonical, lyricsPresence, lyricsScopeKey } from './types.js'
import type { LocalLyricsPorts, LocalLyricsCapture, LocalLyricsSelectedBody } from './types.js'
import { LocalLyricsSaveCoordinator, assertLocalLyricsSaveRecord } from './save-coordinator.js'

interface SessionEntry { capture: LocalLyricsCapture; view: LocalLyricsSession; candidates: Map<string, LocalLyricsResolvedCandidate>; controller: AbortController; work: Promise<void>; commandIds: Set<string>; joinFailed:boolean }
export class LocalLyricsService {
  private readonly sessions = new Map<string, SessionEntry>()
  readonly saves: LocalLyricsSaveCoordinator
  private closed = false
  private readonly retiredLibraries=new Set<string>()
  private readonly preparing=new Map<Promise<LocalLyricsSession>,string>()
  constructor(private readonly ports: LocalLyricsPorts) { this.saves = new LocalLyricsSaveCoordinator(ports, id => this.selected(id)) }
  async query(request: LocalLyricsQueryRequest,parent?:AbortSignal):Promise<LocalLyricsSession>{
    if(!isLocalLyricsCommandPayload('localLyrics.query',request))throw new LocalLyricsError('INVALID')
    if(this.retiredLibraries.has(request.scope.libraryId))throw new LocalLyricsError('CLOSED')
    const work=this.queryOriginal(request,parent);this.preparing.set(work,request.scope.libraryId)
    try{return await work}finally{this.preparing.delete(work)}
  }
  private async queryOriginal(request: LocalLyricsQueryRequest, parent?: AbortSignal): Promise<LocalLyricsSession> {
    if (!isLocalLyricsCommandPayload('localLyrics.query', request)) throw new LocalLyricsError('INVALID')
    this.ports.lifecycle.assertAccepting()
    if (this.closed||this.retiredLibraries.has(request.scope.libraryId)) throw new LocalLyricsError('CLOSED')
    for (const [id, s] of this.sessions) if (s.view.state === 'stale' || s.view.state === 'cancelled') this.sessions.delete(id)
    if (this.sessions.size >= 32) throw new LocalLyricsError('BUDGET')
    const c = await this.ports.capture.capture(request.scope); checkLyricsCapture(c)
    await this.ports.capture.assertCurrent(c)
    if (this.closed||this.retiredLibraries.has(request.scope.libraryId)) throw new LocalLyricsError('CLOSED')
    if (lyricsScopeKey(c.scope) !== lyricsScopeKey(request.scope)) throw new LocalLyricsError('STALE')
    const pending = await this.ports.journal.pendingSaves(c.scope)
    for (const r of pending) assertLocalLyricsSaveRecord(r)
    const controller = new AbortController(), sessionId = randomUUID()
    const onAbort = (): void => controller.abort()
    parent?.addEventListener('abort', onAbort, { once: true }); if (parent?.aborted) controller.abort()
    const view: LocalLyricsSession = { sessionId, scope: lyricsClone(c.scope), state: 'querying', candidates: [], pendingOperations: pending.filter(r => !r.discarded).map(r => ({ request: lyricsClone(r.intent.request), receipt: lyricsClone(r.receipt) })), tracks: c.tracks.map(t => ({ trackId: t.trackId, title: t.title, presence: lyricsPresence(t.lrc, t.embedded), match: t.wholeTrack ? 'whole-track' : lyricsPresence(t.lrc, t.embedded) === 'true' ? 'existing' : 'unknown', candidateIds: [], selectedCandidateId: null, sources: [] })) }
    const entry: SessionEntry = { capture: c, view, candidates: new Map(), controller, work: Promise.resolve(), commandIds: new Set(),joinFailed:false }
    this.sessions.set(sessionId, entry)
    entry.work = this.runQuery(entry).finally(() => parent?.removeEventListener('abort', onAbort))
    void entry.work.catch(() => { /* 公开状态已闭集处理，不暴露Provider异常。 */ })
    return lyricsClone(view)
  }
  private async runQuery(s: SessionEntry): Promise<void> {
    const provider = new LocalLyricsProviderSession(this.ports.providers, () => this.ports.lifecycle.now())
    try {
      if(this.ports.capture.prepareQuery){
        const original=lyricsClone(s.capture.tracks),rows=await this.ports.capture.prepareQuery(s.capture,s.controller.signal)
        if(s.controller.signal.aborted){s.view.state='cancelled';return}
        const byId=new Map(rows.map(row=>[row.trackId,row]))
        if(rows.length!==original.length||byId.size!==original.length||lyricsCanonical(original)!==lyricsCanonical(s.capture.tracks)
          ||original.some(track=>byId.get(track.trackId)?.fileRevision!==track.fileRevision)
          ||rows.some(row=>!['unknown','false','true'].includes(row.lrc)||!['unknown','false','true'].includes(row.embedded)))throw new LocalLyricsError('STALE')
        s.capture.tracks=original.map(track=>({...track,lrc:byId.get(track.trackId)!.lrc,embedded:byId.get(track.trackId)!.embedded}))
        checkLyricsCapture(s.capture);await this.ports.capture.assertCurrent(s.capture)
        s.view.tracks=s.view.tracks.map(track=>{const current=s.capture.tracks.find(value=>value.trackId===track.trackId)!,presence=lyricsPresence(current.lrc,current.embedded)
          return {...track,presence,match:current.wholeTrack?'whole-track':presence==='true'?'existing':'unknown'}})
      }
      for (const [index, track] of s.capture.tracks.entries()) {
        if (s.controller.signal.aborted) { s.view.state = 'cancelled'; return }
        if (track.wholeTrack || lyricsPresence(track.lrc, track.embedded) === 'true') continue
        if (!s.capture.online) continue
        const r = await provider.track(track, s.controller.signal)
        await this.ports.capture.assertCurrent(s.capture)
        if (s.controller.signal.aborted) { s.view.state = 'cancelled'; return }
        const candidates = r.candidates.sort((a, b) => b.view.score - a.view.score)
        for (const c of candidates) s.candidates.set(c.view.candidateId, c)
        const top = candidates[0]
        const match = top ? top.view.score >= 95 && (candidates[1]?.view.score ?? -1) < top.view.score ? 'recommended' : 'review' : r.sources.every(p => p.state === 'ok') ? 'not-found' : r.sources.some(p => p.state === 'budget' || p.state === 'unavailable') ? 'unknown' : 'failed'
        s.view.tracks = s.view.tracks.map((t, i) => i === index ? { ...t, candidateIds: candidates.map(c => c.view.candidateId), match, sources: r.sources } : t)
      }
      await this.ports.capture.assertCurrent(s.capture)
      s.view.candidates = [...s.candidates.values()].map(c => c.view)
      s.view.state = s.controller.signal.aborted ? 'cancelled' : 'ready'
    } catch (error) { if(error instanceof LocalLyricsError&&error.code==='CLOSED')s.joinFailed=true; s.view.state = s.controller.signal.aborted ? 'cancelled' : 'stale'; s.candidates.clear(); s.view.candidates = []; s.view.tracks = s.view.tracks.map(t => ({ ...t, candidateIds: [], selectedCandidateId: null })) }
  }
  private get(id: string): SessionEntry { const s = this.sessions.get(id); if (!s) throw new LocalLyricsError('NOT_FOUND'); return s }
  async readSession(request: LocalLyricsSessionRequest): Promise<LocalLyricsSession> {
    if (!isLocalLyricsCommandPayload('localLyrics.session.read', request)) throw new LocalLyricsError('INVALID')
    const s = this.get(request.sessionId)
    try { await this.ports.capture.assertCurrent(s.capture) } catch { s.controller.abort(); await s.work; s.view.state = 'stale' }
    return lyricsClone(s.view)
  }
  async detail(request: LocalLyricsDetailRequest): Promise<LocalLyricsCandidateDetail> {
    if (!isLocalLyricsCommandPayload('localLyrics.detail', request)) throw new LocalLyricsError('INVALID')
    const s = this.get(request.sessionId)
    await this.ports.capture.assertCurrent(s.capture)
    if (s.view.state !== 'ready') throw new LocalLyricsError('STALE')
    const c = s.candidates.get(request.candidateId)
    if (!c) throw new LocalLyricsError('NOT_FOUND')
    const detail = { candidate: lyricsClone(c.view), body: c.body }
    if (!isLocalLyricsCandidateDetail(detail)) throw new LocalLyricsError('BUDGET')
    return detail
  }
  async select(request: LocalLyricsSelectionRequest): Promise<LocalLyricsSession> {
    if (!isLocalLyricsCommandPayload('localLyrics.select', request)) throw new LocalLyricsError('INVALID')
    const s = this.get(request.sessionId); await this.ports.capture.assertCurrent(s.capture)
    if (s.view.state !== 'ready') throw new LocalLyricsError('STALE')
    for (const commandId of s.commandIds) { const r = await this.saves.receipt({ sessionId: request.sessionId, commandId }); if (r && (r.state !== 'complete' || r.snapshot === 'failed' || r.snapshot === 'pending')) throw new LocalLyricsError('IN_FLIGHT') }
    const t = s.view.tracks.find(t => t.trackId === request.trackId)
    if (!t || t.match === 'existing' || t.match === 'whole-track' || (request.candidateId !== null && !t.candidateIds.includes(request.candidateId))) throw new LocalLyricsError('INVALID')
    s.view.tracks = s.view.tracks.map(t => t.trackId === request.trackId ? { ...t, selectedCandidateId: request.candidateId } : t)
    return lyricsClone(s.view)
  }
  private async selected(id: string): Promise<{ capture: LocalLyricsCapture; selected: LocalLyricsSelectedBody[] }> {
    const s = this.get(id); await this.ports.capture.assertCurrent(s.capture)
    if (s.view.state !== 'ready') throw new LocalLyricsError('STALE')
    const selected = s.view.tracks.filter(t => t.selectedCandidateId !== null).map(t => {
      const c = s.candidates.get(t.selectedCandidateId!)!, track = s.capture.tracks.find(x => x.trackId === t.trackId)!
      return { track: lyricsClone(track), candidateId: c.view.candidateId, source: c.view.source, body: c.body, sha256: lyricsDigest(c.body) }
    })
    return { capture: s.capture, selected }
  }
  async save(request: LocalLyricsSaveRequest): Promise<LocalLyricsSaveReceipt> { const r = await this.saves.save(request); this.sessions.get(request.sessionId)?.commandIds.add(request.commandId); return r }
  async receipt(request: LocalLyricsReceiptRequest): Promise<LocalLyricsSaveReceipt | null> { return this.saves.receipt(request) }
  async retrySave(request: LocalLyricsReceiptRequest): Promise<LocalLyricsSaveReceipt> { return this.saves.retry(request) }
  async retrySnapshot(request: LocalLyricsReceiptRequest): Promise<LocalLyricsSaveReceipt> { return this.saves.retrySnapshot(request) }
  async cancel(request: LocalLyricsSessionRequest): Promise<LocalLyricsSession> {
    if (!isLocalLyricsCommandPayload('localLyrics.cancel', request)) throw new LocalLyricsError('INVALID')
    const s = this.get(request.sessionId); s.controller.abort(); await s.work
    for (const id of s.commandIds) await this.saves.stop(id)
    s.view.state = 'cancelled'; return lyricsClone(s.view)
  }
  async canLeave(sessionId: string): Promise<boolean> {
    const s = this.get(sessionId)
    if (s.view.state === 'querying' || await this.ports.cover.hasPending(s.capture)) return false
    for (const r of await this.ports.journal.pendingSaves(s.capture.scope)) {
      assertLocalLyricsSaveRecord(r)
      if (!r.discarded && (r.receipt.state !== 'complete' || !r.physicalClosed || r.receipt.snapshot === 'failed' || r.receipt.snapshot === 'pending')) return false
    }
    const covered = new Set<string>()
    for (const commandId of s.commandIds) {
      const r = await this.receipt({ sessionId, commandId }); if (!r) return false
      const record = await this.ports.journal.readSave(commandId)
      if (record?.discarded && record.physicalClosed && r.state !== 'unknown' && r.state !== 'running') continue
      if (r.state !== 'complete' || r.snapshot === 'failed' || r.snapshot === 'pending') return false
      for (const selected of record?.intent.selected ?? []) covered.add(`${selected.track.trackId}/${selected.candidateId}`)
    }
    return s.view.tracks.every(t => t.selectedCandidateId === null || covered.has(`${t.trackId}/${t.selectedCandidateId}`))
  }
  async discard(request: LocalLyricsDiscardRequest): Promise<LocalLyricsSession | LocalLyricsSaveReceipt> {
    if (!isLocalLyricsCommandPayload('localLyrics.discard', request)) throw new LocalLyricsError('INVALID')
    if ('commandId' in request) { await this.saves.discard(request); return (await this.receipt(request))! }
    const s = this.get(request.sessionId)
    await this.cancel(request)
    for (const r of await this.ports.journal.pendingSaves(s.capture.scope)) {
      if (!r.discarded && r.intent.request.sessionId !== request.sessionId && (r.receipt.state !== 'complete' || !r.physicalClosed || r.receipt.snapshot === 'failed' || r.receipt.snapshot === 'pending')) throw new LocalLyricsError('IN_FLIGHT')
    }
    for (const id of s.commandIds) await this.saves.discard({ sessionId: request.sessionId, commandId: id })
    s.view.tracks = s.view.tracks.map(t => ({ ...t, selectedCandidateId: null }))
    return lyricsClone(s.view)
  }
  async wait(sessionId: string): Promise<void> { await this.get(sessionId).work }
  async revokeLibrary(libraryId:string,commandIds:readonly string[]):Promise<void>{
    this.retiredLibraries.add(libraryId)
    await Promise.allSettled([...this.preparing].filter(([,root])=>root===libraryId).map(([work])=>work))
    const selected=[...this.sessions.values()].filter(session=>session.capture.scope.libraryId===libraryId)
    for(const session of selected)session.controller.abort()
    await Promise.all(selected.map(session=>this.cancel({sessionId:session.view.sessionId})))
    for(const commandId of commandIds)await this.saves.stop(commandId)
    if(selected.some(session=>session.joinFailed))throw new LocalLyricsError('CLOSED')
    for(const session of selected)this.sessions.delete(session.view.sessionId)
  }
  async close(): Promise<void> { this.closed = true; for (const s of this.sessions.values()) s.controller.abort(); await Promise.allSettled([...this.sessions.values()].map(s => s.work)); await this.saves.close(); this.sessions.clear() }
}
