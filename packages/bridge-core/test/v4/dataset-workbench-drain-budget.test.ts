import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { MessageChannel, type Worker } from 'node:worker_threads'
import { createDatasetOwnerClient } from '../../src/collection/dataset-owner-client.js'
import { attachDatasetOwnerWorkerPort } from '../../src/collection/dataset-owner-worker.js'
import { DATASET_WORKBENCH_BOUNDS, datasetWorkbenchOperationMs, datasetWorkbenchRequestMs, datasetWorkbenchExecutionDeadline,
  datasetWorkbenchFrames, datasetWorkbenchJson, datasetWorkbenchSha, isDatasetWorkbenchFrame, isDatasetOwnerResponse,
  type DatasetWorkbenchMeta, type DatasetWorkbenchFrame, type DatasetOwnerRequest, type DatasetOwnerFatalReason, type OwnedDatasetDomain } from '../../src/collection/dataset-owner-protocol.js'
import { responseFailure } from '../../src/shared/ipc-failure.js'
import { LIBRARY_REMOVAL_REQUEST_MS } from '../../src/shared/library-removal-budget.js'

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
function meta(kind: DatasetWorkbenchMeta['kind'], body: unknown = {}, duration = DATASET_WORKBENCH_BOUNDS.drainMs): DatasetWorkbenchMeta {
  return { id: randomUUID(), epoch: randomUUID(), datasetId: randomUUID(), sequence: 1, kind,
    requestSha256: datasetWorkbenchSha(datasetWorkbenchJson(body)), expiresAtMs: Date.now() + duration }
}

test('工作台drain预算：仅合法空正文获得10s，普通2s和移除原预算保持', () => {
  assert.equal(DATASET_WORKBENCH_BOUNDS.requestMs, 2000)
  assert.equal(DATASET_WORKBENCH_BOUNDS.drainMs, 10000)
  assert.equal(datasetWorkbenchOperationMs('drain', {}), 10000)
  assert.equal(datasetWorkbenchRequestMs(null), 2000)
  const remove = { family: 'management', command: 'library.remove', payload: { commandId: randomUUID(), libraryIds: [randomUUID()] } }
  assert.equal(datasetWorkbenchRequestMs(remove), LIBRARY_REMOVAL_REQUEST_MS)
  assert.equal(datasetWorkbenchOperationMs('execute', remove), LIBRARY_REMOVAL_REQUEST_MS)
  for (const kind of ['context', 'owner'] as const) assert.equal(datasetWorkbenchOperationMs(kind, {}), 2000)
  assert.equal(datasetWorkbenchOperationMs('context.identity', {}), 20_000)
  for (const body of [null, [], { extra: true }, Object.create({ inherited: true })]) {
    assert.throws(() => datasetWorkbenchOperationMs('drain', body), { code: 'INVALID_IPC_REQUEST' })
    assert.throws(() => datasetWorkbenchOperationMs('context.identity', body), { code: 'INVALID_IPC_REQUEST' })
  }
})

test('工作台drain期限：沿首次接收时钟及原expiry，不从正文组装结束另计', () => {
  const receivedAt = Date.now() - 1200, startedAt = performance.now() - 1200
  const request = { ...meta('drain'), expiresAtMs: receivedAt + 10000 }
  const deadline = datasetWorkbenchExecutionDeadline(request, {}, receivedAt, startedAt)
  assert.ok(deadline <= startedAt + 10000)
  assert.ok(deadline > performance.now() + 8000)
  const short = datasetWorkbenchExecutionDeadline({ ...request, expiresAtMs: Date.now() + 200 }, {}, receivedAt, startedAt)
  assert.ok(short <= performance.now() + 200, '原caller较短期限不能升级成10s')
  assert.throws(() => datasetWorkbenchExecutionDeadline({ ...request, expiresAtMs: Date.now() - 1 }, {}, receivedAt, startedAt), { code: 'TIMEOUT' })
  assert.throws(() => datasetWorkbenchExecutionDeadline(request, {}, Date.now() - 2001, performance.now() - 2001), { code: 'TIMEOUT' })
  assert.throws(() => datasetWorkbenchExecutionDeadline({ ...meta('context'), expiresAtMs: Date.now() + 10000 }, {}, Date.now(), performance.now()), { code: 'INVALID_IPC_REQUEST' })
})

