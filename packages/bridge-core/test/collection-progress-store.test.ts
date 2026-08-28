import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import type { CanonicalReference, SaveWantEntryRequest, CatalogMatch } from '@music-bridge/contracts';
import { isCollectionProgressSnapshotsPage, isCollectionProgressSnapshotSummary, MAX_COLLECTION_PROGRESS_BYTES } from '@music-bridge/contracts';
import { createCollectionRepository } from '../src/collection/repository.js';
const page = { offset: 0, limit: 25 };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const item = (referenceId = 'a', changes: Partial<CanonicalReference> = {}): CanonicalReference => ({ referenceId, bookId: 'progress-book', brand: '合成品牌', series: '合成系列', model: referenceId, edition: '1990', lengths: [46, 90], iec: 'II', era: '1990', image: { kind: 'none' }, pages: ['1'], notes: '合成参考项', confidence: 'high', ...changes });
function facts(db: DatabaseSync) { return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'recording_plan*' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB 'collection_progress_*' AND name NOT GLOB 'collection_want*' ORDER BY name").all().map(({ name }) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]); }
async function fixture(t: test.TestContext, beforeCommit?: (action: string) => void) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-progress-')), filePath = path.join(directory, 'collection.sqlite');
  const db = new DatabaseSync(filePath); db.exec(await readFile(new URL('./fixtures/collection-schema16.sql', import.meta.url), 'utf8')); db.close();
  const repository = createCollectionRepository({ filePath, ...(beforeCommit ? { beforeCommit } : {}) });
  t.after(async () => { repository.close(); await rm(directory, { recursive: true, force: true }); }); return { repository, filePath };
}
function publish(repository: ReturnType<typeof createCollectionRepository>, items: CanonicalReference[] = [item()], previous: string | null = null, mappings: { fromReferenceIds: string[]; toReferenceIds: string[] }[] = []) {
  const rawPack = JSON.stringify({ schemaVersion: 1, bookId: 'progress-book', title: '合成进度目录', sourceVersion: 'v1', items });
  const source = repository.catalog.registerSource({ commandId: randomUUID(), rawPack, packHash: sha(rawPack), userConfirmed: true });
  const request = { sourceId: source.id, expectedCurrentRevisionId: previous, items, mappings }, preview = repository.catalog.previewRevision(request);
  return repository.catalog.publishRevision({ ...request, commandId: randomUUID(), baselineFingerprint: preview.baselineFingerprint, userConfirmed: true });
}
function set(repository: ReturnType<typeof createCollectionRepository>, revisionId: string, match: CatalogMatch) { return repository.catalog.setMatch({ commandId: randomUUID(), revisionId, expectedMatchVersion: repository.catalog.revision({ id: revisionId }).matchVersion, match, userConfirmed: true }); }
function want(revisionId: string, changes: Partial<SaveWantEntryRequest> = {}): SaveWantEntryRequest { return { commandId: randomUUID(), id: null, expectedVersion: 0, revisionId, referenceId: 'a', priority: 'normal', preferredCondition: '良好', notes: '合成求购', targetLengthMinutes: 46, packagingTarget: '未拆封', priceTarget: { currency: 'CNY', amount: '120.50' }, userConfirmed: true, ...changes }; }

