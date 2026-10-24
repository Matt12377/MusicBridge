import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { effectScope, nextTick, watch } from 'vue'
import { createLocalAlbumBrowserModel } from '../src/renderer/src/composables/application/local-library-browser/model.js'
import { useLocalAlbumBrowser } from '../src/renderer/src/composables/application/local-library-browser/useLocalAlbumBrowser.js'
import { LOCAL_ALBUM_STATUSES, type LocalAlbumArtworkReply, type LocalAlbumArtworkRequest, type LocalAlbumBrowserApi, type LocalAlbumFilterCounts, type LocalAlbumPage, type LocalAlbumQuery, type LocalAlbumSummary } from '../src/renderer/src/composables/application/local-library-browser/types.js'

// 只运行正式model/Vue订阅与合成读口；不访问真实DB、音乐、图片解码器或播放器。
const rootId = '11111111-1111-4111-8111-111111111111'
const id = (index: number) => `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`
function album(index: number, revision = '1'): LocalAlbumSummary {
  return { id: `renderer-${index}`, kind: 'edition', rootId, editionId: id(index + 1), representativeTrackId: null,
    title: `合成专辑 ${index}`, artists: ['合成艺人'], year: null, versionLabel: null, sourceLabel: '合成来源', trackCount: 0,
    revision, artworkAvailable: true, artworkState: 'available', artworkPrepared: true, statuses: ['has-artwork'] }
}
function page(request: LocalAlbumQuery, values: readonly LocalAlbumSummary[]): LocalAlbumPage {
  const scoped = values.filter(value => (request.rootId === null || request.rootId === value.rootId) && (!request.query || value.title.includes(request.query)))
  const selected = scoped.filter(value => request.filter === 'all' || value.statuses.includes(request.filter))
  const items = selected.slice(request.offset, request.offset + request.limit)
  const counts = Object.fromEntries([['all', scoped.length], ...LOCAL_ALBUM_STATUSES.map(status => [status, scoped.filter(value => value.statuses.includes(status)).length])]) as unknown as LocalAlbumFilterCounts
  return { ...request, items, counts, total: selected.length, hasMore: request.offset + items.length < selected.length }
}
const grid = Object.freeze({ mime: 'image/jpeg' as const, dataUrl: 'data:image/jpeg;base64,/9j/', bytes: 3, sha256: 'a'.repeat(64), width: 512, height: 512 })
const full = Object.freeze({ mime: 'image/jpeg' as const, dataUrl: 'data:image/jpeg;base64,/9j/AA==', bytes: 4, sha256: 'b'.repeat(64), width: 1200, height: 1200 })
function reply(request: LocalAlbumArtworkRequest): LocalAlbumArtworkReply {
  const { refresh: _refresh, ...identity } = request
  return { ...identity, status: 'ready', grid, image: { original: { mime: 'image/jpeg', bytes: 4, sha256: 'b'.repeat(64), width: 1200, height: 1200 }, display: request.variant === 'grid' ? grid : full } }
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

test('封面快照：相同或等价scrollTop不发布，滚动和选中变化复用已冻结的图片表', async t => {
  const values = [album(1), album(2)]; let publications = 0
  const model = createLocalAlbumBrowserModel({ api: api(() => values), onChange: () => { publications++ } }); t.after(model.dispose)
  await model.activate(); await model.ensureArtwork(values[0]!)
  const before = model.getSnapshot(), count = publications
  for (const top of [0, -1, -Infinity, Infinity, NaN]) model.setScrollTop(top)
  assert.equal(publications, count); assert.equal(model.getSnapshot(), before)
  model.setScrollTop(480)
  const moved = model.getSnapshot()
  assert.notEqual(moved, before); assert.equal(moved.scrollTop, 480); assert.equal(moved.artwork, before.artwork)
  for (let pass = 0; pass < 100; pass++) model.setScrollTop(480)
  assert.equal(publications, count + 1); assert.equal(model.getSnapshot(), moved)
  model.setSelectedAlbums([values[0]!.id]); assert.equal(model.getSnapshot().artwork, before.artwork)
  await model.refresh(); assert.equal(model.getSnapshot().artwork, before.artwork)
  assert.ok(Object.isFrozen(before.artwork)); assert.ok(Object.isFrozen(before.artwork[values[0]!.id]))
})

test('封面快照：正式Vue图片订阅不被连续滚动与普通目录刷新唤醒', async t => {
  const values = [album(3)], scope = effectScope()
  const browser = scope.run(() => useLocalAlbumBrowser({ api: api(() => values) }))!
  t.after(() => scope.stop()); await browser.activate(); await browser.ensureArtwork(values[0]!)
  const original = browser.snapshot.value.artwork; let artworkChanges = 0
  scope.run(() => watch(() => browser.artwork.value, () => { artworkChanges++ }, { flush: 'sync' }))
  for (let top = 1; top <= 120; top++) browser.setScrollTop(top)
  browser.setSelectedAlbums([values[0]!.id]); await browser.refresh(); await nextTick()
  assert.equal(artworkChanges, 0); assert.equal(browser.snapshot.value.artwork, original); assert.equal(browser.scrollTop.value, 120)
})

test('封面快照：loading、ready、LRU淘汰及显式失效仍发布真实变化，旧快照保持原值', async t => {
  const values = [album(4), album(5)], pending = deferred<LocalAlbumArtworkReply>(); let requested: LocalAlbumArtworkRequest | undefined
  const model = createLocalAlbumBrowserModel({ artworkCacheEntries: 1, api: api(() => values, { getArtwork: request => {
    if (request.albumKey !== values[0]!.id) return Promise.resolve(reply(request))
    requested = request; return pending.promise
  } }) }); t.after(model.dispose)
  await model.activate(); const empty = model.getSnapshot().artwork
  const loading = model.ensureArtwork(values[0]!), waiting = model.getSnapshot().artwork
  assert.ok(requested); assert.notEqual(waiting, empty); assert.equal(waiting[values[0]!.id]?.status, 'loading')
  model.setScrollTop(40); assert.equal(model.getSnapshot().artwork, waiting)
  pending.resolve(reply(requested)); await loading
  const ready = model.getSnapshot().artwork
  assert.notEqual(ready, waiting); assert.equal(ready[values[0]!.id]?.status, 'ready'); assert.equal(waiting[values[0]!.id]?.status, 'loading')
  await model.ensureArtwork(values[1]!)
  const evicted = model.getSnapshot().artwork
  assert.notEqual(evicted, ready); assert.equal(evicted[values[0]!.id], undefined); assert.equal(evicted[values[1]!.id]?.status, 'ready')
  assert.equal(ready[values[0]!.id]?.status, 'ready')
  await model.invalidateArtwork(values[1]!.id)
  assert.notEqual(model.getSnapshot().artwork, evicted); assert.equal(model.getSnapshot().artwork[values[1]!.id], undefined)
})

test('封面快照：失败与真实缺图仍替换状态，非图片发布不使其重复更新', async t => {
  const values = [album(13)]; let missing = false
  const model = createLocalAlbumBrowserModel({ api: api(() => values, { getArtwork: async request => {
    if (!missing) throw new Error('合成封面读取失败')
    const { refresh: _refresh, ...identity } = request
    return { ...identity, status: 'ready', image: null }
  } }) }); t.after(model.dispose)
  await model.activate(); await model.ensureArtwork(values[0]!)
  const failed = model.getSnapshot().artwork
  assert.equal(failed[values[0]!.id]?.status, 'error'); assert.equal(failed[values[0]!.id]?.canRetry, true)
  model.setScrollTop(41); assert.equal(model.getSnapshot().artwork, failed)
  missing = true; await model.retryArtwork(values[0]!)
  const absent = model.getSnapshot().artwork
  assert.notEqual(absent, failed); assert.equal(absent[values[0]!.id]?.status, 'missing'); assert.equal(absent[values[0]!.id]?.dataUrl, null)
  assert.equal(failed[values[0]!.id]?.status, 'error')
  model.setScrollTop(42); assert.equal(model.getSnapshot().artwork, absent)
})

test('封面快照：保留成功图的源不可用重校验只改私有退避，不替换图片表', async t => {
  const values = [album(6)]; let unavailable = false, reads = 0
  const model = createLocalAlbumBrowserModel({ compactGridArtwork: true, api: api(() => values, { getArtwork: async request => {
    reads++
    if (!unavailable) return reply(request)
    const { refresh: _refresh, ...identity } = request
    return { ...identity, status: 'source-unavailable', image: null }
  } }) }); t.after(model.dispose)
  await model.activate(); model.setArtworkWindow({ visible: values, nearby: [] }); await model.ensureArtwork(values[0]!)
  const ready = model.getSnapshot().artwork; unavailable = true; await model.refresh(true)
  assert.equal(reads, 2); assert.equal(model.getSnapshot().artwork, ready); assert.equal(ready[values[0]!.id]?.status, 'ready')
})

test('封面快照：详情高清覆盖与关闭恢复网格仍逐次发布，未变化详情不重复替换', async t => {
  const values = [album(7)]
  const model = createLocalAlbumBrowserModel({ compactGridArtwork: true, api: api(() => values) }); t.after(model.dispose)
  await model.activate(); await model.ensureArtwork(values[0]!)
  const gallery = model.getSnapshot().artwork
  await model.openAlbum(values[0]!); assert.equal(model.getSnapshot().artwork, gallery)
  await model.ensureArtwork(values[0]!); const detail = model.getSnapshot().artwork
  assert.notEqual(detail, gallery); assert.equal(detail[values[0]!.id]?.dataUrl, full.dataUrl)
  model.setScrollTop(80); assert.equal(model.getSnapshot().artwork, detail)
  model.closeAlbum(); const returned = model.getSnapshot().artwork
  assert.notEqual(returned, detail); assert.equal(returned[values[0]!.id]?.dataUrl, grid.dataUrl)
  assert.equal(detail[values[0]!.id]?.dataUrl, full.dataUrl); assert.equal(gallery[values[0]!.id]?.dataUrl, grid.dataUrl)
})

test('后台身份：连续40次普通修订刷新后不保留旧资格，重新出现的原修订可再次暖图', async t => {
  const time = clock(t), values = [album(8), album(9)], requests: LocalAlbumArtworkRequest[] = []
  const model = createLocalAlbumBrowserModel({ backgroundLoading: true, compactGridArtwork: true, artworkCacheEntries: 1,
    api: api(() => values, { getArtwork: async request => { requests.push(request); return reply(request) } }) }); t.after(model.dispose)
  await model.activate(); await time.advance(0)
  assert.equal(requests.length, 2); assert.equal(model.getSnapshot().backgroundArtwork?.completed, 2)
  for (let revision = 2; revision <= 41; revision++) {
    values[0] = { ...values[0]!, revision: String(revision) }; await model.refresh(); await time.advance(0)
    assert.equal(model.getSnapshot().backgroundArtwork?.completed, 2)
  }
  assert.equal(requests.filter(request => request.albumKey === values[1]!.id).length, 1, '未变化目录不能重新暖图')
  const before = requests.length
  values[0] = { ...values[0]!, revision: '1' }; await model.refresh(); await time.advance(0)
  assert.equal(requests.length, before + 1, '已离开当前目录集合的旧身份不应永久消耗后来同身份的资格')
  assert.equal(requests.at(-1)?.revision, '1'); assert.equal(model.artworkFor(values[0]!).status, 'ready')
  const settled = requests.length; await time.advance(60_000); assert.equal(requests.length, settled, '裁剪不能启动全库循环')
})

test('后台身份：删除后再出现的同tuple在LRU已淘汰时重新读取，未变目录仍不重读', async t => {
  const time = clock(t), first = album(10), second = album(11); let values = [first, second]
  const requests: LocalAlbumArtworkRequest[] = []
  const model = createLocalAlbumBrowserModel({ backgroundLoading: true, compactGridArtwork: true, artworkCacheEntries: 1,
    api: api(() => values, { getArtwork: async request => { requests.push(request); return reply(request) } }) }); t.after(model.dispose)
  await model.activate(); await time.advance(0); assert.equal(model.artworkFor(first).status, 'idle')
  values = [second]; await model.refresh(); await time.advance(0)
  assert.equal(model.getSnapshot().backgroundArtwork?.completed, 1)
  values = [first, second]; await model.refresh(); await time.advance(0)
  assert.deepEqual(requests.map(request => request.albumKey), [first.id, second.id, first.id])
  assert.equal(model.getSnapshot().backgroundArtwork?.completed, 2)
})

test('后台身份：普通刷新保留真正的后台flight，旧修订settle后才继续当前修订且迟到不覆盖', async t => {
  const time = clock(t), values = [album(12)], first = deferred<LocalAlbumArtworkReply>(), requests: LocalAlbumArtworkRequest[] = []
  let active = 0, maximum = 0
  const model = createLocalAlbumBrowserModel({ backgroundLoading: true, compactGridArtwork: true, api: api(() => values, { getArtwork: request => {
    requests.push(request); maximum = Math.max(maximum, ++active)
    const result = requests.length === 1 ? first.promise : Promise.resolve(reply(request))
    return result.finally(() => { active-- })
  } }) }); t.after(model.dispose)
  await model.activate(); await time.advance(0); assert.equal(requests.length, 1)
  values[0] = { ...values[0]!, revision: '2' }; await model.refresh(); await time.advance(0)
  assert.equal(requests.length, 1); assert.equal(active, 1); assert.equal(model.getSnapshot().backgroundArtwork?.running, true)
  first.resolve(reply(requests[0]!)); await drain(); await time.advance(0)
  assert.deepEqual(requests.map(request => request.revision), ['1', '2']); assert.equal(maximum, 1)
  assert.equal(model.getSnapshot().backgroundArtwork?.completed, 1); assert.equal(model.artworkFor(values[0]!).status, 'ready')
  values[0] = { ...values[0]!, revision: '1' }; await model.refresh(); await time.advance(0)
  assert.deepEqual(requests.map(request => request.revision), ['1', '2', '1'], '原flight收口后必须释放旧修订的后台标记')
  model.deactivate(); const before = requests.length; await time.advance(60_000); assert.equal(requests.length, before)
})
