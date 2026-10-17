import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import type { LocalPlayRequest, PlaybackSnapshot } from '@music-bridge/contracts'
import { BridgeController } from '../src/application/bridge-controller.js'
import type { DatasetOwnerEndpoint } from '../src/collection/dataset-owner-protocol.js'
import type { LocalSourceCaptureResult } from '../src/collection/local-source-ticket-types.js'
import type { NeteasePort } from '../src/netease/types.js'
import { AssetLease, LocalFileLeaseError, type LocalFileSourcePool, type LocalLeaseAuthority, type ReadonlyLocalFileDescriptor } from '../src/stream/local-file-source.js'
import { LocalSourceFence } from '../src/stream/local-source-fence.js'
import { StreamRegistry } from '../src/stream/registry.js'
import { StreamGateway } from '../src/stream/gateway.js'
import { adapterFixture, silentLogger } from './mbrs006/adapter-fixture.js'
import { localPlaybackSubmissionUnconfirmed } from '../../../apps/desktop/src/renderer/src/components/player/details.js'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
async function finiteTurns(predicate: () => boolean, message: string): Promise<void> {
  for (let turn = 0; turn < 64; turn++) { if (predicate()) return; await new Promise<void>(resolve => setImmediate(resolve)) }
  assert.ok(predicate(), message)
}
type RenewalResult = { ok: true; value: boolean } | { ok: false; reason: unknown }
type IntervalToken = { milliseconds: number; invoke(): void; unref(): IntervalToken }
interface HeldEnd { delivered: boolean; complete(message?: unknown): void }

