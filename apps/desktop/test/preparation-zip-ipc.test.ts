import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { CoreIpcError } from '../src/main/core-supervisor.js'
import { installPreparationZipHandlers } from '../src/main/recording-preparation-zip-ipc.js'
import { createPreparationZipClient } from '../src/preload/preparation-zip-client.js'

function harness() {
  const handlers = new Map<string, (event: boolean, value?: unknown) => unknown>()
  const calls: unknown[][] = []
  const listeners = new Set<() => void>()
  const datasetId = randomUUID(), workspaceId = randomUUID(), draftId = randomUUID()
  let choosePath = '/private/synthetic/Logic.zip'
  let inspectionFailure: Error | undefined
  let coreFailure: Error | undefined
  let receiptResult: unknown = { status: 'unknown', job: null }
  installPreparationZipHandlers({
    handle: (channel, handler) => { handlers.set(channel, handler) },
    windowFor: trusted => {
      if (!trusted) throw new Error('不可信窗口')
      return { id: 7, onInvalidated: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } }
    },
    choose: async () => choosePath,
    inspectTarget: async () => {
      if (inspectionFailure) throw inspectionFailure
      return { parentPath: '/private/synthetic', parentDev: '1', parentIno: '2' }
    },
    supervisor: {
      requestInternal: (async (...args: unknown[]) => {
        calls.push(args)
        if (coreFailure) throw coreFailure
        return args[0] === 'recordingPreparationZip.authorizeTarget'
          ? { id: (args[1] as { targetId: string }).targetId, label: 'Logic.zip', expiresAt: (args[1] as { expiresAt: string }).expiresAt }
          : { invalidated: true }
      }) as never,
      request: (async (...args: unknown[]) => { calls.push(args); if (coreFailure) throw coreFailure; return args[0] === 'recordingPreparationZip.receipt' ? receiptResult : { draftId, jobs: [] } }) as never,
    },
  })
  return {
    handlers, calls, datasetId, workspaceId, draftId, listeners,
    choose: () => handlers.get('recordingPreparationZip:choose')!,
    request: () => handlers.get('recordingPreparationZip:request')!,
    setPath: (value: string) => { choosePath = value },
    failInspection: (value?: Error) => { inspectionFailure = value },
    failCore: (value?: Error) => { coreFailure = value },
    setReceipt: (value: unknown) => { receiptResult = value },
  }
}

