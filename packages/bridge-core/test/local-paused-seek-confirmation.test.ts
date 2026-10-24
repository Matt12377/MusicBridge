import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import type { LocalPlayRequest, PlaybackSnapshot } from '@music-bridge/contracts'
import { BridgeController } from '../src/application/bridge-controller.js'
import type { DatasetOwnerEndpoint } from '../src/collection/dataset-owner-protocol.js'
import type { LocalSourceCaptureResult } from '../src/collection/local-source-ticket-types.js'
import type { NeteasePort } from '../src/netease/types.js'
import { AssetLease, type LocalFileSourcePool, type LocalLeaseAuthority, type ReadonlyLocalFileDescriptor } from '../src/stream/local-file-source.js'
import { LocalSourceFence } from '../src/stream/local-source-fence.js'
import { StreamRegistry } from '../src/stream/registry.js'
import { StreamGateway } from '../src/stream/gateway.js'
import { adapterFixture, silentLogger } from './mbrs006/adapter-fixture.js'

async function finiteTurns(predicate: () => boolean, message: string): Promise<void> {
  for (let turn = 0; turn < 64; turn++) { if (predicate()) return; await new Promise<void>(resolve => setImmediate(resolve)) }
  assert.ok(predicate(), message)
}

/** 真实Controller/Adapter/Registry/AssetLease/fence；有限SDK和文件端口，不开FD/HTTP、不连接Roon。 */
async function pausedSeekFixture(t: test.TestContext) {
  let controller: BridgeController | undefined, gateway: StreamGateway | undefined, sdk: Awaited<ReturnType<typeof adapterFixture>> | undefined
  let unsubscribe: (() => void) | undefined, alive = true, sourceCurrent = true, openedFiles = 0, captures = 0
  const fences = new Map<string, LocalSourceFence>(), leases: AssetLease[] = [], flights: Promise<unknown>[] = [], snapshots: PlaybackSnapshot[] = []
  const restores: Array<() => void> = []
  const seeks: { target: number; acknowledged: boolean; acknowledge(): void }[] = []
  let closing: Promise<void> | undefined
  const close = () => closing ??= (async () => {
    const errors: unknown[] = [], finish = async (operation: () => unknown) => { try { await operation() } catch (error) { errors.push(error) } }
    // 先释放SDK端口，再由原shutdown撤权、等所有真实work与租约收口；flag不当quiet。
    for (const request of seeks) request.acknowledge()
    for (const callback of sdk?.sessions ?? []) await finish(() => callback('SessionBegan', { session_id: 'synthetic-seek-cleanup' }))
    await finish(() => controller?.shutdown()); await finish(() => sdk?.adapter.shutdown())
    await finish(async () => { await Promise.allSettled(flights) })
    for (const lease of leases) await finish(() => lease.close())
    for (const fence of fences.values()) { await finish(() => fence.revoke()); await finish(() => fence.assertQuiet()) }
    await finish(() => gateway?.stop()); await finish(() => unsubscribe?.())
    await finish(() => assert.equal(fences.size, 0)); await finish(() => assert.equal(openedFiles, 0))
    for (const lease of leases) await finish(() => assert.equal(lease.state, 'CLOSED'))
    if (sdk) await finish(() => assert.deepEqual(sdk!.adapter.getDiagnosticResourceCounters(), { activeSessionCount: 0, listenerCount: 0, timerCount: 0 }))
    for (const restore of [...restores].reverse()) await finish(restore)
    if (errors.length) throw new AggregateError(errors, '暂停seek合成夹具的真实资源收口失败。', { cause: errors[0] })
  })()
  t.after(close)
  const datasetId = randomUUID(), epoch = randomUUID(), rootId = randomUUID(), sourceRootId = randomUUID(), trackId = randomUUID(), assetId = randomUUID()
  const facts: LocalSourceCaptureResult['facts'] = {
    track: { id: trackId, assetId, selectionRevision: '1', segment: null },
    asset: { id: assetId, libraryRootId: rootId, sourceRootId, rootRevision: '1', fileRevision: '1', locationRevision: '1', sampleFrames: null, timebaseHz: null },
    root: { id: rootId, sourceRootId, role: 'library', revision: '1' },
    sourceRoot: { id: sourceRootId, path: '/synthetic-paused-seek-source', dev: '1', ino: '2', authorized: true, label: '合成源' }, relative: 'synthetic-seek.wav',
  }
  const attempts = new Map<string, number>()
  const pool = {
    async prepare(descriptor: ReadonlyLocalFileDescriptor, authority: LocalLeaseAuthority) {
      attempts.set(authority.ownerId, authority.attempt); openedFiles++; let closed = false
      const file = { size: 4, signature: 'synthetic-seek-signature',
        handle: { async read() { throw new Error('此进度测试不得读取媒体字节。') } } as unknown as FileHandle,
        async verify() { if (closed) throw new Error('合成文件已关闭。') },
        async close() { if (!closed) { closed = true; openedFiles-- } },
      }
      const lease = new AssetLease(file, descriptor, authority, () => attempts.get(authority.ownerId) === authority.attempt, () => {}, () => 0)
      leases.push(lease); return lease
    },
    async close() { const results = await Promise.allSettled(leases.map(lease => lease.close())); const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []); if (errors.length) throw new AggregateError(errors, '合成租约未全部收口。') },
  } as unknown as LocalFileSourcePool
  const registry = new StreamRegistry({ localSourcePool: pool })
  gateway = new StreamGateway({ host: '127.0.0.1', port: 0, publicBaseUrl: 'http://127.0.0.1:38502', registry, logger: silentLogger })
  const media = t.mock.method(gateway, 'localStreamUrl', (token: string) => { assert.ok(registry.getLocal(token)); return 'http://127.0.0.1:38502/synthetic-seek-media' }); restores.push(() => media.mock.restore())
  sdk = await adapterFixture(50_000, 38502)
  const seekPort = t.mock.method(sdk.core.services.RoonApiTransport, 'seek', (_zone: unknown, _how: unknown, seconds: unknown, callback: (error: false) => void) => {
    assert.equal(typeof seconds, 'number')
    const request = { target: (seconds as number) * 1000, acknowledged: false, acknowledge() { if (!request.acknowledged) { request.acknowledged = true; callback(false) } } }
    seeks.push(request); request.acknowledge()
  }); restores.push(() => seekPort.mock.restore())
  const localSources: DatasetOwnerEndpoint = {
    async prepare() { return { datasetId, epoch } }, async dispatch() { throw new Error('本进度测试不允许额外领域请求。') }, async commitBoot() {}, async close() {},
    isLocalSourceCurrent: () => alive && sourceCurrent,
    sealLocalSources() { alive = false; for (const fence of fences.values()) fence.revoke() },
    async saveMBQueue(request) { return structuredClone(request.queue) },
    async captureLocalSource(selection) {
      assert.equal(selection.local_track_id, facts.track.id); captures++
      const fence = LocalSourceFence.create(), ticketId = `synthetic-seek-ticket-${captures}`; fences.set(ticketId, fence)
      return { ticketId, epoch, datasetId, facts: structuredClone(facts), buffer: fence.buffer, format: 'wav',
        metadata: { id: facts.track.id, title: '合成暂停曲', artists: ['合成作者'], album: '合成专辑', durationMs: 180000 } }
    },
    async releaseLocalSource(ticketId) { const fence = fences.get(ticketId); if (!fence) return; fence.revoke(); fence.assertQuiet(); fences.delete(ticketId) },
    async revalidateLocalSource(ticketId) { return fences.get(ticketId)?.current === true },
  }
  const netease = new Proxy({ configured: false }, { get(target, key) { if (key === 'configured') return target.configured; throw new Error('进度测试不得调用Provider。') } }) as unknown as NeteasePort
  controller = new BridgeController({ localSources, roon: sdk.adapter, registry, gateway, netease, logger: silentLogger, isLocalPlaybackAllowed: () => true })
  sdk.adapter.setStateHandler(() => controller!.syncRoonTransportState())
  sdk.adapter.setTimeHandler(event => { controller!.updateRoonTime(event) })
  unsubscribe = controller.subscribe(snapshot => snapshots.push(structuredClone(snapshot)))
  const zone = (state: 'playing' | 'paused', positionMs: number, zoneId = 'synthetic-zone') => ({ zone_id: zoneId, state,
    outputs: [{ output_id: zoneId === 'synthetic-zone' ? 'synthetic-output' : 'synthetic-other-output' }],
    is_pause_allowed: true, is_play_allowed: true, is_seek_allowed: true, seek_position: positionMs / 1000 })
  const report = (positionMs: number, zoneId = 'synthetic-zone') => sdk!.zoneCallback('Changed', { zones_seek_changed: [{ zone_id: zoneId, seek_position: positionMs / 1000 }] })
  const start = async () => {
    const request: LocalPlayRequest = { schema_version: '1.2', request_id: randomUUID(), route: 'roon_audio_input', source_kind: 'local_file', action: 'PLAY_NOW',
      local_track_id: facts.track.id, asset_id: facts.asset.id, expected_asset_revision: '1', target: { core_id: 'synthetic-core', zone_id: 'synthetic-zone' } }
    const work = controller!.playLocal(request); flights.push(work); let rejected: unknown; void work.catch(error => { rejected = error })
    await finiteTurns(() => { if (rejected) throw rejected; return sdk!.sessions.length === 1 }, '原Adapter须进入本地begin_session。')
    sdk!.sessions[0]!('SessionBegan', { session_id: 'synthetic-seek-session' }); await work
    sdk!.zoneCallback('Changed', { zones_changed: [zone('playing', 10000)] })
    assert.equal(controller!.getPlaybackState().positionMs, 10000)
    sdk!.zoneCallback('Changed', { zones_changed: [zone('paused', 10000)] }); sdk!.plays[0]!('Paused', {})
    const snapshot = controller!.getPlaybackState()
    assert.equal(snapshot.state, 'paused'); assert.equal(snapshot.local?.phase, 'PAUSED'); assert.equal(snapshot.local?.roon_observation.correlation, 'ATTEMPT_CONFIRMED')
    assert.equal(sdk!.adapter.getState().transportState, 'paused'); return snapshot
  }
  const seek = (positionMs: number) => { const work = controller!.seek(positionMs); flights.push(work); void work.catch(() => {}); return work }
  return { controller, sdk, snapshots, report, zone, start, seek, close, seeks,
    waitSeek: (count: number) => finiteTurns(() => seeks.length === count, '原seek SDK须已派发，不能用测试直接造成功回执。'),
    loseSource: () => { sourceCurrent = false }, revokeFence: () => { for (const fence of fences.values()) fence.revoke() },
    counts: () => ({ captures, openedFiles, leases: leases.length }) }
}