/** 真实Controller/Adapter/Registry/AssetLease/fence；文件与SDK仅有限合成端口，不开FD/网络/Native。 */
async function stopRaceFixture(t: test.TestContext) {
  let controller: BridgeController | undefined, sdk: Awaited<ReturnType<typeof adapterFixture>> | undefined, gateway: StreamGateway | undefined
  let unsubscribe: (() => void) | undefined, alive = true, sourceCurrent = true, holdEnds = false, autoBegin = false, openedFiles = 0
  let renewal: ReturnType<typeof deferred<RenewalResult>> | undefined, renewalCalls = 0
  const intervals = new Set<IntervalToken>(), fences = new Map<string, LocalSourceFence>(), leases: AssetLease[] = []
  const filePorts = new Map<AssetLease, { readGate?: ReturnType<typeof deferred<void>>; readEntered: boolean }>()
  const endCallbacks: HeldEnd[] = [], snapshots: PlaybackSnapshot[] = [], flights: Promise<unknown>[] = [], restores: Array<() => void> = []
  const releaseControls: Array<() => void> = []
  const submissions = new WeakMap<Promise<unknown>, { rejected?: { reason: unknown } }>()
  let firstSubmissionFailure: { reason: unknown } | undefined
  let captures = 0
  // 原timer callback由受控clock端口驱动；不调用Controller私有方法，不真实等250ms。
  const intervalMock = t.mock.method(globalThis, 'setInterval', ((callback: (...args: unknown[]) => unknown, milliseconds = 0, ...args: unknown[]) => {
    const token: IntervalToken = { milliseconds, invoke: () => { callback(...args) }, unref() { return this } }
    intervals.add(token); return token
  }) as unknown as typeof setInterval)
  const clearIntervalMock = t.mock.method(globalThis, 'clearInterval', ((token: unknown) => { intervals.delete(token as IntervalToken) }) as typeof clearInterval)
  restores.push(() => intervalMock.mock.restore(), () => clearIntervalMock.mock.restore())
  let closing: Promise<void> | undefined
  const closeFixture = (): Promise<void> => closing ??= (async () => {
    const errors: unknown[] = [], close = async (operation: () => unknown) => { try { await operation() } catch (error) { errors.push(error) } }
    holdEnds = false; autoBegin = true
    renewal?.resolve({ ok: true, value: true })
    for (const port of filePorts.values()) port.readGate?.resolve()
    for (const release of releaseControls) await close(release)
    for (const end of endCallbacks) if (!end.delivered) await close(() => end.complete())
    for (const callback of sdk?.sessions ?? []) await close(() => callback('SessionBegan', { session_id: 'synthetic-cleanup-session' }))
    await close(() => controller?.shutdown())
    await close(() => sdk?.adapter.shutdown())
    await close(async () => { await Promise.allSettled(flights) })
    for (const lease of leases) await close(() => lease.close())
    for (const fence of fences.values()) { await close(() => fence.revoke()); await close(() => fence.assertQuiet()) }
    await close(() => gateway?.stop()); await close(() => unsubscribe?.())
    await close(() => assert.equal(fences.size, 0)); await close(() => assert.equal(openedFiles, 0)); await close(() => assert.equal(intervals.size, 0))
    for (const lease of leases) await close(() => assert.equal(lease.state, 'CLOSED'))
    if (sdk) await close(() => assert.deepEqual(sdk!.adapter.getDiagnosticResourceCounters(), { activeSessionCount: 0, listenerCount: 0, timerCount: 0 }))
    for (const restore of [...restores].reverse()) await close(restore)
    if (errors.length) {
      const all = firstSubmissionFailure ? [firstSubmissionFailure.reason, ...errors] : errors
      throw new AggregateError(all, '原playLocal首错与停止所有权合成组件清理错分别保留。', { cause: all[0] })
    }
  })()
  t.after(closeFixture)

  const datasetId = randomUUID(), epoch = randomUUID(), rootId = randomUUID(), sourceRootId = randomUUID()
  const facts = Array.from({ length: 2 }, (): LocalSourceCaptureResult['facts'] => {
    const trackId = randomUUID(), assetId = randomUUID()
    return { track: { id: trackId, assetId, selectionRevision: '1', segment: null },
      asset: { id: assetId, libraryRootId: rootId, sourceRootId, rootRevision: '1', fileRevision: '1', locationRevision: '1', sampleFrames: null, timebaseHz: null },
      root: { id: rootId, sourceRootId, role: 'library', revision: '1' }, sourceRoot: { id: sourceRootId, path: '/synthetic-stop-source', dev: '1', ino: '2', authorized: true, label: '合成源' }, relative: `synthetic-${trackId}.wav` }
  })
  const attempts = new Map<string, number>()
  const poolPort = {
    async prepare(descriptor: ReadonlyLocalFileDescriptor, authority: LocalLeaseAuthority) {
      attempts.set(authority.ownerId, authority.attempt); openedFiles++
      const port: { readGate?: ReturnType<typeof deferred<void>>; readEntered: boolean } = { readEntered: false }
      let closed = false
      const file = { size: 4, signature: 'synthetic-stop-signature', handle: { async read() { port.readEntered = true; if (port.readGate) await port.readGate.promise; throw new Error('合成原read失败，不返回媒体字节。') } } as unknown as FileHandle,
        async verify() { if (closed) throw new Error('合成文件已关闭。') },
        async close() { if (!closed) { closed = true; openedFiles-- } } }
      const lease = new AssetLease(file, descriptor, authority, () => attempts.get(authority.ownerId) === authority.attempt, () => {}, () => 0)
      leases.push(lease); filePorts.set(lease, port); return lease
    },
    async close() { const results = await Promise.allSettled(leases.map(lease => lease.close())); const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []); if (errors.length) throw new AggregateError(errors, '合成租约未全部关闭。', { cause: errors[0] }) },
  } as unknown as LocalFileSourcePool
  const registry = new StreamRegistry({ localSourcePool: poolPort })
  gateway = new StreamGateway({ host: '127.0.0.1', port: 0, publicBaseUrl: 'http://127.0.0.1:38502', registry, logger: silentLogger })
  // 本例不监听HTTP；仅URL端口给固定合成地址，原Registry/AssetLease仍须真实存在。
  const mediaUrl = t.mock.method(gateway, 'localStreamUrl', (token: string) => { assert.ok(registry.getLocal(token)); return 'http://127.0.0.1:38502/synthetic-stop-media' })
  restores.push(() => mediaUrl.mock.restore())
  sdk = await adapterFixture(50_000, 38502)
  const originalBegin = sdk.core.services.RoonApiAudioInput.begin_session.bind(sdk.core.services.RoonApiAudioInput)
  const beginMock = t.mock.method(sdk.core.services.RoonApiAudioInput, 'begin_session', (options: unknown, callback: (message: unknown, body: unknown) => void) => {
    const session = originalBegin(options, callback)
    if (autoBegin) queueMicrotask(() => callback('SessionBegan', { session_id: `synthetic-auto-${sdk!.sessions.length}` }))
    return { ...session, end_session(closeCallback: (message: unknown, body: unknown) => void) {
      session.end_session((message, body) => {
        const entry: HeldEnd = { delivered: false, complete(replacement = message) { if (entry.delivered) return; entry.delivered = true; closeCallback(replacement, body) } }
        endCallbacks.push(entry); if (!holdEnds) entry.complete()
      })
    } }
  })
  restores.push(() => beginMock.mock.restore())
  const localSources: DatasetOwnerEndpoint = {
    async prepare() { return { datasetId, epoch } }, async dispatch() { throw new Error('null发行本例不允许额外领域请求。') }, async commitBoot() {}, async close() {},
    isLocalSourceCurrent: () => alive && sourceCurrent,
    sealLocalSources() { alive = false; for (const fence of fences.values()) fence.revoke() },
    async saveMBQueue(request) { return structuredClone(request.queue) },
    async captureLocalSource(selection) {
      const f = facts.find(item => item.track.id === selection.local_track_id); assert.ok(f)
      const fence = LocalSourceFence.create(), ticketId = `synthetic-stop-ticket-${++captures}`; fences.set(ticketId, fence)
      return { ticketId, epoch, datasetId, facts: structuredClone(f), buffer: fence.buffer, format: 'wav', metadata: { id: f.track.id, title: '合成停止曲', artists: ['合成作者'], album: '合成专辑' } }
    },
    async releaseLocalSource(ticketId) { const fence = fences.get(ticketId); if (!fence) return; fence.revoke(); fence.assertQuiet(); fences.delete(ticketId) },
    async revalidateLocalSource(ticketId) { renewalCalls++; const gate = renewal; renewal = undefined; if (gate) { const result = await gate.promise; if (!result.ok) throw result.reason; return result.value }; return fences.get(ticketId)?.current === true },
  }
  const netease = new Proxy({ configured: false }, { get(target, key) { if (key === 'configured') return target.configured; throw new Error('停止测试不得调用Provider。') } }) as unknown as NeteasePort
  controller = new BridgeController({ localSources, roon: sdk.adapter, registry, gateway, netease, logger: silentLogger, isLocalPlaybackAllowed: () => true })
  sdk.adapter.setStateHandler(() => controller!.syncRoonTransportState())
  unsubscribe = controller.subscribe(snapshot => snapshots.push(structuredClone(snapshot)))
  const request = (index = 0): LocalPlayRequest => ({ schema_version: '1.2', request_id: randomUUID(), route: 'roon_audio_input', source_kind: 'local_file', action: 'PLAY_NOW',
    local_track_id: facts[index]!.track.id, asset_id: facts[index]!.asset.id, expected_asset_revision: '1', target: { core_id: 'synthetic-core', zone_id: 'synthetic-zone' } })
  const submit = (value: LocalPlayRequest) => {
    const work = controller!.playLocal(value), observed: { rejected?: { reason: unknown } } = {}
    flights.push(work); submissions.set(work, observed)
    void work.then(() => {}, reason => { observed.rejected = { reason }; firstSubmissionFailure ??= observed.rejected })
    return work
  }
  const start = async (index = 0) => {
    const value = request(index), before = sdk!.sessions.length, work = submit(value)
    await finiteTurns(() => { const rejected = submissions.get(work)?.rejected; if (rejected) throw rejected.reason; return sdk!.sessions.length > before }, '原Adapter须进入begin_session。')
    sdk!.sessions.at(-1)!('SessionBegan', { session_id: `synthetic-state-${sdk!.sessions.length}` }); await work
    assert.equal(controller!.getPlaybackState().local?.phase, 'PLAYING'); return value
  }
  const holdRenewal = async () => {
    const gate = deferred<RenewalResult>(); renewal = gate; releaseControls.push(() => gate.resolve({ ok: true, value: true })); const before = renewalCalls
    const active = [...intervals].filter(timer => timer.milliseconds === 250); assert.equal(active.length, 1); active[0]!.invoke()
    await finiteTurns(() => renewalCalls === before + 1, '须进入原250ms回调的真实revalidate调用。'); return gate
  }
  const holdStop = async () => { holdEnds = true; const before = endCallbacks.length, work = controller!.stop(); flights.push(work); void work.catch(() => {}); await finiteTurns(() => endCallbacks.length > before, '原Adapter须真实调用原session.end_session。'); return { work, end: endCallbacks.at(-1)! } }
  const targetLoss = () => sdk!.zoneCallback('Changed', { zones_changed: [{ zone_id: 'synthetic-zone', state: 'playing', outputs: [{ output_id: 'synthetic-output' }, { output_id: 'synthetic-other-output' }], is_pause_allowed: true, is_play_allowed: true }] })
  const latestLease = () => { const lease = leases.at(-1); assert.ok(lease); return lease }
  const holdReadFailure = async () => {
    const lease = latestLease(), port = filePorts.get(lease)!; port.readGate = deferred<void>(); port.readEntered = false
    const read = lease.readSlice(0, 0, new AbortController().signal).next(); void read.catch(() => {}); flights.push(read)
    await finiteTurns(() => port.readEntered, '原AssetLease须已通过verify并进入原read，再开始停止。')
    return { lease, read, release: () => port.readGate!.resolve() }
  }
  const holdDevice = async () => {
    const gate = deferred<void>(), entered = deferred<void>(), pause = t.mock.method(sdk!.adapter, 'pause', async () => { entered.resolve(); await gate.promise })
    restores.push(() => pause.mock.restore()); releaseControls.push(() => gate.resolve())
    const work = controller!.pause(); flights.push(work); void work.catch(() => {}); await entered.promise; return { work, release: () => gate.resolve() }
  }
  const holdBeforeDispatch = () => {
    const gate = deferred<void>(), entered = deferred<void>(), originalStop = sdk!.adapter.stop.bind(sdk!.adapter), originalPlay = sdk!.adapter.play.bind(sdk!.adapter)
    let first = true, originalRequest: Parameters<typeof originalPlay>[0] | undefined
    const stop = t.mock.method(sdk!.adapter, 'stop', async (options?: Parameters<typeof originalStop>[0]) => { if (first) { first = false; entered.resolve(); await gate.promise }; return originalStop(options) })
    const play = t.mock.method(sdk!.adapter, 'play', (value: Parameters<typeof originalPlay>[0]) => { originalRequest ??= value; return originalPlay(value) })
    restores.push(() => stop.mock.restore(), () => play.mock.restore()); releaseControls.push(() => gate.resolve())
    return { entered: entered.promise, release: () => gate.resolve(), lateDispatch: () => { assert.ok(originalRequest?.onDispatch); originalRequest.onDispatch() } }
  }
  return { controller, sdk, registry, snapshots, endCallbacks, latestLease, request, submit, start, holdRenewal, holdStop, holdReadFailure, holdDevice, holdBeforeDispatch, targetLoss, close: closeFixture,
    loseSource: () => { sourceCurrent = false }, allowAutomaticBegin: () => { autoBegin = true }, holdEnds: () => { holdEnds = true }, counts: () => ({ captures, openFiles: openedFiles, leases: leases.length }) }
}

