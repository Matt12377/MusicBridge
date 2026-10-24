import assert from 'node:assert/strict'
import test from 'node:test'
import type { LocalLibraryManagementReadback } from '@music-bridge/contracts'
import { createCommandOutboxClient, createCommandOutboxDatasetScope } from '../src/preload/command-outbox-client.js'
import { createLocalWorkbenchClient } from '../src/preload/local-workbench-client.js'
import { createRecordingWorkspaceClient } from '../src/preload/recording-workspace-client.js'
import { createRecordingCandidateClient } from '../src/preload/recording-candidate-client.js'
import { createPreparationZipClient } from '../src/preload/preparation-zip-client.js'
import { createCommandOutboxStore } from '../src/main/command-outbox-store.js'
import { createCommandOutboxService } from '../src/main/command-outbox-service.js'
import { installCommandOutboxIpc } from '../src/main/command-outbox-ipc.js'

// 只执行原Preload及合成Main/SQLite内存接点；不启动App，不读真实工作库、Provider、目录或媒体。
const id = (n: number): string => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`
const datasetA = id(1), datasetB = id(2), commandId = id(3), targetId = id(4), outboxId = id(5)
const revoke = () => ({ commandId, id: targetId })
const checkpoint = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const readback = (): LocalLibraryManagementReadback => ({ datasetId: datasetA, revision: '1', scanConcurrency: 12, libraries: [] })

test('共享scope首次失败不永久锁死，后续显式workbench普通读恢复，失败的mutation绝不自动发送', async () => {
  let ready = false, contextReads = 0
  const calls: { channel: string; value: unknown }[] = []
  const invoke = async (channel: string, value?: unknown): Promise<unknown> => {
    calls.push({ channel, value: structuredClone(value) })
    if (channel === 'commandOutbox:context') { contextReads++; if (!ready) throw new Error('合成NOT_READY /private/内部路径'); return { datasetId: datasetA } }
    if (channel === 'localWorkbench:management') return readback()
    if (channel === 'commandOutbox:submit') return { ok: true, outboxId, result: { id: targetId, label: '合成来源', authorized: false, availability: 'REVOKED' } }
    if (channel === 'commandOutbox:acknowledge') return undefined
    throw new Error('禁止其他业务：' + channel)
  }
  const scope = createCommandOutboxDatasetScope(invoke), outbox = createCommandOutboxClient(invoke, scope), workbench = createLocalWorkbenchClient(invoke, scope)
  await assert.rejects(outbox.submit('recordingSources.revoke', revoke()), error => error instanceof Error && error.message.includes('OUTBOX_UNAVAILABLE') && !error.message.includes('/private/'))
  await checkpoint(); assert.equal(contextReads, 1); assert.deepEqual(calls.map(call => call.channel), ['commandOutbox:context'])
  ready = true
  assert.deepEqual(await workbench.localLibraryManagement('library.read', {}), readback())
  await checkpoint(); assert.equal(contextReads, 2)
  assert.equal(calls.some(call => call.channel === 'commandOutbox:submit' || call.channel === 'commandOutbox:revokePreparedBatch'), false, '读取恢复不能重新唤醒已失败的写调用')
  await outbox.submit('recordingSources.revoke', revoke())
  assert.deepEqual(calls.find(call => call.channel === 'commandOutbox:submit')!.value, { request: { datasetId: datasetA, command: 'recordingSources.revoke', payload: revoke() } })
  assert.equal(contextReads, 2, '成功后普通读取和显式写入均只用原pin')
})

test('context失败前后均单飞，每次失败只结束原调用，空闲时不自行重试', async () => {
  const first = deferred<unknown>(), second = deferred<unknown>(); let reads = 0
  const scope = createCommandOutboxDatasetScope(async channel => { assert.equal(channel, 'commandOutbox:context'); return ++reads === 1 ? first.promise : second.promise })
  const initial = Array.from({ length: 64 }, () => scope())
  assert.ok(initial.every(value => value === initial[0])); assert.equal(reads, 1)
  first.reject(new Error('合成首次context不可用'))
  assert.ok((await Promise.allSettled(initial)).every(value => value.status === 'rejected'))
  await checkpoint(); assert.equal(reads, 1, '首次拒绝后的finally不能启动重读')
  const repeated = Array.from({ length: 64 }, () => scope())
  assert.ok(repeated.every(value => value === repeated[0])); assert.equal(reads, 2)
  second.resolve({ datasetId: datasetA })
  assert.deepEqual(await Promise.all(repeated), Array.from({ length: 64 }, () => datasetA))
  assert.equal(scope(), repeated[0], '首次成功Promise永久pin，不能偷偷重新取另一身份')
  assert.equal(reads, 2)
})

test('非法context不pin，后续显式读取可恢复；首次成功后Main换库也不重新采集或变更dataset', async () => {
  for (const bad of [null, { datasetId: '不是UUID' }, { datasetId: datasetA, extra: true }]) {
    let current: unknown = bad, reads = 0
    const scope = createCommandOutboxDatasetScope(async () => { reads++; return current })
    await assert.rejects(scope(), /OUTBOX_UNAVAILABLE/u); await checkpoint(); assert.equal(reads, 1)
    current = { datasetId: datasetA }; assert.equal(await scope(), datasetA); assert.equal(reads, 2)
    current = { datasetId: datasetB }
    for (let attempt = 0; attempt < 3; attempt++) assert.equal(await scope(), datasetA)
    assert.equal(reads, 2)
  }
})

test('同步context抛错亦只拒绝当前调用，不使构造抛出或自动投递业务', async () => {
  let ready = false, reads = 0
  const scope = createCommandOutboxDatasetScope(() => { reads++; if (!ready) throw new Error('合成同步invoke拒绝'); return Promise.resolve({ datasetId: datasetA }) })
  await assert.rejects(scope(), /OUTBOX_UNAVAILABLE/u); await checkpoint(); assert.equal(reads, 1)
  ready = true; assert.equal(await scope(), datasetA); assert.equal(reads, 2)
})

test('scope重读期间仍先捕获原写DTO，字段和commandId不随等待中的表单变化', async () => {
  const retry = deferred<unknown>(); let reads = 0
  const calls: { channel: string; value: unknown }[] = []
  const invoke = async (channel: string, value?: unknown): Promise<unknown> => {
    calls.push({ channel, value: structuredClone(value) })
    if (channel === 'commandOutbox:context') { if (++reads === 1) throw new Error('合成首次拒绝'); return retry.promise }
    if (channel === 'commandOutbox:submit') return { ok: true, outboxId, result: { revoked: true } }
    return undefined
  }
  const scope = createCommandOutboxDatasetScope(invoke), client = createCommandOutboxClient(invoke, scope)
  await assert.rejects(scope(), /OUTBOX_UNAVAILABLE/u)
  const payload = revoke(), original = structuredClone(payload), pending = client.submit('recordingSources.revoke', payload)
  payload.commandId = id(90); payload.id = id(91)
  retry.resolve({ datasetId: datasetA }); await pending
  assert.deepEqual(calls.find(call => call.channel === 'commandOutbox:submit')!.value, { request: { datasetId: datasetA, command: 'recordingSources.revoke', payload: original } })
  assert.equal(calls.filter(call => call.channel === 'commandOutbox:submit').length, 1)
})

test('业务invoke已发后UNKNOWN仍不自动重试，context/普通读恢复也不重放；只有显式同命令重试带原retryConfirmed', async () => {
  let sends = 0, contextReads = 0
  const calls: { channel: string; value: unknown }[] = []
  const invoke = async (channel: string, value?: unknown): Promise<unknown> => {
    calls.push({ channel, value: structuredClone(value) })
    if (channel === 'commandOutbox:context') { contextReads++; return { datasetId: datasetA } }
    if (channel === 'localWorkbench:management') return readback()
    if (channel === 'commandOutbox:submit') { if (++sends === 1) throw new Error('合成业务回复丢失'); return { ok: true, outboxId, result: { revoked: true } } }
    return undefined
  }
  const scope = createCommandOutboxDatasetScope(invoke), client = createCommandOutboxClient(invoke, scope), reader = createLocalWorkbenchClient(invoke, scope)
  await assert.rejects(client.submit('recordingSources.revoke', revoke()), /OUTBOX_RESULT_UNKNOWN/u)
  await scope(); await reader.localLibraryManagement('library.read', {}); await checkpoint()
  assert.equal(sends, 1); assert.equal(contextReads, 1)
  await client.submit('recordingSources.revoke', revoke())
  const submitted = calls.filter(call => call.channel === 'commandOutbox:submit').map(call => call.value)
  assert.deepEqual(submitted, [
    { request: { datasetId: datasetA, command: 'recordingSources.revoke', payload: revoke() } },
    { request: { datasetId: datasetA, command: 'recordingSources.revoke', payload: revoke() }, retryConfirmed: true },
  ])
})

test('批次scope失败绝不发送；后续只读恢复不重放旧批，显式重试只发捕获的整批原commandId', async () => {
  let ready = false, reads = 0
  const calls: { channel: string; value: unknown }[] = []
  const requests = [revoke(), { commandId: id(6), id: id(7) }], original = structuredClone(requests)
  const invoke = async (channel: string, value?: unknown): Promise<unknown> => {
    calls.push({ channel, value: structuredClone(value) })
    if (channel === 'commandOutbox:context') { reads++; if (!ready) throw new Error('合成context拒绝'); return { datasetId: datasetA } }
    if (channel === 'commandOutbox:revokePreparedBatch') return { ok: true, submissions: [id(8), id(9)].map((outboxId, index) => ({ outboxId, result: { id: original[index]!.id, authorized: false } })) }
    return undefined
  }
  const scope = createCommandOutboxDatasetScope(invoke), client = createCommandOutboxClient(invoke, scope)
  await assert.rejects(client.submitPreparedRevocations(requests), /OUTBOX_UNAVAILABLE/u)
  await checkpoint(); assert.deepEqual(calls.map(call => call.channel), ['commandOutbox:context'])
  ready = true; await scope(); await checkpoint()
  assert.equal(calls.some(call => call.channel === 'commandOutbox:revokePreparedBatch'), false)
  const retry = client.submitPreparedRevocations(requests); requests[1]!.commandId = id(99); await retry
  assert.deepEqual(calls.find(call => call.channel === 'commandOutbox:revokePreparedBatch')!.value, { requests: original.map(payload => ({ datasetId: datasetA, command: 'recordingPrepared.revoke', payload })) })
  assert.equal(calls.filter(call => call.channel === 'commandOutbox:revokePreparedBatch').length, 1); assert.equal(reads, 2)
  assert.deepEqual(calls.filter(call => call.channel === 'commandOutbox:acknowledge').map(call => call.value), [{ id: id(8) }, { id: id(9) }])
})

test('成功pin后实际Main换库仍由原service拒绝旧dataset，保持原命令待确认且零业务执行', async t => {
  let currentDataset = datasetA, contextReads = 0, sends = 0
  const store = createCommandOutboxStore({ filePath: ':memory:' }), service = createCommandOutboxService({ store, currentDataset: async () => currentDataset, execute: async () => { sends++; return { id: targetId, label: '合成来源', authorized: false, availability: 'REVOKED' } } })
  t.after(() => service.close())
  const handlers = new Map<string, (event: boolean, value?: unknown) => unknown>()
  installCommandOutboxIpc({ handle: (channel, handler) => handlers.set(channel, handler), requireTrusted: trusted => { if (!trusted) throw new Error('非可信窗口') },
    context: async () => { contextReads++; return { datasetId: currentDataset } }, service, store })
  const invoke = (channel: string, value?: unknown) => Promise.resolve().then(() => handlers.get(channel)!(true, value))
  const scope = createCommandOutboxDatasetScope(invoke), client = createCommandOutboxClient(invoke, scope)
  assert.equal(await scope(), datasetA); currentDataset = datasetB
  await assert.rejects(client.submit('recordingSources.revoke', revoke()), /OUTBOX_SCOPE_MISMATCH/u)
  assert.equal(await scope(), datasetA); assert.equal(contextReads, 1); assert.equal(sends, 0)
  const entry = store.list()[0]!; assert.equal(entry.datasetId, datasetA); assert.equal(entry.commandId, commandId); assert.equal(entry.state, 'uncertain')
})

test('三个共享录音消费者不持有首次reject，显式普通读取共同单飞恢复，旧导出start不自动发送', async () => {
  let ready = false, reads = 0
  const calls: { channel: string; value: unknown }[] = []
  const invoke = async (channel: string, value?: unknown): Promise<unknown> => {
    calls.push({ channel, value: structuredClone(value) })
    if (channel === 'commandOutbox:context') { reads++; if (!ready) throw new Error('合成首次context失败'); return { datasetId: datasetA } }
    if (channel === 'recordingWorkspace:get') return { context: null }
    if (channel === 'recordingCandidates:request') return { scan: null }
    if (channel === 'recordingPreparationZip:choose') return null
    if (channel === 'recordingPreparationZip:request' && (value as { command: string }).command === 'recordingPreparationZip.job') return { job: null }
    throw new Error('此例禁止其他录音或ZIP业务')
  }
  const scope = createCommandOutboxDatasetScope(invoke), forbidden = async (): Promise<never> => { throw new Error('此例禁止任何录音mutation代理') }
  const workspace = createRecordingWorkspaceClient(invoke, forbidden, scope), candidates = createRecordingCandidateClient(invoke, forbidden, scope), zip = createPreparationZipClient(invoke, scope)
  const zipStart = { workspaceId: id(10), targetId: id(11), commandId: id(12), proposalFingerprint: 'a'.repeat(64), userConfirmed: true as const }
  await Promise.all([
    assert.rejects(workspace.getRecordingWorkspaceContext(id(10)), /OUTBOX_SCOPE_MISMATCH/u),
    assert.rejects(candidates.getRecordingSourceCandidateScan(id(11)), /OUTBOX_SCOPE_MISMATCH/u),
    assert.rejects(zip.getPreparationZipJob(id(12)), /OUTBOX_SCOPE_MISMATCH/u),
    assert.rejects(zip.startPreparationZip(zipStart), /OUTBOX_SCOPE_MISMATCH/u),
  ])
  await checkpoint(); assert.equal(reads, 1); assert.deepEqual(calls.map(call => call.channel), ['commandOutbox:context'])
  ready = true
  assert.deepEqual(await Promise.all([workspace.getRecordingWorkspaceContext(id(10)), candidates.getRecordingSourceCandidateScan(id(11)), zip.getPreparationZipJob(id(12))]), [null, { scan: null }, { job: null }])
  assert.equal(await zip.choosePreparationZipTarget(id(10)), null)
  await checkpoint(); assert.equal(reads, 2)
  assert.equal(calls.some(call => call.channel === 'recordingPreparationZip:request' && (call.value as { command: string }).command === 'recordingPreparationZip.start'), false)
  for (const call of calls.filter(call => call.channel !== 'commandOutbox:context')) assert.equal((call.value as { datasetId: string }).datasetId, datasetA)
})
