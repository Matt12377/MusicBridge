import { withoutMobilePreparationContext, createMobileCapabilityContext, withMobileCapabilityContext, captureMobileCapabilityContext } from '../../../../packages/bridge-core/src/mobile/capability-trace.js'
import { IncomingMessage, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { Writable } from 'node:stream'
import { MobileServiceError } from '../../../../packages/bridge-core/src/mobile/types.js'
import { sendMobileMediaResponse, getMobileMediaReleaseCompletion, type MobileMediaReply } from '../../src/main/mobile-media-response.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  copyMobileRangeWindowSnapshot,
  createMobileRangeWindowProbe,
  mobileRangeWindowObserve,
  mobileRangeWindowFailure,
  mobileRangeWindowQueued,
  mobileRangeWindowRpc,
  withMobileRangeWindowContext,
  withoutMobileRangeWindowContext,
  mobileRangeWindowCapture,
  type MobileRangeWindowRecord,
} from '../../../../packages/bridge-core/src/mobile/range-window-observer.js'

const epochMs = 1800000000000
const maxExportBytes = 256 * 1024
const secret = '私密异常正文 /Users/private-owner/media.wav https://private.invalid/audio Cookie=private-token'
const request = (ordinal = 1) => ({
  requestId: `${ordinal.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`,
  method: 'GET', operation: 'getMediaAsset', range: `bytes=${(ordinal - 1) * 262144}-${ordinal * 262144 - 1}`,
})
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed })
  return { promise, resolve, reject }
}

