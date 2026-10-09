import assert from 'node:assert/strict'
import test, { before, after } from 'node:test'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { createServer, request as httpsRequest, type Server } from 'node:https'
import { IncomingMessage, type ServerResponse, type ClientRequest } from 'node:http'
import { Socket } from 'node:net'
import { Writable, type Duplex } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MobileServiceError } from '../../../../packages/bridge-core/src/mobile/types.js'
import {
  sendMobileMediaResponse, getMobileMediaReleaseCompletion, MobileMediaResponseError,
  type MobileMediaReader, type MobileMediaReply, type MobileMediaResponseLimits, type MobileMediaResponseErrorCode,
} from '../../src/main/mobile-media-response.js'
import { loadOrCreateMobileIdentity, type MobileTlsIdentity } from '../../src/main/mobile-tls-identity.js'

/** 受控reader证明发送层/TLS行为，不证明实际Owner、源FD、播放设备或听感。 */
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function failure(code: MobileMediaResponseErrorCode) {
  return (error: unknown) => error instanceof MobileMediaResponseError && error.code === code
}
function source(bytes: Uint8Array) {
  let offset = 0, closes = 0
  const pulls: number[] = [], signals: AbortSignal[] = []
  const reader: MobileMediaReader = {
    async read(maxBytes, signal) {
      pulls.push(maxBytes); signals.push(signal)
      if (offset === bytes.byteLength) return null
      const next = bytes.subarray(offset, Math.min(offset + maxBytes, bytes.byteLength)); offset += next.byteLength
      return next
    },
    async close() { closes++ },
  }
  return { reader, pulls, signals, get closes() { return closes } }
}
function replyFor(reader: MobileMediaReader, total: number, overrides: Partial<MobileMediaReply> = {}): MobileMediaReply {
  return { operation: 'getMediaAsset', status: 200,
    headers: [['Content-Type', 'audio/wav'], ['Content-Length', String(total)], ['Accept-Ranges', 'bytes']],
    expectedBodyBytes: total, fullContentLength: total, resourceAbortSignal: new AbortController().signal,
    ticketExpiresAtMs: Date.now() + 60_000, beforeSend: async () => {}, reader, ...overrides }
}
/** 真实Writable的write callback/drain，仅HTTP头是受控记录；不是网络服务证据。 */
class ControlledResponse extends Writable {
  headersSent = false
  statusCode = 0
  headers: string[] = []
  readonly chunks: Buffer[] = []
  private readonly held: (() => void)[] = []
  constructor(readonly automatic = true) { super({ highWaterMark: 16, autoDestroy: false }) }
  writeHead(status: number, headers: string[]) { this.statusCode = status; this.headers = [...headers]; this.headersSent = true; return this }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.from(chunk))
    if (this.automatic) setImmediate(callback)
    else this.held.push(() => callback())
  }
  flush(): void { for (const callback of this.held.splice(0)) callback() }
  get bytes(): Buffer { return Buffer.concat(this.chunks) }
}
function pure(t: test.TestContext, automatic = true, method = 'GET') {
  const socket = new Socket(), request = new IncomingMessage(socket), response = new ControlledResponse(automatic)
  request.method = method
  t.after(() => { response.flush(); response.destroy(); socket.destroy() })
  // 受控Writable显式适配Node HTTP类型；生产sender在真实TLS测试另以原ServerResponse调用。
  return { request, response, httpResponse: response as unknown as ServerResponse, controller: new AbortController() }
}

test('002 HEAD/400/416真实完成为零body且零pull，reader仅关闭一次', async t => {
  for (const kind of ['head', 'bad-range', 'unsatisfiable'] as const) {
    const h = pure(t, true, kind === 'head' ? 'HEAD' : 'GET'), s = source(Buffer.alloc(12))
    const reply = replyFor(s.reader, 12, kind === 'head' ? { operation: 'headMediaAsset', expectedBodyBytes: 0 }
      : { status: kind === 'bad-range' ? 400 : 416, expectedBodyBytes: 0,
        headers: [['Content-Length', '0'], ...(kind === 'unsatisfiable' ? [['Content-Range', 'bytes */12'] as [string, string]] : [])] })
    await sendMobileMediaResponse(h.request, h.httpResponse, reply, h.controller.signal)
    assert.equal(h.response.statusCode, kind === 'head' ? 200 : kind === 'bad-range' ? 400 : 416)
    assert.equal(h.response.bytes.length, 0); assert.equal(s.pulls.length, 0); assert.equal(s.closes, 1)
    assert.equal(h.response.writableFinished, true); await getMobileMediaReleaseCompletion(reply)
  }
})

