import assert from 'node:assert/strict'
import test from 'node:test'
import { isLocalAlbumPage } from '@music-bridge/contracts'
import { createLocalAlbumBrowserModel, LOCAL_ALBUM_PAGE_SIZE, LOCAL_ALBUM_ARTWORK_COUNT_QUIET_MS, LOCAL_ALBUM_ARTWORK_COUNT_MAX_WAIT_MS } from '../src/renderer/src/composables/application/local-library-browser/model.js'
import { LOCAL_ALBUM_STATUSES, type LocalAlbumArtworkReply, type LocalAlbumArtworkRequest, type LocalAlbumBrowserApi, type LocalAlbumBrowserOptions, type LocalAlbumFilterCounts, type LocalAlbumPage, type LocalAlbumQuery, type LocalAlbumSummary } from '../src/renderer/src/composables/application/local-library-browser/types.js'

// 只执行正式Renderer model；Source/SQL/持久缓存与Native均不由这个内存夹具代证。
const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`
const root = id(1), otherRoot = id(2)
function album(n: number, changes: Partial<LocalAlbumSummary> = {}): LocalAlbumSummary {
  return { id: `count-album-${n}`, kind: 'edition', rootId: root, editionId: id(100 + n), title: `计数专辑 ${n}`, artists: ['合成艺人'], year: null, versionLabel: null,
    trackCount: 1, representativeTrackId: id(1000 + n), revision: '1', artworkAvailable: false, artworkState: 'unknown', statuses: [], ...changes }
}
function page(request: LocalAlbumQuery, albums: readonly LocalAlbumSummary[]): LocalAlbumPage {
  const scoped = albums.filter(value => (request.rootId === null || value.rootId === request.rootId) && (!request.query || value.title.includes(request.query)))
  const selected = scoped.filter(value => request.filter === 'all' || value.statuses.includes(request.filter))
  const items = selected.slice(request.offset, request.offset + request.limit)
  const counts = Object.fromEntries([['all', scoped.length], ...LOCAL_ALBUM_STATUSES.map(status => [status, scoped.filter(value => value.statuses.includes(status)).length])]) as unknown as LocalAlbumFilterCounts
  const result = { ...request, counts, items, total: selected.length, hasMore: request.offset + items.length < selected.length }
  assert.equal(isLocalAlbumPage(result, request), true, '合成回复先通过原DTO守门')
  return result
}
function observed(albums: LocalAlbumSummary[], request: LocalAlbumArtworkRequest, available: boolean): void {
  const index = albums.findIndex(value => value.id === request.albumKey && value.rootId === request.rootId)
  assert.ok(index >= 0)
  const value = albums[index]!
  albums[index] = { ...value, artworkAvailable: available, artworkState: available ? 'available' : 'missing',
    statuses: [...value.statuses.filter(status => status !== 'has-artwork' && status !== 'missing-artwork'), available ? 'has-artwork' : 'missing-artwork'] }
}
function reply(request: LocalAlbumArtworkRequest, available = true): LocalAlbumArtworkReply {
  return { albumKey: request.albumKey, rootId: request.rootId, editionId: request.editionId, representativeTrackId: request.representativeTrackId, revision: request.revision, status: 'ready',
    image: available ? { original: { mime: 'image/png', bytes: 4, sha256: 'a'.repeat(64), width: 32, height: 32 },
      display: { mime: 'image/jpeg', bytes: 3, sha256: 'b'.repeat(64), width: 16, height: 16, dataUrl: 'data:image/jpeg;base64,/9j/' } } : null }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}
// 明确越过新的250ms静默批窗口；既有来源/修订/串行断言保留，独立MockTimer用例核对合并及最大等待。
const nextTurn = () => new Promise<void>(resolve => setTimeout(resolve, LOCAL_ALBUM_ARTWORK_COUNT_QUIET_MS))
function fixture(albums: LocalAlbumSummary[], changes: Partial<LocalAlbumBrowserApi> = {}, options: Omit<Partial<LocalAlbumBrowserOptions>, 'api'> = {}) {
  const queries: LocalAlbumQuery[] = [], artwork: LocalAlbumArtworkRequest[] = []
  let activeQueries = 0, maxQueries = 0
  const api: LocalAlbumBrowserApi = {
    queryAlbums: async request => {
      queries.push({ ...request }); maxQueries = Math.max(maxQueries, ++activeQueries)
      try { return await (changes.queryAlbums?.(request) ?? Promise.resolve(page(request, albums))) } finally { activeQueries-- }
    },
    queryAlbumTracks: changes.queryAlbumTracks ?? (async () => { throw new Error('此夹具不读取曲目') }),
    getArtwork: async request => {
      artwork.push({ ...request })
      if (changes.getArtwork) return changes.getArtwork(request)
      observed(albums, request, true); return reply(request)
    },
  }
  const model = createLocalAlbumBrowserModel({ ...options, api })
  return { model, queries, artwork, countQueries: () => queries.filter(value => value.limit === 1), maxQueries: () => maxQueries }
}

test('MBF封面计数UI：同turn多图一次权威计数，重复无漂移且轻量事实不随图片LRU淘汰', async t => {
  const albums = Array.from({ length: 4 }, (_, index) => album(index + 1))
  const f = fixture(albums, {}, { pageSize: 4, artworkCacheEntries: 2 }); t.after(f.model.dispose)
  await f.model.activate()
  const first = [...f.model.getSnapshot().items]
  await Promise.all(first.slice(0, 2).map(value => f.model.ensureArtwork(value))); await nextTurn()
  assert.equal(f.countQueries().length, 1); assert.equal(f.model.getSnapshot().counts['has-artwork'], 2)
  assert.equal(f.model.getSnapshot().counts['missing-artwork'], 0)
  assert.ok(f.model.getSnapshot().items.slice(0, 2).every(value => value.artworkAvailable && value.artworkState === 'available' && value.statuses.includes('has-artwork')))
  await Promise.all(first.slice(2).map(value => f.model.ensureArtwork(value))); await nextTurn()
  const complete = f.model.getSnapshot()
  assert.equal(f.countQueries().length, 2); assert.equal(complete.counts['has-artwork'], 4)
  assert.equal(complete.items.length, 4); assert.ok(complete.items.every(value => value.artworkState === 'available' && value.statuses.includes('has-artwork')))
  assert.equal(f.model.getArtworkCacheUsage().entries, 2); assert.equal(f.model.artworkFor(first[0]!).status, 'idle')
  await f.model.ensureArtwork(first[0]!); await f.model.retryArtwork(first[0]!); await nextTurn()
  assert.equal(f.countQueries().length, 2, '同一已确认事实不重新发计数读或加一')
  assert.equal(f.model.getSnapshot().counts['has-artwork'], 4); assert.equal(f.model.getSnapshot().counts['missing-artwork'], 0)
  assert.equal(f.maxQueries(), 1); assert.ok(f.countQueries().every(value => value.offset === 0 && value.limit === 1))
})

test('MBF封面计数UI：权威读在途追加成功批次仍单飞，旧结果不覆盖新批次且尾窗不丢队', async t => {
  const albums = Array.from({ length: 4 }, (_, index) => album(index + 1)), firstCount = deferred<LocalAlbumPage>()
  let captured: LocalAlbumPage | undefined, countReads = 0
  const f = fixture(albums, { queryAlbums: request => {
    const result = page(request, albums)
    if (request.limit === 1 && ++countReads === 1) { captured = result; return firstCount.promise }
    return Promise.resolve(result)
  } }, { pageSize: 4, artworkCacheEntries: 2 }); t.after(f.model.dispose)
  await f.model.activate(); const values = [...f.model.getSnapshot().items]
  await Promise.all(values.slice(0, 2).map(value => f.model.ensureArtwork(value))); await nextTurn()
  assert.ok(captured); assert.equal(f.countQueries().length, 1); assert.equal(captured.counts['has-artwork'], 2)
  await Promise.all(values.slice(2).map(value => f.model.ensureArtwork(value))); await nextTurn()
  assert.equal(f.countQueries().length, 1, '旧计数读未settle前不并发启动第二读')
  assert.equal(f.model.getSnapshot().counts['has-artwork'], 0)
  firstCount.resolve(captured)
  // 先收旧work/finally，再让其合并的下一turn批次实际进入。
  await nextTurn(); await nextTurn()
  const snapshot = f.model.getSnapshot()
  assert.equal(f.countQueries().length, 2); assert.equal(f.maxQueries(), 1)
  assert.equal(snapshot.counts['has-artwork'], 4); assert.equal(snapshot.counts['missing-artwork'], 0)
  assert.ok(snapshot.items.every(value => value.artworkState === 'available' && value.statuses.includes('has-artwork')))
  assert.equal(f.model.getArtworkCacheUsage().entries, 2)
})

test('MBF封面计数UI：busy与错误不变missing，unknown无图不扣其他missing', async t => {
  const albums = Array.from({ length: 5 }, (_, index) => album(index + 1))
  albums[4] = album(5, { artworkAvailable: false, artworkState: 'missing', statuses: ['missing-artwork'] })
  const f = fixture(albums, { getArtwork: async request => {
    if (request.albumKey === albums[0]!.id) return { ...reply(request, false), status: 'source-unavailable' }
    if (request.albumKey === albums[1]!.id) throw new Error('合成读取拒绝')
    if (request.albumKey === albums[2]!.id) return { ...reply(request), revision: 'wrong-revision' }
    const available = request.albumKey === albums[4]!.id
    observed(albums, request, available); return reply(request, available)
  } }); t.after(f.model.dispose)
  await f.model.activate(); const values = [...f.model.getSnapshot().items]
  await Promise.all(values.map(value => f.model.ensureArtwork(value, value.id === albums[4]!.id))); await nextTurn()
  const snapshot = f.model.getSnapshot()
  assert.equal(snapshot.counts['has-artwork'], 1); assert.equal(snapshot.counts['missing-artwork'], 1)
  assert.ok(snapshot.items.slice(0, 3).every(value => value.artworkState === 'unknown' && value.statuses.length === 0))
  assert.equal(snapshot.items[3]!.artworkState, 'missing'); assert.deepEqual(snapshot.items[3]!.statuses, ['missing-artwork'])
  assert.equal(snapshot.items[4]!.artworkState, 'available'); assert.deepEqual(snapshot.items[4]!.statuses, ['has-artwork'])
  assert.ok(values.slice(0, 3).every(value => f.model.artworkFor(value).status === 'error'))
  assert.equal(f.countQueries().length, 1); assert.equal(f.maxQueries(), 1)
})

test('MBF封面计数UI：原分页在途且新counts已含旧卡观察时不重复加一', async t => {
  const albums = Array.from({ length: 4 }, (_, index) => album(index + 1)), more = deferred<LocalAlbumPage>()
  let moreRequest: LocalAlbumQuery | undefined
  const f = fixture(albums, { queryAlbums: request => {
    if (request.offset === 2) { moreRequest = request; return more.promise }
    return Promise.resolve(page(request, albums))
  } }, { pageSize: 2 }); t.after(f.model.dispose)
  await f.model.activate(); const first = f.model.getSnapshot().items[0]!
  const loading = f.model.loadMore()
  await f.model.ensureArtwork(first); await nextTurn()
  assert.equal(f.countQueries().length, 0, '计数批次等待原galleryPending，不与原分页抢写')
  assert.ok(moreRequest); more.resolve(page(moreRequest, albums)); await loading; await nextTurn()
  const snapshot = f.model.getSnapshot()
  assert.equal(snapshot.items.length, 4); assert.equal(snapshot.total, 4); assert.equal(snapshot.hasMore, false)
  assert.equal(snapshot.counts['has-artwork'], 1); assert.equal(snapshot.counts['missing-artwork'], 0)
  assert.equal(snapshot.items[0]!.artworkState, 'available'); assert.deepEqual(snapshot.items[0]!.statuses, ['has-artwork'])
  assert.equal(f.countQueries().length, 1); assert.equal(f.maxQueries(), 1)
  assert.deepEqual(f.queries.map(value => [value.offset, value.limit]), [[0, 2], [2, 2], [0, 1]])
})

test('MBF封面计数UI：详情先更新summary不吞掉尚未更新的gallery计数', async t => {
  const albums = [album(1, { trackCount: 0, representativeTrackId: null })], imageRead = deferred<LocalAlbumArtworkReply>()
  const f = fixture(albums, { queryAlbumTracks: async request => ({ ...request, album: albums[0]!, items: [], total: 0, hasMore: false }),
    getArtwork: async () => imageRead.promise }); t.after(f.model.dispose)
  await f.model.activate(); const original = f.model.getSnapshot().items[0]!
  // 合成另一已完成Owner观察：本模型尚未读图，详情先返回同tuple的available。
  const request: LocalAlbumArtworkRequest = { albumKey: original.id, rootId: original.rootId, editionId: original.editionId, representativeTrackId: original.representativeTrackId, revision: original.revision }
  observed(albums, request, true); await f.model.openAlbum(original)
  assert.equal(f.model.getSnapshot().items[0]!.artworkState, 'available'); assert.equal(f.model.getSnapshot().counts['has-artwork'], 0)
  assert.equal(f.artwork.length, 0)
  const reading = f.model.ensureArtwork(f.model.getSnapshot().selectedAlbum!)
  await nextTurn()
  const snapshot = f.model.getSnapshot()
  assert.equal(snapshot.selectedAlbum!.artworkState, 'available'); assert.deepEqual(snapshot.selectedAlbum!.statuses, ['has-artwork'])
  assert.equal(snapshot.items[0]!.artworkState, 'available'); assert.equal(snapshot.counts['has-artwork'], 1)
  assert.equal(f.countQueries().length, 1); assert.equal(f.maxQueries(), 1)
  imageRead.resolve(reply(request)); await reading; await nextTurn()
  assert.equal(f.model.artworkFor(snapshot.items[0]!).status, 'ready')
  assert.equal(f.model.getSnapshot().counts['has-artwork'], 1); assert.equal(f.countQueries().length, 1, '随后图像成功不重复计数')
})

test('MBF封面计数UI：封面筛选多成员变化只重建一次首页且不保留失效尾页', async t => {
  const albums = Array.from({ length: 2 }, (_, index) => album(index + 1, { artworkAvailable: true, artworkState: 'available', statuses: ['has-artwork'] }))
  const refreshed = deferred<LocalAlbumPage>(); let refreshRequest: LocalAlbumQuery | undefined, selectedReads = 0
  const f = fixture(albums, { queryAlbums: request => {
    if (request.filter === 'has-artwork' && request.limit === LOCAL_ALBUM_PAGE_SIZE && ++selectedReads === 2) { refreshRequest = request; return refreshed.promise }
    return Promise.resolve(page(request, albums))
  }, getArtwork: async request => { observed(albums, request, false); return reply(request, false) } }); t.after(f.model.dispose)
  await f.model.activate(); await f.model.setFilter('has-artwork')
  const values = [...f.model.getSnapshot().items]; f.model.setScrollTop(420); f.model.setSelectedAlbums(values.map(value => value.id))
  await Promise.all(values.map(value => f.model.ensureArtwork(value, true))); await nextTurn()
  assert.equal(f.countQueries().length, 1); assert.ok(refreshRequest)
  assert.equal(f.model.getSnapshot().refreshing, true); assert.equal(f.model.getSnapshot().items.length, 2, '新首页确认前保留旧快照')
  refreshed.resolve(page(refreshRequest, albums)); await nextTurn()
  const snapshot = f.model.getSnapshot()
  assert.equal(snapshot.filter, 'has-artwork'); assert.equal(snapshot.items.length, 0); assert.equal(snapshot.total, 0); assert.equal(snapshot.hasMore, false)
  assert.equal(snapshot.counts.all, 2); assert.equal(snapshot.counts['has-artwork'], 0); assert.equal(snapshot.counts['missing-artwork'], 2)
  assert.equal(snapshot.scrollTop, 0); assert.deepEqual(snapshot.selectedAlbumIds, [])
  assert.equal(f.queries.length, 4); assert.equal(selectedReads, 2); assert.equal(f.maxQueries(), 1)
})

test('MBF封面计数UI：旧图与旧计数跨scope迟到或离页均不污染当前页', async t => {
  const albums = [album(1, { title: '左', rootId: root }), album(2, { title: '右', rootId: otherRoot })], oldImage = deferred<LocalAlbumArtworkReply>()
  const countReads: { request: LocalAlbumQuery; gate: ReturnType<typeof deferred<LocalAlbumPage>>; result: LocalAlbumPage }[] = []
  const f = fixture(albums, { queryAlbums: request => {
    if (request.limit !== 1) return Promise.resolve(page(request, albums))
    const gate = deferred<LocalAlbumPage>(); countReads.push({ request, gate, result: page(request, albums) }); return gate.promise
  }, getArtwork: async request => {
    if (request.albumKey === albums[0]!.id) return oldImage.promise
    observed(albums, request, true); return reply(request)
  } }); t.after(f.model.dispose)
  await f.model.activate(); const left = f.model.getSnapshot().items[0]!, oldRead = f.model.ensureArtwork(left)
  await f.model.setScope({ query: '右', rootId: otherRoot, filter: 'all' }); const rightPage = f.model.getSnapshot()
  oldImage.resolve(reply({ albumKey: left.id, rootId: left.rootId, editionId: left.editionId, representativeTrackId: left.representativeTrackId, revision: left.revision })); await oldRead; await nextTurn()
  assert.equal(f.model.getSnapshot(), rightPage); assert.equal(f.countQueries().length, 0)
  await f.model.ensureArtwork(rightPage.items[0]!); await nextTurn(); assert.equal(countReads.length, 1)
  albums[0] = { ...albums[0]!, artworkState: 'missing', artworkAvailable: false, statuses: ['missing-artwork'] }
  await f.model.setScope({ query: '左', rootId: root, filter: 'all' }); const leftPage = f.model.getSnapshot()
  countReads[0]!.gate.resolve(countReads[0]!.result); await nextTurn()
  assert.equal(f.model.getSnapshot(), leftPage); assert.equal(leftPage.counts['has-artwork'], 0); assert.equal(leftPage.counts['missing-artwork'], 1)
  assert.equal(f.model.artworkFor(rightPage.items[0]!).status, 'ready', '切scope仍保同tuple的原成功LRU项')
  assert.deepEqual(f.artwork.filter(value => value.albumKey === albums[1]!.id).map(value => value.revision), ['1'])
  // 第二次真正读图必须使用新的来源修订，不能把同tuple的RAM命中冒充新成功。
  albums[1] = { ...albums[1]!, revision: '2', artworkState: 'unknown', artworkAvailable: false, statuses: [] }
  await f.model.setScope({ query: '右', rootId: otherRoot, filter: 'all' })
  assert.equal(f.model.getSnapshot().items[0]!.revision, '2'); assert.equal(f.model.artworkFor(f.model.getSnapshot().items[0]!).status, 'idle')
  await f.model.ensureArtwork(f.model.getSnapshot().items[0]!); await nextTurn(); assert.equal(countReads.length, 2)
  assert.deepEqual(f.artwork.filter(value => value.albumKey === albums[1]!.id).map(value => value.revision), ['1', '2'])
  f.model.deactivate(true); const inactive = f.model.getSnapshot()
  countReads[1]!.gate.resolve(countReads[1]!.result); await nextTurn()
  assert.equal(f.model.getSnapshot(), inactive); assert.equal(inactive.active, false); assert.equal(f.model.getArtworkCacheUsage().entries, 0)
  assert.equal(f.countQueries().length, 2)
})


test('MBF封面计数批次：跨事件完成的六张图只发一次权威汇总', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(Array.from({ length: 6 }, (_, index) => album(801 + index)), {}, { pageSize: 6 }); t.after(f.model.dispose)
  await f.model.activate(); const values = [...f.model.getSnapshot().items]
  for (const value of values) { await f.model.ensureArtwork(value); t.mock.timers.tick(10) }
  assert.equal(f.countQueries().length, 0)
  t.mock.timers.tick(LOCAL_ALBUM_ARTWORK_COUNT_QUIET_MS)
  for (let turn = 0; turn < 12; turn++) await Promise.resolve()
  assert.equal(f.countQueries().length, 1); assert.equal(f.model.getSnapshot().counts['has-artwork'], 6); assert.equal(f.maxQueries(), 1)
})

test('MBF封面计数批次：持续完成也在最大等待内开始权威汇总且保持单飞', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(Array.from({ length: 10 }, (_, index) => album(901 + index)), {}, { pageSize: 10 }); t.after(f.model.dispose)
  await f.model.activate(); const values = [...f.model.getSnapshot().items]
  for (let index = 0; index < 9; index++) {
    await f.model.ensureArtwork(values[index]!); t.mock.timers.tick(120)
    for (let turn = 0; turn < 12; turn++) await Promise.resolve()
  }
  assert.ok(9 * 120 >= LOCAL_ALBUM_ARTWORK_COUNT_MAX_WAIT_MS)
  assert.equal(f.countQueries().length, 1, '静默计时持续重置不能饿死最大等待计时')
  await f.model.ensureArtwork(values[9]!); t.mock.timers.tick(LOCAL_ALBUM_ARTWORK_COUNT_QUIET_MS)
  for (let turn = 0; turn < 12; turn++) await Promise.resolve()
  assert.equal(f.model.getSnapshot().counts['has-artwork'], 10); assert.equal(f.maxQueries(), 1)
})
