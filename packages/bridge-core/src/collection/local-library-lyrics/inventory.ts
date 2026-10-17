import { isLocalLyricsCommandPayload, isLocalLyricsId } from '@music-bridge/contracts'
import type { LocalLyricsInventoryRequest, LocalLyricsInventoryPage, LocalLyricsScope, LocalLyricsPresence } from '@music-bridge/contracts'
import { LocalLyricsError, checkLyricsCapture, lyricsPresence, lyricsClone } from './types.js'
import type { LocalLyricsPorts } from './types.js'

export class LocalLyricsInventory {
  constructor(private readonly ports: LocalLyricsPorts) {}
  async observe(scope: LocalLyricsScope, signal = new AbortController().signal): Promise<LocalLyricsPresence> {
    this.ports.lifecycle.assertAccepting()
    const c = await this.ports.capture.capture(scope); checkLyricsCapture(c)
    await this.ports.capture.assertCurrent(c)
    if (signal.aborted) throw new LocalLyricsError('CLOSED')
    const rows = await this.ports.inventory.inspect(c, signal)
    if (signal.aborted) throw new LocalLyricsError('CLOSED')
    const byId = new Map(c.tracks.map(t => [t.trackId, t]))
    if (rows.length !== c.tracks.length || new Set(rows.map(r => r.trackId)).size !== rows.length || rows.some(r => !byId.has(r.trackId) || byId.get(r.trackId)!.fileRevision !== r.fileRevision || !['unknown', 'false', 'true'].includes(r.lrc) || !['unknown', 'false', 'true'].includes(r.embedded))) throw new LocalLyricsError('STALE')
    await this.ports.capture.assertCurrent(c)
    await this.ports.inventory.persist(c, rows)
    const facts = rows.map(r => lyricsPresence(r.lrc, r.embedded))
    if (!facts.length) return 'unknown'
    return facts.every(x => x === 'true') && facts.length > 0 ? 'true' : facts.some(x => x === 'unknown') ? 'unknown' : 'false'
  }
  async page(request: LocalLyricsInventoryRequest): Promise<LocalLyricsInventoryPage> {
    if (!isLocalLyricsCommandPayload('localLyrics.inventory', request)) throw new LocalLyricsError('INVALID')
    this.ports.lifecycle.assertAccepting()
    const c = await this.ports.capture.captureLibrary(request.library)
    await this.ports.capture.assertLibraryCurrent(c)
    const p = await this.ports.inventory.page(request.library, request.filter, request.offset, request.limit)
    if (p.watermark !== c.watermark || !Number.isSafeInteger(p.total) || p.total < 0 || p.rows.length !== Math.min(request.limit, Math.max(0, p.total - request.offset)) || new Set(p.rows.map(r => r.albumId)).size !== p.rows.length || p.rows.some(r => !isLocalLyricsId(r.albumId) || !['unknown', 'false', 'true'].includes(r.presence) || (request.filter === 'missingLyrics' && r.presence !== 'false'))) throw new LocalLyricsError('STALE')
    await this.ports.capture.assertLibraryCurrent(c)
    return lyricsClone({ total: p.total, watermark: p.watermark, rows: p.rows.map(r => ({ albumId: r.albumId, presence: r.presence })), offset: request.offset })
  }
}
