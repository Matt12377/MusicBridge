import assert from 'node:assert/strict'
import test from 'node:test'

import type { LyricsSnapshot, PlaybackSnapshot } from '@music-bridge/contracts'
import { NeteaseClient } from '../src/netease/client.js'
import { parseLyricsResponse } from '../src/netease/lyrics.js'
import { LyricsCoordinator } from '../src/lyrics/coordinator.js'

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