test('002逐块真实校验完整字节与EOF，64KiB上限不受2MiB元数据cap影响', async t => {
  const bytes = randomBytes(2 * 1024 * 1024 + 17), s = source(bytes), h = pure(t)
  let fences = 0
  const reply = replyFor(s.reader, bytes.length, { beforeSend: async () => { fences++ } })
  await sendMobileMediaResponse(h.request, h.httpResponse, reply, h.controller.signal)
  assert.equal(digest(h.response.bytes), digest(bytes)); assert.equal(h.response.bytes.length, bytes.length)
  assert.ok(s.pulls.length > 32); assert.ok(s.pulls.every(size => size > 0 && size <= 65536))
  assert.equal(s.pulls.at(-1), 1); assert.equal(fences, h.response.chunks.length + 1)
  assert.equal(s.closes, 1); assert.equal(h.response.writableFinished, true)
})

test('002选定206区间必须与实际singleRange和完整长度精确一致', async t => {
  const h = pure(t), bytes = Buffer.from([2, 3, 4]), s = source(bytes)
  const reply = replyFor(s.reader, 8, { status: 206, expectedBodyBytes: 3, rangeRequested: 'bytes=2-4',
    headers: [['Content-Type', 'audio/wav'], ['Content-Length', '3'], ['Content-Range', 'bytes 2-4/8'], ['Accept-Ranges', 'bytes']] })
  await sendMobileMediaResponse(h.request, h.httpResponse, reply, h.controller.signal)
  assert.equal(h.response.statusCode, 206); assert.equal(digest(h.response.bytes), digest(bytes)); assert.equal(s.closes, 1)
  const other = pure(t), wrong = source(bytes)
  await assert.rejects(() => sendMobileMediaResponse(other.request, other.httpResponse,
    { ...reply, reader: wrong.reader, rangeRequested: 'bytes=1-3' }, other.controller.signal), failure('INVALID_REPLY'))
  assert.equal(other.response.headersSent, false); assert.equal(wrong.pulls.length, 0); assert.equal(wrong.closes, 1)
})

test('002错误头/重复长度/私有响应头/方法及预期长度在输出前拒绝并释放reader', async t => {
  const invalid: readonly Partial<MobileMediaReply>[] = [
    { expectedBodyBytes: 2 }, { headers: [['Content-Length', '3'], ['content-length', '3'], ['Accept-Ranges', 'bytes']] },
    { headers: [['Content-Length', '3'], ['Location', 'https://private.invalid/secret']] },
    { headers: [['Content-Length', '3'], ['Accept-Ranges', 'bytes'], ['Content-Type', 'audio/wav\r\nX-Private: x']] },
    { status: 206 }, { operation: 'headMediaAsset' }, { ticketExpiresAtMs: Number.NaN },
  ]
  for (const override of invalid) {
    const h = pure(t), s = source(Buffer.alloc(3))
    await assert.rejects(() => sendMobileMediaResponse(h.request, h.httpResponse, replyFor(s.reader, 3, override), h.controller.signal), failure('INVALID_REPLY'))
    assert.equal(h.response.headersSent, false); assert.equal(s.pulls.length, 0); assert.equal(s.closes, 1)
  }
  const h = pure(t), s = source(Buffer.alloc(3))
  await assert.rejects(() => sendMobileMediaResponse(h.request, h.httpResponse, replyFor(s.reader, 3), h.controller.signal, { idleMs: 5001 }), failure('INVALID_LIMITS'))
  assert.equal(s.closes, 1); assert.equal(h.response.headersSent, false)
})

