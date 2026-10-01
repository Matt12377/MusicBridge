import assert from 'node:assert/strict'
import test from 'node:test'
import { roonTrackIdFromReference } from '@music-bridge/contracts'
import type { LyricsSnapshot, PlaybackSnapshot, PublicTrackMatchResult, RoonLibraryItem, TrackSummary } from '@music-bridge/contracts'
import type { MusicBridgePublicApi } from '../src/preload/api.js'
import { projectPlaybackSnapshot } from '../src/renderer/src/composables/application/playbackSnapshot.js'
import { usePlaybackSession, type RoonPlaybackContext } from '../src/renderer/src/composables/application/usePlaybackSession.js'
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
  getRoonPlaybackContext: () => RoonPlaybackContext | undefined = () => undefined,
  sessionOptions: { roonContextPlaybackEnabled?: boolean; onEnterNowPlaying?: () => void } = {},
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
    getRoonPlaybackContext,
    resolveFavoriteDescriptor: favoriteDescriptorForRoonItem,
    onEnterNowPlaying: () => undefined,
    clearActionError: () => undefined,
    onActionMessage: () => undefined,
    onError: error => { throw error },
    onToast: () => undefined,
    ...sessionOptions,
  })
  return { session, calls, setNativeSnapshot: (value: PlaybackSnapshot) => { nativeSnapshot = value } }
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(onResolve => { resolve = onResolve })
  return { promise, resolve }
}

test('MBR-001 单曲播放替换集合后，旧后台分页不得追加到新队列', async t => {
  const nextPage = deferred<import('@music-bridge/contracts').Page<TrackSummary>>();
  const appended: string[][] = [];
  const harness = createSession({ replaceQueue: async () => snapshot(track('A')), play: async () => snapshot(track('B')),
    appendQueue: async items => { appended.push(items.map(item => item.trackId)); return snapshot(track('A')); } });
  t.after(() => harness.session.dispose());
  await harness.session.replaceAndPlayCollection(async page => page.offset === 0
    ? { items: [track('A')], offset: 0, limit: 20, total: 21, hasMore: true } : nextPage.promise);
  await harness.session.playTrack(track('B'));
  nextPage.resolve({ items: [track('旧C')], offset: 20, limit: 20, total: 21, hasMore: false });
  await tick();
  assert.deepEqual(appended, []);
  assert.equal(harness.session.currentTrack.value?.id, 'B');
});

test('MBR-001 旧 append 回执晚于新播放时不得回填界面状态', async t => {
  const ack = deferred<PlaybackSnapshot>();
  let appendCalls = 0;
  const harness = createSession({ replaceQueue: async () => snapshot(track('A')), play: async () => snapshot(track('B')),
    appendQueue: async () => { appendCalls++; return ack.promise; } });
  t.after(() => harness.session.dispose());
  await harness.session.replaceAndPlayCollection(async page => ({ items: [track(page.offset === 0 ? 'A' : '旧C')],
    offset: page.offset, limit: 20, total: 21, hasMore: page.offset === 0 }));
  await tick(); assert.equal(appendCalls, 1);
  await harness.session.playTrack(track('B'));
  ack.resolve(snapshot(track('A'))); await tick();
  assert.equal(harness.session.currentTrack.value?.id, 'B');
});

