import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import * as c from '../src/index.js';

const id = randomUUID(), commandId = randomUUID(), hash = 'a'.repeat(64);
const save = { commandId, id: null, expectedVersion: 0, revisionId: id, referenceId: 'ref-a', priority: 'normal', preferredCondition: '完整品相', notes: '寻找另一时长', targetLengthMinutes: 46, packagingTarget: '未拆封', priceTarget: { currency: 'CNY', amount: '12.3400' }, userConfirmed: true };
const entry = { id, version: 1, active: true, bookId: 'book-a', revisionId: id, referenceId: 'ref-a', brand: '合成品牌', series: '系列', model: '型号', edition: '1990', priority: 'normal', preferredCondition: '完整品相', notes: '寻找另一时长', targetLengthMinutes: 46, packagingTarget: '未拆封', priceTarget: { currency: 'CNY', amount: '12.3400' }, createdAt: '2026-08-28T00:00:00.000Z', updatedAt: '2026-08-28T00:00:00.000Z' };

test('求购金额只接受有界正十进制原字符串，不转浮点或猜币种', () => {
  for (const amount of ['1', '0.0001', '123456789012.1234', '10.00']) assert.equal(c.isWantPriceTarget({ currency: 'CNY', amount }), true);
  for (const amount of ['0', '0.0000', '01', '1e3', '+1', '-1', '1.12345', '1234567890123', ' 1', '1.', '.5', 'NaN', 1]) assert.equal(c.isWantPriceTarget({ currency: 'CNY', amount }), false);
  assert.equal(c.isWantPriceTarget({ currency: 'cny', amount: '1' }), false);
  assert.equal(c.isWantPriceTarget({ currency: ['CNY'], amount: '1' }), false);
});

test('求购新建和编辑严格区分版本，不信Renderer品牌标签或Ownership', () => {
  assert.equal(c.isSaveWantEntryRequest(save), true);
  assert.equal(c.isSaveWantEntryRequest({ ...save, id, expectedVersion: 1 }), true);
  for (const change of [{ id, expectedVersion: 0 }, { expectedVersion: 1 }, { userConfirmed: false }, { priority: ['high'] }, { brand: '伪造标签' }, { ownership: 'owned' }, { notes: 'x'.repeat(4001) }, { preferredCondition: 'x'.repeat(201) }, { packagingTarget: 'x'.repeat(201) }, { targetLengthMinutes: 0 }]) assert.equal(c.isSaveWantEntryRequest({ ...save, ...change }), false);
  assert.equal(c.isCancelWantEntryRequest({ commandId, id, expectedVersion: 1, userConfirmed: true }), true);
  assert.equal(c.isCancelWantEntryRequest({ commandId, id, expectedVersion: 0, userConfirmed: true }), false);
});

test('Wanted是独立目标，列表复核状态不混入持久回执，分页明确有界', () => {
  assert.equal(c.isWantEntry(entry), true);
  assert.equal(c.isWantEntry({ ...entry, active: false, version: 2 }), true);
  assert.equal(c.isWantEntry({ ...entry, needsReview: false }), false);
  assert.equal(c.isWantEntryView({ entry, needsReview: true }), true);
  assert.equal(c.isWantEntryView({ entry, needsReview: 'needs-review' }), false);
  assert.equal(c.isListWantEntriesRequest({ page: { offset: 0, limit: 25 }, bookId: 'book-a', revisionId: id, referenceId: 'ref-a', active: true }), true);
  assert.equal(c.isListWantEntriesRequest({ page: { offset: 0, limit: 26 } }), false);
  assert.equal(c.isListWantEntriesRequest({ page: { offset: 0, limit: 25 }, absolutePath: '/private/synthetic' }), false);
});

