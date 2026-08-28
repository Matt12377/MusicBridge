import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { createCommandOutboxStore } from '../src/main/command-outbox-store.js'
import { createCommandOutboxService } from '../src/main/command-outbox-service.js'

test('outbox IPC只接受可信Renderer与有限DTO，先保存再发送并保留待确认结果', async t => {
  const module = await import('../src/main/command-outbox-ipc.js').catch(() => ({}))
  assert.ok('installCommandOutboxIpc' in module, 'Main缺少outbox正式入口')
  const install = (module as typeof import('../src/main/command-outbox-ipc.js')).installCommandOutboxIpc
  const datasetId = randomUUID(), modelId = randomUUID(), store = createCommandOutboxStore({ filePath: ':memory:' })
  const service = createCommandOutboxService({ store, currentDataset: async () => datasetId, execute: async entry => { assert.equal(store.get(entry.id).state, 'sending'); return { modelId } } })
  t.after(() => service.close())
  const handlers = new Map<string, (event: boolean, value?: unknown) => unknown>()
  install({ handle: (channel, handler) => { handlers.set(channel, handler) }, requireTrusted: (event: boolean) => { if (!event) throw new Error('拒绝未知来源') }, context: async () => ({ datasetId }), service, store })
  const call = (channel: string, value?: unknown, trusted = true) => Promise.resolve().then(() => handlers.get(channel)!(trusted, value))
  assert.equal(handlers.size, 7)
  await assert.rejects(call('commandOutbox:context', undefined, false)); assert.equal(store.list().length, 0)
  const payload = { commandId: randomUUID(), model: { brand: '合成', name: '库存', edition: '测试', year: null, format: 'cassette', tapeType: 'II', identification: 'verified' }, lengthMinutes: 60, quantities: { sealedBlank: 1, openedBlank: 0, legacyUsed: 0, unclassified: 0 } }
  const request = { datasetId, command: 'collection.receive', payload }
  assert.deepEqual(await call('commandOutbox:submit', { request: { ...request, command: 'auth.setCredential', payload: { credential: '合成禁止载荷' } } }), { ok: false, code: 'INVALID_IPC_REQUEST' })
  assert.equal(store.list().length, 0)
  const result = await call('commandOutbox:submit', { request }) as { ok: boolean; outboxId: string; result: unknown }
  assert.equal(result.ok, true); assert.deepEqual(result.result, { modelId }); assert.equal(store.get(result.outboxId).acknowledged, false)
  const overview = await call('commandOutbox:overview') as { entries: unknown[] }
  assert.equal(overview.entries.length, 1); assert.equal(JSON.stringify(overview).includes('payload'), false)
  const acknowledged = await call('commandOutbox:acknowledge', { id: result.outboxId }) as { acknowledged: boolean }
  assert.equal(acknowledged.acknowledged, true); assert.equal((await service.list()).entries.length, 0)
})

test('PREP专用批次IPC仅收可信有限撤权集合，所有项先持久，其他命令不能借批次进入', async t => {
  const { installCommandOutboxIpc } = await import('../src/main/command-outbox-ipc.js')
  const datasetId = randomUUID(), preparationId = randomUUID(), store = createCommandOutboxStore({ filePath: ':memory:' })
  let sends = 0
  const service = createCommandOutboxService({ store, currentDataset: async () => datasetId, execute: async entry => {
    assert.equal(store.list().length, 2); sends++
    return { id: (entry.payload as { id: string }).id, preparationId, side: 'A', label: '合成文件', authorized: false }
  } })
  t.after(() => service.close())
  const handlers = new Map<string, (event: boolean, value?: unknown) => unknown>()
  installCommandOutboxIpc({ handle: (channel, handler) => handlers.set(channel, handler), requireTrusted: (trusted: boolean) => { if (!trusted) throw new Error('不可信') }, context: async () => ({ datasetId }), service, store })
  const call = (value: unknown, trusted = true) => Promise.resolve().then(() => handlers.get('commandOutbox:revokePreparedBatch')!(trusted, value))
  assert.ok(handlers.has('commandOutbox:revokePreparedBatch'))
  const requests = [0, 1].map(() => ({ datasetId, command: 'recordingPrepared.revoke', payload: { commandId: randomUUID(), id: randomUUID() } }))
  await assert.rejects(call({ requests }, false))
  for (const value of [{ requests: [] }, { requests: [...requests, ...requests] }, { requests: [requests[0], { ...requests[1], command: 'recordingSources.revoke' }] }, { requests, absolutePath: '/private/forbidden' }]) {
    assert.deepEqual(await call(value), { ok: false, code: 'INVALID_IPC_REQUEST' })
  }
  assert.equal(store.list().length, 0); assert.equal(sends, 0)
  const reply = await call({ requests }) as { ok: boolean; submissions: { outboxId: string; result: { authorized: boolean } }[] }
  assert.equal(reply.ok, true); assert.equal(reply.submissions.length, 2); assert.equal(sends, 2)
  assert.equal(reply.submissions.every(entry => entry.result.authorized === false && !store.get(entry.outboxId).acknowledged), true)
})

test('outbox IPC冷开只读；人工恢复返回view，不把私有请求和结果返回列表', async t => {
  const module = await import('../src/main/command-outbox-ipc.js').catch(() => ({})); assert.ok('installCommandOutboxIpc' in module)
  const install = (module as typeof import('../src/main/command-outbox-ipc.js')).installCommandOutboxIpc
  const datasetId = randomUUID(), store = createCommandOutboxStore({ filePath: ':memory:' }), id = randomUUID(); let sends = 0
  const service = createCommandOutboxService({ store, currentDataset: async () => datasetId, execute: async () => { if (++sends === 1) throw new Error('私有细节不能传出'); return { id, label: '合成目录', authorized: false, availability: 'REVOKED' } } })
  t.after(() => service.close())
  const handlers = new Map<string, (event: boolean, value?: unknown) => unknown>()
  install({ handle: (channel, handler) => handlers.set(channel, handler), requireTrusted: () => {}, context: async () => ({ datasetId }), service, store })
  const call = (channel: string, value?: unknown) => Promise.resolve().then(() => handlers.get(channel)!(true, value))
  await call('commandOutbox:overview'); assert.equal(sends, 0)
  const failure = await call('commandOutbox:submit', { request: { datasetId, command: 'recordingSources.revoke', payload: { commandId: id, id } } })
  assert.equal(JSON.stringify(failure).includes('私有细节'), false)
  const entry = store.list()[0]!
  await assert.rejects(call('commandOutbox:retry', { id: entry.id })); assert.equal(sends, 1)
  const view = await call('commandOutbox:retry', { id: entry.id, userConfirmed: true }) as Record<string, unknown>
  assert.equal(view.state, 'succeeded'); assert.equal('payload' in view, false); assert.equal('result' in view, false); assert.equal(sends, 2)
})
