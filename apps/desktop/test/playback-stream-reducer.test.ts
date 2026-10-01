import assert from 'node:assert/strict'
import test from 'node:test'
import type { PlaybackSnapshot, PlaybackStreamStamp } from '@music-bridge/contracts'
import { createPlaybackStreamReducer } from '../src/renderer/src/composables/application/playbackStreamReducer.js'

const instance = '10000000-0000-4000-8000-000000000001'
const other = '10000000-0000-4000-8000-000000000002'
function stamp(sequence: number, change: Partial<PlaybackStreamStamp> = {}): PlaybackStreamStamp {
  return { coreInstanceId: instance, generation: 1, sequence, queueRevision: 1, selectedZoneId: 'zone-a', trackId: '1', source: 'netease', ...change }
}
function snapshot(positionMs = 0): PlaybackSnapshot {
  return { state: 'playing', source: 'netease', selectedZoneId: 'zone-a', currentTrack: { id: '1', title: '合成曲目', artists: ['合成艺人'], album: '合成专辑', durationMs: 180000 }, positionMs,
    queue: { items: [{ trackId: '1', qualityPreference: 'auto' }], index: 0, hasNext: false, hasPrevious: false },
    canNext: false, canPrevious: false, canStop: true, canPause: true, canResume: false }
}
function seeded() { const r = createPlaybackStreamReducer(); r.authorize(instance); r.full({ stamp: stamp(1), snapshot: snapshot() }); return r }

test('MBP006 进度小更新复用5000队列且不访问items', () => {
  const r = seeded(), original = r.snapshot!
  original.queue.items = Array.from({ length: 5000 }, (_, i) => ({ trackId: String(i), qualityPreference: 'auto' as const }))
  let reads = 0
  const items = original.queue.items
  Object.defineProperty(original.queue, 'items', { get() { reads++; return items } })
  for (let i = 2; i <= 101; i++) r.delta({ kind: 'progress', stamp: stamp(i), positionMs: i * 1000 })
  assert.equal(r.snapshot!.positionMs, 101000); assert.equal(r.snapshot!.queue, original.queue)
  assert.equal(r.snapshot!.currentTrack, original.currentTrack); assert.equal(reads, 0)
})
test('MBP006 同序号命令full只ACK，不能倒退position', () => {
  const r = seeded(); r.delta({ kind: 'progress', stamp: stamp(2), positionMs: 2000 })
  assert.equal(r.full({ stamp: stamp(2), snapshot: snapshot(0) }), undefined)
  assert.equal(r.snapshot!.positionMs, 2000)
})
test('MBP006 未授权实例不能自授，旧full不能复活', () => {
  const r = seeded(); r.authorize(other)
  assert.equal(r.full({ stamp: stamp(99), snapshot: snapshot() }), undefined)
  r.full({ stamp: stamp(1, { coreInstanceId: other }), snapshot: snapshot(700) })
  r.delta({ kind: 'progress', stamp: stamp(2), positionMs: 9000 })
  assert.equal(r.snapshot!.positionMs, 700)
})
test('MBP006 state附queue原子推进；完整state清除旧optional字段', () => {
  const r = seeded(), s = { ...snapshot(100), currentTrack: undefined, source: undefined, selectedZoneId: undefined, state: 'idle' as const }
  const { queue: _q, ...state } = s
  const queue = { items: [], index: -1, hasNext: false, hasPrevious: false }
  r.delta({ kind: 'state', stamp: stamp(2, { generation: 2, queueRevision: 2, trackId: null, source: null, selectedZoneId: null }), state, queue })
  assert.equal(r.snapshot!.state, 'idle'); assert.equal(r.snapshot!.currentTrack, undefined)
  assert.equal(r.snapshot!.source, undefined); assert.equal(r.snapshot!.queue, queue); assert.equal(r.desynced, false)
})
for (const changes of [{ queueRevision: 2 }, { generation: 2 }, { selectedZoneId: 'zone-b' }, { trackId: '2' }, { source: 'roon' as const }]) {
  test(`MBP006 进度身份不匹配不能更新 ${JSON.stringify(changes)}`, () => {
    const r = seeded(); r.delta({ kind: 'progress', stamp: stamp(2, changes), positionMs: 10000 })
    assert.equal(r.snapshot!.positionMs, 0); assert.equal(r.desynced, true)
  })
}
test('MBP006 真sequencegap阻断delta；合法新序号seek可回退', () => {
  const r = seeded(); r.delta({ kind: 'progress', stamp: stamp(3), positionMs: 3000 }); assert.equal(r.desynced, true)
  r.full({ stamp: stamp(4), snapshot: snapshot(8000) })
  const { queue: _queue, ...state } = snapshot(1000)
  r.delta({ kind: 'state', stamp: stamp(5), state }); assert.equal(r.snapshot!.positionMs, 1000)
})
test('MBP006 seed在途百progress合并有连续覆盖，不误报gap', () => {
  const r = seeded(); r.beginSeed()
  for (let i = 2; i <= 101; i++) r.delta({ kind: 'progress', stamp: stamp(i), positionMs: i * 100 })
  r.endSeed({ stamp: stamp(1), snapshot: snapshot() })
  assert.equal(r.snapshot!.positionMs, 10100); assert.equal(r.stamp!.sequence, 101); assert.equal(r.desynced, false)
})
test('MBP006 暂存真gap不能谎称已同步', () => {
  const r = seeded(); r.beginSeed()
  r.delta({ kind: 'progress', stamp: stamp(3), positionMs: 3000 })
  r.endSeed({ stamp: stamp(1), snapshot: snapshot() })
  assert.equal(r.desynced, true); assert.equal(r.snapshot!.positionMs, 0)
})
test('MBP006 8MiB仅限暂存，超预算清stage；合法full5000不截断', () => {
  const r = seeded(); r.beginSeed()
  const large = snapshot(); large.queue.items = Array.from({ length: 5000 }, (_, i) => ({ trackId: String(i), qualityPreference: 'auto', track: { id: String(i), title: '合成'.repeat(1000), artists: [], album: '合成专辑' } }))
  const { queue, ...state } = large
  r.delta({ kind: 'state', stamp: stamp(2, { queueRevision: 2 }), state, queue })
  r.endSeed({ stamp: stamp(1), snapshot: snapshot() }); assert.equal(r.desynced, true)
  r.full({ stamp: stamp(3, { queueRevision: 2 }), snapshot: large })
  assert.equal(r.snapshot!.queue.items.length, 5000); assert.equal(r.desynced, false)
})
test('MBP006 覆盖必要queue依赖而seed未覆盖时不能拼错state', () => {
  const r = seeded(); r.beginSeed(); const { queue, ...state } = snapshot(2)
  r.delta({ kind: 'state', stamp: stamp(2, { queueRevision: 2 }), state, queue })
  r.delta({ kind: 'state', stamp: stamp(3, { queueRevision: 2 }), state: { ...state, state: 'paused' } })
  r.endSeed({ stamp: stamp(1), snapshot: snapshot() }); assert.equal(r.desynced, true)
})
