import assert from 'node:assert/strict'
import test from 'node:test'
import { createRoonArtworkCache } from '../src/renderer/src/roon-artwork-cache.js'

const body = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 1, 0, 1, 0, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0, 0xff, 0xd9])
const result = () => ({ contentType: 'image/jpeg', body })
const request = (id = 1) => ({ reference: `musicbridge-v2-image-123e4567-e89b-12d3-a456-${String(id).padStart(12, '0')}`, width: 256, height: 256, scale: 'fit' as const, format: 'image/jpeg' as const })
function held<T = ReturnType<typeof result>>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const turn = () => new Promise<void>(resolve => setImmediate(resolve))

test('007 RED：clear后的旧失败不能negative新flight或撤销新同key工作', async () => {
  const old = held(), fresh = held(); let fetches = 0
  const cache = createRoonArtworkCache({ getImage: () => (++fetches === 1 ? old : fresh).promise, createObjectUrl: () => 'blob:new', revokeObjectUrl() {}, decodeObjectUrl: async () => undefined })
  const a = cache.acquire(request()).catch(error => error); await turn(); cache.clear()
  const b = cache.acquire(request()); await turn(); old.reject(Error('旧scope失败')); await a
  const c = cache.acquire(request()).catch(error => error); fresh.resolve(result())
  const [second, third] = await Promise.all([b, c]); assert.equal(fetches, 2); assert.equal(third.url, second.url)
  second.release(); third.release(); cache.clear()
})

test('007 RED：clear期间旧decode迟到仅revoke一次', async () => {
  const decode = held<void>(), revoked: string[] = []
  const cache = createRoonArtworkCache({ getImage: async () => result(), createObjectUrl: () => 'blob:old', revokeObjectUrl: url => revoked.push(url), decodeObjectUrl: () => decode.promise })
  const pending = cache.acquire(request()).catch(error => error); await turn(); cache.clear(); decode.resolve(); await pending
  assert.deepEqual(revoked, ['blob:old'])
})

test('007 RED：leased uncached也在强clear清理集合中', async () => {
  const revoked: string[] = []; let sequence = 0
  const cache = createRoonArtworkCache({ getImage: async () => result(), createObjectUrl: () => `blob:${++sequence}`, revokeObjectUrl: url => revoked.push(url), decodeObjectUrl: async () => undefined, maxEntries: 1 })
  const first = await cache.acquire(request(1)), second = await cache.acquire(request(2)); cache.clear()
  assert.deepEqual(revoked, ['blob:1', 'blob:2']); first.release(); second.release(); assert.equal(revoked.length, 2)
})

test('007 RED：取消一个subscriber不取消另一个，也不把取消者交付lease', async () => {
  const work = held(); let calls = 0
  const cache = createRoonArtworkCache({ getImage: () => { calls++; return work.promise }, createObjectUrl: () => 'blob:shared', revokeObjectUrl() {}, decodeObjectUrl: async () => undefined })
  const controller = new AbortController()
  const a = cache.acquire(request(), { signal: controller.signal }).catch(error => error)
  const b = cache.acquire(request()); await turn(); controller.abort(); work.resolve(result())
  const [cancelled, remaining] = await Promise.all([a, b]); assert.equal(cancelled.code, 'ARTWORK_CANCELLED'); assert.equal(calls, 1)
  remaining.release(); cache.clear()
})

test('007 RED：负cache时钟回拨必须重读，不能未来born伪fresh', async () => {
  let now = 10000, calls = 0
  const cache = createRoonArtworkCache({ getImage: async () => { calls++; throw Error('合成失败') }, now: () => now })
  await assert.rejects(cache.acquire(request())); now = 9000; await assert.rejects(cache.acquire(request())); assert.equal(calls, 2)
})

function fake(dependencies: Parameters<typeof createRoonArtworkCache>[0] = {}) {
  const revoked: string[] = []; let created = 0
  const cache = createRoonArtworkCache({ getImage: async () => result(), createObjectUrl: () => `blob:budget-${++created}`, revokeObjectUrl: url => revoked.push(url), decodeObjectUrl: async () => undefined, ...dependencies })
  return { cache, revoked, created: () => created }
}

