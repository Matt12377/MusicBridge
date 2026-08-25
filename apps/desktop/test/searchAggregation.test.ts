import assert from 'node:assert/strict'
import test from 'node:test'
import type { AlbumSummary, ArtistSummary, Page, TrackSummary } from '@music-bridge/contracts'
import { createSearchSnapshotLoader } from '../src/renderer/src/composables/search.js'

const tracks: Page<TrackSummary> = { items: [{ id: '1', title: '青花瓷', artists: ['周杰伦'], album: '我很忙' }], offset: 0, limit: 10, total: 1, hasMore: false }
const artists: Page<ArtistSummary> = { items: [{ id: '7', name: '周杰伦' }], offset: 0, limit: 6, total: 1, hasMore: false }
const albums: Page<AlbumSummary> = { items: [{ id: '9', name: '我很忙', artistId: '7', artistName: '周杰伦' }], offset: 0, limit: 8, total: 1, hasMore: false }

test('search snapshot loads sections in parallel, keeps partial failures, and deduplicates same query', async () => {
  let artistCalls = 0
  const loader = createSearchSnapshotLoader({
    artists: async () => {
      artistCalls += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      return artists
    },
    tracks: async () => tracks,
    albums: async () => {
      throw new Error('album endpoint unavailable')
    },
  })

  const first = loader.load('青花瓷')
  const duplicate = loader.load('青花瓷')
  assert.strictEqual(first, duplicate)
  const result = await first
  assert.equal(artistCalls, 1)
  assert.deepEqual(result.artists, { state: 'ready', page: artists })
  assert.deepEqual(result.tracks, { state: 'ready', page: tracks })
  assert.deepEqual(result.albums, { state: 'error', message: 'album endpoint unavailable' })
})

test('search snapshot generation prevents an older query from replacing a newer one', async () => {
  let releaseFirst: (() => void) | undefined
  const loader = createSearchSnapshotLoader({
    artists: async (query) => {
      if (query === '旧查询') await new Promise<void>((resolve) => { releaseFirst = resolve })
      return artists
    },
    tracks: async () => tracks,
    albums: async () => albums,
  })
  const stale = loader.load('旧查询')
  const fresh = loader.load('新查询')
  releaseFirst?.()
  assert.equal((await stale).stale, true)
  assert.equal((await fresh).stale, false)
  assert.equal((await fresh).query, '新查询')
})

test('search snapshot cache is bounded and reuses the most recent query', async () => {
  let calls = 0
  const loader = createSearchSnapshotLoader({
    artists: async () => { calls += 1; return artists },
    tracks: async () => tracks,
    albums: async () => albums,
  }, { cacheSize: 1 })
  await loader.load('一')
  await loader.load('二')
  await loader.load('二')
  assert.equal(calls, 2)
  await loader.load('一')
  assert.equal(calls, 3)
})

test('失败的搜索快照不会进入缓存，同一查询可在 Core 恢复后重试', async () => {
  let coreReady = false
  const recover = <T>(page: Page<T>) => async () => {
    if (!coreReady) throw Object.assign(new Error('Core request failed'), { code: 'INTERNAL_ERROR' })
    return page
  }
  const loader = createSearchSnapshotLoader({
    artists: recover(artists),
    tracks: recover(tracks),
    albums: recover(albums),
  })

  const failed = await loader.load('红豆')
  assert.equal(failed.artists.state, 'error')
  assert.equal(failed.tracks.state, 'error')
  assert.equal(failed.albums.state, 'error')

  coreReady = true
  const recovered = await loader.load('红豆')
  assert.deepEqual(recovered.artists, { state: 'ready', page: artists })
  assert.deepEqual(recovered.tracks, { state: 'ready', page: tracks })
  assert.deepEqual(recovered.albums, { state: 'ready', page: albums })
})

test('搜索错误隐藏 Electron IPC 细节并保留可操作的登录语义', async () => {
  const loader = createSearchSnapshotLoader({
    artists: async () => {
      throw new Error("Error invoking remote method 'library:search-artists': PublicIpcError: Provider login required")
    },
    tracks: async () => {
      throw new Error("Error invoking remote method 'library:search': PublicIpcError: Core request failed")
    },
    albums: async () => {
      throw new Error("Error invoking remote method 'library:search-albums': PublicIpcError: Provider session expired")
    },
  })

  const result = await loader.load('红豆')
  assert.deepEqual(result.artists, { state: 'error', message: '请先登录音乐服务，再搜索内容。' })
  assert.deepEqual(result.tracks, { state: 'error', message: '搜索分区暂时不可用，请检查连接状态。' })
  assert.deepEqual(result.albums, { state: 'error', message: '登录已过期，请重新登录后再搜索。' })
})

test('search snapshot turns a missing Provider credential into an actionable message', async () => {
  const loader = createSearchSnapshotLoader({
    artists: async () => { throw new Error('Provider login required') },
    tracks: async () => { throw new Error('Provider login required') },
    albums: async () => { throw new Error('Provider login required') },
  })

  const result = await loader.load('青花瓷')
  assert.deepEqual(result.artists, { state: 'error', message: '请先登录音乐服务，再搜索内容。' })
  assert.deepEqual(result.tracks, { state: 'error', message: '请先登录音乐服务，再搜索内容。' })
  assert.deepEqual(result.albums, { state: 'error', message: '请先登录音乐服务，再搜索内容。' })
})