async function withClosedFixture(t: test.TestContext, operation: (fixture: Awaited<ReturnType<typeof stopRaceFixture>>) => Promise<void>): Promise<void> {
  const fixture = await stopRaceFixture(t), failures: unknown[] = []
  try { await operation(fixture) } catch (error) { failures.push(error) }
  try { await fixture.close() } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, '原行为失败与该合成夹具清理失败分别保留。', { cause: failures[0] })
}

function sameOriginal(snapshot: PlaybackSnapshot, request: LocalPlayRequest, attempt: string): void {
  assert.equal(snapshot.local?.request_id, request.request_id); assert.equal(snapshot.local?.attempt_id, attempt)
}
function assertUnknown(snapshot: PlaybackSnapshot): void { assert.equal(snapshot.local?.ownership, 'UNKNOWN'); assert.equal(localPlaybackSubmissionUnconfirmed(snapshot), true) }

test('停止所有权竞态：原SDK等待与正常ACK同步通知不假lost，原终态后新本地可播且旧回调隔离', async t => {
  const f = await stopRaceFixture(t), a = await f.start(), attempt = f.controller.getPlaybackState().local!.attempt_id, renewal = await f.holdRenewal(), stopped = await f.holdStop()
  f.controller.syncRoonTransportState()
  let snapshot = f.controller.getPlaybackState(); sameOriginal(snapshot, a, attempt); assert.equal(snapshot.state, 'stopping'); assert.equal(snapshot.local?.phase, 'PLAYING'); assert.equal(snapshot.local?.ownership, 'MB_OWNED')
  const lease = f.latestLease(); await assert.rejects(lease.verify(), error => error instanceof LocalFileLeaseError && error.code === 'STALE_ATTEMPT'); await lease.close()
  renewal.resolve({ ok: true, value: true }); await finiteTurns(() => f.controller.getPlaybackState().state === 'stopping', '仍应等待原停止确认。'); await new Promise<void>(resolve => setImmediate(resolve)); f.controller.syncRoonTransportState()
  snapshot = f.controller.getPlaybackState(); sameOriginal(snapshot, a, attempt); assert.equal(snapshot.local?.phase, 'PLAYING'); assert.equal(snapshot.local?.ownership, 'MB_OWNED')
  const beforeAck = f.snapshots.length; stopped.end.complete(); await stopped.work
  const terminal = f.controller.getPlaybackState(); sameOriginal(terminal, a, attempt); assert.equal(terminal.local?.phase, 'CANCELLED'); assert.equal(terminal.local?.ownership, 'NONE'); assert.equal(localPlaybackSubmissionUnconfirmed(terminal), false)
  assert.ok(f.snapshots.slice(beforeAck).some(row => row.local?.request_id === a.request_id && row.local.attempt_id === attempt && row.local.phase === 'CANCELLED' && row.local.ownership === 'NONE'))
  const b = await f.start(1), stable = f.controller.getPlaybackState(); assert.equal(stable.local?.request_id, b.request_id); assert.notEqual(stable.local?.attempt_id, attempt)
  const sends = f.sdk.sends.length, begins = f.sdk.sessions.length
  f.sdk.sessions[0]!('SessionBegan', { session_id: 'synthetic-late-A' }); f.sdk.plays[0]!('Playing', {}); f.sdk.plays[0]!('SessionEnded', {}); await new Promise<void>(resolve => setImmediate(resolve))
  const afterLate = f.controller.getPlaybackState(); assert.equal(afterLate.local?.request_id, b.request_id); assert.equal(afterLate.local?.attempt_id, stable.local?.attempt_id); assert.equal(afterLate.local?.phase, 'PLAYING'); assert.equal(f.sdk.sessions.length, begins); assert.equal(f.sdk.sends.length, sends)
})

