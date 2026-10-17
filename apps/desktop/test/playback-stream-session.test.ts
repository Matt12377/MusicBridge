import assert from 'node:assert/strict'
import test from 'node:test'
import { roonTrackIdFromReference } from '@music-bridge/contracts'
import type { PlaybackSnapshot, PlaybackStreamSnapshot, PlaybackStreamStamp, RoonLibraryItem } from '@music-bridge/contracts'
import type { MusicBridgePublicApi } from '../src/preload/api.js'
import { usePlaybackSession, type PlaybackSessionOptions } from '../src/renderer/src/composables/application/usePlaybackSession.js'
import { useRendererLifecycle } from '../src/renderer/src/composables/application/useRendererLifecycle.js'
import { favoriteDescriptorForRoonItem } from '../src/renderer/src/composables/playbackFavorites.js'

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
function fixture(apiOverrides: Partial<MusicBridgePublicApi> = {},
  resolveFavoriteDescriptor: PlaybackSessionOptions['resolveFavoriteDescriptor'] = () => { throw new Error('不应读取收藏描述符') }) {
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
    resolveFavoriteDescriptor, onEnterNowPlaying: () => undefined,
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

const roonItem940 = (suffix: string): RoonLibraryItem => ({
  reference: `musicbridge-v2-entity-40000000-0000-4000-8000-${suffix.padStart(12, '0')}`,
  kind: 'track', title: `热修复自有曲目${suffix}`, artist: '自有艺人', album: '自有专辑',
})
function errorEnvelope940(): PlaybackStreamSnapshot {
  return { stamp: stamp(), snapshot: { ...snapshot(7000), state: 'error',
    lastError: '原停止结果尚未确认，请先核对原播放器。',
    lastIssue: { code: 'ROON_TIMEOUT', message: '原停止结果尚未确认，请先核对原播放器。',
      retryable: true, diagnosticId: '940-authoritative-stop-unknown', action: 'retry' },
    canNext: false, canPrevious: false, canStop: true, canPause: false, canResume: false } }
}

test('HF940 compact同序error恢复原权威提示和能力，不接纳重复或旧帧', async t => {
  const original = errorEnvelope940(), failed = deferred<{ started: true }>(), nativeError = new Error('合成原点播拒绝')
  let plays = 0, seeds = 0, legacy = 0
  const h = fixture({ getPlaybackStreamSnapshot: async () => { seeds++; return structuredClone(original) },
    getPlaybackState: async () => { legacy++; return snapshot(99999) },
    playRoonTrack: () => { plays++; return failed.promise } }, favoriteDescriptorForRoonItem)
  t.after(() => h.session.dispose()); await h.session.initializePlaybackStream()
  const item = roonItem940('1'), pending = h.session.playRoonLibraryTrack(item)
  await tick()
  assert.equal(plays, 1); assert.equal(h.session.playbackState.value!.state, 'resolving')
  assert.equal(h.session.currentTrack.value!.id, roonTrackIdFromReference(item.reference))
  assert.equal(h.session.playbackStartPending.value, true)
  failed.reject(nativeError); await pending
  assert.deepEqual(h.session.playbackState.value, original.snapshot)
  assert.deepEqual(h.session.playbackViewState.value, original.snapshot)
  assert.equal(h.session.playbackState.value!.lastIssue!.diagnosticId, original.snapshot.lastIssue!.diagnosticId)
  assert.equal(h.session.playbackSource.value, 'netease'); assert.equal(h.session.playbackStartPending.value, false)
  assert.equal(h.session.playbackSyncStatus.value, 'ready'); assert.deepEqual(h.errors, [nativeError])
  assert.equal(seeds, 2); assert.equal(legacy, 0)
  for (const sequence of [0, 1]) h.session.acceptPlaybackStreamEvent({ event: 'playback.snapshot', payload: {
    stamp: stamp(sequence), snapshot: { ...snapshot(99999), state: 'playing', lastError: '不得接纳的同序正文' },
  } })
  assert.deepEqual(h.session.playbackState.value, original.snapshot)
  h.session.acceptPlaybackStreamEvent({ event: 'playback.progress', payload: { stamp: stamp(2), positionMs: 8000 } })
  assert.equal(h.session.playbackState.value!.positionMs, 8000)
  assert.equal(h.session.playbackState.value!.state, 'error'); assert.equal(seeds, 2)
})

test('HF940 compact刷新失败仍撤本次乐观层，不伪造权威成功', async t => {
  const original = errorEnvelope940(), failed = deferred<{ started: true }>(), read = deferred<PlaybackStreamSnapshot | null>()
  const nativeError = new Error('合成点播拒绝'), readError = new Error('合成只读恢复拒绝'); let plays = 0, seeds = 0
  const h = fixture({ getPlaybackStreamSnapshot: async () => ++seeds === 1 ? original : read.promise,
    playRoonTrack: () => { plays++; return failed.promise } }, favoriteDescriptorForRoonItem)
  t.after(() => h.session.dispose()); await h.session.initializePlaybackStream()
  const pending = h.session.playRoonLibraryTrack(roonItem940('2')); await tick()
  assert.equal(plays, 1); assert.equal(h.session.playbackState.value!.state, 'resolving')
  failed.reject(nativeError); await tick()
  assert.deepEqual(h.session.playbackState.value, original.snapshot)
  read.reject(readError); await pending
  assert.deepEqual(h.session.playbackState.value, original.snapshot)
  assert.equal(h.session.playbackSyncStatus.value, 'error'); assert.equal(h.session.playbackViewState.value!.canStop, false)
  assert.equal(h.session.playbackStartPending.value, false); assert.deepEqual(h.errors, [readError, nativeError])
  assert.equal(seeds, 2)
})

for (const replacement of ['full', 'ready'] as const) {
  test(`HF940 compact旧失败刷新期间新${replacement}已接纳，迟到回复不回退`, async t => {
    const original = errorEnvelope940(), failed = deferred<{ started: true }>(), read = deferred<PlaybackStreamSnapshot | null>()
    const nativeError = new Error('合成旧点播拒绝'); let plays = 0, seeds = 0
    const h = fixture({ getPlaybackStreamSnapshot: async () => ++seeds === 1 ? original : read.promise,
      playRoonTrack: () => { plays++; return failed.promise } }, favoriteDescriptorForRoonItem)
    t.after(() => h.session.dispose()); await h.session.initializePlaybackStream()
    const pending = h.session.playRoonLibraryTrack(roonItem940(replacement === 'full' ? '3' : '4')); await tick()
    assert.equal(plays, 1); assert.equal(h.session.playbackState.value!.state, 'resolving')
    failed.reject(nativeError); await tick(); assert.equal(seeds, 2)
    const current = { stamp: stamp(replacement === 'full' ? 3 : 1, replacement === 'ready' ? { coreInstanceId: other } : {}),
      snapshot: { ...snapshot(24000), state: 'paused' as const, canPause: false, canResume: true } }
    if (replacement === 'ready') h.session.acceptPlaybackReady({ protocol: 'compact-v1', coreInstanceId: other })
    h.session.acceptPlaybackStreamEvent({ event: 'playback.snapshot', payload: current })
    read.resolve(original); await pending
    assert.deepEqual(h.session.playbackState.value, current.snapshot)
    assert.equal(h.session.playbackSyncStatus.value, 'ready'); assert.equal(h.session.playbackStartPending.value, false)
    assert.deepEqual(h.errors, replacement === 'ready' ? [] : [nativeError]); assert.equal(seeds, 2)
  })
}

test('HF940 compact取消旧失败读取后新准备保有显示和pending，迟到旧回复失权', async t => {
  const original = errorEnvelope940(), first = deferred<{ started: true }>(), second = deferred<{ started: true }>()
  const oldRead = deferred<PlaybackStreamSnapshot | null>(), oldError = new Error('合成旧点播拒绝'); let plays = 0, seeds = 0
  const h = fixture({ getPlaybackStreamSnapshot: async () => ++seeds === 1 ? original : seeds === 2 ? oldRead.promise : original,
    playRoonTrack: () => ++plays === 1 ? first.promise : second.promise }, favoriteDescriptorForRoonItem)
  t.after(() => h.session.dispose()); await h.session.initializePlaybackStream()
  const pendingOld = h.session.playRoonLibraryTrack(roonItem940('5')); await tick()
  assert.equal(plays, 1); assert.equal(h.session.playbackState.value!.state, 'resolving')
  first.reject(oldError); await tick(); assert.equal(seeds, 2)
  h.session.cancelRoonPlaybackPreparation()
  // 原同序命令回执只恢复ready资格；不把它当新full或推进序号。
  h.session.applyPlaybackState({ ...original.snapshot, stream: original.stamp })
  const item = roonItem940('6'), pendingNext = h.session.playRoonLibraryTrack(item); await tick()
  assert.equal(plays, 2); assert.equal(h.session.playbackState.value!.state, 'resolving')
  oldRead.resolve({ stamp: stamp(2), snapshot: { ...snapshot(19000), state: 'paused', canPause: false, canResume: true } })
  await pendingOld
  assert.equal(h.session.currentTrack.value!.id, roonTrackIdFromReference(item.reference))
  assert.equal(h.session.playbackState.value!.state, 'resolving'); assert.equal(h.session.playbackStartPending.value, true)
  assert.deepEqual(h.errors, [])
  const playing = { ...snapshot(0), source: 'roon' as const, currentTrack: track940(item) }
  h.session.acceptPlaybackStreamEvent({ event: 'playback.snapshot', payload: {
    stamp: stamp(3, { generation: 2, trackId: playing.currentTrack.id, source: 'roon' }), snapshot: playing,
  } })
  second.resolve({ started: true }); await pendingNext
  assert.equal(h.session.currentTrack.value!.id, playing.currentTrack.id)
  assert.equal(h.session.playbackState.value!.state, 'playing'); assert.equal(h.session.playbackStartPending.value, false)
})

function track940(item: RoonLibraryItem) {
  return { id: roonTrackIdFromReference(item.reference), title: item.title, artists: [item.artist ?? '自有艺人'], album: item.album ?? '自有专辑' }
}

test('HF940 compact停止和卸载使迟到点播失败失权，不覆新基准或追加提示', async t => {
  const original = errorEnvelope940(), failed = deferred<{ started: true }>(), nativeError = new Error('合成迟到拒绝')
  let plays = 0, stops = 0
  const idle = { ...snapshot(0), state: 'idle' as const, canPause: false, canStop: false }
  const h = fixture({ getPlaybackStreamSnapshot: async () => original,
    playRoonTrack: () => { plays++; return failed.promise }, stopRoonTransport: async () => { stops++; return { stopped: true } } }, favoriteDescriptorForRoonItem)
  t.after(() => h.session.dispose()); await h.session.initializePlaybackStream()
  const pending = h.session.playRoonLibraryTrack(roonItem940('7')); await tick()
  assert.equal(plays, 1); assert.equal(h.session.playbackState.value!.state, 'resolving')
  await h.session.stopPlayback(); assert.equal(stops, 1)
  h.session.acceptPlaybackStreamEvent({ event: 'playback.snapshot', payload: { stamp: stamp(2), snapshot: idle } })
  h.session.dispose(); failed.reject(nativeError); await pending
  assert.deepEqual(h.session.playbackState.value, idle); assert.equal(h.session.playbackStartPending.value, false)
  assert.deepEqual(h.errors, [])
})

test('HF940 legacy失败仍沿原只读快照恢复，不改为compact或借旧帧', async t => {
  const original = errorEnvelope940().snapshot, failed = deferred<{ started: true }>(), nativeError = new Error('合成legacy拒绝')
  let plays = 0, seeds = 0, reads = 0
  const h = fixture({ getPlaybackStreamSnapshot: async () => { seeds++; return null },
    getPlaybackState: async () => { reads++; return original }, playRoonTrack: () => { plays++; return failed.promise } }, favoriteDescriptorForRoonItem)
  t.after(() => h.session.dispose()); await h.session.initializePlaybackStream()
  const pending = h.session.playRoonLibraryTrack(roonItem940('8')); await tick()
  assert.equal(plays, 1); assert.equal(h.session.playbackState.value!.state, 'resolving')
  failed.reject(nativeError); await pending
  assert.deepEqual(h.session.playbackState.value, original)
  assert.equal(h.session.playbackStartPending.value, false); assert.equal(h.session.playbackSyncStatus.value, 'ready')
  assert.deepEqual(h.errors, [nativeError]); assert.equal(seeds, 1); assert.equal(reads, 2)
})

// 仅受控Renderer回归；原session入口消费实际观察叶，不由测试新增播放请求。
function localSeekSnapshot950(phase: 'PLAYING' | 'PAUSED' | 'SUBMISSION_UNKNOWN' = 'PLAYING', positionMs = 10000): PlaybackSnapshot {
  const confirmed = phase !== 'SUBMISSION_UNKNOWN'
  const track = { id: '1', title: '合成本地进度', artists: ['合成作者'], album: '合成专辑', durationMs: 180000 }
  return {
    state: phase === 'PLAYING' ? 'playing' : phase === 'PAUSED' ? 'paused' : 'error', source: 'local_file',
    currentTrack: track, positionMs, selectedZoneId: 'zone-a',
    queue: { queueId: '30000000-0000-4000-8000-000000000001', revision: '1', items: [{
      entryId: '30000000-0000-4000-8000-000000000002', trackId: track.id, track, qualityPreference: 'auto', resolvedSource: 'local_file',
      local: { local_track_id: track.id, asset_id: 'asset-950', asset_revision: '1', selection_revision: '1', location_revision: '1', root_revision: '1' },
    }], index: 0, hasNext: false, hasPrevious: false },
    canNext: false, canPrevious: false, canPause: phase === 'PLAYING', canResume: phase === 'PAUSED', canStop: true,
    local: { schema_version: '1.2', request_id: '30000000-0000-4000-8000-000000000003', attempt_id: '30000000-0000-4000-8000-000000000004',
      intent_generation: '1', route: 'roon_audio_input', local_track_id: track.id, asset_id: 'asset-950', asset_revision: '1',
      target: { core_id: 'core-950', zone_id: 'zone-a' }, session_epoch: confirmed ? '合成本地会话950' : null,
      phase, ownership: confirmed ? 'MB_OWNED' : 'UNKNOWN', queue_owner: confirmed ? 'MB' : 'UNKNOWN', delivery_state: 'UNKNOWN',
      roon_observation: { event: phase === 'PLAYING' ? 'PLAYING' : phase === 'PAUSED' ? 'PAUSED' : 'UNKNOWN', observed: confirmed,
        correlation: confirmed ? 'ATTEMPT_CONFIRMED' : 'UNKNOWN' }, position_ms: positionMs,
      quality: { http_bytes: 'NOT_TESTED', signal_path: 'NOT_TESTED', digital_output: 'NOT_TESTED', gapless: 'NOT_TESTED' }, error_code: null },
  }
}
function localSeekEnvelope950(value = localSeekSnapshot950(), sequence = 1): PlaybackStreamSnapshot {
  return { stamp: stamp(sequence, { source: 'local_file', selectedZoneId: value.selectedZoneId ?? null, trackId: value.currentTrack?.id ?? null }), snapshot: value }
}

test('本地seek950：已知时长但UNKNOWN时原session入口零RPC', async t => {
  let sends = 0
  const h = fixture({ getPlaybackStreamSnapshot: async () => localSeekEnvelope950(localSeekSnapshot950('SUBMISSION_UNKNOWN')),
    seek: async () => { sends++; return { positionMs: 50000 } } })
  t.after(() => h.session.dispose()); await h.session.initializePlaybackStream()
  assert.equal(h.session.currentTrack.value!.durationMs, 180000); assert.equal(h.session.playbackSyncStatus.value, 'ready')
  const settled: (number | undefined)[] = []
  await h.session.seekPlayback(50000, value => settled.push(value))
  assert.equal(sends, 0); assert.deepEqual(settled, [undefined]); assert.deepEqual(h.errors, [])
})

test('本地seek950：准备错误未确认非MB与错Zone成员均不得派发', async t => {
  const variants: readonly [string, (value: PlaybackSnapshot) => void][] = [
    ['准备', value => { value.state = 'preparing'; value.local!.phase = 'PREPARING'; value.local!.ownership = 'MB_PENDING';
      value.local!.session_epoch = null; value.local!.roon_observation = { event: 'NONE', observed: false, correlation: 'UNKNOWN' } }],
    ['失败', value => { value.state = 'error'; value.local!.phase = 'FAILED'; value.local!.ownership = 'NONE' }],
    ['未确认暂停', value => { value.state = 'paused'; value.local!.phase = 'PAUSED'; value.local!.roon_observation.correlation = 'PARTIAL' }],
    ['非MB队列', value => { value.local!.queue_owner = 'ROON_NATIVE_EXTERNAL' }],
    ['缺会话', value => { value.state = 'paused'; value.local!.phase = 'PAUSED'; value.local!.session_epoch = null }],
    ['状态不同', value => { value.state = 'paused' }],
    ['目标Zone不同', value => { value.local!.target.zone_id = 'zone-b' }],
    ['当前Zone不同', value => { value.selectedZoneId = 'zone-b'; value.local!.target.zone_id = 'zone-b' }],
    ['曲目不同', value => { value.queue.items[0]!.local!.asset_revision = '2' }],
    ['无当前队列成员', value => { value.queue.items = []; value.queue.index = -1 }],
  ]
  for (const [name, change] of variants) {
    const value = localSeekSnapshot950(); change(value); let sends = 0
    const h = fixture({ getPlaybackStreamSnapshot: async () => localSeekEnvelope950(value),
      seek: async () => { sends++; return { positionMs: 50000 } } })
    t.after(() => h.session.dispose()); await h.session.initializePlaybackStream()
    const settled: (number | undefined)[] = []
    await h.session.seekPlayback(50000, result => settled.push(result))
    assert.equal(sends, 0, name); assert.deepEqual(settled, [undefined], name)
  }
})

for (const phase of ['PLAYING', 'PAUSED'] as const) {
  test(`本地seek950：compact已确认${phase}保原ACK加实际进度收口`, async t => {
    const value = localSeekSnapshot950(phase); let sends = 0, reads = 0
    const h = fixture({ getPlaybackStreamSnapshot: async () => { reads++; return localSeekEnvelope950(value) },
      seek: async () => { sends++; return { positionMs: 10000 } } })
    t.after(() => h.session.dispose()); await h.session.initializePlaybackStream()
    const settled: (number | undefined)[] = []
    await h.session.seekPlayback(50000, result => settled.push(result))
    assert.equal(sends, 1); assert.equal(reads, 2); assert.deepEqual(settled, [])
    h.session.acceptPlaybackStreamEvent({ event: 'playback.progress', payload: { stamp: stamp(2, { source: 'local_file' }), positionMs: 11000 } })
    assert.deepEqual(settled, [])
    h.session.acceptPlaybackStreamEvent({ event: 'playback.progress', payload: { stamp: stamp(3, { source: 'local_file' }), positionMs: 50000 } })
    assert.deepEqual(settled, [50000]); assert.deepEqual(h.errors, [])
  })
}

test('本地seek950：compact等待ACK失权后同身份恢复也不复活旧请求', async t => {
  const value = localSeekSnapshot950(), ack = deferred<{ positionMs: number }>(); let sends = 0, reads = 0
  const h = fixture({ getPlaybackStreamSnapshot: async () => { reads++; return localSeekEnvelope950(value) },
    seek: () => { sends++; return ack.promise } })
  t.after(() => h.session.dispose()); await h.session.initializePlaybackStream()
  const settled: (number | undefined)[] = [], pending = h.session.seekPlayback(50000, result => settled.push(result))
  h.session.acceptPlaybackStreamEvent({ event: 'playback.snapshot', payload: localSeekEnvelope950(localSeekSnapshot950('SUBMISSION_UNKNOWN'), 2) })
  assert.deepEqual(settled, [undefined])
  h.session.acceptPlaybackStreamEvent({ event: 'playback.snapshot', payload: localSeekEnvelope950(value, 3) })
  ack.resolve({ positionMs: 50000 }); await pending
  h.session.acceptPlaybackStreamEvent({ event: 'playback.progress', payload: { stamp: stamp(4, { source: 'local_file' }), positionMs: 50000 } })
  assert.equal(sends, 1); assert.equal(reads, 1); assert.deepEqual(settled, [undefined]); assert.deepEqual(h.errors, [])
})

test('本地seek950：compact ACK后失权使后续目标位置也不能确认旧草稿', async t => {
  const value = localSeekSnapshot950(); let sends = 0, reads = 0
  const h = fixture({ getPlaybackStreamSnapshot: async () => { reads++; return localSeekEnvelope950(value) },
    seek: async () => { sends++; return { positionMs: 10000 } } })
  t.after(() => h.session.dispose()); await h.session.initializePlaybackStream()
  const settled: (number | undefined)[] = []
  await h.session.seekPlayback(50000, result => settled.push(result))
  assert.deepEqual(settled, [])
  h.session.acceptPlaybackStreamEvent({ event: 'playback.snapshot', payload: localSeekEnvelope950(localSeekSnapshot950('SUBMISSION_UNKNOWN'), 2) })
  assert.deepEqual(settled, [undefined])
  h.session.acceptPlaybackStreamEvent({ event: 'playback.snapshot', payload: localSeekEnvelope950(localSeekSnapshot950('PLAYING', 50000), 3) })
  assert.equal(sends, 1); assert.equal(reads, 2); assert.deepEqual(settled, [undefined]); assert.deepEqual(h.errors, [])
})

test('本地seek950：attempt会话Core换代再恢复原值仍使旧ACK失效', async t => {
  const changes: readonly ((value: PlaybackSnapshot) => void)[] = [
    value => { value.local!.attempt_id = '30000000-0000-4000-8000-000000000005' },
    value => { value.local!.session_epoch = '合成新会话950' },
    value => { value.local!.target.core_id = '合成新Core950' },
  ]
  for (const change of changes) {
    const value = localSeekSnapshot950(), changed = structuredClone(value), ack = deferred<{ positionMs: number }>(); change(changed)
    let sends = 0, reads = 0
    const h = fixture({ getPlaybackStreamSnapshot: async () => { reads++; return localSeekEnvelope950(value) },
      seek: () => { sends++; return ack.promise } })
    t.after(() => h.session.dispose()); await h.session.initializePlaybackStream()
    const settled: (number | undefined)[] = [], pending = h.session.seekPlayback(50000, result => settled.push(result))
    h.session.acceptPlaybackStreamEvent({ event: 'playback.snapshot', payload: localSeekEnvelope950(changed, 2) })
    assert.deepEqual(settled, [undefined])
    h.session.acceptPlaybackStreamEvent({ event: 'playback.snapshot', payload: localSeekEnvelope950(value, 3) })
    ack.resolve({ positionMs: 50000 }); await pending
    assert.equal(sends, 1); assert.equal(reads, 1); assert.deepEqual(settled, [undefined]); assert.deepEqual(h.errors, [])
  }
})

test('本地seek950：legacy失权立即结束草稿且恢复后旧ACK只结算一次', async t => {
  const value = localSeekSnapshot950(), ack = deferred<{ positionMs: number }>(); let sends = 0, reads = 0
  const h = fixture({ getPlaybackStreamSnapshot: async () => null, getPlaybackState: async () => { reads++; return value },
    seek: () => { sends++; return ack.promise } })
  t.after(() => h.session.dispose()); await h.session.initializePlaybackStream()
  const settled: (number | undefined)[] = [], pending = h.session.seekPlayback(50000, result => settled.push(result))
  h.session.acceptPlaybackEvent(localSeekSnapshot950('SUBMISSION_UNKNOWN'))
  assert.deepEqual(settled, [undefined])
  h.session.acceptPlaybackEvent(value); ack.resolve({ positionMs: 50000 }); await pending
  assert.equal(sends, 1); assert.equal(reads, 1); assert.deepEqual(settled, [undefined]); assert.deepEqual(h.errors, [])
})

test('本地seek950：legacy挂起及时结束草稿且迟到ACK不得再结算', async t => {
  const ack = deferred<{ positionMs: number }>(); let sends = 0, reads = 0
  const h = fixture({ getPlaybackStreamSnapshot: async () => null, getPlaybackState: async () => { reads++; return localSeekSnapshot950() },
    seek: () => { sends++; return ack.promise } })
  t.after(() => h.session.dispose()); await h.session.initializePlaybackStream()
  const settled: (number | undefined)[] = [], pending = h.session.seekPlayback(50000, result => settled.push(result))
  h.session.suspendPlaybackStream(); assert.deepEqual(settled, [undefined])
  ack.resolve({ positionMs: 50000 }); await pending
  assert.equal(sends, 1); assert.equal(reads, 1); assert.deepEqual(settled, [undefined]); assert.deepEqual(h.errors, [])
})

test('本地seek950：legacy已确认播放暂停仍按原回执结束草稿', async t => {
  for (const phase of ['PLAYING', 'PAUSED'] as const) {
    let sends = 0, reads = 0
    const h = fixture({ getPlaybackStreamSnapshot: async () => null,
      getPlaybackState: async () => localSeekSnapshot950(phase, ++reads === 1 ? 10000 : 50000),
      seek: async () => { sends++; return { positionMs: 50000 } } })
    t.after(() => h.session.dispose()); await h.session.initializePlaybackStream()
    const settled: (number | undefined)[] = []
    await h.session.seekPlayback(50000, result => settled.push(result))
    assert.equal(sends, 1); assert.equal(reads, 2); assert.deepEqual(settled, [50000]); assert.deepEqual(h.errors, [])
  }
})
