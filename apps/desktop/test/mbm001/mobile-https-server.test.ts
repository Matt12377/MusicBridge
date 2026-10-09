import assert from 'node:assert/strict'
import test, { before, after } from 'node:test'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import type { ClientRequest } from 'node:http'
import { checkServerIdentity, type ConnectionOptions } from 'node:tls'
import { mkdtemp, rm } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'
import os from 'node:os'
import path from 'node:path'
import { MOBILE_JSON_REQUEST_MAX_BYTES, MOBILE_API_RESPONSE_MAX_BYTES } from '@music-bridge/contracts'
import { MobileServiceError, type Mobile001Backend, type Mobile001BackendReply, type Mobile001Operation } from '../../../../packages/bridge-core/src/mobile/types.js'
import { createMobileHttpsServer, MOBILE_HTTPS_LIMITS, MobileHttpsServerError } from '../../src/main/mobile-https-server.js'
import { loadOrCreateMobileIdentity, type MobileTlsIdentity } from '../../src/main/mobile-tls-identity.js'

/** 实际 TLS/HTTP/原 wire decoder，backend 是受控叶接口，不声称实际 Owner/Auth 服务采用。 */
let identity: MobileTlsIdentity, owned = ''
before(async () => {
  const parent = process.env.TMPDIR ?? (process.platform === 'darwin' ? '/Volumes/LifeWeave/Developer/CommandLine/tmp' : os.tmpdir())
  if (process.platform === 'darwin' && !parent.startsWith('/Volumes/LifeWeave/Developer/CommandLine/')) throw new Error('合成材料必须使用外置目录。')
  owned = await mkdtemp(path.join(parent, 'mbm001-https-'))
  const key = randomBytes(32)
  identity = await loadOrCreateMobileIdentity({ directory: path.join(owned, 'identity'), hosts: ['127.0.0.1'], secretProtector: {
    encryptString(value) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), body])
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
    },
  } })
})
after(async () => { if (owned) await rm(owned, { recursive: true, force: true }) })
const digest = (value: Buffer | Uint8Array) => createHash('sha256').update(value).digest('hex')
function serverInfo(displayName = '合成 HTTPS 目录') {
  return { serverId: identity.serverId, displayName, contractVersion: '0.1.0', environment: 'development' }
}
function jsonReply(body: unknown, status = 200): Mobile001BackendReply {
  const bytes = new TextEncoder().encode(JSON.stringify(body))
  return { status, headers: [['Content-Type', 'application/json'], ['Content-Length', String(bytes.byteLength)]], body: bytes }
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function fixture(t: test.TestContext, backend: Mobile001Backend, port = 0) {
  const server = createMobileHttpsServer({ tls: { key: identity.privateKeyPEM, cert: identity.certificatePEM }, host: '127.0.0.1', port, backend })
  t.after(() => server.close())
  const listening = await server.start()
  return { server, ...listening }
}
interface Result { status: number; body: Buffer; rawHeaders: string[] }
interface ClientOptions {
  method?: string; headers?: readonly string[]; body?: Buffer; servername?: string
  checkServerIdentity?: ConnectionOptions['checkServerIdentity']
}
function client(base: string, target: string, options: ClientOptions = {}): { request: ClientRequest; result: Promise<Result> } {
  const url = new URL(base), headers = ['Host', url.host, ...(options.headers ?? []), 'Connection', 'close']
  if (options.body !== undefined && !headers.some((value, index) => index % 2 === 0 && value.toLowerCase() === 'content-length')) headers.push('Content-Length', String(options.body.length))
  let request!: ClientRequest
  const result = new Promise<Result>((resolve, reject) => {
    request = httpsRequest({ hostname: url.hostname, port: url.port, path: target, method: options.method ?? 'GET', headers,
      ca: identity.certificatePEM, agent: false,
      ...(options.servername ? { servername: options.servername } : {}),
      ...(options.checkServerIdentity ? { checkServerIdentity: options.checkServerIdentity } : {}),
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
      response.once('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks), rawHeaders: [...response.rawHeaders] }))
      response.once('error', reject); response.once('aborted', () => reject(new Error('合成响应已关闭。')))
    })
    request.once('error', reject); request.setTimeout(5000, () => request.destroy(new Error('合成请求等待已结束。')))
    request.end(options.body)
  })
  return { request, result }
}
const read = (base: string, target: string, options?: ClientOptions) => client(base, target, options).result
function png(size: number): Buffer {
  const chunk = (name: string, value: Buffer) => {
    const body = Buffer.concat([Buffer.from(name), value]); let crc = 0xffffffff
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1 }
    const length = Buffer.alloc(4), sum = Buffer.alloc(4); length.writeUInt32BE(value.length); sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([length, body, sum])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc((size * 4 + 1) * size))), chunk('IEND', Buffer.alloc(0))])
}

