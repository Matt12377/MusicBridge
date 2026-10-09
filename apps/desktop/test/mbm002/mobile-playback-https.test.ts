import assert from 'node:assert/strict'
import test, { before, after } from 'node:test'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import type { ClientRequest } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  MOBILE_API_RESPONSE_MAX_BYTES, type MobileHeaderPairs, type MobileResourceCodecContext,
  type MobileResourceRequest, type MobileResourceSemanticContext, type MobileReadyResource, type MobilePreparingResource,
} from '@music-bridge/contracts'
import { MobileServiceError, type Mobile001Backend, type Mobile001BackendReply } from '../../../../packages/bridge-core/src/mobile/types.js'
import { createMobileHttpsServer, MOBILE_HTTPS_LIMITS, MobileHttpsServerError } from '../../src/main/mobile-https-server.js'
import { MOBILE002_OPERATIONS, type Mobile002Backend, type Mobile002BackendReply, type Mobile002Operation } from '../../src/main/mobile-playback-backend.js'
import { loadOrCreateMobileIdentity, type MobileTlsIdentity } from '../../src/main/mobile-tls-identity.js'
import type { MobileMediaReply, MobileMediaReader } from '../../src/main/mobile-media-response.js'

/** 实际TLS+真实HTTPS门面+原wire codec；backend/reader受控，不冒充Owner/FD/设备证据。 */
let identity: MobileTlsIdentity, owned = ''
before(async () => {
  const parent = process.env.TMPDIR ?? (process.platform === 'darwin' ? '/Volumes/LifeWeave/Developer/CommandLine/tmp' : os.tmpdir())
  if (process.platform === 'darwin' && !parent.startsWith('/Volumes/LifeWeave/Developer/CommandLine/')) throw new Error('合成材料必须使用外置目录。')
  owned = await mkdtemp(path.join(parent, 'mbm002-playback-route-'))
  const key = randomBytes(32)
  identity = await loadOrCreateMobileIdentity({ directory: path.join(owned, 'identity'), hosts: ['127.0.0.1'], secretProtector: {
    encryptString(value) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
      const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), bytes])
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
    },
  } })
})
after(async () => { if (owned) await rm(owned, { recursive: true, force: true }) })
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
const ticket = 'synthetic-ticket-0000000001'
const mediaPath = `/mobile/v1/media/resource.owned/file?ticket=${ticket}`
const sessionId = 'session.owned'
const resourcePath = `/mobile/v1/sessions/${sessionId}/resources/resource.owned`
const resourceRequest: MobileResourceRequest = {
  trackId: 'local:track.owned', versionId: 'local:version.owned', contentRevision: 'revision.owned',
  quality: { profile: 'lossless', allowLossyFallback: false, preferredTransport: 'file' },
  formats: [{ codec: 'pcm_s16le', container: 'wav', maxSampleRateHz: 48000, maxChannels: 2 }],
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function capabilities(origin: string, bits = true): MobileResourceCodecContext {
  return { scope: { serverId: identity.serverId, deviceId: 'device.owned', sessionId }, responseOrigin: origin,
    now: new Date().toISOString(), resourceFormatBitDepth: bits, capabilityVersion: bits ? '1.0.0' : 'base', capabilitySnapshotIdentity: 'snapshot.owned' }
}
function semantic(origin: string, request = resourceRequest): MobileResourceSemanticContext {
  return { ...capabilities(origin), request, source: 'local', expectedResourceId: 'resource.owned',
    sourceAudio: { codec: 'pcm_s16le', container: 'wav', sampleRateHz: 48000, bitsPerSample: 16, channels: 2 } }
}
function resource(origin: string, ready: true, request?: MobileResourceRequest): MobileReadyResource
function resource(origin: string, ready: false, request?: MobileResourceRequest): MobilePreparingResource
function resource(origin: string, ready: boolean, request = resourceRequest): MobileReadyResource | MobilePreparingResource {
  const common = { id: 'resource.owned', sessionId, trackId: request.trackId, versionId: request.versionId, contentRevision: request.contentRevision,
    sourceAudio: semantic(origin, request).sourceAudio, processing: { mode: 'direct' as const, reason: '合成原样验证', fromPreparedCache: false } }
  return ready ? { ...common, state: 'ready', media: { url: `${origin}${mediaPath}`, transport: 'file', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    durationMs: 1000, seekable: true, actualAudio: common.sourceAudio } } : { ...common, state: 'preparing' }
}
function jsonReply(body: unknown, status = 200): Mobile001BackendReply {
  const bytes = new TextEncoder().encode(JSON.stringify(body))
  return { status, headers: [['Content-Type', 'application/json'], ['Content-Length', String(bytes.byteLength)]], body: bytes }
}
function buffered(body: unknown, status = 200, context?: MobileResourceSemanticContext): Mobile002BackendReply {
  return { kind: 'buffered', ...jsonReply(body, status), ...(context ? { resourceContext: context } : {}) }
}
function empty(): Mobile002BackendReply { return { kind: 'buffered', status: 204, headers: [['Content-Length', '0']], body: new Uint8Array() } }
function oldBackend(): Mobile001Backend {
  return { dispatch: async () => jsonReply({ serverId: identity.serverId, displayName: '合成播放路由', contractVersion: '0.1.0', environment: 'development' }) }
}
function playback(dispatch: Mobile002Backend['dispatch'], cap?: Mobile002Backend['resourceCapabilities']): Mobile002Backend {
  return { dispatch, resourceCapabilities: cap ?? (async (token, requestedSession, origin, signal) => {
    signal.throwIfAborted(); if (!token) throw new MobileServiceError(401, 'UNAUTHORIZED')
    assert.equal(requestedSession, sessionId); return capabilities(origin)
  }) }
}
function source(bytes: Uint8Array) {
  let offset = 0, closes = 0
  const closed = deferred<void>()
  const pulls: number[] = [], signals: AbortSignal[] = []
  const reader: MobileMediaReader = {
    async read(max, signal) {
      pulls.push(max); signals.push(signal)
      if (offset === bytes.length) return null
      const chunk = bytes.subarray(offset, Math.min(offset + max, bytes.length)); offset += chunk.length; return chunk
    },
    async close() { closes++; closed.resolve() },
  }
  return { reader, pulls, signals, closed: closed.promise, get closes() { return closes } }
}
function media(reader: MobileMediaReader, length: number, overrides: Partial<MobileMediaReply> = {}): Mobile002BackendReply {
  return { kind: 'media', operation: 'getMediaAsset', status: 200,
    headers: [['Content-Type', 'audio/wav'], ['Content-Length', String(length)], ['Accept-Ranges', 'bytes']],
    expectedBodyBytes: length, fullContentLength: length, resourceAbortSignal: new AbortController().signal,
    ticketExpiresAtMs: Date.now() + 60_000, beforeSend: async () => {}, reader, ...overrides }
}
async function fixture(t: test.TestContext, mounted?: Mobile002Backend, legacy = oldBackend(), port = 0) {
  const server = createMobileHttpsServer({ tls: { key: identity.privateKeyPEM, cert: identity.certificatePEM },
    host: '127.0.0.1', port, backend: legacy, ...(mounted ? { playback: mounted } : {}) })
  t.after(() => server.close())
  return { server, ...await server.start() }
}
interface ClientOptions { method?: string; headers?: readonly string[]; body?: Uint8Array; timeoutMs?: number; onChunk?: (chunk: Buffer) => void }
interface ClientResult { status: number; body: Buffer; headers: string[] }
function client(base: string, target: string, options: ClientOptions = {}) {
  const url = new URL(base), headers = ['Host', url.host, 'Connection', 'close', ...(options.headers ?? [])]
  if (options.body && !headers.some((key, i) => i % 2 === 0 && key.toLowerCase() === 'content-length')) headers.push('Content-Length', String(options.body.byteLength))
  let request!: ClientRequest
  const result = new Promise<ClientResult>((resolve, reject) => {
    request = httpsRequest({ hostname: url.hostname, port: url.port, path: target, method: options.method ?? 'GET', headers,
      ca: identity.certificatePEM, agent: false }, response => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { chunks.push(Buffer.from(chunk)); options.onChunk?.(chunk) })
      response.once('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks), headers: [...response.rawHeaders] }))
      response.once('error', () => reject(new Error('合成HTTPS响应已中断。')))
      response.once('aborted', () => reject(new Error('合成HTTPS响应已中断。')))
    })
    request.once('error', () => reject(new Error('合成HTTPS请求已关闭。')))
    request.setTimeout(options.timeoutMs ?? 5000, () => request.destroy()); request.end(options.body)
  })
  return { request, result }
}
const read = (base: string, target: string, options?: ClientOptions) => client(base, target, options).result
function header(result: ClientResult, name: string): string | undefined {
  const index = result.headers.findIndex((key, position) => position % 2 === 0 && key.toLowerCase() === name)
  return index < 0 ? undefined : result.headers[index + 1]
}
function jsonRequest(body: unknown, method = 'POST'): ClientOptions {
  return { method, headers: ['Authorization', 'Bearer synthetic.access', 'Content-Type', 'application/json', 'Idempotency-Key', 'original.owned.intent'],
    body: new TextEncoder().encode(JSON.stringify(body)) }
}
const operationRequests: readonly [Mobile002Operation, string, ClientOptions][] = [
  ['createSession', '/mobile/v1/sessions', jsonRequest({ clientInstanceId: 'client.owned' })],
  ['getSession', `/mobile/v1/sessions/${sessionId}`, { headers: ['Authorization', 'Bearer synthetic.access'] }],
  ['closeSession', `/mobile/v1/sessions/${sessionId}`, { method: 'DELETE', headers: ['Authorization', 'Bearer synthetic.access'] }],
  ['reportObservation', `/mobile/v1/sessions/${sessionId}/observation`, jsonRequest({ sequence: 1, playerGeneration: 0,
    queueItemId: 'queue.owned', resourceId: 'resource.owned', trackId: 'local:track.owned', positionMs: 0, state: 'ready' }, 'PUT')],
  ['createResource', `/mobile/v1/sessions/${sessionId}/resources`, jsonRequest(resourceRequest)],
  ['getResource', resourcePath, { headers: ['Authorization', 'Bearer synthetic.access'] }],
  ['releaseResource', resourcePath, { method: 'DELETE', headers: ['Authorization', 'Bearer synthetic.access'] }],
  ['renewResource', `${resourcePath}/renew`, jsonRequest({})],
  ['getMediaAsset', mediaPath, {}], ['headMediaAsset', mediaPath, { method: 'HEAD' }],
]

