import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createCollectionRepository } from '../../src/collection/repository.js'
import { createLocalAlbumOwnerRuntime } from '../../src/collection/local-album-browser/owner-runtime.js'
import { createScanReadAdmission } from '../../src/library/scan-read-admission.js'
import type { DatasetProjectionPort } from '../../src/collection/dataset-owner-protocol.js'
import { createTestDatasetDomain } from '../../src/collection/dataset-domain.js'
import { isMobileCorePrivateCall, isMobileOwnerPrivateRequest, isMobileOwnerPrivateResult } from '../../src/mobile/owner-protocol.js'
import { MOBILE_PLAYBACK_ACTIVITY_LEASE_MS, MOBILE_PLAYBACK_ACTIVITY_MAX_LEASES,
  type MobileOwnerPrivateRequest } from '../../src/mobile/types.js'

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve))

function clock(t: TestContext) {
  let now = 1000
  type Timer = ReturnType<typeof setTimeout>
  const timers = new Map<Timer, { at: number; callback(): void }>()
  t.mock.method(performance, 'now', () => now)
  t.mock.method(Date, 'now', () => 1_800_000_000_000 + now)
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, delay = 0) => {
    const timer = { unref() { return this } } as unknown as Timer
    timers.set(timer, { at: now + Math.max(1, Number(delay)), callback }); return timer
  })
  t.mock.method(globalThis, 'clearTimeout', (timer: Timer) => { timers.delete(timer) })
  return { timers, async advance(ms: number) {
    now += ms
    const due = [...timers].filter(([, task]) => task.at <= now).sort((a, b) => a[1].at - b[1].at)
    for (const [timer, task] of due) if (timers.delete(timer)) task.callback()
    await turn()
  } }
}

function fixture(t: TestContext) {
  const repository = createCollectionRepository({ filePath: ':memory:' }), datasetId = randomUUID()
  const admission = createScanReadAdmission({ isBusy: () => false })
  const context = { datasetId, epoch: randomUUID() }, roots = gate()
  let blocked = false, probes = 0, onCurrent = () => {}
  const pending: Promise<unknown>[] = []
  const projection: DatasetProjectionPort = { async call(command) {
    assert.equal(command, 'scanReadStatus', '空库只允许后台只读准入，不得触及源文件或解码')
    probes++; return admission.status(context) as never
  } }
  const runtime = createLocalAlbumOwnerRuntime({ repository, datasetId, projection, assertCurrent() { onCurrent() },
    async readRootViews() { if (blocked) await roots.promise; return [] },
  })
  assert.ok(runtime.background)
  t.after(async () => {
    roots.resolve(); await Promise.allSettled(pending)
    await runtime.close(); admission.close(); repository.close()
  })
  return { runtime, pending, probes: () => probes, onCurrent(action: () => void) { onCurrent = action },
    hold() { blocked = true }, release() { blocked = false; roots.resolve() } }
}

test('privateMobile.refresh实际生命周期内阻止新后台入场，原刷新完成后能恢复', async t => {
  const time = clock(t), f = fixture(t); f.hold(); f.runtime.background!.start()
  const refresh = f.runtime.localAlbums.privateMobile.refresh(); f.pending.push(refresh)
  const background = f.runtime.background!.runPending(); f.pending.push(background)
  await turn()
  assert.equal(f.probes(), 0, '实际privateMobile刷新尚未退出，后台不得新占Owner')
  f.release(); await Promise.all([refresh, background])
  // 原quiet仍是100ms；这里不更改业务计时器或后台调度。
  await time.advance(101)
  assert.equal(f.probes(), 1, '原后台计时器自然恢复，不额外手工发起第二轮')
})

test('privateMobile.current/revision同步守门含重入仍持活动，返回或抛错后不冻结后台', async t => {
  for (const operation of ['current', 'revision', 'throw'] as const) await t.test(operation, async sub => {
    const time = clock(sub), f = fixture(sub)
    await f.runtime.localAlbums.privateMobile.refresh(); await time.advance(101)
    let entered = false
    const failure = new Error('合成原作者撤销')
    f.onCurrent(() => {
      if (entered) return
      entered = true; f.pending.push(f.runtime.background!.runPending())
      if (operation === 'throw') throw failure
    })
    f.runtime.background!.start()
    const read = () => operation === 'current' ? f.runtime.localAlbums.privateMobile.current({ kind: 'groups', offset: 0,
      limit: 1, query: '', rootId: null, albumKey: null, trackId: null, editionId: null, groupHash: null })
      : f.runtime.localAlbums.privateMobile.revision()
    if (operation === 'throw') assert.throws(read)
    else read()
    assert.equal(entered, true); assert.equal(f.probes(), 0, '同步原作者守门重入也不能开启后台')
    f.onCurrent(() => {}); await Promise.all(f.pending); await time.advance(101)
    assert.equal(f.probes(), 1)
  })
})

test('privateMobile抛错只归还本层活动，外层原Source活动仍挡住后台', async t => {
  const time = clock(t), f = fixture(t)
  await f.runtime.localAlbums.privateMobile.refresh(); await time.advance(101)
  const outer = f.runtime.beginMobileActivity(); f.runtime.background!.start()
  f.onCurrent(() => { throw new Error('合成嵌套失败') })
  assert.throws(() => f.runtime.localAlbums.privateMobile.revision()); f.onCurrent(() => {})
  await f.runtime.background!.runPending(); assert.equal(f.probes(), 0)
  outer(); outer(); await time.advance(101)
  assert.equal(f.probes(), 1)
})

