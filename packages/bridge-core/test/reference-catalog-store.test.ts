import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createCollectionRepository } from '../src/collection/repository.js';
import { verifyReferenceCatalogDatabase, REFERENCE_CATALOG_LIMITS } from '../src/collection/reference-catalog-store.js';
import type { CanonicalReference, CatalogMatch, PreviewCatalogRevisionRequest } from '@music-bridge/contracts';

const page = { offset: 0, limit: 100 };
async function oldDatabase(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-catalog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'collection.sqlite');
  const db = new DatabaseSync(file);
  db.exec(await readFile(new URL('./fixtures/collection-schema14.sql', import.meta.url), 'utf8'));
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 14);
  db.close(); return file;
}
function inventoryBytes(db: DatabaseSync) {
  return ['collection_models', 'collection_skus', 'inventory_lots', 'physical_sequences', 'physical_copies', 'inventory_ledger', 'collection_photos', 'collection_featured_photos']
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]);
}

test('固定旧schema14迁移为15，库存/照片/永久编号和原账本逐行守恒', async t => {
  const filePath = await oldDatabase(t), before = new DatabaseSync(filePath, { readOnly: true });
  const inventory = inventoryBytes(before); before.close();
  const repository = createCollectionRepository({ filePath });
  assert.equal(repository.list(page).items[0]?.counts.total, 5);
  repository.close();
  const after = new DatabaseSync(filePath, { readOnly: true });
  try {
    assert.equal(after.prepare('PRAGMA user_version').get()?.user_version, 15);
    assert.deepEqual(inventoryBytes(after), inventory);
    assert.deepEqual(after.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { after.close(); }
});

test('schema14到15提交前中断回滚整个迁移，冷开可再次迁移且不改旧库存', async t => {
  const filePath = await oldDatabase(t), before = new DatabaseSync(filePath, { readOnly: true });
  const inventory = inventoryBytes(before); before.close();
  const interrupted = createCollectionRepository({ filePath, beforeCommit: action => { if (action === 'migrate-reference-catalog') throw new Error('合成迁移中断'); } });
  try { assert.throws(() => interrupted.list(page), /库存暂时不可用/u); } finally { interrupted.close(); }
  const old = new DatabaseSync(filePath, { readOnly: true });
  try {
    assert.equal(old.prepare('PRAGMA user_version').get()?.user_version, 14);
    assert.deepEqual(inventoryBytes(old), inventory);
  } finally { old.close(); }
  const recovered = createCollectionRepository({ filePath });
  try { assert.equal(recovered.list(page).items[0]?.counts.total, 5); } finally { recovered.close(); }
  const after = new DatabaseSync(filePath, { readOnly: true });
  try { assert.equal(after.prepare('PRAGMA user_version').get()?.user_version, 15); } finally { after.close(); }
});

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const item = (referenceId = 'a', overrides: Partial<CanonicalReference> = {}): CanonicalReference => ({ referenceId, bookId: 'synthetic-book', brand: '合成品牌', series: '合成系列', edition: '1990', model: referenceId, lengths: [60, 90], iec: 'II', era: '1990', image: { kind: 'none' }, pages: ['1'], notes: '仅测试资料', confidence: 'high', ...overrides });
const pack = (items: readonly CanonicalReference[]) => JSON.stringify({ schemaVersion: 1, bookId: 'synthetic-book', title: '合成参考目录', sourceVersion: '第一版', items });
function source(repository: ReturnType<typeof createCollectionRepository>, items: readonly CanonicalReference[] = [item()]) {
  const rawPack = pack(items), request = { commandId: randomUUID(), rawPack, packHash: hash(rawPack), userConfirmed: true as const };
  return { request, value: repository.catalog.registerSource(request) };
}
function publish(repository: ReturnType<typeof createCollectionRepository>, input: Partial<PreviewCatalogRevisionRequest> = {}) {
  const entries = input.items ?? [item()], registered = input.sourceId ?? source(repository, entries).value.id;
  const request: PreviewCatalogRevisionRequest = { sourceId: registered, expectedCurrentRevisionId: null, items: entries, mappings: [], ...input };
  const preview = repository.catalog.previewRevision(request);
  const command = { ...request, commandId: randomUUID(), baselineFingerprint: preview.baselineFingerprint, userConfirmed: true as const };
  return { preview, command, value: repository.catalog.publishRevision(command) };
}
async function fixture(t: test.TestContext, beforeCommit?: (action: string) => void) {
  const filePath = await oldDatabase(t), repository = createCollectionRepository({ filePath, ...(beforeCommit ? { beforeCommit } : {}) });
  repository.list(page); t.after(() => repository.close());
  const modelId = repository.list(page).items[0]!.id;
  return { filePath, repository, modelId };
}
function set(repository: ReturnType<typeof createCollectionRepository>, revisionId: string, match: CatalogMatch) {
  const expectedMatchVersion = repository.catalog.revision({ id: revisionId }).matchVersion;
  return repository.catalog.setMatch({ commandId: randomUUID(), revisionId, expectedMatchVersion, match, userConfirmed: true });
}
const matched = (referenceId: string, modelId: string, status: 'confirmed' | 'candidate' | 'needs-review' = 'confirmed'): CatalogMatch => ({ referenceId, modelId, status, availability: 'unknown' });

test('登记资料原UTF8与hash不可变，BOM与空行保存；重复命令/相同原包幂等且不写库存', async t => {
  const { repository, filePath } = await fixture(t), check = new DatabaseSync(filePath, { readOnly: true });
  const before = inventoryBytes(check);
  const rawPack = '\uFEFF' + pack([item()]) + '\n\n';
  const request = { commandId: randomUUID(), rawPack, packHash: hash(rawPack), userConfirmed: true as const };
  const saved = repository.catalog.registerSource(request);
  assert.deepEqual(repository.catalog.registerSource(request), saved);
  assert.deepEqual(repository.catalog.registerSource({ ...request, commandId: randomUUID() }), saved);
  assert.deepEqual(repository.catalog.source({ id: saved.id }), { source: saved, rawPack });
  assert.equal(repository.catalog.sources({ offset: 0, limit: 25 }).total, 1);
  assert.equal(repository.catalog.history({ bookId: saved.bookId, offset: 0, limit: 25 }).currentRevisionId, null);
  assert.throws(() => repository.catalog.registerSource({ ...request, rawPack: rawPack + '\n', packHash: hash(rawPack + '\n') }), /同一操作编号/u);
  assert.throws(() => repository.catalog.registerSource({ ...request, commandId: randomUUID(), packHash: '0'.repeat(64) }), /资料|Hash|哈希/u);
  assert.deepEqual(inventoryBytes(check), before); check.close();
  repository.close();
  const cold = createCollectionRepository({ filePath });
  try { assert.deepEqual(cold.catalog.source({ id: saved.id }), { source: saved, rawPack }); } finally { cold.close(); }
});

test('重复reference页与时长只占一个分母；冲突身份或不同ID重复canonical拒绝，preview只读', async t => {
  const { repository } = await fixture(t);
  const entries = [item(), item('a', { pages: ['1', '2'], lengths: [90, 120] })];
  const saved = source(repository, entries).value;
  assert.equal(saved.itemCount, 1);
  const request = { sourceId: saved.id, expectedCurrentRevisionId: null, items: [item('a', { pages: ['1', '2'], lengths: [60, 90, 120] })], mappings: [] };
  const preview = repository.catalog.previewRevision(request);
  assert.equal(preview.counts.total, 1); assert.equal(preview.counts.unknown, 1);
  assert.equal(repository.catalog.history({ bookId: saved.bookId, offset: 0, limit: 25 }).total, 0);
  const result = publish(repository, request).value;
  assert.deepEqual(result.revision.items[0]?.pages, ['1', '2']);
  assert.deepEqual(result.revision.items[0]?.lengths, [60, 90, 120]);
  assert.throws(() => source(repository, [item(), item('a', { edition: '其他版次' })]), /资料|重复|冲突/u);
  assert.throws(() => source(repository, [item(), item('different-id', { model: 'a' })]), /资料|重复|冲突/u);
});

test('publish命令幂等，篡改指纹/过期current/预览后match与库存变化均拒绝', async t => {
  const { repository, modelId } = await fixture(t), initial = publish(repository, { items: [item(), item('b')] });
  assert.deepEqual(repository.catalog.publishRevision(initial.command), initial.value);
  assert.throws(() => repository.catalog.publishRevision({ ...initial.command, items: [item('changed')] }), /同一操作编号/u);
  const request = { sourceId: initial.value.revision.sourceId, expectedCurrentRevisionId: initial.value.revision.id, items: [item(), item('b')], mappings: [{ fromReferenceIds: ['a'], toReferenceIds: ['a'] }] };
  const before = repository.catalog.previewRevision(request);
  set(repository, initial.value.revision.id, matched('a', modelId));
  assert.throws(() => repository.catalog.publishRevision({ ...request, commandId: randomUUID(), baselineFingerprint: before.baselineFingerprint, userConfirmed: true }), /预览|基线|改变/u);
  const current = repository.catalog.previewRevision(request);
  repository.receive({ commandId: randomUUID(), model: { brand: '合成品牌', name: '固定旧库型号', edition: '1990', year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified' }, lengthMinutes: 60, quantities: { sealedBlank: 1, openedBlank: 0, legacyUsed: 0, unclassified: 0 } });
  assert.throws(() => repository.catalog.publishRevision({ ...request, commandId: randomUUID(), baselineFingerprint: current.baselineFingerprint, userConfirmed: true }), /预览|基线|改变/u);
  const next = publish(repository, request).value;
  assert.equal(next.revision.sequence, 2);
  assert.throws(() => repository.catalog.previewRevision(request), /当前|改变|版本/u);
});

test('Unknown/Missing/Candidate/NeedsReview独立，确认同型号不能贡献两个canonical，库存和照片不变', async t => {
  const { repository, filePath, modelId } = await fixture(t), revision = publish(repository, { items: [item(), item('b')] }).value;
  const check = new DatabaseSync(filePath, { readOnly: true }), before = inventoryBytes(check);
  assert.equal(revision.currentCounts.unknown, 2);
  const candidate = set(repository, revision.revision.id, matched('a', modelId, 'candidate'));
  assert.equal(candidate.currentCounts.owned, 0); assert.equal(candidate.currentCounts.candidate, 1);
  const confirmed = set(repository, revision.revision.id, matched('a', modelId));
  assert.equal(confirmed.currentCounts.owned, 1); assert.equal(confirmed.currentEntries[0]?.stockCount, 5);
  assert.throws(() => set(repository, revision.revision.id, matched('b', modelId)), /型号|贡献|重复/u);
  const missing = set(repository, revision.revision.id, { referenceId: 'b', modelId: null, status: 'unmatched', availability: 'missing' });
  assert.equal(missing.currentCounts.missing, 1); assert.equal(missing.currentCounts.unknown, 0);
  const review = set(repository, revision.revision.id, matched('a', modelId, 'needs-review'));
  assert.equal(review.currentCounts.owned, 0); assert.equal(review.currentCounts.needsReview, 1);
  const snapshot = repository.catalog.snapshot({ id: confirmed.snapshot.id });
  assert.equal(snapshot.counts.owned, 1); assert.equal(snapshot.entries[0]?.stockCount, 5);
  assert.deepEqual(inventoryBytes(check), before); check.close();
});

test('合并保留多型号确认但只计一次；拆分全部NeedsReview，新增只改新分母且历史snapshot不覆盖', async t => {
  const { repository, modelId } = await fixture(t);
  const secondModel = repository.receive({ commandId: randomUUID(), model: { brand: '合成品牌', name: '另一型号', edition: '1990', year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified' }, lengthMinutes: 90, quantities: { sealedBlank: 1, openedBlank: 0, legacyUsed: 0, unclassified: 0 } }).modelId;
  const first = publish(repository, { items: [item(), item('b')] }).value;
  set(repository, first.revision.id, matched('a', modelId));
  const owned = set(repository, first.revision.id, matched('b', secondModel));
  assert.equal(owned.currentCounts.owned, 2);
  const merged = publish(repository, { items: [item('merged'), item('new')], expectedCurrentRevisionId: first.revision.id, mappings: [{ fromReferenceIds: ['a', 'b'], toReferenceIds: ['merged'] }] });
  assert.equal(merged.preview.delta.merged, 1); assert.equal(merged.value.currentCounts.owned, 1);
  assert.equal(merged.value.currentEntries[0]?.matches.length, 2); assert.equal(merged.value.currentEntries[0]?.stockCount, 6);
  assert.equal(merged.value.currentCounts.total, 2); assert.equal(merged.value.currentCounts.unknown, 1);
  const split = publish(repository, { items: [item('left'), item('right'), item('new')], expectedCurrentRevisionId: merged.value.revision.id, mappings: [{ fromReferenceIds: ['merged'], toReferenceIds: ['left', 'right'] }, { fromReferenceIds: ['new'], toReferenceIds: ['new'] }] });
  assert.equal(split.preview.delta.split, 1); assert.equal(split.value.currentCounts.owned, 0); assert.equal(split.value.currentCounts.needsReview, 2);
  assert.ok(split.value.matches.filter(match => ['left', 'right'].includes(match.referenceId)).every(match => match.status === 'needs-review'));
  set(repository, split.value.revision.id, matched('left', modelId));
  assert.throws(() => set(repository, split.value.revision.id, matched('right', modelId)), /型号|贡献|重复/u);
  assert.deepEqual(repository.catalog.snapshot({ id: owned.snapshot.id }), owned.snapshot);
  assert.equal(repository.catalog.revision({ id: first.revision.id }).currentCounts.owned, 2);
  assert.equal(repository.catalog.history({ bookId: 'synthetic-book', offset: 0, limit: 1 }).total, 3);
});

test('未映射旧匹配不猜测转移；跨书籍/mapping不存在/重复映射均失败', async t => {
  const { repository, modelId } = await fixture(t), first = publish(repository).value;
  set(repository, first.revision.id, matched('a', modelId));
  const request = { sourceId: first.revision.sourceId, expectedCurrentRevisionId: first.revision.id, items: [item()], mappings: [] };
  assert.equal(repository.catalog.previewRevision(request).counts.owned, 0);
  assert.throws(() => repository.catalog.previewRevision({ ...request, items: [item('a', { bookId: 'other-book' })] }), /书|资料|目录/u);
  assert.throws(() => repository.catalog.previewRevision({ ...request, mappings: [{ fromReferenceIds: ['absent'], toReferenceIds: ['a'] }] }), /映射|目录/u);
  const next = publish(repository, request).value;
  assert.throws(() => set(repository, first.revision.id, matched('a', modelId, 'candidate')), /当前|历史|版本/u);
  assert.equal(next.currentCounts.unknown, 1);
});

test('发布和setMatch事务故障无半条revision/指针/快照/回执，原命令可明确再确认', async t => {
  let failAction = '';
  const { repository, modelId } = await fixture(t, action => { if (action === failAction) throw new Error('合成提交故障'); });
  const registered = source(repository).value;
  const request = { sourceId: registered.id, expectedCurrentRevisionId: null, items: [item()], mappings: [] };
  const preview = repository.catalog.previewRevision(request), command = { ...request, commandId: randomUUID(), baselineFingerprint: preview.baselineFingerprint, userConfirmed: true as const };
  failAction = 'publish-reference-catalog'; assert.throws(() => repository.catalog.publishRevision(command), /库存暂时不可用/u);
  assert.equal(repository.catalog.history({ bookId: registered.bookId, offset: 0, limit: 25 }).total, 0);
  failAction = ''; const revision = repository.catalog.publishRevision(command);
  const match = { commandId: randomUUID(), revisionId: revision.revision.id, expectedMatchVersion: 0, match: matched('a', modelId), userConfirmed: true as const };
  failAction = 'set-reference-catalog-match'; assert.throws(() => repository.catalog.setMatch(match), /库存暂时不可用/u);
  assert.equal(repository.catalog.revision({ id: revision.revision.id }).matchVersion, 0);
  failAction = ''; assert.equal(repository.catalog.setMatch(match).currentCounts.owned, 1);
  assert.deepEqual(repository.catalog.setMatch(match), repository.catalog.setMatch(match));
});

test('当前库存变化只更新只读current事实，历史snapshot原值与所有目录回执跨冷开保留', async t => {
  const { repository, filePath, modelId } = await fixture(t), initial = publish(repository).value;
  const confirmed = set(repository, initial.revision.id, matched('a', modelId));
  repository.receive({ commandId: randomUUID(), model: { brand: '合成品牌', name: '固定旧库型号', edition: '1990', year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified' }, lengthMinutes: 60, quantities: { sealedBlank: 2, openedBlank: 0, legacyUsed: 0, unclassified: 0 } });
  const current = repository.catalog.revision({ id: initial.revision.id });
  assert.equal(current.currentEntries[0]?.stockCount, 7);
  assert.equal(current.snapshot.entries[0]?.stockCount, 5);
  assert.deepEqual(repository.catalog.snapshot({ id: confirmed.snapshot.id }), confirmed.snapshot);
  repository.close();
  const cold = createCollectionRepository({ filePath });
  try { assert.deepEqual(cold.catalog.revision({ id: initial.revision.id }), current); } finally { cold.close(); }
  const readonly = new DatabaseSync(filePath, { readOnly: true });
  try { const before = readonly.prepare('PRAGMA data_version').get(); verifyReferenceCatalogDatabase(readonly); assert.deepEqual(readonly.prepare('PRAGMA data_version').get(), before); } finally { readonly.close(); }
});

test('资料/revision/snapshot/ledger均有不可变保护；只读备份校验拒绝原包损坏且不修复', async t => {
  const { repository, filePath } = await fixture(t), initial = publish(repository).value;
  repository.close();
  const db = new DatabaseSync(filePath);
  for (const table of ['reference_sources', 'reference_catalog_revisions', 'reference_catalog_snapshots', 'reference_catalog_ledger']) {
    assert.throws(() => db.exec(`DELETE FROM ${table}`), /immutable reference catalog/u);
    assert.throws(() => db.exec(`UPDATE ${table} SET ${table === 'reference_catalog_ledger' ? 'result=result' : 'data=data'}`), /immutable reference catalog/u);
  }
  verifyReferenceCatalogDatabase(db);
  db.exec('DROP TRIGGER reference_sources_no_update');
  db.prepare('UPDATE reference_sources SET raw_pack=raw_pack || ? WHERE id=?').run('\n', initial.revision.sourceId);
  const before = db.prepare('SELECT raw_pack FROM reference_sources').get();
  assert.throws(() => verifyReferenceCatalogDatabase(db), /参考目录/u);
  assert.deepEqual(db.prepare('SELECT raw_pack FROM reference_sources').get(), before);
  db.close();
  const cold = createCollectionRepository({ filePath });
  try { assert.throws(() => cold.catalog.source({ id: initial.revision.sourceId }), /库存暂时不可用/u); } finally { cold.close(); }
});

test('无确认/未知字段/越界读取不能写目录，关闭后所有目录入口拒绝', async t => {
  const { repository, filePath } = await fixture(t), rawPack = pack([item()]);
  const request = { commandId: randomUUID(), rawPack, packHash: hash(rawPack), userConfirmed: true as const };
  assert.throws(() => repository.catalog.registerSource({ ...request, nativePath: '/synthetic/forbidden' } as typeof request), /资料|目录/u);
  assert.throws(() => repository.catalog.registerSource({ ...request, userConfirmed: false } as unknown as typeof request), /资料|目录/u);
  assert.throws(() => repository.catalog.sources({ offset: 0, limit: 26 }), /资料|目录/u);
  assert.equal(repository.catalog.sources({ offset: 0, limit: 25 }).total, 0);
  repository.close();
  assert.throws(() => repository.catalog.registerSource(request), /库存暂时不可用/u);
  const db = new DatabaseSync(filePath, { readOnly: true });
  try { assert.equal(db.prepare('SELECT count(*) n FROM reference_sources').get()?.n, 0); } finally { db.close(); }
});

test('只读校验拒绝同version但latest snapshot与当前匹配不一致', async t => {
  const { repository, filePath, modelId } = await fixture(t), initial = publish(repository).value;
  repository.close();
  const db = new DatabaseSync(filePath);
  db.prepare('UPDATE reference_catalog_matches SET data=? WHERE revision_id=?').run(JSON.stringify([matched('a', modelId)]), initial.revision.id);
  try { assert.throws(() => verifyReferenceCatalogDatabase(db), /参考目录/u); } finally { db.close(); }
});

test('snapshot读取拒绝不存在的model引用，不把合法JSON形状当成历史证据', async t => {
  const { repository, filePath } = await fixture(t), initial = publish(repository).value;
  const db = new DatabaseSync(filePath), snapshotId = randomUUID();
  const forged = { ...initial.snapshot, id: snapshotId, counts: { ...initial.snapshot.counts, candidate: 1 }, entries: [{ referenceId: 'a', state: 'unknown', stockCount: 0, matches: [matched('a', randomUUID(), 'candidate')] }] };
  db.prepare('INSERT INTO reference_catalog_snapshots VALUES(?,?,?,?)').run(snapshotId, initial.revision.id, 0, JSON.stringify(forged)); db.close();
  assert.throws(() => repository.catalog.snapshot({ id: snapshotId }), /库存暂时不可用/u);
});

test('只读校验在解析JSON前拒绝超长行与过多目录行，不修复坏输入', async t => {
  const { repository, filePath } = await fixture(t); repository.close();
  const db = new DatabaseSync(filePath);
  db.prepare('INSERT INTO reference_sources VALUES(?,?,?,?,?)').run(randomUUID(), 'synthetic-book', '0'.repeat(64), '{}', ' '.repeat(8 * 1024 * 1024 + 1));
  assert.throws(() => verifyReferenceCatalogDatabase(db), /容量/u);
  const trigger = String(db.prepare("SELECT sql FROM sqlite_master WHERE name='reference_sources_no_delete'").get()?.sql);
  db.exec('DROP TRIGGER reference_sources_no_delete; DELETE FROM reference_sources');
  db.exec(trigger);
  db.exec("WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM rows WHERE n<20001) INSERT INTO reference_sources SELECT printf('%08d-1111-4111-8111-111111111111',n),'synthetic-book',printf('%064d',n),'{}','{}' FROM rows");
  assert.throws(() => verifyReferenceCatalogDatabase(db), /容量/u);
  assert.equal(db.prepare('SELECT count(*) n FROM reference_sources').get()?.n, 20001);
  db.close();
});

test('目录容量不足在事务中回滚资料和回执，不丢历史也不创建半条资料', async t => {
  const { repository, filePath } = await fixture(t), registered = source(repository);
  const db = new DatabaseSync(filePath);
  const ledger = db.prepare('SELECT * FROM reference_catalog_ledger LIMIT 1').get()!;
  assert.ok(typeof ledger.fingerprint === 'string' && typeof ledger.kind === 'string' && typeof ledger.result === 'string' && typeof ledger.created_at === 'string');
  const insert = db.prepare('INSERT INTO reference_catalog_ledger VALUES(?,?,?,?,?)');
  db.exec('BEGIN');
  for (let n = 0; n < REFERENCE_CATALOG_LIMITS.rows - 3; n++) insert.run(randomUUID(), ledger.fingerprint, ledger.kind, ledger.result, ledger.created_at);
  db.exec('COMMIT');
  const before = Number(db.prepare('SELECT count(*) n FROM reference_catalog_ledger').get()?.n);
  const rawPack = registered.request.rawPack + '\n', request = { ...registered.request, commandId: randomUUID(), rawPack, packHash: hash(rawPack) };
  assert.throws(() => repository.catalog.registerSource(request), /容量/u);
  assert.equal(db.prepare('SELECT count(*) n FROM reference_sources').get()?.n, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM reference_catalog_ledger').get()?.n, before);
  assert.equal(db.prepare('SELECT command_id FROM reference_catalog_ledger WHERE command_id=?').get(request.commandId), undefined);
  assert.deepEqual(repository.catalog.source({ id: registered.value.id }), { source: registered.value, rawPack: registered.request.rawPack });
  db.close();
});
