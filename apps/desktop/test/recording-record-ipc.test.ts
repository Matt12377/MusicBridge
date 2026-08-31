import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { CoreIpcError } from '../src/main/core-supervisor.js'

test('档案六入口只接受可信来源、固定工作库和有限处置DTO，绝不增加执行或设备入口', async () => {
  const module = await import('../src/main/recording-record-ipc.js').catch(() => ({}))
  assert.ok('installRecordingRecordHandlers' in module, '缺少录音档案IPC入口')
  const handlers = new Map<string, (event: boolean, payload?: unknown) => unknown>()
  const calls: Array<[string, unknown, unknown]> = []
  let failure: Error | undefined
  ;(module as typeof import('../src/main/recording-record-ipc.js')).installRecordingRecordHandlers({
    handle: (channel, handler) => handlers.set(channel, handler),
    requireTrusted: (trusted: boolean) => { if (!trusted) throw new Error('不可信档案调用') },
    supervisor: { request: (async (command: string, payload: unknown, scope: unknown) => {
      if (failure) throw failure
      calls.push([command, payload, scope]); return { dispatched: command }
    }) as never },
  })
  const datasetId = randomUUID(), id = randomUUID()
  const preview = { physicalId: 'MB-C-00427', expectedPhysicalRevision: 1, expectedContentRevision: 0, expectedAttempt: null, intent: { action: 'mark-content-unknown' } }
  const cases: Array<[string, unknown]> = [
    ['list', { page: { offset: 0, limit: 25 }, filter: { query: '427' } }], ['get', { id }],
    ['visual', { recordingId: id, attachmentId: id }], ['history', { physicalId: preview.physicalId, page: { offset: 0, limit: 25 } }],
    ['previewDisposition', preview], ['applyDisposition', { ...preview, commandId: id, proposalFingerprint: 'a'.repeat(64), userConfirmed: true }],
  ]
  const invoke = (name: string, payload: unknown, trusted = true) => Promise.resolve().then(() => handlers.get(`recordingRecords:${name}`)!(trusted, { datasetId, payload }))
  assert.deepEqual([...handlers.keys()].sort(), cases.map(([name]) => `recordingRecords:${name}`).sort())
  for (const [name, payload] of cases) {
    await assert.rejects(invoke(name, payload, false), /不可信档案调用/u)
    await assert.rejects(invoke(name, { ...(payload as object), certified: true }), /INVALID_IPC_REQUEST/u)
  }
  await assert.rejects(invoke('list', { page: { offset: 0, limit: 26 } }), /INVALID_IPC_REQUEST/u)
  await assert.rejects(invoke('applyDisposition', { ...(cases[5]![1] as object), userConfirmed: false }), /INVALID_IPC_REQUEST/u)
  await assert.rejects(invoke('previewDisposition', { ...preview, intent: { action: 'start-recording' } }), /INVALID_IPC_REQUEST/u)
  for (const value of [{}, { datasetId, payload: cases[0]![1], extra: true }, { datasetId: datasetId + '\n', payload: cases[0]![1] }]) {
    await assert.rejects(Promise.resolve().then(() => handlers.get('recordingRecords:list')!(true, value)), /INVALID_IPC_REQUEST/u)
  }
  assert.equal(calls.length, 0)
  for (const [name, payload] of cases) assert.deepEqual(await invoke(name, payload), { dispatched: `recordingRecords.${name}` })
  assert.deepEqual(calls, cases.map(([name, payload]) => [`recordingRecords.${name}`, payload, datasetId]))
  failure = new CoreIpcError('INVENTORY_CONFLICT', '/private/synthetic-detail')
  await assert.rejects(invoke('applyDisposition', cases[5]![1]), e => e instanceof Error && e.message.includes('[INVENTORY_CONFLICT]') && !e.message.includes('/private'))
  failure = new Error('/private/synthetic-detail')
  await assert.rejects(invoke('visual', cases[2]![1]), e => e instanceof Error && e.message.includes('[INVENTORY_UNAVAILABLE]') && !e.message.includes('/private'))
})

test('档案客户端在等待scope前捕获明确处置意图，失败不重放也不重新取得新库身份', async () => {
  const module = await import('../src/preload/recording-record-client.js').catch(() => ({}))
  assert.ok('createRecordingRecordClient' in module, '缺少固定工作库档案客户端')
  const datasetId = randomUUID(), calls: Array<[string, unknown]> = []
  let release!: (value: unknown) => void
  const scope = new Promise(resolve => { release = resolve })
  const client = (module as typeof import('../src/preload/recording-record-client.js')).createRecordingRecordClient(async (channel, value) => {
    calls.push([channel, value]); if (channel === 'commandOutbox:context') return scope
    throw new Error('[INVENTORY_CONFLICT] 合成冲突')
  })
  const request = { commandId: randomUUID(), physicalId: 'MB-C-00427', expectedPhysicalRevision: 1, expectedContentRevision: 0, expectedAttempt: null, intent: { action: 'mark-content-unknown' as const }, proposalFingerprint: 'a'.repeat(64), userConfirmed: true as const }
  const original = structuredClone(request), pending = client.applyPhysicalRecordingDisposition(request)
  request.physicalId = 'MB-C-00428'
  release({ datasetId })
  await assert.rejects(pending, /INVENTORY_CONFLICT/u)
  assert.deepEqual(calls, [['commandOutbox:context', undefined], ['recordingRecords:applyDisposition', { datasetId, payload: original }]])
  await assert.rejects(client.getRecordingRecord(datasetId), /INVENTORY_CONFLICT/u)
  assert.deepEqual(calls[2], ['recordingRecords:get', { datasetId, payload: { id: datasetId } }])
  assert.equal(calls.filter(([channel]) => channel === 'commandOutbox:context').length, 1)
  const invalid = (module as typeof import('../src/preload/recording-record-client.js')).createRecordingRecordClient(async () => ({ datasetId: '/private/invalid' }))
  await assert.rejects(invalid.listRecordingRecords({ page: { offset: 0, limit: 25 } }), e => e instanceof Error && e.message.includes('OUTBOX_SCOPE_MISMATCH') && !e.message.includes('/private'))
})