test('002首次beforeSend实际await且每块复核，撤销后缓存块不进入HTTP', async t => {
  const h = pure(t), gate = deferred<void>(), entered = deferred<void>(), s = source(Buffer.from([1, 2, 3]))
  let fences = 0
  const flight = sendMobileMediaResponse(h.request, h.httpResponse, replyFor(s.reader, 3, { beforeSend: async () => {
    fences++; if (fences === 1) { entered.resolve(); await gate.promise }
    else throw new MobileServiceError(401, 'UNAUTHORIZED')
  } }), h.controller.signal)
  const observed = assert.rejects(() => flight, (error: unknown) => error instanceof MobileServiceError && error.status === 401)
  await entered.promise; assert.equal(h.response.headersSent, false); assert.equal(s.pulls.length, 0)
  gate.resolve(); await observed
  assert.equal(fences, 2); assert.equal(s.pulls.length, 1); assert.equal(h.response.bytes.length, 0)
  assert.equal(h.response.destroyed, true); assert.equal(s.closes, 1)
})

test('002earlyEOF、overflow、空块、超chunk与SAB都失败，不截断伪装完整输出', async t => {
  const variants: readonly [MobileMediaResponseErrorCode, Uint8Array | null][] = [
    ['EARLY_EOF', null], ['OVERFLOW', Buffer.alloc(4)], ['INVALID_CHUNK', Buffer.alloc(0)],
    ['INVALID_CHUNK', new Uint8Array(new SharedArrayBuffer(3))],
  ]
  for (const [code, value] of variants) {
    const h = pure(t); let closes = 0
    const reader: MobileMediaReader = { read: async () => value, close: async () => { closes++ } }
    await assert.rejects(() => sendMobileMediaResponse(h.request, h.httpResponse, replyFor(reader, 3), h.controller.signal), failure(code))
    assert.equal(closes, 1); assert.equal(h.response.writableFinished, false); assert.equal(h.response.destroyed, true)
    assert.equal(h.response.bytes.length, 0)
  }
  const h = pure(t); let closes = 0
  const reader: MobileMediaReader = { read: async () => Buffer.alloc(65537), close: async () => { closes++ } }
  await assert.rejects(() => sendMobileMediaResponse(h.request, h.httpResponse, replyFor(reader, 131072), h.controller.signal), failure('INVALID_CHUNK'))
  assert.equal(closes, 1); assert.equal(h.response.bytes.length, 0)
  const trailing = pure(t); let reads = 0, trailingCloses = 0
  const extra: MobileMediaReader = { read: async () => { reads++; return Buffer.from([1]) }, close: async () => { trailingCloses++ } }
  await assert.rejects(() => sendMobileMediaResponse(trailing.request, trailing.httpResponse, replyFor(extra, 1), trailing.controller.signal), failure('OVERFLOW'))
  assert.equal(reads, 2); assert.equal(trailing.response.bytes.length, 1); assert.equal(trailingCloses, 1)
})

test('002真实Writable背压期间只保有一块，不拉取后续块直至drain', async t => {
  const h = pure(t, false), bytes = randomBytes(65537), s = source(bytes)
  const flight = sendMobileMediaResponse(h.request, h.httpResponse, replyFor(s.reader, bytes.length), h.controller.signal)
  await settle(); assert.equal(s.pulls.length, 1); assert.equal(h.response.writableLength, 65536)
  await settle(); assert.equal(s.pulls.length, 1)
  h.response.flush(); await settle(); assert.equal(s.pulls.length, 2)
  assert.equal(h.response.writableLength, 1); h.response.flush(); await flight
  assert.equal(digest(h.response.bytes), digest(bytes)); assert.equal(s.closes, 1)
})

test('002peer取消在途读，迟到块不写且原close/AbortSignal只收口一次', async t => {
  const h = pure(t), entered = deferred<void>(), late = deferred<Uint8Array | null>()
  let closes = 0, readSignal: AbortSignal | undefined
  const reader: MobileMediaReader = { read: async (_max, signal) => { readSignal = signal; entered.resolve(); return late.promise }, close: async () => { closes++ } }
  const reply = replyFor(reader, 3), flight = sendMobileMediaResponse(h.request, h.httpResponse, reply, h.controller.signal)
  const rejected = assert.rejects(() => flight, failure('PEER_CLOSED'))
  await entered.promise; h.response.destroy(); await rejected
  assert.equal(readSignal?.aborted, true); assert.equal(closes, 1)
  late.resolve(Buffer.alloc(3)); await settle(); assert.equal(h.response.bytes.length, 0)
  await getMobileMediaReleaseCompletion(reply); assert.equal(closes, 1)
})

