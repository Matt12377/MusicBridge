import assert from 'node:assert/strict'
import test from 'node:test'
import type { LocalArtistSummary, Page, TrackSummary } from '@music-bridge/contracts'
import { groupCatalogArtists, localArtistItem, neteaseArtistItem, roonCatalogItem, type CatalogItem, type CatalogPage } from '../src/renderer/src/composables/catalog/catalog-presentation.js'
import { useCatalogExperience, type CatalogDataPort } from '../src/renderer/src/composables/catalog/useCatalogExperience.js'
import { readCatalogPlaybackPrefix, readCatalogRoonPlaybackPrefix } from '../src/renderer/src/composables/catalog/catalog-playback-selection.js'
import { sidebarSearchKeyAction } from '../src/renderer/src/components/sidebar/sidebar-search-model.js'

const local = (linkedNeteaseId?: string): LocalArtistSummary => ({ id: `local-artist:${'a'.repeat(64)}`, name: '同名艺人', source: 'local', albumCount: 2, trackCount: 7, ...(linkedNeteaseId ? { linkedNeteaseId } : {}) })
const empty = (): CatalogPage => ({ items: [], offset: 0, limit: 24, total: 0, hasMore: false, revision: 'r1' })
const page = (item: CatalogItem): CatalogPage => ({ ...empty(), items: [item], total: 1 })
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
const turn = () => new Promise<void>(yes => setImmediate(yes))
function port(overrides: Partial<CatalogDataPort> = {}): CatalogDataPort {
  return { search: async () => empty(), suggest: async () => [], artists: async () => empty(), artist: async () => ({ artist: local() }),
    artistAlbums: async () => empty(), artistTracks: async () => empty(), remoteDetail: async () => empty(), artistMatches: async () => [], bindArtist: async () => ({ artist: local() }), ...overrides }
}

test('4.1 同名未绑定不合卡，明确人物ID关联才共卡并保留两个来源及本地计数', () => {
  const remote = neteaseArtistItem({ id: '12', name: '同名艺人' })
  assert.equal(groupCatalogArtists([localArtistItem(local()), remote]).length, 2)
  const groups = groupCatalogArtists([localArtistItem(local('12')), remote])
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0]!.entries.map(item => item.source), ['local', 'netease'])
  assert.equal(groups[0]!.localAlbumCount, 2); assert.equal(groups[0]!.localTrackCount, 7)
  assert.equal(groupCatalogArtists([localArtistItem(local('13')), remote]).length, 2)
})

test('4.1 统一搜索的单来源人物卡只保留该来源入口，资料头像不扩大范围', async t => {
  const portrait = 'https://example.invalid/netease-portrait.jpg'
  const items = {
    local: localArtistItem(local('12'), portrait),
    netease: neteaseArtistItem({ id: '12', name: '同名艺人' }),
    roon: roonCatalogItem({ reference: 'roon-artist-1', kind: 'artist', title: '同名艺人' }),
  }
  const model = useCatalogExperience(port({ search: async (source, kind) => kind === 'artists' ? page(items[source]) : empty() }))
  t.after(() => model.dispose())
  await model.search('同名艺人')
  assert.deepEqual(model.artistCards.value.map(card => card.entries.map(item => item.source)), [['local', 'netease'], ['roon']])
  for (const source of ['local', 'netease', 'roon'] as const) {
    model.selectSource(source)
    assert.equal(model.artistCards.value.length, 1)
    assert.deepEqual(model.artistCards.value[0]!.entries.map(item => item.key), [items[source].key])
    if (source === 'local') assert.equal(model.artistCards.value[0]!.artworkUrl, portrait)
  }
  model.selectSource('all')
  assert.deepEqual(model.artistCards.value.map(card => card.entries.map(item => item.source)), [['local', 'netease'], ['roon']])
})

test('4.1 已确认关联缺少远端搜索结果时全部来源仍保留入口，本地筛选不改变艺术家列表', async t => {
  const item = localArtistItem(local('12'))
  const model = useCatalogExperience(port({ artists: async () => page(item),
    search: async (source, kind) => source === 'local' && kind === 'artists' ? page(item) : empty() }))
  t.after(() => model.dispose())
  await model.loadArtists(); await model.search('同名艺人')
  assert.deepEqual(model.artistCards.value[0]!.entries.map(entry => entry.source), ['local', 'netease'])
  assert.equal(model.artistCards.value[0]!.entries[0]!.identity.type, 'local-artist')
  assert.deepEqual(model.artistCards.value[0]!.entries[1]!.identity, { type: 'netease-artist', value: { id: '12', name: '同名艺人' } })
  model.selectSource('local')
  assert.deepEqual(model.artistCards.value[0]!.entries.map(entry => entry.source), ['local'])
  assert.deepEqual(model.libraryCards.value[0]!.entries.map(entry => entry.source), ['local', 'netease'])
  model.selectSource('all')
  assert.deepEqual(model.artistCards.value[0]!.entries.map(entry => entry.source), ['local', 'netease'])
})

