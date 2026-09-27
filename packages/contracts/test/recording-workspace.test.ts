import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  isCommandOutboxExecute, isCommandOutboxResult, isPutRecordingWorkspaceContextRequest,
  validateIpcRequest, validateIpcResponseForCommand,
} from '../src/index.js';

test('工作台合同限定草稿、双修订、页面位置和选择，只有 put 可走 outbox', () => {
  const draftId = randomUUID(), datasetId = randomUUID();
  const payload = { commandId: randomUUID(), draftId, expectedDraftRevision: 1, expectedContextRevision: 0,
    selection: { selectedPhysicalId: 'MB-C-00427', path: 'logic' }, pagePosition: 'media' };
  const context = { draftId, draftRevision: 1, contextRevision: 1, selection: payload.selection, pagePosition: payload.pagePosition, staleReasons: [] };
  assert.equal(isPutRecordingWorkspaceContextRequest(payload), true);
  assert.equal(validateIpcRequest({ version: 1, id: 'workspace', command: 'recordingWorkspace.get', payload: { draftId } }).ok, true);
  assert.equal(validateIpcRequest({ version: 1, id: 'workspace', command: 'recordingWorkspace.put', payload }).ok, true);
  assert.equal(isCommandOutboxExecute({ datasetId, command: 'recordingWorkspace.put', payload }), true);
  assert.equal(isCommandOutboxExecute({ datasetId, command: 'recordingWorkspace.get', payload: { draftId, commandId: randomUUID() } }), false);
  assert.equal(isCommandOutboxResult({ command: 'recordingWorkspace.put', result: context }), true);
  assert.equal(validateIpcResponseForCommand({ version: 1, id: 'workspace', ok: true, result: { context } }, 'recordingWorkspace.get').ok, true);
  assert.equal(validateIpcResponseForCommand({ version: 1, id: 'workspace', ok: true, result: { context: null } }, 'recordingWorkspace.get').ok, true);
  for (const wrong of [
    { ...payload, expectedContextRevision: -1 }, { ...payload, expectedDraftRevision: 0 },
    { ...payload, selection: { ...payload.selection, credential: 'secret' } },
    { ...payload, pagePosition: 'start-output' },
  ]) assert.equal(isPutRecordingWorkspaceContextRequest(wrong), false);
  assert.equal(validateIpcResponseForCommand({ version: 1, id: 'workspace', ok: true, result: { context: { ...context, outputCertified: true } } }, 'recordingWorkspace.get').ok, false);
});
