import { withMobileRangeWindowContext, type MobileRangeWindowContext, type MobileRangeWindowProbe } from '../../../../packages/bridge-core/src/mobile/range-window-observer.js'
import { createServer, type Server } from 'node:https'
import { createMobileCapabilityContext, withMobileCapabilityContext, mobileCapabilityAsync, mobileCapabilitySync, mobileCapabilityReject, closeMobileCapabilityContext, mobilePreparationAsync, mobilePreparationSync, type MobileCapabilityContext, type MobilePreparationProbe } from '../../../../packages/bridge-core/src/mobile/capability-trace.js'
import { createMobileContentSampleSelector } from '../../../../packages/bridge-core/src/mobile/capability-trace.js'
import { randomUUID, X509Certificate, createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import {
  decodeMobileRequest, decodeMobileResponse, mapMobileSafeError,
  MOBILE_JSON_REQUEST_MAX_BYTES, MOBILE_API_RESPONSE_MAX_BYTES, resolveMobileOperation,
  type MobileHeaderPairs,
  type MobileResourceSemanticContext,
  type MobileContentReadContext,
} from '@music-bridge/contracts'
import {
  MOBILE001_OPERATIONS, MobileServiceError,
  type Mobile001Backend, type Mobile001BackendReply, type Mobile001Operation,
} from '../../../../packages/bridge-core/src/mobile/types.js'
import { isMobilePrivateIPv4 } from './mobile-tls-identity.js'
import { MOBILE002_OPERATIONS, safeMobilePlaybackFailure, type Mobile002Backend, type Mobile002Operation, type Mobile002BackendReply } from './mobile-playback-backend.js'
import { sendMobileMediaResponse, getMobileMediaReleaseCompletion, type MobileMediaReply } from './mobile-media-response.js'
import type { Mobile003Backend, Mobile003Operation } from './mobile-backend.js'
import type { MobileContentBackend, MobileContentBackendReply } from './mobile-content-backend.js'
import type { MobileRangeTimingProbe, MobileRangeTimingContext, MobileRangeTimingSpan } from './mobile-range-timing.js'
import { MOBILE_CONTENT_OPERATIONS, type MobileContentOperation } from '../../../../packages/bridge-core/src/mobile/content-types.js'

/** 新门面自己的有限预算，不改变旧 Control API、Stream Gateway 或任务 Gate。 */
export const MOBILE_HTTPS_LIMITS = Object.freeze({
  headerBytes: 16 * 1024, headers: 64, urlBytes: 4096,
  bodyMs: 5000, headersMs: 10_000, requestMs: 15_000,
  handshakeMs: 10_000, startMs: 5000, closeMs: 1000,
  responseWriteMs: 5000, connections: 32, concurrentRequests: 16,
})

export interface MobileHttpsServerOptions {
  tls: { key: string | Buffer; cert: string | Buffer }
  host: string
  /** 0 只由可信合成开发配置采用；生产配置由 Main 拒绝 0。 */
  port: number
  backend: Mobile001Backend
  /** 只有可信 Main 显式安装002；旧001组合继续拒绝全部播放操作。 */
  playback?: Mobile002Backend
  /** 003显式安装既有认证能力路由；不开放其他尚未实现的UI操作。 */
  dsd?: Mobile003Backend
  /** 004由原Main认证及原Core/Owner组合根显式装载。 */
  content?: MobileContentBackend
  allowedHosts?: readonly string[]
  /** 可信Main单次旁注，缺省关闭，不进入HTTP或RPC合同。 */
  rangeTimingProbe?: MobileRangeTimingProbe
  rangeWindowProbe?: MobileRangeWindowProbe
  preparationProbe?: MobilePreparationProbe
}
export interface MobileHttpsListening { baseUrl: string; certificateSha256: string }
export interface MobileHttpsServer { start(): Promise<MobileHttpsListening>; close(): Promise<void> }
export class MobileHttpsServerError extends Error {
  constructor(readonly code: 'INVALID_CONFIGURATION' | 'INVALID_TLS_IDENTITY' | 'START_FAILED' | 'CLOSED') {
    super('移动 HTTPS 服务当前不可用。')
    this.name = 'MobileHttpsServerError'
  }
}

const replyHeaderNames = new Set(['content-type', 'content-length', 'cache-control', 'retry-after'])
function serviceFailure(status: 400 | 401 | 404 | 413 | 429 | 503, code: ConstructorParameters<typeof MobileServiceError>[1]) {
  return new MobileServiceError(status, code, status === 429 || status === 503)
}
function headerPairs(request: IncomingMessage): [string, string][] {
  if (request.rawHeaders.length % 2 || request.rawHeaders.length > MOBILE_HTTPS_LIMITS.headers * 2) {
    throw serviceFailure(400, 'INVALID_REQUEST')
  }
  const result: [string, string][] = []
  for (let i = 0; i < request.rawHeaders.length; i += 2) result.push([request.rawHeaders[i]!, request.rawHeaders[i + 1]!])
  return result
}
function requestTarget(raw: string | undefined): { path: string; query: [string, string][] } {
  if (!raw || Buffer.byteLength(raw) > MOBILE_HTTPS_LIMITS.urlBytes || !raw.startsWith('/') || raw.startsWith('//')
    || /[\u0000-\u0020\u007f\\#]/u.test(raw)) throw serviceFailure(400, 'INVALID_REQUEST')
  const question = raw.indexOf('?'), path = question < 0 ? raw : raw.slice(0, question)
  const query: [string, string][] = []
  if (question >= 0 && question < raw.length - 1) {
    for (const part of raw.slice(question + 1).split('&')) {
      if (!part) throw serviceFailure(400, 'INVALID_REQUEST')
      const equals = part.indexOf('=')
      try {
        const decode = (value: string) => decodeURIComponent(value.replace(/\+/gu, ' '))
        query.push([decode(equals < 0 ? part : part.slice(0, equals)), decode(equals < 0 ? '' : part.slice(equals + 1))])
      } catch { throw serviceFailure(400, 'INVALID_REQUEST') }
    }
  }
  return { path, query }
}
function oneHeader(headers: MobileHeaderPairs, name: string): string | undefined {
  const values = headers.filter(([key]) => key.toLowerCase() === name)
  if (values.length > 1) throw serviceFailure(400, 'INVALID_REQUEST')
  return values[0]?.[1]
}
function authority(headers: MobileHeaderPairs, hosts: ReadonlySet<string>, port: number): string {
  const value = oneHeader(headers, 'host'), match = /^([0-9]+(?:\.[0-9]+){3})(?::([1-9]\d{0,4}))?$/u.exec(value ?? '')
  if (!match || !hosts.has(match[1]!) || Number(match[2] ?? 443) !== port
    || headers.some(([name]) => /^(?:forwarded|x-forwarded-)/iu.test(name))) throw serviceFailure(400, 'INVALID_REQUEST')
  return `https://${match[1]}${port === 443 ? '' : `:${port}`}`
}
function accessToken(headers: MobileHeaderPairs): string | null {
  const value = oneHeader(headers, 'authorization')
  if (value === undefined) return null
  const match = /^Bearer ([A-Za-z0-9_.~+\/-]{1,8192}={0,2})$/u.exec(value)
  if (!match) throw serviceFailure(401, 'UNAUTHORIZED')
  return match[1]!
}
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(serviceFailure(503, 'BUSY'))
    if (signal.aborted) { promise.catch(() => {}); stop(); return }
    signal.addEventListener('abort', stop, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop)).catch(() => {})
  })
}
function readBody(request: IncomingMessage, headers: MobileHeaderPairs, signal: AbortSignal): Promise<Uint8Array> {
  const rawLength = oneHeader(headers, 'content-length'), encoding = oneHeader(headers, 'content-encoding')
  if (encoding !== undefined && encoding !== 'identity') throw serviceFailure(400, 'INVALID_REQUEST')
  if (rawLength !== undefined && (!/^(0|[1-9]\d*)$/u.test(rawLength) || !Number.isSafeInteger(Number(rawLength)))) {
    throw serviceFailure(400, 'INVALID_REQUEST')
  }
  if (rawLength !== undefined && Number(rawLength) > MOBILE_JSON_REQUEST_MAX_BYTES) throw serviceFailure(413, 'CONTENT_LIMIT_EXCEEDED')
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let bytes = 0, done = false
    const finish = (error?: MobileServiceError) => {
      if (done) return
      done = true; clearTimeout(timer)
      request.removeListener('data', data); request.removeListener('end', end)
      request.removeListener('error', failed); request.removeListener('aborted', failed)
      signal.removeEventListener('abort', failed)
      if (error) { request.pause(); reject(error) }
      else resolve(new Uint8Array(Buffer.concat(chunks, bytes)))
    }
    const data = (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes > MOBILE_JSON_REQUEST_MAX_BYTES) { finish(serviceFailure(413, 'CONTENT_LIMIT_EXCEEDED')); return }
      chunks.push(Buffer.from(chunk))
    }
    const end = () => finish(rawLength !== undefined && Number(rawLength) !== bytes ? serviceFailure(400, 'INVALID_REQUEST') : undefined)
    const failed = () => finish(serviceFailure(503, 'BUSY'))
    const timer = setTimeout(failed, MOBILE_HTTPS_LIMITS.bodyMs)
    request.on('data', data); request.once('end', end); request.once('error', failed); request.once('aborted', failed)
    signal.addEventListener('abort', failed, { once: true })
    if (signal.aborted) failed()
  })
}
function captureReply(operation: Mobile001Operation | Mobile002Operation | Mobile003Operation | MobileContentOperation, reply: Mobile001BackendReply & { resourceContext?: MobileResourceSemanticContext; contentContext?: MobileContentReadContext }, origin: string, path: string): Mobile001BackendReply {
  if (!(reply.body instanceof Uint8Array) || reply.body.buffer instanceof SharedArrayBuffer
    || reply.body.byteLength > MOBILE_API_RESPONSE_MAX_BYTES || !Array.isArray(reply.headers)
    || reply.headers.length > MOBILE_HTTPS_LIMITS.headers || reply.beforeSend !== undefined && typeof reply.beforeSend !== 'function') {
    throw serviceFailure(503, 'BUSY')
  }
  const headers: [string, string][] = Array.from(reply.headers, pair => {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string'
      || !replyHeaderNames.has(pair[0].toLowerCase())) throw serviceFailure(503, 'BUSY')
    return [pair[0], pair[1]]
  })
  const body = new Uint8Array(reply.body)
  const checked = decodeMobileResponse(operation, { status: reply.status, headers, body, finalUrl: `${origin}${path}` }, {
    responseOrigin: origin, requestPath: path, ...(reply.resourceContext ? { resource: reply.resourceContext } : {}),
    ...(reply.contentContext ? { content: reply.contentContext } : {}),
  })
  if (!checked.ok) throw serviceFailure(503, 'BUSY')
  const length = headers.find(([name]) => name.toLowerCase() === 'content-length')
  if (length === undefined) headers.push(['Content-Length', String(body.byteLength)])
  if (operation === 'getArtwork' && reply.status === 200) {
    const type = headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1]
    const png = body.length >= 8 && Buffer.from(body.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    const jpeg = body.length >= 4 && body[0] === 255 && body[1] === 216 && body[body.length - 2] === 255 && body[body.length - 1] === 217
    if (type === 'image/png' ? !png : type === 'image/jpeg' ? !jpeg : true) throw serviceFailure(503, 'BUSY')
  }
  return { status: reply.status, headers, body, ...(reply.beforeSend ? { beforeSend: reply.beforeSend } : {}) }
}
function privateStatus(status: number): void {
  const stages = { 200: 'http.status.200', 400: 'http.status.400', 401: 'http.status.401', 403: 'http.status.403', 404: 'http.status.404',
    409: 'http.status.409', 410: 'http.status.410', 413: 'http.status.413', 429: 'http.status.429', 503: 'http.status.503' } as const
  const stage = stages[status as keyof typeof stages]
  if (stage) mobileCapabilitySync(stage, () => undefined)
}
function safeReply(error: unknown, requestId: string): Mobile001BackendReply {
  const safe = safeMobilePlaybackFailure(error)
  const mapped = mapMobileSafeError({ code: safe.code, requestId, retryable: safe.retryable,
    ...(safe.retryAfterMs === undefined ? {} : { retryAfterMs: safe.retryAfterMs }) })
  if (!mapped.ok) throw new MobileHttpsServerError('INVALID_CONFIGURATION')
  const body = new TextEncoder().encode(JSON.stringify(mapped.value))
  return { status: safe.status, headers: [['Content-Type', 'application/json'], ['Content-Length', String(body.byteLength)],
    ...(safe.retryAfterMs === undefined ? [] : [['Retry-After', String(Math.ceil(safe.retryAfterMs / 1000))] as [string, string]])], body }
}
function output(response: ServerResponse, reply: Mobile001BackendReply): Promise<void> {
  return new Promise(resolve => {
    const done = () => { response.removeListener('finish', done); response.removeListener('close', done); response.removeListener('error', done); resolve() }
    response.once('finish', done); response.once('close', done); response.once('error', done)
    response.setTimeout(MOBILE_HTTPS_LIMITS.responseWriteMs, () => response.destroy())
    response.writeHead(reply.status, [...reply.headers.filter(([name]) => name.toLowerCase() !== 'cache-control').flatMap(([name, value]) => [name, value]),
      'Connection', 'close', 'Cache-Control', 'no-store', 'X-Content-Type-Options', 'nosniff'])
    response.end(reply.body)
  })
}

