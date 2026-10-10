import assert from 'node:assert/strict'
import test, { before, after } from 'node:test'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  MOBILE_API_RESPONSE_MAX_BYTES, MOBILE_DSD_PCM_PROCESSING_REASON, decodeMobileResponse,
  isMobileErrorEnvelope, isMobileUIContentCapabilities, type MobileErrorEnvelope,
  type MobileHeaderPairs, type MobileReadyResource, type MobileResourceRequest, type MobileResourceSemanticContext,
} from '@music-bridge/contracts'
import { MobileServiceError, type Mobile001Backend } from '../../../../packages/bridge-core/src/mobile/types.js'
import { createMobileHttpsServer, MobileHttpsServerError } from '../../src/main/mobile-https-server.js'
import type { Mobile003Backend } from '../../src/main/mobile-backend.js'
import type { Mobile002Backend, Mobile002BackendReply } from '../../src/main/mobile-playback-backend.js'
import { loadOrCreateMobileIdentity, type MobileTlsIdentity } from '../../src/main/mobile-tls-identity.js'
import { DSD_TEST_REQUEST, dsdContext, mobileDsdMainFixture } from './mobile-dsd-main-fixture.js'

/** 真Node TLS/HTTPS+Main/auth/actor+whole codec；Owner及转换源端口受控。
 * runtime合成protector不证明Keychain，受控媒体字节不证明真实FLAC/转换器/iOS/听感。
 */
let owned = '', identity: MobileTlsIdentity
before(async () => {
  const parent = process.env.TMPDIR ?? (process.platform === 'darwin' ? '/Volumes/LifeWeave/Developer/CommandLine/tmp' : os.tmpdir())
  if (process.platform === 'darwin' && !parent.startsWith('/Volumes/LifeWeave/Developer/CommandLine/')) throw new Error('自有TLS材料必须使用外置目录。')
  owned = await mkdtemp(path.join(parent, 'mbm003-main-https-'))
  const key = randomBytes(32)
  identity = await loadOrCreateMobileIdentity({ directory: path.join(owned, 'identity'), hosts: ['127.0.0.1'], secretProtector: {
    encryptString(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
      const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]) },
    decryptString(value) { const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8') },
  } })
})
after(async () => { if (owned) await rm(owned, { recursive: true, force: true }) })
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
interface HttpReply { status: number; body: Uint8Array; headers: MobileHeaderPairs }
async function http(base: string, target: string, options: { method?: string; token?: string; key?: string; body?: unknown; headers?: readonly string[] } = {}): Promise<HttpReply> {
  const origin = new URL(base), bytes = options.body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(options.body))
  const headers = ['Host', origin.host, 'Connection', 'close', ...(options.headers ?? [])]
  if (options.token) headers.push('Authorization', `Bearer ${options.token}`)
  if (options.key) headers.push('Idempotency-Key', options.key)
  if (bytes) headers.push('Content-Type', 'application/json', 'Content-Length', String(bytes.length))
  return new Promise((resolve, reject) => {
    const request = httpsRequest({ hostname: origin.hostname, port: origin.port, path: target, method: options.method ?? 'GET',
      headers, ca: identity.certificatePEM, agent: false }, response => {
      const chunks: Buffer[] = [], pairs: [string, string][] = []
      for (let i = 0; i < response.rawHeaders.length; i += 2) pairs.push([response.rawHeaders[i]!, response.rawHeaders[i + 1]!])
      response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
      response.once('end', () => resolve({ status: response.statusCode ?? 0, body: new Uint8Array(Buffer.concat(chunks)), headers: pairs }))
      response.once('error', () => reject(new Error('自有HTTPS响应已中断。')))
    })
    request.once('error', () => reject(new Error('自有HTTPS请求已中断。')))
    request.setTimeout(5000, () => request.destroy()); request.end(bytes)
  })
}
const parsed = (reply: HttpReply): unknown => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(reply.body))
function errorBody(reply: HttpReply): MobileErrorEnvelope {
  const body = parsed(reply)
  if (!isMobileErrorEnvelope(body)) throw new Error('HTTPS完整错误body未符合原Error schema。')
  return body
}
const record = (reply: HttpReply): Record<string, unknown> => {
  const value = parsed(reply); assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>
}
function json(body: unknown, status = 200): Mobile002BackendReply & { kind: 'buffered' } {
  const bytes = new TextEncoder().encode(JSON.stringify(body))
  return { kind: 'buffered', status, body: bytes, headers: [['Content-Type', 'application/json'], ['Content-Length', String(bytes.length)]] }
}
const dummy: Mobile001Backend = { dispatch: async () => json({ serverId: 'server.dsd-owned', displayName: '合成HTTPS', contractVersion: '0.1.0', environment: 'development' }) }
const playbackDummy: Mobile002Backend = { dispatch: async () => { throw new MobileServiceError(401, 'UNAUTHORIZED') }, resourceCapabilities: async () => { throw new MobileServiceError(401, 'UNAUTHORIZED') } }
async function route(t: test.TestContext, options: { playback?: Mobile002Backend; dsd?: Mobile003Backend; backend?: Mobile001Backend } = {}) {
  const server = createMobileHttpsServer({ tls: { key: identity.privateKeyPEM, cert: identity.certificatePEM }, host: '127.0.0.1', port: 0,
    backend: options.backend ?? dummy, ...(options.playback ? { playback: options.playback } : {}), ...(options.dsd ? { dsd: options.dsd } : {}) })
  t.after(() => server.close()); return { server, ...await server.start() }
}
async function mainRoute(t: test.TestContext, options: { qualified?: boolean; ready?: boolean } = {}) {
  const f = mobileDsdMainFixture(t, options)
  assert.ok(f.service.playbackBackend); assert.ok(f.service.dsdBackend)
  const h = await route(t, { backend: f.service.backend, playback: f.service.playbackBackend, dsd: f.service.dsdBackend })
  f.activate(h.baseUrl); return { f, h, token: await f.pair() }
}

