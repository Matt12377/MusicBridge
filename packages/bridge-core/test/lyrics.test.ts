import assert from 'node:assert/strict'
import test from 'node:test'

import type { LyricsSnapshot, PlaybackSnapshot } from '@music-bridge/contracts'
import { NeteaseClient } from '../src/netease/client.js'
import { parseLyricsResponse } from '../src/netease/lyrics.js'
import { LyricsMatchResolver } from '../src/lyrics-matching/resolver.js'
import { createLyricsMatchRepository } from '../src/lyrics-matching/repository.js'
import { LocalLyricsManualMatchController } from '../src/lyrics-matching/manual-controller.js'
import {
  LyricsCoordinator,
  createLyricsRequestContext,
} from '../src/lyrics/coordinator.js'

function response(body: Record<string, unknown>): unknown {
  return { body: { code: 200, ...body } }
}

function readySnapshot(text: string): LyricsSnapshot {
  return {
    status: 'ready',
    lines: [{ startMs: 0, text }],
    activeLineIndex: -1,
    timingSource: 'static',
  }
}

function playing(trackId: string): PlaybackSnapshot {
  return {
    state: 'playing',
    queue: {
      items: [{ trackId, qualityPreference: 'standard' }],
      index: 0,
      hasNext: false,
      hasPrevious: false,
    },
    currentTrack: {
      id: trackId,
      title: 'Synthetic Track',
      artists: ['Synthetic Artist'],
      album: 'Synthetic Album',
    },
    positionMs: 0,
    canNext: false,
    canPrevious: false,
    canStop: true,
    canPause: true,
    canResume: false,
  }
}

test('lyrics parser accepts LRC with translation, romanization, ordering and duplicates', () => {
  const snapshot = parseLyricsResponse(response({
    lrc: {
      lyric: '[00:03.00]third\n[00:01.00]first\n[00:01.00]first\n[00:02.00]second',
    },
    tlyric: { lyric: '[00:01.00]translated first\n[00:02.00]translated second' },
    romalrc: { lyric: '[00:01.00]romanized first' },
    ignoredProviderField: { cookie: 'must-not-escape' },
  }))

  assert.equal(snapshot.status, 'ready')
  assert.deepEqual(snapshot.lines, [
    { startMs: 1_000, endMs: 2_000, text: 'first', translation: 'translated first', romanization: 'romanized first' },
    { startMs: 2_000, endMs: 3_000, text: 'second', translation: 'translated second' },
    { startMs: 3_000, text: 'third' },
  ])
  assert.equal(snapshot.timingSource, 'static')
  assert.equal(snapshot.activeLineIndex, -1)
  assert.equal('ignoredProviderField' in snapshot, false)
})

test('lyrics parser preserves actual YRC word timing and clamps malformed words', () => {
  const snapshot = parseLyricsResponse(response({
    yrc: { lyric: '[100,1000](100,400,0)hel(500,600,0)lo' },
  }))

  assert.equal(snapshot.status, 'ready')
  assert.deepEqual(snapshot.lines, [{
    startMs: 100,
    endMs: 1_100,
    text: 'hello',
    words: [
      { startMs: 100, endMs: 500, text: 'hel' },
      { startMs: 500, endMs: 1_100, text: 'lo' },
    ],
  }])
})

test('lyrics parser treats YRC word timestamps as absolute song time', () => {
  const snapshot = parseLyricsResponse(response({
    yrc: { lyric: '[1000,1000](1000,400,0)ab(1400,600,0)cd' },
  }))

  assert.deepEqual(snapshot.lines, [{
    startMs: 1_000,
    endMs: 2_000,
    text: 'abcd',
    words: [
      { startMs: 1_000, endMs: 1_400, text: 'ab' },
      { startMs: 1_400, endMs: 2_000, text: 'cd' },
    ],
  }])
})

test('lyrics parser preserves spaces between English and mixed-language YRC words', () => {
  const snapshot = parseLyricsResponse(response({
    yrc: { lyric: '[100,1000](100,300,0)Hello (400,300,0)世界 (800,200,0)world' },
  }))

  assert.deepEqual(snapshot.lines, [{
    startMs: 100,
    endMs: 1_100,
    text: 'Hello 世界 world',
    words: [
      { startMs: 100, endMs: 400, text: 'Hello ' },
      { startMs: 400, endMs: 700, text: '世界 ' },
      { startMs: 800, endMs: 1_000, text: 'world' },
    ],
  }])
})

test('lyrics parser accepts the yromalrc romanization field alongside romalrc', () => {
  const snapshot = parseLyricsResponse(response({
    lrc: { lyric: '[00:01.00]原文' },
    yromalrc: { lyric: '[00:01.00]yuanwen' },
  }))

  assert.deepEqual(snapshot.lines, [{
    startMs: 1_000,
    text: '原文',
    romanization: 'yuanwen',
  }])
})

