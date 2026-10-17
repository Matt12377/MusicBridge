/** 整理工作台歌词合同；捕获引用、候选与回执不构成源文件写权限。 */
export const LOCAL_LYRICS_SOURCES = ['netease', 'qq', 'kugou', 'kuwo', 'lrclib'] as const
export type LocalLyricsSource = typeof LOCAL_LYRICS_SOURCES[number]
export const LOCAL_LYRICS_LIMITS = Object.freeze({
  candidatesPerSource: 12, candidates: 60, sourceRawBytes: 1024 * 1024,
  bodyBytes: 64 * 1024, sessionBodyBytes: 8 * 1024 * 1024,
  publicDetailBytes: 128 * 1024, providerMs: 15000, ownerMs: 2000,
})
export type LocalLyricsPresence = 'unknown' | 'false' | 'true'
export type LocalLyricsVersion = 'original' | 'live' | 'remix' | 'instrumental' | 'unknown'
export interface LocalLyricsScope { datasetId: string; libraryId: string; albumId: string; captureId: string }
export interface LocalLyricsQueryRequest { scope: LocalLyricsScope }
export interface LocalLyricsSelectionRequest { sessionId: string; trackId: string; candidateId: string | null }
export interface LocalLyricsDetailRequest { sessionId: string; candidateId: string }
export interface LocalLyricsSaveRequest { sessionId: string; commandId: string; embed: boolean }
export interface LocalLyricsReceiptRequest { sessionId: string; commandId: string }
export interface LocalLyricsCancelRequest { sessionId: string }
export interface LocalLyricsSessionRequest { sessionId: string }
export type LocalLyricsDiscardRequest = LocalLyricsSessionRequest | LocalLyricsReceiptRequest
export interface LocalLyricsCandidate {
  candidateId: string; trackId: string; source: LocalLyricsSource
  title: string; artist: string; album: string; durationMs: number | null
  language: string; version: LocalLyricsVersion; score: number
}
export interface LocalLyricsCandidateDetail { candidate: LocalLyricsCandidate; body: string }
export interface LocalLyricsSourceResult { source: LocalLyricsSource; state: 'ok' | 'failed' | 'unavailable' | 'budget' | 'cancelled' }
export interface LocalLyricsTrackView {
  trackId: string; title: string; presence: LocalLyricsPresence
  match: 'existing' | 'whole-track' | 'recommended' | 'review' | 'not-found' | 'failed' | 'unknown'
  candidateIds: readonly string[]; selectedCandidateId: string | null
  sources: readonly LocalLyricsSourceResult[]
}
export interface LocalLyricsSession {
  sessionId: string; scope: LocalLyricsScope; state: 'querying' | 'ready' | 'cancelled' | 'stale'
  tracks: readonly LocalLyricsTrackView[]; candidates: readonly LocalLyricsCandidate[]
  /** 原accepted记录的安全回显；冷恢复查询这些原id，不重建或重发计划。 */
  pendingOperations?: readonly { request: LocalLyricsSaveRequest; receipt: LocalLyricsSaveReceipt }[]
}
export type LocalLyricsWriteState = 'not-requested' | 'pending' | 'saved' | 'existing' | 'failed' | 'unknown' | 'cancelled'
export interface LocalLyricsTrackReceipt { trackId: string; lrc: LocalLyricsWriteState; embed: LocalLyricsWriteState }
export interface LocalLyricsSaveReceipt {
  commandId: string; sessionId: string; state: 'running' | 'complete' | 'partial' | 'unknown' | 'cancelled' | 'failed'
  cover: LocalLyricsWriteState; tracks: readonly LocalLyricsTrackReceipt[]
  snapshot: 'not-requested' | 'pending' | 'saved' | 'failed'
}
export interface LocalLyricsLibraryRequest { datasetId: string; libraryId: string; captureId: string }
export interface LocalLyricsJobStartRequest { commandId: string; library: LocalLyricsLibraryRequest; embed: boolean }
export interface LocalLyricsJobRequest { jobId: string }
/** 只读定位原job的单个专辑；不会创建会话、捕获或保存授权。 */
export interface LocalLyricsJobReadRequest extends LocalLyricsJobRequest { albumId?: string }
export interface LocalLyricsJobOriginalEntry {
  scope: LocalLyricsScope; sessionId: string | null; saveRequest: LocalLyricsSaveRequest | null
}
export interface LocalLyricsJobRetryRequest { jobId: string; albumIds: readonly string[] }
export interface LocalLyricsJobSnapshot {
  jobId: string; library: LocalLyricsLibraryRequest
  state: 'queued' | 'running' | 'stopped' | 'complete' | 'partial' | 'unknown' | 'failed'
  totalAlbums: number; processedAlbums: number; savedAlbums: number
  reviewAlbumIds: readonly string[]; failedAlbumIds: readonly string[]; unknownAlbumIds: readonly string[]
  sidecars: number; embedded: number; inspectionFailures: number; revision: number
  /** 仅job.read指定albumId时回投影，原持久snapshot不存此字段。 */
  originalEntry?: LocalLyricsJobOriginalEntry | null
}
export interface LocalLyricsInventoryRequest { library: LocalLyricsLibraryRequest; filter: 'all' | 'missingLyrics'; offset: number; limit: number }
export interface LocalLyricsInventoryRow { albumId: string; presence: LocalLyricsPresence }
export interface LocalLyricsInventoryPage { total: number; offset: number; rows: readonly LocalLyricsInventoryRow[]; watermark: string }
export const LOCAL_LYRICS_COMMANDS = [
  'localLyrics.query', 'localLyrics.session.read', 'localLyrics.detail', 'localLyrics.select', 'localLyrics.cancel', 'localLyrics.discard',
  'localLyrics.save', 'localLyrics.receipt', 'localLyrics.save.retry', 'localLyrics.snapshot.retry',
  'localLyrics.job.start', 'localLyrics.job.read', 'localLyrics.job.stop', 'localLyrics.job.resume',
  'localLyrics.job.retry', 'localLyrics.inventory',
] as const
export type LocalLyricsCommand = typeof LOCAL_LYRICS_COMMANDS[number]
export interface LocalLyricsCommandPayloads {
  'localLyrics.query': LocalLyricsQueryRequest; 'localLyrics.detail': LocalLyricsDetailRequest
  'localLyrics.session.read': LocalLyricsSessionRequest
  'localLyrics.discard': LocalLyricsDiscardRequest
  'localLyrics.select': LocalLyricsSelectionRequest; 'localLyrics.cancel': LocalLyricsCancelRequest
  'localLyrics.save': LocalLyricsSaveRequest; 'localLyrics.receipt': LocalLyricsReceiptRequest
  'localLyrics.save.retry': LocalLyricsReceiptRequest
  'localLyrics.snapshot.retry': LocalLyricsReceiptRequest
  'localLyrics.job.start': LocalLyricsJobStartRequest; 'localLyrics.job.read': LocalLyricsJobReadRequest
  'localLyrics.job.stop': LocalLyricsJobRequest; 'localLyrics.job.resume': LocalLyricsJobRequest
  'localLyrics.job.retry': LocalLyricsJobRetryRequest; 'localLyrics.inventory': LocalLyricsInventoryRequest
}
export interface LocalLyricsCommandResults {
  'localLyrics.query': LocalLyricsSession; 'localLyrics.detail': LocalLyricsCandidateDetail
  'localLyrics.session.read': LocalLyricsSession
  'localLyrics.discard': LocalLyricsSession | LocalLyricsSaveReceipt
  'localLyrics.select': LocalLyricsSession; 'localLyrics.cancel': LocalLyricsSession
  'localLyrics.save': LocalLyricsSaveReceipt; 'localLyrics.receipt': LocalLyricsSaveReceipt | null
  'localLyrics.save.retry': LocalLyricsSaveReceipt
  'localLyrics.snapshot.retry': LocalLyricsSaveReceipt
  'localLyrics.job.start': LocalLyricsJobSnapshot; 'localLyrics.job.read': LocalLyricsJobSnapshot | null
  'localLyrics.job.stop': LocalLyricsJobSnapshot; 'localLyrics.job.resume': LocalLyricsJobSnapshot
  'localLyrics.job.retry': LocalLyricsJobSnapshot; 'localLyrics.inventory': LocalLyricsInventoryPage
}

