import assert from 'node:assert/strict'
import test from 'node:test'
import type { PlaybackSnapshot, PlaybackStreamSnapshot, PlaybackStreamStamp } from '@music-bridge/contracts'
import type { MusicBridgePublicApi } from '../src/preload/api.js'
import { usePlaybackSession } from '../src/renderer/src/composables/application/usePlaybackSession.js'
import { useRendererLifecycle } from '../src/renderer/src/composables/application/useRendererLifecycle.js'

const instance = '20000000-0000-4000-8000-000000000001'
const other = '20000000-0000-4000-8000-000000000002'
function stamp(sequence = 1, change: Partial<PlaybackStreamStamp> = {}): PlaybackStreamStamp {
  return { coreInstanceId: instance, generation: 1, sequence, queueRevision: 1, selectedZoneId: 'zone-a', trackId: '1', source: 'netease', ...change }
}
function snapshot(positionMs = 10000): PlaybackSnapshot {
  return { state: 'playing', source: 'netease', selectedZoneId: 'zone-a', currentTrack: { id: '1', title: '合成曲目', artists: ['合成艺人'], album: '合成专辑', durationMs: 180000 }, positionMs,
    queue: { items: [{ trackId: '1', qualityPreference: 'auto' }], index: 0, hasNext: false, hasPrevious: false },
    canNext: false, canPrevious: false, canStop: true, canPause: true, canResume: false }
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((a,b) => { resolve=a; reject=b }); return { promise, resolve, reject } }
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function fixture(apiOverrides: Partial<MusicBridgePublicApi> = {}) {
  const calls = { seed: 0, legacy: 0, lyrics: 0, like: 0, favorite: 0 }, errors: unknown[] = []
  const api = {
    getPlaybackStreamSnapshot: async () => { calls.seed++; return { stamp: stamp(), snapshot: snapshot() } },
    getPlaybackState: async () => { calls.legacy++; return snapshot() },
    getLyrics: async () => { calls.lyrics++; return { status: 'unavailable', lines: [], activeLineIndex: -1, timingSource: 'static' } },
    getTrackLikeStatus: async () => { calls.like++; return { liked: false } },
    checkFavorite: async () => { calls.favorite++; return { favorite: false } }, ...apiOverrides,
  } as unknown as MusicBridgePublicApi
  const session = usePlaybackSession({ api, getSelectedZone: () => ({ zoneId: 'zone-a', displayName: '合成Zone', selected: true, seekAllowed: true }),
    getZoneLifecycleStatus: () => 'selected', getSelectedQuality: () => 'auto', getMatchResult: () => undefined,
    getPendingMatch: () => undefined, onMatchTracks: () => undefined, getRoonPlaybackContext: () => undefined,
    resolveFavoriteDescriptor: () => { throw new Error('不应读取收藏描述符') }, onEnterNowPlaying: () => undefined,
    clearActionError: () => undefined, onActionMessage: () => undefined, onError: e => errors.push(e), onToast: () => undefined })
  return { session, calls, errors, api }
}