/** 实际Client/Worker函数穿真实MessageChannel；领域受控，不冒充线程/DB/FD/NAS验收。 */
async function fixture(t: TestContext, client = true) {
  const channel = new MessageChannel(), packets: unknown[] = [], outgoing: unknown[] = [], listeners = new Set<() => void>()
  const reasons: DatasetOwnerFatalReason[] = [], releases = new Set<() => void>(), closedPort = deferred(), closeEntered = deferred()
  const state = { closeCalls: 0, closeCompleted: 0, domainClosed: 0, contextCompleted: 0 }
  let epoch: string = randomUUID(), sequence = 0, disconnected = false, closeWork: () => Promise<void> = async () => {}, readWork: () => Promise<void> = async () => {}
  const datasetId = randomUUID(); let closure: Promise<void> | undefined
  const domain: OwnedDatasetDomain = { datasetId, async dispatch() {}, commitBoot() {},
    async workbenchContext() { try { await readWork(); return { epoch, datasetId, ready: true } } finally { state.contextCompleted++ } },
    async dispatchWorkbench() { throw new Error('drain夹具禁止公开mutation') },
    async dispatchWorkbenchOwner() { throw new Error('drain夹具禁止Owner mutation') },
    closeWorkbench() { return closure ??= (async () => { state.closeCalls++; closeEntered.resolve(); await closeWork(); state.closeCompleted++ })() },
    async close(before) { await before?.(); state.domainClosed++ },
    failureForError: id => responseFailure(id, 'INTERNAL_ERROR', '合成关闭失败'),
  }
  class PortWorker extends EventEmitter {
    postMessage(value: unknown) { outgoing.push(value); channel.port1.postMessage(value) }
  }
  const worker = new PortWorker()
  channel.port1.on('message', (value: unknown) => { packets.push(value); for (const wake of [...listeners]) wake(); worker.emit('message', value) })
  channel.port1.once('close', () => { disconnected = true; closedPort.resolve(); worker.emit('exit', 0) })
  attachDatasetOwnerWorkerPort(channel.port2, { async prepare(actualEpoch) { epoch = actualEpoch; return domain } })
  function take(predicate: (value: unknown) => boolean): Promise<unknown> {
    const previous = packets.find(predicate); if (previous !== undefined) return Promise.resolve(previous)
    return new Promise(resolve => { const wake = () => { const found = packets.find(predicate); if (found !== undefined) { listeners.delete(wake); resolve(found) } }; listeners.add(wake) })
  }
  async function command(operation: 'prepare' | 'commitBoot' | 'close') {
    const request: DatasetOwnerRequest = { version: 1, type: 'request', epoch, requestId: randomUUID(), sequence: ++sequence, operation }
    const result = take(value => isDatasetOwnerResponse(value) && value.requestId === request.requestId)
    channel.port1.postMessage(request); return result
  }
  const endpoint = client ? createDatasetOwnerClient({ worker: worker as unknown as Worker, onFatal: reason => reasons.push(reason) }) : undefined
  if (endpoint) { await endpoint.prepare(); await endpoint.commitBoot(); await endpoint.workbenchContext!() }
  else { await command('prepare'); await command('commitBoot') }
  t.after(async () => {
    for (const release of releases) release()
    try { if (!disconnected) { if (endpoint) await endpoint.close(); else await command('close') } }
    catch { /* 关闭失败反例只清受控MessagePort，不伪称领域quiet或成功ACK。 */ }
    finally { channel.port1.close(); channel.port2.close() }
  })
  return { endpoint, state, reasons, packets, outgoing, closeEntered: closeEntered.promise, closedPort: closedPort.promise,
    setClose(work: () => Promise<void>) { closeWork = work }, setRead(work: () => Promise<void>) { readWork = work },
    releaseOnCleanup(release: () => void) { releases.add(release) }, command,
    build(body: unknown = {}, change: Partial<DatasetWorkbenchMeta> = {}) {
      const foreignEpoch = typeof change.epoch === 'string' && change.epoch !== epoch
      return { ...meta('drain', body), epoch, datasetId, sequence: foreignEpoch ? sequence + 1 : ++sequence, ...change }
    },
    post(value: unknown) { channel.port1.postMessage(value) },
    frame(request: DatasetWorkbenchMeta, part: DatasetWorkbenchFrame['part']) { return take(value => isDatasetWorkbenchFrame(value) && value.id === request.id && value.part === part) },
  }
}

test('私有drain真实超过2s：Client与Worker等待close及原取消context settled后才成功', { timeout: 8000 }, async t => {
  const f = await fixture(t), reading = deferred(), entered = deferred()
  f.releaseOnCleanup(reading.resolve)
  f.setRead(async () => { entered.resolve(); await reading.promise })
  const pending = f.endpoint!.workbenchContext!().then(() => '意外成功', error => error.code)
  await entered.promise
  const prior = f.state.contextCompleted
  f.setClose(async () => { await delay(2050); assert.equal(f.state.contextCompleted, prior); reading.resolve() })
  const started = performance.now(), sentAt = Date.now(); let complete = false
  const closing = f.endpoint!.closeWorkbench!().then(() => { complete = true })
  await f.closeEntered
  assert.equal(await pending, 'NOT_READY'); assert.equal(complete, false)
  await closing
  assert.ok(performance.now() - started >= 2000)
  assert.equal(f.state.closeCalls, 1); assert.equal(f.state.closeCompleted, 1); assert.equal(f.state.contextCompleted, prior + 1)
  const begin = f.outgoing.find((value): value is DatasetWorkbenchFrame => isDatasetWorkbenchFrame(value) && value.kind === 'drain' && value.part === 'begin')
  assert.ok(begin); assert.ok(begin.expiresAtMs >= sentAt + 9900 && begin.expiresAtMs <= sentAt + 10100, '发送端使用原10s期限，不能只升级Worker')
  assert.deepEqual(f.reasons, [])
  await f.endpoint!.close(); await f.closedPort
  assert.equal(f.state.domainClosed, 1)
})