test('003显式mount只增加原能力route，旧001/002缺省仍404且不能单挂能力绕播放组合', { timeout: 10_000 }, async t => {
  for (const playback of [undefined, playbackDummy]) {
    const h = await route(t, playback ? { playback } : {})
    assert.equal((await http(h.baseUrl, '/mobile/v1/ui/capabilities')).status, 404)
  }
  const dsd: Mobile003Backend = { dispatch: async () => json({ version: '1.0.0', addedAlbums: 'unsupported', neteaseDailyRecommendations: 'unsupported', lyrics: 'unsupported' }) }
  assert.throws(() => createMobileHttpsServer({ tls: { key: identity.privateKeyPEM, cert: identity.certificatePEM }, host: '127.0.0.1', port: 0,
    backend: dummy, dsd }), (error: unknown) => error instanceof MobileHttpsServerError && error.code === 'INVALID_CONFIGURATION')
})

test('003真实HTTPS/Main认证后才读Owner能力，true/false均按whole UIFeature合同发送', { timeout: 10_000 }, async t => {
  const { f, h, token } = await mainRoute(t, { qualified: false })
  assert.equal((await http(h.baseUrl, '/mobile/v1/ui/capabilities')).status, 401)
  assert.equal(f.calls.some(v => v.kind === 'media-source' && v.request.operation === 'capabilities'), false)
  for (const qualified of [false, true]) {
    f.state.qualified = qualified
    const reply = await http(h.baseUrl, '/mobile/v1/ui/capabilities', { token: token.accessToken })
    assert.equal(reply.status, 200)
    const decoded = decodeMobileResponse('getUIContentCapabilities', { ...reply, finalUrl: `${h.baseUrl}/mobile/v1/ui/capabilities` },
      { responseOrigin: h.baseUrl, requestPath: '/mobile/v1/ui/capabilities' })
    assert.equal(decoded.ok, true)
    if (!decoded.ok || decoded.value.category !== 'success') throw new Error('能力完整回复未合格。')
    if (!isMobileUIContentCapabilities(decoded.value.body)) throw new Error('HTTPS能力完整body未符合原UIContentCapabilities schema。')
    assert.equal(decoded.value.body.resourceDsdToPcm, qualified); assert.equal(decoded.value.body.resourceFormatBitDepth, true)
    assert.equal(decoded.value.body.addedAlbums, 'unsupported'); assert.equal(decoded.value.body.lyrics, 'unsupported')
  }
  for (const target of ['/mobile/v1/ui/albums/recent', '/mobile/v1/ui/netease/daily-recommendations']) {
    assert.equal((await http(h.baseUrl, target, { token: token.accessToken })).status, 404)
  }
})

