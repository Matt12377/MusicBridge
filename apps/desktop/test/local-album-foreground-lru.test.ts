import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createLocalAlbumBrowserModel } from '../src/renderer/src/composables/application/local-library-browser/model.js'
import { LOCAL_ALBUM_STATUSES, type LocalAlbumArtworkReply, type LocalAlbumArtworkRequest, type LocalAlbumArtworkState, type LocalAlbumBrowserApi, type LocalAlbumFilterCounts, type LocalAlbumPage, type LocalAlbumQuery, type LocalAlbumSummary } from '../src/renderer/src/composables/application/local-library-browser/types.js'

// 运行正式状态机与合成读口；不访问真实DB、Source、图片解码器或播放器。
const rootId = '11111111-1111-4111-8111-111111111111'
const otherRootId = '22222222-2222-4222-8222-222222222222'
const id = (index: number) => `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`
function album(index: number): LocalAlbumSummary {
  return { id: `foreground-lru-${index}`, kind: 'edition', rootId, editionId: id(index + 1), representativeTrackId: null,
    title: `合成专辑 ${index}`, artists: ['合成艺人'], year: null, versionLabel: null, sourceLabel: '合成来源', trackCount: 0,
    revision: '1', artworkAvailable: true, artworkState: 'available', artworkPrepared: true, statuses: ['has-artwork'] }
}
function page(request: LocalAlbumQuery, values: readonly LocalAlbumSummary[]): LocalAlbumPage {
  const scoped = values.filter(value => (request.rootId === null || request.rootId === value.rootId) && (!request.query || value.title.includes(request.query)))
  const selected = scoped.filter(value => request.filter === 'all' || value.statuses.includes(request.filter))
  const items = selected.slice(request.offset, request.offset + request.limit)
  const counts = Object.fromEntries([['all', scoped.length], ...LOCAL_ALBUM_STATUSES.map(status => [status, scoped.filter(value => value.statuses.includes(status)).length])]) as unknown as LocalAlbumFilterCounts
  return { ...request, items, counts, total: selected.length, hasMore: request.offset + items.length < selected.length }
}
const grid = Object.freeze({ mime: 'image/jpeg' as const, dataUrl: 'data:image/jpeg;base64,/9j/', bytes: 3, sha256: 'a'.repeat(64), width: 512, height: 512 })
const imageBytes = grid.dataUrl.length * 2
function reply(request: LocalAlbumArtworkRequest, alternate = false): LocalAlbumArtworkReply {
  const { refresh: _refresh, ...identity } = request
  const display = alternate ? { ...grid, dataUrl: 'data:image/jpeg;base64,/9j/AA==', bytes: 4, sha256: 'b'.repeat(64) } : grid
  return { ...identity, status: 'ready', grid: display, image: { original: { mime: display.mime, bytes: display.bytes, sha256: display.sha256, width: 512, height: 512 }, display } }
}
function api(values: () => readonly LocalAlbumSummary[], changes: Partial<LocalAlbumBrowserApi> = {}): LocalAlbumBrowserApi {
  return { queryAlbums: async request => page(request, values()), getArtwork: async request => reply(request), queryAlbumTracks: async request => {
    const selected = values().find(value => value.id === request.albumKey && value.rootId === request.rootId)
    assert.ok(selected); return { ...request, album: selected, items: [], total: 0, hasMore: false }
  }, ...changes }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}