export function createMobileHttpsServer(options: MobileHttpsServerOptions): MobileHttpsServer {
  const host = options.host, port = options.port, requestedHosts = options.allowedHosts ?? [host]
  if (!isMobilePrivateIPv4(host) || !Number.isInteger(port) || port < 0 || port > 65535
    || !Array.isArray(requestedHosts) || !requestedHosts.length || requestedHosts.length > 16
    || Array.from(requestedHosts).some(value => !isMobilePrivateIPv4(value)) || !requestedHosts.includes(host)
    || typeof options.backend?.dispatch !== 'function') throw new MobileHttpsServerError('INVALID_CONFIGURATION')
  const dispatch = options.backend.dispatch.bind(options.backend)
  const operationSet = new Set<string>(MOBILE001_OPERATIONS)
  if (options.playback) {
    if (typeof options.playback.dispatch !== 'function' || typeof options.playback.resourceCapabilities !== 'function') throw new MobileHttpsServerError('INVALID_CONFIGURATION')
    for (const operation of MOBILE002_OPERATIONS) operationSet.add(operation)
  }
  if (options.dsd) {
    if (!options.playback || typeof options.dsd.dispatch !== 'function') throw new MobileHttpsServerError('INVALID_CONFIGURATION')
    operationSet.add('getUIContentCapabilities')
  }
  if (options.content) {
    if (!options.playback || !options.dsd || typeof options.content.dispatch !== 'function') throw new MobileHttpsServerError('INVALID_CONFIGURATION')
    for (const operation of MOBILE_CONTENT_OPERATIONS) operationSet.add(operation)
  }
  let certificateSha256: string, server: Server
  try {
    const certificate = new X509Certificate(options.tls.cert)
    if (Buffer.byteLength(options.tls.cert) > 65536 || Buffer.byteLength(options.tls.key) > 65536
      || requestedHosts.some(host => !certificate.checkIP(host)) || !Number.isFinite(Date.parse(certificate.validFrom))
      || !Number.isFinite(Date.parse(certificate.validTo)) || Date.parse(certificate.validFrom) > Date.now()
      || Date.parse(certificate.validTo) <= Date.now()) throw new Error('无效证书')
    certificateSha256 = createHash('sha256').update(certificate.raw).digest('hex')
    server = createServer({ key: options.tls.key, cert: options.tls.cert, minVersion: 'TLSv1.2',
      ALPNProtocols: ['http/1.1'], handshakeTimeout: MOBILE_HTTPS_LIMITS.handshakeMs,
      maxHeaderSize: MOBILE_HTTPS_LIMITS.headerBytes, headersTimeout: MOBILE_HTTPS_LIMITS.headersMs,
      requestTimeout: MOBILE_HTTPS_LIMITS.requestMs, connectionsCheckingInterval: 1000,
    })
  } catch { throw new MobileHttpsServerError('INVALID_TLS_IDENTITY') }
  const hosts = new Set(requestedHosts), sockets = new Set<Duplex>(), active = new Set<AbortController>()
  const controls = new Set<AbortController>(), media = new Set<AbortController>()
  const handlers = new Set<Promise<void>>(), mediaCleanup = new Set<Promise<void>>()
  let closed = false, listeningPort = 0, startFlight: Promise<MobileHttpsListening> | undefined, closeFlight: Promise<void> | undefined
  const privateSamples = createMobileContentSampleSelector()
  server.maxConnections = MOBILE_HTTPS_LIMITS.connections
  // 不让 Node 先截断重复头；总字节先限，随后完整 rawHeaders 闭集核最多64项。
  server.maxHeadersCount = 0
  server.maxRequestsPerSocket = 1; server.keepAliveTimeout = 1000
  server.on('connection', socket => {
    if (closed || sockets.size >= MOBILE_HTTPS_LIMITS.connections) { socket.destroy(); return }
    sockets.add(socket); socket.once('close', () => sockets.delete(socket))
  })
  server.on('clientError', (_error, socket) => socket.destroy())
  server.on('tlsClientError', () => {})
  server.on('error', () => {
    closed = true
    for (const controller of active) controller.abort()
    for (const socket of sockets) socket.destroy()
  })
  server.on('request', (request, response) => {
    // 本监听回调的到达时刻；不冒充TCP到包或跨进程时钟。
    const rangeArrival = options.rangeWindowProbe?.markArrival()
    const handler = (async () => {
      const requestId = randomUUID()
      if (closed) { response.destroy(); return }
      const controller = new AbortController(); active.add(controller)
      let ownMediaReply: MobileMediaReply | undefined
      let capabilityContext: MobileCapabilityContext | undefined
      let privateSample: ReturnType<typeof privateSamples.claim>
      let privateReplyStatus: number | undefined
      let rangeTiming: MobileRangeTimingContext | undefined, rangeOpen: MobileRangeTimingSpan | undefined
      let rangeWindow: MobileRangeWindowContext | undefined
      const windowAbort = () => { if (!response.writableFinished) options.rangeWindowProbe?.abort(rangeWindow) }
      let rangeFailure: unknown, rangeFailed = false
      const cancel = () => { options.rangeWindowProbe?.abort(rangeWindow); controller.abort() }
      const peerClose = () => { if (!response.writableFinished) cancel() }
      request.once('aborted', cancel); response.once('close', peerClose)
      const deadline = setTimeout(() => { cancel(); response.destroy() }, MOBILE_HTTPS_LIMITS.requestMs)
      try {
        const peer = request.socket.remoteAddress?.replace(/^::ffff:/u, '')
        if (!isMobilePrivateIPv4(peer)) throw serviceFailure(400, 'INVALID_REQUEST')
        const headers = headerPairs(request), origin = authority(headers, hosts, listeningPort), target = requestTarget(request.url)
        const resolved = resolveMobileOperation(request.method ?? '', target.path.slice(1).split('/'))
        if (!resolved.ok || !operationSet.has(resolved.value)) throw serviceFailure(404, 'INVALID_REQUEST')
        const operation = resolved.value as Mobile001Operation | Mobile002Operation | Mobile003Operation | MobileContentOperation
        capabilityContext = options.preparationProbe?.claim(operation, requestId, controller.signal)
        if (capabilityContext) {
          withMobileCapabilityContext(capabilityContext, () => mobileCapabilitySync(operation === 'getServer' ? 'preparation.http.identity' : 'preparation.http.session', () => undefined))
        } else if (operation === 'getCapabilities') {
          capabilityContext = createMobileCapabilityContext(requestId, 'main', 'http', null, controller.signal)
          withMobileCapabilityContext(capabilityContext, () => mobileCapabilitySync('http.receive', () => undefined))
        } else if (options.preparationProbe) {
          // 只沿既有私有开关；每类最多八次，成功与首错分槽，不记录路径、图片ID或正文。
          privateSample = privateSamples.claim(operation)
          if (privateSample) {
            capabilityContext = createMobileCapabilityContext(requestId, 'main', 'http', null, controller.signal)
            if (capabilityContext) { capabilityContext.deferredRecords = []; capabilityContext.httpTerminalReserve = true; capabilityContext.privateContentDiagnostic = true }
            withMobileCapabilityContext(capabilityContext, () => mobileCapabilitySync('http.receive', () => undefined))
          }
        }
        const isMedia = operation === 'getMediaAsset' || operation === 'headMediaAsset'
        const lane = isMedia ? media : controls
        if (lane.size >= MOBILE_HTTPS_LIMITS.concurrentRequests) throw serviceFailure(429, isMedia ? 'RESOURCE_BUSY' : 'BUSY')
        lane.add(controller)
        const body = await withMobileCapabilityContext(capabilityContext, () => mobilePreparationAsync('preparation.http.body', () => readBody(request, headers, controller.signal)))
        const bearer = accessToken(headers)
        const resourceCapabilities = operation === 'createResource'
          ? await withAbort(options.playback!.resourceCapabilities(bearer, target.path.split('/')[4]!, origin, controller.signal), controller.signal)
          : undefined
        const decoded = withMobileCapabilityContext(capabilityContext, () => mobilePreparationSync('preparation.http.decode', () => decodeMobileRequest(operation, { method: request.method!, path: target.path, headers, query: target.query, body }, {
          responseOrigin: origin, requestPath: target.path, ...(resourceCapabilities ? { resourceCapabilities } : {}),
        })))
        if (!decoded.ok && operation === 'getMediaAsset' && decoded.issue.field === 'range') {
          await output(response, { status: 400, headers: [['Content-Length', '0']], body: new Uint8Array() }); return
        }
        if (!decoded.ok) {
          const failure = serviceFailure(decoded.issue.code === 'LIMIT_EXCEEDED' ? 413 : 400,
            decoded.issue.code === 'LIMIT_EXCEEDED' ? 'CONTENT_LIMIT_EXCEEDED' : 'INVALID_REQUEST')
          withMobileCapabilityContext(capabilityContext, () => mobileCapabilityReject('preparation.http.decode', failure))
          throw failure
        }
        if (operation === 'createSession') options.preparationProbe?.associateSession(capabilityContext, decoded.value.idempotencyKey)
        let raw: Mobile001BackendReply | Mobile002BackendReply | MobileContentBackendReply
        if ((MOBILE001_OPERATIONS as readonly string[]).includes(operation)) raw = await withAbort(withMobileCapabilityContext(capabilityContext, () => mobilePreparationAsync('preparation.http.dispatch', () => dispatch({ operation: operation as Mobile001Operation,
          request: decoded.value, accessToken: bearer, signal: controller.signal }))), controller.signal)
        else if (operation === 'getUIContentCapabilities') raw = await withAbort(withMobileCapabilityContext(capabilityContext, () => mobileCapabilityAsync('preparation.http.dispatch', () => options.dsd!.dispatch({ operation,
          request: decoded.value, accessToken: bearer, signal: controller.signal, origin }))), controller.signal)
        else if ((MOBILE_CONTENT_OPERATIONS as readonly string[]).includes(operation)) raw = await withAbort(withMobileCapabilityContext(capabilityContext, () => mobileCapabilityAsync('preparation.http.dispatch', () => options.content!.dispatch({
          operation: operation as MobileContentOperation, request: decoded.value, accessToken: bearer,
          signal: controller.signal, origin }))), controller.signal)
        else {
          rangeTiming = options.rangeTimingProbe?.claim({ requestId, method: request.method ?? '', operation,
            range: headers.find(([name]) => name.toLowerCase() === 'range')?.[1],
            ifRange: headers.find(([name]) => name.toLowerCase() === 'if-range')?.[1] })
          rangeWindow = options.rangeWindowProbe?.claim({ requestId, method: request.method ?? '', operation,
            range: headers.find(([name]) => name.toLowerCase() === 'range')?.[1],
            ifRange: headers.find(([name]) => name.toLowerCase() === 'if-range')?.[1], ...(rangeArrival ? { arrival: rangeArrival } : {}) })
          if (rangeWindow) { controller.signal.addEventListener('abort', windowAbort, { once: true }); if (controller.signal.aborted) windowAbort() }
          rangeOpen = rangeTiming?.start('open')
          const pending = withMobileRangeWindowContext(rangeWindow, () => withMobileCapabilityContext(capabilityContext, () => mobilePreparationAsync('preparation.http.dispatch', () => options.playback!.dispatch({ operation: operation as Mobile002Operation, request: decoded.value,
            accessToken: bearer, signal: controller.signal, origin, headers }))))
          // HTTP已经退场后的迟到媒体reply仍必须关闭原读句柄。
          const late = pending.then(value => withMobileRangeWindowContext(rangeWindow, async () => {
            if (controller.signal.aborted && value.kind === 'media') {
              const closing = rangeTiming?.start('actual-close')
              try { await value.reader.close(); rangeTiming?.end(closing, { quiet: 'confirmed' }) }
              catch (error) { rangeTiming?.reject(closing, error, 'failed'); throw error }
            }
          }), () => undefined)
          mediaCleanup.add(late); void late.then(() => mediaCleanup.delete(late), () => {})
          raw = await withAbort(pending, controller.signal)
          rangeTiming?.end(rangeOpen)
        }
        if ('kind' in raw && raw.kind === 'media') {
          clearTimeout(deadline); response.setTimeout(0); ownMediaReply = raw
          rangeTiming?.reply(raw.status, raw.expectedBodyBytes)
          await withMobileRangeWindowContext(rangeWindow, () => sendMobileMediaResponse(request, response, raw, controller.signal, {}, rangeTiming)); return
        }
        const reply = withMobileCapabilityContext(capabilityContext, () => privateSample
          ? mobileCapabilitySync('preparation.http.capture', () => captureReply(operation, raw, origin, target.path))
          : mobilePreparationSync('preparation.http.capture', () => captureReply(operation, raw, origin, target.path)))
        if (reply.beforeSend) await withAbort(withMobileCapabilityContext(capabilityContext, () => privateSample
          ? mobileCapabilityAsync('preparation.http.beforeSend', () => reply.beforeSend!())
          : mobilePreparationAsync('preparation.http.beforeSend', () => reply.beforeSend!())), controller.signal)
        if (closed || controller.signal.aborted || response.destroyed) throw serviceFailure(503, 'BUSY')
        if (privateSample) {
          privateReplyStatus = reply.status
          withMobileCapabilityContext(capabilityContext, () => privateStatus(reply.status))
        }
        await withMobileCapabilityContext(capabilityContext, () => mobileCapabilityAsync('http.send', () => output(response, reply)))
        if (operation === 'getUIContentCapabilities' && reply.status === 200 && response.writableFinished) options.preparationProbe?.arm()
      } catch (error) {
        rangeFailed = true; rangeFailure = error; rangeTiming?.reject(rangeOpen, error)
        withMobileCapabilityContext(capabilityContext, () => mobileCapabilityReject('http.failure', error))
        if (!closed && !controller.signal.aborted && !response.destroyed && !response.headersSent) {
          const reply = safeReply(error, requestId)
          if (privateSample) {
            privateReplyStatus = reply.status
            withMobileCapabilityContext(capabilityContext, () => privateStatus(reply.status))
          }
          if (request.method === 'HEAD') { reply.body = new Uint8Array(); reply.headers = [...reply.headers.filter(([name]) => name.toLowerCase() !== 'content-length'), ['Content-Length', '0']] }
          await withMobileCapabilityContext(capabilityContext, () => privateSample
            ? mobileCapabilityAsync('http.send', () => output(response, reply)) : mobilePreparationAsync('http.send', () => output(response, reply)))
        }
        else if (!response.writableFinished) response.destroy()
      } finally {
        clearTimeout(deadline); active.delete(controller)
        controls.delete(controller); media.delete(controller)
        request.removeListener('aborted', cancel); response.removeListener('close', peerClose)
        options.preparationProbe?.finish(capabilityContext, { failed: rangeFailed, finished: response.writableFinished,
          httpStatus: response.headersSent ? response.statusCode : null })
        controller.signal.removeEventListener('abort', windowAbort)
        controller.abort()
        if (ownMediaReply) {
          const cleanup = getMobileMediaReleaseCompletion(ownMediaReply)
          if (cleanup) { mediaCleanup.add(cleanup); void cleanup.then(() => mediaCleanup.delete(cleanup), () => {}) }
        }
        privateSample?.finish(capabilityContext, privateReplyStatus, rangeFailed, response.writableFinished)
        closeMobileCapabilityContext(capabilityContext)
        rangeTiming?.finish(rangeFailed ? 'reject' : 'ok', rangeFailure)
        options.rangeWindowProbe?.finish(rangeWindow, { status: response.headersSent ? response.statusCode : null, finished: response.writableFinished, failed: rangeFailed, error: rangeFailure })
      }
    })()
    handlers.add(handler)
    void handler.catch(() => response.destroy()).finally(() => handlers.delete(handler))
  })
  return {
    start() {
      if (closed) return Promise.reject(new MobileHttpsServerError('CLOSED'))
      if (startFlight) return startFlight
      startFlight = new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); server.removeListener('error', failed); server.removeListener('listening', ready) }
        const failed = () => { cleanup(); reject(new MobileHttpsServerError('START_FAILED')) }
        const ready = () => {
          cleanup()
          const address = server.address()
          if (closed || !address || typeof address === 'string') { reject(new MobileHttpsServerError('CLOSED')); return }
          listeningPort = address.port
          resolve({ baseUrl: `https://${host}${listeningPort === 443 ? '' : `:${listeningPort}`}`, certificateSha256 })
        }
        const timer = setTimeout(() => { failed(); server.close() }, MOBILE_HTTPS_LIMITS.startMs)
        server.once('error', failed); server.once('listening', ready)
        try { server.listen({ host, port, exclusive: true }) } catch { failed() }
      })
      return startFlight
    },
    close() {
      if (closeFlight) return closeFlight
      closed = true
      for (const controller of active) controller.abort()
      closeFlight = (async () => {
        if (startFlight) await startFlight.catch(() => {})
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { for (const socket of sockets) socket.destroy() }, MOBILE_HTTPS_LIMITS.closeMs)
          server.close(() => { clearTimeout(timer); resolve() })
          server.closeIdleConnections()
        })
        const results = await Promise.allSettled([...handlers])
        results.push(...await Promise.allSettled([...mediaCleanup]))
        if (results.some(result => result.status === 'rejected')) throw new MobileHttpsServerError('CLOSED')
      })()
      return closeFlight
    },
  }
}