test('MBP006 compact bootstrap与百progress零队列扫描、零喜欢/最近重算', async t => {
  const h = fixture(); t.after(() => h.session.dispose()); await h.session.initializePlaybackStream()
  const original = h.session.playbackState.value!, recent = h.session.recentTracks.value
  const baseline = { ...h.calls }; let reads = 0; const items = original.queue.items
  Object.defineProperty(original.queue, 'items', { get() { reads++; return items } })
  for (let i = 2; i <= 101; i++) h.session.acceptPlaybackStreamEvent({ event: 'playback.progress', payload: { stamp: stamp(i), positionMs: i * 1000 } })
  assert.equal(h.session.playbackState.value!.positionMs, 101000); assert.equal(h.session.playbackState.value!.queue, original.queue)
  assert.equal(h.session.recentTracks.value, recent); assert.equal(reads, 0); assert.deepEqual(h.calls, baseline)
})
test('MBP006 late pause命令回执不能覆盖更新Stop事件', async t => {
  const ack = deferred<PlaybackSnapshot>(), h = fixture({ pause: () => ack.promise }); t.after(() => h.session.dispose())
  await h.session.initializePlaybackStream(); const paused = h.session.togglePlayback()
  const idle = { ...snapshot(0), state: 'idle' as const, currentTrack: undefined, source: undefined, canPause: false, canStop: false }
  h.session.acceptPlaybackStreamEvent({ event: 'playback.snapshot', payload: { stamp: stamp(3, { generation: 2, trackId: null, source: null }), snapshot: idle } })
  ack.resolve({ ...snapshot(), state: 'paused', stream: stamp(2) }); await paused
  assert.equal(h.session.playbackState.value!.state, 'idle'); assert.equal(h.session.currentTrack.value, undefined)
})
test('MBP006 compact missing stamp只ACK+共享readonly，不能legacy覆盖', async t => {
  const seed = deferred<PlaybackStreamSnapshot | null>(); let count = 0
  const h = fixture({ getPlaybackStreamSnapshot: async () => ++count === 1 ? { stamp: stamp(), snapshot: snapshot() } : seed.promise,
    next: async () => ({ ...snapshot(0), currentTrack: { id: '旧', title: '旧回执', artists: [], album: '合成专辑' } }) })
  t.after(() => h.session.dispose()); await h.session.initializePlaybackStream()
  await h.session.nextTrack(); assert.equal(h.session.currentTrack.value!.id, '1'); assert.equal(count, 2)
  for (let i = 2; i < 100; i++) h.session.acceptPlaybackStreamEvent({ event: 'playback.progress', payload: { stamp: stamp(i, { queueRevision: 2 }), positionMs: i } })
  assert.equal(count, 2); seed.reject(new Error('合成读取失败')); await tick()
  for (let i = 100; i < 200; i++) h.session.acceptPlaybackStreamEvent({ event: 'playback.progress', payload: { stamp: stamp(i, { queueRevision: 2 }), positionMs: i } })
  assert.equal(count, 2); assert.equal(h.calls.legacy, 0); assert.equal(h.session.playbackSyncStatus.value, 'error')
})
test('MBP006 只读恢复失败清flight，显式retry可成功，null不降级', async t => {
  let count = 0
  const h = fixture({ getPlaybackStreamSnapshot: async () => { count++; return count === 1 ? { stamp: stamp(), snapshot: snapshot() } : count === 2 ? null : { stamp: stamp(10), snapshot: snapshot(8000) } } })
  t.after(() => h.session.dispose()); await h.session.initializePlaybackStream()
  h.session.acceptPlaybackStreamEvent({ event: 'playback.progress', payload: { stamp: stamp(3), positionMs: 1 } }); await tick()
  assert.equal(h.session.playbackSyncStatus.value, 'error'); assert.equal(h.calls.legacy, 0)
  await h.session.retryPlaybackSync(); assert.equal(h.session.playbackSyncStatus.value, 'ready'); assert.equal(count, 3)
})
test('MBP006 新可信ready换代挡迟到seed与旧实例delta', async t => {
  const seed = deferred<PlaybackStreamSnapshot | null>(); const h = fixture({ getPlaybackStreamSnapshot: () => seed.promise })
  t.after(() => h.session.dispose()); const pending = h.session.initializePlaybackStream()
  h.session.acceptPlaybackReady({ protocol: 'compact-v1', coreInstanceId: other })
  h.session.acceptPlaybackStreamEvent({ event: 'playback.snapshot', payload: { stamp: stamp(1, { coreInstanceId: other }), snapshot: snapshot(500) } })
  seed.resolve({ stamp: stamp(99), snapshot: snapshot(90000) }); await pending
  h.session.acceptPlaybackStreamEvent({ event: 'playback.progress', payload: { stamp: stamp(100), positionMs: 100000 } })
  assert.equal(h.session.playbackState.value!.positionMs, 500); assert.equal(h.session.playbackSyncStatus.value, 'ready')
})
test('MBP006 普通unknowninstance snapshot不能自授', async t => {
  const h = fixture(); t.after(() => h.session.dispose()); await h.session.initializePlaybackStream()
  h.session.acceptPlaybackStreamEvent({ event: 'playback.snapshot', payload: { stamp: stamp(100, { coreInstanceId: other }), snapshot: snapshot(90000) } })
  assert.equal(h.session.playbackState.value!.positionMs, 10000); assert.equal(h.session.playbackSyncStatus.value, 'ready')
})
test('MBP006 首次bootstrap seed在途收到静止Pause，不漏掉最新state或自授', async t => {
  const seed = deferred<PlaybackStreamSnapshot | null>(), h = fixture({ getPlaybackStreamSnapshot: () => seed.promise })
  t.after(() => h.session.dispose()); const pending = h.session.initializePlaybackStream()
  const { queue: _queue, ...state } = snapshot(11000)
  h.session.acceptPlaybackStreamEvent({ event: 'playback.state', payload: { stamp: stamp(2), state: { ...state, state: 'paused', canPause: false, canResume: true } } })
  assert.equal(h.session.playbackState.value, null)
  seed.resolve({ stamp: stamp(1), snapshot: snapshot() }); await pending
  assert.equal(h.session.playbackState.value!.state, 'paused'); assert.equal(h.session.playbackState.value!.positionMs, 11000)
  assert.equal(h.session.playbackSyncStatus.value, 'ready')
})
test('MBP006 同曲新owner废弃旧seek确认，不刷新新owner', async t => {
  const ack = deferred<{ positionMs: number }>(), h = fixture({ seek: () => ack.promise }); t.after(() => h.session.dispose())
  await h.session.initializePlaybackStream(); const values: (number | undefined)[] = []
  const seeking = h.session.seekPlayback(50000, value => values.push(value))
  h.session.acceptPlaybackStreamEvent({ event: 'playback.snapshot', payload: { stamp: stamp(2, { generation: 2 }), snapshot: snapshot(0) } })
  ack.resolve({ positionMs: 50000 }); await seeking
  assert.ok(!values.includes(50000)); assert.equal(h.calls.seed, 1); assert.equal(h.session.playbackState.value!.positionMs, 0)
})
test('MBP006 连续seek乱序只结算最后草稿', async t => {
  const a = deferred<{ positionMs: number }>(), b = deferred<{ positionMs: number }>(); let n = 0
  const h = fixture({ seek: () => ++n === 1 ? a.promise : b.promise }); t.after(() => h.session.dispose())
  await h.session.initializePlaybackStream(); const values: number[] = []
  const first = h.session.seekPlayback(50000, v => { if (v !== undefined) values.push(v) })
  const second = h.session.seekPlayback(30000, v => { if (v !== undefined) values.push(v) })
  b.resolve({ positionMs: 30000 }); await second
  h.session.acceptPlaybackStreamEvent({ event: 'playback.progress', payload: { stamp: stamp(2), positionMs: 30000 } })
  a.resolve({ positionMs: 50000 }); await first
  assert.deepEqual(values, [30000])
})

