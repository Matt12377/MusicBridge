import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

test('备份概览合同严格限制公开根信息，拒绝路径和未声明字段', async () => {
  const api = await import('../src/recording-backups.js').catch(() => ({}));
  assert.ok('isBackupOverview' in api, '备份概览合同尚未定义');
  const valid = (api as typeof import('../src/recording-backups.js')).isBackupOverview;
  assert.equal(valid({ roots: [], jobs: [], activations: [] }), true);
  const root = { id: randomUUID(), kind: 'backup-destination', label: '合成备份目录', authorized: true };
  assert.equal(valid({ roots: [root], jobs: [], activations: [] }), true);
  assert.equal(valid({ roots: [{ ...root, absolutePath: '/private/synthetic' }], jobs: [], activations: [] }), false);
  assert.equal(valid({ roots: [root, root], jobs: [], activations: [] }), false);
});

test('备份确认按操作限制字段，恢复必须引用已核验任务', async () => {
  const api = await import('../src/recording-backups.js');
  assert.equal(typeof api.isStartBackupJob, 'function', '尚无确认请求合同');
  const id = randomUUID(), commandId = randomUUID();
  assert.equal(api.isStartBackupJob({ commandId, kind: 'backup', rootId: id, mode: 'metadata', userConfirmed: true }), true);
  assert.equal(api.isStartBackupJob({ commandId, kind: 'backup', rootId: id, mode: 'metadata', userConfirmed: false }), false);
  assert.equal(api.isStartBackupJob({ commandId, kind: 'restore', rootId: id, destinationId: randomUUID(), verificationId: randomUUID(), userConfirmed: true }), true);
  assert.equal(api.isStartBackupJob({ commandId, kind: 'restore', rootId: id, destinationId: randomUUID(), userConfirmed: true }), false);
  assert.equal(api.isStartBackupJob({ commandId, kind: 'verify', rootId: id, mode: 'archive-content', userConfirmed: true }), false);
});

test('原生授权响应只允许内部通道，普通响应验证拒绝', async () => {
  const { validateIpcInternalResponseForCommand, validateIpcResponseForCommand } = await import('../src/validator.js');
  const root = { id: randomUUID(), kind: 'backup-destination', label: '测试目录', authorized: true };
  const response = { version: 1, id: randomUUID(), ok: true, result: root };
  assert.equal(validateIpcInternalResponseForCommand(response, 'recordingBackups.authorize' as never).ok, true);
  assert.equal(validateIpcResponseForCommand(response, 'recordingBackups.authorize' as never).ok, false);
});

test('索引问题合同保留安全明细、真实总数、截断数量与未知事实', async () => {
  const { isBackupJobView } = await import('../src/recording-backups.js');
  const issue = { code: 'OBJECT_MISSING', operationId: randomUUID(), sha256: 'a'.repeat(64) };
  const index = { operationCount: 1, quarantinedCount: 1, issueCount: 1, historyTrusted: false, inventoryReconstructed: false,
    issueDetails: [issue], issueDetailsOmittedCount: 0,
    missingFacts: ['physical-recording-completion', 'inventory-and-ledger', 'frozen-version-records', 'profile-snapshots-and-user-confirmations', 'directory-authorizations'] };
  const job = { id: randomUUID(), rootId: randomUUID(), kind: 'index', state: 'succeeded', createdAt: new Date().toISOString(), index };
  assert.equal(isBackupJobView(job), true, '应接收有界的索引问题明细');
  const validate = (change: Record<string, unknown>) => isBackupJobView({ ...job, index: { ...index, ...change } });
  assert.equal(validate({ issueDetails: [{ code: 'MANIFEST_INVALID' }] }), true);
  assert.equal(validate({ issueCount: 103, issueDetails: Array.from({ length: 100 }, () => issue), issueDetailsOmittedCount: 3 }), true);
  for (const detail of [{ ...issue, absolutePath: '/private/synthetic' }, { ...issue, stack: '合成内部堆栈' }, { ...issue, operationId: '/private/synthetic' }, { ...issue, sha256: '../越界' }, { code: 'OBJECT_MISSING' }, { code: 'MANIFEST_INVALID', sha256: issue.sha256 }, { ...issue, code: '未知错误' }]) {
    assert.equal(validate({ issueDetails: [detail] }), false);
  }
  for (const change of [{ issueDetails: Array.from({ length: 101 }, () => issue), issueCount: 101 }, { issueDetailsOmittedCount: 1 }, { issueDetails: [] }, { quarantinedCount: 2 }, { missingFacts: [] }, { missingFacts: [...index.missingFacts, '/private/synthetic'] }, { historyTrusted: true }, { inventoryReconstructed: true }]) {
    assert.equal(validate(change), false);
  }
});