test('暂停seek：真实新Zone观测发布实际位置，连续seek不重建会话/Source/租约且普通暂停Time仍拒', async t => {
  const f = await pausedSeekFixture(t), before = await f.start(), epoch = f.sdk.adapter.getActivePlaybackEpoch(), counts = f.counts()
  assert.equal(typeof epoch, 'number'); assert.ok(epoch !== undefined)
  const start = f.snapshots.length, first = f.seek(50000); await f.waitSeek(1)
  assert.equal(f.controller.getPlaybackState().positionMs, 10000)
  f.report(50000, 'synthetic-unrelated-zone'); assert.equal(f.controller.getPlaybackState().positionMs, 10000)
  f.report(49500); await first
  let snapshot = f.controller.getPlaybackState()
  assert.equal(snapshot.positionMs, 49500); assert.equal(snapshot.local?.position_ms, 49500); assert.equal(snapshot.state, 'paused')
  assert.equal(snapshot.local?.attempt_id, before.local?.attempt_id); assert.equal(snapshot.local?.session_epoch, before.local?.session_epoch)
  assert.ok(f.snapshots.slice(start).some(row => row.positionMs === 49500 && row.local?.position_ms === 49500))
  const second = f.seek(30000); await f.waitSeek(2); f.report(30000); await second
  snapshot = f.controller.getPlaybackState(); assert.equal(snapshot.positionMs, 30000); assert.equal(snapshot.local?.position_ms, 30000)
  const observation = f.sdk.adapter.getSelectedZonePlaybackObservation()!
  assert.equal(f.controller.updateRoonTime({ source: 'zone', zoneId: observation.zoneId, revision: observation.revision + 1,
    positionMs: 70000, playbackEpoch: epoch }), false)
  f.report(70000); assert.equal(f.controller.getPlaybackState().positionMs, 30000)
  assert.equal(f.sdk.adapter.getActivePlaybackEpoch(), epoch); assert.equal(f.sdk.sessions.length, 1); assert.equal(f.sdk.sends.length, 1)
  assert.deepEqual(f.counts(), counts); assert.deepEqual(f.seeks.map(row => row.target), [50000, 30000])
})