test('002未显式挂载时原001十操作边界保持，新十操作全部404且不取得播放scope', { timeout: 10_000 }, async t => {
  const h = await fixture(t)
  for (const [, target, options] of operationRequests) assert.equal((await read(h.baseUrl, target, options)).status, 404)
  const old = await read(h.baseUrl, '/mobile/v1/server'); assert.equal(old.status, 200)
  assert.equal((JSON.parse(old.body.toString()) as { serverId: string }).serverId, identity.serverId)
})

test('002显式mount只新增原十操作，真实raw头/完整body/key/origin传typed backend而后续UI仍拒绝', { timeout: 10_000 }, async t => {
  const calls: Mobile002Operation[] = []; let caps = 0, expectedOrigin = ''
  const h = await fixture(t, playback(async input => {
    calls.push(input.operation); assert.equal(input.origin, expectedOrigin)
    assert.ok(input.request.path.startsWith('/mobile/v1/')); assert.equal(input.signal.aborted, false)
    if (input.operation === 'createSession') {
      assert.equal(input.accessToken, 'synthetic.access'); assert.equal(input.request.idempotencyKey, 'original.owned.intent')
      assert.deepEqual(structuredClone(input.request.body), { clientInstanceId: 'client.owned' })
      assert.ok(input.headers.some(([key, value]) => key === 'Authorization' && value === 'Bearer synthetic.access'))
    }
    throw new MobileServiceError(401, 'UNAUTHORIZED')
  }, async (token, scope, origin, signal) => { caps++; assert.equal(token, 'synthetic.access'); assert.equal(scope, sessionId)
    assert.equal(origin, expectedOrigin); assert.equal(signal.aborted, false); return capabilities(origin) }))
  expectedOrigin = h.baseUrl
  for (const [, target, options] of operationRequests) assert.equal((await read(h.baseUrl, target, options)).status, 401)
  assert.deepEqual(calls, [...MOBILE002_OPERATIONS]); assert.equal(caps, 1)
  for (const target of ['/mobile/v1/ui/capabilities', '/mobile/v1/ui/netease/daily-recommendations', '/mobile/v1/not-a-route']) {
    assert.equal((await read(h.baseUrl, target)).status, 404)
  }
  assert.equal(calls.length, 10); assert.equal(caps, 1)
})