test('007：全部subscriber取消零warm，actual getImage直到真实settle才归还', async () => {
  const work = held(), controller = new AbortController(), h = fake({ getImage: () => work.promise, maxActualGetImage: 1 })
  const pending = h.cache.acquire(request(), { signal: controller.signal }); const stopped = assert.rejects(pending, { code: 'ARTWORK_CANCELLED' })
  await turn(); controller.abort(); await stopped
  assert.equal(h.cache.inspect().actualGetImage, 1); assert.equal(h.cache.inspect().logicalFlights, 0)
  await assert.rejects(h.cache.acquire(request(2)), { code: 'ARTWORK_BUSY' }); assert.equal(h.cache.inspect().negativeEntries, 0)
  work.resolve(result()); await turn(); assert.equal(h.created(), 0); assert.equal(h.cache.inspect().actualGetImage, 0)
  const lease = await h.cache.acquire(request(2)); lease.release(); h.cache.clear()
})

test('007：decode本地timeout不归还actual或资源账，late settle一次回收且零warm', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const decode = held<void>(), h = fake({ decodeObjectUrl: () => decode.promise, maxActualDecode: 1, timeoutMs: 100 })
  const pending = h.cache.acquire(request()); const timeout = assert.rejects(pending, { code: 'ARTWORK_TIMEOUT' }); await turn()
  t.mock.timers.tick(101); await timeout
  assert.equal(h.cache.inspect().actualDecode, 1); assert.equal(h.cache.inspect().entries, 1); assert.equal(h.cache.inspect().compressedBytes, body.length)
  assert.deepEqual(h.revoked, ['blob:budget-1']); await assert.rejects(h.cache.acquire(request(2)), { code: 'ARTWORK_BUSY' })
  decode.resolve(); await turn(); assert.equal(h.cache.inspect().actualDecode, 0); assert.equal(h.cache.inspect().entries, 0); assert.equal(h.cache.inspect().decodedBytesEstimate, 0)
  assert.equal(h.revoked.filter(url => url === 'blob:budget-1').length, 1); h.cache.clear()
})

test('007：共享deadline固定，晚subscriber不能延长', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const work = held(), h = fake({ getImage: () => work.promise, timeoutMs: 100 })
  const a = h.cache.acquire(request()), failed = assert.rejects(a, { code: 'ARTWORK_TIMEOUT' }); await turn(); t.mock.timers.tick(90)
  const b = h.cache.acquire(request()), late = assert.rejects(b, { code: 'ARTWORK_TIMEOUT' }); t.mock.timers.tick(11)
  await Promise.all([failed, late]); assert.equal(h.cache.inspect().subscribers, 0); assert.equal(h.cache.inspect().actualGetImage, 1)
  work.resolve(result()); await turn(); assert.equal(h.created(), 0)
})

test('007：默认visible held30后playing保留2个getImage槽，取消不提前返还', async () => {
  const work = held(), h = fake({ getImage: () => work.promise })
  const reads = Array.from({ length: 30 }, (_, id) => h.cache.acquire(request(id + 1)))
  const settled = Promise.allSettled(reads); await turn(); assert.equal(h.cache.inspect().actualGetImage, 30)
  await assert.rejects(h.cache.acquire(request(31)), { code: 'ARTWORK_BUSY' })
  const p = h.cache.acquire(request(31), { priority: 'playing' }), q = h.cache.acquire(request(32), { priority: 'playing' })
  const players = Promise.allSettled([p, q]); await turn(); assert.equal(h.cache.inspect().actualGetImage, 32)
  await assert.rejects(h.cache.acquire(request(33), { priority: 'playing' }), { code: 'ARTWORK_BUSY' })
  h.cache.clear(); await Promise.all([settled, players]); assert.equal(h.cache.inspect().actualGetImage, 32)
  work.resolve(result()); await turn(); assert.equal(h.cache.inspect().actualGetImage, 0); assert.equal(h.created(), 0)
})