test('Owner控制租约有界且重复归还不影响其他活动，Main失联到期后后台自然恢复', async t => {
  const time = clock(t), f = fixture(t); f.runtime.background!.start()
  const leases = Array.from({ length: MOBILE_PLAYBACK_ACTIVITY_MAX_LEASES }, () => f.runtime.beginMobileControlActivity())
  assert.ok(leases.every(id => typeof id === 'string')); assert.equal(new Set(leases).size, leases.length)
  assert.equal(f.runtime.beginMobileControlActivity(), null)
  f.runtime.endMobileControlActivity(leases[0]!); f.runtime.endMobileControlActivity(leases[0]!)
  const replacement = f.runtime.beginMobileControlActivity(); assert.ok(replacement); assert.notEqual(replacement, leases[0])
  await f.runtime.background!.runPending(); assert.equal(f.probes(), 0)
  await time.advance(MOBILE_PLAYBACK_ACTIVITY_LEASE_MS)
  await f.runtime.background!.runPending(); assert.equal(f.probes(), 0, '到期后仍保原100ms quiet')
  await time.advance(101); assert.equal(f.probes(), 1)
  await f.runtime.close(); assert.equal(f.runtime.beginMobileControlActivity(), null); assert.equal(time.timers.size, 0)
})

test('租约计时器创建失败也归还本次活动，恢复原计时器后后台自然继续', async t => {
  const time = clock(t), f = fixture(t); f.runtime.background!.start()
  const broken = t.mock.method(globalThis, 'setTimeout', () => { throw new Error('合成计时器失败') })
  assert.equal(f.runtime.beginMobileControlActivity(), null); broken.mock.restore()
  await time.advance(151); assert.equal(f.probes(), 1)
})

test('私有活动闭集拒绝额外键/getter/Proxy及跨dataset/Owner代次回包，不读取业务字段', () => {
  const datasetId = randomUUID(), ownerEpoch = randomUUID(), leaseId = randomUUID()
  const begin: MobileOwnerPrivateRequest = { kind: 'playback-activity', datasetId, request: { operation: 'begin' } }
  const end: MobileOwnerPrivateRequest = { kind: 'playback-activity', datasetId, request: { operation: 'end', ownerEpoch, leaseId } }
  for (const request of [begin, end]) {
    assert.equal(isMobileOwnerPrivateRequest(request), true)
    assert.equal(isMobileCorePrivateCall({ type: 'mobile-main-request', id: randomUUID(), request }), true)
    assert.equal(isMobileOwnerPrivateRequest({ ...request, request: { ...request.request, authorized: true } }), false)
    let touched = 0
    const proxy = new Proxy(request, { getPrototypeOf() { touched++; throw new Error('不能触Proxy') } })
    assert.equal(isMobileOwnerPrivateRequest(proxy), false); assert.equal(touched, 0)
    const getter = { ...request, get request() { touched++; return request.request } }
    assert.equal(isMobileOwnerPrivateRequest(getter), false); assert.equal(touched, 0)
  }
  const reply = { kind: 'playback-activity', datasetId, ownerEpoch, operation: 'end', leaseId }
  assert.equal(isMobileOwnerPrivateResult(reply, end), true)
  assert.equal(isMobileOwnerPrivateResult({ ...reply, ownerEpoch: randomUUID() }, end), false)
  assert.equal(isMobileOwnerPrivateResult({ ...reply, datasetId: randomUUID() }, end), false)
  assert.equal(isMobileOwnerPrivateResult({ ...reply, leaseId: randomUUID() }, end), false)
  assert.equal(isMobileOwnerPrivateRequest({ ...end, request: { ...end.request, leaseId: 'x'.repeat(1024) } }), false)
})

test('真实内存Owner私有租约绑定原dataset/代次，错代归还不接受且无持久写', async t => {
  const datasetId = randomUUID(), ownerEpoch = randomUUID()
  const repository = createCollectionRepository({ filePath: ':memory:' })
  const domain = createTestDatasetDomain({ collectionRepository: repository, collectionDatasetIdentity: { datasetId, assertCurrent() {} }, localSourceEpoch: ownerEpoch })
  t.after(() => domain.close())
  const dispatch = domain.mobileMain; assert.ok(dispatch)
  const before = repository.readonlySnapshotStamp()
  const begin: MobileOwnerPrivateRequest = { kind: 'playback-activity', datasetId, request: { operation: 'begin' } }
  const reply = await dispatch(begin)
  assert.equal(isMobileOwnerPrivateResult(reply, begin), true)
  assert.ok('kind' in reply && reply.kind === 'playback-activity' && reply.leaseId)
  if (!('kind' in reply) || reply.kind !== 'playback-activity' || !reply.leaseId) throw new Error('必须取得本Owner的RAM租约')
  assert.equal(reply.ownerEpoch, ownerEpoch)
  const wrong: MobileOwnerPrivateRequest = { kind: 'playback-activity', datasetId, request: { operation: 'end', ownerEpoch: randomUUID(), leaseId: reply.leaseId } }
  assert.deepEqual(await dispatch(wrong), { kind: 'mobile-error', status: 409, code: 'SOURCE_CHANGED', retryable: false, outcome: null })
  const end: MobileOwnerPrivateRequest = { kind: 'playback-activity', datasetId, request: { operation: 'end', ownerEpoch, leaseId: reply.leaseId } }
  assert.equal(isMobileOwnerPrivateResult(await dispatch(end), end), true)
  assert.equal(isMobileOwnerPrivateResult(await dispatch(end), end), true)
  assert.equal((await dispatch({ ...begin, datasetId: randomUUID() }) as { status: number }).status, 400)
  assert.deepEqual(repository.readonlySnapshotStamp(), before)
})
