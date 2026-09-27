import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { CoreIpcError } from '../src/main/core-supervisor.js'
import { installRecordingCandidateHandlers } from '../src/main/recording-candidate-ipc.js'
import { createRecordingCandidateClient } from '../src/preload/recording-candidate-client.js'
import { createCommandOutboxDatasetScope } from '../src/preload/command-outbox-client.js'

const ids = () => ({ datasetId: randomUUID(), commandId: randomUUID(), rootId: randomUUID(), draftId: randomUUID(), trackId: randomUUID() })
const start = (id: ReturnType<typeof ids>) => ({ commandId: id.commandId, rootId: id.rootId, draftId: id.draftId, trackId: id.trackId, expectedDraftRevision: 2 })
const scan = (request: ReturnType<typeof start>) => ({ id: request.commandId, rootId: request.rootId, draftId: request.draftId, trackId: request.trackId, expectedDraftRevision: request.expectedDraftRevision,
  state: 'completed' as const, scannedEntries: 1, skippedSymlinks: 0, skippedUnreadable: 0, candidates: [] })

test('候选 Main 仅可信窗口且旧工作库身份固定，非法 DTO 与私有错误不外泄', async () => {
  const handlers = new Map<string, (trusted: boolean, value?: unknown) => unknown>(), calls: unknown[][] = []
  let failure: Error | undefined
  const id = ids(), request = start(id), result = scan(request)
  installRecordingCandidateHandlers({
    handle: (channel, fn) => { handlers.set(channel, fn) },
    requireTrusted: trusted => { if (!trusted) throw new Error('不可信窗口') },
    supervisor: { request: (async (...args: unknown[]) => { if (failure) throw failure; calls.push(args); return args[0] === 'recordingCandidates.get' ? { scan: result } : result }) as never },
  })
  const handle = handlers.get('recordingCandidates:request')!
  const envelope = { datasetId: id.datasetId, command: 'recordingCandidates.start', payload: request }
  await assert.rejects(Promise.resolve().then(() => handle(false, envelope)), /不可信窗口/u)
  for (const bad of [
    { ...envelope, extra: true }, { ...envelope, datasetId: randomUUID().replace('4', 'z') },
    { ...envelope, command: 'recordingCandidates.select' }, { ...envelope, payload: { ...request, absolutePath: '/private/source' } },
    { ...envelope, payload: { ...request, expectedDraftRevision: 0 } },
  ]) await assert.rejects(Promise.resolve().then(() => handle(true, bad)), /INVALID_IPC_REQUEST/u)
  assert.deepEqual(calls, [])
  assert.deepEqual(await handle(true, envelope), result)
  assert.deepEqual(await handle(true, { datasetId: id.datasetId, command: 'recordingCandidates.get', payload: { id: request.commandId } }), { scan: result })
  assert.deepEqual(await handle(true, { datasetId: id.datasetId, command: 'recordingCandidates.cancel', payload: { commandId: randomUUID(), id: request.commandId } }), result)
  assert.deepEqual(calls.map(call => [call[0], call[2]]), [['recordingCandidates.start', id.datasetId], ['recordingCandidates.get', id.datasetId], ['recordingCandidates.cancel', id.datasetId]])
  failure = new CoreIpcError('OUTBOX_SCOPE_MISMATCH', '/private/secret')
  await assert.rejects(Promise.resolve().then(() => handle(true, envelope)), error => error instanceof Error && error.message.includes('OUTBOX_SCOPE_MISMATCH') && !error.message.includes('/private'))
})

test('预加载只暴露去路径候选；选中候选才交持久 Outbox，重启空会话不复活', async () => {
  const id = ids(), request = start(id), current = scan(request), calls: unknown[][] = [], selections: unknown[] = []
  let reply: unknown = current
  const invoke = async (channel: string, value?: unknown): Promise<unknown> => {
    calls.push([channel, value])
    if (channel === 'commandOutbox:context') return { datasetId: id.datasetId }
    return reply
  }
  const client = createRecordingCandidateClient(invoke, async selected => { selections.push(selected); return { id: selected.commandId, draftId: selected.draftId, trackId: selected.trackId, rootId: selected.rootId, state: 'running' } }, createCommandOutboxDatasetScope(invoke))
  assert.deepEqual(await client.startRecordingSourceCandidateScan(request), current)
  reply = { scan: current }
  assert.deepEqual(await client.getRecordingSourceCandidateScan(request.commandId), { scan: current })
  reply = { scan: null }
  assert.deepEqual(await client.getRecordingSourceCandidateScan(request.commandId), { scan: null }, 'Core 冷启没有会话，不从持久回执恢复候选')
  reply = { ...current, state: 'cancelled' }
  assert.equal((await client.cancelRecordingSourceCandidateScan({ commandId: randomUUID(), id: request.commandId })).state, 'cancelled')
  const selected = { commandId: randomUUID(), rootId: id.rootId, draftId: id.draftId, trackId: id.trackId, acquisition: 'userFileBind' as const,
    candidate: { scanId: request.commandId, candidateId: randomUUID(), expectedDraftRevision: 2 } }
  assert.equal((await client.selectRecordingSourceCandidate(selected)).id, selected.commandId)
  assert.deepEqual(selections, [selected])
  assert.equal(calls.filter(call => call[0] === 'commandOutbox:context').length, 1)
  for (const [, envelope] of calls.filter(call => call[0] === 'recordingCandidates:request')) assert.equal((envelope as { datasetId: string }).datasetId, id.datasetId)
  assert.equal(JSON.stringify(calls).includes('/private'), false)
  reply = { scan: { ...current, id: randomUUID() } }
  await assert.rejects(client.getRecordingSourceCandidateScan(request.commandId), /INVALID_IPC_RESPONSE/u)
  await assert.rejects(client.startRecordingSourceCandidateScan({ ...request, expectedDraftRevision: 0 }), /INVALID_IPC_REQUEST/u)
})