test('暂停seek：原SDK ACK与既有目标位置不够，必须等同Zone新revision', async t => {
  const f = await pausedSeekFixture(t); await f.start(); f.report(50000)
  assert.equal(f.controller.getPlaybackState().positionMs, 10000)
  let settled = false; const work = f.seek(50000); void work.then(() => { settled = true }, () => { settled = true }); await f.waitSeek(1)
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(settled, false)
  assert.equal(f.controller.getPlaybackState().positionMs, 10000)
  f.report(50000); await work; assert.equal(f.controller.getPlaybackState().positionMs, 50000)
})

for (const missing of ['无新revision', '旧adapter epoch', '目标外1500ms', '非暂停新观测'] as const) {
  test(`暂停seek：${missing}不能从请求值补造Controller进度`, async t => {
    const f = await pausedSeekFixture(t); await f.start()
    const originalEpoch = f.sdk.adapter.getActivePlaybackEpoch.bind(f.sdk.adapter); let changedEpoch = false
    if (missing === '无新revision') f.report(50000)
    if (missing === '旧adapter epoch') t.mock.method(f.sdk.adapter, 'getActivePlaybackEpoch', () => { const value = originalEpoch(); return changedEpoch && value !== undefined ? value + 1 : value })
    // 仅替换ACK端口以测试Controller的独立证据检查；成功主例仍经过原Adapter等待器。
    t.mock.method(f.sdk.adapter, 'seek', async () => {
      if (missing === '旧adapter epoch') { f.report(50000); changedEpoch = true }
      if (missing === '目标外1500ms') f.report(48500)
      if (missing === '非暂停新观测') f.sdk.zoneCallback('Changed', { zones_changed: [f.zone('playing', 50000)] })
    })
    await f.seek(50000)
    const snapshot = f.controller.getPlaybackState()
    assert.equal(snapshot.positionMs, 10000); assert.equal(snapshot.local?.position_ms, 10000)
    assert.equal(snapshot.local?.phase, 'PAUSED'); assert.equal(f.sdk.sessions.length, 1); assert.equal(f.sdk.sends.length, 1)
  })
}