test('003独立协商可bits=false而DSD=true，真实HTTP base正文无maxBits仍消费固定DSD24/48', { timeout: 10_000 }, async t => {
  const { acceptedProcessingModes: _optIn, ...rest } = DSD_TEST_REQUEST
  const body: MobileResourceRequest = { ...rest, formats: [{ codec: 'flac', container: 'flac', maxSampleRateHz: 48_000, maxChannels: 2 }],
    acceptedProcessingModes: ['dsd_to_pcm'] }
  const sourceAudio = { codec: 'dsd', container: 'dff', sampleRateHz: 6_144_000, bitsPerSample: 1, channels: 2 }
  let called = 0
  const playback: Mobile002Backend = {
    resourceCapabilities: async (token, session, origin) => { assert.equal(token !== null, true); return dsdContext(origin, 'server.dsd-owned', session, false) },
    dispatch: async input => {
      assert.equal(input.operation, 'createResource'); called++
      assert.deepEqual(structuredClone(input.request.body), body)
      assert.equal(Object.hasOwn((input.request.body as MobileResourceRequest).formats[0]!, 'maxBitsPerSample'), false)
      const context: MobileResourceSemanticContext = { ...dsdContext(input.origin, 'server.dsd-owned', 'session.owned', false),
        source: 'local', sourceAudio, request: body, expectedResourceId: 'resource.owned' }
      const ready: MobileReadyResource = { id: 'resource.owned', sessionId: 'session.owned', trackId: body.trackId,
        versionId: body.versionId, contentRevision: body.contentRevision, sourceAudio, state: 'ready',
        processing: { mode: 'dsd_to_pcm', reason: MOBILE_DSD_PCM_PROCESSING_REASON, fromPreparedCache: false },
        media: { url: `${input.origin}/mobile/v1/media/resource.owned/file?ticket=synthetic-dsd-ticket-0001`, transport: 'file',
          expiresAt: new Date(Date.now() + 60_000).toISOString(), durationMs: 1000, seekable: true,
          actualAudio: { codec: 'flac', container: 'flac', sampleRateHz: 48_000, bitsPerSample: 24, channels: 2 } } }
      return { ...json(ready, 201), resourceContext: context }
    },
  }
  const h = await route(t, { playback }), reply = await http(h.baseUrl, '/mobile/v1/sessions/session.owned/resources',
    { method: 'POST', token: 'synthetic.access', key: 'dsd.base.original', body })
  assert.equal(reply.status, 201); assert.equal(called, 1)
  const result = record(reply); assert.equal(result.state, 'ready')
  assert.equal((result.processing as Record<string, unknown>).mode, 'dsd_to_pcm')
})

test('003真Main短begin在原HTTP窗内返回202，GET ready与重复POST原202完整字节各自保持', { timeout: 10_000 }, async t => {
  const { f, h, token } = await mainRoute(t)
  const sessionReply = await http(h.baseUrl, '/mobile/v1/sessions', { method: 'POST', token: token.accessToken, key: 'http.session.original', body: { clientInstanceId: 'client.http-owned' } })
  assert.equal(sessionReply.status, 201); const sessionId = String(record(sessionReply).id), path = `/mobile/v1/sessions/${sessionId}/resources`
  const request = { method: 'POST', token: token.accessToken, key: 'http.resource.original', body: DSD_TEST_REQUEST }
  const initial = await http(h.baseUrl, path, request); assert.equal(initial.status, 202)
  const pending = record(initial); assert.equal(pending.state, 'preparing'); assert.equal(Object.hasOwn(pending, 'media'), false)
  f.state.ready = true; const resourcePath = `${path}/${String(pending.id)}`, deadline = Date.now() + 4000
  let current: HttpReply
  do { current = await http(h.baseUrl, resourcePath, { token: token.accessToken })
    if (record(current).state === 'ready') break
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  } while (Date.now() < deadline)
  assert.equal(current.status, 200); assert.equal(record(current).state, 'ready')
  const original = await http(h.baseUrl, path, request); assert.equal(original.status, 202); assert.equal(hash(original.body), hash(initial.body))
  assert.equal(f.state.begins, 1); assert.equal(f.calls.filter(v => v.kind === 'media-source' && v.request.operation === 'prepare').length, 1)
  const release = await http(h.baseUrl, resourcePath, { method: 'DELETE', token: token.accessToken })
  assert.equal(release.status, 204); assert.equal(release.body.length, 0); assert.equal(f.state.active.size, 0)
})

