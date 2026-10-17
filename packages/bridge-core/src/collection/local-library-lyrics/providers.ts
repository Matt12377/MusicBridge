import { randomUUID } from 'node:crypto'
import { LOCAL_LYRICS_LIMITS, LOCAL_LYRICS_SOURCES, isLocalLyricsSafeText, isLocalLyricsCandidateDetail } from '@music-bridge/contracts'
import type { LocalLyricsCandidate, LocalLyricsSource, LocalLyricsSourceResult, LocalLyricsVersion } from '@music-bridge/contracts'
import { LocalLyricsError, lyricsAbort } from './types.js'
import type { LocalLyricsProviderTransportPort, LocalLyricsTrackCapture } from './types.js'

interface Song { id: string; title: string; artist: string; album: string; durationMs: number | null; language: string; version: LocalLyricsVersion; body: string | null }
export interface LocalLyricsResolvedCandidate { view: LocalLyricsCandidate; body: string }
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : []
const text = (v: unknown): string => typeof v === 'string' ? v : ''
const seconds = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v * 1000) : null
const millis = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null
const names = (v: unknown): string => list(v).map(x => text(record(x).name)).join(' / ')
const version = (title: string): LocalLyricsVersion => /\blive\b|现场/iu.test(title) ? 'live' : /remix|混音/iu.test(title) ? 'remix' : /instrumental|伴奏|纯音乐/iu.test(title) ? 'instrumental' : 'original'
const normalized = (v: string): string => v.normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/gu, ' ').trim()
function decodedBase64(v: unknown): string {
  if (typeof v !== 'string' || v.length > LOCAL_LYRICS_LIMITS.sourceRawBytes * 2 || /[^A-Za-z0-9+/=]/u.test(v)) throw new LocalLyricsError('INVALID')
  const b = Buffer.from(v, 'base64')
  if (b.toString('base64') !== v) throw new LocalLyricsError('INVALID')
  return new TextDecoder('utf-8', { fatal: true }).decode(b)
}
function song(id: unknown, title: unknown, artist: unknown, album: unknown, durationMs: number | null, body: string | null, language: unknown): Song {
  const i = typeof id === 'number' && Number.isSafeInteger(id) ? String(id) : text(id)
  const t = text(title), a = text(artist), al = text(album), lang = text(language)
  if (!/^[A-Za-z0-9_-]{1,160}$/u.test(i) || !t.trim() || !a.trim() || ![t, a, al, lang].every(x => isLocalLyricsSafeText(x, 2048))) throw new LocalLyricsError('INVALID')
  return { id: i, title: t, artist: a, album: al, durationMs, language: lang, version: version(t), body }
}
/** 原始响应只在私有transport边界解析，外部Provider身份与URL不进入候选展示。 */
export function parseLocalLyricsSearch(source: LocalLyricsSource, raw: unknown): Song[] {
  const r = record(raw)
  const shape = source === 'netease' ? record(r.result).songs : source === 'qq' ? record(record(r.data).song).list : source === 'kugou' ? record(r.data).info : source === 'kuwo' ? record(r.data).list : raw
  if (!Array.isArray(shape)) throw new LocalLyricsError('INVALID')
  switch (source) {
    case 'netease': return list(record(r.result).songs).map(v => { const x = record(v); return song(x.id, x.name, names(x.ar ?? x.artists), record(x.al ?? x.album).name, millis(x.dt ?? x.duration), null, x.language) })
    case 'qq': return list(record(record(r.data).song).list).map(v => { const x = record(v); return song(x.mid ?? x.songmid, x.name ?? x.songname, names(x.singer), record(x.album).name ?? x.albumname, seconds(x.interval), null, x.language) })
    case 'kugou': return list(record(r.data).info).map(v => { const x = record(v); return song(x.hash, x.songname, x.singername, x.album_name, seconds(x.duration), null, x.language) })
    case 'kuwo': return list(record(r.data).list).map(v => { const x = record(v); return song(x.rid, x.name, x.artist, x.album, seconds(x.duration), null, x.language) })
    case 'lrclib': return list(raw).filter(v => record(v).instrumental !== true).map(v => { const x = record(v); return song(x.id, x.trackName, x.artistName, x.albumName, seconds(x.duration), text(x.syncedLyrics || x.plainLyrics) || null, x.language) })
  }
}
export function parseLocalLyricsBody(source: LocalLyricsSource, raw: unknown): string {
  const r = record(raw)
  switch (source) {
    case 'netease': { const body=record(r.lrc).lyric; if(typeof body!=='string')throw new LocalLyricsError('INVALID');return body }
    case 'qq': {
      // QQ明确的单首无词不是来源失败；相反状态携正文仍是坏协议，不能吞掉。
      if(r.code===-1901){if(Object.hasOwn(r,'lyric')&&r.lyric!==null&&r.lyric!=='')throw new LocalLyricsError('INVALID');return ''}
      if(Object.hasOwn(r,'code')&&r.code!==0)throw new LocalLyricsError('INVALID');return decodedBase64(r.lyric)
    }
    case 'kugou': return decodedBase64(r.content)
    case 'kuwo': { const lines=record(r.data).lrclist;if(!Array.isArray(lines))throw new LocalLyricsError('INVALID');return lines.map(v => { const x = record(v); const t = Number(x.time); if (!Number.isFinite(t) || t < 0 || typeof x.lineLyric!=='string') throw new LocalLyricsError('INVALID'); return `[${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(2).padStart(5, '0')}]${text(x.lineLyric)}` }).join('\n') }
    case 'lrclib': { if(r.instrumental===true)return '';if(typeof r.syncedLyrics!=='string'&&typeof r.plainLyrics!=='string')throw new LocalLyricsError('INVALID');return text(r.syncedLyrics)||text(r.plainLyrics) }
  }
}
export function localLyricsMatchScore(track: LocalLyricsTrackCapture, s: Pick<Song, 'title' | 'artist' | 'album' | 'durationMs' | 'language' | 'version'>): number {
  if (normalized(track.title) !== normalized(s.title) || normalized(track.artist) !== normalized(s.artist)) return 0
  if (track.version !== 'unknown' && track.version !== s.version) return 0
  if (track.language && s.language && normalized(track.language) !== normalized(s.language)) return 0
  if (track.durationMs !== null && s.durationMs !== null && Math.abs(track.durationMs - s.durationMs) > 3000) return 0
  let score = 70
  if (track.album && normalized(track.album) === normalized(s.album)) score += 10
  if (track.durationMs !== null && s.durationMs !== null) score += 10
  if (!track.language || normalized(track.language) === normalized(s.language)) score += 5
  if (track.version !== 'unknown' && track.version === s.version) score += 5
  return score
}