test('固定schema16迁移18逐列保留XLSX原bytes/更正/实体照片/目录历史，迁移失败回滚', async t => {
  let fail = true; const { repository, filePath } = await fixture(t, action => { if (fail && action === 'migrate-collection-progress') throw new Error('合成迁移中断'); });
  let db = new DatabaseSync(filePath, { readOnly: true }); const before = facts(db); assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 16); assert.ok(Number(db.prepare('SELECT count(*) n FROM spreadsheet_adjustments').get()?.n) > 0); db.close();
  assert.throws(() => repository.list(page), /库存暂时不可用/u);
  db = new DatabaseSync(filePath, { readOnly: true }); assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 16); assert.deepEqual(facts(db), before); db.close();
  fail = false; repository.list(page); repository.close(); db = new DatabaseSync(filePath, { readOnly: true });
  try { assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 18); assert.deepEqual(facts(db), before); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); } finally { db.close(); }
});
test('Owned90再Wanted46仍分子1，品牌/系列守恒，读取不改库存与目录历史', async t => {
  const { repository, filePath } = await fixture(t), modelId = repository.list(page).items.find(m => m.name === '固定旧库型号')!.id;
  const revision = publish(repository, [item(), item('b', { brand: '第二品牌', series: 'B' }), item('c')]).revision;
  set(repository, revision.id, { referenceId: 'a', modelId, status: 'confirmed', availability: 'unknown' }); set(repository, revision.id, { referenceId: 'b', modelId: null, status: 'unmatched', availability: 'missing' });
  const db = new DatabaseSync(filePath, { readOnly: true }), before = facts(db); const saved = repository.collectionProgress.saveWant(want(revision.id)); assert.equal(saved.brand, '合成品牌'); assert.equal(saved.model, 'a');
  const progress = repository.collectionProgress.current({ revisionId: revision.id, page });
  assert.deepEqual(progress.overall, { total: 3, owned: 1, missing: 1, unknown: 1, candidate: 0, needsReview: 0, wanted: 1, wantTargetCount: 1 });
  assert.equal(progress.entries.items[0]?.state, 'owned'); assert.equal(progress.entries.items[0]?.wantedTargets[0]?.targetLengthMinutes, 46); assert.deepEqual(progress.entries.items[0]?.ownedLengths, [{ lengthMinutes: 90, quantity: 5 }]); assert.equal(progress.entries.items[0]?.allKnownLengthsOwned, false);
  assert.equal(progress.brands.reduce((n, group) => n + group.counts.total, 0), 3); assert.equal(progress.series.reduce((n, group) => n + group.counts.owned, 0), 1);
  assert.deepEqual(repository.collectionProgress.wants({ bookId: revision.bookId, page }).items[0], { entry: saved, needsReview: false }); assert.deepEqual(facts(db), before); db.close();
});
test('候选不Owned、空known不AllLengths，未知/目录外长度分别计数且不重复Copy', async t => {
  const { repository } = await fixture(t), model = { brand: '合成多长度', name: 'Z', edition: '1991', year: 1991, format: 'cassette' as const, tapeType: 'II' as const, identification: 'verified' as const };
  const first = repository.receive({ commandId: randomUUID(), model, lengthMinutes: 46, quantities: { sealedBlank: 2, openedBlank: 0, legacyUsed: 0, unclassified: 0 } });
  repository.receive({ commandId: randomUUID(), model, lengthMinutes: 60, quantities: { sealedBlank: 1, openedBlank: 0, legacyUsed: 0, unclassified: 0 } }); repository.receive({ commandId: randomUUID(), model, lengthMinutes: null, quantities: { sealedBlank: 0, openedBlank: 0, legacyUsed: 0, unclassified: 3 } });
  const copy = repository.materialize({ commandId: randomUUID(), lotId: first.lotId!, bucket: 'sealedBlank', action: 'open' }); const entity = repository.detail(first.modelId, page).copies.items[0]!;
  repository.updateCopy({ commandId: randomUUID(), physicalId: copy.physicalId!, expectedRevision: entity.revision, action: 'reserve' });
  assert.equal(repository.collectionProgress.modelLengths({ modelId: first.modelId }).total, 6);
  repository.updateCopy({ commandId: randomUUID(), physicalId: copy.physicalId!, expectedRevision: entity.revision + 1, action: 'mark-unavailable' });
  const revision = publish(repository, [item('a', { lengths: [] })]).revision; set(repository, revision.id, { referenceId: 'a', modelId: first.modelId, status: 'candidate', availability: 'unknown' }); assert.equal(repository.collectionProgress.current({ revisionId: revision.id, page }).overall.owned, 0);
  set(repository, revision.id, { referenceId: 'a', modelId: first.modelId, status: 'confirmed', availability: 'unknown' }); const entry = repository.collectionProgress.current({ revisionId: revision.id, page }).entries.items[0]!;
  assert.equal(entry.stockCount, 6); assert.equal(entry.unknownLengthQty, 3); assert.deepEqual(entry.extraLengths, [{ lengthMinutes: 46, quantity: 2 }, { lengthMinutes: 60, quantity: 1 }]); assert.equal(entry.allKnownLengthsOwned, false);
  const lengths = repository.collectionProgress.modelLengths({ modelId: first.modelId }); assert.equal(lengths.total, 6); assert.equal(lengths.unknownLengthQty, 3); assert.deepEqual(lengths.lengths, entry.extraLengths);
});
test('Want编辑/取消版本历史、幂等冲突；cancel终态且提交故障不留部分账本', async t => {
  let fail = false; const { repository, filePath } = await fixture(t, action => { if (fail && action.startsWith('collection-progress-')) throw new Error('合成提交中断'); }); const revision = publish(repository).revision, request = want(revision.id), saved = repository.collectionProgress.saveWant(request);
  assert.deepEqual(repository.collectionProgress.saveWant(request), saved); assert.throws(() => repository.collectionProgress.saveWant({ ...request, notes: '另一个请求' }), /同一操作编号/u);
  const edit = want(revision.id, { id: saved.id, expectedVersion: saved.version, notes: '新目标' }); fail = true; assert.throws(() => repository.collectionProgress.saveWant(edit), /库存暂时不可用/u); assert.equal(repository.collectionProgress.wantHistory({ id: saved.id, page }).total, 1);
  fail = false; const updated = repository.collectionProgress.saveWant(edit); assert.equal(updated.version, 2); assert.throws(() => repository.collectionProgress.saveWant({ ...edit, commandId: randomUUID() }), /版本/u);
  const cancel = { commandId: randomUUID(), id: saved.id, expectedVersion: 2, userConfirmed: true as const }, cancelled = repository.collectionProgress.cancelWant(cancel); assert.equal(cancelled.active, false); assert.equal(cancelled.version, 3); assert.deepEqual(repository.collectionProgress.cancelWant(cancel), cancelled);
  assert.throws(() => repository.collectionProgress.saveWant(want(revision.id, { id: saved.id, expectedVersion: 3 })), /取消|终止/u); assert.equal(repository.collectionProgress.wantHistory({ id: saved.id, page }).total, 3);
  repository.close(); const cold = createCollectionRepository({ filePath }); try { assert.deepEqual(cold.collectionProgress.saveWant(request), saved); assert.equal(cold.collectionProgress.wants({ active: false, page }).total, 1); } finally { cold.close(); }
});
test('旧revision目标原标签需复核、不拆分复制；显式编辑可重绑当前', async t => {
  const { repository } = await fixture(t), first = publish(repository).revision, saved = repository.collectionProgress.saveWant(want(first.id));
  const second = publish(repository, [item('b'), item('c')], first.id, [{ fromReferenceIds: ['a'], toReferenceIds: ['b', 'c'] }]).revision, list = repository.collectionProgress.wants({ bookId: first.bookId, page }); assert.equal(list.total, 1); assert.equal(list.items[0]?.needsReview, true); assert.deepEqual(list.items[0]?.entry, saved);
  const progress = repository.collectionProgress.current({ revisionId: second.id, page }); assert.equal(progress.historicalWantedCount, 1); assert.equal(progress.overall.wanted, 0); assert.throws(() => repository.collectionProgress.saveWant(want(first.id)), /当前|版本/u);
  const rebound = repository.collectionProgress.saveWant(want(second.id, { id: saved.id, expectedVersion: saved.version, referenceId: 'b' })); assert.equal(rebound.model, 'b'); assert.equal(rebound.version, 2); assert.equal(repository.collectionProgress.wantHistory({ id: saved.id, page }).items[0]?.model, 'a');
});
test('完整进度仅显式capture且指纹防过期，历史Wanted不被后续编辑回填', async t => {
  const { repository, filePath } = await fixture(t), modelId = repository.list(page).items.find(m => m.name === '固定旧库型号')!.id, revision = publish(repository).revision; set(repository, revision.id, { referenceId: 'a', modelId, status: 'confirmed', availability: 'unknown' });
  const initial = repository.collectionProgress.current({ revisionId: revision.id, page }); assert.equal(repository.collectionProgress.snapshots({ page }).total, 0); const wanted = repository.collectionProgress.saveWant(want(revision.id));
  assert.throws(() => repository.collectionProgress.capture({ commandId: randomUUID(), revisionId: revision.id, expectedFingerprint: initial.fingerprint, userConfirmed: true }), /指纹|改变|过期/u);
  const current = repository.collectionProgress.current({ revisionId: revision.id, page }), command = { commandId: randomUUID(), revisionId: revision.id, expectedFingerprint: current.fingerprint, userConfirmed: true as const }, snapshot = repository.collectionProgress.capture(command); assert.deepEqual(repository.collectionProgress.capture(command), snapshot);
  const historical = repository.collectionProgress.snapshot({ id: snapshot.id, page }); repository.collectionProgress.saveWant(want(revision.id, { id: wanted.id, expectedVersion: wanted.version, targetLengthMinutes: 120 })); assert.deepEqual(repository.collectionProgress.snapshot({ id: snapshot.id, page }), historical); assert.equal(historical.entries.items[0]?.wantedTargets[0]?.version, 1); assert.equal(repository.collectionProgress.snapshots({ page }).total, 1);
  repository.close(); const cold = createCollectionRepository({ filePath }); try { assert.deepEqual(cold.collectionProgress.snapshot({ id: snapshot.id, page }), historical); } finally { cold.close(); }
});

