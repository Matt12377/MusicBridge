import assert from 'node:assert/strict'
import test from 'node:test'
import { roonTrackIdFromReference } from '@music-bridge/contracts'
import type { LyricsSnapshot, PlaybackSnapshot, RoonLibraryItem, TrackSummary } from '@music-bridge/contracts'
import type { MusicBridgePublicApi } from '../src/preload/api.js'
import { projectPlaybackSnapshot } from '../src/renderer/src/composables/application/playbackSnapshot.js'
import { usePlaybackSession } from '../src/renderer/src/composables/application/usePlaybackSession.js'
import { favoriteDescriptorForRoonItem } from '../src/renderer/src/composables/playbackFavorites.js'

const track = (id: string): TrackSummary => ({ id, title: `曲目 ${id}`, artists: ['合成艺人'], album: '合成专辑' })

function snapshot(currentTrack: TrackSummary, positionMs = 0, source: 'roon' | 'netease' = 'netease'): PlaybackSnapshot {
  return {
    state: 'playing', source, currentTrack, positionMs,
    queue: {
      items: [{ trackId: currentTrack.id, track: { ...currentTrack }, qualityPreference: 'auto', resolvedSource: source }],
      index: 0, hasNext: false, hasPrevious: false,
    },
    canNext: false, canPrevious: false, canStop: true, canPause: true, canResume: false,
  }
}