test('002资源撤销和调用端取消会打断blocked drain，不继续拉取且不自动删除持久资源', async t => {
  for (const kind of ['resource', 'server'] as const) {
    const h = pure(t, false), s = source(Buffer.alloc(131072)), resource = new AbortController()
    const reply = replyFor(s.reader, 131072, { resourceAbortSignal: resource.signal })
    const flight = sendMobileMediaResponse(h.request, h.httpResponse, reply, h.controller.signal)
    const rejected = assert.rejects(() => flight, failure('ABORTED'))
    await settle(); assert.equal(s.pulls.length, 1)
    if (kind === 'resource') resource.abort(); else h.controller.abort()
    await rejected; assert.equal(s.closes, 1); assert.equal(s.pulls.length, 1)
    assert.equal(h.response.destroyed, true); h.response.flush(); await settle(); assert.equal(s.pulls.length, 1)
  }
})

test('002建立期限与idle期限分别有界，挂起检查或后续读不能保留listener/timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 })
  t.after(() => t.mock.timers.reset())
  const h = pure(t), gate = deferred<void>(), s = source(Buffer.alloc(3))
  const first = sendMobileMediaResponse(h.request, h.httpResponse, replyFor(s.reader, 3, { beforeSend: () => gate.promise }), h.controller.signal)
  const firstRejected = assert.rejects(() => first, failure('ESTABLISH_TIMEOUT'))
  await settle(); t.mock.timers.tick(10_000); await firstRejected; gate.resolve(); await settle()
  assert.equal(h.response.headersSent, false); assert.equal(s.closes, 1)
  assert.equal(h.request.listenerCount('aborted'), 0); assert.equal(h.response.listenerCount('drain'), 0)
  const other = pure(t), stalled = deferred<Uint8Array | null>(); let reads = 0, closes = 0
  const reader: MobileMediaReader = { read: async () => { reads++; return reads === 1 ? Buffer.from([1]) : stalled.promise }, close: async () => { closes++ } }
  const next = sendMobileMediaResponse(other.request, other.httpResponse, replyFor(reader, 2), other.controller.signal)
  const nextRejected = assert.rejects(() => next, failure('IDLE_TIMEOUT'))
  await settle(); await settle(); assert.equal(reads, 2); t.mock.timers.tick(5000); await nextRejected
  stalled.resolve(null); await settle(); assert.equal(closes, 1); assert.equal(other.response.bytes.length, 1)
  assert.equal(other.response.listenerCount('drain'), 0); assert.equal(other.response.listenerCount('finish'), 0)
})

test('002持续实际写进展超过15秒仍完成，媒体不套用原控制整体期限', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 }); t.after(() => t.mock.timers.reset())
  const h = pure(t), gates = Array.from({ length: 4 }, () => deferred<Uint8Array | null>())
  let reads = 0, closes = 0
  const reader: MobileMediaReader = { read: async () => { const index = reads++; return index === 0 ? Buffer.from([1]) : index <= 4 ? gates[index - 1]!.promise : null }, close: async () => { closes++ } }
  const flight = sendMobileMediaResponse(h.request, h.httpResponse, replyFor(reader, 5), h.controller.signal)
  await settle(); await settle()
  for (const [index, gate] of gates.entries()) { t.mock.timers.tick(4000); gate.resolve(Buffer.from([index + 2])); await settle(); await settle() }
  await flight; assert.equal(Date.now(), 1_800_000_016_000)
  assert.deepEqual([...h.response.bytes], [1, 2, 3, 4, 5]); assert.equal(closes, 1); assert.equal(h.response.writableFinished, true)
})

test('002绝对票据期限不因真实写进展延期，缓存块与迟到读不能越过期限', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 }); t.after(() => t.mock.timers.reset())
  const h = pure(t), second = deferred<Uint8Array | null>(), late = deferred<Uint8Array | null>(); let reads = 0, closes = 0
  const reader: MobileMediaReader = { read: async () => { reads++; return reads === 1 ? Buffer.from([1]) : reads === 2 ? second.promise : late.promise }, close: async () => { closes++ } }
  const flight = sendMobileMediaResponse(h.request, h.httpResponse, replyFor(reader, 3, { ticketExpiresAtMs: Date.now() + 5000 }), h.controller.signal)
  const rejected = assert.rejects(() => flight, failure('TICKET_EXPIRED'))
  await settle(); await settle(); t.mock.timers.tick(4000); second.resolve(Buffer.from([2])); await settle(); await settle()
  assert.equal(h.response.bytes.length, 2); t.mock.timers.tick(1000); await rejected
  late.resolve(Buffer.from([3])); await settle(); assert.equal(h.response.bytes.length, 2); assert.equal(closes, 1)
})