test('4.1 详情关联资料晚到后继续遵守当前单来源范围，切回全部来源才展示关联入口', async t => {
  const held = gate<{ artist: LocalArtistSummary; artworkUrl: string }>()
  const remote = neteaseArtistItem({ id: '12', name: '同名艺人' })
  const model = useCatalogExperience(port({ artist: async () => held.promise,
    search: async (source, kind) => kind !== 'artists' ? empty() : source === 'local' ? page(localArtistItem(local()))
      : source === 'netease' ? page(remote) : empty() }))
  t.after(() => model.dispose())
  await model.search('同名艺人')
  const detail = model.openDetail(localArtistItem(local()))
  model.selectSource('netease'); model.selectSource('local')
  held.resolve({ artist: local('12'), artworkUrl: 'https://example.invalid/late-portrait.jpg' })
  await detail
  assert.equal(model.sourceFilter.value, 'local')
  assert.equal(model.detail.value?.profile?.artist.linkedNeteaseId, '12')
  assert.equal(model.artistCards.value[0]!.artworkUrl, 'https://example.invalid/late-portrait.jpg')
  assert.deepEqual(model.artistCards.value[0]!.entries.map(item => item.source), ['local'])
  model.selectSource('all')
  assert.deepEqual(model.artistCards.value[0]!.entries.map(item => item.source), ['local', 'netease'])
})

test('4.1 某来源慢或鉴权失败不挡住其它来源，旧查询晚回包不覆盖新查询', async t => {
  const held = gate<CatalogPage>()
  const model = useCatalogExperience(port({ search: async (source, kind, query) => {
    if (query === '旧查询' && source === 'roon') return held.promise
    if (source === 'netease') throw new Error('[AUTH_REQUIRED] 登录')
    return kind === 'artists' ? page(localArtistItem({ ...local(), name: query })) : empty()
  } }))
  t.after(() => model.dispose())
  const first = model.search('旧查询'); await turn()
  assert.equal(model.searchSections.local.artists.items[0]?.title, '旧查询')
  assert.match(model.searchSections.netease.artists.error, /请先登录/u)
  assert.equal(model.searchSections.roon.artists.loading, true)
  await model.search('新查询')
  held.resolve(page(neteaseArtistItem({ id: '99', name: '旧回包' }))); await first
  assert.equal(model.searchSections.local.artists.items[0]?.title, '新查询')
  assert.ok(model.searchSections.roon.artists.items.every(item => item.title !== '旧回包'))
})

test('4.1 草稿预览与已提交结果隔离，来源失效时晚回包不复活旧结果', async t => {
  const held = gate<CatalogPage>()
  const model = useCatalogExperience(port({ search: async (source, kind, query) => query === '预览' && source === 'netease' ? held.promise
    : kind === 'artists' ? page(localArtistItem({ ...local(), name: query })) : empty() }))
  t.after(() => model.dispose())
  await model.search('原结果')
  model.invalidatePreview('预览'); const work = model.preview('预览'); await turn()
  assert.equal(model.query.value, '原结果'); assert.equal(model.searchSections.local.artists.items[0]?.title, '原结果')
  model.invalidateSource('netease'); held.resolve(page(neteaseArtistItem({ id: '7', name: '旧账号' }))); await work
  assert.ok(model.suggestions.value.every(item => item.title !== '旧账号'))
  assert.equal(model.searchSections.local.artists.items[0]?.title, '原结果')
})

test('4.1 未知关联写不自动重发，关闭重开仍须先读回再允许新决定', async t => {
  let writes = 0, profileReads = 0
  const model = useCatalogExperience(port({ artist: async () => { profileReads++; return { artist: local(profileReads > 1 ? '12' : undefined) } },
    bindArtist: async () => { writes++; throw new Error('合成未知结果') } }))
  t.after(() => model.dispose())
  await model.openDetail(localArtistItem(local()))
  assert.equal(model.detail.value?.albums.loading, false); assert.equal(model.detail.value?.tracks.loading, false)
  model.openBinding(); await model.bind('12'); await model.bind('12')
  assert.equal(writes, 1); assert.match(model.bindingError.value, /尚未确认/u)
  model.closeBinding(); model.openBinding(); await model.bind('12')
  assert.equal(writes, 1); assert.match(model.bindingError.value, /尚未确认/u)
  await model.refreshProfile()
  assert.equal(model.detail.value?.profile?.artist.linkedNeteaseId, '12'); assert.equal(model.bindingError.value, '')
})

