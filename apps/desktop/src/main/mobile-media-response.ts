import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  validateMobileMediaStreamHeaders, validateMobileMediaStreamCompletion,
  type MobileHeaderPairs, type MobileMediaStreamOperation, type MobileMediaStreamStatus,
} from '@music-bridge/contracts'
import { MobileServiceError } from '../../../../packages/bridge-core/src/mobile/types.js'

/** 只存在于可信 Main；这些回调不得进入 structuredClone/RPC 或 Renderer。 */
export interface MobileMediaReader {
  /** 一次最多返回 maxBytes，null 表示本次选定区间真实 EOF；close 必须取消在途读。 */
  read(maxBytes: number, signal: AbortSignal): Promise<Uint8Array | null>
  /** 仅释放本次 HTTP reader，不替代持久 resource/session 的 DELETE。 */
  close(): Promise<void>
}
export interface MobileMediaReply {
  operation: MobileMediaStreamOperation
  status: MobileMediaStreamStatus
  headers: MobileHeaderPairs
  expectedBodyBytes: number
  fullContentLength: number
  resourceAbortSignal: AbortSignal
  ticketExpiresAtMs: number
  beforeSend(): Promise<void>
  reader: MobileMediaReader
  /** 实际单 Range；If-Range 已降为完整 200 时省略，HEAD 始终忽略。 */
  rangeRequested?: string
}
export interface MobileMediaResponseLimits { idleMs?: number; establishMs?: number; releaseMs?: number }
export const MOBILE_MEDIA_RESPONSE_LIMITS = Object.freeze({
  maxChunkBytes: 64 * 1024, idleMs: 5000, establishMs: 10_000, releaseMs: 10_000,
})
export type MobileMediaResponseErrorCode = 'INVALID_REPLY' | 'INVALID_LIMITS' | 'ABORTED'
  | 'PEER_CLOSED' | 'ESTABLISH_TIMEOUT' | 'IDLE_TIMEOUT' | 'TICKET_EXPIRED'
  | 'AUTHORITY_CHECK_FAILED' | 'READER_FAILED' | 'INVALID_CHUNK' | 'EARLY_EOF' | 'OVERFLOW'
  | 'WRITE_FAILED' | 'RELEASE_FAILED' | 'RELEASE_TIMEOUT'
