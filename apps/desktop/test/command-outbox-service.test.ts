import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

async function fixture(t: test.TestContext) {
  const module = await import('../src/main/command-outbox-service.js').catch(() => ({}))
  assert.ok('createCommandOutboxService' in module, '缺少先落盘后发送的outbox服务')
  const { createCommandOutboxService } = module as typeof import('../src/main/command-outbox-service.js')
  const { createCommandOutboxStore } = await import('../src/main/command-outbox-store.js')
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-outbox-service-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, 'outbox.sqlite'), store = createCommandOutboxStore({ filePath })
  t.after(() => store.close())
  const input = { datasetId: randomUUID(), command: 'collection.setPolicy' as const, payload: { commandId: randomUUID(), modelId: randomUUID(), expectedRevision: 1, collectorPolicy: 'normal' as const, minimumSealedReserve: 0 } }
  const result = { modelId: input.payload.modelId }
  return { filePath, store, input, result, createCommandOutboxStore, createCommandOutboxService }
}

test('先持久请求再执行，singleflight合并，持久成功未ack跨Renderer可见', async t => {
  const f = await fixture(t); let calls = 0
  const service = f.createCommandOutboxService({ store: f.store, currentDataset: async () => f.input.datasetId, execute: async entry => {
    calls++; assert.equal(f.store.get(entry.id).state, 'sending'); assert.deepEqual(f.store.get(entry.id).payload, f.input.payload)
    return f.result
  } })
  const [one, two] = await Promise.all([service.submit(f.input), service.submit(f.input)])
  assert.deepEqual(one, two); assert.equal(calls, 1)
  assert.equal((await service.list()).entries[0]?.state, 'succeeded'); assert.equal((await service.list()).entries[0]?.acknowledged, false)
  assert.deepEqual(await service.submit(f.input), one); assert.equal(calls, 1)
  service.ack({ id: one.outboxId }); assert.equal((await service.list()).entries.length, 0)
})

test('未知结果保留原DTO，冷开零执行，只有人工retry才恢复原命令', async t => {
  const f = await fixture(t); let calls = 0
  const first = f.createCommandOutboxService({ store: f.store, currentDataset: async () => f.input.datasetId, execute: async () => { calls++; throw new Error('不能持久化的内部路径') } })
  await assert.rejects(first.submit(f.input)); const id = f.store.list()[0]!.id
  assert.equal(f.store.get(id).state, 'uncertain'); assert.equal(JSON.stringify(f.store.get(id)).includes('不能持久化'), false)
  f.store.close()
  const store = f.createCommandOutboxStore({ filePath: f.filePath })
  try {
    const cold = f.createCommandOutboxService({ store, currentDataset: async () => f.input.datasetId, execute: async entry => { calls++; assert.deepEqual(entry.payload, f.input.payload); return f.result } })
    assert.equal((await cold.list()).entries[0]?.state, 'uncertain'); assert.equal(calls, 1)
    await assert.rejects(cold.submit(f.input)); assert.equal(calls, 1)
    assert.equal((await cold.retry({ id, userConfirmed: true })).outboxId, id); assert.equal(calls, 2)
  } finally { store.close() }
})

test('scope不匹配不得执行或重盖scope，明确拒绝与unknown分开保留', async t => {
  const f = await fixture(t); let calls = 0, current = randomUUID()
  const service = f.createCommandOutboxService({ store: f.store, currentDataset: async () => current, execute: async () => { calls++; throw Object.assign(new Error('原始错误不持久化'), { code: 'INVENTORY_CONFLICT' }) } })
  await assert.rejects(service.submit(f.input)); assert.equal(calls, 0)
  const entry = f.store.list()[0]!; assert.equal(entry.datasetId, f.input.datasetId)
  current = f.input.datasetId
  await assert.rejects(service.retry({ id: entry.id, userConfirmed: true })); assert.equal(calls, 1)
  assert.equal(f.store.get(entry.id).state, 'rejected')
  await assert.rejects(service.retry({ id: entry.id, userConfirmed: true })); assert.equal(calls, 1)
})

