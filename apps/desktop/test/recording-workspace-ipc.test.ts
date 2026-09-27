import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { CoreIpcError } from '../src/main/core-supervisor.js'
import { installRecordingWorkspaceRead } from '../src/main/recording-workspace-ipc.js'
import { createRecordingWorkspaceClient } from '../src/preload/recording-workspace-client.js'
import { createCommandOutboxClient, createCommandOutboxDatasetScope } from '../src/preload/command-outbox-client.js'

test('工作台 Main 仅读取可信窗口指定工作库，拒绝非法 DTO 并隐藏内部错误', async () => {
  const handlers = new Map<string, (trusted: boolean, value?: unknown) => unknown>()
  const calls: unknown[][] = []
  let failure: Error | undefined
  installRecordingWorkspaceRead({
    handle: (channel, fn) => { handlers.set(channel, fn) },
    requireTrusted: trusted => { if (!trusted) throw new Error('不可信窗口') },
    supervisor: { request: (async (...args: unknown[]) => { if (failure) throw failure; calls.push(args); return { context: null } }) as never },
  })
  const handler = handlers.get('recordingWorkspace:get')!
  const datasetId = randomUUID(), draftId = randomUUID()
  const envelope = { datasetId, payload: { draftId } }
  await assert.rejects(Promise.resolve().then(() => handler(false, envelope)), /不可信窗口/u)
  for (const invalid of [{ ...envelope, extra: true }, { datasetId: 'wrong', payload: { draftId } }, { datasetId, payload: { draftId, certified: true } }]) {
    await assert.rejects(Promise.resolve().then(() => handler(true, invalid)), /INVALID_IPC_REQUEST/u)
  }
  assert.deepEqual(calls, [])
  assert.deepEqual(await handler(true, envelope), { context: null })
  assert.deepEqual(calls, [['recordingWorkspace.get', { draftId }, datasetId]])
  failure = new CoreIpcError('OUTBOX_SCOPE_MISMATCH', '/private/synthetic')
  await assert.rejects(Promise.resolve().then(() => handler(true, envelope)), error => error instanceof Error && error.message.includes('OUTBOX_SCOPE_MISMATCH') && !error.message.includes('/private'))
  failure = new Error('/private/synthetic')
  await assert.rejects(Promise.resolve().then(() => handler(true, envelope)), error => error instanceof Error && error.message.includes('INVENTORY_UNAVAILABLE') && !error.message.includes('/private'))
})

test('实体副本 Main 读取绑定原工作库并只接受永久 ID', async () => {
  const handlers = new Map<string, (trusted: boolean, value?: unknown) => unknown>()
  const calls: unknown[][] = []
  let failure: Error | undefined
  installRecordingWorkspaceRead({
    handle: (channel, fn) => { handlers.set(channel, fn) },
    requireTrusted: trusted => { if (!trusted) throw new Error('不可信窗口') },
    supervisor: { request: (async (...args: unknown[]) => { if (failure) throw failure; calls.push(args); return { modelId: randomUUID(), copy: { physicalId: 'MB-C-00427' } } }) as never },
  })
  const handler = handlers.get('collection:copy')!
  const datasetId = randomUUID(), physicalId = 'MB-C-00427', envelope = { datasetId, payload: { physicalId } }
  await assert.rejects(Promise.resolve().then(() => handler(false, envelope)), /不可信窗口/u)
  for (const invalid of [{ ...envelope, extra: true }, { datasetId: 'wrong', payload: { physicalId } }, { datasetId, payload: { physicalId: 'bad' } }]) {
    await assert.rejects(Promise.resolve().then(() => handler(true, invalid)), /INVALID_IPC_REQUEST/u)
  }
  assert.deepEqual(calls, [])
  await handler(true, envelope)
  assert.deepEqual(calls, [['collection.copy', { physicalId }, datasetId]])
  failure = new CoreIpcError('INVENTORY_CONFLICT', '/private/synthetic')
  await assert.rejects(Promise.resolve().then(() => handler(true, envelope)), error => error instanceof Error && error.message.includes('实体副本不存在') && !error.message.includes('/private'))
})