export class MobileMediaResponseError extends Error {
  constructor(readonly code: MobileMediaResponseErrorCode) {
    super('移动媒体传输当前无法完成。')
    this.name = 'MobileMediaResponseError'
  }
}
const headerNames = new Set(['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'etag', 'last-modified'])
const releaseCompletions = new WeakMap<MobileMediaReader, Promise<void>>()
/** 返回未被发送等待期限截断的真实 close；Root须保留到Owner确认quiet，超时不是成功。 */
export function getMobileMediaReleaseCompletion(reply: MobileMediaReply): Promise<void> | undefined {
  return releaseCompletions.get(reply.reader)
}
function captureHeaders(raw: MobileHeaderPairs): [string, string][] {
  if (!Array.isArray(raw) || raw.length > 64) throw new MobileMediaResponseError('INVALID_REPLY')
  let bytes = 0
  return Array.from(raw, (pair): [string, string] => {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string'
      || !headerNames.has(pair[0].toLowerCase()) || /[\u0000-\u001f\u007f]/u.test(pair[1])) {
      throw new MobileMediaResponseError('INVALID_REPLY')
    }
    bytes += Buffer.byteLength(pair[0]) + Buffer.byteLength(pair[1]) + 4
    if (bytes > 16 * 1024) throw new MobileMediaResponseError('INVALID_REPLY')
    return [pair[0], pair[1]]
  })
}
function budget(value: number | undefined, maximum: number): number {
  const actual = value ?? maximum
  if (!Number.isSafeInteger(actual) || actual <= 0 || actual > maximum) throw new MobileMediaResponseError('INVALID_LIMITS')
  return actual
}

/** 媒体不采用旧元数据整体 15 秒期限；建立、流空闲和绝对票据期限分别核验。 */
export async function sendMobileMediaResponse(
  request: IncomingMessage, response: ServerResponse, reply: MobileMediaReply,
  signal: AbortSignal, limits: Readonly<MobileMediaResponseLimits> = {},
): Promise<void> {
  const controller = new AbortController()
  let failure: MobileMediaResponseError | undefined, sentBytes = 0, established = false
  let establishmentTimer: ReturnType<typeof setTimeout> | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let ticketTimer: ReturnType<typeof setTimeout> | undefined
  let authorityTimer: ReturnType<typeof setTimeout> | undefined
  let releaseTimer: ReturnType<typeof setTimeout> | undefined
  let closeFlight: Promise<void> | undefined
  let ownedReader: MobileMediaReader | undefined
  let resourceSignal: AbortSignal | undefined, closeReader: (() => Promise<void>) | undefined
  let idleMs: number = MOBILE_MEDIA_RESPONSE_LIMITS.idleMs, releaseMs: number = MOBILE_MEDIA_RESPONSE_LIMITS.releaseMs
  let ticketExpiresAtMs = 0
  const stop = (code: MobileMediaResponseErrorCode) => {
    if (!failure) failure = new MobileMediaResponseError(code)
    if (!controller.signal.aborted) controller.abort()
  }
  const externalAbort = () => stop('ABORTED')
  const peerClose = () => { if (!response.writableFinished) stop('PEER_CLOSED') }
  const peerError = () => stop('WRITE_FAILED')
  const guard = () => {
    if (controller.signal.aborted) throw failure ?? new MobileMediaResponseError('ABORTED')
    if (request.aborted || response.destroyed || response.writableEnded) throw new MobileMediaResponseError('PEER_CLOSED')
    if (Date.now() >= ticketExpiresAtMs) { stop('TICKET_EXPIRED'); throw failure! }
  }
  const progress = () => {
    if (!established) { established = true; clearTimeout(establishmentTimer); establishmentTimer = undefined }
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => stop('IDLE_TIMEOUT'), idleMs)
  }
  /** 只竞争等待，不重试；迟到的读/检查结果被消费，绝不再写响应。 */
  const wait = <T>(flight: Promise<T>, code: 'READER_FAILED' | 'AUTHORITY_CHECK_FAILED' | 'WRITE_FAILED'): Promise<T> => new Promise((resolve, reject) => {
    let settled = false
    const finish = (error: unknown, value?: T) => {
      if (settled) return
      settled = true; controller.signal.removeEventListener('abort', aborted)
      if (error !== null) reject(error)
      else resolve(value as T)
    }
    const aborted = () => finish(failure ?? new MobileMediaResponseError('ABORTED'))
    controller.signal.addEventListener('abort', aborted, { once: true })
    flight.then(value => finish(null, value), error => finish(error instanceof MobileServiceError ? error : new MobileMediaResponseError(code)))
    if (controller.signal.aborted) aborted()
  })
  const writeChunk = (chunk: Uint8Array): Promise<void> => new Promise((resolve, reject) => {
    let settled = false, callbackDone = false, drainDone = false, writeReturned = false
    const finish = (error?: MobileMediaResponseError) => {
      if (settled) return
      if (!error && (!writeReturned || !callbackDone || !drainDone)) return
      settled = true; response.removeListener('drain', drain)
      controller.signal.removeEventListener('abort', aborted)
      if (error) reject(error); else resolve()
    }
    const drain = () => { drainDone = true; progress(); finish() }
    const aborted = () => finish(failure ?? new MobileMediaResponseError('ABORTED'))
    response.once('drain', drain); controller.signal.addEventListener('abort', aborted, { once: true })
    try {
      guard()
      const accepted = response.write(chunk, error => {
        if (settled) return
        if (error) { stop('WRITE_FAILED'); finish(failure); return }
        callbackDone = true; progress(); finish()
      })
      writeReturned = true
      if (accepted) drainDone = true
      finish()
    } catch { finish(failure ?? new MobileMediaResponseError('WRITE_FAILED')) }
    if (controller.signal.aborted) aborted()
  })
  const endResponse = (): Promise<void> => new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => { response.removeListener('finish', finished); controller.signal.removeEventListener('abort', aborted) }
    const finished = () => { if (settled) return; settled = true; cleanup(); resolve() }
    const aborted = () => { if (settled) return; settled = true; cleanup(); reject(failure ?? new MobileMediaResponseError('ABORTED')) }
    response.once('finish', finished); controller.signal.addEventListener('abort', aborted, { once: true })
    try { guard(); response.end() } catch { stop('WRITE_FAILED'); aborted() }
    if (controller.signal.aborted) aborted()
  })
  const release = (): Promise<void> => {
    if (closeFlight) return closeFlight
    if (!closeReader || !ownedReader) return Promise.resolve()
    const reader = ownedReader, close = closeReader
    closeFlight = new Promise((resolve, reject) => {
      let settled = false
      const finish = (error?: MobileMediaResponseError) => {
        if (settled) return
        settled = true; clearTimeout(releaseTimer); releaseTimer = undefined
        if (error) reject(error); else resolve()
      }
      releaseTimer = setTimeout(() => finish(new MobileMediaResponseError('RELEASE_TIMEOUT')), releaseMs)
      let actual = releaseCompletions.get(reader)
      if (!actual) {
        actual = Promise.resolve().then(close).catch(() => { throw new MobileMediaResponseError('RELEASE_FAILED') })
        releaseCompletions.set(reader, actual)
      }
      actual.then(() => finish(), () => finish(new MobileMediaResponseError('RELEASE_FAILED')))
    })
    return closeFlight
  }
  request.once('aborted', externalAbort); response.once('close', peerClose); response.once('error', peerError)
  signal.addEventListener('abort', externalAbort, { once: true })
  let originalFailure: unknown, failed = false
  try {
    // 即使校验拒绝，已交给 Main 的 HTTP reader 仍在 finally 中仅关闭一次。
    if (typeof reply?.reader?.close !== 'function') throw new MobileMediaResponseError('INVALID_REPLY')
    ownedReader = reply.reader
    closeReader = reply.reader.close.bind(reply.reader)
    if (typeof reply.reader.read !== 'function' || typeof reply.beforeSend !== 'function'
      || !(reply.resourceAbortSignal instanceof AbortSignal) || response.headersSent
      || !Number.isSafeInteger(reply.ticketExpiresAtMs) || reply.ticketExpiresAtMs < 0
      || !Number.isSafeInteger(reply.expectedBodyBytes) || reply.expectedBodyBytes < 0
      || request.method !== (reply.operation === 'getMediaAsset' ? 'GET' : reply.operation === 'headMediaAsset' ? 'HEAD' : '')) {
      throw new MobileMediaResponseError('INVALID_REPLY')
    }
    idleMs = budget(limits.idleMs, MOBILE_MEDIA_RESPONSE_LIMITS.idleMs)
    releaseMs = budget(limits.releaseMs, MOBILE_MEDIA_RESPONSE_LIMITS.releaseMs)
    const establishMs = budget(limits.establishMs, MOBILE_MEDIA_RESPONSE_LIMITS.establishMs)
    ticketExpiresAtMs = reply.ticketExpiresAtMs
    const headers = captureHeaders(reply.headers)
    const checked = validateMobileMediaStreamHeaders(reply.operation, reply.status, headers, reply.fullContentLength, reply.rangeRequested)
    if (!checked.ok || checked.value.expectedBodyBytes !== reply.expectedBodyBytes) throw new MobileMediaResponseError('INVALID_REPLY')
    const snapshot = checked.value, read = reply.reader.read.bind(reply.reader), beforeSend = reply.beforeSend.bind(reply)
    resourceSignal = reply.resourceAbortSignal; resourceSignal.addEventListener('abort', externalAbort, { once: true })
    if (signal.aborted || resourceSignal.aborted || request.aborted) stop('ABORTED')
    establishmentTimer = setTimeout(() => stop('ESTABLISH_TIMEOUT'), establishMs)
    const armTicket = () => {
      const remaining = ticketExpiresAtMs - Date.now()
      if (remaining <= 0) { stop('TICKET_EXPIRED'); return }
      ticketTimer = setTimeout(armTicket, Math.min(remaining, 2_147_483_647))
    }
    const authority = async () => {
      guard(); clearTimeout(idleTimer); idleTimer = undefined
      authorityTimer = setTimeout(() => stop('ESTABLISH_TIMEOUT'), establishMs)
      try { await wait(Promise.resolve().then(beforeSend), 'AUTHORITY_CHECK_FAILED'); guard() }
      finally {
        clearTimeout(authorityTimer); authorityTimer = undefined
        if (established && !controller.signal.aborted) idleTimer = setTimeout(() => stop('IDLE_TIMEOUT'), idleMs)
      }
    }
    armTicket(); guard(); await authority()
    response.writeHead(snapshot.status, [...headers.filter(([name]) => name.toLowerCase() !== 'cache-control').flatMap(([name, value]) => [name, value]),
      'Connection', 'close', 'Cache-Control', 'no-store', 'X-Content-Type-Options', 'nosniff'])
    if (snapshot.operation !== 'headMediaAsset' && snapshot.status !== 400 && snapshot.status !== 416) {
      for (;;) {
        guard()
        // 末尾最多再读1字节核真实EOF；超长reader不得用截断伪装完整成功。
        const remaining = snapshot.expectedBodyBytes - sentBytes
        const maxBytes = Math.min(MOBILE_MEDIA_RESPONSE_LIMITS.maxChunkBytes, Math.max(1, remaining))
        const chunk = await wait(Promise.resolve().then(() => read(maxBytes, controller.signal)), 'READER_FAILED')
        guard()
        if (chunk === null) {
          const complete = validateMobileMediaStreamCompletion(snapshot, sentBytes)
          if (!complete.ok) throw new MobileMediaResponseError('EARLY_EOF')
          break
        }
        if (!(chunk instanceof Uint8Array) || chunk.buffer instanceof SharedArrayBuffer || !chunk.byteLength) throw new MobileMediaResponseError('INVALID_CHUNK')
        if (chunk.byteLength > remaining) throw new MobileMediaResponseError('OVERFLOW')
        if (chunk.byteLength > maxBytes) throw new MobileMediaResponseError('INVALID_CHUNK')
        const ownedChunk = new Uint8Array(chunk)
        await authority(); guard()
        // reader可复用自身缓冲；当前写完成前只保有一份有限副本。
        await writeChunk(ownedChunk); sentBytes += ownedChunk.byteLength
      }
    }
    const complete = validateMobileMediaStreamCompletion(snapshot, sentBytes)
    if (!complete.ok) throw new MobileMediaResponseError('EARLY_EOF')
    // 回收确认采用独立10秒预算，不用网络idle把真实慢IO误截为5秒。
    clearTimeout(establishmentTimer); establishmentTimer = undefined
    clearTimeout(idleTimer); idleTimer = undefined
    // 释放失败时不发HTTP finish，从而不把未回收的reader记成成功。
    await release(); guard(); progress(); await endResponse()
  } catch (error) {
    failed = true; originalFailure = error instanceof MobileMediaResponseError || error instanceof MobileServiceError
      ? error : new MobileMediaResponseError('WRITE_FAILED')
    if (response.headersSent && !response.writableFinished) response.destroy()
  } finally {
    controller.abort()
    clearTimeout(establishmentTimer); clearTimeout(idleTimer); clearTimeout(ticketTimer); clearTimeout(authorityTimer)
    request.removeListener('aborted', externalAbort); response.removeListener('close', peerClose); response.removeListener('error', peerError)
    signal.removeEventListener('abort', externalAbort); resourceSignal?.removeEventListener('abort', externalAbort)
    try { await release() } catch (error) { if (!failed) { failed = true; originalFailure = error } }
  }
  if (failed) throw originalFailure
}