test('007：默认decode held30保留playing两槽，同keyplaying加入不重复getImage', async () => {
  const work = held<void>(), h = fake({ decodeObjectUrl: () => work.promise })
  const reads = Array.from({ length: 30 }, (_, id) => h.cache.acquire(request(id + 1)))
  const settled = Promise.allSettled(reads); await turn(); assert.equal(h.cache.inspect().actualDecode, 30)
  const shared = h.cache.acquire(request(1), { priority: 'playing' }); const sharedDone = shared.catch(error => error)
  const p = h.cache.acquire(request(31), { priority: 'playing' }), q = h.cache.acquire(request(32), { priority: 'playing' }); const players = Promise.allSettled([p, q])
  await turn(); assert.equal(h.cache.inspect().actualDecode, 32); assert.equal(h.created(), 32)
  h.cache.clear(); await Promise.all([settled, players, sharedDone]); assert.equal(h.cache.inspect().actualDecode, 32)
  work.resolve(); await turn(); assert.equal(h.cache.inspect().entries, 0); assert.equal(h.cache.inspect().actualDecode, 0)
})

for (const count of [1, 2]) test(`007：小actual预算${count}默认visible不饿死，playing预留比例生效`, async () => {
  const work = held(), h = fake({ maxActualGetImage: count, getImage: () => work.promise })
  const first = h.cache.acquire(request(1)); const firstDone = first.catch(error => error); await turn()
  if (count === 2) {
    await assert.rejects(h.cache.acquire(request(2)), { code: 'ARTWORK_BUSY' })
    const playing = h.cache.acquire(request(2), { priority: 'playing' }); const done = playing.catch(error => error); await turn(); h.cache.clear(); await done
  } else h.cache.clear()
  await firstDone; assert.equal(h.cache.inspect().actualGetImage, count)
  work.resolve(result()); await turn(); assert.equal(h.cache.inspect().actualGetImage, 0)
})

test('007：retained条目含uncached及活跃lease，忙后release可重试，不提前revoke', async () => {
  const h = fake({ maxEntries: 1, maxRetainedEntries: 2 })
  const a = await h.cache.acquire(request(1)), b = await h.cache.acquire(request(2))
  assert.equal(h.cache.inspect().entries, 2); assert.equal(h.cache.inspect().cachedEntries, 1)
  await assert.rejects(h.cache.acquire(request(3)), { code: 'ARTWORK_BUSY' }); assert.deepEqual(h.revoked, [])
  b.release(); assert.equal(h.cache.inspect().entries, 1)
  const c = await h.cache.acquire(request(3)); assert.equal(c.url, 'blob:budget-3'); a.release(); c.release(); h.cache.clear(); assert.equal(h.cache.inspect().entries, 0)
})

test('007：压缩及自然RGBA预算在Blob前拒绝，不能用小request掩盖大编码尺寸', async () => {
  const compressed = fake({ maxCompressedBytes: body.length - 1 })
  await assert.rejects(compressed.cache.acquire(request()), { code: 'ROON_IMAGE_DECODE_FAILED' }); assert.equal(compressed.created(), 0)
  const decoded = fake({ maxDecodedBytes: 256 * 256 * 4 - 1 })
  await assert.rejects(decoded.cache.acquire({ ...request(), width: 16, height: 16 }), { code: 'ROON_IMAGE_DECODE_FAILED' }); assert.equal(decoded.created(), 0)
  const mismatch = fake({ decodeObjectUrl: async () => ({ width: 512, height: 256, rgbaBytes: 512 * 256 * 4 }) })
  await assert.rejects(mismatch.cache.acquire(request()), { code: 'ROON_IMAGE_DECODE_FAILED' }); assert.equal(mismatch.cache.inspect().entries, 0); assert.equal(mismatch.revoked.length, 1)
})

test('007：negative/subscriber/logical预算和不含身份的diagnostics有界', async () => {
  const work = held(), h = fake({ getImage: () => work.promise, maxSubscribers: 2, maxFlights: 1 })
  const a = h.cache.acquire(request()), b = h.cache.acquire(request()); const all = Promise.allSettled([a, b]); await turn()
  await assert.rejects(h.cache.acquire(request()), { code: 'ARTWORK_BUSY' }); await assert.rejects(h.cache.acquire(request(2)), { code: 'ARTWORK_BUSY' })
  assert.deepEqual(Object.keys(h.cache.inspect()).sort(), ['entries', 'cachedEntries', 'compressedBytes', 'decodedBytesEstimate', 'logicalFlights', 'actualGetImage', 'actualDecode', 'subscribers', 'negativeEntries'].sort())
  assert.ok(Object.values(h.cache.inspect()).every(value => Number.isSafeInteger(value) && value >= 0))
  h.cache.clear(); await all; work.resolve(result()); await turn()
  let calls = 0; const failing = fake({ getImage: async () => { calls++; throw Error('合成失败') }, maxNegativeEntries: 2 })
  for (let id = 1; id <= 3; id++) await assert.rejects(failing.cache.acquire(request(id)))
  assert.equal(failing.cache.inspect().negativeEntries, 2); await assert.rejects(failing.cache.acquire(request(1))); assert.equal(calls, 4)
})