test('002重复raw头/query、额外body/方法和坏ticket在真正wire解码前后闭合拒绝，零backend', { timeout: 10_000 }, async t => {
  let calls = 0, caps = 0
  const h = await fixture(t, playback(async () => { calls++; throw new MobileServiceError(401, 'UNAUTHORIZED') }, async (_token, _session, origin) => { caps++; return capabilities(origin) }))
  const invalid: readonly [string, ClientOptions][] = [
    [resourcePath, { headers: ['Authorization', 'Bearer a', 'authorization', 'Bearer b'] }],
    [mediaPath, { headers: ['Range', 'bytes=0-1', 'range', 'bytes=2-3'] }],
    [`${mediaPath}&ticket=second-ticket-0000000`, {}], ['/mobile/v1/media/resource.owned/file?ticket=short', {}],
    [resourcePath, { body: Buffer.from('{}') }], [resourcePath, { method: 'PATCH' }],
    ['/mobile/v1/media/%2e%2e/file?ticket=synthetic-ticket-0000000001', {}],
  ]
  for (const [target, options] of invalid) assert.ok([400, 404].includes((await read(h.baseUrl, target, options)).status))
  assert.equal(calls, 0); assert.equal(caps, 0)
})

test('002createResource只用认证capabilities决定位深分支，false/缺认证/null拒绝不投递', { timeout: 10_000 }, async t => {
  let allowBits = false, calls = 0, capCalls = 0
  const h = await fixture(t, playback(async input => {
    calls++; assert.equal(input.operation, 'createResource')
    const request = input.request.body as MobileResourceRequest
    return buffered(resource(input.origin, false, request), 202, semantic(input.origin, request))
  }, async (token, requestedSession, origin, signal) => {
    capCalls++; signal.throwIfAborted(); if (!token) throw new MobileServiceError(401, 'UNAUTHORIZED')
    assert.equal(requestedSession, sessionId); return capabilities(origin, allowBits)
  }))
  const target = `/mobile/v1/sessions/${sessionId}/resources`
  const withBits = (bits: unknown) => ({ ...resourceRequest, formats: [{ ...resourceRequest.formats[0], maxBitsPerSample: bits }] })
  assert.equal((await read(h.baseUrl, target, jsonRequest(withBits(16)))).status, 400); assert.equal(calls, 0)
  assert.equal((await read(h.baseUrl, target, jsonRequest(resourceRequest))).status, 202); assert.equal(calls, 1)
  allowBits = true
  for (const bits of [1, 64]) assert.equal((await read(h.baseUrl, target, jsonRequest(withBits(bits)))).status, 202)
  assert.equal(calls, 3)
  for (const bits of [null, 0, 65]) assert.equal((await read(h.baseUrl, target, jsonRequest(withBits(bits)))).status, 400)
  const untrusted = jsonRequest(resourceRequest)
  assert.equal((await read(h.baseUrl, target, { ...untrusted, headers: ['Content-Type', 'application/json', 'Idempotency-Key', 'original.owned.intent'] })).status, 401)
  assert.equal(calls, 3); assert.equal(capCalls, 8)
})