test('数量明确调零后SKU仍在但coverage与Owned消失，旧快照继续保存原数', async t => {
  const { repository, filePath } = await fixture(t); repository.list(page);
  const db = new DatabaseSync(filePath, { readOnly: true }), imported = db.prepare('SELECT r.id row_id,r.revision_id,e.model_id,e.lot_id FROM spreadsheet_rows r JOIN spreadsheet_effects e ON e.id=r.effect_id').get()!; db.close();
  const modelId = String(imported.model_id), revision = publish(repository, [item('a', { lengths: [46] })]).revision;
  set(repository, revision.id, { referenceId: 'a', modelId, status: 'confirmed', availability: 'unknown' });
  const current = repository.collectionProgress.current({ revisionId: revision.id, page }); assert.equal(current.entries.items[0]?.stockCount, 3); assert.equal(current.entries.items[0]?.allKnownLengthsOwned, true);
  const snapshot = repository.collectionProgress.capture({ commandId: randomUUID(), revisionId: revision.id, expectedFingerprint: current.fingerprint, userConfirmed: true });
  const loc = { revisionId: String(imported.revision_id), rowId: String(imported.row_id) }, balance = repository.spreadsheetImports.adjustmentPreview(loc);
  repository.spreadsheetImports.adjust({ ...loc, commandId: randomUUID(), lotId: String(imported.lot_id), expectedBalanceFingerprint: balance.balanceFingerprint, legacyUsedDelta: -1, unclassifiedDelta: -1, userConfirmed: true });
  assert.equal(repository.collectionProgress.current({ revisionId: revision.id, page }).entries.items[0]?.stockCount, 1);
  assert.equal(repository.collectionProgress.snapshot({ id: snapshot.id, page }).entries.items[0]?.stockCount, 3);
  // 另建纯池导入，真实更正到零；已物化副本保持原样，不使用删实体伪造场景。
  const raw = Buffer.from('合成第二来源'); const workbook = { fileFormat: 'xlsx' as const, parserVersion: 'sheetjs-ce-0.20.3' as const, dateSystem: '1900' as const, sheets: [{ name: '库存', rows: [{ rowIndex: 1, cells: [{ columnIndex: 1, type: 'string' as const, value: '纯池' }, { columnIndex: 2, type: 'number' as const, value: 1 }, { columnIndex: 3, type: 'number' as const, value: 46 }] }] }] };
  const input = repository.spreadsheetImports.registerSource({ commandId: randomUUID(), bytes: raw, displayName: 'synthetic.xlsx', workbook });
  const plan = { sourceId: input.id, sheetName: '库存', format: 'cassette' as const, headerRow: 0, columns: { brand: null, model: 1, edition: null, year: null, iec: null, length: 3, quantity: 2, used: null, price: null, purchaseDate: null, notes: null }, sourceRelationship: 'independent' as const, previousRevisionId: null, decisions: [{ rowIndex: 1, action: 'new' as const }] };
  const preview = repository.spreadsheetImports.preview({ ...plan, page }), applied = repository.spreadsheetImports.apply({ ...plan, commandId: randomUUID(), baselineFingerprint: preview.baselineFingerprint, userConfirmed: true }), row = repository.spreadsheetImports.revision({ revisionId: applied.revision.id, page }).rows.items[0]!;
  set(repository, revision.id, { referenceId: 'a', modelId: row.modelId!, status: 'confirmed', availability: 'unknown' });
  const position = { revisionId: applied.revision.id, rowId: row.id }, before = repository.spreadsheetImports.adjustmentPreview(position);
  repository.spreadsheetImports.adjust({ ...position, commandId: randomUUID(), lotId: row.lotId!, expectedBalanceFingerprint: before.balanceFingerprint, legacyUsedDelta: 0, unclassifiedDelta: -1, userConfirmed: true });
  assert.deepEqual(repository.detail(row.modelId!, page).model.lengths, [46]);
  const zero = repository.collectionProgress.current({ revisionId: revision.id, page }); assert.equal(zero.overall.owned, 0); assert.equal(zero.entries.items[0]?.state, 'unknown'); assert.deepEqual(zero.entries.items[0]?.ownedLengths, []); assert.equal(zero.entries.items[0]?.allKnownLengthsOwned, false);
});

