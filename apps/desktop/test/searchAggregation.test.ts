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