test('002ready资源完整body采用真实HTTPS origin及scope，异源media URL/错session不被消费', { timeout: 10_000 }, async t => {
  let mode: 'ready' | 'foreign-origin' | 'foreign-session' = 'ready'
  let emitted: MobileReadyResource | undefined
  const h = await fixture(t, playback(async input => {
    const body = resource(input.origin, true)
    if (mode === 'foreign-origin') body.media.url = `https://127.0.0.1:1${mediaPath}`
    if (mode === 'foreign-session') body.sessionId = 'session.foreign'
    emitted = body; return buffered(body, 201, semantic(input.origin))
  }))
  const good = await read(h.baseUrl, `/mobile/v1/sessions/${sessionId}/resources`, jsonRequest(resourceRequest))
  assert.equal(good.status, 201); assert.equal(digest(good.body), digest(new TextEncoder().encode(JSON.stringify(emitted))))
  const actual = JSON.parse(good.body.toString()) as MobileReadyResource
  assert.equal(new URL(actual.media.url).origin, h.baseUrl); assert.equal(actual.sessionId, sessionId)
  for (const invalid of ['foreign-origin', 'foreign-session'] as const) {
    mode = invalid; const result = await read(h.baseUrl, `/mobile/v1/sessions/${sessionId}/resources`, jsonRequest(resourceRequest))
    assert.equal(result.status, 503); assert.ok(result.body.length < 1024)
  }
})