test('停止所有权竞态：原stop拒绝及迟到renew取消保锁，明确retry再次调用原SDK后才终态', async t => {
  const f = await stopRaceFixture(t), a = await f.start(), attempt = f.controller.getPlaybackState().local!.attempt_id, renewal = await f.holdRenewal(), stopped = await f.holdStop()
  const rejected = assert.rejects(stopped.work, { code: 'ROON_TIMEOUT' }); stopped.end.complete('Failure'); await rejected
  renewal.resolve({ ok: true, value: true }); await new Promise<void>(resolve => setImmediate(resolve)); f.controller.syncRoonTransportState()
  const failed = f.controller.getPlaybackState(); sameOriginal(failed, a, attempt); assert.equal(failed.state, 'error'); assert.equal(failed.local?.phase, 'PLAYING'); assert.equal(failed.local?.ownership, 'MB_OWNED'); assert.equal(failed.canStop, true)
  const begins = f.sdk.sessions.length, sends = f.sdk.sends.length; f.allowAutomaticBegin()
  await assert.rejects(f.submit(f.request(1)), { code: 'ROON_TRANSPORT_UNAVAILABLE' }); assert.equal(f.sdk.sessions.length, begins); assert.equal(f.sdk.sends.length, sends)
  const ended = f.sdk.ends(), retried = await f.holdStop(); assert.equal(f.sdk.ends(), ended + 1); sameOriginal(f.controller.getPlaybackState(), a, attempt)
  retried.end.complete(); await retried.work; const terminal = f.controller.getPlaybackState(); sameOriginal(terminal, a, attempt); assert.equal(terminal.local?.phase, 'CANCELLED'); assert.equal(terminal.local?.ownership, 'NONE')
})