test('007：clear通知同props owner，旧lease invalidate不能污染新代', async () => {
  const h = fake(); let notifications = 0; const unsubscribe = h.cache.subscribeInvalidation(() => { notifications++ })
  const old = await h.cache.acquire(request()); h.cache.clear(); assert.equal(notifications, 1)
  const fresh = await h.cache.acquire(request()); old.invalidate(); assert.equal(h.cache.inspect().negativeEntries, 0); assert.notEqual(old.url, fresh.url)
  unsubscribe(); h.cache.clear(); assert.equal(notifications, 1); old.release(); fresh.release()
})

function sizedBody(width: number, height: number, length = body.length) {
  const bytes = new Uint8Array(length); bytes.set(body); bytes[7] = Math.floor(height / 256); bytes[8] = height % 256; bytes[9] = Math.floor(width / 256); bytes[10] = width % 256; return bytes
}
test('007：生产默认32MiB压缩硬上限含所有活跃lease，第9张4MiB不分配Blob', async () => {
  const image = sizedBody(256, 256, 4 * 1024 * 1024), h = fake({ getImage: async () => ({ contentType: 'image/jpeg', body: image }) })
  const leases = []
  for (let i = 1; i <= 8; i++) leases.push(await h.cache.acquire(request(i)))
  assert.equal(h.cache.inspect().compressedBytes, 32 * 1024 * 1024); await assert.rejects(h.cache.acquire(request(9)), { code: 'ARTWORK_BUSY' }); assert.equal(h.created(), 8)
  leases[0]!.release(); const retry = await h.cache.acquire(request(9)); assert.equal(h.created(), 9); assert.equal(h.revoked.length, 1)
  leases.forEach(lease => lease.release()); retry.release(); h.cache.clear(); assert.equal(h.cache.inspect().compressedBytes, 0)
})
test('007：生产默认自然RGBA96MiB硬上限，不按request256低估4096编码', async () => {
  let next = 0
  const h = fake({ getImage: async () => ({ contentType: 'image/jpeg', body: ++next === 1 ? sizedBody(4096, 4096) : next === 2 ? sizedBody(4096, 2048) : sizedBody(1, 1) }) })
  const first = await h.cache.acquire(request(1)), second = await h.cache.acquire(request(2))
  assert.equal(h.cache.inspect().decodedBytesEstimate, 96 * 1024 * 1024)
  await assert.rejects(h.cache.acquire(request(3)), { code: 'ARTWORK_BUSY' }); assert.equal(h.created(), 2)
  first.release(); second.release(); h.cache.clear(); assert.equal(h.cache.inspect().decodedBytesEstimate, 0)
})
test('007：生产默认128资源满时第129明确忙，普通LRU不通知clear/不撤lease', async () => {
  const h = fake(), leases = []; let notifications = 0; const unsubscribe = h.cache.subscribeInvalidation(() => { notifications++ })
  for (let i = 1; i <= 128; i++) leases.push(await h.cache.acquire(request(i)))
  assert.equal(h.cache.inspect().entries, 128); await assert.rejects(h.cache.acquire(request(129)), { code: 'ARTWORK_BUSY' }); assert.equal(h.created(), 128); assert.equal(notifications, 0)
  leases[0]!.release(); const last = await h.cache.acquire(request(129)); assert.equal(h.created(), 129); assert.equal(notifications, 0); assert.equal(h.revoked.length, 1)
  leases.forEach(lease => lease.release()); last.release(); unsubscribe(); h.cache.clear()
})
test('007：同代旧uncached lease的DOM invalidate也不得negative较新同key资源', async () => {
  const h = fake({ maxEntries: 1 }); const cached = await h.cache.acquire(request(1))
  const old = await h.cache.acquire(request(2)), fresh = await h.cache.acquire(request(2))
  old.invalidate(); assert.equal(h.cache.inspect().negativeEntries, 0); assert.ok(!h.revoked.includes(fresh.url))
  old.release(); fresh.release(); cached.release(); h.cache.clear()
})