test('范围窗口旁注：八请求及记录导出硬上限，默认关闭与坏输入不触碰业务', async () => {
  let offClocks = 0, offEpochs = 0, offSinks = 0, offGetters = 0, offCalls = 0
  const off = createMobileRangeWindowProbe({
    now() { offClocks++; throw new Error(secret) },
    epochNow() { offEpochs++; throw new Error(secret) },
    sink() { offSinks++; throw new Error(secret) },
  })
  const disabledInput = Object.defineProperty(request(), 'method', {
    enumerable: true, get() { offGetters++; throw new Error(secret) },
  })
  assert.equal(off.claim(disabledInput), undefined)
  const disabledContext = off.claim(request())
  const original = Promise.resolve('原业务结果')
  const disabledResult = withMobileRangeWindowContext(disabledContext, () => mobileRangeWindowObserve('main.open.task', () => {
    offCalls++; return original
  }))
  assert.strictEqual(disabledResult, original)
  assert.equal(await disabledResult, '原业务结果')
  assert.equal(offCalls, 1)
  assert.equal(offClocks, 0); assert.equal(offEpochs, 0); assert.equal(offSinks, 0); assert.equal(offGetters, 0)
  assert.equal(off.snapshot().enabled, false); assert.deepEqual(off.snapshot().requests, [])
  assert.ok(copyMobileRangeWindowSnapshot(off.snapshot()))

  let clock = 0, clocks = 0, epochs = 0, sinks = 0
  const probe = createMobileRangeWindowProbe({ enabled: true,
    now() { clocks++; return ++clock }, epochNow() { epochs++; return epochMs }, sink() { sinks++ },
  })
  const invalid = [
    { ...request(), method: 'HEAD' }, { ...request(), method: 'POST' },
    { ...request(), operation: 'createResource' }, { ...request(), ifRange: secret },
    { ...request(), requestId: secret }, { ...request(), range: 'bytes=0-1' },
    { ...request(), range: 'bytes=0-' }, { ...request(), range: 'bytes=-262144' },
    { ...request(), range: 'bytes=00-262143' }, { ...request(), range: 'bytes=0-262143,262144-524287' },
    { ...request(), range: 'bytes=9007199254740992-9007199255003135' },
  ]
  for (const input of invalid) assert.equal(probe.claim(input), undefined)
  assert.equal(clocks, 0); assert.equal(epochs, 0); assert.equal(sinks, 0)
  assert.equal(probe.snapshot().ineligibleRequests, invalid.length)
  assert.deepEqual(probe.snapshot().requests, [])

  const contexts = Array.from({ length: 8 }, (_, index) => {
    const context = probe.claim(request(index + 1)); assert.ok(context); return context
  })
  assert.equal(probe.claim(request(9)), undefined)
  assert.equal(probe.snapshot().overflowRequests, 1)
  const flights: Promise<void>[] = []
  let businessCalls = 0
  for (const context of contexts) for (let index = 0; index < 96; index++) for (const stage of ['source.read.composite', 'auth.owner-load.composite'] as const) {
    const business = Promise.resolve()
    const observed = withMobileRangeWindowContext(context, () => mobileRangeWindowObserve(stage, () => {
      businessCalls++; return business
    }, 'business', stage === 'source.read.composite' ? 'read' : 'auth-current'))
    assert.strictEqual(observed, business); flights.push(observed)
  }
  await Promise.all(flights)
  for (const context of contexts) probe.finish(context, { status: 206, finished: true, failed: false })
  assert.equal(businessCalls, 8 * 96 * 2)
  const snapshot = probe.snapshot()
  assert.equal(snapshot.maxRequests, 8); assert.equal(snapshot.maxRecordsPerRequest, 64); assert.equal(snapshot.maxRecords, 512)
  assert.equal(snapshot.requests.length, 8)
  assert.ok(snapshot.requests.every(row => row.records.length <= 64 && row.droppedRecords > 0))
  assert.ok(snapshot.requests.reduce((count, row) => count + row.records.length, 0) <= 512)
  assert.ok(snapshot.requests.every(row => row.pendingSpans === 0 && row.httpTerminal && row.responseFinished))
  const serialized = JSON.stringify(snapshot)
  assert.ok(Buffer.byteLength(serialized, 'utf8') <= maxExportBytes)
  for (const input of Array.from({ length: 9 }, (_, index) => request(index + 1))) assert.equal(serialized.includes(input.requestId), false)
  assert.equal(serialized.includes(secret), false)
  assert.equal(snapshot.ownerDetail, 'not-observable-current-channel')
  const copied = copyMobileRangeWindowSnapshot(JSON.parse(serialized) as unknown)
  assert.ok(copied); assert.deepEqual(copied, snapshot); assert.notStrictEqual(copied, snapshot)
  assert.notStrictEqual(copied.requests, snapshot.requests)
  assert.notStrictEqual(copied.requests[0], snapshot.requests[0])
  assert.notStrictEqual(copied.requests[0]!.records[0], snapshot.requests[0]!.records[0])
  copied.requests[0]!.records[0]!.atMs = 999999
  assert.notEqual(snapshot.requests[0]!.records[0]!.atMs, 999999)

  let getters = 0, traps = 0
  const first = snapshot.requests[0]!, record = first.records[0]!
  const getter = Object.defineProperty({ ...snapshot }, 'requests', {
    enumerable: true, get() { getters++; throw new Error(secret) },
  })
  const nestedGetter = { ...snapshot, requests: [{ ...first, records: [Object.defineProperty({ ...record }, 'stage', {
    enumerable: true, get() { getters++; throw new Error(secret) },
  })] }, ...snapshot.requests.slice(1)] }
  const proxy = new Proxy(snapshot, { ownKeys() { traps++; throw new Error(secret) }, getPrototypeOf() { traps++; throw new Error(secret) } })
  const tooManyRecords = { ...snapshot, requests: [{ ...first, records: Array.from({ length: 65 }, () => ({ ...record })) }, ...snapshot.requests.slice(1)] }
  const extraRecordField = { ...snapshot, requests: [{ ...first, records: [{ ...record, path: secret }] }, ...snapshot.requests.slice(1)] }
  const nonFinite = { ...snapshot, requests: [{ ...first, records: [{ ...record, durationMs: Number.NaN }] }, ...snapshot.requests.slice(1)] }
  const fakeSettlement = { ...snapshot, requests: [{ ...first, records: [{ ...record, phase: 'pending', durationMs: 1 }] }, ...snapshot.requests.slice(1)] }
  for (const raw of [getter, nestedGetter, proxy, tooManyRecords, extraRecordField, nonFinite, fakeSettlement,
    { ...snapshot, requests: [...snapshot.requests, first] }, { ...snapshot, maxRecords: 513 },
    { ...snapshot, ownerDetail: 'owner-quiet-confirmed' }, { ...snapshot, privateError: secret }]) {
    assert.equal(copyMobileRangeWindowSnapshot(raw), null)
  }
  assert.equal(getters, 0); assert.equal(traps, 0)

  // 自定义数组原型及own方法均拒绝；从不执行输入every/map/reduce/iterator或索引getter。
  let inheritedCalls = 0, arrayGetters = 0
  const inherited = Object.create(Array.prototype)
  for (const method of ['every', 'map', 'some', 'reduce']) Object.defineProperty(inherited, method, {
    get() { inheritedCalls++; throw new Error(secret) },
  })
  Object.defineProperty(inherited, Symbol.iterator, { get() { inheritedCalls++; throw new Error(secret) } })
  const arrayProxy = new Proxy([...snapshot.requests], {
    get() { inheritedCalls++; throw new Error(secret) },
    getOwnPropertyDescriptor() { inheritedCalls++; throw new Error(secret) },
    getPrototypeOf() { inheritedCalls++; throw new Error(secret) },
  })
  const inheritedRequests = Object.setPrototypeOf([...snapshot.requests], inherited)
  const inheritedRecords = Object.setPrototypeOf([...first.records], inherited)
  const nullRequests = Object.setPrototypeOf([...snapshot.requests], null)
  const ownEvery = [...snapshot.requests]
  Object.defineProperty(ownEvery, 'every', { value() { inheritedCalls++; return true } })
  const ownMap = [...first.records]
  Object.defineProperty(ownMap, 'map', { value() { inheritedCalls++; return [{ ...record, privateError: secret }] } })
  const ownIterator = [...snapshot.requests]
  Object.defineProperty(ownIterator, Symbol.iterator, { get() { arrayGetters++; throw new Error(secret) } })
  const indexGetter = [...snapshot.requests]
  Object.defineProperty(indexGetter, '0', { enumerable: true, get() { arrayGetters++; throw new Error(secret) } })
  const recordIndexGetter = [...first.records]
  Object.defineProperty(recordIndexGetter, '0', { enumerable: true, get() { arrayGetters++; throw new Error(secret) } })
  const inheritedSuccess = Object.create(Array.prototype, {
    every: { value() { inheritedCalls++; return true } },
    map: { value() { inheritedCalls++; return [{ ...record, privateError: secret }] } },
    [Symbol.iterator]: { value() { inheritedCalls++; return [first][Symbol.iterator]() } },
  })
  const fakeSuccess = Object.setPrototypeOf([{ ...record, privateError: secret }], inheritedSuccess)
  for (const raw of [
    { ...snapshot, requests: inheritedRequests }, { ...snapshot, requests: nullRequests },
    { ...snapshot, requests: arrayProxy },
    { ...snapshot, requests: ownEvery }, { ...snapshot, requests: ownIterator }, { ...snapshot, requests: indexGetter },
    { ...snapshot, requests: [{ ...first, records: inheritedRecords }, ...snapshot.requests.slice(1)] },
    { ...snapshot, requests: [{ ...first, records: ownMap }, ...snapshot.requests.slice(1)] },
    { ...snapshot, requests: [{ ...first, records: recordIndexGetter }, ...snapshot.requests.slice(1)] },
    { ...snapshot, requests: [{ ...first, records: fakeSuccess }, ...snapshot.requests.slice(1)] },
  ]) assert.equal(copyMobileRangeWindowSnapshot(raw), null)
  assert.equal(inheritedCalls, 0); assert.equal(arrayGetters, 0)
  const cleanCopy = copyMobileRangeWindowSnapshot(snapshot); assert.ok(cleanCopy)
  assert.deepEqual(cleanCopy, snapshot); assert.equal(JSON.stringify(cleanCopy).includes(secret), false)

  // 使用闭集允许的最长数值与摘要散列检查完整八请求导出的字节边界。
  const dense = copyMobileRangeWindowSnapshot(snapshot); assert.ok(dense)
  for (const row of dense.requests) {
    row.epochMs = Number.MAX_SAFE_INTEGER; row.offset = Number.MAX_SAFE_INTEGER - 262143
    for (const entry of row.records) {
      entry.atMs = Number.MAX_SAFE_INTEGER; entry.durationMs = Number.MAX_SAFE_INTEGER
      entry.queueAhead = 2147483647; entry.nonceSha256 = 'f'.repeat(64)
    }
    const failure: MobileRangeWindowRecord = { ...row.records[0]!, stage: 'source.read.authority.before', role: 'business',
      phase: 'reject', code: 'RESOURCE_RELEASED', atMs: Number.MAX_SAFE_INTEGER, durationMs: Number.MAX_SAFE_INTEGER,
      queueAhead: 2147483647, nonceSha256: 'f'.repeat(64) }
    row.firstBusinessFailure = failure
    row.firstCleanupFailure = { ...failure, stage: 'cleanup.close-read.composite', role: 'cleanup' }
  }
  const denseBytes = Buffer.byteLength(JSON.stringify({ privateEvidence: { mobileRangeWindow: dense } }, null, 2), 'utf8')
  const denseCopy = copyMobileRangeWindowSnapshot(dense)
  if (denseBytes > maxExportBytes) assert.equal(denseCopy, null)
  else { assert.ok(denseCopy); assert.ok(denseBytes <= maxExportBytes) }

  // 正常满窗：保留四块source/RPC分段，重复auth/authority仅按闭集摘要累计。
  let normalClock = 0
  const normal = createMobileRangeWindowProbe({ enabled: true, now: () => ++normalClock, epochNow: () => epochMs })
  for (let index = 1; index <= 8; index++) {
    const arrival = normal.markArrival(), context = normal.claim({ ...request(index), arrival }); assert.ok(context)
    await withMobileRangeWindowContext(context, async () => {
      const auth = () => Promise.resolve().then(mobileRangeWindowQueued('auth', 'auth-device',
        () => mobileRangeWindowObserve('auth.owner-load.composite', () => Promise.resolve())))
      const rpc = (ordinal: number, kind: string) => {
        const nonce = `${(index * 100 + ordinal).toString(16).padStart(8, '0')}-2222-4222-8222-222222222222`
        const role = kind === 'close-read' ? 'cleanup' : 'business'
        const observed = mobileRangeWindowRpc(nonce, kind, role), retained = mobileRangeWindowRpc(nonce, kind, role, 'content.rpc.retained')
        assert.ok(observed); assert.ok(retained); observed.settle(nonce); retained.settle(nonce)
      }
      await mobileRangeWindowObserve('main.open.task', () => Promise.resolve().then(mobileRangeWindowQueued('open', 'getMediaAsset', async () => {
        await auth()
        await mobileRangeWindowObserve('source.verify.composite', async () => { await auth(); rpc(0, 'verify'); await auth() })
        await auth()
      })))
      await mobileRangeWindowObserve('sender.initial-authority', auth)
      for (let block = 1; block <= 4; block++) {
        await mobileRangeWindowObserve('sender.read', async () => {
          await mobileRangeWindowObserve('read.authority.before', auth)
          await mobileRangeWindowObserve('source.read.composite', async () => {
            await mobileRangeWindowObserve('source.read.authority.before', auth)
            rpc(block, 'read')
            await mobileRangeWindowObserve('source.read.authority.after', auth)
          })
          await mobileRangeWindowObserve('read.authority.after', auth)
        })
        await mobileRangeWindowObserve('sender.before-write-authority', auth)
        await mobileRangeWindowObserve('sender.write', () => Promise.resolve())
      }
      await mobileRangeWindowObserve('sender.read', () => mobileRangeWindowObserve('reader.close.wait',
        () => mobileRangeWindowObserve('reader.close', () => mobileRangeWindowObserve('cleanup.close-read.composite', async () => { rpc(5, 'close-read') }, 'cleanup'), 'cleanup'), 'cleanup'))
      await mobileRangeWindowObserve('sender.close', () => mobileRangeWindowObserve('reader.close.wait', () => Promise.resolve(), 'cleanup'), 'cleanup')
      await mobileRangeWindowObserve('sender.close.wait', () => Promise.resolve(), 'cleanup')
    })
    normal.finish(context, { status: 206, finished: true, failed: false })
  }
  const normalSnapshot = normal.snapshot()
  assert.equal(normalSnapshot.truncated, false); assert.equal(normalSnapshot.overflowRequests, 0)
  assert.equal(normalSnapshot.requests.length, 8)
  for (const row of normalSnapshot.requests) {
    assert.equal(row.droppedRecords, 0); assert.equal(row.pendingSpans, 0); assert.equal(row.httpTerminal, true)
    assert.equal(row.records.filter(r => r.stage === 'source.read.composite').length, 4)
    assert.equal(row.records.filter(r => r.stage === 'content.rpc.composite').length, 6)
    assert.equal(row.records.filter(r => r.stage === 'content.rpc.retained').length, 6)
    assert.equal(row.records.find(r => r.stage === 'auth.owner-load.composite')?.count, 25)
    assert.equal(row.records.find(r => r.stage === 'sender.write')?.count, 4)
  }
  assert.ok(Buffer.byteLength(JSON.stringify({ privateEvidence: { mobileRangeWindow: normalSnapshot } }, null, 2), 'utf8') <= maxExportBytes)
  assert.ok(copyMobileRangeWindowSnapshot(normalSnapshot))

  for (const mode of ['clock-throw', 'clock-backward', 'epoch-throw'] as const) {
    let calls = 0
    const faulty = createMobileRangeWindowProbe({ enabled: true,
      now() { calls++; if (mode === 'clock-throw') throw new Error(secret); return mode === 'clock-backward' ? 100 - calls : calls },
      epochNow() { if (mode === 'epoch-throw') throw new Error(secret); return epochMs },
    })
    const context = faulty.claim(request()); assert.ok(context)
    const business = Promise.resolve('时钟故障仍保留原结果')
    const observed = withMobileRangeWindowContext(context, () => mobileRangeWindowObserve('sender.read', () => business))
    assert.strictEqual(observed, business); assert.equal(await observed, '时钟故障仍保留原结果')
    faulty.finish(context, { status: 206, finished: true, failed: false })
    const result = faulty.snapshot(); assert.equal(result.requests[0]!.clockFault, true); assert.ok(result.clockFaults > 0)
    if (mode === 'epoch-throw') assert.equal(result.requests[0]!.epochMs, null)
    else assert.ok(result.requests[0]!.records.some(entry => entry.atMs === null || entry.durationMs === null))
    assert.ok(copyMobileRangeWindowSnapshot(result)); assert.equal(JSON.stringify(result).includes(secret), false)
  }
})

