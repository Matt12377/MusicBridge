import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { isPreparationZipHistory, isPreparationZipJob, isPreparationZipProposal, isPreparationZipReceipt, isPreparationZipReceiptRequest, isPreparationZipTarget, isPreviewPreparationZipRequest, isStartPreparationZipRequest } from '../src/preparation-export.js';

const id = (): string => randomUUID();
const hash = 'a'.repeat(64);
test('Preparation ZIP 公共合同只接受短时目标 ID，不接受路径与额外字段', () => {
  const workspaceId = id(), targetId = id(), draftId = id(), masterVersionId = id(), layoutVersionId = id();
  const target = { id: targetId, label: 'MusicBridge-Preparation.zip', expiresAt: new Date().toISOString() };
  const preview = { workspaceId, targetId };
  const proposal = { ...preview, draftId, masterVersionId, layoutVersionId, targetLabel: target.label, manifestHash: hash, fileCount: 4, sourceBytes: 128, proposalFingerprint: hash, executionReady: false };
  const start = { ...preview, commandId: id(), proposalFingerprint: hash, userConfirmed: true };
  assert.ok(isPreparationZipTarget(target));
  assert.ok(isPreviewPreparationZipRequest(preview));
  assert.ok(isPreparationZipProposal(proposal));
  assert.ok(isStartPreparationZipRequest(start));
  assert.ok(isPreparationZipReceiptRequest({ kind: 'start', request: start }));
  assert.ok(isPreparationZipReceiptRequest({ kind: 'cancel', request: { commandId: id(), id: id() } }));
  assert.equal(isPreparationZipReceiptRequest({ kind: 'start', request: { ...start, absolute: '/private/example.zip' } }), false);
  assert.equal(isPreparationZipReceiptRequest({ kind: 'cancel', request: { commandId: id(), id: id(), workspaceId } }), false);
  assert.ok(isPreparationZipReceipt({ status: 'unknown', job: null }));
  assert.ok(isPreparationZipReceipt({ status: 'not-accepted', job: null }));
  assert.equal(isPreparationZipReceipt({ status: 'accepted', job: null }), false);
  assert.equal(isPreparationZipReceipt({ status: 'not-accepted', job: { id: id() } }), false);
  assert.equal(isPreparationZipTarget({ ...target, path: '/private/example.zip' }), false);
  assert.equal(isPreviewPreparationZipRequest({ ...preview, absolute: '/private/example.zip' }), false);
  assert.equal(isStartPreparationZipRequest({ ...start, userConfirmed: false }), false);
});

test('Preparation ZIP 完成必须有 Hash/尺寸，取消与失败不能伪装完成', () => {
  const draftId = id();
  const base = { id: id(), workspaceId: id(), draftId, targetLabel: 'package.zip', fileCount: 5, completedFiles: 5 };
  const completed = { ...base, state: 'completed', zipSha256: hash, zipBytes: 2048 };
  assert.ok(isPreparationZipJob(completed));
  assert.ok(isPreparationZipHistory({ draftId, jobs: [completed] }));
  assert.equal(isPreparationZipJob({ ...completed, zipSha256: undefined }), false);
  assert.equal(isPreparationZipJob({ ...completed, state: 'cancelled', failure: 'CANCELLED' }), false);
  assert.ok(isPreparationZipJob({ ...base, state: 'cancelled', failure: 'CANCELLED' }));
});
