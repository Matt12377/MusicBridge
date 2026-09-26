import assert from 'node:assert/strict'
import test from 'node:test'
import { roonTrackIdFromReference } from '@music-bridge/contracts'
import type { LyricsSnapshot, PlaybackSnapshot, PublicTrackMatchResult, RoonLibraryItem, TrackSummary } from '@music-bridge/contracts'
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

function createSession(
  apiOverrides: Partial<MusicBridgePublicApi> = {},
  getMatchResult: (trackId: string) => PublicTrackMatchResult | undefined = () => undefined,
) {
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
    getMatchResult,
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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(onResolve => { resolve = onResolve })
  return { promise, resolve }
}

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

test('仅网易云身份连续两次点击只写网易云，依次收藏和取消', async t => {
  const writes: boolean[] = []
  let localWrites = 0
  const harness = createSession({
    setTrackLiked: async (_id, liked) => { writes.push(liked); return { liked } },
    setFavorite: async () => { localWrites += 1; return { favorite: true } },
  })
  t.after(() => harness.session.dispose())
  harness.session.applyPlaybackState(snapshot(track('netease-only')))
  await tick()

  await harness.session.toggleTrackLike()
  await harness.session.toggleTrackLike()
  assert.deepEqual(writes, [true, false])
  assert.equal(localWrites, 0)
  assert.equal(harness.session.trackLikeState.value, 'not-liked')
})

test('仅本地 Roon 身份连续两次点击只写本地收藏，依次收藏和取消', async t => {
  const item: RoonLibraryItem = {
    reference: 'musicbridge-v2-entity-00000000-0000-0000-0000-000000000103',
    kind: 'track', title: '仅本地曲目', artist: '本地艺人',
  }
  const localWrites: boolean[] = []
  let neteaseWrites = 0
  const harness = createSession({
    setTrackLiked: async () => { neteaseWrites += 1; return { liked: true } },
    setFavorite: async (_descriptor, favorite) => { localWrites.push(favorite); return { favorite } },
  })
  t.after(() => harness.session.dispose())
  harness.setNativeSnapshot(snapshot(track(roonTrackIdFromReference(item.reference)), 0, 'roon'))
  await harness.session.playRoonLibraryTrack(item)
  await tick()

  await harness.session.toggleTrackLike()
  await harness.session.toggleTrackLike()
  assert.deepEqual(localWrites, [true, false])
  assert.equal(neteaseWrites, 0)
  assert.equal(harness.session.trackLikeState.value, 'not-liked')
})

test('双身份一边已收藏时先补齐两边，下一次再共同取消', async t => {
  const item: RoonLibraryItem = {
    reference: 'musicbridge-v2-entity-00000000-0000-0000-0000-000000000104',
    kind: 'track', title: '双来源曲目', artist: '本地艺人',
  }
  const providerTrack = track('netease-dual')
  const mixed = snapshot(providerTrack, 0, 'roon')
  mixed.queue = {
    ...mixed.queue,
    items: [{ ...mixed.queue.items[0]!, preferredSource: 'smart' }],
  }
  const writes = { netease: [] as boolean[], local: [] as boolean[] }
  const match: PublicTrackMatchResult = {
    trackId: providerTrack.id, state: 'CONFIRMED', confidence: 0.95,
    evidence: ['synthetic'], candidates: [], candidate: item, algorithmVersion: 'synthetic-v1',
  }
  const harness = createSession({
    replaceQueue: async () => mixed,
    getTrackLikeStatus: async () => ({ liked: true }),
    setTrackLiked: async (_id, liked) => { writes.netease.push(liked); return { liked } },
    setFavorite: async (_descriptor, favorite) => { writes.local.push(favorite); return { favorite } },
  }, id => id === providerTrack.id ? match : undefined)
  t.after(() => harness.session.dispose())
  await harness.session.playTrack(providerTrack)
  await tick()
  assert.equal(harness.session.nativeRoonHasNeteaseMatch.value, true)
  assert.equal(harness.session.localTrackFavoriteDescriptor.value?.title, item.title)

  await harness.session.toggleTrackLike()
  await harness.session.toggleTrackLike()
  assert.deepEqual(writes, { netease: [true, false], local: [true, false] })
  assert.equal(harness.session.trackLikeState.value, 'not-liked')
})

