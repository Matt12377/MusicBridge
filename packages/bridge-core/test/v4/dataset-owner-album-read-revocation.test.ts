import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { Worker, MessageChannel } from 'node:worker_threads'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { createDatasetOwnerClient } from '../../src/collection/dataset-owner-client.js'
import { createDatasetOwnerReadRevocation, isDatasetOwnerReadRevocationBuffer } from '../../src/collection/dataset-owner-read-revocation.js'
import { LocalAlbumReadError } from '../../src/collection/local-album-browser/grouping.js'
import type { DatasetOwnerFatalReason } from '../../src/collection/dataset-owner-protocol.js'

type Phase = 'codec' | 'publish' | 'barrier' | 'transaction' | 'abort' | 'normal'
type Observation = { type: string; ok?: boolean; code?: string; point?: string; total?: number; sourceRows?: number; readerCurrent?: boolean; compactPublished?: number; committedMarkers?: number; inTransaction?: boolean; fdClosed?: boolean; databaseClosed?: boolean }
const immediate = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/** 真Worker、实际Client/Worker协议、SQLite与测试自有FD；领域仅为受控Gate，不冒充正式Source许可。 */
async function fixture(t: TestContext, phase: Phase) {
  const temporary = process.env.TMPDIR; assert.ok(temporary && path.isAbsolute(temporary))
  if (process.platform === 'darwin') assert.ok(temporary === '/Volumes/LifeWeave/Developer/CommandLine/tmp' || temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))
  const directory = await mkdtemp(path.join(temporary, 'album-read-revocation-'))
  const sourcePath = path.join(directory, 'owned-source.bin'); await writeFile(sourcePath, Buffer.from('测试自有FD必须实际关闭'), { flag: 'wx', mode: 0o600 })
  const revocation = createDatasetOwnerReadRevocation(), gate = new Int32Array(new SharedArrayBuffer(4))
  const channel = new MessageChannel(), observations: Observation[] = [], listeners = new Set<() => void>()
  channel.port1.on('message', (value: Observation) => { observations.push(value); for (const wake of [...listeners]) wake() })
  const datasetId = randomUUID(), reasons: DatasetOwnerFatalReason[] = []
  const worker = new Worker(new URL('../helpers/dataset-owner-album-read-revocation-fixture.ts', import.meta.url), {
    execArgv: ['--import', 'tsx'], workerData: { datasetId, phase, databasePath: path.join(directory, 'synthetic.sqlite'), sourcePath,
      albumReadRevocationBuffer: revocation.buffer, gate: gate.buffer, controlPort: channel.port2 }, transferList: [channel.port2],
  })
  const exit = once(worker, 'exit').then(value => Number(value[0])); void exit.catch(() => undefined)
  let exited = false; worker.once('exit', () => { exited = true })
  const endpoint = createDatasetOwnerClient({ worker, albumReadRevocationBuffer: revocation.buffer, onFatal: reason => reasons.push(reason) })
  const releaseCodec = () => { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0) }
  const releaseFd = () => { channel.port1.postMessage({ type: 'release-fd' }) }
  function take(type: string, index = 0): Promise<Observation> {
    const found = () => observations.filter(value => value.type === type)[index]
    const prior = found(); if (prior) return Promise.resolve(prior)
    return new Promise(resolve => { const wake = () => { const value = found(); if (value) { listeners.delete(wake); resolve(value) } }; listeners.add(wake) })
  }
  t.after(async () => {
    releaseCodec(); releaseFd()
    let timer: NodeJS.Timeout | undefined
    try {
      if (!exited) await Promise.race([endpoint.close(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('合成Worker清理未自然退出')), 3000) })])
    } finally {
      if (timer) clearTimeout(timer)
      // 只在失败清理时终止测试自有Worker；成功断言必须观察原协议自然exit0，不能以此代替quiet。
      if (!exited) await worker.terminate()
      channel.port1.close(); await rm(directory, { recursive: true, force: true })
    }
  })
  const identity = await endpoint.prepare(); await endpoint.commitBoot(); await endpoint.workbenchContext!()
  const read = (signal = new AbortController().signal) => endpoint.dispatchWorkbenchOwner!({ command: 'registry.operations', payload: {} }, { identity, signal, deadlineAtMs: performance.now() + 2000 })
  return { revocation, endpoint, read, take, observations, reasons, exit, releaseCodec, releaseFd }
}

test('撤销闩只允许固定共享内存并保持单向，新对象不会复位旧闩', () => {
  const first = createDatasetOwnerReadRevocation(), otherView = createDatasetOwnerReadRevocation(first.buffer), fresh = createDatasetOwnerReadRevocation()
  assert.equal(isDatasetOwnerReadRevocationBuffer(first.buffer), true)
  for (const value of [new ArrayBuffer(4), new SharedArrayBuffer(0), new SharedArrayBuffer(8), {}]) assert.equal(isDatasetOwnerReadRevocationBuffer(value), false)
  first.assertActive(); otherView.assertActive(); first.revoke(); first.revoke()
  const unavailable = (error: unknown) => error instanceof LocalAlbumReadError && error.code === 'UNAVAILABLE'
  assert.throws(first.assertActive, unavailable); assert.throws(otherView.assertActive, unavailable)
  fresh.assertActive(); assert.notEqual(fresh.buffer, first.buffer); assert.equal(Atomics.load(new Int32Array(first.buffer), 0), 1)
})

