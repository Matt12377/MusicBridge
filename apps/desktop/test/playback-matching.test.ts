import assert from 'node:assert/strict'
import test from 'node:test'

import type { DailyRecommendationTrack, PublicTrackMatchResult } from '@music-bridge/contracts'
import {
  SMART_MATCH_PRELOAD_LIMIT,
  SMART_MATCH_CLICK_WAIT_MS,
  createMatchRequestScheduler,
  confirmedRoonCandidate,
  settledMapWithConcurrency,
  immediatePlaybackSelection,
  nativeRoonQueueItemHasNeteaseIdentity,
  queuePreferenceForMatch,
  shouldPreloadSmartMatches,
  trackSummaryForMatching,
  tracksForInitialMatching,
  waitForMatchWithinPlaybackBudget,
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

test('Smart matching shares one concurrency bound across overlapping UI batches', async () => {
  let active = 0
  let maximumActive = 0
  const scheduler = createMatchRequestScheduler(async (value: number) => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    await new Promise((resolve) => setTimeout(resolve, 2))
    active -= 1
    return value * 10
  }, 2)

  const firstBatch = [1, 2, 3].map((value) => scheduler.schedule(value))
  const secondBatch = [4, 5, 6].map((value) => scheduler.schedule(value))

  assert.deepEqual(await Promise.all([...firstBatch, ...secondBatch]), [10, 20, 30, 40, 50, 60])
  assert.equal(maximumActive, 2)
})

test('Smart matching drops stale queued work before scheduling the current search', async () => {
  let releaseFirst!: () => void
  const started: number[] = []
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const scheduler = createMatchRequestScheduler(async (value: number) => {
    started.push(value)
    if (value === 1) await firstGate
    return value
  }, 1)

  const first = scheduler.schedule(1)
  const stale = scheduler.schedule(2).then(
    () => 'fulfilled',
    () => 'cancelled',
  )
  await Promise.resolve()
  scheduler.cancelPending()
  const current = scheduler.schedule(3)
  releaseFirst()

  assert.equal(await first, 1)
  assert.equal(await stale, 'cancelled')
  assert.equal(await current, 3)
  assert.deepEqual(started, [1, 3])
})

test('Smart matching strips recommendation and Roon-only fields before strict IPC', () => {
  const track: DailyRecommendationTrack = {
    id: '301',
    title: 'Synthetic Song',
    artists: ['Synthetic Artist'],
    album: 'Synthetic Album',
    durationMs: 240_000,
    artworkUrl: 'https://p1.music.126.net/synthetic-cover.jpg',
    artworkReference: 'roon-image:runtime-only',
    recommendationReason: 'synthetic recommendation',
  }

  assert.deepEqual(trackSummaryForMatching(track), {
    id: '301',
    title: 'Synthetic Song',
    artists: ['Synthetic Artist'],
    album: 'Synthetic Album',
    durationMs: 240_000,
    artworkUrl: 'https://p1.music.126.net/synthetic-cover.jpg',
  })
})

test('Smart matching preloads only the most relevant eight visible tracks', () => {
  const tracks = Array.from({ length: 12 }, (_, index) => ({
    id: String(index + 1),
    title: `Track ${index + 1}`,
    artists: ['Synthetic Artist'],
    album: 'Synthetic Album',
  }))

  assert.equal(SMART_MATCH_PRELOAD_LIMIT, 8)
  assert.deepEqual(
    tracksForInitialMatching(tracks).map((track) => track.id),
    ['1', '2', '3', '4', '5', '6', '7', '8'],
  )
})

test('Smart matching does not start Browse work before a real Zone is selected', () => {
  assert.equal(shouldPreloadSmartMatches(undefined), false)
  assert.equal(shouldPreloadSmartMatches(''), false)
  assert.equal(shouldPreloadSmartMatches('zone-1', false), false)
  assert.equal(shouldPreloadSmartMatches('zone-1'), true)
})

test('Smart playback waits at most the bounded click budget for an in-flight match', async () => {
  assert.equal(SMART_MATCH_CLICK_WAIT_MS, 300)
  assert.equal(
    await waitForMatchWithinPlaybackBudget(Promise.resolve(confirmed), 10),
    confirmed,
  )
  assert.equal(
    await waitForMatchWithinPlaybackBudget(Promise.reject(new Error('synthetic failure')), 10),
    undefined,
  )
  assert.equal(
    await waitForMatchWithinPlaybackBudget(new Promise(() => undefined), 2),
    undefined,
  )
})