/** 预算属于整个album session，而不是每曲、每请求重置。 */
export class LocalLyricsProviderSession {
  private readonly budgets = new Map<LocalLyricsSource, { raw: number; count: number; deadline: number }>()
  private bodyBytes = 0
  constructor(private readonly transport: LocalLyricsProviderTransportPort, private readonly now: () => number) {}
  async track(track: LocalLyricsTrackCapture, parent: AbortSignal): Promise<{ candidates: LocalLyricsResolvedCandidate[]; sources: LocalLyricsSourceResult[] }> {
    const settled = await Promise.allSettled(LOCAL_LYRICS_SOURCES.map(async source => {
      const b = this.budgets.get(source) ?? { raw: 0, count: 0, deadline: this.now() + LOCAL_LYRICS_LIMITS.providerMs }
      this.budgets.set(source, b)
      const remaining = b.deadline - this.now()
      if (b.count >= LOCAL_LYRICS_LIMITS.candidatesPerSource || remaining <= 0) return { source, state: 'budget' as const, candidates: [] }
      const abort = lyricsAbort(parent, remaining), signal = abort.controller.signal
      const candidates: LocalLyricsResolvedCandidate[] = []
      let state: LocalLyricsSourceResult['state'] = 'ok'
      const request = async (operation: 'search' | 'body', input: Parameters<LocalLyricsProviderTransportPort['request']>[2]): Promise<unknown> => {
        if (signal.aborted || this.now() >= b.deadline) throw new LocalLyricsError('BUDGET')
        // 先采wall，再读原单源剩余时钟；Main不必从每轨的新signal猜另一个15秒。
        const wallNow=Date.now(),remainingMs=Math.max(0,Math.floor(b.deadline-this.now())),expiresAtMs=wallNow+remainingMs
        if(!Number.isSafeInteger(wallNow)||wallNow<0||!Number.isSafeInteger(remainingMs)||remainingMs<1||remainingMs>LOCAL_LYRICS_LIMITS.providerMs
          ||!Number.isSafeInteger(expiresAtMs)||expiresAtMs<=wallNow)throw new LocalLyricsError('BUDGET')
        const raw = await this.transport.request(source, operation, input, signal,{expiresAtMs})
        if (signal.aborted || this.now() >= b.deadline) throw new LocalLyricsError('BUDGET')
        b.raw += raw.byteLength
        if (b.raw > LOCAL_LYRICS_LIMITS.sourceRawBytes) throw new LocalLyricsError('BUDGET')
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as unknown
      }
      try {
        const songs = parseLocalLyricsSearch(source, await request('search', { title: track.title, artist: track.artist, album: track.album, language: track.language, version: track.version, durationMs: track.durationMs }))
        for (const s of songs) {
          if (b.count >= LOCAL_LYRICS_LIMITS.candidatesPerSource) { state = 'budget'; break }
          const score = localLyricsMatchScore(track, s)
          if (!score) continue
          const body = s.body ?? parseLocalLyricsBody(source, await request('body', { id: s.id }))
          if(body==='')continue // 明确空正文不占候选预算；下一请求仍沿用同一raw/期限账本。
          if (!body.trim() || !isLocalLyricsSafeText(body, LOCAL_LYRICS_LIMITS.bodyBytes, true)) throw new LocalLyricsError('INVALID')
          const bytes = Buffer.byteLength(body)
          if (this.bodyBytes + bytes > LOCAL_LYRICS_LIMITS.sessionBodyBytes) throw new LocalLyricsError('BUDGET')
          const candidate = { view: { candidateId: randomUUID(), trackId: track.trackId, source, title: s.title, artist: s.artist, album: s.album, durationMs: s.durationMs, language: s.language, version: s.version, score }, body }
          if (!isLocalLyricsCandidateDetail({ candidate: candidate.view, body })) throw new LocalLyricsError('BUDGET')
          this.bodyBytes += bytes; b.count++
          candidates.push(candidate)
        }
      } catch (e) { state = parent.aborted ? 'cancelled' : signal.aborted || this.now() >= b.deadline || e instanceof LocalLyricsError && e.code === 'BUDGET' ? 'budget' : 'failed' }
      finally { abort.dispose(); abort.controller.abort(); await this.transport.join(signal) }
      return { source, state, candidates }
    }))
    if (settled.some(r => r.status === 'rejected')) throw new LocalLyricsError('CLOSED')
    const results = settled.flatMap(r => r.status === 'fulfilled' ? [r.value] : [])
    return { candidates: results.flatMap(r => r.candidates), sources: results.map(({ source, state }) => ({ source, state })) }
  }
}
