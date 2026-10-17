import { createHash } from 'node:crypto'
import { types as nodeTypes } from 'node:util'
import { isLocalLyricsScope, isLocalLyricsId, isLocalLyricsSafeText } from '@music-bridge/contracts'
import type { LocalLyricsScope, LocalLyricsLibraryRequest, LocalLyricsVersion, LocalLyricsPresence, LocalLyricsSource, LocalLyricsSaveRequest, LocalLyricsSaveReceipt, LocalLyricsWriteState, LocalLyricsJobSnapshot } from '@music-bridge/contracts'

/** Root唯一Owner验证原对象；authorityRef永不进入公开合同或序列化日志。 */
export interface LocalLyricsTrackCapture {
  trackId: string; title: string; artist: string; album: string; language: string
  version: LocalLyricsVersion; durationMs: number | null; wholeTrack: boolean
  format: 'wav' | 'flac' | 'other'; rootRevision: string; fileRevision: string
  locationRevision: string; metadataRevision: string; lrc: LocalLyricsPresence; embedded: LocalLyricsPresence
}
export interface LocalLyricsCapture { scope: LocalLyricsScope; authorityRef: object; epoch: string; fingerprint: string; tracks: readonly LocalLyricsTrackCapture[]; online: boolean }
export interface LocalLyricsLibraryCapture { library: LocalLyricsLibraryRequest; authorityRef: object; watermark: string; deadlineAtMs: number }
export interface LocalLyricsCapturePort {
  capture(scope: LocalLyricsScope, originalCommandId?: string): Promise<LocalLyricsCapture>
  /** query受理后才执行完整物理盘点；仅同authorityRef原捕获，完成前不能select/save。 */
  prepareQuery?(capture:LocalLyricsCapture,signal:AbortSignal):Promise<readonly LocalLyricsInventoryObservation[]>
  assertCurrent(capture: LocalLyricsCapture, originalCommandId?: string): Promise<void>
  captureLibrary(library: LocalLyricsLibraryRequest): Promise<LocalLyricsLibraryCapture>
  assertLibraryCurrent(capture: LocalLyricsLibraryCapture): Promise<void>
  /** 必须枚举原watermark全部已扫描专辑，不能只读UI当前筛选或当前页。 */
  libraryPage(capture: LocalLyricsLibraryCapture, cursor: string | null): Promise<{ scopes: readonly LocalLyricsScope[]; next: string | null; total: number; watermark: string }>
}
export interface LocalLyricsProviderQuery { title: string; artist: string; album: string; language: string; version: LocalLyricsVersion; durationMs: number | null }
/** 只给私有provider接点的原来源剩余期限；不进入公开合同或授予Provider权限。 */
export interface LocalLyricsProviderRequestContext {expiresAtMs:number}
export interface LocalLyricsProviderTransportPort {
  /** 只允许固定source及operation；URL、凭据、Provider ID均留私有边界。 */
  request(source: LocalLyricsSource, operation: 'search' | 'body', input: LocalLyricsProviderQuery | { id: string }, signal: AbortSignal, context?:LocalLyricsProviderRequestContext): Promise<Uint8Array>
  /** signal取消后也要join实际请求资源，而不只让Promise.race提前返回。 */
  join(signal: AbortSignal): Promise<void>
}
export interface LocalLyricsSelectedBody { track: LocalLyricsTrackCapture; candidateId: string; source: LocalLyricsSource; body: string; sha256: string }
export interface LocalLyricsSaveIntent { request: LocalLyricsSaveRequest; scope: LocalLyricsScope; captureFingerprint: string; selected: readonly LocalLyricsSelectedBody[]; fingerprint: string }
export interface LocalLyricsSaveRecord { intent: LocalLyricsSaveIntent; receipt: LocalLyricsSaveReceipt; revision: number; physicalClosed: boolean; discarded: boolean }
export interface LocalLyricsJobEntry { scope: LocalLyricsScope; state: 'pending' | 'saved' | 'review' | 'failed' | 'unknown'; saveRequest: LocalLyricsSaveRequest | null; sessionId: string | null; unresolved: 'review' | 'failed' | 'unknown' | null; sidecars: number; embedded: number }
export interface LocalLyricsJobRecord { snapshot: LocalLyricsJobSnapshot; embed: boolean; watermark: string; deadlineAtMs: number; enumerationComplete: boolean; entries: readonly LocalLyricsJobEntry[] }
export interface LocalLyricsJournalPort {
  readSave(commandId: string): Promise<LocalLyricsSaveRecord | null>
  /** 完整原pending集合，按dataset/library/album，不以新captureId或session绕过旧UNKNOWN。 */
  pendingSaves(scope: LocalLyricsScope): Promise<readonly LocalLyricsSaveRecord[]>
  /** 唯一Owner事务CAS；不存在expectedRevision=null时同时核同album无其他pending，否则严格原revision。 */
  save(record: LocalLyricsSaveRecord, expectedRevision: number | null): Promise<void>
  readJob(jobId: string): Promise<LocalLyricsJobRecord | null>
  checkpoint(record: LocalLyricsJobRecord, expectedRevision: number | null): Promise<void>
}
export interface LocalLyricsProtectedWriteResult { state: Exclude<LocalLyricsWriteState, 'not-requested' | 'pending'>; bodySha256: string | null }
export interface LocalLyricsProtectedSavePort {
  /** Root必须核原Owner intent及specific SourceFiles grant/FD/namespace，不接受声明式能力。 */
  write(kind: 'lrc' | 'embed', intent: LocalLyricsSaveIntent, selected: LocalLyricsSelectedBody, signal: AbortSignal): Promise<LocalLyricsProtectedWriteResult>
  readOriginal(kind: 'lrc' | 'embed', intent: LocalLyricsSaveIntent, selected: LocalLyricsSelectedBody): Promise<LocalLyricsProtectedWriteResult | null>
  /** 仅原明确failed、完成物理probe且恢复授权后的同body重试；UNKNOWN不得进入此入口。 */
  retryFailed(kind: 'lrc' | 'embed', intent: LocalLyricsSaveIntent, selected: LocalLyricsSelectedBody, signal: AbortSignal): Promise<LocalLyricsProtectedWriteResult>
  join(commandId: string): Promise<void>
}
export interface LocalLyricsPendingCoverPort {
  save(capture: LocalLyricsCapture, commandId: string, signal: AbortSignal): Promise<LocalLyricsWriteState>
  readOriginal(capture: LocalLyricsCapture, commandId: string): Promise<LocalLyricsWriteState | null>
  hasPending(capture: LocalLyricsCapture): Promise<boolean>
}
export interface LocalLyricsInventoryObservation { trackId: string; lrc: LocalLyricsPresence; embedded: LocalLyricsPresence; fileRevision: string }
export interface LocalLyricsInventoryPort {
  inspect(capture: LocalLyricsCapture, signal: AbortSignal): Promise<readonly LocalLyricsInventoryObservation[]>
  /** 同一个原capture/CAS；删除或换库必须拒绝，不得创建被删除的库。 */
  persist(capture: LocalLyricsCapture, observations: readonly LocalLyricsInventoryObservation[]): Promise<void>
  snapshot(capture: LocalLyricsCapture, commandId: string): Promise<'saved' | 'failed'>
  page(library: LocalLyricsLibraryRequest, filter: 'all' | 'missingLyrics', offset: number, limit: number): Promise<{ total: number; watermark: string; rows: readonly { albumId: string; presence: LocalLyricsPresence }[] }>
}
export interface LocalLyricsLifecyclePort { assertAccepting(): void; now(): number; join(): Promise<void> }
export interface LocalLyricsPorts { capture: LocalLyricsCapturePort; journal: LocalLyricsJournalPort; providers: LocalLyricsProviderTransportPort; writer: LocalLyricsProtectedSavePort; cover: LocalLyricsPendingCoverPort; inventory: LocalLyricsInventoryPort; lifecycle: LocalLyricsLifecyclePort }
export class LocalLyricsError extends Error {
  constructor(readonly code: 'INVALID' | 'STALE' | 'CLOSED' | 'BUDGET' | 'CONFLICT' | 'NOT_FOUND' | 'IN_FLIGHT') { super(code) }
}
export const lyricsDigest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')
export function lyricsCanonical(value: unknown): string {
  const seen = new Set<object>()
  const capture = (v: unknown): unknown => {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v !== 'object' || nodeTypes.isProxy(v) || seen.has(v)) throw new LocalLyricsError('INVALID')
    seen.add(v)
    try {
      if (!Array.isArray(v) && ![Object.prototype, null].includes(Object.getPrototypeOf(v))) throw new LocalLyricsError('INVALID')
      const d = Object.getOwnPropertyDescriptors(v)
      const keys = Object.keys(v)
      if (Reflect.ownKeys(v).some(k => typeof k !== 'string' || k === 'toJSON') || keys.some(k => !('value' in d[k]!))) throw new LocalLyricsError('INVALID')
      if (Array.isArray(v)) {
        if (v.length > 10000 || Reflect.ownKeys(v).length !== v.length + 1) throw new LocalLyricsError('BUDGET')
        return Array.from({ length: v.length }, (_x, i) => { if (!d[String(i)] || !('value' in d[String(i)]!)) throw new LocalLyricsError('INVALID'); return capture(d[String(i)]!.value) })
      }
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>
      for (const k of keys.sort()) out[k] = capture(d[k]!.value)
      return out
    } finally { seen.delete(v) }
  }
  return JSON.stringify(capture(value))
}
export const lyricsClone = <T>(value: T): T => structuredClone(value)
export const lyricsPresence = (lrc: LocalLyricsPresence, embedded: LocalLyricsPresence): LocalLyricsPresence => lrc === 'true' || embedded === 'true' ? 'true' : lrc === 'unknown' || embedded === 'unknown' ? 'unknown' : 'false'
export function checkLyricsCapture(c: LocalLyricsCapture): void {
  if (c.tracks.length > 10000 || new Set(c.tracks.map(t => t.trackId)).size !== c.tracks.length || Buffer.byteLength(JSON.stringify(c.tracks)) > 32 * 1024 * 1024) throw new LocalLyricsError('BUDGET')
  if (!isLocalLyricsScope(c.scope) || c.tracks.some(t => !isLocalLyricsId(t.trackId) || ![t.title, t.artist, t.album, t.language].every(s => isLocalLyricsSafeText(s, 2048)) || !['unknown', 'false', 'true'].includes(t.lrc) || !['unknown', 'false', 'true'].includes(t.embedded) || !['original', 'live', 'remix', 'instrumental', 'unknown'].includes(t.version) || !['wav', 'flac', 'other'].includes(t.format) || typeof t.wholeTrack !== 'boolean' || (t.durationMs !== null && (!Number.isSafeInteger(t.durationMs) || t.durationMs < 0)))) throw new LocalLyricsError('INVALID')
}
export const lyricsScopeKey = (scope: LocalLyricsScope): string => JSON.stringify([scope.datasetId, scope.libraryId, scope.albumId, scope.captureId])
export const lyricsLibraryKey = (scope: LocalLyricsLibraryRequest): string => JSON.stringify([scope.datasetId, scope.libraryId, scope.captureId])
/** 不把deadline race当物理关闭；finally仍必须await端口join。 */
export function lyricsAbort(parent: AbortSignal | undefined, milliseconds: number): { controller: AbortController; dispose(): void } {
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  parent?.addEventListener('abort', onAbort, { once: true })
  if (parent?.aborted) controller.abort()
  const timer = setTimeout(onAbort, Math.max(0, milliseconds))
  return { controller, dispose() { clearTimeout(timer); parent?.removeEventListener('abort', onAbort) } }
}
