import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import * as c from '../src/reference-catalog.js';
import { isCommandOutboxExecute, isCommandOutboxResult, validateIpcRequest, validateIpcResponseForCommand } from '../src/index.js';

const id = randomUUID(), commandId = randomUUID(), datasetId = randomUUID();
const item = { referenceId: 'ref-a', bookId: 'synthetic-book', brand: '合成品牌', series: '合成系列', edition: '第一版', model: 'A', lengths: [60], iec: 'I', era: null, image: { kind: 'none' }, pages: ['1'], notes: '', confidence: 'high' } as const;
const pack = { schemaVersion: 1, bookId: item.bookId, title: '合成资料', sourceVersion: 'v1', items: [item] };
const rawPack = JSON.stringify(pack), packHash = createHash('sha256').update(rawPack, 'utf8').digest('hex');
const source = { id, bookId: pack.bookId, title: pack.title, sourceVersion: pack.sourceVersion, packHash, itemCount: 1, createdAt: '2026-08-28T00:00:00.000Z' };
const previewRequest = { sourceId: id, expectedCurrentRevisionId: null, items: [item], mappings: [] };
const register = { commandId, rawPack, packHash, userConfirmed: true };

for (const [field, valid] of [['iec', 'II'], ['confidence', 'high']] as const) {
  test(`参考资料${field}只接受字符串枚举，原JSON与IPC/outbox拒绝数组强制转换`, () => {
    for (const value of [[valid], null, false, 1, {}]) {
      const invalidItem = { ...item, [field]: value };
      const invalidRaw = JSON.stringify({ ...pack, items: [invalidItem] });
      const request = { ...register, rawPack: invalidRaw, packHash: createHash('sha256').update(invalidRaw).digest('hex') };
      assert.equal(c.isCanonicalReference(invalidItem), false);
      assert.equal(c.parseReferenceSourcePack(invalidRaw), null);
      assert.equal(c.isRegisterReferenceSourceRequest(request), false);
      assert.equal(validateIpcRequest({ version: 1, id, command: 'referenceCatalog.registerSource', payload: request }).ok, false);
      assert.equal(isCommandOutboxExecute({ datasetId, command: 'referenceCatalog.registerSource', payload: request }), false);
    }
  });
}
for (const [field, valid] of [['status', 'confirmed'], ['availability', 'missing']] as const) {
  test(`目录审核${field}只接受字符串枚举，setMatch与IPC/outbox拒绝非字符串`, () => {
    for (const value of [[valid], null, false, 1, {}]) {
      const match = { referenceId: item.referenceId, modelId: field === 'status' ? id : null, status: field === 'status' ? 'confirmed' : 'unmatched', availability: field === 'status' ? 'unknown' : 'missing', [field]: value };
      const request = { commandId, revisionId: id, expectedMatchVersion: 0, match, userConfirmed: true };
      assert.equal(c.isCatalogMatch(match), false);
      assert.equal(c.isSetCatalogMatchRequest(request), false);
      assert.equal(validateIpcRequest({ version: 1, id, command: 'referenceCatalog.setMatch', payload: request }).ok, false);
      assert.equal(isCommandOutboxExecute({ datasetId, command: 'referenceCatalog.setMatch', payload: request }), false);
    }
  });
}

test('资料原文可保留BOM/空白，严格解析且不隐式生成来源', () => {
  const original = '\uFEFF \n' + rawPack;
  assert.deepEqual(c.parseReferenceSourcePack(original), pack);
  assert.equal(c.isRegisterReferenceSourceRequest({ ...register, rawPack: original }), true);
  assert.equal(c.isReferenceSourceDetail({ source, rawPack }), true);
  assert.equal(c.parseReferenceSourcePack('{坏JSON'), null);
  assert.equal(c.parseReferenceSourcePack(JSON.stringify({ ...pack, absolutePath: '/private/synthetic' })), null);
  assert.equal(c.parseReferenceSourcePack(JSON.stringify({ ...pack, items: [{ ...item, credential: 'synthetic' }] })), null);
  assert.equal(c.isRegisterReferenceSourceRequest({ ...register, userConfirmed: false }), false);
  assert.equal(c.isRegisterReferenceSourceRequest({ ...register, packHash: 'sha256:wrong' }), false);
  assert.equal(c.parseReferenceSourcePack(' '.repeat(c.MAX_REFERENCE_SOURCE_PACK_BYTES) + rawPack), null);
  assert.equal(c.parseReferenceSourcePack(JSON.stringify({ ...pack, items: Array.from({ length: 501 }, () => item) })), null);
});