test('cancel与capture提交前故障各自回滚；读取不隐式capture且旧head禁止capture', async t => {
  let fail: string | null = null; const { repository } = await fixture(t, action => { if (action === fail) throw new Error('合成提交中断'); });
  const revision = publish(repository).revision, saved = repository.collectionProgress.saveWant(want(revision.id)), cancel = { commandId: randomUUID(), id: saved.id, expectedVersion: 1, userConfirmed: true as const };
  fail = 'collection-progress-cancel'; assert.throws(() => repository.collectionProgress.cancelWant(cancel), /库存暂时不可用/u); assert.equal(repository.collectionProgress.wantHistory({ id: saved.id, page }).total, 1); assert.equal(repository.collectionProgress.wants({ active: true, page }).total, 1);
  const current = repository.collectionProgress.current({ revisionId: revision.id, page }), capture = { commandId: randomUUID(), revisionId: revision.id, expectedFingerprint: current.fingerprint, userConfirmed: true as const };
  fail = 'collection-progress-capture'; assert.throws(() => repository.collectionProgress.capture(capture), /库存暂时不可用/u); assert.equal(repository.collectionProgress.snapshots({ page }).total, 0);
  fail = null; repository.collectionProgress.capture(capture); repository.collectionProgress.cancelWant(cancel);
  publish(repository, [item('b')], revision.id, [{ fromReferenceIds: ['a'], toReferenceIds: ['b'] }]);
  const oldCurrent = repository.collectionProgress.current({ revisionId: revision.id, page }); assert.equal(oldCurrent.facts, 'current'); assert.equal(oldCurrent.isCurrentRevision, false);
  assert.throws(() => repository.collectionProgress.capture({ ...capture, commandId: randomUUID(), expectedFingerprint: oldCurrent.fingerprint }), /当前/u);
});