const own = (v: unknown, keys: readonly string[]): v is Record<string, unknown> => {
  if (!v || typeof v !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return false
  const d = Object.getOwnPropertyDescriptors(v)
  return Reflect.ownKeys(v).length === keys.length && keys.every(k => d[k] !== undefined && 'value' in d[k]!)
}
export const isLocalLyricsId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(v)
/** 公开正文允许LRC时间标签；网络地址、凭据与控制字符不能进入Renderer。 */
export function isLocalLyricsSafeText(v: unknown, maxBytes: number, multiline = false): v is string {
  return typeof v === 'string' && new TextEncoder().encode(v).byteLength <= maxBytes
    && !(multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u : /[\x00-\x1f\x7f]/u).test(v)
    && !/(?:https?|file|smb):\/\/|(?:cookie|authorization|access[_-]?token|password)\s*[:=]|bearer\s|-----BEGIN .*PRIVATE KEY|[A-Za-z]:\\/iu.test(v)
}
export function isLocalLyricsScope(v: unknown): v is LocalLyricsScope {
  return own(v, ['datasetId', 'libraryId', 'albumId', 'captureId']) && Object.values(v).every(isLocalLyricsId)
}
export function isLocalLyricsLibraryRequest(v: unknown): v is LocalLyricsLibraryRequest {
  return own(v, ['datasetId', 'libraryId', 'captureId']) && Object.values(v).every(isLocalLyricsId)
}
export function isLocalLyricsCommandPayload(command: LocalLyricsCommand, v: unknown): boolean {
  try {
    switch (command) {
      case 'localLyrics.query': return own(v, ['scope']) && isLocalLyricsScope(v.scope)
      case 'localLyrics.detail': return own(v, ['sessionId', 'candidateId']) && isLocalLyricsId(v.sessionId) && isLocalLyricsId(v.candidateId)
      case 'localLyrics.select': return own(v, ['sessionId', 'trackId', 'candidateId']) && isLocalLyricsId(v.sessionId) && isLocalLyricsId(v.trackId) && (v.candidateId === null || isLocalLyricsId(v.candidateId))
      case 'localLyrics.cancel': case 'localLyrics.session.read': return own(v, ['sessionId']) && isLocalLyricsId(v.sessionId)
      case 'localLyrics.discard': return (own(v, ['sessionId']) && isLocalLyricsId(v.sessionId)) || (own(v, ['sessionId', 'commandId']) && isLocalLyricsId(v.sessionId) && isLocalLyricsId(v.commandId))
      case 'localLyrics.save': return own(v, ['sessionId', 'commandId', 'embed']) && isLocalLyricsId(v.sessionId) && isLocalLyricsId(v.commandId) && typeof v.embed === 'boolean'
      case 'localLyrics.receipt': case 'localLyrics.save.retry': case 'localLyrics.snapshot.retry': return own(v, ['sessionId', 'commandId']) && isLocalLyricsId(v.sessionId) && isLocalLyricsId(v.commandId)
      case 'localLyrics.job.start': return own(v, ['commandId', 'library', 'embed']) && isLocalLyricsId(v.commandId) && isLocalLyricsLibraryRequest(v.library) && typeof v.embed === 'boolean'
      case 'localLyrics.job.read': return (own(v, ['jobId']) || own(v, ['jobId', 'albumId'])) && isLocalLyricsId(v.jobId) && (!Object.hasOwn(v, 'albumId') || isLocalLyricsId(v.albumId))
      case 'localLyrics.job.stop': case 'localLyrics.job.resume': return own(v, ['jobId']) && isLocalLyricsId(v.jobId)
      case 'localLyrics.job.retry': return own(v, ['jobId', 'albumIds']) && isLocalLyricsId(v.jobId) && Array.isArray(v.albumIds) && v.albumIds.length <= 10000 && v.albumIds.every(isLocalLyricsId) && new Set(v.albumIds).size === v.albumIds.length
      case 'localLyrics.inventory': return own(v, ['library', 'filter', 'offset', 'limit']) && isLocalLyricsLibraryRequest(v.library) && ['all', 'missingLyrics'].includes(String(v.filter)) && Number.isSafeInteger(v.offset) && Number(v.offset) >= 0 && Number.isSafeInteger(v.limit) && Number(v.limit) >= 1 && Number(v.limit) <= 200
    }
  } catch { return false }
}
export function isLocalLyricsCandidateDetail(v: unknown): v is LocalLyricsCandidateDetail {
  try {
    if (!own(v, ['candidate', 'body']) || !own(v.candidate, ['candidateId', 'trackId', 'source', 'title', 'artist', 'album', 'durationMs', 'language', 'version', 'score'])) return false
    const c = v.candidate
    return isLocalLyricsId(c.candidateId) && isLocalLyricsId(c.trackId) && LOCAL_LYRICS_SOURCES.includes(c.source as LocalLyricsSource)
      && ['title', 'artist', 'album', 'language'].every(k => isLocalLyricsSafeText(c[k], 2048))
      && (c.durationMs === null || (Number.isSafeInteger(c.durationMs) && Number(c.durationMs) >= 0))
      && ['original', 'live', 'remix', 'instrumental', 'unknown'].includes(String(c.version))
      && Number.isInteger(c.score) && Number(c.score) >= 0 && Number(c.score) <= 100
      && isLocalLyricsSafeText(v.body, LOCAL_LYRICS_LIMITS.bodyBytes, true) && v.body.trim().length > 0
      && new TextEncoder().encode(JSON.stringify(v)).byteLength <= LOCAL_LYRICS_LIMITS.publicDetailBytes
  } catch { return false }
}
/** 原entry只有三字段引用；正文、路径、私有整组和额外授权均不能回传。 */
export function isLocalLyricsJobOriginalEntry(v: unknown): v is LocalLyricsJobOriginalEntry {
  try {
    return own(v, ['scope', 'sessionId', 'saveRequest']) && isLocalLyricsScope(v.scope)
      && (v.sessionId === null || isLocalLyricsId(v.sessionId))
      && (v.saveRequest === null || isLocalLyricsCommandPayload('localLyrics.save', v.saveRequest)
        && (v.saveRequest as LocalLyricsSaveRequest).sessionId === v.sessionId)
  } catch { return false }
}