test('001真实HTTPS使用完整证书链/SAN并回读实际端口、证书SHA和原server whole body', async t => {
  const h = await fixture(t, { dispatch: async request => { assert.equal(request.operation, 'getServer'); assert.equal(request.accessToken, null); return jsonReply(serverInfo()) } })
  assert.match(h.baseUrl, /^https:\/\/127\.0\.0\.1:[1-9]\d*$/u); assert.equal(h.certificateSha256, identity.certificateSha256)
  const result = await read(h.baseUrl, '/mobile/v1/server')
  assert.equal(result.status, 200); assert.deepEqual(JSON.parse(result.body.toString('utf8')), serverInfo())
  assert.equal(result.rawHeaders.some((value, index) => index % 2 === 0 && value.toLowerCase() === 'location'), false)
})

test('001原十操作真实解码后仅送typed backend；后续资源/播放、额外方法和坏路径零投递', async t => {
  const calls: Mobile001Operation[] = []
  const h = await fixture(t, { dispatch: async request => { calls.push(request.operation); throw new MobileServiceError(401, 'UNAUTHORIZED') } })
  const operations: readonly [Mobile001Operation, string, string, unknown?][] = [
    ['getServer', 'GET', '/mobile/v1/server'], ['claimPairing', 'POST', '/mobile/v1/pairings/claim', { pairingSecret: 's'.repeat(32), installationId: 'installation.test', deviceName: '合成客户端' }],
    ['refreshToken', 'POST', '/mobile/v1/auth/refresh', { refreshToken: 'r'.repeat(32) }], ['logout', 'POST', '/mobile/v1/auth/logout', {}],
    ['getCapabilities', 'GET', '/mobile/v1/capabilities'], ['listAlbums', 'GET', '/mobile/v1/albums?source=local&limit=100'],
    ['getAlbum', 'GET', '/mobile/v1/albums/album.test'], ['listTracks', 'GET', '/mobile/v1/tracks?source=local&limit=100'],
    ['getTrack', 'GET', '/mobile/v1/tracks/local:track.1'], ['getArtwork', 'GET', '/mobile/v1/artwork/artwork.test?size=96'],
  ]
  for (const [, method, target, body] of operations) {
    const result = await read(h.baseUrl, target, { method, headers: ['Idempotency-Key', 'original-intent', ...(body === undefined ? [] : ['Content-Type', 'application/json'])],
      ...(body === undefined ? {} : { body: Buffer.from(JSON.stringify(body)) }) })
    assert.equal(result.status, 401)
  }
  assert.deepEqual(calls, operations.map(([operation]) => operation))
  // EmptyRequest 是完整 {} JSON；缺 Content-Type 或缺 JSON 都不得进入 backend。
  const incompleteLogoutRequests: readonly ClientOptions[] = [{ method: 'POST' }, { method: 'POST', body: Buffer.from('{}') },
    { method: 'POST', headers: ['Content-Type', 'application/json'] }]
  for (const options of incompleteLogoutRequests) {
    assert.equal((await read(h.baseUrl, '/mobile/v1/auth/logout', options)).status, 400)
    assert.equal(calls.length, 10)
  }
  for (const [method, target] of [['POST', '/mobile/v1/resources'], ['GET', '/mobile/v1/sessions/session.test'], ['PATCH', '/mobile/v1/server'],
    ['HEAD', '/mobile/v1/server'], ['GET', '/mobile/v1/%2e%2e/server'], ['GET', '/mobile/v1//server']] as const) assert.equal((await read(h.baseUrl, target!, { method })).status, 404)
  assert.equal(calls.length, 10)
})