test('同参考项重复页及时长归并，冲突版次或重复canonical身份拒绝', () => {
  const duplicated = [{ ...item, lengths: [60, 60], pages: ['1', '1'] }, { ...item, lengths: [90], pages: ['2'] }];
  assert.equal(c.isSourcePack({ ...pack, items: duplicated }), true);
  assert.deepEqual(c.normalizeReferenceItems(duplicated), [{ ...item, lengths: [60, 90], pages: ['1', '2'] }]);
  assert.equal(c.normalizeReferenceItems([item, { ...item, edition: '第二版' }]), null);
  assert.equal(c.normalizeReferenceItems([item, { ...item, referenceId: 'ref-b' }]), null);
  assert.equal(c.isPreviewCatalogRevisionRequest({ ...previewRequest, items: duplicated }), false);
  assert.equal(c.isPreviewCatalogRevisionRequest({ ...previewRequest, items: [{ ...item, lengths: [60, 60] }] }), false);
});

test('参考图只允许明确参考来源与受限内嵌JPEG，无外网或私有路径', () => {
  const image = { kind: 'reference', image: { dataUrl: 'data:image/jpeg;base64,/9j/2Q==', width: 1, height: 1 }, caption: '合成参考图' };
  assert.equal(c.isCanonicalReference({ ...item, image }), true);
  for (const dataUrl of ['https://example.com/a.jpg', '/private/a.jpg', 'data:image/svg+xml;base64,AA==']) {
    assert.equal(c.isCanonicalReference({ ...item, image: { ...image, image: { ...image.image, dataUrl } } }), false);
  }
  assert.equal(c.isCanonicalReference({ ...item, image: { kind: 'none', absolutePath: undefined } }), false);
  assert.equal(c.isCanonicalReference({ ...item, image: { ...image, source: 'user-photo' } }), false);
});

test('发布要求原基线指纹与确认；映射仅有限合并或拆分', () => {
  const publish = { ...previewRequest, commandId, baselineFingerprint: packHash, userConfirmed: true };
  assert.equal(c.isPublishCatalogRevisionRequest(publish), true);
  assert.equal(c.isPublishCatalogRevisionRequest({ ...publish, userConfirmed: false }), false);
  assert.equal(c.isPublishCatalogRevisionRequest({ ...publish, baselineFingerprint: undefined }), false);
  for (const mappings of [
    [{ fromReferenceIds: ['a', 'b'], toReferenceIds: ['c', 'd'] }],
    [{ fromReferenceIds: ['a'], toReferenceIds: ['a'] }, { fromReferenceIds: ['a'], toReferenceIds: ['b'] }],
    [{ fromReferenceIds: [], toReferenceIds: ['a'] }],
  ]) assert.equal(c.isPreviewCatalogRevisionRequest({ ...previewRequest, mappings }), false);
  assert.equal(c.isPreviewCatalogRevisionRequest({ ...previewRequest, mappings: [{ fromReferenceIds: ['old-a', 'old-b'], toReferenceIds: ['ref-a'] }] }), true);
});

test('未匹配不等于Missing，候选/拆分待审不伪装已确认拥有', () => {
  const match = { referenceId: 'ref-a', modelId: null, status: 'unmatched', availability: 'unknown' };
  assert.equal(c.isCatalogMatch(match), true);
  assert.equal(c.isCatalogMatch({ ...match, availability: 'missing' }), true);
  for (const status of ['confirmed', 'candidate', 'needs-review']) {
    assert.equal(c.isCatalogMatch({ ...match, status, modelId: id }), true);
    assert.equal(c.isCatalogMatch({ ...match, status, modelId: id, availability: 'missing' }), false);
    assert.equal(c.isCatalogMatch({ ...match, status }), false);
  }
  assert.equal(c.isSetCatalogMatchRequest({ commandId, revisionId: id, expectedMatchVersion: 0, match, userConfirmed: true }), true);
  assert.equal(c.isSetCatalogMatchRequest({ commandId, revisionId: id, expectedMatchVersion: -1, match, userConfirmed: true }), false);
});

test('snapshot是有界一致时点事实，不接受额外路径或不守恒counts', () => {
  const counts = { total: 1, owned: 0, missing: 0, unknown: 1, candidate: 0, needsReview: 0 };
  const snapshot = { id, bookId: item.bookId, revisionId: id, matchVersion: 0, createdAt: source.createdAt, counts, entries: [{ referenceId: item.referenceId, state: 'unknown', matches: [], stockCount: 0 }] };
  assert.equal(c.isCatalogSnapshot(snapshot), true);
  assert.equal(c.isCatalogSnapshot({ ...snapshot, counts: { ...counts, owned: 1 } }), false);
  assert.equal(c.isCatalogSnapshot({ ...snapshot, entries: [...snapshot.entries, ...snapshot.entries] }), false);
  assert.equal(c.isCatalogSnapshot({ ...snapshot, absolutePath: '/private/synthetic' }), false);
});

