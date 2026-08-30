import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { CoreIpcError } from '../src/main/core-supervisor.js'

test('Replica六入口固定工作库并严格拒绝任意来源、设备与假确认', async () => {
  const module = await import('../src/main/recording-replica-ipc.js').catch(() => ({}))
  assert.ok('installRecordingReplicaHandlers' in module, '缺少Replica IPC入口')
  const handlers = new Map<string, (trusted: boolean, value?: unknown) => unknown>()
  const calls: Array<[string, unknown, unknown]> = []
  let failure: Error | undefined
  ;(module as typeof import('../src/main/recording-replica-ipc.js')).installRecordingReplicaHandlers({
    handle: (channel, handler) => handlers.set(channel, handler),
    requireTrusted: (trusted: boolean) => { if (!trusted) throw new Error('不可信Replica调用') },
    supervisor: { request: (async (command: string, payload: unknown, scope: unknown) => {
      if (failure) throw failure
      calls.push([command, payload, scope]); return { dispatched: command }
    }) as never },
  })
  const datasetId = randomUUID(), id = randomUUID()
  const start = { runId: id, recordingId: id, target: 'actual-execution', side: 'A', expectedFingerprint: 'a'.repeat(64), userConfirmed: true }
  const cases: Array<[string, unknown]> = [['status', {}], ['inspect', { readId: id, recordingId: id }], ['cancelRead', { readId: id }], ['start', start], ['get', { runId: id }], ['stop', { runId: id }]]
  const invoke = (method: string, payload: unknown, trusted = true) => Promise.resolve().then(() => handlers.get(`recordingReplica:${method}`)!(trusted, { datasetId, payload }))
  assert.deepEqual([...handlers.keys()].sort(), cases.map(([method]) => `recordingReplica:${method}`).sort())
  for (const [method, payload] of cases) {
    await assert.rejects(invoke(method, payload, false), /不可信Replica调用/u)
    for (const extra of [{ path: '/private/synthetic.wav' }, { provider: 'synthetic' }, { deviceId: 1 }]) {
      await assert.rejects(invoke(method, { ...(payload as object), ...extra }), /INVALID_IPC_REQUEST/u)
    }
  }
  for (const patch of [{ userConfirmed: false }, { target: 'latest-master' }, { side: 'both' }, { expectedFingerprint: 'bad' }]) await assert.rejects(invoke('start', { ...start, ...patch }), /INVALID_IPC_REQUEST/u)
  for (const value of [{}, { datasetId, payload: {}, extra: true }, { datasetId: datasetId + '\n', payload: {} }]) await assert.rejects(Promise.resolve().then(() => handlers.get('recordingReplica:status')!(true, value)), /INVALID_IPC_REQUEST/u)
  assert.equal(calls.length, 0)
  for (const [method, payload] of cases) assert.deepEqual(await invoke(method, payload), { dispatched: `recordingReplica.${method}` })
  assert.deepEqual(calls, cases.map(([method, payload]) => [`recordingReplica.${method}`, payload, datasetId]))
  failure = new CoreIpcError('NOT_READY', '/private/synthetic-backend')
  await assert.rejects(invoke('start', start), e => e instanceof Error && e.message.includes('[NOT_READY]') && !e.message.includes('/private'))
  failure = new Error('/private/synthetic-stack')
  await assert.rejects(invoke('inspect', cases[1]![1]), e => e instanceof Error && e.message.includes('[INVENTORY_UNAVAILABLE]') && !e.message.includes('/private'))
})

test('Replica客户端在等待scope之前复制明确选择，失败不重播也不换库', async () => {
  const module = await import('../src/preload/recording-replica-client.js').catch(() => ({}))
  assert.ok('createRecordingReplicaClient' in module, '缺少Replica固定scope客户端')
  const datasetId = randomUUID(), calls: Array<[string, unknown]> = []
  let release!: (value: unknown) => void
  const scope = new Promise(resolve => { release = resolve })
  const client = (module as typeof import('../src/preload/recording-replica-client.js')).createRecordingReplicaClient(async (channel, value) => {
    calls.push([channel, value]); if (channel === 'commandOutbox:context') return scope
    throw new Error('[NOT_READY] 后端不可用')
  })
  const request = { runId: randomUUID(), recordingId: randomUUID(), target: 'actual-execution' as const, side: 'A' as const, expectedFingerprint: 'a'.repeat(64), userConfirmed: true as const }
  const captured = structuredClone(request), pending = client.startRecordingReplica(request)
  request.recordingId = randomUUID(); release({ datasetId })
  await assert.rejects(pending, /NOT_READY/u)
  assert.deepEqual(calls, [['commandOutbox:context', undefined], ['recordingReplica:start', { datasetId, payload: captured }]])
  await assert.rejects(client.stopRecordingReplica(captured.runId), /NOT_READY/u)
  assert.deepEqual(calls[2], ['recordingReplica:stop', { datasetId, payload: { runId: captured.runId } }])
  assert.equal(calls.filter(([channel]) => channel === 'commandOutbox:context').length, 1)
  const invalid = (module as typeof import('../src/preload/recording-replica-client.js')).createRecordingReplicaClient(async () => ({ datasetId: '/private/invalid' }))
  await assert.rejects(invalid.getRecordingReplicaStatus(), e => e instanceof Error && e.message.includes('OUTBOX_SCOPE_MISMATCH') && !e.message.includes('/private'))
})
