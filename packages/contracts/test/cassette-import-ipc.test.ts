import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { validateIpcRequest, isCommandOutboxRequest, isImportReferenceArchiveCatalogRequest } from '../src/index.js';

test('档案导入只接受来源哈希与预览资料库身份，不接受路径、正文或旧ZIP载荷', () => {
  const request = { commandId: randomUUID(), archiveSha256: 'a'.repeat(64), expectedDatasetId: randomUUID(),
    expectedCurrentRevisionId: null, baselineFingerprint: 'b'.repeat(64), userConfirmed: true as const };
  assert.equal(isImportReferenceArchiveCatalogRequest(request), true);
  assert.equal(validateIpcRequest({ version: 1, id: randomUUID(), command: 'referenceCatalog.importArchive', payload: request }).ok, true);
  assert.equal(isCommandOutboxRequest({ datasetId: request.expectedDatasetId, command: 'referenceCatalog.importArchive', payload: request }), true);
  for (const extra of [{ path: '/private/secret' }, { rawPack: '{}' }, { zipBase64: 'AAAA' }, { archiveSha256: '../secret' }, { expectedDatasetId: 'not-a-dataset' }, { userConfirmed: false }])
    assert.equal(isImportReferenceArchiveCatalogRequest({ ...request, ...extra }), false);
});