test('无效结果不会登记成功，dismiss只放弃跟踪且不改业务请求', async t => {
  const f = await fixture(t)
  const service = f.createCommandOutboxService({ store: f.store, currentDataset: async () => f.input.datasetId, execute: async () => ({ absolutePath: '/private/不允许' }) })
  await assert.rejects(service.submit(f.input)); const id = f.store.list()[0]!.id
  assert.equal(f.store.get(id).state, 'uncertain')
  service.dismiss({ id, userConfirmed: true }); assert.equal((await service.list()).entries.length, 0)
  assert.deepEqual(f.store.get(id).payload, f.input.payload); assert.equal(f.store.get(id).state, 'dismissed')
  await assert.rejects(service.retry({ id, userConfirmed: true }))
})

test('人工retry和放弃跟踪必须显式确认，不能由无确认请求触发', async t => {
  const f = await fixture(t); let calls = 0
  const id = f.store.confirm(f.input).entry.id
  const service = f.createCommandOutboxService({ store: f.store, currentDataset: async () => f.input.datasetId, execute: async () => { calls++; return f.result } })
  await assert.rejects(service.retry({ id } as never)); assert.equal(calls, 0)
  assert.throws(() => service.dismiss({ id } as never)); assert.equal(f.store.get(id).state, 'pending')
  assert.equal((await service.retry({ id, userConfirmed: true })).outboxId, id)
})

test('成功回执落盘失败不能向Renderer返回成功，重开仍保留待确认', async t => {
  const f = await fixture(t)
  const service = f.createCommandOutboxService({ store: f.store, currentDataset: async () => f.input.datasetId, execute: async () => f.result })
  const succeed = t.mock.method(f.store, 'succeed', () => { throw new Error('合成回执落盘失败') })
  await assert.rejects(service.submit(f.input), { code: 'OUTBOX_RESULT_UNKNOWN' })
  assert.equal(f.store.list()[0]?.state, 'uncertain'); succeed.mock.restore()
  f.store.close(); const cold = f.createCommandOutboxStore({ filePath: f.filePath })
  try { assert.equal(cold.list()[0]?.state, 'uncertain') } finally { cold.close() }
})

test('确认落盘失败绝不调用executor，关闭时不开始等待中的scope检查后发送', async t => {
  const f = await fixture(t); let calls = 0
  const service = f.createCommandOutboxService({ store: f.store, currentDataset: async () => f.input.datasetId, execute: async () => { calls++; return f.result } })
  const confirmation = t.mock.method(f.store, 'confirm', () => { throw new Error('合成确认落盘失败') })
  await assert.rejects(service.submit(f.input)); assert.equal(calls, 0); confirmation.mock.restore()
  const result = service.submit(f.input).catch(error => error)
  await service.close(); assert.equal((await result).code, 'OUTBOX_UNAVAILABLE'); assert.equal(calls, 0)
})

test('原生选择取消的null回执可持久，重试已成功结果不重复打开对话框', async t => {
  const f = await fixture(t); let calls = 0
  const request = { datasetId: f.input.datasetId, command: 'recordingArchive.choose' as const, payload: { commandId: randomUUID() } }
  const service = f.createCommandOutboxService({ store: f.store, currentDataset: async () => f.input.datasetId, execute: async () => { calls++; return null } })
  const first = await service.submit(request)
  assert.equal(first.result, null); assert.deepEqual(await service.submit(request), first); assert.equal(calls, 1)
})

