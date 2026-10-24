import assert from 'node:assert/strict'
import test from 'node:test'
import type { ArtistCatalogSearch, ArtistSearchCatalogPublicApi, LocalArtistSummary } from '@music-bridge/contracts'
import { useCatalogExperience, type CatalogDataPort } from '../src/renderer/src/composables/catalog/useCatalogExperience.js'
import { createCatalogDataAdapter } from '../src/renderer/src/composables/catalog/catalog-data-adapter.js'
import { localArtistItem, type CatalogPage } from '../src/renderer/src/composables/catalog/catalog-presentation.js'
import type { MusicBridgePublicApi } from '../src/preload/api.js'

const local = (name = '合成艺术家'): LocalArtistSummary => ({ id: `local-artist:${'a'.repeat(64)}`, name, source: 'local', albumCount: 1, trackCount: 1 })
const empty = (): CatalogPage => ({ items: [], offset: 0, limit: 24, total: 0, hasMore: false, revision: 'r1' })
const page = (name?: string): CatalogPage => ({ ...empty(), items: [localArtistItem(local(name))], total: 1 })
const preparing = () => Object.assign(new Error('[ARTIST_INDEX_PREPARING] 合成索引正在准备'), { code: 'ARTIST_INDEX_PREPARING' })
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function port(overrides: Partial<CatalogDataPort> = {}): CatalogDataPort {
  return { search: async () => empty(), suggest: async () => [], artists: async () => empty(), artist: async () => ({ artist: local() }),
    artistAlbums: async () => empty(), artistTracks: async () => empty(), remoteDetail: async () => empty(), artistMatches: async () => [],
    bindArtist: async () => ({ artist: local() }), ...overrides }
}

test('4.1 准备态保持加载而非空库，按500/1000/2000ms退避且在途请求不重叠', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const held = gate<CatalogPage>(); let reads = 0
  const model = useCatalogExperience(port({ artists: async () => { if (++reads < 4) throw preparing(); return held.promise } }))
  t.after(() => model.dispose())
  const work = model.loadArtists(); await turn()
  assert.equal(model.library.loading, true); assert.equal(model.library.preparing, true)
  assert.equal(model.library.error, ''); assert.equal(model.library.total, undefined)
  for (const delay of [500, 1000, 2000]) {
    const before = reads
    t.mock.timers.tick(delay - 1); await turn(); assert.equal(reads, before)
    t.mock.timers.tick(1); await turn(); assert.equal(reads, before + 1)
  }
  t.mock.timers.tick(60_000); await turn(); assert.equal(reads, 4, '等待真实回包时不能追加下一次查询')
  held.resolve(page()); await work
  assert.equal(model.library.preparing, false); assert.equal(model.library.loading, false)
  assert.equal(model.library.items.length, 1); assert.equal(model.library.error, '')
})

test('4.1 真实错误只读一次，NOT_READY和TIMEOUT不伪装成索引准备', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const code of ['AUTH_REQUIRED', 'AUTH_EXPIRED', 'NOT_READY', 'TIMEOUT', 'SNAPSHOT_CHANGED', 'INTERNAL_ERROR']) {
    let reads = 0
    const model = useCatalogExperience(port({ artists: async () => { reads++; throw Object.assign(new Error(`[${code}] 合成失败`), { code }) } }))
    await model.loadArtists(); t.mock.timers.tick(20_000); await turn()
    assert.equal(reads, 1, code); assert.equal(model.library.preparing, false); assert.equal(model.library.loading, false)
    assert.ok(model.library.error, code); model.dispose()
  }
})

test('4.1 准备等待最多五分钟，到期停止转圈并允许稍后重试', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let reads = 0
  const model = useCatalogExperience(port({ artists: async () => { reads++; throw preparing() } }))
  t.after(() => model.dispose())
  const work = model.loadArtists(); await turn()
  t.mock.timers.tick(5 * 60_000); await work
  assert.equal(model.library.loading, false); assert.equal(model.library.preparing, false)
  assert.match(model.library.error, /Mac仍在准备.*稍后重试/u)
  const stopped = reads; t.mock.timers.tick(60_000); await turn(); assert.equal(reads, stopped)
})

test('4.1 准备途中出现真实失败立即停止重试并显示失败', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let reads = 0
  const model = useCatalogExperience(port({ artists: async () => {
    if (++reads === 1) throw preparing()
    throw new Error('[AUTH_REQUIRED] 合成授权失效')
  } }))
  t.after(() => model.dispose())
  const work = model.loadArtists(); await turn(); t.mock.timers.tick(500); await work
  assert.equal(model.library.preparing, false); assert.equal(model.library.loading, false)
  assert.match(model.library.error, /请先登录/u)
  t.mock.timers.tick(60_000); await turn(); assert.equal(reads, 2)
})

test('4.1 换查询立刻结束旧等待，只重试最新查询且旧回包不能覆盖', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const old = gate<CatalogPage>(), calls: string[] = []
  const model = useCatalogExperience(port({ artists: async query => { calls.push(query); return query === '旧查询' ? old.promise : page(query) } }))
  t.after(() => model.dispose())
  const first = model.loadArtists('旧查询'); await turn()
  await model.loadArtists('新查询'); await first
  old.resolve(page('旧回包')); await turn(); t.mock.timers.tick(20_000); await turn()
  assert.deepEqual(calls, ['旧查询', '新查询']); assert.equal(model.library.items[0]?.title, '新查询')
  assert.equal(model.library.error, '')
})