test('MBR-001 Stop 后旧后台页停止消费，用户下一次集合播放仍可开始', async t => {
  const nextPage = deferred<import('@music-bridge/contracts').Page<TrackSummary>>();
  let appended = 0;
  const idle: PlaybackSnapshot = { ...snapshot(track('A')), state: 'idle', currentTrack: undefined, canStop: false, canPause: false };
  const harness = createSession({ replaceQueue: async items => snapshot(track(items[0]!.trackId)), stop: async () => idle,
    appendQueue: async () => { appended++; return snapshot(track('A')); } });
  t.after(() => harness.session.dispose());
  await harness.session.replaceAndPlayCollection(async page => page.offset === 0
    ? { items: [track('A')], offset: 0, limit: 20, total: 21, hasMore: true } : nextPage.promise);
  await harness.session.stopPlayback();
  nextPage.resolve({ items: [track('旧C')], offset: 20, limit: 20, total: 21, hasMore: false }); await tick();
  assert.equal(appended, 0); assert.equal(harness.session.playbackState.value?.state, 'idle');
  await harness.session.replaceAndPlayCollection(async () => ({ items: [track('B')], offset: 0, limit: 20, total: 1, hasMore: false }));
  assert.equal(harness.session.currentTrack.value?.id, 'B');
});