test('私有drain失败：真实close拒绝仍发送failure并等quiet，不发布closed成功', async t => {
  const f = await fixture(t)
  f.setClose(async () => { throw new Error('合成实际close拒绝') })
  await assert.rejects(f.endpoint!.closeWorkbench!(), { code: 'NOT_READY' })
  const begin = f.outgoing.find((value): value is DatasetWorkbenchFrame => isDatasetWorkbenchFrame(value) && value.kind === 'drain' && value.part === 'begin')
  assert.ok(begin)
  assert.ok(f.packets.some(value => isDatasetWorkbenchFrame(value) && value.id === begin.id && value.part === 'settled'))
  assert.equal(f.packets.some(value => isDatasetWorkbenchFrame(value) && value.id === begin.id && value.part === 'end'), false)
  assert.equal(f.state.closeCalls, 1); assert.equal(f.state.closeCompleted, 0)
})

test('私有drain晚expiry：物理close完成也不得把已到期请求改报成功', async t => {
  const f = await fixture(t), finish = deferred(), originalNow = Date.now
  f.releaseOnCleanup(finish.resolve); f.setClose(async () => { await finish.promise })
  const result = f.endpoint!.closeWorkbench!().then(() => '意外成功', error => error.code)
  await f.closeEntered
  const clock = t.mock.method(Date, 'now', () => originalNow() + 10001)
  try { finish.resolve(); assert.equal(await result, 'TIMEOUT') } finally { clock.mock.restore() }
  assert.equal(f.state.closeCompleted, 1)
  const request = f.outgoing.find((value): value is DatasetWorkbenchFrame => isDatasetWorkbenchFrame(value) && value.kind === 'drain' && value.part === 'begin')!
  assert.equal(f.packets.some(value => isDatasetWorkbenchFrame(value) && value.id === request.id && value.part === 'end'), false)
})

for (const mode of ['正文非空', '摘要不符', '不同dataset', '超出10s', '原期限已过'] as const) {
  test(`私有drain反例：${mode}不进入领域close`, async t => {
    const f = await fixture(t, false), body = mode === '正文非空' ? { extra: true } : {}
    const change: Partial<DatasetWorkbenchMeta> = mode === '摘要不符' ? { requestSha256: 'f'.repeat(64) }
      : mode === '不同dataset' ? { datasetId: randomUUID() }
        : mode === '超出10s' ? { expiresAtMs: Date.now() + 11000 }
          : mode === '原期限已过' ? { expiresAtMs: Date.now() - 1 } : {}
    const request = f.build(body, change)
    for (const frame of datasetWorkbenchFrames(request, 'request', body)) f.post(frame)
    const failure = await f.frame(request, 'failure')
    assert.ok(isDatasetWorkbenchFrame(failure) && failure.part === 'failure')
    assert.equal(failure.code, mode === '不同dataset' ? 'NOT_READY' : mode === '原期限已过' ? 'TIMEOUT' : 'INVALID_IPC_REQUEST')
    await f.frame(request, 'settled'); assert.equal(f.state.closeCalls, 0)
  })
}

test('私有drain不同epoch：保原静默隔离，当前代请求仍可用且不触发领域关闭', async t => {
  const f = await fixture(t, false), request = f.build({}, { epoch: randomUUID() })
  f.post(datasetWorkbenchFrames(request, 'request', {})[0]!)
  const barrier = await f.command('commitBoot') // 同端口屏障；异代帧不消耗当前代sequence。
  assert.ok(isDatasetOwnerResponse(barrier) && barrier.ok)
  assert.equal(f.packets.some(value => isDatasetWorkbenchFrame(value) && value.id === request.id), false)
  assert.equal(f.packets.some(value => value !== null && typeof value === 'object' && 'type' in value && value.type === 'fatal'), false)
  assert.equal(f.state.closeCalls, 0); assert.equal(f.state.domainClosed, 0)
})

test('私有drain组装：首次begin后仍受2s限制，不能凭长expiry慢传正文', async t => {
  const f = await fixture(t, false), request = f.build(), frames = datasetWorkbenchFrames(request, 'request', {})
  f.post(frames[0]!); f.post(frames[1]!)
  await f.command('commitBoot') // 同MessagePort屏障保证Worker已收到begin与data。
  const originalNow = Date.now, clock = t.mock.method(Date, 'now', () => originalNow() + 2001)
  try {
    f.post(frames[2]!)
    const failure = await f.frame(request, 'failure')
    assert.ok(isDatasetWorkbenchFrame(failure) && failure.part === 'failure'); assert.equal(failure.code, 'TIMEOUT')
    await f.frame(request, 'settled')
  } finally { clock.mock.restore() }
  assert.equal(f.state.closeCalls, 0)
})