test('新增写命令均进入有限outbox且响应按命令校验，读命令不能重放', () => {
  assert.equal(isCommandOutboxExecute({ datasetId, command: 'referenceCatalog.registerSource', payload: register }), true);
  assert.equal(isCommandOutboxExecute({ datasetId, command: 'referenceCatalog.publishRevision', payload: { ...previewRequest, commandId, baselineFingerprint: packHash, userConfirmed: true } }), true);
  assert.equal(isCommandOutboxExecute({ datasetId, command: 'referenceCatalog.setMatch', payload: { commandId, revisionId: id, expectedMatchVersion: 0, match: { referenceId: item.referenceId, modelId: null, status: 'unmatched', availability: 'unknown' }, userConfirmed: true } }), true);
  assert.equal(isCommandOutboxExecute({ datasetId, command: 'referenceCatalog.previewRevision', payload: { ...previewRequest, commandId } }), false);
  assert.equal(isCommandOutboxResult({ command: 'referenceCatalog.registerSource', result: source }), true);
  assert.equal(isCommandOutboxResult({ command: 'referenceCatalog.publishRevision', result: source }), false);
  assert.equal(validateIpcRequest({ version: 1, id, command: 'referenceCatalog.sources', payload: { offset: 0, limit: 25 } }).ok, true);
  assert.equal(validateIpcRequest({ version: 1, id, command: 'referenceCatalog.sources', payload: { offset: 0, limit: 26 } }).ok, false);
  assert.equal(validateIpcResponseForCommand({ version: 1, id, ok: true, result: source }, 'referenceCatalog.registerSource').ok, true);
});

test('revision响应按字段事实比较match且历史snapshot不可串接其它canonical', () => {
  const counts = { total: 1, owned: 1, missing: 0, unknown: 0, candidate: 0, needsReview: 0 };
  const match = { referenceId: item.referenceId, modelId: id, status: 'confirmed', availability: 'unknown' };
  const reorderedMatch = { status: 'confirmed', availability: 'unknown', modelId: id, referenceId: item.referenceId };
  const entries = [{ referenceId: item.referenceId, state: 'owned', matches: [reorderedMatch], stockCount: 2 }];
  const snapshot = { id, bookId: item.bookId, revisionId: id, matchVersion: 1, createdAt: source.createdAt, counts, entries };
  const revision = { id, bookId: item.bookId, sourceId: id, packHash, sequence: 1, previousRevisionId: null, items: [item], mappings: [], createdAt: source.createdAt };
  const detail = { revision, matchVersion: 1, matches: [match], snapshot, currentCounts: counts, currentEntries: entries };
  assert.equal(c.isCatalogRevisionDetail(detail), true);
  assert.equal(c.isCatalogRevisionDetail({ ...detail, snapshot: { ...snapshot, entries: [{ ...entries[0], referenceId: 'other', matches: [{ ...match, referenceId: 'other' }] }] } }), false);
  assert.equal(c.isCatalogRevision({ ...revision, mappings: [{ fromReferenceIds: ['old'], toReferenceIds: ['other'] }] }), false);
  for (const command of ['referenceCatalog.revision', 'referenceCatalog.publishRevision', 'referenceCatalog.setMatch'] as const) {
    assert.equal(validateIpcResponseForCommand({ version: 1, id, ok: true, result: detail }, command).ok, true);
  }
});

test('UTF8按字节限额，未知字段和稀疏数组不能绕过有界输入', () => {
  assert.equal(c.parseReferenceSourcePack(' '.repeat(c.MAX_REFERENCE_SOURCE_PACK_BYTES - rawPack.length) + rawPack), null);
  assert.equal(c.parseReferenceSourcePack(rawPack + '\ud800'), null);
  assert.equal(c.isSourcePack({ ...pack, items: new Array(1) }), false);
  assert.equal(c.isPreviewCatalogRevisionRequest({ ...previewRequest, mappings: new Array(1) }), false);
  assert.equal(c.isRegisterReferenceSourceRequest({ ...register, absolutePath: undefined }), false);
  assert.equal(c.isReferenceSourceDetail({ source: { ...source, bookId: 'another-book' }, rawPack }), false);
  const keys = { ...item, lengths: [], pages: [] };
  assert.equal(c.isCanonicalReference(keys), true);
});