const drain = async () => { for (let pass = 0; pass < 32; pass++) await Promise.resolve() }
function clock(t: TestContext) {
  let now = 1_800_000_000_000, serial = 0, fired = 0
  const timers = new Map<number, { at: number; callback: (...args: any[]) => void; args: any[] }>()
  t.mock.method(Date, 'now', () => now)
  t.mock.method(globalThis, 'setTimeout', (callback: (...args: any[]) => void, delay = 0, ...args: any[]) => {
    const handle = ++serial; timers.set(handle, { at: now + Math.max(0, Number(delay)), callback, args }); return handle
  })
  t.mock.method(globalThis, 'clearTimeout', (handle: number) => { timers.delete(handle) })
  return { async advance(ms: number) {
    const end = now + ms
    for (;;) {
      const next = [...timers].sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0]
      if (!next || next[1].at > end) break
      assert.ok(++fired < 10_000, '合成时钟不能出现后台风暴')
      now = next[1].at; timers.delete(next[0]); next[1].callback(...next[1].args); await drain()
    }
    now = end; await drain()
  } }
}
type Browser = ReturnType<typeof createLocalAlbumBrowserModel>
function assertBudget(model: Browser, entries: number, bytes: number): void {
  const usage = model.getArtworkCacheUsage()
  assert.ok(usage.entries <= entries, `RAM项数 ${usage.entries} 必须在 ${entries} 内`)
  assert.ok(usage.bytes <= bytes, `RAM字节 ${usage.bytes} 必须在 ${bytes} 内`)
}

for (const budget of ['entries', 'bytes'] as const) test(`后台LRU：前台填满${budget}预算后，后台pending和真实完成均不得驱逐返滚图片`, async t => {
  const time = clock(t), values = Array.from({ length: 8 }, (_, index) => album(index)), foreground = values.slice(-2)
  const entries = budget === 'entries' ? 2 : values.length, bytes = budget === 'bytes' ? 2 * imageBytes : 64 * 1024
  const held = deferred<LocalAlbumArtworkReply>(), reads: LocalAlbumArtworkRequest[] = []
  let model!: Browser, protect = false
  const samples: Array<{ usage: ReturnType<Browser['getArtworkCacheUsage']>; images: readonly LocalAlbumArtworkState[] }> = []
  model = createLocalAlbumBrowserModel({ backgroundLoading: true, compactGridArtwork: true, artworkCacheEntries: entries, artworkCacheBytes: bytes,
    api: api(() => values, { getArtwork: request => { reads.push(request); return request.albumKey === values[0]!.id ? held.promise : Promise.resolve(reply(request)) } }),
    onChange: () => { if (protect) samples.push({ usage: model.getArtworkCacheUsage(), images: foreground.map(value => model.artworkFor(value)) }) } })
  t.after(() => { model.dispose(); if (reads[2]) held.resolve(reply(reads[2])) })
  await model.activate(); model.setArtworkWindow({ visible: foreground, nearby: [] })
  for (const value of foreground) await model.ensureArtwork(value)
  const retained = foreground.map(value => model.artworkFor(value))
  assert.ok(retained.every(value => value.status === 'ready')); assert.equal(reads.length, 2)
  model.setArtworkWindow({ visible: [], nearby: [] }); protect = true
  await time.advance(0)
  assert.equal(reads.length, 3, '后台必须真正进入原API，不能靠跳过读取保图')
  assert.equal(model.getArtworkCacheUsage().running, 1); assert.equal(model.getArtworkCacheUsage().queued, 0)
  assert.deepEqual(foreground.map(value => model.artworkFor(value)), retained); assertBudget(model, entries, bytes)
  held.resolve(reply(reads[2]!)); await drain()
  assert.equal(model.getSnapshot().backgroundArtwork?.completed, 1, '后台完成计数在LRU自淘汰前确认')
  assert.equal(model.getArtworkCacheUsage().running, 0, '只在真实API settle后归还槽位')
  await time.advance(0)
  assert.equal(reads.length, values.length); assert.equal(new Set(reads.map(value => value.albumKey)).size, values.length)
  assert.equal(model.getSnapshot().backgroundArtwork?.completed, values.length)
  assert.equal(model.getSnapshot().backgroundArtwork?.running, false)
  assert.deepEqual(model.getArtworkCacheUsage(), { entries: 2, bytes: 2 * imageBytes, running: 0, queued: 0 })
  assert.ok(samples.length > 0)
  for (const sample of samples) {
    assert.ok(sample.usage.entries <= entries); assert.ok(sample.usage.bytes <= bytes)
    for (let index = 0; index < retained.length; index++) assert.equal(sample.images[index], retained[index], '后台整个过程不撤前台ready引用')
  }
  model.setArtworkWindow({ visible: foreground, nearby: [] })
  for (let index = 0; index < foreground.length; index++) { await model.ensureArtwork(foreground[index]!); assert.equal(model.artworkFor(foreground[index]!), retained[index]) }
  await time.advance(0); assert.equal(reads.length, values.length, '返滚命中RAM；自淘汰不触发第二轮后台')
})