test('001真实raw重复头、尾部超64项、重复query和坏UTF8拒绝，完整原body/key不投影', async t => {
  let calls = 0
  const h = await fixture(t, { dispatch: async request => {
    calls++; assert.equal(request.request.idempotencyKey, 'whole-original-key')
    assert.deepEqual(structuredClone(request.request.body), { pairingSecret: 's'.repeat(32), installationId: 'installation.test', deviceName: '合成 é 客户端' })
    throw new MobileServiceError(401, 'UNAUTHORIZED')
  } })
  assert.equal((await read(h.baseUrl, '/mobile/v1/server', { headers: ['Authorization', 'Bearer a', 'authorization', 'Bearer b'] })).status, 400)
  assert.equal((await read(h.baseUrl, '/mobile/v1/server', { headers: Array.from({ length: 65 }, (_, i) => [`X-Owned-${i}`, 'x']).flat() })).status, 400)
  assert.equal((await read(h.baseUrl, '/mobile/v1/tracks?limit=1&limit=2')).status, 400)
  assert.equal((await read(h.baseUrl, '/mobile/v1/pairings/claim', { method: 'POST', headers: ['Content-Type', 'application/json', 'Idempotency-Key', 'whole-original-key'], body: Buffer.from([255]) })).status, 400)
  assert.equal(calls, 0)
  const body = Buffer.from(JSON.stringify({ pairingSecret: 's'.repeat(32), installationId: 'installation.test', deviceName: '合成 é 客户端' }))
  assert.equal((await read(h.baseUrl, '/mobile/v1/pairings/claim', { method: 'POST', headers: ['Content-Type', 'application/json', 'Idempotency-Key', 'whole-original-key'], body })).status, 401)
  assert.equal(calls, 1)
})

test('001坏Host/转发authority和公网/wildcard配置拒绝，allowedHosts不能扩大私有地址闭集', async t => {
  let calls = 0
  const backend: Mobile001Backend = { dispatch: async () => { calls++; return jsonReply(serverInfo()) } }
  const h = await fixture(t, backend)
  assert.equal((await read(h.baseUrl, '/mobile/v1/server', { headers: ['Host', '8.8.8.8'] })).status, 400)
  assert.equal((await read(h.baseUrl, '/mobile/v1/server', { headers: ['X-Forwarded-Host', 'public.example.ts.net'] })).status, 400)
  for (const host of ['8.8.8.8', '0.0.0.0', '*.ts.net', 'studio.example.ts.net', '::1']) {
    assert.throws(() => createMobileHttpsServer({ tls: { key: identity.privateKeyPEM, cert: identity.certificatePEM }, host, port: 0, backend }),
      (error: unknown) => error instanceof MobileHttpsServerError && error.code === 'INVALID_CONFIGURATION')
  }
  assert.throws(() => createMobileHttpsServer({ tls: { key: identity.privateKeyPEM, cert: identity.certificatePEM }, host: '127.0.0.1', port: 0, allowedHosts: ['127.0.0.1', '8.8.8.8'], backend }))
  assert.equal(calls, 0)
})