test('002真实GET200/206/suffix/open/If-Range完整回退与400/416零body，坏Range零投递', { timeout: 10_000 }, async t => {
  const bytes = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]); let calls = 0
  const readers: ReturnType<typeof source>[] = []
  const h = await fixture(t, playback(async input => {
    calls++; const range = input.headers.find(([key]) => key.toLowerCase() === 'range')?.[1]
    const ifRange = input.headers.some(([key]) => key.toLowerCase() === 'if-range')
    let start = 0, end = 7, status: 200 | 206 = 200
    if (!ifRange && range === 'bytes=2-4') { start = 2; end = 4; status = 206 }
    if (!ifRange && range === 'bytes=-2') { start = 6; status = 206 }
    if (!ifRange && range === 'bytes=6-') { start = 6; status = 206 }
    const s = source(bytes.subarray(start, end + 1)); readers.push(s)
    if (!ifRange && (range === 'bytes=8-' || range === 'bytes=-0')) return media(s.reader, 8, { status: 416, expectedBodyBytes: 0, rangeRequested: range,
      headers: [['Content-Length', '0'], ['Content-Range', 'bytes */8']] })
    return media(s.reader, 8, { status, expectedBodyBytes: end - start + 1,
      ...(range !== undefined && !ifRange ? { rangeRequested: range } : {}), headers: [['Content-Type', 'audio/wav'], ['Content-Length', String(end - start + 1)],
        ['Accept-Ranges', 'bytes'], ...(status === 206 ? [['Content-Range', `bytes ${start}-${end}/8`] as [string, string]] : [])] })
  }))
  const full = await read(h.baseUrl, mediaPath); assert.equal(full.status, 200); assert.equal(digest(full.body), digest(bytes)); assert.equal(header(full, 'accept-ranges'), 'bytes')
  for (const [range, selected] of [['bytes=2-4', bytes.subarray(2, 5)], ['bytes=-2', bytes.subarray(6)], ['bytes=6-', bytes.subarray(6)]] as const) {
    const result = await read(h.baseUrl, mediaPath, { headers: ['Range', range] }); assert.equal(result.status, 206)
    assert.equal(digest(result.body), digest(selected)); assert.ok(header(result, 'content-range'))
  }
  const fallback = await read(h.baseUrl, mediaPath, { headers: ['Range', 'garbled', 'If-Range', 'untrusted-validator'] })
  assert.equal(fallback.status, 200); assert.equal(digest(fallback.body), digest(bytes)); assert.equal(header(fallback, 'content-range'), undefined)
  for (const range of ['bytes=8-', 'bytes=-0']) {
    const result = await read(h.baseUrl, mediaPath, { headers: ['Range', range] }); assert.equal(result.status, 416)
    assert.equal(result.body.length, 0); assert.equal(header(result, 'content-range'), 'bytes */8')
  }
  const acceptedCalls = calls
  for (const range of ['bytes=0-1,2-3', 'bytes=3-1', 'bytes=9007199254740992-', 'invalid']) {
    const result = await read(h.baseUrl, mediaPath, { headers: ['Range', range] }); assert.equal(result.status, 400)
    assert.equal(result.body.length, 0); assert.equal(header(result, 'content-length'), '0')
  }
  assert.equal(calls, acceptedCalls); assert.ok(readers.every(s => s.closes === 1)); assert.ok(readers.slice(-2).every(s => s.pulls.length === 0))
})

