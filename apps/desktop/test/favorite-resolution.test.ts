import assert from 'node:assert/strict'
import test from 'node:test'
import type { FavoriteRecord, RoonLibraryItem } from '@music-bridge/contracts'
import { matchesFavorite, resolveFavorite } from '../src/renderer/src/composables/favoriteResolution.js'
import { hasNoAlbums } from '../src/renderer/src/composables/artistVisibility.js'

const record: FavoriteRecord = { favoriteId: 'saved', createdAt: 1, updatedAt: 1, kind: 'album', title: '测试专辑', subtitle: '甲艺人' }
const album: RoonLibraryItem = { reference: 'fresh', kind: 'album', title: '测试专辑', subtitle: '甲艺人', artworkReference: 'fresh-art' }

test('收藏从当前会话恢复封面与引用，按艺人排除同名专辑', async () => {
  assert.equal(matchesFavorite(record, { ...album, subtitle: '乙艺人' }), false)
  assert.deepEqual(await resolveFavorite(record, async (_query, page) => ({ ...page, items: [album], hasMore: false })), { state: 'ready', item: album })
})

test('收藏检查后续分页，重名版本不自动打开；失联和网络错误保留记录', async () => {
  const calls: number[] = []
  const ambiguous = await resolveFavorite(record, async (_query, page) => {
    calls.push(page.offset)
    return { ...page, items: [{ ...album, reference: String(page.offset) }], hasMore: page.offset === 0 }
  })
  assert.equal(ambiguous.state, 'ambiguous')
  assert.deepEqual(calls, [0, 100])
  assert.equal((await resolveFavorite(record, async (_q, page) => ({ ...page, items: [], hasMore: false }))).state, 'missing')
  assert.equal((await resolveFavorite(record, async () => { throw Error('离线') })).state, 'error')
})

test('歌曲收藏可从专辑恢复曲目与继承封面，不依赖缺少专辑信息的全局搜索', async () => {
  const track: FavoriteRecord = { ...record, kind: 'track', title: '第二首', artist: '甲艺人', album: '测试专辑', trackNumber: 2 }
  const result = await resolveFavorite(track, async (query, page, kind) => {
    assert.equal(query, '测试专辑'); assert.equal(kind, 'album')
    return { ...page, items: [album], hasMore: false }
  }, undefined, async (_reference, page) => ({ ...page, items: [{ reference: 'track-new', kind: 'track', title: '第二首', trackNumber: 2 }], hasMore: false }))
  assert.equal(result.state, 'ready')
  if (result.state === 'ready') { assert.equal(result.item.artworkReference, 'fresh-art'); assert.equal(result.item.album, '测试专辑') }
})

test('停止解析后不继续请求，结果超过扫描界限不误判唯一', async () => {
  let calls = 0
  assert.equal((await resolveFavorite(record, async (_q, page) => { calls++; return { ...page, items: [], hasMore: true } })).state, 'error')
  assert.equal(calls, 10)
  await resolveFavorite(record, async () => { throw Error('不应调用') }, () => false)
})

test('仅过滤明确零专辑艺人，不把未知数量和 10 专辑当成零', () => {
  for (const subtitle of ['0 albums', '0 Albums · 3 tracks', '0 张专辑', '0 專輯']) assert.equal(hasNoAlbums({ kind: 'artist', subtitle }), true)
  for (const subtitle of [undefined, '10 albums', '艺人']) assert.equal(hasNoAlbums({ kind: 'artist', subtitle }), false)
  assert.equal(hasNoAlbums({ kind: 'artist', albumCount: 0 }), true)
  assert.equal(hasNoAlbums({ kind: 'artist', albumCount: 2, subtitle: '0 albums' }), false)
  assert.equal(hasNoAlbums({ kind: 'album', subtitle: '0 albums' }), false)
})
