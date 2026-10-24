import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { effectScope } from 'vue'
import { useLocalAlbumBrowserPages } from '../src/renderer/src/composables/application/local-library-browser/useLocalAlbumBrowser.js'
import { createLocalAlbumBrowserModel } from '../src/renderer/src/composables/application/local-library-browser/model.js'
import { LOCAL_ALBUM_STATUSES, type LocalAlbumArtworkReply, type LocalAlbumArtworkRequest, type LocalAlbumArtworkState, type LocalAlbumBrowserApi, type LocalAlbumFilterCounts, type LocalAlbumPage, type LocalAlbumQuery, type LocalAlbumSummary } from '../src/renderer/src/composables/application/local-library-browser/types.js'

// 运行正式状态机与合成读口；不访问真实DB、Source、图片解码器或播放器。
const rootId = '11111111-1111-4111-8111-111111111111'
const id = (index: number) => `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`
function album(index: number): LocalAlbumSummary {
  return { id: `interest-${index}`, kind: 'edition', rootId, editionId: id(index + 1), representativeTrackId: null,
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

test('正式双入口：默认自动读取9755项49页，离窗prepared不发RAM图API；可见近邻读图与返滚缓存继续工作', async t => {
  const time = clock(t), values = Array.from({ length: 9755 }, (_, index) => album(index)), queries: LocalAlbumQuery[] = [], reads: LocalAlbumArtworkRequest[] = []
  const scope = effectScope(), pages = scope.run(() => useLocalAlbumBrowserPages({ api: api(() => values, {
    queryAlbums: async request => { queries.push(request); return page(request, values) },
    getArtwork: async request => { reads.push(request); return reply(request) },
  }) }))!
  t.after(() => scope.stop())
  const model = pages.localLibrary
  await model.activate(); assert.equal(model.items.value.length, 200); assert.equal(queries.length, 1)
  await time.advance(0)
  assert.equal(reads.length, 0, '已prepared的首200项不能被Renderer重复全量hydrate')
  await time.advance(1000)
  assert.equal(model.items.value.length, 9755); assert.equal(model.hasMore.value, false)
  assert.deepEqual(queries.map(value => [value.offset, value.limit]), Array.from({ length: 49 }, (_, index) => [index * 200, 200]))
  assert.equal(reads.length, 0); assert.equal(model.backgroundArtwork.value, undefined, '不把Renderer检查数冒充Core补图进度')
  assert.deepEqual(model.getArtworkCacheUsage(), { entries: 0, bytes: 0, running: 0, queued: 0 })
  const visible = values.slice(0, 4), nearby = values.slice(4, 8)
  model.setArtworkWindow({ visible, nearby }); await Promise.all([...visible, ...nearby].map(value => model.ensureArtwork(value)))
  assert.equal(reads.length, 8); assert.ok(reads.every(value => value.variant === 'grid'))
  const retained = visible.map(value => model.artworkFor(value))
  assert.ok(retained.every(value => value.status === 'ready'))
  model.setArtworkWindow({ visible: values.slice(500, 504), nearby: values.slice(504, 508) })
  await Promise.all(values.slice(500, 508).map(value => model.ensureArtwork(value)))
  assert.equal(reads.length, 16)
  model.setArtworkWindow({ visible, nearby }); await Promise.all([...visible, ...nearby].map(value => model.ensureArtwork(value)))
  for (let index = 0; index < visible.length; index++) assert.equal(model.artworkFor(visible[index]!), retained[index])
  await time.advance(1500)
  assert.equal(reads.length, 16); assert.equal(queries.length, 49, '同状态图不制造计数补读，兴趣外也不接着hydrate')
  assertBudget(model, 2048, 32 * 1024 * 1024)
  assert.equal(pages.coverDrop.items.value.length, 0, '未激活的第二入口不抢读全库')
})

test('正式双入口：关闭全库RAM预热不阻止前台未prepared读取、显式失败重试和权威计数补读', async t => {
  const time = clock(t), values = [album(0), album(1), album(2)], reads: LocalAlbumArtworkRequest[] = [], queries: LocalAlbumQuery[] = []
  values[1] = { ...values[1]!, artworkAvailable: false, artworkState: 'missing', statuses: ['missing-artwork'] }
  values[2] = { ...values[2]!, artworkAvailable: false, artworkState: 'unknown', artworkPrepared: false, statuses: [] }
  const original = values[2]!, scope = effectScope()
  const pages = scope.run(() => useLocalAlbumBrowserPages({ api: api(() => values, {
    queryAlbums: async request => { queries.push(request); return page(request, values) },
    getArtwork: async request => {
      reads.push(request)
      if (reads.length === 1) throw new Error('合成前台首次读取失败')
      values[2] = { ...original, artworkAvailable: true, artworkState: 'available', artworkPrepared: true, statuses: ['has-artwork'] }
      return reply(request)
    },
  }) }))!
  t.after(() => scope.stop()); const model = pages.localLibrary
  await model.activate(); await time.advance(0); assert.equal(reads.length, 0)
  model.setArtworkWindow({ visible: [original], nearby: [values[1]!] })
  await model.ensureArtwork(original); assert.equal(model.artworkFor(original).status, 'error')
  assert.equal(model.artworkFor(original).canRetry, true); await model.ensureArtwork(original)
  await model.ensureArtwork(values[1]!); await time.advance(1500)
  assert.equal(reads.length, 1, '普通失败保显式重试，兴趣外没有背景自动循环')
  assert.equal(model.artworkFor(values[1]!).status, 'missing', '原缺图事实不强制重开Source')
  await model.retryArtwork(original); assert.equal(reads.length, 2); assert.equal(reads[1]!.refresh, true)
  const ready = model.artworkFor(original); assert.equal(ready.status, 'ready')
  await time.advance(250)
  assert.deepEqual(queries.map(value => value.limit), [200, 1], '状态真正变化后仍由一次权威回复核计数')
  assert.equal(model.counts.value['has-artwork'], 2); assert.equal(model.counts.value['missing-artwork'], 1)
  assert.equal(model.items.value[2]!.artworkState, 'available'); assert.equal(model.artworkFor(original), ready)
  assert.ok(reads.every(value => value.albumKey === original.id), '不顺手读取其他prepared卡片')
  assert.equal(model.getArtworkCacheUsage().running, 0); assert.equal(model.getArtworkCacheUsage().queued, 0)
})

test('正式双入口：显式开启旧RendererRAM预热仍真实完成，并与自动分页独立兼容', async t => {
  const time = clock(t), values = Array.from({ length: 4 }, (_, index) => album(index)), reads: string[] = [], offsets: number[] = []
  const scope = effectScope(), pages = scope.run(() => useLocalAlbumBrowserPages({ backgroundArtworkLoading: true, pageSize: 2, api: api(() => values, {
    queryAlbums: async request => { offsets.push(request.offset); return page(request, values) },
    getArtwork: async request => { reads.push(request.albumKey); return reply(request) },
  }) }))!
  t.after(() => scope.stop()); await pages.localLibrary.activate(); await time.advance(32)
  assert.deepEqual(offsets, [0, 2]); assert.deepEqual(reads, values.map(value => value.id))
  assert.equal(pages.localLibrary.backgroundArtwork.value?.completed, 4); assert.equal(pages.localLibrary.backgroundArtwork.value?.running, false)
  assert.equal(pages.localLibrary.getArtworkCacheUsage().entries, 4)
  pages.localLibrary.deactivate(); await time.advance(0); assert.equal(reads.length, 4)
})

test('正式双入口：真实计数补读失败仍保留错误和成功图片，不用关闭RAM预热掩盖红色告警', async t => {
  const time = clock(t), values = [{ ...album(0), artworkAvailable: false, artworkState: 'unknown' as const, artworkPrepared: false, statuses: [] }], queries: LocalAlbumQuery[] = []
  const scope = effectScope(), pages = scope.run(() => useLocalAlbumBrowserPages({ api: api(() => values, {
    queryAlbums: async request => { queries.push(request); if (request.limit === 1) throw new Error('合成权威计数不可用'); return page(request, values) },
  }) }))!
  t.after(() => scope.stop()); const model = pages.localLibrary
  await model.activate(); model.setArtworkWindow({ visible: values, nearby: [] }); await model.ensureArtwork(values[0]!)
  const ready = model.artworkFor(values[0]!); assert.equal(ready.status, 'ready')
  await time.advance(250)
  assert.match(model.refreshError.value, /封面计数暂未更新/); assert.equal(model.stale.value, true)
  assert.equal(model.artworkFor(values[0]!), ready); assert.equal(model.items.value.length, 1)
  await time.advance(1000); assert.deepEqual(queries.map(value => value.limit), [200, 1], '真实失败保留，由原显式恢复门禁处理')
})