test('readonly备份核验接受完整链，拒绝历史/当前/快照/触发器篡改且不修复现场', async t => {
  const { verifyCollectionProgressDatabase } = await import('../src/collection/collection-progress-store.js');
  const { repository, filePath } = await fixture(t), revision = publish(repository).revision, saved = repository.collectionProgress.saveWant(want(revision.id));
  const progress = repository.collectionProgress.current({ revisionId: revision.id, page }), captured = repository.collectionProgress.capture({ commandId: randomUUID(), revisionId: revision.id, expectedFingerprint: progress.fingerprint, userConfirmed: true });
  repository.collectionProgress.saveWant(want(revision.id, { id: saved.id, expectedVersion: 1, notes: '新的备注' }));
  repository.close(); const db = new DatabaseSync(filePath); t.after(() => db.close()); assert.doesNotThrow(() => verifyCollectionProgressDatabase(db));
  const original = String(db.prepare('SELECT data FROM collection_wants WHERE id=?').get(saved.id)?.data); const modified = { ...JSON.parse(original), version: 999 }; db.prepare('UPDATE collection_wants SET data=? WHERE id=?').run(JSON.stringify(modified), saved.id); assert.throws(() => verifyCollectionProgressDatabase(db), /损坏/u); assert.equal(db.prepare('SELECT data FROM collection_wants WHERE id=?').get(saved.id)?.data, JSON.stringify(modified)); db.prepare('UPDATE collection_wants SET data=? WHERE id=?').run(original, saved.id);
  const trigger = String(db.prepare("SELECT sql FROM sqlite_master WHERE name='collection_progress_snapshots_no_update'").get()?.sql); db.exec('DROP TRIGGER collection_progress_snapshots_no_update'); assert.throws(() => verifyCollectionProgressDatabase(db), /损坏/u); db.exec(trigger);
  const raw = String(db.prepare('SELECT data FROM collection_progress_snapshots WHERE id=?').get(captured.id)?.data), snapshot = JSON.parse(raw); snapshot.entries[0].wantedTargets[0].version = 2;
  db.exec('DROP TRIGGER collection_progress_snapshots_no_update'); db.prepare('UPDATE collection_progress_snapshots SET data=? WHERE id=?').run(JSON.stringify(snapshot), captured.id); db.exec(trigger); assert.throws(() => verifyCollectionProgressDatabase(db), /损坏/u);
  db.exec('DROP TRIGGER collection_progress_snapshots_no_update'); db.prepare('UPDATE collection_progress_snapshots SET data=? WHERE id=?').run(raw, captured.id); db.exec(trigger); assert.doesNotThrow(() => verifyCollectionProgressDatabase(db));
  assert.throws(() => db.exec('DELETE FROM collection_want_events'), /immutable/u); assert.throws(() => db.exec('DELETE FROM collection_progress_ledger'), /immutable/u); assert.throws(() => db.exec('DELETE FROM collection_wants'), /immutable/u);
});