test('002D2 HEAD忽略Range且零pull；全部安全错误/非法query仍0body/CL0', { timeout: 10_000 }, async t => {
  let denied: 401 | 404 | 503 | undefined, calls = 0
  const readers: ReturnType<typeof source>[] = []
  const h = await fixture(t, playback(async input => {
    calls++; assert.equal(input.operation, 'headMediaAsset')
    if (denied) throw new MobileServiceError(denied, denied === 401 ? 'UNAUTHORIZED' : 'BUSY')
    const s = source(Buffer.alloc(8)); readers.push(s); return media(s.reader, 8, { operation: 'headMediaAsset', expectedBodyBytes: 0 })
  }))
  for (const range of ['bytes=0-1', 'bytes=8-', 'bytes=1-0', 'bytes=0-1,2-3', 'invalid']) {
    const result = await read(h.baseUrl, mediaPath, { method: 'HEAD', headers: ['Range', range] })
    assert.equal(result.status, 200); assert.equal(header(result, 'content-length'), '8'); assert.equal(header(result, 'content-range'), undefined)
    assert.equal(result.body.length, 0)
  }
  for (const status of [401, 404, 503] as const) {
    denied = status; const result = await read(h.baseUrl, mediaPath, { method: 'HEAD' })
    assert.equal(result.status, status); assert.equal(header(result, 'content-length'), '0'); assert.equal(result.body.length, 0)
  }
  const beforeInvalid = calls
  for (const target of ['/mobile/v1/media/resource.owned/file?ticket=short', `${mediaPath}&ticket=another-synthetic-ticket`, '/mobile/v1/ui/capabilities']) {
    const result = await read(h.baseUrl, target, { method: 'HEAD' }); assert.ok([400, 404].includes(result.status))
    assert.equal(result.body.length, 0); assert.equal(header(result, 'content-length'), '0')
  }
  assert.equal(calls, beforeInvalid); assert.ok(readers.every(s => s.pulls.length === 0 && s.closes === 1))
})

test('002大媒体不放宽原元数据2MiB预算，完整JSON B通过而B+1安全拒绝', { timeout: 10_000 }, async t => {
  const info = { serverId: identity.serverId, displayName: '', contractVersion: '0.1.0', environment: 'development' }
  let oversized = false
  const bytes = randomBytes(MOBILE_API_RESPONSE_MAX_BYTES + 17), s = source(bytes)
  const legacy: Mobile001Backend = { dispatch: async () => {
    const full = { ...info, displayName: 'x'.repeat(MOBILE_API_RESPONSE_MAX_BYTES - Buffer.byteLength(JSON.stringify(info))) }
    const body = new TextEncoder().encode(JSON.stringify(full))
    return { status: 200, headers: [['Content-Type', 'application/json'], ['Content-Length', String(body.length + (oversized ? 1 : 0))]],
      body: oversized ? new Uint8Array(Buffer.concat([Buffer.from(body), Buffer.from([32])])) : body }
  } }
  const h = await fixture(t, playback(async () => media(s.reader, bytes.length)), legacy)
  const exact = await read(h.baseUrl, '/mobile/v1/server'); assert.equal(exact.status, 200); assert.equal(exact.body.length, MOBILE_API_RESPONSE_MAX_BYTES)
  oversized = true; const excess = await read(h.baseUrl, '/mobile/v1/server'); assert.equal(excess.status, 503); assert.ok(excess.body.length < 1024)
  const audio = await read(h.baseUrl, mediaPath); assert.equal(audio.status, 200); assert.equal(audio.body.length, bytes.length)
  assert.equal(digest(audio.body), digest(bytes)); assert.ok(s.pulls.every(max => max <= 65536))
  await s.closed; await h.server.close(); assert.equal(s.closes, 1)
})

test('002close等待真实在途reader quiet并封新入口，同一close Promise不能早于释放确认', { timeout: 10_000 }, async t => {
  const entered = deferred<void>(), quiet = deferred<void>(); let closes = 0, readSignal: AbortSignal | undefined
  const reader: MobileMediaReader = { read: async (_max, signal) => { readSignal = signal; entered.resolve(); return new Promise<Uint8Array | null>(() => {}) },
    close: async () => { closes++; await quiet.promise } }
  const h = await fixture(t, playback(async () => media(reader, 1)))
  const pending = client(h.baseUrl, mediaPath), cancelled = pending.result.catch(() => null)
  let closed = false, closing: Promise<void> | undefined
  try {
    await entered.promise; closing = h.server.close(); assert.equal(h.server.close(), closing)
    void closing.then(() => { closed = true }); await settle(); await settle()
    assert.equal(readSignal?.aborted, true); assert.equal(closes, 1); assert.equal(closed, false)
    await assert.rejects(() => h.server.start(), (error: unknown) => error instanceof MobileHttpsServerError && error.code === 'CLOSED')
  } finally { quiet.resolve(); if (closing) await closing; else await h.server.close() }
  assert.equal(closed, true); assert.equal(closes, 1); assert.equal(await cancelled, null)
})

