import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { CoreIpcError } from '../src/main/core-supervisor.js'

test('Attempt六入口先核可信来源和有限DTO；执行边界不经outbox，不允许客户端认证', async () => {
  const module = await import('../src/main/recording-attempt-ipc.js').catch(() => ({}))
  assert.ok('installRecordingAttemptHandlers' in module, '缺少独立且受限的录音尝试入口')
  const handlers = new Map<string, (event: boolean, payload?: unknown) => unknown>()
  const calls: Array<[string, unknown, unknown]> = []
  let failure: Error | undefined
  ;(module as typeof import('../src/main/recording-attempt-ipc.js')).installRecordingAttemptHandlers({
    handle: (channel, handler) => handlers.set(channel, handler),
    requireTrusted: (trusted: boolean) => { if (!trusted) throw new Error('不可信录音调用') },
    supervisor: { request: (async (command: string, payload: unknown, scope: unknown) => {
      if (failure) throw failure
      calls.push([command, payload, scope]); return { acceptedForTest: true }
    }) as never },
  })
  const datasetId = randomUUID()
  const invoke = (name: string, payload: unknown, trusted = true) => Promise.resolve().then(() => handlers.get(`recordingAttempts:${name}`)!(trusted, { datasetId, payload }))
  assert.deepEqual([...handlers.keys()].sort(), ['list','get','begin','confirm','beginSide','stop'].map(name => `recordingAttempts:${name}`).sort())
  const id = randomUUID(), commandId = randomUUID(), hash = 'a'.repeat(64)
  const cases: Array<[string, unknown]> = [
    ['list', { draftId: id, page: { offset: 0, limit: 25 } }],
    ['get', { attemptId: id }],
    ['begin', { commandId, planVersionId: id, planContentHash: hash, userConfirmed: true }],
    ['confirm', { commandId, attemptId: id, expectedRevision: 1, kind: 'physical-stop', side: 'A', userConfirmed: true }],
    ['beginSide', { commandId, attemptId: id, expectedRevision: 1, side: 'B', userConfirmed: true }],
    ['stop', { commandId, attemptId: id }],
  ]
  for (const [name, payload] of cases) await assert.rejects(invoke(name, payload, false), /不可信录音调用/u)
  for (const [name, payload] of cases) await assert.rejects(invoke(name, { ...(payload as object), certified: true }), /INVALID_IPC_REQUEST/u)
  await assert.rejects(invoke('beginSide', { commandId, attemptId: id, expectedRevision: 1, side: 'A', userConfirmed: true }), /INVALID_IPC_REQUEST/u)
  await assert.rejects(invoke('confirm', { commandId, attemptId: id, expectedRevision: 1, kind: 'backend-drained', userConfirmed: true }), /INVALID_IPC_REQUEST/u)
  await assert.rejects(Promise.resolve().then(() => handlers.get('recordingAttempts:list')!(true, { page: { offset: 0, limit: 25 } })), /INVALID_IPC_REQUEST/u)
  await assert.rejects(Promise.resolve().then(() => handlers.get('recordingAttempts:list')!(true, { datasetId, payload: cases[0]![1], certified: true })), /INVALID_IPC_REQUEST/u)
  assert.equal(calls.length, 0)
  for (const [name, payload] of cases) assert.deepEqual(await invoke(name, payload), { acceptedForTest: true })
  assert.deepEqual(calls, cases.map(([name, payload]) => [`recordingAttempts.${name}`, payload, datasetId]))
  failure = new CoreIpcError('NOT_READY', '/private/synthetic-secret-stack')
  await assert.rejects(invoke('begin', cases[2]![1]), error => error instanceof Error && error.message.includes('[NOT_READY]') && !error.message.includes('synthetic-secret'))
  failure = new Error('/private/synthetic-secret-stack')
  await assert.rejects(invoke('list', cases[0]![1]), error => error instanceof Error && error.message.includes('[INVENTORY_UNAVAILABLE]') && !error.message.includes('synthetic-secret'))
})