test('003原客户端无mode许可的DSD返回原409 Error，零转换且错误不泄私有来源', { timeout: 10_000 }, async t => {
  const { f, h, token } = await mainRoute(t)
  const session = await http(h.baseUrl, '/mobile/v1/sessions', { method: 'POST', token: token.accessToken, key: 'legacy.session', body: { clientInstanceId: 'client.legacy' } })
  const { acceptedProcessingModes: _optIn, ...body } = DSD_TEST_REQUEST
  const reply = await http(h.baseUrl, `/mobile/v1/sessions/${String(record(session).id)}/resources`,
    { method: 'POST', token: token.accessToken, key: 'legacy.resource', body })
  assert.equal(reply.status, 409); assert.equal(errorBody(reply).error.code, 'UNSUPPORTED_FORMAT'); assert.equal(f.state.begins, 0)
  const names = Object.keys(record(reply)); assert.equal(names.includes('processing'), false); assert.equal(names.includes('sourceAudio'), false)
  assert.equal(/absolutePath|privateKey|stack|converterDirectory|cacheDirectory/u.test(new TextDecoder().decode(reply.body)), false)
})

test('003发送前资格变化保留503，撤销设备后能力HTTP401而非迟到true', { timeout: 10_000 }, async t => {
  const f = mobileDsdMainFixture(t); assert.ok(f.service.dsdBackend); assert.ok(f.service.playbackBackend)
  const actual = f.service.dsdBackend
  const changing: Mobile003Backend = { dispatch: async input => { const result = await actual.dispatch(input); f.state.qualified = false; return result } }
  const h = await route(t, { backend: f.service.backend, playback: f.service.playbackBackend, dsd: changing }); f.activate(h.baseUrl)
  const token = await f.pair(), reply = await http(h.baseUrl, '/mobile/v1/ui/capabilities', { token: token.accessToken })
  assert.equal(reply.status, 503); assert.equal(Object.hasOwn(record(reply), 'resourceDsdToPcm'), false)
  await f.service.auth.revokeDevice((await f.service.auth.authenticate(token.accessToken)).deviceId)
  assert.equal((await http(h.baseUrl, '/mobile/v1/ui/capabilities', { token: token.accessToken })).status, 401)
})

test('003新增能力路由仍拒重复auth及非法null能力，并维持原2MiB元数据上限', { timeout: 10_000 }, async t => {
  let calls = 0, large = false
  const dsd: Mobile003Backend = { dispatch: async () => {
    calls++
    if (large) { const bytes = new Uint8Array(MOBILE_API_RESPONSE_MAX_BYTES + 1); return { status: 200, headers: [], body: bytes } }
    return json({ version: '1.0.0', addedAlbums: 'unsupported', neteaseDailyRecommendations: 'unsupported', lyrics: 'unsupported', resourceDsdToPcm: null })
  } }
  const h = await route(t, { playback: playbackDummy, dsd })
  const duplicate = await http(h.baseUrl, '/mobile/v1/ui/capabilities', { headers: ['Authorization', 'Bearer synthetic.one', 'Authorization', 'Bearer synthetic.two'] })
  assert.equal(duplicate.status, 400); assert.equal(calls, 0)
  assert.equal((await http(h.baseUrl, '/mobile/v1/ui/capabilities', { token: 'synthetic.access' })).status, 503)
  large = true
  const reply = await http(h.baseUrl, '/mobile/v1/ui/capabilities', { token: 'synthetic.access' })
  assert.equal(reply.status, 503); assert.ok(reply.body.length < 1024); assert.equal(calls, 2)
})