test('002peer先取消而backend迟到媒体reply仍关闭原reader，不发旧body或重dispatch', { timeout: 10_000 }, async t => {
  const entered = deferred<void>(), late = deferred<Mobile002BackendReply>(), released = deferred<void>(), quiet = deferred<void>()
  let calls = 0, closes = 0, backendSignal: AbortSignal | undefined
  const s = source(Buffer.from([1]))
  const reader: MobileMediaReader = { read: s.reader.read, close: async () => { closes++; released.resolve(); await quiet.promise } }
  const h = await fixture(t, playback(async input => { calls++; backendSignal = input.signal; entered.resolve(); return late.promise }))
  const pending = client(h.baseUrl, mediaPath), cancelled = pending.result.catch(() => null)
  try {
    await entered.promise
    const serverSignal = backendSignal
    assert.ok(serverSignal)
    // 客户端error只证明本地socket退场；先订阅并等待真实服务端取消，再释放迟到reply。
    const serverAborted = new Promise<void>(resolve => {
      serverSignal.addEventListener('abort', () => resolve(), { once: true })
      if (serverSignal.aborted) resolve()
    })
    pending.request.destroy(); await cancelled; await serverAborted
    late.resolve(media(reader, 1)); await released.promise
    assert.equal(backendSignal?.aborted, true); assert.equal(calls, 1); assert.equal(s.pulls.length, 0); assert.equal(closes, 1)
    let closed = false; const closing = h.server.close(); void closing.then(() => { closed = true })
    await settle(); assert.equal(closed, false); quiet.resolve(); await closing; assert.equal(closed, true)
  } finally { late.resolve(media(reader, 1)); quiet.resolve(); await h.server.close() }
})

test('002媒体16槽满仍准入metadata/控制，第17媒体安全429且关闭全部原读flight', { timeout: 10_000 }, async t => {
  const entered = deferred<void>(); let mediaCalls = 0, controls = 0, closes = 0
  const h = await fixture(t, playback(async input => {
    if (input.operation === 'releaseResource') { controls++; return empty() }
    mediaCalls++
    const reader: MobileMediaReader = { read: async () => {
      if (mediaCalls === 16) entered.resolve(); return new Promise<Uint8Array | null>(() => {})
    }, close: async () => { closes++ } }
    return media(reader, 1)
  }))
  const pending = Array.from({ length: 16 }, () => read(h.baseUrl, mediaPath).catch(() => null))
  try {
    await entered.promise; const overflow = await read(h.baseUrl, mediaPath); assert.equal(overflow.status, 429); assert.equal(mediaCalls, 16)
    assert.equal((await read(h.baseUrl, '/mobile/v1/server')).status, 200)
    assert.equal((await read(h.baseUrl, resourcePath, { method: 'DELETE', headers: ['Authorization', 'Bearer synthetic.access'] })).status, 204)
    assert.equal(controls, 1); assert.equal(closes, 0)
  } finally { await h.server.close() }
  assert.ok((await Promise.all(pending)).every(result => result === null)); assert.equal(closes, 16)
})