test('MBP006 seek ACK与同owner旧full保留草稿，晚观测才确认', async t => {
  const ack = deferred<{ positionMs: number }>(), h = fixture({ seek: () => ack.promise })
  t.after(() => h.session.dispose()); await h.session.initializePlaybackStream()
  const values: (number | undefined)[] = [], pending = h.session.seekPlayback(50000, value => values.push(value))
  h.session.acceptPlaybackStreamEvent({ event: 'playback.snapshot', payload: { stamp: stamp(2), snapshot: snapshot(10000) } })
  ack.resolve({ positionMs: 10000 }); await pending
  assert.deepEqual(values, [])
  h.session.acceptPlaybackStreamEvent({ event: 'playback.progress', payload: { stamp: stamp(3), positionMs: 11000 } })
  assert.deepEqual(values, [])
  h.session.acceptPlaybackStreamEvent({ event: 'playback.progress', payload: { stamp: stamp(4), positionMs: 50000 } })
  assert.deepEqual(values, [50000]); assert.equal(h.session.playbackState.value!.positionMs, 50000)
})

test('MBP006 低频full投影复用后，progress仍保留UI低频引用', async t => {
  const h = fixture(); t.after(() => h.session.dispose()); await h.session.initializePlaybackStream()
  const original = h.session.playbackState.value!, clone = structuredClone(original)
  h.session.acceptPlaybackStreamEvent({ event: 'playback.snapshot', payload: { stamp: stamp(2), snapshot: { ...clone, actualQuality: 'lossless' } } })
  h.session.acceptPlaybackStreamEvent({ event: 'playback.progress', payload: { stamp: stamp(3), positionMs: 12000 } })
  assert.equal(h.session.playbackState.value!.queue, original.queue)
  assert.equal(h.session.playbackState.value!.currentTrack, original.currentTrack)
})
test('MBP006 明确legacy null仍使用旧全快照并保留命令兼容', async t => {
  const h = fixture({ getPlaybackStreamSnapshot: async () => null, pause: async () => ({ ...snapshot(), state: 'paused' }) })
  t.after(() => h.session.dispose()); await h.session.initializePlaybackStream(); await h.session.togglePlayback()
  assert.equal(h.session.playbackState.value!.state, 'paused'); assert.equal(h.calls.legacy, 1)
})

test('MBP006 换到可信legacy ready必须读新事实，不能保留旧Core队列', async t => {
  const idle: PlaybackSnapshot = { ...snapshot(0), state: 'idle', currentTrack: undefined,
    queue: { items: [], index: -1, hasNext: false, hasPrevious: false }, canPause: false, canStop: false }
  const h = fixture({ getPlaybackState: async () => idle }); t.after(() => h.session.dispose())
  await h.session.initializePlaybackStream(); h.session.acceptPlaybackReady(); await tick()
  assert.equal(h.session.playbackState.value!.state, 'idle'); assert.equal(h.session.playbackState.value!.queue.items.length, 0)
  assert.equal(h.session.playbackSyncStatus.value, 'ready')
})

