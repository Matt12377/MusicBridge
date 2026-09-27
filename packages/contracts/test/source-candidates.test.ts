import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { isCommandOutboxRequest, isCommandOutboxDispatchResult, validateIpcRequest, validateIpcResponseForCommand } from '../src/index.js'

const id = () => randomUUID()
const valid = (command: string, payload: unknown) => validateIpcRequest({ version: 1, id: id(), command, payload }).ok
const response = (command: Parameters<typeof validateIpcResponseForCommand>[1], result: unknown) => validateIpcResponseForCommand({ version: 1, id: id(), ok: true, result }, command).ok

test('候选命令只接受有界身份和去路径响应；临时扫描不在持久 Outbox 允许表', () => {
  const rootId = id(), draftId = id(), trackId = id(), commandId = id()
  const start = { commandId, rootId, draftId, trackId, expectedDraftRevision: 1 }
  const scan = { id: commandId, rootId, draftId, trackId, expectedDraftRevision: 1, state: 'completed', scannedEntries: 1, skippedSymlinks: 0, skippedUnreadable: 0,
    candidates: [{ id: id(), fileName: '合成.wav', relativeLabel: '合成目录/合成.wav', extension: 'wav', size: 400, modifiedAt: '2026-09-27T00:00:00.000Z' }] }
  assert.equal(valid('recordingCandidates.start', start), true)
  assert.equal(valid('recordingCandidates.get', { id: commandId }), true)
  assert.equal(valid('recordingCandidates.cancel', { commandId: id(), id: commandId }), true)
  assert.equal(response('recordingCandidates.start', scan), true)
  assert.equal(response('recordingCandidates.get', { scan }), true)
  assert.equal(response('recordingCandidates.get', { scan: null }), true)
  assert.equal(response('recordingCandidates.cancel', { ...scan, state: 'cancelled' }), true)
  assert.equal(isCommandOutboxRequest({ datasetId: id(), command: 'recordingCandidates.start', payload: start }), false)
  assert.equal(isCommandOutboxRequest({ datasetId: id(), command: 'recordingCandidates.cancel', payload: { commandId: id(), id: commandId } }), false)
  for (const bad of [
    { ...start, absolutePath: '/private/source' }, { ...start, expectedDraftRevision: 0 }, { ...start, rootId: '/private/source' },
  ]) assert.equal(valid('recordingCandidates.start', bad), false)
  for (const bad of [
    { ...scan, absolutePath: '/private/source' }, { ...scan, candidates: [{ ...scan.candidates[0], absolutePath: '/private/source' }] },
    { ...scan, candidates: [{ ...scan.candidates[0], fileName: '../秘密.wav' }] },
  ]) assert.equal(response('recordingCandidates.start', bad), false)
})

test('候选选择必须带扫描身份证据才入 Outbox；旧手选来源原体继续接受', () => {
  const datasetId = id(), rootId = id(), draftId = id(), trackId = id(), commandId = id(), scanId = id(), candidateId = id()
  const previous = { commandId, rootId, draftId, trackId, acquisition: 'userFileBind' }
  const selected = { ...previous, candidate: { scanId, candidateId, expectedDraftRevision: 1 } }
  const job = { id: commandId, rootId, draftId, trackId, state: 'running' }
  assert.equal(isCommandOutboxRequest({ datasetId, command: 'recordingSources.choose', payload: previous }), true)
  assert.equal(isCommandOutboxRequest({ datasetId, command: 'recordingCandidates.select', payload: selected }), true)
  assert.equal(valid('recordingCandidates.select', selected), true)
  assert.equal(response('recordingCandidates.select', job), true)
  assert.equal(isCommandOutboxDispatchResult({ command: 'recordingCandidates.select', result: job }), true)
  assert.equal(isCommandOutboxRequest({ datasetId, command: 'recordingCandidates.select', payload: previous }), false)
  assert.equal(isCommandOutboxRequest({ datasetId, command: 'recordingCandidates.select', payload: { ...selected, absolutePath: '/private/source' } }), false)
})