test('002逐块Owner围栏有独立控制期限，期间不误用5秒媒体idle且仍受票据约束', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 }); t.after(() => t.mock.timers.reset())
  const h = pure(t), gate = deferred<void>(), entered = deferred<void>(); let reads = 0, fences = 0, closes = 0
  const reader: MobileMediaReader = { read: async () => { reads++; return reads <= 2 ? Buffer.from([reads]) : null }, close: async () => { closes++ } }
  const flight = sendMobileMediaResponse(h.request, h.httpResponse, replyFor(reader, 2, { beforeSend: async () => {
    fences++; if (fences === 3) { entered.resolve(); await gate.promise }
  } }), h.controller.signal)
  await entered.promise; t.mock.timers.tick(6000); assert.equal(h.response.destroyed, false); gate.resolve(); await flight
  assert.deepEqual([...h.response.bytes], [1, 2]); assert.equal(closes, 1)
})

test('002close超限不记quiet，原未截断回收Promise可继续核验且没有二次close', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 }); t.after(() => t.mock.timers.reset())
  const h = pure(t), closeGate = deferred<void>(), s = source(Buffer.from([1])); let closes = 0
  const reader: MobileMediaReader = { read: s.reader.read, close: async () => { closes++; await closeGate.promise } }
  const reply = replyFor(reader, 1), flight = sendMobileMediaResponse(h.request, h.httpResponse, reply, h.controller.signal, { releaseMs: 20 })
  const rejected = assert.rejects(() => flight, failure('RELEASE_TIMEOUT'))
  await settle(); await settle(); assert.equal(closes, 1); t.mock.timers.tick(20); await rejected
  assert.equal(h.response.writableFinished, false); const actualClose = getMobileMediaReleaseCompletion(reply); assert.ok(actualClose)
  let quiet = false; void actualClose.then(() => { quiet = true }); await settle(); assert.equal(quiet, false)
  closeGate.resolve(); await actualClose; assert.equal(quiet, true); assert.equal(closes, 1)
})

test('002已过期/预取消/释放失败拒绝且安全错误不包含底层私密文本', async t => {
  for (const kind of ['expired', 'cancelled', 'close-failed'] as const) {
    const h = pure(t), s = source(Buffer.from([1]))
    const reader = kind === 'close-failed' ? { ...s.reader, close: async () => { throw new Error('PRIVATE_PATH_TICKET_NEVER_REPORT') } } : s.reader
    const reply = replyFor(reader, 1, kind === 'expired' ? { ticketExpiresAtMs: Date.now() - 1 } : {})
    if (kind === 'cancelled') h.controller.abort()
    await assert.rejects(() => sendMobileMediaResponse(h.request, h.httpResponse, reply, h.controller.signal), error => {
      assert.ok(error instanceof MobileMediaResponseError)
      assert.equal(error.code, kind === 'expired' ? 'TICKET_EXPIRED' : kind === 'cancelled' ? 'ABORTED' : 'RELEASE_FAILED')
      assert.equal(error.message.includes('PRIVATE_PATH_TICKET_NEVER_REPORT'), false); return true
    })
    if (kind !== 'close-failed') { assert.equal(s.pulls.length, 0); assert.equal(s.closes, 1); assert.equal(h.response.headersSent, false) }
    else assert.equal(h.response.writableFinished, false)
  }
})

