import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { isBackupOverview, isBackupIndexSummary, BACKUP_INDEX_MISSING_FACTS, isActivateRestoredDataset, isRestoreActivationView, validateIpcRequest, IPC_VERSION } from '../src/index.js';

test('显式激活合同保留两个确认与预期工作库，概览只返回安全回执', () => {
  const request = { commandId: randomUUID(), restoreJobId: randomUUID(), expectedActiveId: null, userConfirmed: true, stopPlaybackConfirmed: true };
  assert.equal(isActivateRestoredDataset(request), true);
  for (const change of [{ stopPlaybackConfirmed: false }, { userConfirmed: false }, { absolutePath: '/private/dataset' }, { expectedActiveId: undefined }]) assert.equal(isActivateRestoredDataset({ ...request, ...change }), false);
  const view = { id: randomUUID(), restoreJobId: request.restoreJobId, previousId: null, createdAt: new Date().toISOString(), state: 'active', contentIncluded: true };
  assert.equal(isRestoreActivationView(view), true);
  assert.equal(isRestoreActivationView({ ...view, source: '/private/dataset' }), false);
  assert.equal(isBackupOverview({ roots: [], jobs: [], activations: [view] }), true);
  assert.equal(validateIpcRequest({ version: IPC_VERSION, id: randomUUID(), command: 'recordingBackups.activate', payload: request }).ok, true);
});

test('旧索引回执的缺失明细必须明示省略数量，不虚构问题项', () => {
  const summary = { operationCount: 3, quarantinedCount: 1, issueCount: 2, historyTrusted: false, inventoryReconstructed: false, issueDetails: [], issueDetailsOmittedCount: 2, missingFacts: [...BACKUP_INDEX_MISSING_FACTS] };
  assert.equal(isBackupIndexSummary(summary), true);
  assert.equal(isBackupIndexSummary({ ...summary, issueDetailsOmittedCount: 1 }), false);
});