test('002metadata16槽满不占媒体槽，原第17metadata仍429而真实媒体独立完成', { timeout: 10_000 }, async t => {
  const entered = deferred<void>(); let calls = 0, cancelled = 0
  const legacy: Mobile001Backend = { dispatch: async input => {
    calls++; if (calls === MOBILE_HTTPS_LIMITS.concurrentRequests) entered.resolve()
    return new Promise<Mobile001BackendReply>((_resolve, reject) => input.signal.addEventListener('abort', () => { cancelled++; reject(new MobileServiceError(503, 'BUSY')) }, { once: true }))
  } }
  const s = source(Buffer.from([1, 2, 3])), h = await fixture(t, playback(async () => media(s.reader, 3)), legacy)
  const pending = Array.from({ length: 16 }, () => read(h.baseUrl, '/mobile/v1/server').catch(() => null))
  try {
    await entered.promise; assert.equal((await read(h.baseUrl, '/mobile/v1/server')).status, 429); assert.equal(calls, 16)
    const actual = await read(h.baseUrl, mediaPath); assert.equal(actual.status, 200); assert.equal(digest(actual.body), digest(Buffer.from([1, 2, 3])))
    assert.equal(s.closes, 1)
  } finally { await h.server.close() }
  assert.ok((await Promise.all(pending)).every(result => result === null)); assert.equal(cancelled, 16)
})

test('002实际beforeSend撤销发生于头前/块间，旧成功正文不发或断流且绝不追加JSON', { timeout: 10_000 }, async t => {
  let phase: 'before-header' | 'between-blocks' = 'before-header', fences = 0, reads = 0, closes = 0
  const firstData = deferred<void>(), releaseFence = deferred<void>()
  const h = await fixture(t, playback(async () => {
    const reader: MobileMediaReader = { read: async () => { reads++; return reads <= 2 ? Buffer.from([reads]) : null }, close: async () => { closes++ } }
    return media(reader, 2, { beforeSend: async () => {
      fences++
      if (phase === 'before-header') throw new MobileServiceError(401, 'UNAUTHORIZED')
      if (fences === 3) { await releaseFence.promise; throw new MobileServiceError(401, 'UNAUTHORIZED') }
    } })
  }))
  const first = await read(h.baseUrl, mediaPath); assert.equal(first.status, 401); assert.equal(reads, 0); assert.equal(closes, 1)
  phase = 'between-blocks'; fences = 0; let actualBytes = 0
  const pending = client(h.baseUrl, mediaPath, { onChunk: chunk => { actualBytes += chunk.length; firstData.resolve() } })
  const rejected = assert.rejects(() => pending.result)
  try { await firstData.promise; assert.equal(actualBytes, 1); releaseFence.resolve(); await rejected }
  finally { releaseFence.resolve(); await h.server.close() }
  assert.equal(actualBytes, 1); assert.equal(closes, 2); assert.equal(fences, 3)
})

test('002真实TLS媒体持续超过15秒可完成，原metadata整体15秒仍取消而不放宽', { timeout: 25_000 }, async t => {
  let metadataAborted = false, metadataAbortedAt = 0, closes = 0, index = 0
  const closed = deferred<void>()
  const legacy: Mobile001Backend = { dispatch: async input => new Promise<Mobile001BackendReply>((_resolve, reject) => {
    input.signal.addEventListener('abort', () => { metadataAborted = true; metadataAbortedAt = performance.now(); reject(new MobileServiceError(503, 'BUSY')) }, { once: true })
  }) }
  const reader: MobileMediaReader = { read: async (_max, signal) => {
    if (index === 17) return null
    if (index) await new Promise<void>((resolve, reject) => {
      const stopped = () => { clearTimeout(timer); signal.removeEventListener('abort', stopped); reject(new MobileServiceError(503, 'BUSY')) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', stopped); resolve() }, 1000)
      signal.addEventListener('abort', stopped, { once: true }); if (signal.aborted) stopped()
    })
    return Buffer.from([++index])
  }, close: async () => { closes++; closed.resolve() } }
  const h = await fixture(t, playback(async () => media(reader, 17)), legacy)
  const started = performance.now()
  const metadata = read(h.baseUrl, '/mobile/v1/server', { timeoutMs: 20_000 }).catch(() => null)
  const audio = await read(h.baseUrl, mediaPath, { timeoutMs: 5000 })
  assert.ok(performance.now() - started >= 15_000)
  assert.equal(audio.status, 200); assert.equal(digest(audio.body), digest(Buffer.from(Array.from({ length: 17 }, (_, i) => i + 1))))
  assert.equal(await metadata, null); assert.equal(metadataAborted, true)
  await closed.promise; await h.server.close(); assert.equal(closes, 1)
  assert.ok(metadataAbortedAt - started >= 14_900 && metadataAbortedAt - started < 18_000)
})