for (const touch of ['request', 'window'] as const) test(`后台LRU：${touch}前台触达升级ready图，仍按原预算淘汰真正旧前台`, async t => {
  const values = Array.from({ length: 5 }, (_, index) => album(index)), reads: string[] = []
  const model = createLocalAlbumBrowserModel({ compactGridArtwork: true, artworkCacheEntries: 2, api: api(() => values, { getArtwork: async request => { reads.push(request.albumKey); return reply(request) } }) })
  t.after(model.dispose); await model.activate(); await model.ensureArtwork(values[0]!, false, true)
  const first = model.artworkFor(values[0]!)
  if (touch === 'request') await model.ensureArtwork(values[0]!)
  else model.setArtworkWindow({ visible: [values[0]!], nearby: [] })
  model.setArtworkWindow({ visible: [], nearby: [] })
  await model.ensureArtwork(values[1]!, false, true); await model.ensureArtwork(values[2]!, false, true)
  assert.equal(model.artworkFor(values[0]!), first, '后台ready入窗或前台命中后不能再归后台层')
  assert.equal(model.artworkFor(values[1]!).status, 'idle', '先逐出最旧后台图')
  const second = model.artworkFor(values[2]!)
  model.setArtworkWindow({ visible: [values[2]!], nearby: [] }); await model.ensureArtwork(values[2]!)
  model.setArtworkWindow({ visible: [], nearby: [] }); await model.ensureArtwork(values[3]!, false, true)
  assert.equal(model.artworkFor(values[0]!), first); assert.equal(model.artworkFor(values[2]!), second)
  assert.equal(model.artworkFor(values[3]!).status, 'idle', '两个前台占满后，新后台真实完成可自淘汰')
  model.setArtworkWindow({ visible: [values[4]!], nearby: [] }); await model.ensureArtwork(values[4]!)
  assert.equal(model.artworkFor(values[0]!).status, 'idle', '旧前台没有永久豁免，真正新前台仍按LRU取代它')
  assert.equal(model.artworkFor(values[2]!), second); assert.equal(model.artworkFor(values[4]!).status, 'ready')
  assert.deepEqual(reads, values.map(value => value.id)); assertBudget(model, 2, 64 * 1024 * 1024)
})

test('后台LRU：已撤展示引用的后台flight被前台加入时仍只有一个API，settle后才归还槽位', async t => {
  const values = Array.from({ length: 3 }, (_, index) => album(index)), held = deferred<LocalAlbumArtworkReply>(), reads: LocalAlbumArtworkRequest[] = []
  const model = createLocalAlbumBrowserModel({ compactGridArtwork: true, artworkConcurrency: 1, artworkCacheEntries: 1,
    api: api(() => values, { getArtwork: request => { reads.push(request); return request.albumKey === values[1]!.id ? held.promise : Promise.resolve(reply(request)) } }) })
  t.after(() => { model.dispose(); if (reads[1]) held.resolve(reply(reads[1])) })
  await model.activate(); await model.ensureArtwork(values[0]!); const first = model.artworkFor(values[0]!)
  model.setArtworkWindow({ visible: [], nearby: [] })
  const background = model.ensureArtwork(values[1]!, false, true)
  assert.equal(model.artworkFor(values[0]!), first); assert.equal(model.artworkFor(values[1]!).status, 'idle')
  assert.deepEqual(model.getArtworkCacheUsage(), { entries: 1, bytes: imageBytes, running: 1, queued: 0 })
  model.setArtworkWindow({ visible: [values[1]!], nearby: [] }); const joined = model.ensureArtwork(values[1]!)
  assert.equal(reads.length, 2); assert.equal(model.artworkFor(values[1]!).status, 'loading')
  assert.equal(model.getArtworkCacheUsage().running, 1); assertBudget(model, 1, 64 * 1024 * 1024)
  held.resolve(reply(reads[1]!)); await Promise.all([background, joined]); await drain()
  const foreground = model.artworkFor(values[1]!); assert.equal(foreground.status, 'ready')
  assert.equal(model.getArtworkCacheUsage().running, 0)
  model.setArtworkWindow({ visible: [], nearby: [] }); await model.ensureArtwork(values[2]!, false, true)
  assert.equal(model.artworkFor(values[1]!), foreground); assert.equal(reads.length, 3)
  assert.deepEqual(model.getArtworkCacheUsage(), { entries: 1, bytes: imageBytes, running: 0, queued: 0 })
})