test('旧scope激活仅人工retry可只读恢复终态，初次submit和冷开不能查询或执行', async t => {
  const f = await fixture(t), old = { datasetId: f.input.datasetId, command: 'recordingBackups.activate' as const, payload: { commandId: randomUUID(), restoreJobId: randomUUID(), expectedActiveId: null, userConfirmed: true as const, stopPlaybackConfirmed: true as const } }
  const result = { id: randomUUID(), restoreJobId: old.payload.restoreJobId, previousId: null, state: 'active' as const, createdAt: new Date().toISOString(), contentIncluded: true }
  let executed = 0, recovered = 0
  const service = f.createCommandOutboxService({ store: f.store, currentDataset: async () => randomUUID(), execute: async () => { executed++; return result }, recoverAcrossDataset: async entry => { recovered++; assert.deepEqual(entry.payload, old.payload); return { found: true, result } } })
  await assert.rejects(service.submit(old), { code: 'OUTBOX_SCOPE_MISMATCH' })
  const entry = (await service.list()).entries[0]!
  assert.equal(entry.canRetry, true); assert.equal(recovered, 0); assert.equal(executed, 0)
  assert.deepEqual((await service.retry({ id: entry.id, userConfirmed: true })).result, result)
  assert.equal(recovered, 1); assert.equal(executed, 0)
})

test('旧scope只读恢复拒绝无回执、非终态和非激活命令，不能回落普通execute', async t => {
  const f = await fixture(t)
  let recovered = 0, executed = 0
  const service = f.createCommandOutboxService({ store: f.store, currentDataset: async () => randomUUID(), execute: async () => { executed++; return f.result }, recoverAcrossDataset: async () => { recovered++; return { found: false } } })
  const ordinary = f.store.confirm(f.input).entry
  await assert.rejects(service.retry({ id: ordinary.id, userConfirmed: true }), { code: 'OUTBOX_SCOPE_MISMATCH' })
  assert.equal(recovered, 0)
  const activation = f.store.confirm({ datasetId: f.input.datasetId, command: 'recordingBackups.activate', payload: { commandId: randomUUID(), restoreJobId: randomUUID(), expectedActiveId: null, userConfirmed: true, stopPlaybackConfirmed: true } }).entry
  await assert.rejects(service.retry({ id: activation.id, userConfirmed: true }), { code: 'OUTBOX_SCOPE_MISMATCH' })
  assert.equal(recovered, 1); assert.equal(executed, 0)
  const other = f.createCommandOutboxService({ store: f.store, currentDataset: async () => randomUUID(), execute: async () => { executed++; return f.result }, recoverAcrossDataset: async () => ({ found: true, result: { id: randomUUID(), restoreJobId: (activation.payload as { restoreJobId: string }).restoreJobId, previousId: null, state: 'preparing', createdAt: new Date().toISOString() } }) })
  await assert.rejects(other.retry({ id: activation.id, userConfirmed: true }), { code: 'OUTBOX_SCOPE_MISMATCH' }); assert.equal(executed, 0)
})

test('同会话明确retry标记才允许submit重发原DTO，缺标记或改参不发送', async t => {
  const f = await fixture(t); let calls = 0
  const service = f.createCommandOutboxService({ store: f.store, currentDataset: async () => f.input.datasetId, execute: async () => { calls++; if (calls === 1) throw new Error('合成丢回执'); return f.result } })
  await assert.rejects(service.submit(f.input)); await assert.rejects(service.submit(f.input)); assert.equal(calls, 1)
  await assert.rejects(service.submit(f.input, {}), { code: 'OUTBOX_RESULT_UNKNOWN' }); assert.equal(calls, 1)
  await assert.rejects(service.submit({ ...f.input, payload: { ...f.input.payload, minimumSealedReserve: 2 } }, { retryConfirmed: true }), { code: 'OUTBOX_CONFLICT' }); assert.equal(calls, 1)
  const result = await service.submit(f.input, { retryConfirmed: true }); assert.deepEqual(result.result, f.result); assert.equal(calls, 2)
})

test('查询数据集失败只返回固定安全码，不泄露callback内部错误', async t => {
  const f = await fixture(t)
  const service = f.createCommandOutboxService({ store: f.store, currentDataset: async () => { throw new Error('/private/不公开内容') }, execute: async () => f.result })
  await assert.rejects(service.list(), error => (error as { code: string }).code === 'OUTBOX_UNAVAILABLE' && !(error as Error).message.includes('/private/'))
})