for (const phase of ['codec', 'publish', 'barrier'] as const) test('跨线程关闭撤销实际SQLite冷读：' + phase + '，flag不冒充FD quiet', { timeout: 15000 }, async t => {
  const f = await fixture(t, phase)
  const reading = f.read().then(() => 'SUCCESS', error => String(error.code))
  assert.equal((await f.take('query.entered')).point, phase === 'codec' ? 'source-codec' : phase === 'publish' ? 'compact-row' : 'final-barrier')
  let closed = false
  const closing = f.endpoint.closeWorkbench!().then(() => { closed = true })
  assert.equal(Atomics.load(new Int32Array(f.revocation.buffer), 0), 1, 'closeWorkbench必须同步置闩，不能等待Owner接收drain')
  f.releaseCodec()
  const outcome = await f.take('query.outcome')
  assert.equal(outcome.ok, false); assert.equal(outcome.code, 'UNAVAILABLE'); assert.equal(outcome.readerCurrent, false)
  assert.equal(outcome.compactPublished, phase === 'barrier' ? 1 : 0, '前两阶段不得发布部分组装；末屏障阶段须弃掉撤销前已构造的缓存')
  if (phase === 'codec') assert.ok(outcome.sourceRows! < 96, '必须在原SELECT中观察跨线程撤销，不能读完全部行后再丢回复')
  assert.equal(await reading, 'NOT_READY')
  assert.equal((await f.take('close.entered')).fdClosed, false)
  await immediate(); assert.equal(closed, false); assert.equal(f.observations.some(value => value.type === 'fd.closed'), false)
  f.releaseFd(); await closing; assert.equal((await f.take('fd.closed')).fdClosed, true)
  assert.deepEqual(f.reasons, []); await f.endpoint.close(); assert.equal(await f.exit, 0)
  assert.equal((await f.take('domain.closed')).databaseClosed, true)

  // 真实新Worker重新打开独立合成库；旧闩保持1，新代必须取得完整96组，而非缓存前缀。
  const next = await fixture(t, 'normal'), normalRead = next.read()
  const page = await next.take('query.outcome'); assert.equal(page.ok, true); assert.equal(page.total, 96); assert.equal(page.compactPublished, 1)
  assert.equal(Atomics.load(new Int32Array(f.revocation.buffer), 0), 1); next.revocation.assertActive(); await normalRead
  next.releaseFd(); await next.endpoint.closeWorkbench!(); await next.endpoint.close(); assert.equal(await next.exit, 0); assert.deepEqual(next.reasons, [])
})

test('已开始的显式写事务内原事实重核不被闩打断，COMMIT之后普通读取仍拒绝', { timeout: 15000 }, async t => {
  const f = await fixture(t, 'transaction'), first = f.read()
  await f.take('query.entered'); f.revocation.revoke(); f.releaseCodec()
  const committed = await f.take('query.outcome')
  assert.equal(committed.ok, true); assert.equal(committed.total, 96); assert.equal(committed.committedMarkers, 2); assert.equal(committed.inTransaction, false)
  await first
  const after = f.read().then(() => 'SUCCESS', error => String(error.code))
  const rejected = await f.take('query.outcome', 1)
  assert.equal(rejected.ok, false); assert.equal(rejected.code, 'UNAVAILABLE'); assert.equal(rejected.committedMarkers, 2); assert.equal(rejected.readerCurrent, false)
  assert.equal(await after, 'NOT_READY')
  f.releaseFd(); await f.endpoint.closeWorkbench!(); await f.endpoint.close(); assert.equal(await f.exit, 0); assert.deepEqual(f.reasons, [])
})

test('单次请求Abort只撤本次响应，不置永久共享闩或冒充整个Owner关闭', { timeout: 15000 }, async t => {
  const f = await fixture(t, 'abort'), controller = new AbortController()
  const request = f.read(controller.signal).then(() => 'SUCCESS', error => String(error.code))
  await f.take('query.entered'); controller.abort(); assert.equal(await request, 'TIMEOUT')
  f.revocation.assertActive(); assert.equal(Atomics.load(new Int32Array(f.revocation.buffer), 0), 0)
  f.releaseCodec(); const outcome = await f.take('query.outcome')
  assert.equal(outcome.ok, true); assert.equal(outcome.total, 96); f.revocation.assertActive()
  await f.endpoint.joinWorkbench!(); assert.equal(f.observations.some(value => value.type === 'close.entered'), false)
  f.releaseFd(); await f.endpoint.closeWorkbench!(); await f.endpoint.close(); assert.equal(await f.exit, 0); assert.deepEqual(f.reasons, [])
})