test('只有saveWant/cancelWant/capture进入有限outbox，读请求和伪造路径不能重放', () => {
  const request = { datasetId: id, command: 'collectionProgress.saveWant', payload: save };
  assert.equal(c.isCommandOutboxExecute(request), true);
  assert.equal(c.isCommandOutboxDispatchResult({ command: 'collectionProgress.saveWant', result: entry }), true);
  assert.equal(c.isCommandOutboxExecute({ ...request, command: 'collectionProgress.current' }), false);
  assert.equal(c.isCommandOutboxExecute({ ...request, payload: { ...save, absolutePath: '/private/synthetic' } }), false);
  assert.equal(c.validateIpcRequest({ version: 1, id, command: 'collectionProgress.current', payload: { revisionId: id, page: { offset: 0, limit: 25 } } }).ok, true);
  assert.equal(c.validateIpcRequest({ version: 1, id, command: 'collectionProgress.capture', payload: { commandId, revisionId: id, expectedFingerprint: hash, userConfirmed: true } }).ok, true);
  assert.equal(c.validateIpcRequest({ version: 1, id, command: 'collectionProgress.capture', payload: { commandId, revisionId: id, expectedFingerprint: hash, userConfirmed: false } }).ok, false);
});

const target = { id, version: 1, priority: 'normal', targetLengthMinutes: 46, preferredCondition: '完整品相', packagingTarget: '未拆封', priceTarget: null };
const progressEntry = { referenceId: 'ref-a', brand: '合成品牌', series: '系列', model: '型号', edition: '1990', state: 'owned', matches: [{ referenceId: 'ref-a', modelId: id, status: 'confirmed', availability: 'unknown' }], stockCount: 3, knownLengths: [46, 90], ownedLengths: [{ lengthMinutes: 90, quantity: 2 }], unknownLengthQty: 0, extraLengths: [{ lengthMinutes: 120, quantity: 1 }], allKnownLengthsOwned: false, wantedTargets: [target] };
const counts = { total: 1, owned: 1, missing: 0, unknown: 0, candidate: 0, needsReview: 0, wanted: 1, wantTargetCount: 1 };
const page = <T>(items: T[]) => ({ items, total: items.length, offset: 0, limit: 25, hasMore: false });
const progress = { bookId: 'book-a', revisionId: id, catalogSequence: 1, matchVersion: 0, metricsVersion: 1, facts: 'current', isCurrentRevision: true, fingerprint: hash, overall: counts, brands: [{ brand: '合成品牌', counts }], series: [{ brand: '合成品牌', series: '系列', counts }], historicalWantedCount: 0, entries: page([progressEntry]) };

test('长度覆盖与总数量守恒，未知/额外长度不能假装All Lengths', () => {
  assert.equal(c.isCollectionProgressEntry(progressEntry), true);
  assert.equal(c.isCollectionProgressEntry({ ...progressEntry, allKnownLengthsOwned: true }), false);
  assert.equal(c.isCollectionProgressEntry({ ...progressEntry, extraLengths: [{ lengthMinutes: 90, quantity: 1 }] }), false);
  assert.equal(c.isCollectionProgressEntry({ ...progressEntry, ownedLengths: [{ lengthMinutes: 90, quantity: 0 }] }), false);
  assert.equal(c.isCollectionProgressEntry({ ...progressEntry, knownLengths: [], ownedLengths: [], extraLengths: [], unknownLengthQty: 3, allKnownLengthsOwned: true }), false);
  assert.equal(c.isCollectionProgressEntry({ ...progressEntry, stockCount: 4 }), false);
  assert.equal(c.isCollectionProgressEntry({ ...progressEntry, matches: [{ referenceId: 'ref-a', modelId: id, status: 'candidate', availability: 'unknown' }] }), false);
  const lengths = { modelId: id, modelRevision: 1, total: 3, lengths: [{ lengthMinutes: 90, quantity: 2 }], unknownLengthQty: 1 };
  assert.equal(c.isCollectionModelLengths(lengths), true);
  assert.equal(c.isCollectionModelLengths({ ...lengths, total: 4 }), false);
  assert.equal(c.isCollectionModelLengths({ ...lengths, lengths: [{ lengthMinutes: 90, quantity: 0 }] }), false);
});

test('Wanted不改变Owned/Missing/Unknown分母，分组与当前事实明确校验', () => {
  assert.equal(c.isCollectionProgress(progress), true);
  assert.equal(c.isCollectionProgress({ ...progress, isCurrentRevision: false }), true);
  assert.equal(c.isCollectionProgress({ ...progress, facts: 'snapshot' }), false);
  assert.equal(c.isCollectionProgressCounts({ ...counts, wanted: 2 }), false);
  assert.equal(c.isCollectionProgressCounts({ ...counts, wantTargetCount: 0 }), false);
  assert.equal(c.isCollectionProgress({ ...progress, brands: [] }), false);
  assert.equal(c.isCollectionProgress({ ...progress, series: [{ brand: '伪造分组', series: '系列', counts }] }), false);
  assert.equal(c.isCollectionProgress({ ...progress, overall: { ...counts, owned: 0, unknown: 1 } }), false);
});

