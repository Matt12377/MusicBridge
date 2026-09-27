import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_REFERENCE_SOURCE_ZIP_BASE64_CHARS, MAX_REFERENCE_SOURCE_ZIP_BYTES,
  isPreviewReferenceSourceZipRequest, isRegisterReferenceSourceZipRequest,
  isReferenceSourceZipPreview, isReferenceSourceZipReceipt, isRegisterReferenceSourceZipResult,
  isReferenceSourceZipReceiptListRequest, isReferenceSourceZipReceiptPage,
} from '../src/reference-catalog.js';

const id = '11111111-1111-4111-8111-111111111111';
const hash = 'a'.repeat(64);
const preview = { entryName: 'catalog.json', zipSha256: hash, zipBytes: 1024, rawPackHash: 'b'.repeat(64),
  bookId: 'synthetic-book', title: '合成目录', sourceVersion: '第一版', itemCount: 1 };
const source = { id, bookId: preview.bookId, title: preview.title, sourceVersion: preview.sourceVersion,
  packHash: preview.rawPackHash, itemCount: 1, createdAt: '2026-09-27T00:00:00.000Z' };
const receipt = { id: '22222222-2222-4222-8222-222222222222', sourceId: id,
  zipSha256: hash, zipBytes: 1024, entryName: 'catalog.json', rawPackHash: preview.rawPackHash,
  createdAt: '2026-09-27T00:00:00.000Z' };

test('C11 ZIP 合同限定有界 base64、双 Hash、根入口名和确认字段', () => {
  assert.equal(MAX_REFERENCE_SOURCE_ZIP_BYTES, 4 * 1024 * 1024);
  assert.ok(isPreviewReferenceSourceZipRequest({ zipBase64: 'UEsDBA==' }));
  assert.equal(isPreviewReferenceSourceZipRequest({ zipBase64: 'UEsDBA==', nativePath: '/private/x' }), false);
  assert.equal(isPreviewReferenceSourceZipRequest({ zipBase64: 'A'.repeat(MAX_REFERENCE_SOURCE_ZIP_BASE64_CHARS + 4) }), false);
  assert.equal(isPreviewReferenceSourceZipRequest({ zipBase64: 'UEs==\n' }), false);
  assert.ok(isReferenceSourceZipPreview(preview));
  assert.equal(isReferenceSourceZipPreview({ ...preview, entryName: 'nested/catalog.json' }), false);
  assert.equal(isReferenceSourceZipPreview({ ...preview, zipBytes: MAX_REFERENCE_SOURCE_ZIP_BYTES + 1 }), false);
  assert.ok(isRegisterReferenceSourceZipRequest({ commandId: id, zipBase64: 'UEsDBA==',
    expectedZipSha256: hash, expectedRawPackHash: preview.rawPackHash, userConfirmed: true }));
  assert.equal(isRegisterReferenceSourceZipRequest({ commandId: id, zipBase64: 'UEsDBA==',
    expectedZipSha256: hash, expectedRawPackHash: preview.rawPackHash }), false);
});

test('C11 来源与不可变回执交叉校验，不把容器回执当新目录条目', () => {
  assert.ok(isReferenceSourceZipReceipt(receipt));
  assert.ok(isRegisterReferenceSourceZipResult({ source, receipt }));
  assert.equal(isRegisterReferenceSourceZipResult({ source, receipt: { ...receipt, rawPackHash: hash } }), false);
  assert.ok(isReferenceSourceZipReceiptListRequest({ sourceId: id, offset: 0, limit: 25 }));
  assert.equal(isReferenceSourceZipReceiptListRequest({ sourceId: id, offset: 0, limit: 26 }), false);
  assert.ok(isReferenceSourceZipReceiptPage({ items: [receipt], total: 1, offset: 0, limit: 25 }));
  assert.equal(isReferenceSourceZipReceiptPage({ items: [receipt, receipt], total: 2, offset: 0, limit: 25 }), false);
});