test('MBP006 实际Renderer lifecycle先订阅再seed，卸载废弃迟到基准', async t => {
  const pending = deferred<PlaybackStreamSnapshot | null>(), order: string[] = []
  const h = fixture({ getPlaybackStreamSnapshot: () => { order.push('seed'); return pending.promise } })
  const lifecycle = useRendererLifecycle({
    api: { onAppCommand: () => () => undefined, onRemoteCoreEvent: () => () => undefined,
      onCoreEvent: () => { order.push('listen'); return () => undefined } },
    keyTarget: { addEventListener: () => undefined, removeEventListener: () => undefined },
    onKeydown: () => undefined, onCoreEvent: () => undefined, onRemoteCoreEvent: () => undefined, onAppCommand: () => undefined,
    initialize: async read => { await read(() => h.session.initializePlaybackStream()) }, onInitializationError: e => h.errors.push(e),
  })
  t.after(() => { lifecycle.dispose(); h.session.dispose() }); lifecycle.start()
  assert.deepEqual(order, ['listen', 'seed']); lifecycle.dispose(); h.session.dispose()
  pending.resolve({ stamp: stamp(), snapshot: snapshot() }); await tick(); assert.equal(h.session.playbackState.value, null)
})

test('MBP006 ACK后观测等待有界，到期恢复观测而不伪造目标', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = fixture({ seek: async () => ({ positionMs: 10000 }) }); t.after(() => h.session.dispose())
  await h.session.initializePlaybackStream(); const values: (number | undefined)[] = []
  await h.session.seekPlayback(50000, value => values.push(value)); assert.deepEqual(values, [])
  t.mock.timers.tick(5001); assert.deepEqual(values, [undefined]); assert.equal(h.session.playbackState.value!.positionMs, 10000)
})

for (const outcome of ['reject', 'null', 'older', 'later'] as const) {
  test(`MBP006 新full取代恢复flight后，迟到${outcome}不得撤销基准或再读`, async t => {
    const pending = deferred<PlaybackStreamSnapshot | null>(); let reads = 0
    const h = fixture({ getPlaybackStreamSnapshot: async () => ++reads === 1 ? { stamp: stamp(1), snapshot: snapshot() } : pending.promise })
    t.after(() => h.session.dispose()); await h.session.initializePlaybackStream()
    h.session.acceptPlaybackStreamEvent({ event: 'playback.progress', payload: { stamp: stamp(3), positionMs: 11000 } })
    assert.equal(reads, 2)
    h.session.acceptPlaybackStreamEvent({ event: 'playback.snapshot', payload: { stamp: stamp(4), snapshot: snapshot(12000) } })
    assert.equal(h.session.playbackSyncStatus.value, 'ready')
    if (outcome === 'reject') pending.reject(new Error('合成旧恢复读取失败'))
    else if (outcome === 'null') pending.resolve(null)
    else pending.resolve({ stamp: stamp(outcome === 'older' ? 2 : 6), snapshot: snapshot(90000) })
    await tick()
    assert.equal(h.session.playbackSyncStatus.value, 'ready'); assert.equal(h.session.playbackViewState.value!.canPause, true)
    assert.equal(h.session.playbackState.value!.positionMs, 12000); assert.deepEqual(h.errors, [])
    h.session.acceptPlaybackStreamEvent({ event: 'playback.progress', payload: { stamp: stamp(5), positionMs: 13000 } }); await tick()
    assert.equal(reads, 2); assert.equal(h.session.playbackState.value!.positionMs, 13000)
  })
}

test('MBP006 被新full废弃的旧flight不得清除后一incident的flight与预算', async t => {
  const old = deferred<PlaybackStreamSnapshot | null>(), next = deferred<PlaybackStreamSnapshot | null>(); let reads = 0
  const h = fixture({ getPlaybackStreamSnapshot: async () => ++reads === 1 ? { stamp: stamp(), snapshot: snapshot() } : reads === 2 ? old.promise : next.promise })
  t.after(() => h.session.dispose()); await h.session.initializePlaybackStream()
  h.session.acceptPlaybackStreamEvent({ event: 'playback.progress', payload: { stamp: stamp(3), positionMs: 11000 } })
  h.session.acceptPlaybackStreamEvent({ event: 'playback.snapshot', payload: { stamp: stamp(4), snapshot: snapshot(12000) } })
  h.session.acceptPlaybackStreamEvent({ event: 'playback.progress', payload: { stamp: stamp(6), positionMs: 14000 } })
  assert.equal(reads, 3)
  old.reject(new Error('合成被替代的读取失败')); await tick()
  assert.equal(h.session.playbackSyncStatus.value, 'syncing'); assert.deepEqual(h.errors, [])
  for (let n = 7; n <= 100; n++) h.session.acceptPlaybackStreamEvent({ event: 'playback.progress', payload: { stamp: stamp(n), positionMs: n } })
  assert.equal(reads, 3)
  next.resolve({ stamp: stamp(101), snapshot: snapshot(15000) }); await tick()
  assert.equal(h.session.playbackSyncStatus.value, 'ready'); assert.equal(h.session.playbackState.value!.positionMs, 15000)
})