test('范围窗口旁注：预取队首与取消后的原队列任务保留到真实迟到结算', async t => {
  let clock = 0, prefetchCalls = 0, selectedCalls = 0, executedAfterAbort = false
  const probe = createMobileRangeWindowProbe({ enabled: true, now: () => ++clock, epochNow: () => epochMs })
  const prefetchEntered = deferred<void>(), prefetchGate = deferred<void>()
  const selectedEntered = deferred<void>(), selectedGate = deferred<string>()
  const controller = new AbortController()
  t.after(() => { prefetchGate.resolve(); selectedGate.resolve('迟到的原open结果') })
  // 真实tail.then回调：此正常预取没有选中HTTP上下文，但仍占用同一open lane。
  const prefetch = Promise.resolve().then(mobileRangeWindowQueued('open', 'createResource', () => {
    prefetchCalls++; prefetchEntered.resolve(); return prefetchGate.promise
  }))
  const tail = prefetch.then(() => undefined)
  await prefetchEntered.promise
  assert.equal(prefetchCalls, 1); assert.deepEqual(probe.snapshot().requests, [])
  const context = probe.claim(request()); assert.ok(context)
  const rpcNonce = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  const composite = withMobileRangeWindowContext(context, () => mobileRangeWindowRpc(rpcNonce, 'read'))
  const retained = withMobileRangeWindowContext(context, () => mobileRangeWindowRpc(rpcNonce, 'read', 'business', 'content.rpc.retained'))
  assert.ok(composite); assert.ok(retained)
  let original!: Promise<string>
  const selected = withMobileRangeWindowContext(context, () => mobileRangeWindowObserve('main.open.task', () => {
    original = tail.then(mobileRangeWindowQueued('open', 'getMediaAsset', () => {
      selectedCalls++; executedAfterAbort = controller.signal.aborted; selectedEntered.resolve(); return selectedGate.promise
    }))
    return original
  }, 'business', 'getMediaAsset'))
  assert.strictEqual(selected, original)
  assert.equal(selectedCalls, 0)
  let row = probe.snapshot().requests[0]!
  assert.equal(row.records.find(entry => entry.stage === 'main.open.queue')?.phase, 'pending')
  assert.ok((row.records.find(entry => entry.stage === 'main.open.queue')?.queueAhead ?? 0) >= 1)
  assert.ok(row.pendingSpans >= 2)
  controller.abort(); probe.abort(context)
  const aborted = Object.assign(new Error(secret), { code: 'ABORTED' })
  probe.finish(context, { status: 499, finished: false, failed: true, error: aborted })
  composite.settle(rpcNonce, true, aborted)
  let snapshot = probe.snapshot(); row = snapshot.requests[0]!
  assert.equal(row.aborted, true); assert.equal(row.httpTerminal, true); assert.equal(row.httpStatus, 499); assert.equal(row.responseFinished, false)
  assert.equal(selectedCalls, 0); assert.ok(row.pendingSpans >= 2)
  assert.equal(row.records.find(entry => entry.stage === 'main.open.task')?.phase, 'pending')
  assert.equal(row.records.find(entry => entry.stage === 'main.open.queue')?.phase, 'pending')
  assert.equal(snapshot.ownerDetail, 'not-observable-current-channel')
  assert.ok(copyMobileRangeWindowSnapshot(snapshot))

  prefetchGate.resolve(); await prefetch; await selectedEntered.promise
  snapshot = probe.snapshot(); row = snapshot.requests[0]!
  const queued = row.records.find(entry => entry.stage === 'main.open.queue')
  assert.ok(queued); assert.equal(queued.phase, 'ok'); assert.equal(queued.predecessorKind, 'createResource')
  assert.ok(queued.queueAhead >= 1); assert.equal(selectedCalls, 1); assert.equal(executedAfterAbort, true)
  assert.equal(row.records.find(entry => entry.stage === 'main.open.execute')?.phase, 'pending')
  assert.equal(row.records.find(entry => entry.stage === 'main.open.task')?.phase, 'pending')
  assert.ok(row.pendingSpans >= 2)
  assert.equal(row.httpTerminal, true); assert.equal(snapshot.ownerDetail, 'not-observable-current-channel')
  selectedGate.resolve('迟到的原open结果')
  assert.equal(await selected, '迟到的原open结果')
  row = probe.snapshot().requests[0]!
  assert.equal(row.pendingSpans, 1)
  assert.equal(row.records.find(r => r.stage === 'content.rpc.composite')?.phase, 'reject')
  assert.equal(row.records.find(r => r.stage === 'content.rpc.retained')?.phase, 'pending')
  retained.settle('ffffffff-ffff-4fff-8fff-ffffffffffff')
  assert.equal(probe.snapshot().requests[0]!.pendingSpans, 1)
  retained.settle(rpcNonce, true, aborted)
  snapshot = probe.snapshot(); row = snapshot.requests[0]!
  assert.equal(prefetchCalls, 1); assert.equal(selectedCalls, 1); assert.equal(row.pendingSpans, 0)
  assert.equal(row.records.find(entry => entry.stage === 'main.open.task')?.phase, 'ok')
  assert.equal(row.records.find(entry => entry.stage === 'main.open.execute')?.phase, 'ok')
  assert.equal(row.firstBusinessFailure?.code, 'ABORTED')
  assert.equal(row.httpTerminal, true); assert.equal(row.responseFinished, false)
  assert.equal(snapshot.ownerDetail, 'not-observable-current-channel')
  assert.ok(copyMobileRangeWindowSnapshot(snapshot)); assert.equal(JSON.stringify(snapshot).includes(secret), false)

  // 原timer创建点组合退出两个专用ALS；已终结HTTP不接受后台expire旁注，原late RPC仍能结算。
  let timerClock = 0, factoryCalls = 0, backgroundCalls = 0, exitCalls = 0
  const timerProbe = createMobileRangeWindowProbe({ enabled: true, now: () => ++timerClock, epochNow: () => epochMs })
  const timerContext = timerProbe.claim(request()); assert.ok(timerContext)
  const lateNonce = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  const lateRpc = withMobileRangeWindowContext(timerContext, () => mobileRangeWindowRpc(lateNonce, 'read', 'business', 'content.rpc.retained'))
  assert.ok(lateRpc)
  const capability = createMobileCapabilityContext('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'main', 'http', null, undefined, () => {})
  assert.ok(capability)
  const marker = Object.freeze({ unchanged: true })
  const returned = withMobileCapabilityContext(capability, () => withMobileRangeWindowContext(timerContext, () => withoutMobileRangeWindowContext(() => {
    exitCalls++; assert.equal(mobileRangeWindowCapture(), undefined)
    assert.strictEqual(captureMobileCapabilityContext(), capability)
    return marker
  })))
  assert.strictEqual(returned, marker); assert.equal(exitCalls, 1)
  const originalThrow = new Error(secret)
  assert.throws(() => withMobileRangeWindowContext(timerContext, () => withoutMobileRangeWindowContext(() => {
    exitCalls++; throw originalThrow
  })), error => error === originalThrow)
  assert.equal(exitCalls, 2)
  const tickDone = deferred<void>()
  let backgroundContext: ReturnType<typeof mobileRangeWindowCapture>
  let interval!: ReturnType<typeof setInterval>
  withMobileRangeWindowContext(timerContext, () => {
    interval = withoutMobileRangeWindowContext(() => withoutMobilePreparationContext(() => {
      factoryCalls++
      return setInterval(() => {
        backgroundCalls++; clearInterval(interval); backgroundContext = mobileRangeWindowCapture()
        const tick = Promise.resolve().then(mobileRangeWindowQueued('open', 'expire',
          () => mobileRangeWindowObserve('auth.owner-load.composite', () => Promise.reject(new Error(secret)))))
        void tick.then(() => tickDone.resolve(), () => tickDone.resolve())
      }, 1)
    }))
  })
  t.after(() => clearInterval(interval))
  timerProbe.finish(timerContext, { status: 206, finished: true, failed: false })
  const beforeTick = timerProbe.snapshot()
  assert.equal(beforeTick.requests[0]!.pendingSpans, 1)
  await tickDone.promise
  assert.equal(factoryCalls, 1); assert.equal(backgroundCalls, 1); assert.equal(backgroundContext, undefined)
  assert.deepEqual(timerProbe.snapshot(), beforeTick)
  lateRpc.settle(lateNonce)
  const afterLate = timerProbe.snapshot().requests[0]!
  assert.equal(afterLate.httpTerminal, true); assert.equal(afterLate.pendingSpans, 0)
  assert.equal(afterLate.firstBusinessFailure, null); assert.equal(afterLate.firstCleanupFailure, null)
  assert.equal(afterLate.records.find(r => r.stage === 'content.rpc.retained')?.phase, 'ok')
  assert.ok(copyMobileRangeWindowSnapshot(timerProbe.snapshot()))
})

test('范围窗口旁注：错配坏帧与观察器故障不改原结果及首业务错误', async t => {
  let clock = 0, getters = 0, traps = 0
  const probe = createMobileRangeWindowProbe({ enabled: true, now: () => ++clock, epochNow: () => epochMs })
  const context = probe.claim(request()); assert.ok(context)
  const nonce = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', wrongNonce = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const rpc = withMobileRangeWindowContext(context, () => mobileRangeWindowRpc(nonce, 'source')); assert.ok(rpc)
  const pending = probe.snapshot().requests[0]!.pendingSpans
  assert.ok(pending > 0)
  rpc.settle(wrongNonce)
  rpc.acceptFrame(Object.defineProperty({ nonce, phase: 'ok' }, 'code', {
    enumerable: true, get() { getters++; throw new Error(secret) },
  }))
  rpc.acceptFrame(new Proxy({ nonce, phase: 'ok', code: 'NONE' }, {
    ownKeys() { traps++; throw new Error(secret) }, getPrototypeOf() { traps++; throw new Error(secret) },
  }))
  rpc.acceptFrame({ nonce, phase: 'future-success', code: 'NONE' })
  rpc.acceptFrame({ nonce, phase: 'ok', code: 'SOURCE_CHANGED' })
  rpc.acceptFrame({ nonce, phase: 'ok', code: 'NONE', privateError: secret })
  let snapshot = probe.snapshot(), row = snapshot.requests[0]!
  assert.equal(getters, 0); assert.equal(traps, 0)
  assert.ok(snapshot.unmatchedFrames > 0); assert.ok(snapshot.malformedFrames >= 5)
  assert.equal(row.pendingSpans, pending); assert.equal(row.firstBusinessFailure, null)
  assert.equal(row.records.find(entry => entry.stage === 'content.rpc.composite')?.phase, 'pending')
  assert.equal(row.records.some(entry => entry.stage === 'content.rpc.composite' && entry.phase === 'ok'), false)
  rpc.acceptFrame({ nonce, phase: 'ok', code: 'NONE' })
  snapshot = probe.snapshot(); row = snapshot.requests[0]!
  assert.equal(row.pendingSpans, 0)
  const completed = row.records.find(entry => entry.stage === 'content.rpc.composite')
  assert.ok(completed); assert.equal(completed.phase, 'ok'); assert.match(completed.nonceSha256!, /^[a-f0-9]{64}$/u)
  rpc.settle(nonce)
  assert.ok(probe.snapshot().unmatchedFrames > snapshot.unmatchedFrames)
  assert.equal(probe.snapshot().requests[0]!.pendingSpans, 0)
  assert.ok(copyMobileRangeWindowSnapshot(probe.snapshot()))
  const serialized = JSON.stringify(probe.snapshot())
  assert.equal(serialized.includes(nonce), false); assert.equal(serialized.includes(wrongNonce), false); assert.equal(serialized.includes(secret), false)

  for (const mode of ['sink', 'clock'] as const) {
    let ticks = 0, sinks = 0, successCalls = 0, businessCalls = 0, cleanupCalls = 0, throwCalls = 0, codeGetters = 0
    const faulty = createMobileRangeWindowProbe({ enabled: true,
      now() { if (mode === 'clock') throw new Error(secret); return ++ticks }, epochNow: () => epochMs,
      sink() { sinks++; if (mode === 'sink') throw new Error(secret) },
    })
    const selectedContext = faulty.claim(request()); assert.ok(selectedContext)
    const value = Object.freeze({ result: '原业务值' }), originalSuccess = Promise.resolve(value)
    const success = withMobileRangeWindowContext(selectedContext, () => mobileRangeWindowObserve('source.read.composite', () => {
      successCalls++; return originalSuccess
    }, 'business', 'source'))
    assert.strictEqual(success, originalSuccess); assert.strictEqual(await success, value); assert.equal(successCalls, 1)

    const businessError = Object.assign(new Error(secret), { code: 'SOURCE_CHANGED' })
    const cleanupError = Object.assign(new Error(secret), { code: 'RELEASE_FAILED' })
    const businessGate = deferred<void>(), cleanupGate = deferred<void>()
    const business = withMobileRangeWindowContext(selectedContext, () => mobileRangeWindowObserve('sender.read', () => {
      businessCalls++; return businessGate.promise
    }, 'business', 'read'))
    assert.strictEqual(business, businessGate.promise)
    const businessRejected = assert.rejects(business, error => error === businessError)
    businessGate.reject(businessError); await businessRejected
    const firstBusiness = faulty.snapshot().requests[0]!.firstBusinessFailure
    assert.ok(firstBusiness); assert.equal(firstBusiness.stage, 'sender.read'); assert.equal(firstBusiness.code, 'SOURCE_CHANGED')
    const cleanup = withMobileRangeWindowContext(selectedContext, () => mobileRangeWindowObserve('reader.close', () => {
      cleanupCalls++; return cleanupGate.promise
    }, 'cleanup', 'close-read'))
    assert.strictEqual(cleanup, cleanupGate.promise)
    const cleanupRejected = assert.rejects(cleanup, error => error === cleanupError)
    cleanupGate.reject(cleanupError); await cleanupRejected
    const throwIdentity = Object.defineProperty(new Error(secret), 'code', {
      enumerable: true, get() { codeGetters++; throw new Error(secret) },
    })
    assert.throws(() => withMobileRangeWindowContext(selectedContext, () => mobileRangeWindowObserve('source.verify.composite', () => {
      throwCalls++; throw throwIdentity
    }, 'business', secret)), error => error === throwIdentity)
    faulty.finish(selectedContext, { status: 500, finished: false, failed: true, error: businessError })
    const result = faulty.snapshot(), selectedRow = result.requests[0]!
    assert.equal(businessCalls, 1); assert.equal(cleanupCalls, 1); assert.equal(throwCalls, 1); assert.equal(codeGetters, 0)
    assert.deepEqual(selectedRow.firstBusinessFailure, firstBusiness)
    assert.equal(selectedRow.firstCleanupFailure?.stage, 'reader.close'); assert.equal(selectedRow.firstCleanupFailure?.code, 'RELEASE_FAILED')
    assert.equal(selectedRow.records.find(entry => entry.stage === 'source.verify.composite')?.code, 'UNKNOWN')
    assert.equal(selectedRow.records.find(entry => entry.stage === 'source.verify.composite')?.kind, 'control-other')
    assert.equal(selectedRow.pendingSpans, 0); assert.equal(selectedRow.httpTerminal, true)
    if (mode === 'sink') { assert.ok(sinks > 0); assert.ok(result.observerFaults > 0) }
    else { assert.equal(selectedRow.clockFault, true); assert.ok(result.clockFaults > 0); assert.ok(selectedRow.records.every(entry => entry.durationMs === null)) }
    assert.ok(copyMobileRangeWindowSnapshot(result)); assert.equal(JSON.stringify(result).includes(secret), false)
    assert.equal(result.ownerDetail, 'not-observable-current-channel')
  }
  const cleanupOnly = createMobileRangeWindowProbe({ enabled: true, now: () => 10, epochNow: () => epochMs })
  const cleanupContext = cleanupOnly.claim(request()); assert.ok(cleanupContext)
  const closeError = Object.assign(new Error(secret), { code: 'RELEASE_FAILED' })
  withMobileRangeWindowContext(cleanupContext, () => mobileRangeWindowFailure(closeError, 'cleanup'))
  cleanupOnly.finish(cleanupContext, { status: 206, finished: false, failed: true, error: closeError })
  const cleanupRow = cleanupOnly.snapshot().requests[0]!
  assert.equal(cleanupRow.firstBusinessFailure, null)
  assert.equal(cleanupRow.firstCleanupFailure?.code, 'RELEASE_FAILED')
  assert.equal(cleanupRow.records.find(r => r.stage === 'http.terminal')?.role, 'cleanup')

  // 直接走生产sender：首业务错之后的finally清理等待仍要旁注，且原异常身份不变。
  for (const outcome of ['timeout', 'failed'] as const) {
    const socket = new Socket(), incoming = new IncomingMessage(socket)
    const response = new class extends Writable {
      headersSent = false
      statusCode = 0
      constructor() { super({ autoDestroy: false }) }
      writeHead(status: number, _headers: string[]) { this.statusCode = status; this.headersSent = true; return this }
      override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) { callback() }
    }()
    incoming.method = 'GET'
    const gate = deferred<void>(), closeEntered = deferred<void>()
    let closes = 0, pulls = 0
    t.after(() => { gate.resolve(); response.destroy(); socket.destroy() })
    const firstError = new MobileServiceError(409, 'SOURCE_CHANGED')
    const reply: MobileMediaReply = {
      operation: 'getMediaAsset', status: 206, expectedBodyBytes: 262144, fullContentLength: 524288,
      headers: [['Content-Type', 'audio/wav'], ['Content-Length', '262144'], ['Content-Range', 'bytes 0-262143/524288'], ['Accept-Ranges', 'bytes']],
      rangeRequested: 'bytes=0-262143', resourceAbortSignal: new AbortController().signal, ticketExpiresAtMs: Date.now() + 60000,
      async beforeSend() { throw firstError },
      reader: { async read() { pulls++; return null }, close() { closes++; closeEntered.resolve(); return gate.promise } },
    }
    const senderProbe = createMobileRangeWindowProbe({ enabled: true })
    const senderContext = senderProbe.claim(request()); assert.ok(senderContext)
    const sending = withMobileRangeWindowContext(senderContext, () => sendMobileMediaResponse(incoming,
      response as unknown as ServerResponse, reply, new AbortController().signal, { releaseMs: 20 }))
    const rejected = assert.rejects(sending, error => error === firstError)
    await closeEntered.promise
    if (outcome === 'failed') gate.reject(new Error(secret))
    await rejected
    senderProbe.finish(senderContext, { status: null, finished: false, failed: true, error: firstError })
    const observed = senderProbe.snapshot().requests[0]!
    const cleanupCode = outcome === 'timeout' ? 'RELEASE_TIMEOUT' : 'RELEASE_FAILED'
    assert.equal(pulls, 0); assert.equal(closes, 1)
    assert.equal(observed.firstBusinessFailure?.code, 'SOURCE_CHANGED')
    assert.equal(observed.firstCleanupFailure?.code, cleanupCode)
    assert.equal(observed.records.find(r => r.stage === 'sender.close.wait')?.code, cleanupCode)
    assert.equal(observed.records.find(r => r.stage === 'http.terminal')?.role, 'business')
    const firstBusiness = observed.firstBusinessFailure, firstCleanup = observed.firstCleanupFailure
    if (outcome === 'timeout') {
      assert.ok(observed.pendingSpans > 0)
      assert.equal(observed.records.find(r => r.stage === 'sender.close')?.phase, 'pending')
      gate.resolve(); await getMobileMediaReleaseCompletion(reply)
    } else await assert.rejects(getMobileMediaReleaseCompletion(reply)!)
    const late = senderProbe.snapshot().requests[0]!
    assert.equal(late.pendingSpans, 0)
    assert.deepEqual(late.firstBusinessFailure, firstBusiness); assert.deepEqual(late.firstCleanupFailure, firstCleanup)
    assert.ok(copyMobileRangeWindowSnapshot(senderProbe.snapshot()))
    assert.equal(JSON.stringify(senderProbe.snapshot()).includes(secret), false)
  }

})