test('后台LRU：显式失效阻止同tuple的已detach在途旧图复活，真实槽位仍等原API归还', async t => {
  const values = [album(0), album(1)], held = deferred<LocalAlbumArtworkReply>(), reads: LocalAlbumArtworkRequest[] = []
  const model = createLocalAlbumBrowserModel({ compactGridArtwork: true, artworkConcurrency: 1, artworkCacheEntries: 1,
    api: api(() => values, { getArtwork: request => { reads.push(request); return reads.length === 2 ? held.promise : Promise.resolve(reply(request, reads.length > 2)) } }) })
  t.after(() => { model.dispose(); if (reads[1]) held.resolve(reply(reads[1])) })
  await model.activate(); await model.ensureArtwork(values[0]!); const first = model.artworkFor(values[0]!)
  model.setArtworkWindow({ visible: [], nearby: [] }); const background = model.ensureArtwork(values[1]!, false, true)
  assert.equal(model.artworkFor(values[0]!), first); assert.equal(model.artworkFor(values[1]!).status, 'idle')
  await model.invalidateArtwork(values[1]!.id)
  assert.equal(model.getArtworkCacheUsage().running, 1, '显式失效不是底层API的settle或物理abort')
  held.resolve(reply(reads[1]!)); await background; await drain()
  assert.equal(model.artworkFor(values[1]!).status, 'idle'); assert.equal(model.getSnapshot().artwork[values[1]!.id], undefined)
  assert.equal(model.artworkFor(values[0]!), first); assert.equal(model.getArtworkCacheUsage().running, 0)
  model.setArtworkWindow({ visible: [values[1]!], nearby: [] }); await model.ensureArtwork(values[1]!)
  assert.equal(reads.length, 3); assert.equal(model.artworkFor(values[1]!).status, 'ready')
  assert.equal(model.artworkFor(values[1]!).dataUrl, reply(reads[2]!, true).grid!.dataUrl, '只接受失效后真正新请求的图片')
  assertBudget(model, 1, 64 * 1024 * 1024)
})

test('后台LRU：显式失效阻止已detach排队旧job继续发API，前台阻塞项真实settle后队列收口', async t => {
  const values = [album(0), album(1), album(2)], held = deferred<LocalAlbumArtworkReply>(), reads: LocalAlbumArtworkRequest[] = []
  const model = createLocalAlbumBrowserModel({ compactGridArtwork: true, artworkConcurrency: 1, artworkCacheEntries: 2,
    api: api(() => values, { getArtwork: request => { reads.push(request); return request.albumKey === values[1]!.id ? held.promise : Promise.resolve(reply(request)) } }) })
  t.after(() => { model.dispose(); if (reads[1]) held.resolve(reply(reads[1])) })
  await model.activate(); await model.ensureArtwork(values[0]!); const first = model.artworkFor(values[0]!)
  model.setArtworkWindow({ visible: [values[1]!], nearby: [] }); const foreground = model.ensureArtwork(values[1]!)
  const queued = model.ensureArtwork(values[2]!, false, true)
  assert.deepEqual(model.getArtworkCacheUsage(), { entries: 2, bytes: imageBytes, running: 1, queued: 1 })
  assert.equal(reads.length, 2); assert.equal(model.artworkFor(values[0]!), first)
  await model.invalidateArtwork(values[2]!.id); assert.equal(model.getArtworkCacheUsage().running, 1)
  held.resolve(reply(reads[1]!)); await Promise.all([foreground, queued]); await drain()
  assert.equal(reads.length, 2, '被显式撤销的后台job不能以detach资格重新发API')
  assert.equal(model.artworkFor(values[2]!).status, 'idle'); assert.equal(model.getSnapshot().artwork[values[2]!.id], undefined)
  assert.deepEqual(model.getArtworkCacheUsage(), { entries: 2, bytes: 2 * imageBytes, running: 0, queued: 0 })
})