test('4.1 来源过滤停止隐藏来源轮询，快速切回只恢复当前查询', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let ready = false, localReads = 0
  const model = useCatalogExperience(port({ search: async (source, kind) => {
    if (source === 'local') { localReads++; if (!ready) throw preparing() }
    return kind === 'artists' ? page(source) : empty()
  } }))
  t.after(() => model.dispose())
  const search = model.search('合成'); await turn()
  assert.equal(model.searchSections.local.artists.preparing, true)
  assert.equal(model.searchSections.netease.artists.items[0]?.title, 'netease')
  model.selectSource('netease'); t.mock.timers.tick(20_000); await search
  assert.equal(localReads, 3); assert.equal(model.searchSections.local.artists.loading, false)
  ready = true; model.selectSource('all'); await turn()
  assert.equal(model.searchSections.local.artists.items[0]?.title, 'local')
  assert.equal(model.searchSections.local.artists.preparing, false)
})

test('4.1 页面退出停止自己的轮询，另一个等待者仍能取得共享准备结果', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let ready = false, firstReads = 0, secondReads = 0
  const first = useCatalogExperience(port({ artists: async () => { firstReads++; if (!ready) throw preparing(); return page() } }))
  const second = useCatalogExperience(port({ artists: async () => { secondReads++; if (!ready) throw preparing(); return page() } }))
  t.after(() => { first.dispose(); second.dispose() })
  const left = first.loadArtists(), kept = second.loadArtists(); await turn()
  first.suspendWorkspace('artists'); await left
  ready = true; t.mock.timers.tick(500); await kept
  assert.equal(firstReads, 1); assert.equal(first.library.loading, false); assert.equal(first.library.preparing, false)
  assert.equal(secondReads, 2); assert.equal(second.library.items.length, 1)
})

test('4.1 关闭详情和dispose立即结束等待，不发布迟到资料或继续重试', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const held = gate<{ artist: LocalArtistSummary }>(); let reads = 0
  const model = useCatalogExperience(port({ artist: async () => held.promise,
    artistTracks: async () => { reads++; throw preparing() }, artistAlbums: async () => { reads++; throw preparing() } }))
  t.after(() => model.dispose())
  const detail = model.openDetail(localArtistItem(local())); await turn()
  assert.equal(model.detail.value?.tracks.preparing, true)
  model.closeDetail(); await detail
  held.resolve({ artist: local('迟到资料') }); await turn()
  assert.equal(model.detail.value, null)
  const other = model.loadArtists(); model.dispose(); await other
  t.mock.timers.tick(20_000); await turn(); assert.equal(reads, 3)
})

test('4.1 旧页面迟到的卸载不能清除新页面的详情与等待', async t => {
  const model = useCatalogExperience(port({ artist: async () => ({ artist: local('新页面人物') }) })), old = Symbol('旧页面'), current = Symbol('新页面')
  t.after(() => model.dispose())
  model.activateWorkspace('artists', old)
  const detail = model.openDetail(localArtistItem(local('新页面人物')))
  model.activateWorkspace('search', current); model.suspendWorkspace('artists', old)
  await detail
  assert.equal(model.detail.value?.item.title, '新页面人物')
  model.suspendWorkspace('search', current); assert.equal(model.detail.value, null)
})

test('4.1 联想准备不阻塞其它来源，换草稿清除旧准备轮询', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let reads = 0
  const model = useCatalogExperience(port({ search: async (source, kind) => {
    if (source === 'local') { reads++; throw preparing() }
    return kind === 'artists' ? page(source) : empty()
  } }))
  t.after(() => model.dispose())
  const work = model.preview('旧草稿'); await turn()
  assert.match(model.previewMessage.value, /正在准备本地艺术家与搜索/u)
  assert.ok(model.suggestions.value.some(item => item.title === 'netease'))
  model.invalidatePreview('新草稿'); await work
  t.mock.timers.tick(20_000); await turn()
  assert.equal(reads, 3); assert.equal(model.previewPending.value, 0); assert.equal(model.previewMessage.value, '')
})

test('4.1 数据适配仍共享同查询真实请求，撤销范围只拒绝旧回包', async t => {
  const held = gate<ArtistCatalogSearch>(); let requests = 0
  const result = (): ArtistCatalogSearch => {
    const part = { query: '合成', revision: 'r1', offset: 0, limit: 24, total: 0, hasMore: false, items: [] }
    return { query: '合成', revision: 'r1', artists: { ...part }, albums: { ...part }, tracks: { ...part } }
  }
  const api = { search: async () => { requests++; return requests === 1 ? held.promise : result() } } as unknown as ArtistSearchCatalogPublicApi
  const adapter = createCatalogDataAdapter({} as MusicBridgePublicApi, () => api)
  t.after(() => adapter.dispose())
  const old = Promise.allSettled((['artists', 'albums', 'tracks'] as const).map(kind => adapter.port.search('local', kind, '合成', { offset: 0, limit: 24 })))
  assert.equal(requests, 1)
  adapter.cancelSource('local')
  assert.equal((await adapter.port.search('local', 'artists', '合成', { offset: 0, limit: 24 })).items.length, 0)
  held.resolve(result())
  for (const settled of await old) { assert.equal(settled.status, 'rejected'); if (settled.status === 'rejected') assert.match(String(settled.reason), /CANCELLED/u) }
  assert.equal(requests, 2)
})