test('lyrics parser distinguishes instrumental, unavailable, malformed and oversized payloads', () => {
  assert.equal(parseLyricsResponse(response({ pureMusic: true })).status, 'instrumental')
  assert.equal(parseLyricsResponse(response({ lrc: { lyric: '' } })).status, 'unavailable')
  assert.equal(parseLyricsResponse(response({ lrc: { lyric: '[bad]not timed' } })).status, 'unavailable')
  assert.equal(
    parseLyricsResponse(response({ lrc: { lyric: 'x'.repeat(600_000) } })).status,
    'unavailable',
  )
})

test('NeteaseClient calls only the pinned lyric_new capability and returns a public snapshot', async () => {
  let requestedId = ''
  const client = new NeteaseClient('synthetic-credential', {
    async song_detail() { return { body: { code: 200 } } },
    async song_url_v1() { return { body: { code: 200 } } },
    async login_qr_key() { return { body: { code: 200, data: { unikey: 'synthetic-key' } } } },
    async login_qr_create() { return { body: { code: 200, data: { qrimg: 'data:image/png;base64,synthetic' } } } },
    async login_qr_check() { return { body: { code: 801 } } },
    async login_status() { return { body: { data: { code: 200, profile: {} } } } },
    async logout() { return { body: { code: 200 } } },
    async lyric_new(params) {
      requestedId = String(params.id)
      return response({ lrc: { lyric: '[00:01.00]synthetic lyric' } })
    },
  })

  const snapshot = await client.getLyrics('303')
  assert.equal(requestedId, '303')
  assert.equal(snapshot.status, 'ready')
  assert.equal(snapshot.lines[0]?.text, 'synthetic lyric')
  assert.equal('rawProviderResponse' in snapshot, false)
})

test('lyrics coordinator prevents stale track results from replacing the active track', async () => {
  const resolvers = new Map<string, (snapshot: LyricsSnapshot) => void>()
  const changes: LyricsSnapshot[] = []
  let now = 0
  const coordinator = new LyricsCoordinator({
    now: () => now,
    load: (trackId) => new Promise((resolve) => resolvers.set(trackId, resolve)),
    onChange: (snapshot) => changes.push(snapshot),
  })

  coordinator.onPlaybackChanged(playing('101'))
  coordinator.onPlaybackChanged(playing('202'))
  resolvers.get('101')?.(readySnapshot('stale'))
  resolvers.get('202')?.(readySnapshot('current'))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(changes.at(-1)?.lines[0]?.text, 'current')
  assert.equal(coordinator.getSnapshot().lines[0]?.text, 'current')
})

test('lyrics request context distinguishes NetEase, Smart-to-Roon and direct Roon identity', () => {
  const directNetease = createLyricsRequestContext({
    ...playing('101'),
    source: 'netease',
  }, 7)
  assert.deepEqual(directNetease, {
    kind: 'netease',
    playbackGeneration: 7,
    cacheKey: 'netease:101',
    neteaseTrackId: '101',
  })

  const smartRoon = createLyricsRequestContext({
    ...playing('runtime-smart-id'),
    source: 'roon',
    currentTrack: {
      id: 'runtime-smart-id',
      title: '归零',
      artists: ['林忆莲'],
      album: '0',
      durationMs: 271_000,
      version: 'Original',
    },
    queue: {
      items: [{
        trackId: '202',
        qualityPreference: 'lossless',
        preferredSource: 'smart',
        resolvedSource: 'roon',
      }],
      index: 0,
      hasNext: false,
      hasPrevious: false,
    },
  }, 8)
  assert.equal(smartRoon?.kind, 'local')
  if (smartRoon?.kind !== 'local') assert.fail('expected local lyrics context')
  assert.equal(smartRoon.trustedNeteaseTrackId, '202')
  assert.equal(smartRoon.signature.canonical.version, 'original')
  assert.equal(JSON.stringify(smartRoon).includes('runtime-smart-id'), false)

  const directRoon = createLyricsRequestContext({
    ...playing('runtime-local-id'),
    source: 'roon',
    currentTrack: {
      id: 'runtime-local-id',
      title: 'Local Song',
      artists: ['Local Artist'],
      album: 'Local Album',
      durationMs: 180_000,
    },
    queue: {
      items: [{
        trackId: '999',
        qualityPreference: 'auto',
        preferredSource: 'roon',
        resolvedSource: 'roon',
      }],
      index: 0,
      hasNext: false,
      hasPrevious: false,
    },
  }, 9)
  assert.equal(directRoon?.kind, 'local')
  if (directRoon?.kind !== 'local') assert.fail('expected local lyrics context')
  assert.equal(directRoon.trustedNeteaseTrackId, undefined)
  assert.equal(JSON.stringify(directRoon).includes('runtime-local-id'), false)

  const malformedRoon = createLyricsRequestContext({
    ...playing('777777'),
    source: 'roon',
    currentTrack: {
      id: '777777',
      title: 'Local Song',
      artists: [],
      album: 'Local Album',
    },
    queue: {
      items: [{ trackId: '777777', qualityPreference: 'auto', preferredSource: 'roon' }],
      index: 0,
      hasNext: false,
      hasPrevious: false,
    },
  }, 10)
  assert.deepEqual(malformedRoon, {
    kind: 'unavailable',
    playbackGeneration: 10,
    cacheKey: 'unavailable:10',
  })
})