test('停止所有权竞态：heldstop中真实target源lease或session丢失仍保UNKNOWN', async t => {
  for (const loss of ['target', 'source', 'lease', 'session'] as const) {
    await withClosedFixture(t, async f => {
      const a = await f.start(), attempt = f.controller.getPlaybackState().local!.attempt_id
      const reading = loss === 'lease' ? await f.holdReadFailure() : undefined, stopped = await f.holdStop()
      if (loss === 'target') f.targetLoss()
      else if (loss === 'source') f.loseSource()
      else if (loss === 'session') f.sdk.unpair()
      else { reading!.release(); await assert.rejects(reading!.read, /合成原read失败/u); await reading!.lease.close(); assert.equal(reading!.lease.state, 'CLOSED'); assert.equal(reading!.lease.failureCode, null, '原read异常的关闭原因未知，不得归为主动取消。') }
      f.controller.syncRoonTransportState(); sameOriginal(f.controller.getPlaybackState(), a, attempt); assertUnknown(f.controller.getPlaybackState())
      if (loss === 'session') { const rejected = assert.rejects(stopped.work, { code: 'ROON_TIMEOUT' }); stopped.end.complete('Failure'); await rejected }
      else { stopped.end.complete(); await stopped.work }
      const after = f.controller.getPlaybackState(); sameOriginal(after, a, attempt); assert.equal(after.local?.phase, 'OWNERSHIP_LOST'); assertUnknown(after); assert.equal(f.sdk.sessions.length, 1); assert.equal(f.sdk.sends.length, 1)
    })
  }
})