for (const loss of ['Source', 'fence', 'Zone', 'session'] as const) {
  test(`暂停seek：SDK等待中真实${loss}撤销拒旧位置且不重发mutation`, async t => {
    const f = await pausedSeekFixture(t), original = await f.start(), baseline = f.counts(), start = f.snapshots.length
    assert.equal(baseline.captures, 2, '原点播先初次捕获，派发前再实读第二次；seek不得新增捕获。')
    const work = f.seek(50000); const rejected = assert.rejects(work); await f.waitSeek(1)
    if (loss === 'Source') f.loseSource()
    else if (loss === 'fence') f.revokeFence()
    else if (loss === 'session') f.sdk.unpair()
    else {
      f.sdk.zoneCallback('Changed', { zones_added: [f.zone('paused', 10000, 'synthetic-other-zone')] })
      f.sdk.adapter.selectZone('synthetic-other-zone')
    }
    f.report(50000); await rejected
    const after = f.controller.getPlaybackState()
    assert.notEqual(after.positionMs, 50000)
    assert.ok(!f.snapshots.slice(start).some(row => row.local?.attempt_id === original.local?.attempt_id && row.local?.position_ms === 50000))
    assert.equal(f.seeks.length, 1); assert.equal(f.sdk.sessions.length, 1); assert.equal(f.sdk.sends.length, 1); assert.equal(f.counts().captures, baseline.captures)
  })
}