test('工作台预加载读取验证响应与草稿身份，窗口内不悄悄切换工作库', async () => {
  const datasetId = randomUUID(), draftId = randomUUID(), otherDraftId = randomUUID()
  const calls: unknown[][] = []
  let response: unknown = { context: null }
  const saved = { draftId, draftRevision: 1, contextRevision: 1, selection: {}, pagePosition: 'workbench' as const, staleReasons: [] }
  const client = createRecordingWorkspaceClient(async (channel, value) => {
    calls.push([channel, value])
    return channel === 'commandOutbox:context' ? { datasetId } : response
  }, async () => saved)
  assert.equal(await client.getRecordingWorkspaceContext(draftId), null)
  response = { context: saved }
  assert.deepEqual(await client.getRecordingWorkspaceContext(draftId), saved)
  response = { context: { ...saved, draftId: otherDraftId } }
  await assert.rejects(client.getRecordingWorkspaceContext(draftId), /INVALID_IPC_RESPONSE/u)
  response = { context: saved, hidden: true }
  await assert.rejects(client.getRecordingWorkspaceContext(draftId), /INVALID_IPC_RESPONSE/u)
  assert.equal(calls.filter(call => call[0] === 'commandOutbox:context').length, 1)
  for (const call of calls.filter(call => call[0] === 'recordingWorkspace:get')) assert.deepEqual(call[1], { datasetId, payload: { draftId } })
  const invalid = createRecordingWorkspaceClient(async () => ({ datasetId: '/private/not-uuid' }), async () => saved)
  await assert.rejects(invalid.getRecordingWorkspaceContext(draftId), error => error instanceof Error && error.message.includes('OUTBOX_SCOPE_MISMATCH') && !error.message.includes('/private'))
})

test('实体副本预加载只接受同 ID 合法实时投影，继续使用首次窗口工作库', async () => {
  const datasetId = randomUUID(), physicalId = 'MB-C-00427', calls: unknown[][] = []
  const copy = { physicalId, lotId: randomUUID(), skuId: randomUUID(), lengthMinutes: 90,
    packaging: 'opened', usage: 'blank', available: true, origin: 'blank-pool', revision: 3 }
  const modelId = randomUUID()
  let response: unknown = { modelId, copy }
  const client = createRecordingWorkspaceClient(async (channel, value) => {
    calls.push([channel, value])
    return channel === 'commandOutbox:context' ? { datasetId } : response
  }, async () => { throw new Error('本测试不得写入') })
  assert.deepEqual(await client.getCollectionCopy(physicalId), response)
  response = { modelId, copy: { ...copy, physicalId: 'MB-C-00428' } }
  await assert.rejects(client.getCollectionCopy(physicalId), /INVALID_IPC_RESPONSE/u)
  response = { modelId, copy, extra: 'private' }
  await assert.rejects(client.getCollectionCopy(physicalId), /INVALID_IPC_RESPONSE/u)
  await assert.rejects(client.getCollectionCopy('bad-id'), /INVALID_IPC_REQUEST/u)
  assert.equal(calls.filter(call => call[0] === 'commandOutbox:context').length, 1)
  for (const call of calls.filter(call => call[0] === 'collection:copy')) assert.deepEqual(call[1], { datasetId, payload: { physicalId } })
})

test('工作台读取与 outbox 写入共用一次窗口工作库身份，切库后不悄悄重绑', async () => {
  const originalDataset = randomUUID(), laterDataset = randomUUID(), draftId = randomUUID(), physicalId = 'MB-C-00427'
  const modelId = randomUUID(), calls: Array<[string, unknown]> = []
  const copy = { physicalId, lotId: randomUUID(), skuId: randomUUID(), lengthMinutes: 90,
    packaging: 'opened', usage: 'blank', available: true, origin: 'blank-pool', revision: 1 }
  const saved = { draftId, draftRevision: 1, contextRevision: 1, selection: {}, pagePosition: 'workbench' as const, staleReasons: [] }
  const invoke = async (channel: string, value?: unknown): Promise<unknown> => {
    calls.push([channel, value])
    if (channel === 'commandOutbox:context') return { datasetId: calls.filter(([name]) => name === channel).length === 1 ? originalDataset : laterDataset }
    if (channel === 'collection:copy') return { modelId, copy }
    if (channel === 'commandOutbox:submit') return { ok: true, outboxId: randomUUID(), result: saved }
    return undefined
  }
  const getDatasetId = createCommandOutboxDatasetScope(invoke)
  const outbox = createCommandOutboxClient(invoke, getDatasetId)
  const workspace = createRecordingWorkspaceClient(invoke, request => outbox.submit('recordingWorkspace.put', request), getDatasetId)
  assert.deepEqual(await workspace.getCollectionCopy(physicalId), { modelId, copy })
  const request = { commandId: randomUUID(), draftId, expectedDraftRevision: 1, expectedContextRevision: 0,
    selection: {}, pagePosition: 'workbench' as const }
  assert.deepEqual(await workspace.putRecordingWorkspaceContext(request), saved)
  assert.equal(calls.filter(([name]) => name === 'commandOutbox:context').length, 1)
  assert.deepEqual(calls.find(([name]) => name === 'collection:copy')?.[1], { datasetId: originalDataset, payload: { physicalId } })
  const submitted = calls.find(([name]) => name === 'commandOutbox:submit')?.[1] as { request: { datasetId: string } }
  assert.equal(submitted.request.datasetId, originalDataset)
})