test('停止所有权竞态：原revalidate实际false或拒绝不得被停止意图洗掉', async t => {
  for (const outcome of [{ ok: true as const, value: false }, { ok: false as const, reason: new Error('合成原重验证失败。') }]) {
    await withClosedFixture(t, async f => {
      const a = await f.start(), attempt = f.controller.getPlaybackState().local!.attempt_id, renewal = await f.holdRenewal(), stopped = await f.holdStop()
      renewal.resolve(outcome); await finiteTurns(() => f.controller.getPlaybackState().local?.phase === 'OWNERSHIP_LOST', '原重验证失败必须成为真实lost。')
      sameOriginal(f.controller.getPlaybackState(), a, attempt); assertUnknown(f.controller.getPlaybackState()); stopped.end.complete(); await stopped.work
      sameOriginal(f.controller.getPlaybackState(), a, attempt); assertUnknown(f.controller.getPlaybackState()); assert.equal(f.sdk.sessions.length, 1)
    })
  }
})

test('停止所有权竞态：原未确认提交仍保护，不借sync或无新owner判断解除', async t => {
  const f = await stopRaceFixture(t); t.mock.timers.enable({ apis: ['setTimeout'] }); t.after(() => t.mock.timers.reset())
  const request = f.request(), work = f.submit(request); await finiteTurns(() => f.sdk.sessions.length === 1, '原begin已发送但不注入SessionBegan。')
  t.mock.timers.tick(50_001); await work
  const before = f.controller.getPlaybackState(), attempt = before.local!.attempt_id; sameOriginal(before, request, attempt); assert.equal(before.local?.phase, 'SUBMISSION_UNKNOWN'); assertUnknown(before)
  f.controller.syncRoonTransportState(); const after = f.controller.getPlaybackState(); sameOriginal(after, request, attempt); assert.equal(after.local?.phase, 'SUBMISSION_UNKNOWN'); assertUnknown(after); assert.equal(f.sdk.sessions.length, 1); assert.equal(f.sdk.sends.length, 0)
})

test('停止所有权竞态：原真实OWNERSHIP_LOST在无owner停止后仍不伪装CANCELLED', async t => {
  const f = await stopRaceFixture(t), request = await f.start(), attempt = f.controller.getPlaybackState().local!.attempt_id
  f.sdk.unpair(); await new Promise<void>(resolve => setImmediate(resolve)); const lost = f.controller.getPlaybackState(); sameOriginal(lost, request, attempt); assert.equal(lost.local?.phase, 'OWNERSHIP_LOST'); assertUnknown(lost)
  await f.controller.stop(); f.controller.syncRoonTransportState(); const after = f.controller.getPlaybackState(); sameOriginal(after, request, attempt); assert.equal(after.local?.phase, 'OWNERSHIP_LOST'); assertUnknown(after); assert.equal(f.sdk.sessions.length, 1)
})