test('Logic ZIP Main 原生目标只给短时句柄；文件系统 EACCES/ENOENT 不向 Renderer 泄露路径', async () => {
  const h = harness(), envelope = { datasetId: h.datasetId, workspaceId: h.workspaceId }
  await assert.rejects(Promise.resolve().then(() => h.choose()(false, envelope)), /不可信窗口/u)
  for (const code of ['EACCES', 'ENOENT'] as const) {
    h.failInspection(Object.assign(new Error(`${code}: /private/synthetic/secret.zip`), { code }))
    await assert.rejects(Promise.resolve().then(() => h.choose()(true, envelope)), error => error instanceof Error && error.message.includes('INVENTORY_UNAVAILABLE') && !error.message.includes('/private') && !error.message.includes('secret'))
  }
  h.failInspection()
  const target = await h.choose()(true, envelope) as { id: string; label: string; expiresAt: string }
  assert.equal(target.label, 'Logic.zip')
  assert.equal(JSON.stringify(target).includes('/private'), false)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0][0], 'recordingPreparationZip.authorizeTarget')
  assert.equal(h.calls[0][2], h.datasetId)
  const preview = { workspaceId: h.workspaceId, targetId: target.id }
  await h.request()(true, { datasetId: h.datasetId, command: 'recordingPreparationZip.preview', payload: preview })
  const exact = { kind: 'start', request: { ...preview, commandId: randomUUID(), proposalFingerprint: 'a'.repeat(64), userConfirmed: true } }
  assert.deepEqual(await h.request()(true, { datasetId: h.datasetId, command: 'recordingPreparationZip.receipt', payload: exact }), { status: 'unknown', job: null })
  assert.equal(h.calls.at(-1)?.[0], 'recordingPreparationZip.receipt')
  assert.equal(h.calls.at(-1)?.[2], h.datasetId)
  await assert.rejects(Promise.resolve().then(() => h.request()(true, { datasetId: h.datasetId, command: 'recordingPreparationZip.receipt', payload: { kind: 'start', request: { ...exact.request, absolute: '/private/secret.zip' } } })), /INVALID_IPC_REQUEST/u)
  await assert.rejects(Promise.resolve().then(() => h.request()(true, { datasetId: h.datasetId, command: 'recordingPreparationZip.preview', payload: { ...preview, targetId: randomUUID() } })), /INVALID_IPC_REQUEST/u)
  h.failCore(new CoreIpcError('INVENTORY_CONFLICT', '/private/synthetic/secret.zip'))
  await assert.rejects(Promise.resolve().then(() => h.request()(true, { datasetId: h.datasetId, command: 'recordingPreparationZip.list', payload: { draftId: h.draftId } })), error => error instanceof Error && error.message.includes('INVENTORY_CONFLICT') && !error.message.includes('/private'))
  h.failCore()
  for (const listener of [...h.listeners]) listener()
  await Promise.resolve()
  assert.equal(h.calls.at(-1)?.[0], 'recordingPreparationZip.invalidateScope')
  await assert.rejects(Promise.resolve().then(() => h.request()(true, { datasetId: h.datasetId, command: 'recordingPreparationZip.preview', payload: preview })), /INVALID_IPC_REQUEST/u)
  assert.deepEqual(await h.request()(true, { datasetId: h.datasetId, command: 'recordingPreparationZip.receipt', payload: exact }), { status: 'unknown', job: null })
})

test('Logic ZIP 预加载固定首次工作库且拒绝路径或错配回执', async () => {
  const datasetId = randomUUID(), workspaceId = randomUUID(), targetId = randomUUID(), draftId = randomUUID(), calls: unknown[][] = []
  const target = { id: targetId, label: 'Logic.zip', expiresAt: new Date(Date.now() + 60_000).toISOString() }
  let reply: unknown = target
  const client = createPreparationZipClient(async (channel, value) => { calls.push([channel, value]); return reply }, async () => datasetId)
  assert.deepEqual(await client.choosePreparationZipTarget(workspaceId), target)
  assert.deepEqual(calls[0], ['recordingPreparationZip:choose', { datasetId, workspaceId }])
  reply = { ...target, absolute: '/private/secret.zip' }
  await assert.rejects(client.choosePreparationZipTarget(workspaceId), /INVALID_IPC_RESPONSE/u)
  reply = { draftId, jobs: [] }
  assert.deepEqual(await client.listPreparationZips(draftId), reply)
  assert.equal((calls.at(-1)?.[1] as { datasetId: string }).datasetId, datasetId)
  await assert.rejects(client.previewPreparationZip({ workspaceId, targetId: 'wrong' }), /INVALID_IPC_REQUEST/u)
  const exact = { kind: 'start' as const, request: { workspaceId, targetId, commandId: randomUUID(), proposalFingerprint: 'a'.repeat(64), userConfirmed: true as const } }
  reply = { status: 'not-accepted', job: null }
  assert.deepEqual(await client.getPreparationZipReceipt(exact), { status: 'not-accepted', job: null })
  assert.deepEqual(calls.at(-1), ['recordingPreparationZip:request', { datasetId, command: 'recordingPreparationZip.receipt', payload: exact }])
  reply = { status: 'accepted', job: { id: randomUUID(), workspaceId, draftId, state: 'running', targetLabel: 'Logic.zip', fileCount: 1, completedFiles: 0 } }
  await assert.rejects(client.getPreparationZipReceipt(exact), /INVALID_IPC_RESPONSE/u)
})