test('001错误精确pin和错误SAN均经正常TLS校验失败，backend零调用', async t => {
  let calls = 0
  const h = await fixture(t, { dispatch: async () => { calls++; return jsonReply(serverInfo()) } })
  const wrong = digest(randomBytes(32))
  await assert.rejects(() => read(h.baseUrl, '/mobile/v1/server', { checkServerIdentity: (host, certificate) => {
    const original = checkServerIdentity(host, certificate); if (original) return original
    if (digest(certificate.raw) !== wrong) return new Error('不符合本次精确证书pin。')
    return undefined
  } }))
  await assert.rejects(() => read(h.baseUrl, '/mobile/v1/server', { servername: 'wrong.example.test' }))
  assert.equal(calls, 0)
})

test('001真实PNG whole bytes与空204通过，错状态/长度/伪图片/内部异常均安全mapper', async t => {
  const image = png(96); let mode = 'png'
  const h = await fixture(t, { dispatch: async request => {
    if (mode === 'exception') throw new Error('PRIVATE_PATH_AND_SECRET_MUST_NOT_APPEAR')
    if (request.operation === 'logout') return { status: 204, headers: [], body: new Uint8Array() }
    if (mode === 'status') return jsonReply(serverInfo(), 201)
    if (mode === 'length') return { ...jsonReply(serverInfo()), headers: [['Content-Type', 'application/json'], ['Content-Length', '1']] }
    if (mode === 'png' || mode === 'fake') {
      const body = mode === 'png' ? image : Buffer.from('PRIVATE_PATH_AND_SECRET_MUST_NOT_APPEAR')
      return { status: 200, headers: [['Content-Type', 'image/png'], ['Content-Length', String(body.length)]], body: new Uint8Array(body) }
    }
    return jsonReply(serverInfo())
  } })
  const picture = await read(h.baseUrl, '/mobile/v1/artwork/artwork.test?size=96')
  assert.equal(picture.status, 200); assert.equal(digest(picture.body), digest(image))
  const empty = await read(h.baseUrl, '/mobile/v1/auth/logout', { method: 'POST', headers: ['Content-Type', 'application/json'], body: Buffer.from('{}') }); assert.equal(empty.status, 204); assert.equal(empty.body.length, 0)
  for (const failure of ['status', 'length', 'fake', 'exception']) {
    mode = failure; const result = await read(h.baseUrl, failure === 'fake' ? '/mobile/v1/artwork/artwork.test?size=96' : '/mobile/v1/server')
    assert.equal(result.status, 503); assert.equal(result.body.includes('PRIVATE_PATH_AND_SECRET_MUST_NOT_APPEAR'), false)
    assert.equal((JSON.parse(result.body.toString()) as { error: { code: string } }).error.code, 'BUSY')
  }
})

test('001完整请求256KiB与回复2MiB边界沿原codec核B/B+1，超限不发原body', async t => {
  let calls = 0, responseBytes: Buffer | undefined
  const h = await fixture(t, { dispatch: async request => {
    calls++
    if (request.operation === 'getServer' && responseBytes) return { status: 200, headers: [['Content-Type', 'application/json'], ['Content-Length', String(responseBytes.length)]], body: new Uint8Array(responseBytes) }
    throw new MobileServiceError(401, 'UNAUTHORIZED')
  } })
  const whole = Buffer.from(JSON.stringify({ pairingSecret: 's'.repeat(32), installationId: 'installation.test', deviceName: '合成客户端' }))
  const body = Buffer.concat([Buffer.alloc(MOBILE_JSON_REQUEST_MAX_BYTES - whole.length, 32), whole])
  const headers = ['Content-Type', 'application/json', 'Idempotency-Key', 'owned-boundary']
  assert.equal((await read(h.baseUrl, '/mobile/v1/pairings/claim', { method: 'POST', headers, body })).status, 401)
  assert.equal((await read(h.baseUrl, '/mobile/v1/pairings/claim', { method: 'POST', headers, body: Buffer.concat([body, Buffer.from(' ')]) })).status, 413)
  assert.equal(calls, 1)
  const empty = JSON.stringify(serverInfo('')), target = MOBILE_API_RESPONSE_MAX_BYTES - Buffer.byteLength(empty)
  responseBytes = Buffer.from(JSON.stringify(serverInfo('x'.repeat(target))))
  assert.equal(responseBytes.length, MOBILE_API_RESPONSE_MAX_BYTES)
  const exact = await read(h.baseUrl, '/mobile/v1/server'); assert.equal(exact.status, 200); assert.equal(exact.body.length, MOBILE_API_RESPONSE_MAX_BYTES)
  responseBytes = Buffer.concat([responseBytes, Buffer.from(' ')])
  const exceeded = await read(h.baseUrl, '/mobile/v1/server'); assert.equal(exceeded.status, 503); assert.ok(exceeded.body.length < 1024)
})