test('an un-signable Roon track fails lyrics closed without calling either NetEase path', async () => {
  let directLoads = 0
  let resolverCalls = 0
  const snapshot: PlaybackSnapshot = {
    ...playing('777777'),
    source: 'roon',
    currentTrack: { id: '777777', title: 'Local Song', artists: [], album: 'Local Album' },
    queue: {
      items: [{ trackId: '777777', qualityPreference: 'auto', preferredSource: 'roon' }],
      index: 0,
      hasNext: false,
      hasPrevious: false,
    },
  }
  const coordinator = new LyricsCoordinator({
    async load() {
      directLoads += 1
      return readySnapshot('unsafe direct load')
    },
    localResolver: {
      async resolveActive() {
        resolverCalls += 1
        return { status: 'unavailable', applied: true } as never
      },
      cancelActive() {},
    },
  })

  coordinator.onPlaybackChanged(snapshot, createLyricsRequestContext(snapshot, 10))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(coordinator.getSnapshot().status, 'unavailable')
  assert.equal(directLoads, 0)
  assert.equal(resolverCalls, 0)
})

test('local playback reaches playing while lyrics resolve asynchronously and never loads the Roon runtime id', async () => {
  const changes: LyricsSnapshot[] = []
  const loadedTrackIds: string[] = []
  let resolveLocal: ((value: unknown) => void) | undefined
  const localResolver = {
    resolveActive: () => new Promise((resolve) => { resolveLocal = resolve }),
    cancelActive: () => undefined,
  }
  const snapshot: PlaybackSnapshot = {
    ...playing('987654321'),
    source: 'roon',
    currentTrack: {
      id: '987654321',
      title: '归零',
      artists: ['林忆莲'],
      album: '0',
      durationMs: 271_000,
    },
    queue: {
      items: [{
        trackId: '987654321',
        qualityPreference: 'auto',
        preferredSource: 'roon',
        resolvedSource: 'roon',
      }],
      index: 0,
      hasNext: false,
      hasPrevious: false,
    },
  }
  const coordinator = new LyricsCoordinator({
    load: async (trackId) => {
      loadedTrackIds.push(trackId)
      return readySnapshot('wrong path')
    },
    localResolver: localResolver as never,
    onChange: (value) => changes.push(value),
  })

  coordinator.onPlaybackChanged(snapshot, createLyricsRequestContext(snapshot, 11))
  assert.equal(snapshot.state, 'playing')
  assert.equal(changes.at(-1)?.status, 'loading')
  assert.deepEqual(loadedTrackIds, [])

  resolveLocal?.({
    status: 'resolved',
    applied: true,
    lyrics: readySnapshot('matched local lyric'),
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(changes.at(-1)?.lines[0]?.text, 'matched local lyric')
  assert.equal(changes.at(-1)?.source, 'netease')
  assert.deepEqual(loadedTrackIds, [])
})

test('Smart-to-Roon playback resolves lyrics through the original NetEase identity and stable signature', async () => {
  const requestedLyricsIds: string[] = []
  let searchCalls = 0
  const repository = createLyricsMatchRepository()
  const resolver = new LyricsMatchResolver({
    provider: {
      configured: true,
      async searchTracks() {
        searchCalls += 1
        return { items: [], offset: 0, limit: 20, total: 0, hasMore: false }
      },
      async getLyrics(trackId) {
        requestedLyricsIds.push(trackId)
        return readySnapshot('trusted smart lyric')
      },
    },
    repository,
  })
  const snapshot: PlaybackSnapshot = {
    ...playing('987654321'),
    source: 'roon',
    currentTrack: {
      id: '987654321',
      title: '归零',
      artists: ['林忆莲'],
      album: '0',
      durationMs: 271_000,
    },
    queue: {
      items: [{
        trackId: '202',
        qualityPreference: 'lossless',
        preferredSource: 'smart',
        resolvedSource: 'roon',
      }],
      index: 0,
      hasNext: false,
      hasPrevious: false,
    },
  }
  const context = createLyricsRequestContext(snapshot, 13)
  assert.equal(context?.kind, 'local')
  const coordinator = new LyricsCoordinator({
    load: async () => readySnapshot('wrong direct path'),
    localResolver: resolver,
  })

  coordinator.onPlaybackChanged(snapshot, context)
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(requestedLyricsIds, ['202'])
  assert.equal(searchCalls, 0)
  assert.equal(coordinator.getSnapshot().lines[0]?.text, 'trusted smart lyric')
  const records = await repository.listBounded(0, 10)
  assert.equal(records.length, 1)
  assert.equal(records[0]?.neteaseTrackId, '202')
  assert.equal(JSON.stringify(records).includes('987654321'), false)
})

test('local lyrics cache follows the stable recording signature across Roon runtime id changes', async () => {
  let resolverCalls = 0
  const coordinator = new LyricsCoordinator({
    load: async () => readySnapshot('unused'),
    localResolver: {
      async resolveActive() {
        resolverCalls += 1
        return {
          status: 'resolved',
          applied: true,
          lyrics: readySnapshot('stable cached lyric'),
        } as never
      },
      cancelActive() {},
    },
  })
  const localPlayback = (runtimeId: string): PlaybackSnapshot => ({
    ...playing(runtimeId),
    source: 'roon',
    currentTrack: {
      id: runtimeId,
      title: 'Same Local Song',
      artists: ['Same Artist'],
      album: 'Same Album',
      durationMs: 200_000,
    },
    queue: {
      items: [{ trackId: runtimeId, qualityPreference: 'auto', preferredSource: 'roon' }],
      index: 0,
      hasNext: false,
      hasPrevious: false,
    },
  })
  const first = localPlayback('111111')
  coordinator.onPlaybackChanged(first, createLyricsRequestContext(first, 21))
  await new Promise((resolve) => setImmediate(resolve))
  coordinator.onPlaybackChanged({
    ...first,
    state: 'idle',
    canStop: false,
    canPause: false,
  })

  const second = localPlayback('222222')
  coordinator.onPlaybackChanged(second, createLyricsRequestContext(second, 22))

  assert.equal(resolverCalls, 1)
  assert.equal(coordinator.getSnapshot().lines[0]?.text, 'stable cached lyric')
  assert.equal(coordinator.getSnapshot().source, 'netease')
})

test('an unavailable local resolution is not promoted beyond the resolver negative-cache policy', async () => {
  let resolverCalls = 0
  const coordinator = new LyricsCoordinator({
    load: async () => readySnapshot('unused'),
    localResolver: {
      async resolveActive() {
        resolverCalls += 1
        return resolverCalls === 1
          ? {
              status: 'unavailable',
              applied: true,
              lyrics: { status: 'unavailable', lines: [], activeLineIndex: -1, timingSource: 'static' },
            } as never
          : {
              status: 'resolved',
              applied: true,
              lyrics: readySnapshot('available on retry'),
            } as never
      },
      cancelActive() {},
    },
  })
  const localPlayback = (generation: number): PlaybackSnapshot => ({
    ...playing('333333'),
    source: 'roon',
    currentTrack: {
      id: '333333',
      title: 'Retry Local Song',
      artists: ['Retry Artist'],
      album: 'Retry Album',
      durationMs: 210_000,
    },
    queue: {
      items: [{ trackId: '333333', qualityPreference: 'auto', preferredSource: 'roon' }],
      index: 0,
      hasNext: false,
      hasPrevious: false,
    },
    positionMs: generation,
  })

  const first = localPlayback(31)
  coordinator.onPlaybackChanged(first, createLyricsRequestContext(first, 31))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(coordinator.getSnapshot().status, 'unavailable')
  coordinator.onPlaybackChanged({ ...first, state: 'idle', canStop: false, canPause: false })

  const second = localPlayback(32)
  coordinator.onPlaybackChanged(second, createLyricsRequestContext(second, 32))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(resolverCalls, 2)
  assert.equal(coordinator.getSnapshot().lines[0]?.text, 'available on retry')
})

test('stopped local playback rejects a late resolver result without mutating playback', async () => {
  const changes: LyricsSnapshot[] = []
  let cancellations = 0
  let resolveLocal: ((value: unknown) => void) | undefined
  const coordinator = new LyricsCoordinator({
    load: async () => readySnapshot('unused'),
    localResolver: {
      resolveActive: () => new Promise((resolve) => { resolveLocal = resolve }),
      cancelActive: () => { cancellations += 1 },
    } as never,
    onChange: (value) => changes.push(value),
  })
  const snapshot: PlaybackSnapshot = {
    ...playing('303030'),
    source: 'roon',
    currentTrack: {
      id: '303030',
      title: 'Local Song',
      artists: ['Local Artist'],
      album: 'Local Album',
    },
    queue: {
      items: [{ trackId: '303030', qualityPreference: 'auto', preferredSource: 'roon' }],
      index: 0,
      hasNext: false,
      hasPrevious: false,
    },
  }
  coordinator.onPlaybackChanged(snapshot, createLyricsRequestContext(snapshot, 12))
  const { currentTrack: _currentTrack, ...stoppedSnapshot } = snapshot
  coordinator.onPlaybackChanged({
    ...stoppedSnapshot,
    state: 'idle',
    canStop: false,
    canPause: false,
  })
  resolveLocal?.({ status: 'resolved', applied: true, lyrics: readySnapshot('stale') })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(cancellations > 0, true)
  assert.equal(changes.at(-1)?.status, 'idle')
  assert.equal(changes.some((value) => value.lines[0]?.text === 'stale'), false)
  assert.equal(snapshot.state, 'playing')
})

test('NetEase source is exposed only for ready or instrumental snapshots', async () => {
  for (const status of ['ready', 'instrumental', 'unavailable', 'error'] as const) {
    const coordinator = new LyricsCoordinator({
      load: async () => status === 'ready'
        ? readySnapshot('source')
        : { status, lines: [], activeLineIndex: -1, timingSource: 'static' },
    })
    const result = await coordinator.getLyrics('404')
    assert.equal(result.source, status === 'ready' || status === 'instrumental' ? 'netease' : undefined)
    assert.equal('confidence' in result, false)
    assert.equal('evidence' in result, false)
  }
})

test('lyrics coordinator pushes active-line changes immediately inside the word throttle window', () => {
  const changes: LyricsSnapshot[] = []
  let now = 0
  const coordinator = new LyricsCoordinator({
    now: () => now,
    load: async () => readySnapshot('unused'),
    onChange: (snapshot) => changes.push(snapshot),
  })
  const snapshot: LyricsSnapshot = {
    status: 'ready',
    lines: [
      { startMs: 0, endMs: 1_000, text: 'one' },
      { startMs: 1_000, text: 'two' },
    ],
    activeLineIndex: -1,
    timingSource: 'static',
  }

  coordinator.setActiveLyrics('101', snapshot)
  now = 250
  coordinator.updateRoonTime(500)
  const afterFirstLine = changes.length
  now = 260
  coordinator.updateRoonTime(1_000)

  assert.equal(changes.length, afterFirstLine + 1)
  assert.equal(changes.at(-1)?.activeLineIndex, 1)
  assert.equal(changes.at(-1)?.timingSource, 'roon-time')
})

test('lyrics coordinator bounds active-word updates to one hundred milliseconds', () => {
  const changes: LyricsSnapshot[] = []
  let now = 0
  const coordinator = new LyricsCoordinator({
    now: () => now,
    load: async () => readySnapshot('unused'),
    onChange: (snapshot) => changes.push(snapshot),
  })

  coordinator.setActiveLyrics('101', {
    status: 'ready',
    lines: [{
      startMs: 0,
      endMs: 2_000,
      text: 'one two three',
      words: [
        { startMs: 0, endMs: 500, text: 'one ' },
        { startMs: 500, endMs: 1_000, text: 'two ' },
        { startMs: 1_000, endMs: 2_000, text: 'three' },
      ],
    }],
    activeLineIndex: -1,
    timingSource: 'static',
  })
  now = 250
  coordinator.updateRoonTime(100)
  const afterFirstWord = changes.length
  now = 300
  coordinator.updateRoonTime(500)
  assert.equal(changes.length, afterFirstWord)
  now = 350
  coordinator.updateRoonTime(1_000)

  assert.equal(changes.length, afterFirstWord + 1)
  assert.equal(changes.at(-1)?.activeWordIndex, 2)
})

test('lyrics coordinator applies the confirmed pause position before freezing progression', () => {
  const changes: LyricsSnapshot[] = []
  let now = 0
  const coordinator = new LyricsCoordinator({
    now: () => now,
    load: async () => readySnapshot('unused'),
    onChange: (snapshot) => changes.push(snapshot),
  })

  coordinator.setActiveLyrics('101', {
    status: 'ready',
    lines: [
      { startMs: 0, endMs: 1_000, text: 'one' },
      { startMs: 1_000, text: 'two' },
    ],
    activeLineIndex: -1,
    timingSource: 'static',
  })
  now = 250
  coordinator.onPlaybackChanged({
    ...playing('101'),
    source: 'netease',
    selectedZoneId: 'zone-a',
    positionMs: 800,
  })
  now = 260
  coordinator.onPlaybackChanged({
    ...playing('101'),
    state: 'paused',
    source: 'netease',
    selectedZoneId: 'zone-a',
    positionMs: 1_000,
    canPause: false,
    canResume: true,
  })

  assert.equal(changes.at(-1)?.activeLineIndex, 1)
  assert.equal(changes.at(-1)?.timingSource, 'roon-time')
})

test('lyrics coordinator does not leave a throttled word stale when playback pauses', () => {
  const changes: LyricsSnapshot[] = []
  let now = 0
  const coordinator = new LyricsCoordinator({
    now: () => now,
    load: async () => readySnapshot('unused'),
    onChange: (snapshot) => changes.push(snapshot),
  })

  coordinator.setActiveLyrics('101', {
    status: 'ready',
    lines: [{
      startMs: 0,
      endMs: 1_000,
      text: 'one two',
      words: [
        { startMs: 0, endMs: 500, text: 'one ' },
        { startMs: 500, endMs: 1_000, text: 'two' },
      ],
    }],
    activeLineIndex: -1,
    timingSource: 'static',
  })
  now = 250
  coordinator.onPlaybackChanged({
    ...playing('101'),
    source: 'netease',
    selectedZoneId: 'zone-a',
    positionMs: 100,
  })
  assert.equal(changes.at(-1)?.activeWordIndex, 0)

  now = 300
  coordinator.onPlaybackChanged({
    ...playing('101'),
    state: 'paused',
    source: 'netease',
    selectedZoneId: 'zone-a',
    positionMs: 500,
    canPause: false,
    canResume: true,
  })

  assert.equal(changes.at(-1)?.activeWordIndex, 1)
})

for (const contextChange of [
  {
    name: 'source',
    next: { source: 'roon' as const, selectedZoneId: 'zone-a' },
  },
  {
    name: 'zone',
    next: { source: 'netease' as const, selectedZoneId: 'zone-b' },
  },
]) {
  test(`lyrics coordinator re-anchors when the ${contextChange.name} changes on the same track`, () => {
    const changes: LyricsSnapshot[] = []
    let now = 0
    const coordinator = new LyricsCoordinator({
      now: () => now,
      load: async () => readySnapshot('unused'),
      onChange: (snapshot) => changes.push(snapshot),
    })

    coordinator.setActiveLyrics('101', {
      status: 'ready',
      lines: [
        { startMs: 0, endMs: 1_000, text: 'one' },
        { startMs: 1_000, text: 'two' },
      ],
      activeLineIndex: -1,
      timingSource: 'static',
    })
    now = 250
    coordinator.onPlaybackChanged({
      ...playing('101'),
      source: 'netease',
      selectedZoneId: 'zone-a',
      positionMs: 1_500,
    })
    assert.equal(changes.at(-1)?.activeLineIndex, 1)

    now = 260
    coordinator.onPlaybackChanged({
      ...playing('101'),
      ...contextChange.next,
      positionMs: 0,
    })

    assert.equal(changes.at(-1)?.activeLineIndex, 0)
    assert.equal(changes.at(-1)?.timingSource, 'estimated')
  })
}

test('lyrics coordinator schedules estimated updates and cancels them on shutdown', () => {
  const changes: LyricsSnapshot[] = []
  let now = 0
  let tick: (() => void) | undefined
  let cancellations = 0
  const coordinator = new LyricsCoordinator({
    now: () => now,
    load: async () => readySnapshot('unused'),
    onChange: (snapshot) => changes.push(snapshot),
    scheduleEstimatedUpdates: (callback) => {
      tick = callback
      return () => {
        cancellations += 1
        tick = undefined
      }
    },
  })

  coordinator.setActiveLyrics('101', {
    status: 'ready',
    lines: [
      { startMs: 0, endMs: 1_000, text: 'one' },
      { startMs: 1_000, text: 'two' },
    ],
    activeLineIndex: -1,
    timingSource: 'static',
  })
  coordinator.markPlaying('101')
  now = 1_250
  tick?.()

  assert.equal(changes.at(-1)?.activeLineIndex, 1)
  assert.equal(changes.at(-1)?.timingSource, 'estimated')
  coordinator.shutdown()
  assert.equal(cancellations, 1)
})

test('lyrics coordinator stops estimated updates while paused and resumes from the held position', () => {
  const changes: LyricsSnapshot[] = []
  let now = 0
  let tick: (() => void) | undefined
  let cancellations = 0
  const coordinator = new LyricsCoordinator({
    now: () => now,
    load: async () => readySnapshot('unused'),
    onChange: (snapshot) => changes.push(snapshot),
    scheduleEstimatedUpdates: (callback) => {
      tick = callback
      return () => {
        cancellations += 1
        tick = undefined
      }
    },
  })

  coordinator.setActiveLyrics('101', {
    status: 'ready',
    lines: [
      { startMs: 0, endMs: 1_000, text: 'one' },
      { startMs: 1_000, text: 'two' },
    ],
    activeLineIndex: -1,
    timingSource: 'static',
  })
  coordinator.onPlaybackChanged({
    ...playing('101'),
    positionMs: 800,
  })
  now = 450
  coordinator.onPlaybackChanged({
    ...playing('101'),
    state: 'paused',
    positionMs: 800,
    canPause: false,
    canResume: true,
  })
  const pausedLine = changes.at(-1)?.activeLineIndex
  tick?.()
  assert.equal(changes.at(-1)?.activeLineIndex, pausedLine)
  assert.equal(cancellations > 0, true)

  coordinator.onPlaybackChanged({
    ...playing('101'),
    positionMs: 800,
  })
  now = 800
  tick?.()
  assert.equal(changes.at(-1)?.activeLineIndex, 1)
})

test('lyrics coordinator freezes estimated time throughout pausing and resuming', () => {
  const changes: LyricsSnapshot[] = []
  let now = 0
  let tick: (() => void) | undefined
  let cancellations = 0
  const coordinator = new LyricsCoordinator({
    now: () => now,
    load: async () => readySnapshot('unused'),
    onChange: (snapshot) => changes.push(snapshot),
    scheduleEstimatedUpdates: (callback) => {
      tick = callback
      return () => {
        cancellations += 1
        tick = undefined
      }
    },
  })

  coordinator.setActiveLyrics('101', {
    status: 'ready',
    lines: [
      { startMs: 0, endMs: 1_000, text: 'one' },
      { startMs: 1_000, text: 'two' },
    ],
    activeLineIndex: -1,
    timingSource: 'static',
  })
  coordinator.onPlaybackChanged({ ...playing('101'), positionMs: 800 })
  now = 300
  coordinator.onPlaybackChanged({
    ...playing('101'),
    state: 'pausing' as PlaybackSnapshot['state'],
    positionMs: 800,
    canPause: false,
    canResume: false,
  })
  const heldLine = changes.at(-1)?.activeLineIndex
  tick?.()
  assert.equal(changes.at(-1)?.activeLineIndex, heldLine)

  coordinator.onPlaybackChanged({
    ...playing('101'),
    state: 'resuming' as PlaybackSnapshot['state'],
    positionMs: 800,
    canPause: false,
    canResume: false,
  })
  now = 800
  tick?.()
  assert.equal(changes.at(-1)?.activeLineIndex, heldLine)
  assert.equal(cancellations > 0, true)
})

test('lyrics coordinator keeps estimating between sparse Roon time callbacks', () => {
  const changes: LyricsSnapshot[] = []
  let now = 0
  const coordinator = new LyricsCoordinator({
    now: () => now,
    load: async () => readySnapshot('unused'),
    onChange: (snapshot) => changes.push(snapshot),
  })

  coordinator.setActiveLyrics('101', {
    status: 'ready',
    lines: [
      { startMs: 0, endMs: 1_000, text: 'one' },
      { startMs: 1_000, text: 'two' },
    ],
    activeLineIndex: -1,
    timingSource: 'static',
  })
  coordinator.updateRoonTime(800)
  now = 450
  coordinator.updateEstimated()

  assert.equal(changes.at(-1)?.activeLineIndex, 1)
  assert.equal(changes.at(-1)?.timingSource, 'estimated')
})

test('lyrics coordinator caps its in-memory cache at fifty tracks', async () => {
  let loads = 0
  const coordinator = new LyricsCoordinator({
    load: async () => {
      loads += 1
      return readySnapshot(`track-${loads}`)
    },
  })

  for (let index = 0; index < 51; index += 1) {
    await coordinator.getLyrics(String(index + 1))
  }

  assert.equal(coordinator.cacheSize, 50)
  assert.equal(loads, 51)
})

test('重复播放命中本地歌词缓存时恢复 MANUAL 状态和撤销能力', async () => {
  const repository = createLyricsMatchRepository()
  let downloads = 0
  const resolver = new LyricsMatchResolver({
    repository,
    provider: {
      configured: true,
      async searchTracks() { throw new Error('不应重新搜索已保存的匹配') },
      async getLyrics() { downloads += 1; return readySnapshot('已确认歌词') },
    },
  })
  const snapshot: PlaybackSnapshot = {
    ...playing('local-1'),
    source: 'roon',
    currentTrack: { id: 'local-1', title: '归零', artists: ['林忆莲'], album: '0', durationMs: 271_000 },
    queue: { items: [{ trackId: 'local-1', qualityPreference: 'auto', preferredSource: 'roon' }], index: 0, hasNext: false, hasPrevious: false },
  }
  const first = createLyricsRequestContext(snapshot, 1)
  assert.ok(first?.kind === 'local')
  await repository.set({ signature: first.signature, neteaseTrackId: '101', source: 'MANUAL', algorithmVersion: 'lyrics-match-v1' })
  const manual = new LocalLyricsManualMatchController({ repository, reload: async () => undefined })
  const coordinator = new LyricsCoordinator({
    load: async () => readySnapshot('不应调用'),
    localResolver: resolver,
    onLocalResolution: (context, resolution) => manual.observeResolution(context, resolution),
  })
  manual.observeContext(first)
  coordinator.onPlaybackChanged(snapshot, first)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(manual.getSnapshot().canRevoke, true)
  manual.observeContext(undefined)
  coordinator.onPlaybackChanged({ ...snapshot, state: 'idle' })
  const second = createLyricsRequestContext(snapshot, 2)
  assert.ok(second?.kind === 'local')
  manual.observeContext(second)
  coordinator.onPlaybackChanged(snapshot, second)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(coordinator.getSnapshot().status, 'ready')
  assert.equal(downloads, 1)
  assert.equal(manual.getSnapshot().status, 'matched')
  assert.equal(manual.getSnapshot().canRevoke, true)
})

test('停止或播放失败时不再保留可供手动选择的本地上下文', () => {
  for (const state of ['idle', 'stopping', 'error'] as const) {
    assert.equal(createLyricsRequestContext({ ...playing('101'), state }, 3), undefined)
  }
})

test('MANUAL 选择和撤销贯穿 resolver 与 coordinator，仅刷新歌词不改变播放快照', async () => {
  const repository = createLyricsMatchRepository()
  let searches = 0
  const downloads: string[] = []
  const resolver = new LyricsMatchResolver({
    repository,
    provider: {
      configured: true,
      async searchTracks() {
        searches += 1
        return {
          items: [
            { id: '101', title: '归零', artists: ['林忆莲'], album: '甲', durationMs: 268_000 },
            { id: '102', title: '归零', artists: ['林忆莲'], album: '乙', durationMs: 274_000 },
          ], offset: 0, limit: 20, total: 2, hasMore: false,
        }
      },
      async getLyrics(trackId) { downloads.push(trackId); return readySnapshot('手动选择后的歌词') },
    },
  })
  const snapshot: PlaybackSnapshot = {
    ...playing('local-1'), source: 'roon', positionMs: 5_000,
    currentTrack: { id: 'local-1', title: '归零', artists: ['林忆莲'], album: '0', durationMs: 271_000 },
    queue: { items: [{ trackId: 'local-1', qualityPreference: 'auto', preferredSource: 'roon' }], index: 0, hasNext: false, hasPrevious: false },
  }
  const before = JSON.stringify(snapshot)
  const context = createLyricsRequestContext(snapshot, 7)
  assert.ok(context?.kind === 'local')
  let coordinator!: LyricsCoordinator
  const manual = new LocalLyricsManualMatchController({
    repository,
    reload: async (active) => { resolver.invalidate(active.signature.key); await coordinator.reloadActiveLocalLyrics(active) },
  })
  coordinator = new LyricsCoordinator({
    load: async () => { throw new Error('本地播放不得使用直接加载入口') },
    localResolver: resolver,
    onLocalResolution: (active, result) => manual.observeResolution(active, result),
  })
  manual.observeContext(context)
  coordinator.onPlaybackChanged(snapshot, context)
  await new Promise((resolve) => setImmediate(resolve))
  const choice = manual.getSnapshot()
  assert.equal(choice.status, 'needs-choice')
  assert.deepEqual(downloads, [])
  await manual.select(choice.matchSessionId!, choice.candidates[1]!.candidateId)
  assert.deepEqual(downloads, ['102'])
  assert.equal(coordinator.getSnapshot().source, 'netease')
  assert.equal(coordinator.getSnapshot().activeLineIndex, 0)
  assert.equal(manual.getSnapshot().canRevoke, true)
  const searchesBeforeRevoke = searches
  await manual.revoke()
  assert.equal(manual.getSnapshot().status, 'needs-choice')
  assert.equal(coordinator.getSnapshot().status, 'unavailable')
  assert.equal(searches > searchesBeforeRevoke, true)
  assert.equal(await repository.get(context.signature.key, 'lyrics-match-v1'), undefined)
  assert.equal(JSON.stringify(snapshot), before)
})
