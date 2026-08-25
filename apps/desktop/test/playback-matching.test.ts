import assert from 'node:assert/strict'
import test from 'node:test'

import type { PublicTrackMatchResult } from '@music-bridge/contracts'
import {
  confirmedRoonCandidate,
  settledMapWithConcurrency,
  immediatePlaybackSelection,
  nativeRoonQueueItemHasNeteaseIdentity,
  queuePreferenceForMatch,
} from '../src/renderer/src/composables/playbackMatching.js'

const confirmed: PublicTrackMatchResult = {
  trackId: '1',
  state: 'CONFIRMED',
  confidence: 0.95,
  evidence: ['title-exact', 'artist-exact'],
  candidates: [],
  candidate: {
    reference: 'musicbridge-v2-entity-confirmed',
    kind: 'track',
    title: 'Local Track',
    artist: 'Local Artist',
  },
  algorithmVersion: 'logical-recording-v1',
}

test('V1 immediate playback stays on Provider until a cached Roon match is confirmed', () => {
  assert.deepEqual(immediatePlaybackSelection(undefined, 'zone-1'), { source: 'netease' })
  assert.deepEqual(immediatePlaybackSelection({ ...confirmed, state: 'POSSIBLE' }, 'zone-1'), { source: 'netease' })
  assert.deepEqual(immediatePlaybackSelection(confirmed, undefined), { source: 'netease' })
  assert.deepEqual(immediatePlaybackSelection(confirmed, 'zone-1'), {
    source: 'roon',
    candidate: confirmed.candidate,
    zoneId: 'zone-1',
  })
})

test('mixed queues request Smart only for a match already confirmed in the Core cache', () => {
  assert.equal(queuePreferenceForMatch(undefined), 'netease')
  assert.equal(queuePreferenceForMatch({ ...confirmed, state: 'POSSIBLE' }), 'netease')
  assert.equal(queuePreferenceForMatch(confirmed), 'smart')
  assert.equal(confirmedRoonCandidate(confirmed), confirmed.candidate)
})

test('a Smart queue item keeps its NetEase identity during native Roon playback', () => {
  assert.equal(nativeRoonQueueItemHasNeteaseIdentity(undefined, false), false)
  assert.equal(nativeRoonQueueItemHasNeteaseIdentity({
    trackId: '1',
    qualityPreference: 'auto',
    preferredSource: 'smart',
  }, false), true)
  assert.equal(nativeRoonQueueItemHasNeteaseIdentity({
    trackId: '2',
    qualityPreference: 'auto',
    preferredSource: 'roon',
  }, true), true)
})

test('Roon matching keeps Browse concurrency bounded and preserves result order', async () => {
  let active = 0
  let maximumActive = 0
  const results = await settledMapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (value) => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    await new Promise((resolve) => setTimeout(resolve, 2))
    active -= 1
    if (value === 4) throw new Error('synthetic match failure')
    return value * 10
  })

  assert.equal(maximumActive, 3)
  assert.deepEqual(results.map((result) => (
    result.status === 'fulfilled' ? result.value : 'rejected'
  )), [10, 20, 30, 'rejected', 50, 60, 70])
})