function preparedBatch(datasetId: string) {
  return Array.from({ length: 3 }, () => ({ datasetId, command: 'recordingPrepared.revoke' as const, payload: { commandId: randomUUID(), id: randomUUID() } }))
}
const revokedResult = (id: string) => ({ id, preparationId: '11111111-1111-4111-8111-111111111111', side: 'A' as const, label: '合成PREP', authorized: false })

test('第一项执行前整批已落盘，首项未知仍执行其余项，显式同会话重试只恢复未知项', async t => {
  const f = await fixture(t), batch = preparedBatch(f.input.datasetId), calls = new Map<string, number>()
  const service = f.createCommandOutboxService({ store: f.store, currentDataset: async () => f.input.datasetId, execute: async entry => {
    assert.equal(f.store.list().length, batch.length, '不可在尾项确认落盘前执行首项')
    const count = (calls.get(entry.commandId) ?? 0) + 1; calls.set(entry.commandId, count)
    if (entry.commandId === batch[0]!.payload.commandId && count === 1) throw new Error('合成首项回执丢失')
    return revokedResult((entry.payload as { id: string }).id)
  } })
  assert.equal(typeof service.submitPreparedRevocations, 'function', '缺少Main批量投递入口')
  await assert.rejects(service.submitPreparedRevocations(batch))
  assert.deepEqual(batch.map(item => calls.get(item.payload.commandId)), [1, 1, 1])
  await assert.rejects(service.submitPreparedRevocations(batch)); assert.deepEqual(batch.map(item => calls.get(item.payload.commandId)), [1, 1, 1])
  await assert.rejects(service.submitPreparedRevocations([batch[0]!, { ...batch[1]!, payload: { ...batch[1]!.payload, id: randomUUID() } }], { retryConfirmed: true }), { code: 'OUTBOX_CONFLICT' })
  const results = await service.submitPreparedRevocations(batch, { retryConfirmed: true })
  assert.equal(results.length, 3); assert.deepEqual(batch.map(item => calls.get(item.payload.commandId)), [2, 1, 1])
})

test('Renderer不再参与循环时尾项仍有持久确认，冷开不发送，人工批量恢复原DTO', async t => {
  const f = await fixture(t), batch = preparedBatch(f.input.datasetId)
  assert.equal(typeof f.store.confirmBatch, 'function')
  const saved = f.store.confirmBatch(batch); f.store.markSending(saved[0]!.entry.id); f.store.close()
  const cold = f.createCommandOutboxStore({ filePath: f.filePath }); let calls = 0
  try {
    const service = f.createCommandOutboxService({ store: cold, currentDataset: async () => f.input.datasetId, execute: async entry => { calls++; assert.deepEqual(entry.payload, batch.find(item => item.payload.commandId === entry.commandId)!.payload); return revokedResult((entry.payload as { id: string }).id) } })
    assert.equal((await service.list()).entries.length, 3); assert.equal(calls, 0)
    assert.deepEqual(saved.map(item => cold.get(item.entry.id).state), ['uncertain', 'pending', 'pending'])
    await assert.rejects(service.submitPreparedRevocations(batch)); assert.equal(calls, 0)
    const result = await service.submitPreparedRevocations(batch, { retryConfirmed: true })
    assert.equal(result.length, 3); assert.equal(calls, 3)
  } finally { cold.close() }
})

test('坏批次完全不投递，不因前项合法而启动executor', async t => {
  const f = await fixture(t), batch = preparedBatch(f.input.datasetId); let calls = 0
  const service = f.createCommandOutboxService({ store: f.store, currentDataset: async () => f.input.datasetId, execute: async () => { calls++; return null } })
  assert.equal(typeof service.submitPreparedRevocations, 'function')
  await assert.rejects(service.submitPreparedRevocations([batch[0]!, f.input]), { code: 'INVALID_IPC_REQUEST' })
  assert.equal(calls, 0); assert.equal(f.store.list().length, 0)
})