test('4.1 资料鉴权失败保留本地详情各分区并显示真实状态', async t => {
  const model = useCatalogExperience(port({ artist: async () => { throw new Error('[AUTH_REQUIRED] 合成登录状态') } }))
  t.after(() => model.dispose())
  await model.openDetail(localArtistItem(local()))
  assert.match(model.detail.value?.profileError ?? '', /请先登录/u)
  for (const kind of ['albums', 'appearsOn', 'tracks'] as const) { assert.equal(model.detail.value?.[kind].loading, false); assert.equal(model.detail.value?.[kind].error, '') }
})

test('4.1 详情取得明确关联后立即更新原列表和共卡，无需重新搜索', async t => {
  const model = useCatalogExperience(port({ artists: async () => page(localArtistItem(local())), artist: async () => ({ artist: local('12'), artworkUrl: 'https://example.invalid/portrait.jpg' }),
    search: async (source, kind) => kind !== 'artists' ? empty() : source === 'local' ? page(localArtistItem(local())) : source === 'netease' ? page(neteaseArtistItem({ id: '12', name: '同名艺人' })) : empty() }))
  t.after(() => model.dispose())
  await model.loadArtists(); await model.search('同名艺人')
  assert.equal(model.artistCards.value.length, 2)
  await model.openDetail(localArtistItem(local()))
  assert.equal(model.artistCards.value.length, 1); assert.equal(model.libraryCards.value[0]?.entries.length, 2)
  assert.equal(model.libraryCards.value[0]?.artworkUrl, 'https://example.invalid/portrait.jpg')
})

test('4.1 键盘IME期间不选择，空Enter不提交，Esc只关，下拉上下键含查看全部', () => {
  const base = { open: true, highlighted: -1, count: 3, query: '艺人', composing: false }
  assert.deepEqual(sidebarSearchKeyAction({ ...base, key: 'Enter', composing: true }), { type: 'none' })
  assert.deepEqual(sidebarSearchKeyAction({ ...base, key: 'Enter', query: '  ' }), { type: 'none' })
  assert.deepEqual(sidebarSearchKeyAction({ ...base, key: 'Escape' }), { type: 'close' })
  assert.deepEqual(sidebarSearchKeyAction({ ...base, key: 'ArrowDown' }), { type: 'highlight', index: 0 })
  assert.deepEqual(sidebarSearchKeyAction({ ...base, key: 'ArrowUp', highlighted: 0 }), { type: 'highlight', index: 3 })
  assert.deepEqual(sidebarSearchKeyAction({ ...base, key: 'Enter', highlighted: 3 }), { type: 'submit' })
})

test('4.1 后页歌曲先定位原选择，前缀留给原渐进队列继续消费，不静默改播首曲', async () => {
  const calls: number[] = []
  const load = async (window: { offset: number; limit: number }): Promise<Page<TrackSummary>> => {
    calls.push(window.offset)
    return { ...window, total: 250, hasMore: window.offset + window.limit < 250,
      items: Array.from({ length: Math.min(window.limit, 250 - window.offset) }, (_, n) => ({ id: String(window.offset + n), title: '合成歌曲', artists: [], album: '' })) }
  }
  const prefix = await readCatalogPlaybackPrefix(load, '137')
  assert.deepEqual(calls, [0, 100]); assert.equal(prefix.items.findIndex(item => item.id === '137'), 137)
  assert.equal(prefix.offset, 0); assert.equal(prefix.limit, 200); assert.equal(prefix.hasMore, true)
  await assert.rejects(readCatalogPlaybackPrefix(load, '不存在'), /所选歌曲已不在/u)
})

test('4.1 Roon搜索后页保持原epoch，换代拒绝组队', async () => {
  const calls: number[] = []
  const load = async (window: { offset: number; limit: number }) => { calls.push(window.offset); return { ...window, sourceEpoch: 'epoch-a', items: [{ reference: window.offset ? 'selected' : 'first', kind: 'track' as const, title: '合成曲目' }], hasMore: window.offset === 0, nextOffset: window.offset + 100, complete: window.offset > 0 } }
  const prefix = await readCatalogRoonPlaybackPrefix(load, 'selected')
  assert.deepEqual(calls, [0, 100]); assert.equal(prefix.items.length, 2); assert.equal(prefix.sourceEpoch, 'epoch-a')
  await assert.rejects(readCatalogRoonPlaybackPrefix(async window => ({ ...await load(window), sourceEpoch: window.offset ? 'epoch-b' : 'epoch-a' }), 'selected'), /上下文已变化/u)
})
