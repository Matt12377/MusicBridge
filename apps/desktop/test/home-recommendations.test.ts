import assert from 'node:assert/strict'
import test from 'node:test'

import type { PlaylistSummary, TrackSummary } from '@music-bridge/contracts'
import {
  HOME_RECOMMENDATION_PAGE_SIZE,
  HOME_RECOMMENDATION_TRACK_LIMIT,
  selectRandomPlaylistPages,
  shuffleTracks,
} from '../src/renderer/src/composables/homeRecommendations.js'

const playlists: readonly PlaylistSummary[] = [
  { id: 'empty', name: '空歌单', trackCount: 0 },
  { id: 'small', name: '短歌单', trackCount: 5 },
  { id: 'large', name: '长歌单', trackCount: 1200 },
]

test('homepage cover wall defaults to a dense but bounded recommendation set', () => {
  assert.equal(HOME_RECOMMENDATION_PAGE_SIZE, 12)
  assert.equal(HOME_RECOMMENDATION_TRACK_LIMIT, 24)
})

test('homepage samples bounded pages from non-empty playlists', () => {
  const selections = selectRandomPlaylistPages(playlists, 4, 8, () => 0.5)

  assert.deepEqual(
    selections.map((selection) => selection.playlistId).sort(),
    ['large', 'small'],
  )
  const smallSelection = selections.find((selection) => selection.playlistId === 'small')
  const largeSelection = selections.find((selection) => selection.playlistId === 'large')
  assert.deepEqual(smallSelection?.page.limit, 8)
  assert.equal(smallSelection?.page.offset, 0)
  assert.ok((largeSelection?.page.offset ?? 0) >= 0)
  assert.ok((largeSelection?.page.offset ?? 0) <= 1192)
})

test('homepage shuffles unique tracks and caps the cover wall', () => {
  const tracks: readonly TrackSummary[] = [
    { id: '1', title: '一', artists: ['甲'], album: 'A' },
    { id: '2', title: '二', artists: ['乙'], album: 'B' },
    { id: '1', title: '一（重复）', artists: ['甲'], album: 'A' },
    { id: '3', title: '三', artists: ['丙'], album: 'C' },
  ]

  const result = shuffleTracks(tracks, 2, () => 0)

  assert.equal(result.length, 2)
  assert.equal(new Set(result.map((track) => track.id)).size, 2)
  assert.ok(result.every((track) => ['1', '2', '3'].includes(track.id)))
})
