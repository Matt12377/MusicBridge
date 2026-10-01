import assert from 'node:assert/strict'
import test from 'node:test'
import { groupSearchArtists, mixSearchAlbums } from '../src/renderer/src/composables/search-entities.js'

test('同名艺人聚合展示但保留两个来源的独立入口', () => {
  const result = groupSearchArtists([{ id: '1', name: ' Artist ' }], [{ reference: 'r1', kind: 'artist', title: 'artist' }])
  assert.equal(result.length, 1)
  assert.equal(result[0]?.netease?.id, '1')
  assert.equal(result[0]?.roon?.reference, 'r1')
})

test('重名和未确认的中英文别名不误合并', () => {
  assert.equal(groupSearchArtists([{ id: '1', name: '同名' }, { id: '2', name: '同名' }], [{ reference: 'r1', kind: 'artist', title: '同名' }]).length, 3)
  assert.equal(groupSearchArtists([{ id: '1', name: '草蜢' }], [{ reference: 'r1', kind: 'artist', title: 'Grasshopper' }]).length, 2)
})

test('专辑跨来源交错展示，保留同名版本并排除单曲', () => {
  const result = mixSearchAlbums([{ id: '1', name: '专辑', artistName: '艺人' }], [
    { reference: 'r1', kind: 'album', title: '专辑' },
    { reference: 'r2', kind: 'album', title: '专辑', year: 2024 },
    { reference: 'r3', kind: 'track', title: '歌曲' },
  ])
  assert.deepEqual(result.map((item) => item.key), ['roon:r1', 'netease:1', 'roon:r2'])
})

test('MBP004：聚合Roon搜索下一页用cursor，混代有界重读且Provider路径不参与', async t => {
  const { useAggregatedSearch } = await import('../src/renderer/src/composables/application/useAggregatedSearch.js')
  const epochA = '00000000-0000-4000-8000-000000000001', epochB = '00000000-0000-4000-8000-000000000002'
  const calls: number[] = []
  const api = { searchRoonLibrary: async (_query: string, request: { offset: number; limit: number }) => {
    calls.push(request.offset)
    return { items: [{ reference: `album:${calls.length}`, kind: 'album' as const, title: '合成专辑' }], ...request, sourceEpoch: calls.length <= 2 ? epochB : epochA, nextOffset: request.offset + 7, hasMore: true, complete: false }
  } } as unknown as import('../src/preload/api.js').MusicBridgePublicApi
  const search = useAggregatedSearch({ api, getZoneId: () => undefined, getScrollTop: () => 0, scrollTo: () => {}, classifyError: () => 'generic', onResetSearchOrigin: () => {}, onInvalidateRoonDetails: () => {} })
  t.after(() => search.dispose())
  search.searchQuery.value = '合成查询'
  search.roonSearchAlbums.value = { items: [{ reference: 'old', kind: 'album', title: '旧专辑' }], offset: 0, limit: 8, sourceEpoch: epochA, nextOffset: 7, hasMore: true, complete: false }
  await search.loadMoreSearchEntities('roon', 'album')
  await search.loadMoreSearchEntities('roon', 'album')
  assert.deepEqual(calls, [7, 0, 7])
  assert.equal(search.roonSearchAlbums.value.items.length, 1)
  assert.equal(search.roonSearchAlbums.value.sourceEpoch, epochB)
  assert.match(search.roonSearchError.value ?? '', /重新读取/u)
})