test('新快照与旧catalog快照分开，捕获固定指纹且详情仅有界分页', () => {
  const snapshot = { id, bookId: progress.bookId, revisionId: id, catalogSequence: 1, matchVersion: 0, metricsVersion: 1, createdAt: entry.createdAt, fingerprint: hash, overall: counts, brands: progress.brands, series: progress.series, historicalWantedCount: 0 };
  assert.equal(c.isCollectionProgressSnapshotSummary(snapshot), true);
  assert.equal(c.isCollectionProgressSnapshotDetail({ snapshot, entries: page([progressEntry]) }), true);
  assert.equal(c.isCollectionProgressSnapshotDetail({ snapshot, entries: { ...page([progressEntry]), limit: 26 } }), false);
  assert.equal(c.isCollectionProgressSnapshotSummary({ ...snapshot, facts: 'current' }), false);
  assert.equal(c.isCommandOutboxDispatchResult({ command: 'collectionProgress.capture', result: snapshot }), true);
  assert.equal(c.validateIpcResponseForCommand({ version: 1, id, ok: true, result: { snapshot, entries: page([progressEntry]) } }, 'collectionProgress.snapshot').ok, true);
  assert.equal(c.isGetCollectionProgressSnapshotRequest({ id, page: { offset: 0, limit: 25 } }), true);
});

test('全批快照拒绝跨条目重复求购，分页保留完整分母而非本页计数', () => {
  const other = { ...progressEntry, referenceId: 'ref-b', state: 'missing', matches: [{ referenceId: 'ref-b', modelId: null, status: 'unmatched', availability: 'missing' }], stockCount: 0, ownedLengths: [], extraLengths: [], wantedTargets: [{ ...target, id: randomUUID() }] };
  const overall = { ...counts, total: 2, missing: 1, wanted: 2, wantTargetCount: 2 };
  const snapshot = { id, bookId: 'book-a', revisionId: id, catalogSequence: 1, matchVersion: 0, metricsVersion: 1, createdAt: entry.createdAt, fingerprint: hash, overall, brands: [{ brand: '合成品牌', counts: overall }], series: [{ brand: '合成品牌', series: '系列', counts: overall }], historicalWantedCount: 2 };
  assert.equal(c.isCollectionProgressSnapshot({ ...snapshot, entries: [progressEntry, other] }), true);
  assert.equal(c.isCollectionProgressSnapshot({ ...snapshot, entries: [progressEntry, { ...other, wantedTargets: [target] }] }), false);
  const firstPage = { items: [progressEntry], total: 2, offset: 0, limit: 1, hasMore: true };
  assert.equal(c.isCollectionProgressSnapshotDetail({ snapshot, entries: firstPage }), true);
  assert.equal(c.isCollectionProgressSnapshotDetail({ snapshot, entries: { ...firstPage, total: 1, hasMore: false } }), false);
  assert.equal(c.isCollectionProgressSnapshotDetail({ snapshot, entries: { ...firstPage, items: [] } }), false);
});

test('目标和历史边界有界，空已知长度不得获得AllLengths，非法原字符拒绝', () => {
  const targets = Array.from({ length: 100 }, () => ({ ...target, id: randomUUID() }));
  assert.equal(c.isCollectionProgressEntry({ ...progressEntry, wantedTargets: targets }), true);
  assert.equal(c.isCollectionProgressEntry({ ...progressEntry, wantedTargets: [...targets, { ...target, id: randomUUID() }] }), false);
  assert.equal(c.isCollectionProgressEntry({ ...progressEntry, wantedTargets: [target, target] }), false);
  assert.equal(c.isCollectionProgressEntry({ ...progressEntry, knownLengths: [], ownedLengths: [], extraLengths: [{ lengthMinutes: 90, quantity: 3 }], allKnownLengthsOwned: false }), true);
  assert.equal(c.isWantEntryHistory(page([entry, { ...entry, version: 2, active: false }])), true);
  assert.equal(c.isWantEntryHistory(page([entry, entry])), false);
  assert.equal(c.isWantEntryHistory(page([entry, { ...entry, id: randomUUID(), version: 2 }])), false);
  assert.equal(c.isSaveWantEntryRequest({ ...save, notes: '第一行\n第二行\t备注' }), true);
  assert.equal(c.isSaveWantEntryRequest({ ...save, preferredCondition: '品相\n未知' }), false);
  assert.equal(c.isSaveWantEntryRequest({ ...save, notes: '\uD800' }), false);
});