test('来源不存在或可用来源读取失败时不猜测方向也不发送写请求', async t => {
  const writes = { netease: 0, local: 0 }
  const failing = createSession({
    getTrackLikeStatus: async () => { throw new Error('合成读取故障') },
    setTrackLiked: async () => { writes.netease += 1; return { liked: true } },
    setFavorite: async () => { writes.local += 1; return { favorite: true } },
  })
  t.after(() => failing.session.dispose())
  failing.session.applyPlaybackState(snapshot(track('unknown-netease')))
  await tick()
  await failing.session.toggleTrackLike()

  const localItem: RoonLibraryItem = {
    reference: 'musicbridge-v2-entity-00000000-0000-0000-0000-000000000105',
    kind: 'track', title: '未知本地收藏',
  }
  const failingLocal = createSession({
    checkFavorite: async () => { throw new Error('合成本地读取故障') },
    setTrackLiked: async () => { writes.netease += 1; return { liked: true } },
    setFavorite: async () => { writes.local += 1; return { favorite: true } },
  })
  t.after(() => failingLocal.session.dispose())
  failingLocal.setNativeSnapshot(snapshot(track(roonTrackIdFromReference(localItem.reference)), 0, 'roon'))
  await failingLocal.session.playRoonLibraryTrack(localItem)
  await tick()
  await failingLocal.session.toggleTrackLike()

  const unavailable = createSession({
    setTrackLiked: async () => { writes.netease += 1; return { liked: true } },
    setFavorite: async () => { writes.local += 1; return { favorite: true } },
  })
  t.after(() => unavailable.session.dispose())
  unavailable.session.applyPlaybackState(snapshot(track('unmapped-roon'), 0, 'roon'))
  await tick()
  await unavailable.session.toggleTrackLike()
  assert.deepEqual(writes, { netease: 0, local: 0 })
})

for (const alreadyLiked of [false, true]) {
  test(`首次网易云喜欢状态读取失败后，点击重读并${alreadyLiked ? '取消' : '收藏'}`, async t => {
    let reads = 0
    const writes: boolean[] = []
    const harness = createSession({
      getTrackLikeStatus: async () => {
        reads += 1
        if (reads === 1) throw new Error('合成首次读取故障')
        return { liked: alreadyLiked }
      },
      setTrackLiked: async (_id, liked) => { writes.push(liked); return { liked } },
    })
    t.after(() => harness.session.dispose())
    harness.session.applyPlaybackState(snapshot(track(`retry-${alreadyLiked}`)))
    await tick()
    assert.equal(harness.session.trackLikeState.value, 'error')

    await harness.session.toggleTrackLike()
    assert.equal(reads, 2)
    assert.deepEqual(writes, [!alreadyLiked])
    assert.equal(harness.session.trackLikeState.value, alreadyLiked ? 'not-liked' : 'liked')
  })
}

test('首次本地收藏读取失败后，点击只重读本地并按真实状态取消', async t => {
  const item: RoonLibraryItem = {
    reference: 'musicbridge-v2-entity-00000000-0000-0000-0000-000000000106',
    kind: 'track', title: '本地读取重试',
  }
  let reads = 0
  let neteaseWrites = 0
  const localWrites: boolean[] = []
  const harness = createSession({
    checkFavorite: async () => {
      reads += 1
      if (reads === 1) throw new Error('合成首次本地读取故障')
      return { favorite: true }
    },
    setFavorite: async (_descriptor, favorite) => { localWrites.push(favorite); return { favorite } },
    setTrackLiked: async () => { neteaseWrites += 1; return { liked: true } },
  })
  t.after(() => harness.session.dispose())
  harness.setNativeSnapshot(snapshot(track(roonTrackIdFromReference(item.reference)), 0, 'roon'))
  await harness.session.playRoonLibraryTrack(item)
  await tick()
  assert.equal(harness.session.trackLikeState.value, 'error')

  await harness.session.toggleTrackLike()
  assert.equal(reads, 2)
  assert.deepEqual(localWrites, [false])
  assert.equal(neteaseWrites, 0)
  assert.equal(harness.session.trackLikeState.value, 'not-liked')
})

test('收藏写入失败后重试先重读真实状态，不用失败前的旧布尔值猜方向', async t => {
  let liked = false
  let reads = 0
  const writes: boolean[] = []
  const harness = createSession({
    getTrackLikeStatus: async () => { reads += 1; return { liked } },
    setTrackLiked: async (_id, nextLiked) => {
      writes.push(nextLiked)
      liked = nextLiked
      if (writes.length === 1) throw new Error('合成写入已生效但回执失败')
      return { liked }
    },
  })
  t.after(() => harness.session.dispose())
  harness.session.applyPlaybackState(snapshot(track('write-uncertain')))
  await tick()
  await assert.rejects(harness.session.toggleTrackLike())
  assert.equal(harness.session.trackLikeState.value, 'error')

  await harness.session.toggleTrackLike()
  assert.equal(reads, 2)
  assert.deepEqual(writes, [true, false])
  assert.equal(harness.session.trackLikeState.value, 'not-liked')
})