for (const changed of ['revision', 'rootId'] as const) test(`后台LRU：${changed}变化拒绝detach旧flight，原身份和新身份不交叉复用`, async t => {
  const values = [album(0), album(1)], held = deferred<LocalAlbumArtworkReply>(), reads: LocalAlbumArtworkRequest[] = []
  const model = createLocalAlbumBrowserModel({ compactGridArtwork: true, artworkConcurrency: 1, artworkCacheEntries: 1,
    api: api(() => values, { getArtwork: request => { reads.push(request); return reads.length === 2 ? held.promise : Promise.resolve(reply(request, reads.length > 2)) } }) })
  t.after(() => { model.dispose(); if (reads[1]) held.resolve(reply(reads[1])) })
  await model.activate(); await model.ensureArtwork(values[0]!)
  model.setArtworkWindow({ visible: [], nearby: [] }); const old = values[1]!, background = model.ensureArtwork(old, false, true)
  values[1] = changed === 'revision' ? { ...old, revision: '2' } : { ...old, rootId: otherRootId }
  await model.refresh(); held.resolve(reply(reads[1]!)); await background; await drain()
  assert.equal(model.artworkFor(values[1]!).status, 'idle'); assert.equal(model.artworkFor(old).status, 'idle')
  assert.equal(model.getSnapshot().artwork[old.id], undefined); assert.equal(model.getArtworkCacheUsage().running, 0)
  model.setArtworkWindow({ visible: [values[1]!], nearby: [] }); await model.ensureArtwork(values[1]!)
  assert.equal(reads.length, 3); assert.equal(reads[2]![changed], values[1]![changed])
  assert.equal(model.artworkFor(values[1]!).dataUrl, reply(reads[2]!, true).grid!.dataUrl)
  assert.equal(model.artworkFor(old).status, 'idle', '相同albumKey不允许复用不同root或revision')
  assertBudget(model, 1, 64 * 1024 * 1024)
})

test('后台LRU：known missing零字节自淘汰也计真实完成，不读取API、不驱逐前台或循环', async t => {
  const time = clock(t), values = [album(0), album(1)], reads: string[] = []
  values[0] = { ...values[0]!, artworkAvailable: false, artworkState: 'missing', statuses: ['missing-artwork'] }
  const model = createLocalAlbumBrowserModel({ backgroundLoading: true, compactGridArtwork: true, artworkCacheEntries: 1,
    api: api(() => values, { getArtwork: async request => { reads.push(request.albumKey); return reply(request) } }) })
  t.after(model.dispose); await model.activate(); model.setArtworkWindow({ visible: [values[1]!], nearby: [] }); await model.ensureArtwork(values[1]!)
  const foreground = model.artworkFor(values[1]!); model.setArtworkWindow({ visible: [], nearby: [] })
  await time.advance(0)
  assert.equal(model.getSnapshot().backgroundArtwork?.completed, 2, 'missing必须在自淘汰前记完成，不能只依赖finally里的RAM引用')
  assert.equal(model.getSnapshot().backgroundArtwork?.running, false); assert.deepEqual(reads, [values[1]!.id])
  assert.equal(model.artworkFor(values[1]!), foreground); assert.equal(model.getSnapshot().artwork[values[0]!.id], undefined)
  assert.deepEqual(model.getArtworkCacheUsage(), { entries: 1, bytes: imageBytes, running: 0, queued: 0 })
  await time.advance(0); assert.deepEqual(reads, [values[1]!.id]); assert.equal(model.getSnapshot().backgroundArtwork?.completed, 2)
})
