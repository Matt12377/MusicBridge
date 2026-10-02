import assert from 'node:assert/strict'
import test from 'node:test'
import type { RoonLibraryPage } from '@music-bridge/contracts'
import type { MusicBridgePublicApi } from '../src/preload/api.js'
import { useRoonBrowse } from '../src/renderer/src/composables/application/useRoonBrowse.js'
const epochA = '00000000-0000-4000-8000-000000000001', epochB = '00000000-0000-4000-8000-000000000002'
function page(offset: number, sourceEpoch = epochA): RoonLibraryPage {
  return { items: [{ reference: `track:${sourceEpoch}:${offset}`, kind: 'track', title: '合成曲目' }], offset, limit: 24, sourceEpoch, complete: false, nextOffset: offset + 7, hasMore: true }
}
function harness(read: (reference: string, request: { offset: number; limit: number }) => Promise<RoonLibraryPage>, apiOverrides: Partial<MusicBridgePublicApi> = {}) {
  const api = { getRoonAlbumTracks: read, getRoonArtistAlbums: read, getRoonGenreItems: read, getRoonPlaylistTracks: read, ...apiOverrides } as unknown as MusicBridgePublicApi
  return useRoonBrowse({ api, formatError: () => '合成读取失败', getView: () => 'roon-album-detail', onDetailOpening: () => {}, onDetailReady: () => {}, onNavigateSource: () => {}, onPlayTrack: () => {}, onError: () => {}, onToast: () => {} })
}
test('当前收藏读取被取消时显示错误，不伪报空收藏', async t => {
  const browse = harness(async (_reference, request) => page(request.offset), {
    listFavorites: async () => { throw Object.assign(new Error('合成读取取消'), { code: 'CANCELLED' }) },
  })
  t.after(() => browse.dispose())
  await browse.loadFavorites('album')
  assert.equal(browse.favoritesInitialLoading.value, false)
  assert.equal(browse.favoritesError.value, '合成读取失败')
})
for (const kind of ['Album', 'Artist', 'Genre', 'Playlist'] as const) {
  test(`当前${kind}详情读取被取消时显示错误，重新读取可恢复`, async t => {
    let cancelled = true
    const browse = harness(async (_reference, request) => {
      if (cancelled) throw Object.assign(new Error('合成读取取消'), { code: 'CANCELLED' })
      return page(request.offset)
    })
    t.after(() => browse.dispose())
    await browse[`loadRoon${kind}`]('album')
    assert.equal(browse[`roon${kind}InitialLoading`].value, false)
    assert.equal(browse[`roon${kind}Error`].value, '合成读取失败')
    cancelled = false
    await browse[`loadRoon${kind}`]('album')
    assert.equal(browse[`roon${kind}Error`].value, null)
    assert.equal(browse[`selectedRoon${kind}Page`].value.items.length, 1)
  })
  test(`MBP004：${kind}详情混代只重读第一页一次，错误页不混入`, async t => {
    const calls: number[] = []; let starts = 0
    const browse = harness(async (_reference, request) => {
      calls.push(request.offset)
      if (request.offset === 0) starts++
      return page(request.offset, request.offset === 0 ? (starts === 1 ? epochA : epochB) : (starts === 1 ? epochB : epochA))
    })
    t.after(() => browse.dispose())
    await browse[`loadRoon${kind}`]('album')
    await browse[`loadRoon${kind}`]('album', { offset: 7, limit: 24 })
    await browse[`loadRoon${kind}`]('album', { offset: 7, limit: 24 })
    assert.deepEqual(calls, [0, 7, 0, 7])
    assert.equal(browse[`selectedRoon${kind}Page`].value.items.length, 1)
    assert.equal(browse[`selectedRoon${kind}Page`].value.sourceEpoch, epochB)
    assert.match(browse[`roon${kind}LoadMoreError`].value ?? '', /重新读取/u)
  })
}
test('MBP004：详情返回父页保留未完成offset与epoch，旧回执不回填', async t => {
  let release!: (page: RoonLibraryPage) => void
  const pending = new Promise<RoonLibraryPage>(resolve => { release = resolve })
  const calls: number[] = []
  const browse = harness(async (_reference, request) => {
    calls.push(request.offset)
    if (calls.length === 2) return pending
    return page(request.offset)
  })
  t.after(() => browse.dispose())
  await browse.loadRoonAlbum('album')
  const old = browse.loadRoonAlbum('album', { offset: 7, limit: 24 })
  await new Promise(resolve => setImmediate(resolve))
  const saved = browse.captureDetail()
  browse.leaveDetail(); browse.restoreDetail(saved); browse.resumeDetail('roon-album-detail')
  await new Promise(resolve => setImmediate(resolve))
  release(page(7, epochB)); await old
  assert.deepEqual(calls, [0, 7, 7])
  assert.equal(browse.selectedRoonAlbumPage.value.sourceEpoch, epochA)
  assert.equal(browse.selectedRoonAlbumPage.value.items.length, 2)
})

test('MBP004：已知失效的父详情缓存恢复目标而重读0，不继续旧第N页', async t => {
  const calls: number[] = []; let old = true
  const browse = harness(async (_reference, request) => { calls.push(request.offset); return page(request.offset, old ? epochA : epochB) })
  t.after(() => browse.dispose())
  await browse.loadRoonAlbum('album')
  const saved = browse.captureDetail()
  old = false
  await browse.loadRoonAlbum('album', { offset: 7, limit: 24 })
  browse.restoreDetail(saved)
  assert.equal(browse.selectedRoonAlbumPage.value.items.length, 0)
  browse.resumeDetail('roon-album-detail')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, [0, 7, 0, 0])
  assert.equal(browse.selectedRoonAlbumPage.value.sourceEpoch, epochB)
})
