import assert from 'node:assert/strict'
import test from 'node:test'
import type { LocalPlayReceipt, LocalPlayRequest, PlaybackSnapshot } from '@music-bridge/contracts'
import { useCatalogPlaybackRecovery } from '../src/renderer/src/composables/catalog/useCatalogPlaybackRecovery.js'

const original = (): LocalPlayRequest => ({ schema_version: '1.2', request_id: '原点播请求', route: 'roon_audio_input', source_kind: 'local_file',
  local_track_id: '本地曲目', asset_id: '本地资产', expected_asset_revision: '1', action: 'PLAY_NOW', target: { core_id: 'core', zone_id: 'zone' },
  context: { kind: 'artist', artistId: `local-artist:${'a'.repeat(64)}`, revision: 'r1' } })

function confirmed(request: LocalPlayRequest): PlaybackSnapshot {
  const track = { id: request.local_track_id, title: '合成播放观察', artists: ['合成作者'], album: '合成专辑' }
  return { state: 'playing', source: 'local_file', currentTrack: track, positionMs: 1000, selectedZoneId: request.target.zone_id,
    queue: { items: [], index: -1, hasNext: false, hasPrevious: false }, canNext: false, canPrevious: false, canPause: true, canResume: false, canStop: true,
    local: { schema_version: '1.2', request_id: request.request_id, attempt_id: '00000000-0000-4000-8000-000000000001', intent_generation: '1', route: request.route,
      local_track_id: track.id, asset_id: request.asset_id, asset_revision: request.expected_asset_revision, target: { ...request.target },
      session_epoch: '合成观察轮次', phase: 'PLAYING', ownership: 'MB_OWNED', queue_owner: 'MB', delivery_state: 'BYTES_SENT', position_ms: 1000,
      roon_observation: { event: 'TIME', observed: true, correlation: 'ATTEMPT_CONFIRMED' },
      quality: { http_bytes: 'NOT_TESTED', signal_path: 'NOT_TESTED', digital_output: 'NOT_TESTED', gapless: 'NOT_TESTED' }, error_code: null } }
}

test('4.1 原播放观察先到，迟到受理或传输失败不得复活等待提示', () => {
  for (const completion of ['accept', 'fail'] as const) {
    const request = original(), snapshot = confirmed(request)
    const recovery = useCatalogPlaybackRecovery({ readReceipt: async () => { throw new Error('不应重发或读取') }, getSnapshot: () => snapshot })
    recovery.begin(request); recovery.observe(snapshot)
    assert.equal(recovery.request.value, null); assert.equal(recovery.message.value, '')
    if (completion === 'accept') recovery.accept({ status: 'accepted', request_id: request.request_id, action: request.action })
    else recovery.fail(new Error('原观察已确认后的迟到运输失败'))
    assert.equal(recovery.request.value, null); assert.equal(recovery.message.value, '')
  }
})

test('4.1 换请求后旧受理、unsupported与失败不能清除新请求或改写提示', () => {
  const before = original(), next = { ...original(), request_id: '新点播请求' }
  const recovery = useCatalogPlaybackRecovery({ readReceipt: async () => { throw new Error('不应读取') }, getSnapshot: () => null })
  recovery.begin(before); recovery.observe(confirmed(before)); recovery.begin(next)
  const message = recovery.message.value
  recovery.accept({ status: 'accepted', request_id: before.request_id, action: before.action }, before)
  recovery.accept({ status: 'unsupported', reason: 'TARGET_AUTHORITY_UNAVAILABLE' }, before)
  recovery.fail(Object.assign(new Error('旧运输结果'), { outcome: 'not-sent' }), before)
  assert.equal(recovery.request.value?.request_id, next.request_id); assert.equal(recovery.message.value, message)
  recovery.accept({ status: 'accepted', request_id: before.request_id, action: before.action })
  assert.equal(recovery.request.value?.request_id, next.request_id); assert.equal(recovery.message.value, message)
})

test('4.1 仅明确not-sent解除原保护，单一SOURCE_CHANGED或未知结果仍保留', () => {
  const recovery = useCatalogPlaybackRecovery({ readReceipt: async () => { throw new Error('本用例不读回执') }, getSnapshot: () => null })
  recovery.begin(original()); recovery.fail(new Error('[SOURCE_CHANGED] 原状态已变化'))
  assert.ok(recovery.request.value); assert.match(recovery.message.value, /尚未确认/u)
  recovery.fail(Object.assign(new Error('[SOURCE_CHANGED] 预读失败'), { outcome: 'not-sent' }))
  assert.equal(recovery.request.value, null)
  recovery.begin(original()); recovery.fail(Object.assign(new Error('合成未知状态'), { outcome: 'unknown' })); assert.ok(recovery.request.value)
  recovery.fail(Object.defineProperty(new Error('不执行getter'), 'outcome', { get() { throw new Error('不能执行') } })); assert.ok(recovery.request.value)
})

test('4.1 显式核对只读取原request/context，missing/pending/accepted不自动重发或解除保护', async () => {
  let status: 'missing' | 'pending' | 'received' = 'missing'
  const reads: LocalPlayRequest[] = []
  const recovery = useCatalogPlaybackRecovery({ readReceipt: async request => {
    reads.push(request)
    return status === 'received' ? { status, request_id: request.request_id, action: request.action, result: { status: 'accepted', request_id: request.request_id, action: request.action } }
      : { status, request_id: request.request_id, action: request.action }
  }, getSnapshot: () => null })
  const request = original(); recovery.begin(request); request.target.zone_id = '新表单目标'
  await recovery.check(); assert.ok(recovery.request.value); assert.match(recovery.message.value, /没有原提交的回执/u)
  status = 'pending'; await recovery.check(); assert.ok(recovery.request.value); assert.match(recovery.message.value, /仍在处理/u)
  status = 'received'; await recovery.check(); assert.ok(recovery.request.value); assert.match(recovery.message.value, /等待原播放器/u)
  assert.equal(reads.length, 3); assert.ok(reads.every(read => read.request_id === '原点播请求' && read.target.zone_id === 'zone'))
  assert.deepEqual(reads[0]?.context, original().context)
})

test('4.1 外来或失败回执保留原请求，原明确拒绝或unsupported才允许用户重新选择', async () => {
  let response: LocalPlayReceipt = { status: 'rejected', request_id: '外来请求', action: 'PLAY_NOW', reason: 'REQUEST_REJECTED' }
  const recovery = useCatalogPlaybackRecovery({ readReceipt: async () => response, getSnapshot: () => null })
  recovery.begin(original()); await recovery.check(); assert.ok(recovery.request.value); assert.match(recovery.message.value, /无法读取/u)
  response = { ...response, request_id: original().request_id }; await recovery.check(); assert.equal(recovery.request.value, null); assert.match(recovery.message.value, /明确拒绝/u)
  recovery.begin(original()); response = { status: 'received', request_id: original().request_id, action: 'PLAY_NOW', result: { status: 'unsupported', reason: 'TARGET_AUTHORITY_UNAVAILABLE' } }
  await recovery.check(); assert.equal(recovery.request.value, null); assert.match(recovery.message.value, /不支持/u)
})
