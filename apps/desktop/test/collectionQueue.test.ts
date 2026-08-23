import assert from 'node:assert/strict'
import test from 'node:test'
import type { Page, PageRequest, TrackSummary } from '@music-bridge/contracts'
import { loadCollectionTracks } from '../src/renderer/src/composables/collectionQueue.js'

function makePage(tracks: readonly TrackSummary[], page: PageRequest): Page<TrackSummary> {
  const items = tracks.slice(page.offset, page.offset + page.limit)
  return {
    items,
    offset: page.offset,
    limit: page.limit,
    total: tracks.length,
    hasMore: page.offset + page.limit < tracks.length,
  }
}

function tracks(count: number): TrackSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    id: String(8000 + index),
    title: `Track ${index + 1}`,
    artists: ['Artist'],
    album: 'Album',
  }))
}

test('collection queue loads all 45 tracks in provider order without requiring DOM rows', async () => {
  const source = tracks(45)
  const requests: PageRequest[] = []

  const result = await loadCollectionTracks(async (page) => {
    requests.push(page)
    return makePage(source, page)
  })

  assert.equal(result.length, 45)
  assert.deepEqual(result.map((track) => track.id), source.map((track) => track.id))
  assert.deepEqual(requests, [
    { offset: 0, limit: 20 },
    { offset: 20, limit: 20 },
    { offset: 40, limit: 20 },
  ])
})

test('collection queue loads 120 tracks and de-duplicates repeated provider items', async () => {
  const source = tracks(120)
  const repeated = [...source.slice(0, 20), source[19]!, ...source.slice(20)]
  const result = await loadCollectionTracks(async (page) => makePage(repeated, page))

  assert.equal(result.length, 120)
  assert.deepEqual(result.slice(0, 3).map((track) => track.id), ['8000', '8001', '8002'])
  assert.equal(new Set(result.map((track) => track.id)).size, 120)
})