for (const source of ['netease', 'roon'] as const) {
  test(`MBR-001 ${source} 停止失败的重试继续停止原来源，不重新播放`, async t => {
    let stops = 0, plays = 0;
    const failure = new Error('合成停止超时');
    const idle: PlaybackSnapshot = { ...snapshot(track('A'), 0, source), state: 'idle', currentTrack: undefined, canStop: false, canPause: false };
    const stop = async () => { stops++; if (stops === 1) throw failure; return idle; };
    const harness = createSession({ stop, stopRoonTransport: async () => { await stop(); return { stopped: true }; },
      play: async () => { plays++; return snapshot(track('A')); }, getPlaybackState: async () => idle });
    t.after(() => harness.session.dispose());
    harness.session.applyPlaybackState(snapshot(track('A'), 0, source));
    await assert.rejects(harness.session.stopPlayback(), error => error === failure);
    await (harness.session as unknown as { retryLastPlaybackAction(): Promise<void> }).retryLastPlaybackAction();
    assert.equal(stops, 2); assert.equal(plays, 0);
    assert.equal(harness.session.playbackState.value?.state, 'idle');
  });
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

test('MBP004：完整Roon上下文持续换代时实际Session零play派发', async t => {
  const item: RoonLibraryItem = { reference: 'musicbridge-v2-entity-00000000-0000-4000-8000-000000000001', kind: 'track', title: '合成曲目' }
  const epochA = '00000000-0000-4000-8000-000000000001', epochB = '00000000-0000-4000-8000-000000000002'
  let plays = 0
  const calls: number[] = []
  const f = createSession({ playRoonTrack: async () => { plays++; return { started: true } } }, () => undefined, () => ({
    reference: 'album', page: { items: [item], offset: 0, limit: 24, sourceEpoch: epochA, nextOffset: 1, hasMore: true, complete: false },
    load: async (_reference, request) => {
      calls.push(request.offset)
      return { ...request, items: [item], sourceEpoch: request.offset === 0 ? epochA : epochB, nextOffset: request.offset + 1, hasMore: true, complete: false }
    },
  }))
  t.after(() => f.session.dispose())
  await assert.rejects(f.session.playRoonLibraryTrack(item), /已变化/u)
  assert.deepEqual(calls, [1, 0]); assert.equal(plays, 0)
  assert.equal(f.session.playbackStartPending.value, false)
})

const contextHandle = '00000000-0000-4000-8000-000000000051'
const contextTrack = (suffix: string): RoonLibraryItem => ({
  reference: `musicbridge-v2-entity-00000000-0000-4000-8000-${suffix.padStart(12, '0')}`,
  kind: 'track', title: `上下文曲目${suffix}`, artist: '上下文艺人', album: '上下文专辑',
})

test('MBP003B：详情带句柄直接播放选中曲目，不等后续详情页', async t => {
  const selected = contextTrack('52'), earlier = contextTrack('53')
  let reads = 0
  const writes: unknown[][] = []
  const f = createSession({ playRoonTrack: async (...args) => { writes.push(args); return { started: true } } },
    () => undefined, () => ({ reference: 'album', page: {
      items: [earlier, selected], offset: 24, limit: 24, hasMore: true, complete: false,
      sourceEpoch: contextHandle, playbackContextHandle: contextHandle, nextOffset: 48,
    }, load: async () => { reads++; throw new Error('首播不能读取后续页') } }))
  t.after(() => f.session.dispose())
  await f.session.playRoonLibraryTrack(selected)
  assert.equal(reads, 0)
  assert.deepEqual(writes, [[selected.reference, 'zone-1', undefined, contextHandle]])
})

test('MBP003B：累积详情后仍可点击前页曲目，共用句柄而不发完整引用数组', async t => {
  const first = contextTrack('54'), later = contextTrack('55')
  const writes: unknown[][] = []
  const f = createSession({ playRoonTrack: async (...args) => { writes.push(args); return { started: true } } },
    () => undefined, () => ({ reference: 'playlist', page: {
      items: [first, later], offset: 24, limit: 24, hasMore: false, complete: true,
      sourceEpoch: contextHandle, playbackContextHandle: contextHandle,
    }, load: async () => { throw new Error('不应重读前页') } }))
  t.after(() => f.session.dispose())
  await f.session.playRoonLibraryTrack(first)
  assert.deepEqual(writes, [[first.reference, 'zone-1', undefined, contextHandle]])
})

test('MBP003B：提供但过期的句柄只拒绝，不降级成完整读取或单曲重试', async t => {
  const selected = contextTrack('56')
  const writes: unknown[][] = []; let reads = 0
  const f = createSession({ playRoonTrack: async (...args) => { writes.push(args); throw new Error('上下文已过期') } },
    () => undefined, () => ({ reference: 'genre', page: {
      items: [selected], offset: 0, limit: 24, hasMore: true, playbackContextHandle: contextHandle,
    }, load: async (_reference, request) => { reads++; return { ...request, items: [], hasMore: false } } }))
  t.after(() => f.session.dispose())
  await assert.rejects(f.session.playRoonLibraryTrack(selected), /上下文已过期/u)
  assert.equal(reads, 0)
  assert.deepEqual(writes, [[selected.reference, 'zone-1', undefined, contextHandle]])
})

for (const mode of ['缺句柄', '关闭开关'] as const) {
  test(`MBP003B：${mode}保留旧完整读取与队列顺序`, async t => {
    const first = contextTrack('57'), second = contextTrack('58')
    const writes: unknown[][] = []; const reads: number[] = []
    const f = createSession({ playRoonTrack: async (...args) => { writes.push(args); return { started: true } } },
      () => undefined, () => ({ reference: 'album', page: {
        items: [first], offset: 0, limit: 24, hasMore: true, nextOffset: 7,
        ...(mode === '关闭开关' ? { playbackContextHandle: contextHandle } : {}),
      }, load: async (_reference, request) => { reads.push(request.offset); return { ...request, items: [second], hasMore: false,
        ...(mode === '关闭开关' ? { playbackContextHandle: contextHandle } : {}) } } }),
      { roonContextPlaybackEnabled: mode !== '关闭开关' })
    t.after(() => f.session.dispose())
    await f.session.playRoonLibraryTrack(first)
    assert.deepEqual(reads, [7])
    assert.deepEqual(writes, [[first.reference, 'zone-1', [first.reference, second.reference]]])
  })
}

test('MBP003B：搜索单曲不借用残留父页的句柄', async t => {
  const selected = contextTrack('59'), foreign = contextTrack('60')
  const writes: unknown[][] = []
  const f = createSession({ playRoonTrack: async (...args) => { writes.push(args); return { started: true } } },
    () => undefined, () => ({ reference: '旧album', page: {
      items: [foreign], offset: 0, limit: 24, hasMore: true, playbackContextHandle: contextHandle,
    }, load: async () => { throw new Error('不应借用旧父页') } }))
  t.after(() => f.session.dispose())
  await f.session.playRoonLibraryTrack(selected)
  assert.deepEqual(writes, [[selected.reference, 'zone-1', [selected.reference]]])
})

test('MBP003B：后台补入的可信曲目保持本地收藏、最近播放与重播', async t => {
  const item = { ...contextTrack('61'), trackNumber: 2, discNumber: 1, version: '现场版' }
  const current = track(roonTrackIdFromReference(item.reference))
  const native = snapshot(current, 0, 'roon')
  native.queue.items = [{ ...native.queue.items[0]!, preferredSource: 'roon', roonItem: item }]
  const queries: unknown[] = []; const writes: unknown[][] = []
  const f = createSession({ checkFavorite: async descriptor => { queries.push(descriptor); return { favorite: false } },
    playRoonTrack: async (...args) => { writes.push(args); return { started: true } } })
  t.after(() => f.session.dispose())
  f.setNativeSnapshot(native)
  f.session.acceptPlaybackEvent(native)
  await tick()
  assert.deepEqual(queries, [favoriteDescriptorForRoonItem(item)])
  assert.equal(f.session.recentTracks.value[0]?.id, current.id)
  await f.session.retryLastPlaybackAction()
  assert.deepEqual(writes, [[item.reference, 'zone-1', [item.reference]]])
})

test('MBP003B：仅context状态变化仍透出，普通进度tick保持队列引用', () => {
  const previous = snapshot(track('1'), 0, 'roon')
  previous.queue.context = { beforeComplete: false, afterComplete: false, loading: false }
  const incoming = structuredClone(previous)
  incoming.queue.context = { beforeComplete: false, afterComplete: false, loading: true, error: 'retryable' }
  const projected = projectPlaybackSnapshot(previous, incoming)
  assert.notEqual(projected.queue, previous.queue)
  assert.deepEqual(projected.queue.context, incoming.queue.context)
  const progress = projectPlaybackSnapshot(projected, { ...structuredClone(projected), positionMs: 1_000 })
  assert.equal(progress.queue, projected.queue)
})

test('MBP003B：同trackId补齐roonItem不被快照投影丢弃', () => {
  const item = contextTrack('62')
  const previous = snapshot(track(roonTrackIdFromReference(item.reference)), 0, 'roon')
  previous.queue.items = [{ ...previous.queue.items[0]!, preferredSource: 'roon' }]
  const incoming = structuredClone(previous)
  incoming.queue.items = [{ ...incoming.queue.items[0]!, roonItem: item }]
  const projected = projectPlaybackSnapshot(previous, incoming)
  assert.notEqual(projected.queue, previous.queue)
  assert.deepEqual(projected.queue.items[0]?.roonItem, item)
  assert.equal(projectPlaybackSnapshot(projected, structuredClone(projected)), projected)
})

test('MBP003B：进入播放页面同步取消后，句柄播放零派发', async t => {
  const item = contextTrack('63'); let plays = 0
  let stop!: Promise<void>
  const idle = { ...snapshot(track('1'), 0, 'roon'), state: 'idle' as const, canStop: false }
  const f = createSession({ playRoonTrack: async () => { plays++; return { started: true } },
    stopRoonTransport: async () => ({ stopped: true }), getPlaybackState: async () => idle },
    () => undefined, () => ({ reference: 'album', page: {
      items: [item], offset: 0, limit: 24, playbackContextHandle: contextHandle,
    }, load: async () => { throw new Error('不应额外读取') } }),
    { onEnterNowPlaying: () => { stop = f.session.stopPlayback() } })
  t.after(() => f.session.dispose())
  await f.session.playRoonLibraryTrack(item)
  await stop
  assert.equal(plays, 0)
  assert.equal(f.session.playbackState.value?.state, 'idle')
})

test('MBP003B：取消句柄播放的迟到回执不清除下一次准备标志或回填状态', async t => {
  const first = contextTrack('64'), second = contextTrack('65')
  const old = deferred<{ started: true }>(), next = deferred<{ started: true }>()
  let writes = 0
  const idle = { ...snapshot(track('1'), 0, 'roon'), state: 'idle' as const, canStop: false }
  const f = createSession({ playRoonTrack: async () => { writes++; return writes === 1 ? old.promise : next.promise },
    stopRoonTransport: async () => ({ stopped: true }), getPlaybackState: async () => idle },
    () => undefined, () => ({ reference: 'album', page: {
      items: [first, second], offset: 0, limit: 24, playbackContextHandle: contextHandle,
    }, load: async () => { throw new Error('不应额外读取') } }))
  t.after(() => f.session.dispose())
  const pendingOld = f.session.playRoonLibraryTrack(first)
  await f.session.stopPlayback()
  const pendingNext = f.session.playRoonLibraryTrack(second)
  assert.equal(f.session.playbackStartPending.value, true)
  old.resolve({ started: true }); await pendingOld
  assert.equal(f.session.playbackStartPending.value, true)
  assert.equal(f.session.currentTrack.value?.id, roonTrackIdFromReference(second.reference))
  next.resolve({ started: true }); await pendingNext
  assert.equal(f.session.playbackStartPending.value, false)
})

test('MBP003B：句柄播放之后的旧快照读取晚于Stop，不回填旧playing状态', async t => {
  const item = contextTrack('66'), oldRead = deferred<PlaybackSnapshot>()
  let reads = 0
  const idle = { ...snapshot(track('1'), 0, 'roon'), state: 'idle' as const, canStop: false }
  const f = createSession({ playRoonTrack: async () => ({ started: true }),
    stopRoonTransport: async () => ({ stopped: true }), getPlaybackState: async () => ++reads === 1 ? oldRead.promise : idle },
    () => undefined, () => ({ reference: 'album', page: {
      items: [item], offset: 0, limit: 24, playbackContextHandle: contextHandle,
    }, load: async () => { throw new Error('不应额外读取') } }))
  t.after(() => f.session.dispose())
  const pending = f.session.playRoonLibraryTrack(item)
  await tick(); await f.session.stopPlayback()
  oldRead.resolve(snapshot(track(roonTrackIdFromReference(item.reference)), 0, 'roon'))
  await pending
  assert.equal(f.session.playbackState.value?.state, 'idle')
})

test('MBP003B：可信队列描述符有界且保留当前项，重复进度不重复收藏查询', async t => {
  const items = Array.from({ length: 300 }, (_, index) => contextTrack(String(100 + index)))
  const native = snapshot(track(roonTrackIdFromReference(items[0]!.reference)), 0, 'roon')
  native.queue.items = items.map(item => ({ trackId: roonTrackIdFromReference(item.reference),
    track: track(roonTrackIdFromReference(item.reference)), qualityPreference: 'auto', preferredSource: 'roon', roonItem: item }))
  const queries: unknown[] = []; let plays = 0
  const f = createSession({ checkFavorite: async descriptor => { queries.push(descriptor); return { favorite: false } },
    playRoonTrack: async () => { plays++; return { started: true } } })
  t.after(() => f.session.dispose())
  f.session.acceptPlaybackEvent(native); await tick()
  assert.deepEqual(queries, [favoriteDescriptorForRoonItem(items[0]!)])
  for (let index = 1; index <= 100; index++) {
    f.session.acceptPlaybackEvent({ ...structuredClone(native), positionMs: index * 1000 })
  }
  await tick()
  assert.equal(queries.length, 1)
  const evicted = snapshot(track(roonTrackIdFromReference(items[1]!.reference)), 0, 'roon')
  f.setNativeSnapshot(evicted); f.session.acceptPlaybackEvent(evicted); await tick()
  await f.session.retryLastPlaybackAction()
  assert.equal(plays, 0, '超过描述符缓存容量的旧项不能继续作为可信重播身份')
})