test('同一reference最多100个active目标，第101次被拒绝且历史不删除', async t => {
  const { repository } = await fixture(t), revision = publish(repository).revision;
  for (let index = 0; index < 100; index++) repository.collectionProgress.saveWant(want(revision.id, { notes: String(index) }));
  assert.throws(() => repository.collectionProgress.saveWant(want(revision.id)), /容量|上限/u);
  const current = repository.collectionProgress.current({ revisionId: revision.id, page }); assert.equal(current.overall.wantTargetCount, 100); assert.equal(repository.collectionProgress.wants({ page }).total, 100);
});

test('新表JSON与行预算在解析前拒绝，容量失败不删除历史也不提交命令', async t => {
  const { verifyCollectionProgressDatabase, COLLECTION_PROGRESS_LIMITS } = await import('../src/collection/collection-progress-store.js');
  const { repository, filePath } = await fixture(t), revision = publish(repository).revision, saved = repository.collectionProgress.saveWant(want(revision.id));
  const mutable = COLLECTION_PROGRESS_LIMITS as { totalBytes: number; jsonBytes: number; wants: number; history: number; snapshots: number };
  // 使用更小的同一预算入口模拟容量边界，不为测试在磁盘制造上百MiB数据。
  const limits = { ...mutable };
  try {
    mutable.history = 2;
    assert.throws(() => repository.collectionProgress.saveWant(want(revision.id, { id: saved.id, expectedVersion: 1, notes: '不得提交' })), /容量|上限/u);
    mutable.history = limits.history; assert.equal(repository.collectionProgress.wantHistory({ id: saved.id, page }).total, 1);
    mutable.wants = 1; assert.throws(() => repository.collectionProgress.saveWant(want(revision.id)), /容量|上限/u); mutable.wants = limits.wants;
    const current = repository.collectionProgress.current({ revisionId: revision.id, page }); mutable.snapshots = 0;
    assert.throws(() => repository.collectionProgress.capture({ commandId: randomUUID(), revisionId: revision.id, expectedFingerprint: current.fingerprint, userConfirmed: true }), /容量|上限/u); mutable.snapshots = limits.snapshots;
    assert.equal(repository.collectionProgress.snapshots({ page }).total, 0);
    const db = new DatabaseSync(filePath, { readOnly: true });
    try { mutable.totalBytes = 1; assert.throws(() => verifyCollectionProgressDatabase(db), /容量|上限/u); mutable.totalBytes = limits.totalBytes; mutable.jsonBytes = 1; assert.throws(() => verifyCollectionProgressDatabase(db), /容量|上限/u); } finally { db.close(); }
  } finally { Object.assign(mutable, limits); }
  assert.equal(repository.collectionProgress.wantHistory({ id: saved.id, page }).total, 1);
  const check = new DatabaseSync(filePath, { readOnly: true }); try { assert.doesNotThrow(() => verifyCollectionProgressDatabase(check)); } finally { check.close(); }
});