test('完整快照逐条合法但合计超过JSON预算时整体拒绝，不截断目标或历史', () => {
  const entries = Array.from({ length: 500 }, (_, index) => ({ ...progressEntry, referenceId: `ref-${index}`, brand: '品'.repeat(116) + String(index).padStart(4, '0'), series: '系'.repeat(120), model: '型'.repeat(120), edition: '版'.repeat(120),
    matches: [{ referenceId: `ref-${index}`, modelId: randomUUID(), status: 'confirmed', availability: 'unknown' }],
    wantedTargets: Array.from({ length: 10 }, () => ({ ...target, id: randomUUID(), version: Number.MAX_SAFE_INTEGER, preferredCondition: '品'.repeat(200), packagingTarget: '包'.repeat(200), priceTarget: { currency: 'CNY', amount: '123456789012.1234' } })) }));
  const one = { ...counts, wantTargetCount: 10 }, overall = { ...counts, total: 500, owned: 500, wanted: 500, wantTargetCount: 5000 };
  const snapshot = { id, bookId: 'book-a', revisionId: id, catalogSequence: 1, matchVersion: 0, metricsVersion: 1, createdAt: entry.createdAt, fingerprint: hash, overall,
    brands: entries.map(item => ({ brand: item.brand, counts: one })), series: entries.map(item => ({ brand: item.brand, series: item.series, counts: one })), historicalWantedCount: 0 };
  assert.equal(entries.every(c.isCollectionProgressEntry), true);
  assert.equal(c.isCollectionProgressSnapshotSummary(snapshot), true);
  assert.ok(Buffer.byteLength(JSON.stringify({ ...snapshot, entries })) > c.MAX_COLLECTION_PROGRESS_BYTES);
  assert.equal(c.isCollectionProgressSnapshot({ ...snapshot, entries }), false);
});

test('九条IPC均使用领域响应guard，拒绝额外字段与错误结果类型', () => {
  const snapshot = { id, bookId: 'book-a', revisionId: id, catalogSequence: 1, matchVersion: 0, metricsVersion: 1, createdAt: entry.createdAt, fingerprint: hash, overall: counts, brands: progress.brands, series: progress.series, historicalWantedCount: 0 };
  const scenarios = [
    ['collectionProgress.wants', { page: { offset: 0, limit: 25 } }, page([{ entry, needsReview: false }])],
    ['collectionProgress.saveWant', save, entry],
    ['collectionProgress.cancelWant', { commandId, id, expectedVersion: 1, userConfirmed: true }, { ...entry, version: 2, active: false }],
    ['collectionProgress.wantHistory', { id, page: { offset: 0, limit: 25 } }, page([entry])],
    ['collectionProgress.current', { revisionId: id, page: { offset: 0, limit: 25 } }, progress],
    ['collectionProgress.capture', { commandId, revisionId: id, expectedFingerprint: hash, userConfirmed: true }, snapshot],
    ['collectionProgress.snapshots', { page: { offset: 0, limit: 25 } }, page([snapshot])],
    ['collectionProgress.snapshot', { id, page: { offset: 0, limit: 25 } }, { snapshot, entries: page([progressEntry]) }],
    ['collectionProgress.modelLengths', { modelId: id }, { modelId: id, modelRevision: 1, total: 0, lengths: [], unknownLengthQty: 0 }],
  ] as const;
  for (const [command, payload, result] of scenarios) {
    assert.equal(c.validateIpcRequest({ version: 1, id, command, payload }).ok, true, command);
    assert.equal(c.validateIpcRequest({ version: 1, id, command, payload: { ...payload, path: '/private/synthetic' } }).ok, false, command);
    assert.equal(c.validateIpcResponseForCommand({ version: 1, id, ok: true, result }, command).ok, true, command);
    assert.equal(c.validateIpcResponseForCommand({ version: 1, id, ok: true, result: { ...result, rawDatabase: 'synthetic' } }, command).ok, false, command);
  }
});