test('重试读取途中切曲或换来源，不向任何旧实体写收藏', async t => {
  for (const transition of ['track', 'source'] as const) {
    const retryRead = deferred<{ liked: boolean }>()
    let oldReads = 0
    const writes: Array<{ id: string; liked: boolean }> = []
    const harness = createSession({
      getTrackLikeStatus: id => {
        if (id !== 'retry-old') return Promise.resolve({ liked: false })
        oldReads += 1
        return oldReads === 1 ? Promise.reject(new Error('合成首次读取故障')) : retryRead.promise
      },
      setTrackLiked: async (id, liked) => { writes.push({ id, liked }); return { liked } },
    })
    t.after(() => harness.session.dispose())
    harness.session.applyPlaybackState(snapshot(track('retry-old')))
    await tick()
    assert.equal(harness.session.trackLikeState.value, 'error')
    const pendingToggle = harness.session.toggleTrackLike()
    await tick()
    assert.equal(oldReads, 2)

    harness.session.applyPlaybackState(snapshot(track(transition === 'track' ? 'new-track' : 'retry-old'), 0,
      transition === 'track' ? 'netease' : 'roon'))
    await tick()
    retryRead.resolve({ liked: true })
    await pendingToggle
    assert.deepEqual(writes, [])
  }
})

test('重试读取途中同 ID 的本地描述符被替换，也不写旧收藏实体', async t => {
  const reference = 'musicbridge-v2-entity-00000000-0000-0000-0000-000000000107'
  const oldItem: RoonLibraryItem = { reference, kind: 'track', title: '旧描述符' }
  const newItem: RoonLibraryItem = { ...oldItem, title: '新描述符' }
  const retryRead = deferred<{ favorite: boolean }>()
  let reads = 0
  const writes: string[] = []
  const harness = createSession({
    checkFavorite: async () => {
      reads += 1
      if (reads === 1) throw new Error('合成首次读取故障')
      return reads === 2 ? retryRead.promise : { favorite: false }
    },
    setFavorite: async (descriptor, favorite) => {
      writes.push(`${descriptor.title}:${favorite}`)
      return { favorite }
    },
  })
  t.after(() => harness.session.dispose())
  harness.setNativeSnapshot(snapshot(track(roonTrackIdFromReference(reference)), 0, 'roon'))
  await harness.session.playRoonLibraryTrack(oldItem)
  await tick()
  assert.equal(harness.session.trackLikeState.value, 'error')
  const pendingToggle = harness.session.toggleTrackLike()
  await tick()
  assert.equal(reads, 2)

  await harness.session.playRoonLibraryTrack(newItem)
  await tick()
  retryRead.resolve({ favorite: true })
  await pendingToggle
  assert.equal(harness.session.localTrackFavoriteDescriptor.value?.title, '新描述符')
  assert.deepEqual(writes, [])
})

test('迟到的喜欢查询与旧曲目写入结果不能回填切曲后的收藏状态', async t => {
  const oldQuery = deferred<{ liked: boolean }>()
  const oldWrite = deferred<{ liked: boolean }>()
  const writes: Array<{ id: string; liked: boolean }> = []
  const harness = createSession({
    getTrackLikeStatus: id => id === 'old-query' ? oldQuery.promise : Promise.resolve({ liked: false }),
    setTrackLiked: (id, liked) => {
      writes.push({ id, liked })
      return id === 'old-write' ? oldWrite.promise : Promise.resolve({ liked })
    },
  })
  t.after(() => harness.session.dispose())

  harness.session.applyPlaybackState(snapshot(track('old-query')))
  harness.session.applyPlaybackState(snapshot(track('old-write')))
  await tick()
  const pendingWrite = harness.session.toggleTrackLike()
  harness.session.applyPlaybackState(snapshot(track('current')))
  await tick()
  oldQuery.resolve({ liked: true })
  oldWrite.resolve({ liked: true })
  await pendingWrite
  await tick()
  assert.equal(harness.session.currentTrack.value?.id, 'current')
  assert.equal(harness.session.neteaseTrackLiked.value, false)
  assert.equal(harness.session.trackLikeState.value, 'not-liked')
  await harness.session.toggleTrackLike()
  assert.deepEqual(writes, [
    { id: 'old-write', liked: true },
    { id: 'current', liked: true },
  ])
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