test('分页保留整体统计与同一fingerprint，Renderer不能伪造参考标签或跳过确认', async t => {
  const { repository } = await fixture(t), revision = publish(repository, Array.from({ length: 28 }, (_, index) => item('r' + index, { series: index % 2 ? '奇数' : '偶数' }))).revision;
  const request = want(revision.id, { referenceId: 'r0' }); assert.throws(() => repository.collectionProgress.saveWant({ ...request, brand: '伪造' } as SaveWantEntryRequest), /请求无效/u); assert.throws(() => repository.collectionProgress.saveWant({ ...request, userConfirmed: false } as unknown as SaveWantEntryRequest), /请求无效/u);
  const saved = repository.collectionProgress.saveWant(request); assert.equal(saved.model, 'r0');
  const first = repository.collectionProgress.current({ revisionId: revision.id, page }), last = repository.collectionProgress.current({ revisionId: revision.id, page: { offset: 25, limit: 25 } }); assert.equal(first.entries.items.length, 25); assert.equal(last.entries.items.length, 3); assert.deepEqual(last.overall, first.overall); assert.equal(last.fingerprint, first.fingerprint); assert.equal(last.overall.total, 28);
});

test('合法500项长中文目录的25份完整快照按响应字节装页且遍历不丢历史', async t => {
  const { repository, filePath } = await fixture(t);
  const revision = publish(repository, Array.from({ length: 500 }, (_, index) => item('large-' + index, {
    brand: '品'.repeat(119) + String.fromCharCode(0x4e00 + index), series: '系'.repeat(120),
    model: 'm' + index, edition: '', notes: '', lengths: [], era: null,
  }))).revision;
  const current = repository.collectionProgress.current({ revisionId: revision.id, page });
  const captured = Array.from({ length: 25 }, () => repository.collectionProgress.capture({
    commandId: randomUUID(), revisionId: revision.id, expectedFingerprint: current.fingerprint, userConfirmed: true,
  }));
  assert.ok(captured.every(isCollectionProgressSnapshotSummary));
  const expected = captured.toReversed();
  assert.ok(Buffer.byteLength(JSON.stringify({ ...page, total: 25, items: expected, hasMore: false })) > MAX_COLLECTION_PROGRESS_BYTES);
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    let bytes = 0;
    for (const name of ['collection_wants', 'collection_want_events', 'collection_progress_snapshots', 'collection_progress_ledger']) {
      const columns = db.prepare(`PRAGMA table_info(${name})`).all().filter(column => column.type === 'TEXT').map(column => String(column.name));
      bytes += Number(db.prepare(`SELECT COALESCE(sum(${columns.map(column => `length(CAST(${column} AS BLOB))`).join('+')}),0) bytes FROM ${name}`).get()?.bytes);
    }
    assert.ok(bytes < 128 * 1024 * 1024);
    t.diagnostic(`完整25条列表字节=${Buffer.byteLength(JSON.stringify({ ...page, total: 25, items: expected, hasMore: false }))}，新表持久字节=${bytes}`);
  } finally { db.close(); }

  const first = repository.collectionProgress.snapshots({ bookId: revision.bookId, page });
  assert.ok(isCollectionProgressSnapshotsPage(first), '合法capture产生的列表必须通过真实响应合同');
  assert.ok(first.limit < page.limit);
  const seen: string[] = [];
  let next = first;
  while (true) {
    assert.ok(isCollectionProgressSnapshotsPage(next));
    assert.ok(Buffer.byteLength(JSON.stringify(next)) <= MAX_COLLECTION_PROGRESS_BYTES);
    assert.equal(next.total, 25);
    assert.equal(next.offset, seen.length);
    assert.deepEqual(next.items, expected.slice(next.offset, next.offset + next.items.length));
    seen.push(...next.items.map(snapshot => snapshot.id));
    if (!next.hasMore) { assert.equal(next.limit, 25); break; }
    assert.ok(next.items.length > 0);
    assert.equal(next.limit, next.items.length);
    next = repository.collectionProgress.snapshots({ revisionId: revision.id, page: { offset: seen.length, limit: 25 } });
  }
  assert.deepEqual(seen, expected.map(snapshot => snapshot.id));
  assert.equal(new Set(seen).size, 25);
  for (const requested of [{ offset: 24, limit: 25 }, { offset: 25, limit: 25 }, { offset: 250, limit: 25 }, { offset: 0, limit: 1 }, { offset: 7, limit: 3 }]) {
    const result = repository.collectionProgress.snapshots({ bookId: revision.bookId, revisionId: revision.id, page: requested });
    assert.ok(isCollectionProgressSnapshotsPage(result));
    assert.equal(result.offset, requested.offset);
    assert.equal(result.limit, requested.limit);
    assert.equal(result.total, 25);
    assert.deepEqual(result.items, expected.slice(requested.offset, requested.offset + requested.limit));
    assert.equal(result.hasMore, requested.offset + result.items.length < 25);
  }
});