test('001beforeSend实际await撤销围栏，旧成功body完全未发，安全401返回', async t => {
  const entered = deferred<void>(), release = deferred<void>(); let checks = 0, completed = false
  const h = await fixture(t, { dispatch: async () => ({ ...jsonReply(serverInfo()), beforeSend: async () => {
    checks++; entered.resolve(); await release.promise; throw new MobileServiceError(401, 'UNAUTHORIZED')
  } }) })
  const result = read(h.baseUrl, '/mobile/v1/server').then(value => { completed = true; return value })
  try { await entered.promise; assert.equal(completed, false) } finally { release.resolve() }
  const received = await result
  assert.equal(checks, 1); assert.equal(received.status, 401); assert.equal(received.body.includes(identity.serverId), false)
  assert.equal((JSON.parse(received.body.toString()) as { error: { code: string } }).error.code, 'UNAUTHORIZED')
})

test('001真实peer abort传AbortSignal，close封新入口并收口自有socket，重启只用fresh server', async t => {
  const entered = deferred<void>(), cancelled = deferred<void>(); let calls = 0
  const h = await fixture(t, { dispatch: async request => {
    calls++; entered.resolve()
    return new Promise<Mobile001BackendReply>((_resolve, reject) => request.signal.addEventListener('abort', () => { cancelled.resolve(); reject(new MobileServiceError(503, 'BUSY')) }, { once: true }))
  } })
  const pending = client(h.baseUrl, '/mobile/v1/server'); const observed = pending.result.catch(() => null)
  await entered.promise; pending.request.destroy(); await cancelled.promise; assert.equal(await observed, null); assert.equal(calls, 1)
  const first = h.server.close(); assert.equal(h.server.close(), first); await first
  await assert.rejects(() => h.server.start(), (error: unknown) => error instanceof MobileHttpsServerError && error.code === 'CLOSED')
  const next = await fixture(t, { dispatch: async () => jsonReply(serverInfo()) }, Number(new URL(h.baseUrl).port))
  assert.equal(next.baseUrl, h.baseUrl); assert.equal((await read(next.baseUrl, '/mobile/v1/server')).status, 200)
})

test('001并发上限拒第17个请求不投递，close取消全部16在途且无额外backend', async t => {
  const entered = deferred<void>(); let calls = 0, cancellations = 0
  const h = await fixture(t, { dispatch: async request => {
    calls++; if (calls === MOBILE_HTTPS_LIMITS.concurrentRequests) entered.resolve()
    return new Promise<Mobile001BackendReply>((_resolve, reject) => request.signal.addEventListener('abort', () => { cancellations++; reject(new MobileServiceError(503, 'BUSY')) }, { once: true }))
  } })
  const pending = Array.from({ length: MOBILE_HTTPS_LIMITS.concurrentRequests }, () => read(h.baseUrl, '/mobile/v1/server').catch(() => null))
  try {
    await entered.promise; assert.equal((await read(h.baseUrl, '/mobile/v1/server')).status, 429); assert.equal(calls, 16)
  } finally { await h.server.close() }
  assert.equal((await Promise.all(pending)).every(value => value === null), true); assert.equal(cancellations, 16)
})