let identity: MobileTlsIdentity, owned = ''
before(async () => {
  const parent = process.env.TMPDIR ?? (process.platform === 'darwin' ? '/Volumes/LifeWeave/Developer/CommandLine/tmp' : os.tmpdir())
  if (process.platform === 'darwin' && !parent.startsWith('/Volumes/LifeWeave/Developer/CommandLine/')) throw new Error('合成材料必须使用外置目录。')
  owned = await mkdtemp(path.join(parent, 'mbm002-media-https-'))
  const key = randomBytes(32)
  identity = await loadOrCreateMobileIdentity({ directory: path.join(owned, 'identity'), hosts: ['127.0.0.1'], secretProtector: {
    encryptString(value) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), body])
    },
    // 使用完整真实AES保护器；不把测试保护器声称系统Keychain证据。
    decryptString(value) { const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8') },
  } })
})
after(async () => { if (owned) await rm(owned, { recursive: true, force: true }) })
async function tlsFixture(t: test.TestContext, factory: (request: IncomingMessage) => MobileMediaReply, limits?: Readonly<MobileMediaResponseLimits>) {
  const controllers = new Set<AbortController>(), sockets = new Set<Duplex>(), completions: Promise<void>[] = [], failures: unknown[] = []
  const server: Server = createServer({ key: identity.privateKeyPEM, cert: identity.certificatePEM, minVersion: 'TLSv1.2' }, (request, response) => {
    const controller = new AbortController(); controllers.add(controller)
    const flight = sendMobileMediaResponse(request, response, factory(request), controller.signal, limits).catch(error => {
      failures.push(error)
      if (!response.headersSent && !response.destroyed) { response.writeHead(503, { 'Content-Length': '0' }); response.end() }
      else response.destroy()
    }).finally(() => controllers.delete(controller))
    completions.push(flight)
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  t.after(async () => {
    for (const controller of controllers) controller.abort()
    for (const socket of sockets) socket.destroy()
    await Promise.all(completions)
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address(); assert.ok(address && typeof address === 'object')
  return { base: `https://127.0.0.1:${address.port}`, completions, failures }
}
function tlsRead(base: string, options: { method?: string; range?: string; onChunk?: (bytes: Buffer) => void } = {}) {
  const url = new URL(base); let request!: ClientRequest
  const result = new Promise<{ status: number; rawHeaders: string[]; bytes: number; sha256: string }>((resolve, reject) => {
    request = httpsRequest({ hostname: url.hostname, port: url.port, path: '/mobile/v1/media/resource.owned/file', method: options.method ?? 'GET',
      ca: identity.certificatePEM, agent: false, ...(options.range ? { headers: { Range: options.range } } : {}) }, response => {
      const hash = createHash('sha256'); let bytes = 0
      response.on('data', (chunk: Buffer) => { bytes += chunk.length; hash.update(chunk); options.onChunk?.(chunk) })
      response.once('end', () => resolve({ status: response.statusCode ?? 0, rawHeaders: [...response.rawHeaders], bytes, sha256: hash.digest('hex') }))
      response.once('error', reject); response.once('aborted', () => reject(new Error('合成媒体连接已中断。')))
    })
    request.once('error', reject); request.setTimeout(5000, () => request.destroy(new Error('合成媒体请求等待已结束。'))); request.end()
  })
  return { request, result }
}

test('002实际TLS完整200大于2MiB逐块hash、206与HEAD/400/416真实HTTP字节闭合', async t => {
  const bytes = randomBytes(2 * 1024 * 1024 + 3), readers: ReturnType<typeof source>[] = []
  const h = await tlsFixture(t, request => {
    const range = request.headers.range
    const operation = request.method === 'HEAD' ? 'headMediaAsset' : 'getMediaAsset'
    const selected = range === 'bytes=7-9' && operation === 'getMediaAsset' ? bytes.subarray(7, 10) : bytes
    const s = source(selected); readers.push(s)
    if (operation === 'headMediaAsset') return replyFor(s.reader, bytes.length, { operation, expectedBodyBytes: 0 })
    if (range === 'bytes=7-9') return replyFor(s.reader, bytes.length, { status: 206, expectedBodyBytes: 3, rangeRequested: range,
      headers: [['Content-Type', 'audio/wav'], ['Content-Length', '3'], ['Content-Range', `bytes 7-9/${bytes.length}`], ['Accept-Ranges', 'bytes']] })
    if (range === 'bad' || range === 'bytes=9000000-') return replyFor(s.reader, bytes.length, { status: range === 'bad' ? 400 : 416, expectedBodyBytes: 0,
      headers: [['Content-Length', '0'], ...(range === 'bad' ? [] : [['Content-Range', `bytes */${bytes.length}`] as [string, string]])] })
    return replyFor(s.reader, bytes.length)
  })
  const whole = await tlsRead(h.base).result; assert.equal(whole.status, 200); assert.equal(whole.bytes, bytes.length); assert.equal(whole.sha256, digest(bytes))
  const partial = await tlsRead(h.base, { range: 'bytes=7-9' }).result; assert.equal(partial.status, 206); assert.equal(partial.bytes, 3); assert.equal(partial.sha256, digest(bytes.subarray(7, 10)))
  for (const [method, range, status] of [['HEAD', 'bad', 200], ['GET', 'bad', 400], ['GET', 'bytes=9000000-', 416]] as const) {
    const actual = await tlsRead(h.base, { method, range }).result; assert.equal(actual.status, status); assert.equal(actual.bytes, 0)
  }
  await Promise.all(h.completions); assert.equal(h.failures.length, 0)
  assert.equal(readers.length, 5); assert.ok(readers.every(s => s.closes === 1))
  assert.ok(readers.slice(2).every(s => s.pulls.length === 0))
})

test('002实际TLS消费者中断回收单次reader，后续独立HTTP仍可读取同资源', async t => {
  const bytes = randomBytes(16 * 1024 * 1024), readers: ReturnType<typeof source>[] = [], signals: AbortSignal[] = []
  const h = await tlsFixture(t, () => {
    const s = source(bytes); readers.push(s)
    const reader: MobileMediaReader = { read: async (max, signal) => { signals.push(signal); await settle(); return s.reader.read(max, signal) }, close: s.reader.close }
    return replyFor(reader, bytes.length)
  })
  const received = deferred<void>(); let first = true
  const current = tlsRead(h.base, { onChunk: () => { if (first) { first = false; current.request.destroy(); received.resolve() } } })
  const cancelled = assert.rejects(() => current.result)
  await received.promise; await cancelled; await Promise.all(h.completions)
  assert.equal(readers[0]!.closes, 1); assert.ok(signals.some(signal => signal.aborted))
  const next = await tlsRead(h.base).result; await Promise.all(h.completions)
  assert.equal(next.status, 200); assert.equal(next.bytes, bytes.length); assert.equal(next.sha256, digest(bytes))
  assert.equal(readers[1]!.closes, 1); assert.equal(h.failures.length, 1)
})

test('002实际TLS消费者暂停后拉取停止，恢复消费仍逐块闭合完整hash', async t => {
  const bytes = randomBytes(32 * 1024 * 1024), s = source(bytes), paused = deferred<IncomingMessage>()
  const h = await tlsFixture(t, () => replyFor(s.reader, bytes.length))
  const url = new URL(h.base)
  const result = new Promise<{ bytes: number; sha256: string }>((resolve, reject) => {
    const request = httpsRequest({ hostname: url.hostname, port: url.port, path: '/mobile/v1/media/resource.owned/file',
      ca: identity.certificatePEM, agent: false }, response => {
      response.pause(); paused.resolve(response)
      const hash = createHash('sha256'); let receivedBytes = 0
      response.on('data', (chunk: Buffer) => { receivedBytes += chunk.length; hash.update(chunk) })
      response.once('end', () => resolve({ bytes: receivedBytes, sha256: hash.digest('hex') }))
      response.once('error', reject); response.once('aborted', () => reject(new Error('合成慢读连接已中断。')))
    })
    request.once('error', reject); request.setTimeout(5000, () => request.destroy(new Error('合成慢读等待已结束。'))); request.end()
  })
  // 内核/TLS也有有限缓冲，不能要求第一块就停；观察连续三个窗口停止拉取。
  const response = await paused.promise; let unchanged = 0, previous = s.pulls.length
  try {
    for (let window = 0; window < 25 && unchanged < 3; window++) {
      await new Promise<void>(resolve => setTimeout(resolve, 30))
      const current = s.pulls.length
      unchanged = current === previous ? unchanged + 1 : 0; previous = current
    }
    assert.equal(unchanged, 3); assert.ok(s.pulls.length > 0 && s.pulls.length < bytes.length / 65536)
    assert.ok(s.pulls.every(max => max > 0 && max <= 65536)); assert.equal(s.closes, 0)
  } finally { response.resume() }
  const actual = await result; await Promise.all(h.completions)
  assert.equal(actual.bytes, bytes.length); assert.equal(actual.sha256, digest(bytes)); assert.equal(s.closes, 1)
  assert.equal(h.failures.length, 0)
})