test('停止所有权竞态：device等待后真实target失效触发原skip，零SDKstop也不能授CANCELLED', async t => {
  for (const loss of ['target', 'session-without-loss-event'] as const) await withClosedFixture(t, async f => {
    const request = await f.start(), attempt = f.controller.getPlaybackState().local!.attempt_id, target = f.sdk.adapter.captureLocalTarget(), device = await f.holdDevice()
    assert.ok(target); assert.equal(target.isCurrent(), true)
    const paused = assert.rejects(device.work), ends = f.sdk.ends(), stopped = f.controller.stop(); void stopped.catch(() => {})
    await finiteTurns(() => f.controller.getPlaybackState().state === 'stopping', 'stopActive须已受理且其device尚未执行。')
    if (loss === 'target') f.targetLoss()
    else {
      // 原SDK事件不发OWNERSHIP_LOST；保留真实terminalHandler，先排队再由Adapter清原context。
      f.sdk.plays.at(-1)!('StoppedUser', {})
      assert.equal(f.sdk.adapter.getDiagnosticResourceCounters().activeSessionCount, 0)
      assert.equal(target.isCurrent(), true); assert.equal(f.latestLease().state, 'ACTIVE'); assert.equal(f.latestLease().failureCode, null); assert.equal(f.latestLease().signal.aborted, false)
      f.controller.syncRoonTransportState()
      const beforeDevice = f.controller.getPlaybackState(); sameOriginal(beforeDevice, request, attempt)
      assert.equal(beforeDevice.state, 'stopping'); assert.equal(beforeDevice.local?.phase, 'PLAYING'); assert.equal(beforeDevice.local?.ownership, 'MB_OWNED'); assert.equal(f.sdk.ends(), ends)
    }
    device.release(); await paused; await stopped
    // 原terminalHandler在stop之后结算；其token/generation屏障不得将UNKNOWN洗成终态。
    await new Promise<void>(resolve => setImmediate(resolve))
    const after = f.controller.getPlaybackState(); sameOriginal(after, request, attempt); assert.equal(after.local?.phase, 'OWNERSHIP_LOST'); assertUnknown(after); assert.equal(f.sdk.ends(), ends, '原guard已skip，不能虚称SDK停止ACK。')
    assert.equal(f.sdk.sessions.length, 1); assert.equal(f.sdk.sends.length, 1)
  })
})


test('停止所有权竞态：原lease已注册但SDK未dispatch的NOT_STARTED取消仍为原终态且零SDK', async t => {
  for (const changeTarget of [false, true]) await withClosedFixture(t, async f => {
    const beforeDispatch = f.holdBeforeDispatch(), request = f.request(), work = f.submit(request)
    await beforeDispatch.entered
    const intercepted = f.controller.getPlaybackState(), attempt = intercepted.local!.attempt_id
    sameOriginal(intercepted, request, attempt); assert.equal(intercepted.local?.phase, 'SUBMITTING'); assert.equal(intercepted.local?.ownership, 'MB_PENDING'); assert.equal(intercepted.local?.delivery_state, 'NOT_STARTED'); assert.equal(f.latestLease().state, 'PREPARED')
    const rejected = assert.rejects(work), stopped = f.controller.stop(); void stopped.catch(() => {})
    // 真Adapter的stateHandler同步进入public sync；未发送取消也不能因target此刻变化伪造UNKNOWN。
    if (changeTarget) f.targetLoss()
    beforeDispatch.release(); await rejected; await stopped
    const after = f.controller.getPlaybackState(); sameOriginal(after, request, attempt)
    assert.equal(after.local?.phase, 'CANCELLED'); assert.equal(after.local?.ownership, 'NONE'); assert.equal(after.local?.delivery_state, 'NOT_STARTED'); assert.equal(localPlaybackSubmissionUnconfirmed(after), false)
    assert.equal(f.sdk.sessions.length, 0); assert.equal(f.sdk.sends.length, 0); assert.equal(f.sdk.ends(), 0)
    assert.ok(f.snapshots.some(row => row.local?.request_id === request.request_id && row.local.attempt_id === attempt && row.local.phase === 'CANCELLED' && row.local.ownership === 'NONE'))
    const b = await f.start(1), stable = f.controller.getPlaybackState(), begins = f.sdk.sessions.length, sends = f.sdk.sends.length, ends = f.sdk.ends()
    assert.throws(() => beforeDispatch.lateDispatch(), '原A的onDispatch必须先由原assertLocal拒绝，不能写新owner。')
    const late = f.controller.getPlaybackState(); sameOriginal(late, b, stable.local!.attempt_id); assert.equal(late.local?.phase, 'PLAYING'); assert.equal(f.sdk.sessions.length, begins); assert.equal(f.sdk.sends.length, sends); assert.equal(f.sdk.ends(), ends)
  })
})