function createSession(apiOverrides: Partial<MusicBridgePublicApi> = {}) {
  const calls = { lyrics: 0, like: 0, favorite: 0 }
  let nativeSnapshot = snapshot(track('1'), 0, 'roon')
  const api = {
    getLyrics: async () => { calls.lyrics += 1; return { status: 'unavailable', lines: [], activeLineIndex: -1, timingSource: 'static' } },
    getTrackLikeStatus: async () => { calls.like += 1; return { liked: false } },
    checkFavorite: async () => { calls.favorite += 1; return { favorite: false } },
    playRoonTrack: async () => undefined,
    getPlaybackState: async () => nativeSnapshot,
    ...apiOverrides,
  } as unknown as MusicBridgePublicApi
  const session = usePlaybackSession({
    api,
    getSelectedZone: () => ({ zoneId: 'zone-1', displayName: '合成设备', selected: true }),
    getZoneLifecycleStatus: () => 'selected',
    getSelectedQuality: () => 'auto',
    getMatchResult: () => undefined,
    getPendingMatch: () => undefined,
    onMatchTracks: () => undefined,
    getRoonPlaybackContext: () => undefined,
    resolveFavoriteDescriptor: favoriteDescriptorForRoonItem,
    onEnterNowPlaying: () => undefined,
    clearActionError: () => undefined,
    onActionMessage: () => undefined,
    onError: error => { throw error },
    onToast: () => undefined,
  })
  return { session, calls, setNativeSnapshot: (value: PlaybackSnapshot) => { nativeSnapshot = value } }
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

test('100 次同曲进度事件不重复请求歌词或喜欢状态', async t => {
  const harness = createSession()
  t.after(() => harness.session.dispose())
  const initial = snapshot(track('netease-1'))
  harness.session.applyPlaybackState(initial)
  await tick()
  assert.deepEqual(harness.calls, { lyrics: 1, like: 1, favorite: 0 })

  for (let index = 1; index <= 100; index += 1) {
    harness.session.acceptPlaybackEvent(snapshot({ ...initial.currentTrack! }, index * 1_000))
  }
  await tick()
  assert.deepEqual(harness.calls, { lyrics: 1, like: 1, favorite: 0 })
  assert.equal(harness.session.playbackState.value?.positionMs, 100_000)
})

test('100 次同曲原生 Roon 进度事件不重复查询本地收藏', async t => {
  const item: RoonLibraryItem = {
    reference: 'musicbridge-v2-entity-00000000-0000-0000-0000-000000000101',
    kind: 'track', title: '本地曲目', artist: '本地艺人', album: '本地专辑',
  }
  const roonTrack = track(roonTrackIdFromReference(item.reference))
  const native = snapshot(roonTrack, 0, 'roon')
  const harness = createSession()
  t.after(() => harness.session.dispose())
  harness.setNativeSnapshot(native)
  await harness.session.playRoonLibraryTrack(item)
  await tick()
  assert.ok(harness.calls.favorite >= 1)
  const before = { ...harness.calls }

  for (let index = 1; index <= 100; index += 1) {
    harness.session.acceptPlaybackEvent(snapshot({ ...roonTrack }, index * 1_000, 'roon'))
  }
  await tick()
  assert.deepEqual(harness.calls, before)
})

test('Roon 收藏查询与切换向 API 发送可结构化克隆的完整标量描述符', async t => {
  const item: RoonLibraryItem = {
    reference: 'musicbridge-v2-entity-00000000-0000-0000-0000-000000000102',
    kind: 'track', title: '可传输曲目', subtitle: '录音版本', artist: '本地艺人',
    album: '本地专辑', durationMs: 183_000, trackNumber: 2, discNumber: 1,
    year: 2026, version: '现场版',
  }
  const receivedQueries: unknown[] = []
  const receivedWrites: Array<{ descriptor: unknown; favorite: boolean }> = []
  const harness = createSession({
    checkFavorite: async descriptor => {
      receivedQueries.push(structuredClone(descriptor))
      return { favorite: false }
    },
    setFavorite: async (descriptor, favorite) => {
      receivedWrites.push({ descriptor: structuredClone(descriptor), favorite })
      return { favorite }
    },
  })
  t.after(() => harness.session.dispose())
  harness.setNativeSnapshot(snapshot(track(roonTrackIdFromReference(item.reference)), 0, 'roon'))

  await harness.session.playRoonLibraryTrack(item)
  await tick()
  assert.ok(receivedQueries.length >= 1)
  for (const descriptor of receivedQueries) assert.deepEqual(descriptor, favoriteDescriptorForRoonItem(item))
  assert.equal(harness.session.trackLikeState.value, 'not-liked')

  await harness.session.toggleTrackLike()
  assert.deepEqual(receivedWrites, [{ descriptor: favoriteDescriptorForRoonItem(item), favorite: true }])
  assert.equal(harness.session.trackLikeState.value, 'liked')
})

test('同 ID 的封面、格式、播放能力及 issue 变化不会被进度投影吞掉', () => {
  const original = snapshot({ ...track('same'), artworkReference: 'art-a', format: 'FLAC' }, 1_000)
  const progress = projectPlaybackSnapshot(original, snapshot({ ...original.currentTrack! }, 2_000))
  assert.equal(progress.currentTrack, original.currentTrack)
  assert.equal(progress.queue, original.queue)

  const changed = snapshot({ ...original.currentTrack!, artworkReference: 'art-b', format: 'ALAC' }, 2_000)
  changed.format = 'ALAC'
  changed.canNext = true
  changed.lastIssue = { code: 'ROON_TIMEOUT', message: '确认超时', retryable: true, diagnosticId: 'synthetic-issue' }
  const projected = projectPlaybackSnapshot(progress, changed)
  assert.notEqual(projected.currentTrack, original.currentTrack)
  assert.equal(projected.currentTrack?.artworkReference, 'art-b')
  assert.equal(projected.currentTrack?.format, 'ALAC')
  assert.equal(projected.format, 'ALAC')
  assert.equal(projected.canNext, true)
  assert.equal(projected.lastIssue?.code, 'ROON_TIMEOUT')
})

test('lyrics.changed(B) 先于原生 playback.changed(B) 时保留 Core 推送歌词', async t => {
  const harness = createSession()
  t.after(() => harness.session.dispose())
  harness.session.applyPlaybackState(snapshot(track('roon-a'), 0, 'roon'))
  const lyricsB: LyricsSnapshot = {
    status: 'ready', lines: [{ startMs: 0, text: 'B 的歌词' }],
    activeLineIndex: 0, timingSource: 'roon-time', source: 'roon-display',
  }
  harness.session.onLyricsChanged(lyricsB)
  harness.session.acceptPlaybackEvent(snapshot(track('roon-b'), 0, 'roon'))
  await tick()
  assert.equal(harness.session.lyricsSnapshot.value, lyricsB)
  assert.equal(harness.calls.lyrics, 0)
})