test('007：Blob工厂同步clear再返回URL也只revoke一次，零stale decode', async () => {
  const revoked: string[] = []; let decoded = 0
  const cache = createRoonArtworkCache({ getImage: async () => result(), createObjectUrl: () => { cache.clear(); return 'blob:reentrant' }, revokeObjectUrl: url => revoked.push(url), decodeObjectUrl: async () => { decoded++ } })
  await assert.rejects(cache.acquire(request()), { code: 'ARTWORK_CANCELLED' })
  assert.equal(decoded, 0); assert.deepEqual(revoked, ['blob:reentrant']); assert.equal(cache.inspect().entries, 0)
})

test('007 默认接线：readLibrary独立owned id取消，原IPC Promise未结算仍占getImage预算', async t => {
  const previous = globalThis.window, raw = held(), reads: Array<{ id: string; command: string; payload: unknown; deadlineAtMs: number }> = [], cancels: string[] = []
  let fallback = 0, created = 0
  globalThis.window = { musicBridge: { readLibrary: async (request: typeof reads[number]) => { reads.push(request); return raw.promise }, cancelLibraryRead: async (id: string) => { cancels.push(id) }, getRoonImage: async () => { fallback++; return result() } } } as unknown as Window & typeof globalThis
  t.after(() => { if (previous) globalThis.window = previous; else Reflect.deleteProperty(globalThis, 'window') })
  const controller = new AbortController(), cache = createRoonArtworkCache({ createObjectUrl: () => { created++; return 'blob:default' }, revokeObjectUrl() {}, decodeObjectUrl: async () => undefined })
  const pending = cache.acquire(request(), { signal: controller.signal, priority: 'playing' }), cancelled = assert.rejects(pending, { code: 'ARTWORK_CANCELLED' }); await turn()
  assert.equal(reads.length, 1); assert.match(reads[0]!.id, /^[0-9a-f-]{36}$/); assert.equal(reads[0]!.command, 'roon.library.image')
  assert.deepEqual(reads[0]!.payload, { reference: request().reference, options: { width: 256, height: 256, scale: 'fit', format: 'image/jpeg' } })
  controller.abort(); await cancelled; assert.deepEqual(cancels, [reads[0]!.id]); assert.equal(cache.inspect().actualGetImage, 1); assert.equal(fallback, 0)
  raw.resolve(result()); await turn(); assert.equal(cache.inspect().actualGetImage, 0); assert.equal(created, 0)
})

test('007 默认接线：旧API一次fallback，新读协议失败零fallback重放', async t => {
  const previous = globalThis.window; t.after(() => { if (previous) globalThis.window = previous; else Reflect.deleteProperty(globalThis, 'window') })
  let fallback = 0
  const options = { createObjectUrl: () => 'blob:legacy', revokeObjectUrl() {}, decodeObjectUrl: async () => undefined }
  globalThis.window = { musicBridge: { getRoonImage: async () => { fallback++; return result() } } } as unknown as Window & typeof globalThis
  const legacy = createRoonArtworkCache(options), lease = await legacy.acquire(request()); assert.equal(fallback, 1); lease.release(); legacy.clear()
  globalThis.window = { musicBridge: { getRoonImage: async () => { fallback++; return result() }, readLibrary: async () => { throw Error('新协议失败') }, cancelLibraryRead: async () => undefined } } as unknown as Window & typeof globalThis
  await assert.rejects(createRoonArtworkCache(options).acquire(request())); assert.equal(fallback, 1)
})

test('007：受理后调用者改request/options不能串key或取消owner', async () => {
  const work = held(); const seen: string[] = [], controller = new AbortController(), other = new AbortController()
  const h = fake({ getImage: (reference) => { seen.push(reference); return work.promise } })
  const input = request(1), options = { signal: controller.signal }
  const pending = h.cache.acquire(input, options), rejected = assert.rejects(pending, { code: 'ARTWORK_CANCELLED' })
  input.reference = request(2).reference; input.width = 4096; options.signal = other.signal
  await turn(); controller.abort(); await rejected; assert.deepEqual(seen, [request(1).reference]); assert.equal(h.cache.inspect().subscribers, 0)
  work.resolve(result()); await turn(); assert.equal(h.created(), 0)
})
