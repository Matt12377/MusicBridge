import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { CoreIpcError } from '../src/main/core-supervisor.js'
import { installRecordingDeviceHandlers } from '../src/main/recording-device-ipc.js'
import { createRecordingDeviceClient } from '../src/preload/recording-device-client.js'

test('设备Main只接受可信窗口、当前工作库和有限请求，不转发UID或私有错误', async () => {
  const handlers = new Map<string, (trusted: boolean, value?: unknown) => unknown>(), calls: unknown[][] = []
  const datasetId = randomUUID(), selected = { endpointId: 'endpoint-a', selectionGeneration: randomUUID() }
  let failure: Error | undefined
  installRecordingDeviceHandlers({
    handle: (channel, handler) => { handlers.set(channel, handler) },
    requireTrusted: trusted => { if (!trusted) throw new Error('不可信窗口') },
    supervisor: { request: (async (...args: unknown[]) => { if (failure) throw failure; calls.push(args); return args[0] === 'recordingDevice.select' ? selected
      : { candidates: [{ endpointId: 'endpoint-a', label: '合成端点', available: true }], selected: null, blockedReason: null, deviceOpened: false, gateB: 'NOT_RUN', formalReady: false } }) as never },
  })
  const list = handlers.get('recordingDevice:candidates')!, select = handlers.get('recordingDevice:select')!
  await assert.rejects(Promise.resolve().then(() => list(false, { datasetId, payload: {} })), /不可信窗口/u)
  for (const bad of [
    { datasetId, payload: {}, extra: true },
    { datasetId: randomUUID().replace('4', 'z'), payload: {} },
    { datasetId, payload: { uid: 'private-device-uid' } },
  ]) await assert.rejects(Promise.resolve().then(() => list(true, bad)), /INVALID_IPC_REQUEST/u)
  for (const bad of [{ datasetId, payload: { endpointId: 'endpoint-a', uid: 'private' } },
    { datasetId, payload: { endpointId: '/private/output' } }]) await assert.rejects(Promise.resolve().then(() => select(true, bad)), /INVALID_IPC_REQUEST/u)
  assert.deepEqual(calls, [])
  assert.equal((await select(true, { datasetId, payload: { endpointId: 'endpoint-a' } }) as typeof selected).endpointId, 'endpoint-a')
  await list(true, { datasetId, payload: {} })
  assert.deepEqual(calls.map(call => [call[0], call[2]]), [['recordingDevice.select', datasetId], ['recordingDevice.candidates', datasetId]])
  failure = new CoreIpcError('OUTBOX_SCOPE_MISMATCH', '/private/secret')
  await assert.rejects(Promise.resolve().then(() => select(true, { datasetId, payload: { endpointId: 'endpoint-a' } })),
    error => error instanceof Error && error.message.includes('OUTBOX_SCOPE_MISMATCH') && !error.message.includes('/private'))
})

test('Preload在等待工作库身份之前固定显式端点，不采用调用方迟到修改', async () => {
  let release!: (value: unknown) => void
  const scope = new Promise<unknown>(resolve => { release = resolve }), datasetId = randomUUID(), calls: unknown[][] = []
  const client = createRecordingDeviceClient(async (channel, value) => {
    if (channel === 'commandOutbox:context') return scope
    calls.push([channel, value]); return { endpointId: 'endpoint-a', selectionGeneration: randomUUID() }
  })
  const request = { endpointId: 'endpoint-a' }, pending = client.selectRecordingDevice(request)
  request.endpointId = 'endpoint-b'
  release({ datasetId })
  await pending
  assert.deepEqual(calls, [['recordingDevice:select', { datasetId, payload: { endpointId: 'endpoint-a' } }]])
})
