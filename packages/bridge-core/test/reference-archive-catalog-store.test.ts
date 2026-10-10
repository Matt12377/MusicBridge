import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createCollectionRepository } from '../src/collection/repository.js';
import { verifyReferenceCatalogDatabase, verifyReferenceCatalogZipDatabase } from '../src/collection/reference-catalog-store.js';
import { isCatalogRevisionDetail, isCatalogRevisionPreview, type CanonicalReference, type CatalogMatch, type ImportReferenceArchiveCatalogRequest } from '@music-bridge/contracts';

const page = { offset: 0, limit: 100 };
const datasetId = '11111111-1111-7111-8111-111111111111';
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const archiveSha256 = hash('合成完整 ZIP 身份，仅测试目录事务，不是资产归档证据');
const item = (referenceId = 'a', overrides: Partial<CanonicalReference> = {}): CanonicalReference => ({
  referenceId, bookId: 'synthetic-book', brand: '合成品牌', series: '合成系列', edition: '1990', model: referenceId,
  lengths: [60, 90], iec: 'II', era: '1990', image: { kind: 'none' }, pages: ['1'], notes: '合成参考说明', confidence: 'high', ...overrides,
});
const pack = (items: readonly CanonicalReference[], sourceVersion = 'r3'): string => JSON.stringify({
  schemaVersion: 1, bookId: 'synthetic-book', title: '合成完整磁带资料', sourceVersion, items,
});
const archived = (items: readonly CanonicalReference[], sha256 = archiveSha256): CanonicalReference[] => items.map((entry, n) => ({
  ...entry, archive: { sha256, primaryAssetId: n < 16 ? null : `image_${n}.jpg` },
}));
type Repository = ReturnType<typeof createCollectionRepository>;

function databaseRows(filePath: string, references = true) {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
      .map(row => String(row.name)).filter(name => references || !name.startsWith('reference_'));
    return names.map(name => {
      assert.match(name, /^[A-Za-z0-9_]+$/u);
      const rows = db.prepare(`SELECT * FROM "${name}"`).all().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return { name, rows };
    });
  } finally { db.close(); }
}
async function fixture(t: test.TestContext, beforeCommit?: (action: string) => void) {
  const directory = await mkdtemp('/Volumes/LifeWeave/Developer/CommandLine/tmp/musicbridge-archive-catalog-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'collection.sqlite');
  const db = new DatabaseSync(filePath);
  try { db.exec(await readFile(new URL('./fixtures/collection-schema14.sql', import.meta.url), 'utf8')); } finally { db.close(); }
  const repository = createCollectionRepository({ filePath, ...(beforeCommit ? { beforeCommit } : {}) });
  t.after(() => repository.close());
  const modelId = repository.list(page).items[0]!.id;
  // 非空旧照片、个人录音与实体数字关联都要守恒，不能只检查空表。
  const legacy = repository.receive({ commandId: randomUUID(), model: { brand: '旧用户品牌', name: '既有录音型号', edition: '1988', year: 1988,
    format: 'cassette', tapeType: 'I', identification: 'verified' }, lengthMinutes: 60,
    quantities: { sealedBlank: 0, openedBlank: 0, legacyUsed: 1, unclassified: 0 } });
  const copy = repository.materialize({ commandId: randomUUID(), lotId: legacy.lotId!, bucket: 'legacyUsed', action: 'register-legacy' });
  repository.music.saveLegacy({ commandId: randomUUID(), physicalId: copy.physicalId!, expectedRevision: 1,
    content: { title: '既有个人录音', artist: '用户原有内容', tracks: [{ title: '旧录音曲目', artist: '用户原有内容', position: 1, side: 'A' }], notes: '导入必须原样保留' } });
  const release = repository.music.saveRelease({ commandId: randomUUID(), release: {
    title: '既有实体专辑', artist: '合成旧艺人', format: 'cd', quantity: 1, completeness: 'basic', tracks: [],
  } });
  repository.links.link({ commandId: randomUUID(), fingerprint: hash('合成既有实体数字关联'), releaseId: release.id, expectedRevision: 1,
    relation: 'exact', ripFromCdConfirmed: true, metadata: { title: '既有数字专辑', artist: '合成旧艺人', year: 1990, version: '旧版' } });
  repository.music.addPhoto({ commandId: randomUUID(), id: release.id, image: { dataUrl: 'data:image/jpeg;base64,/9j/2Q==', width: 1, height: 1 } });
  return { repository, filePath, modelId };
}
function publish(repository: Repository, items: readonly CanonicalReference[], currentId: string | null = null) {
  const rawPack = pack(items, '旧版'), source = repository.catalog.registerSource({ commandId: randomUUID(), rawPack, packHash: hash(rawPack), userConfirmed: true });
  const request = { sourceId: source.id, expectedCurrentRevisionId: currentId, items,
    mappings: currentId === null ? [] : items.map(i => ({ fromReferenceIds: [i.referenceId], toReferenceIds: [i.referenceId] })) };
  const preview = repository.catalog.previewRevision(request);
  return repository.catalog.publishRevision({ ...request, commandId: randomUUID(), baselineFingerprint: preview.baselineFingerprint, userConfirmed: true });
}
function prepare(repository: Repository, rawPack: string, currentId: string | null = null, sha256 = archiveSha256) {
  const request = { archiveSha256: sha256, expectedDatasetId: datasetId, expectedCurrentRevisionId: currentId };
  const preview = repository.catalog.previewArchiveCatalog(request, rawPack);
  const command: ImportReferenceArchiveCatalogRequest = { ...request, commandId: randomUUID(), baselineFingerprint: preview.baselineFingerprint, userConfirmed: true };
  return { preview, command };
}
function set(repository: Repository, revisionId: string, match: CatalogMatch) {
  return repository.catalog.setMatch({ commandId: randomUUID(), revisionId,
    expectedMatchVersion: repository.catalog.revision({ id: revisionId }).matchVersion, match, userConfirmed: true });
}

test('634项完整档案一次原子登记发布，16缺主图保持unknown且全部既有个人数据逐行守恒', async t => {
  const { repository, filePath } = await fixture(t), before = databaseRows(filePath, false);
  const entries = archived(Array.from({ length: 634 }, (_, n) => item(`ref-${n}`))), rawPack = pack(entries);
  const allBefore = databaseRows(filePath), prepared = prepare(repository, rawPack);
  assert.equal(isCatalogRevisionPreview(prepared.preview), true);
  assert.deepEqual(databaseRows(filePath), allBefore, '预览不能先登记来源或写入任何表');
  assert.equal(prepared.preview.counts.total, 634);
  assert.equal(prepared.preview.counts.unknown, 634);
  assert.equal(prepared.preview.counts.missing, 0);
  const result = repository.catalog.importArchiveCatalog(prepared.command, rawPack);
  assert.equal(isCatalogRevisionDetail(result), true);
  assert.equal(result.revision.items.length, 634);
  assert.equal(result.revision.items.filter(i => i.archive?.primaryAssetId === null).length, 16);
  assert.equal(result.currentCounts.unknown, 634);
  assert.equal(result.currentCounts.missing, 0);
  assert.equal(repository.catalog.sources({ offset: 0, limit: 25 }).total, 1);
  assert.equal(repository.catalog.source({ id: result.revision.sourceId }).rawPack, rawPack);
  assert.equal(repository.catalog.history({ bookId: 'synthetic-book', offset: 0, limit: 25 }).total, 1);
  assert.deepEqual(databaseRows(filePath, false), before);
});

test('完整self mapping保留全部匹配状态和旧修订，资料字段变化明确列入preview delta', async t => {
  const { repository, filePath, modelId } = await fixture(t), entries = ['a', 'b', 'c', 'd', 'e'].map(id => item(id));
  const first = publish(repository, entries);
  set(repository, first.revision.id, { referenceId: 'a', modelId, status: 'confirmed', availability: 'unknown' });
  set(repository, first.revision.id, { referenceId: 'b', modelId, status: 'candidate', availability: 'unknown' });
  set(repository, first.revision.id, { referenceId: 'c', modelId, status: 'needs-review', availability: 'unknown' });
  const prior = set(repository, first.revision.id, { referenceId: 'd', modelId: null, status: 'unmatched', availability: 'missing' });
  const before = databaseRows(filePath, false);
  const next = entries.map(entry => ({ ...entry, notes: '原说明的资料修订', lengths: [60, 90, 120], pages: ['1', '2'] }));
  const rawPack = pack(archived([...next, item('new')])), prepared = prepare(repository, rawPack, first.revision.id);
  assert.deepEqual(prepared.preview.delta.updatedReferenceIds, ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(prepared.preview.delta.addedReferenceIds, ['new']);
  assert.deepEqual(prepared.preview.delta.removedReferenceIds, []);
  assert.equal(prepared.preview.delta.merged, 0); assert.equal(prepared.preview.delta.split, 0);
  assert.equal(prepared.preview.counts.owned, 1); assert.equal(prepared.preview.counts.missing, 1);
  assert.equal(prepared.preview.counts.candidate, 1); assert.equal(prepared.preview.counts.needsReview, 1);
  // 旧修订 API 仍要求显式映射；本次修复只在档案导入生成完整映射。
  assert.equal(repository.catalog.previewRevision({ sourceId: first.revision.sourceId, expectedCurrentRevisionId: first.revision.id, items: entries, mappings: [] }).counts.owned, 0);
  const result = repository.catalog.importArchiveCatalog(prepared.command, rawPack);
  for (const entry of entries) assert.deepEqual(result.matches.filter(m => m.referenceId === entry.referenceId), prior.matches.filter(m => m.referenceId === entry.referenceId));
  assert.deepEqual(result.matches.find(m => m.referenceId === 'new'), { referenceId: 'new', modelId: null, status: 'unmatched', availability: 'unknown' });
  assert.deepEqual(result.revision.mappings, entries.map(i => ({ fromReferenceIds: [i.referenceId], toReferenceIds: [i.referenceId] })));
  assert.deepEqual(repository.catalog.revision({ id: first.revision.id }).revision, first.revision);
  assert.deepEqual(repository.catalog.revision({ id: first.revision.id }).matches, prior.matches);
  assert.deepEqual(repository.catalog.snapshot({ id: prior.snapshot.id }), prior.snapshot);
  assert.deepEqual(databaseRows(filePath, false), before);
});

test('同一来源原子发布失败回滚所有表，既有sources/revisions/links原样保留，原命令可明确重试', async t => {
  let interrupt = false;
  const { repository, filePath, modelId } = await fixture(t, action => { if (interrupt && action === 'import-reference-archive-catalog') throw new Error('合成提交前故障'); });
  const first = publish(repository, [item()]);
  set(repository, first.revision.id, { referenceId: 'a', modelId, status: 'confirmed', availability: 'unknown' });
  const rawPack = pack(archived([item(), item('new')])), prepared = prepare(repository, rawPack, first.revision.id);
  const before = databaseRows(filePath);
  interrupt = true;
  assert.throws(() => repository.catalog.importArchiveCatalog(prepared.command, rawPack), /库存暂时不可用/u);
  assert.deepEqual(databaseRows(filePath), before, '来源、修订、指针、快照和ledger必须一起回滚');
  interrupt = false;
  const result = repository.catalog.importArchiveCatalog(prepared.command, rawPack);
  assert.equal(result.revision.previousRevisionId, first.revision.id);
  assert.equal(result.currentCounts.owned, 1);
  assert.equal(repository.catalog.sources({ offset: 0, limit: 25 }).total, 2);
  assert.equal(repository.catalog.history({ bookId: 'synthetic-book', offset: 0, limit: 25 }).total, 2);
});

test('旧ID删除、重编号、合并、拆分或同ID身份改变都在写入前阻断', async t => {
  const { repository, filePath } = await fixture(t), first = publish(repository, [item(), item('b')]);
  const before = databaseRows(filePath);
  const rejected = [
    [item('b')], [item('renamed', { model: 'a' }), item('b')], [item('merged')],
    [item('a-left'), item('a-right'), item('b')], [item('a', { edition: '另一版次' }), item('b')],
    [item('a', { model: '另一型号' }), item('b')], [item('a', { iec: 'I' }), item('b')],
  ];
  for (const entries of rejected) {
    const rawPack = pack(archived(entries));
    assert.throws(() => prepare(repository, rawPack, first.revision.id), /编号|身份|目录/u);
    assert.deepEqual(databaseRows(filePath), before);
  }
});

test('NFKC与大小写身份相同仍可自映射，非身份字段变化显式预览而不改旧referenceId', async t => {
  const { repository } = await fixture(t), first = publish(repository, [item('a', { brand: 'TDK', model: 'SA' })]);
  const rawPack = pack(archived([item('a', { brand: ' ｔｄｋ ', model: 'sa', notes: '新增介绍', confidence: 'medium' })]));
  const prepared = prepare(repository, rawPack, first.revision.id);
  assert.deepEqual(prepared.preview.delta.updatedReferenceIds, ['a']);
  const result = repository.catalog.importArchiveCatalog(prepared.command, rawPack);
  assert.equal(result.revision.items[0]?.referenceId, 'a');
  assert.equal(result.revision.items[0]?.notes, '新增介绍');
});

test('档案哈希混用、超预算原文和附带未知字段均不能登记来源或写入目录', async t => {
  const { repository, filePath } = await fixture(t), before = databaseRows(filePath);
  const request = { archiveSha256, expectedDatasetId: datasetId, expectedCurrentRevisionId: null };
  for (const rawPack of [pack([item()]), pack(archived([item()], hash('另一份ZIP'))),
    JSON.stringify({ ...JSON.parse(pack(archived([item()]))), absolutePath: '/private/source.zip' }),
    pack(archived(Array.from({ length: 634 }, (_, n) => item(`ref-${n}`, { notes: '长'.repeat(2000) }))))]) {
    assert.throws(() => repository.catalog.previewArchiveCatalog(request, rawPack), /档案|目录/u);
    assert.deepEqual(databaseRows(filePath), before);
  }
});

test('预览绑定原文、工作库、匹配和库存事实，任一改变均拒绝旧指纹而不产生半条来源', async t => {
  const { repository, filePath, modelId } = await fixture(t), first = publish(repository, [item()]);
  const rawPack = pack(archived([item(), item('new')])), prepared = prepare(repository, rawPack, first.revision.id);
  const anotherDataset = '22222222-2222-7222-8222-222222222222';
  const otherPreview = repository.catalog.previewArchiveCatalog({ archiveSha256, expectedDatasetId: anotherDataset, expectedCurrentRevisionId: first.revision.id }, rawPack);
  assert.notEqual(otherPreview.baselineFingerprint, prepared.preview.baselineFingerprint);
  const before = databaseRows(filePath);
  assert.throws(() => repository.catalog.importArchiveCatalog({ ...prepared.command, expectedDatasetId: anotherDataset }, rawPack), /基线|预览/u);
  assert.deepEqual(databaseRows(filePath), before);
  assert.throws(() => repository.catalog.importArchiveCatalog(prepared.command, pack(archived([item(), item('new')]), '改变的来源文字')), /基线|预览/u);
  set(repository, first.revision.id, { referenceId: 'a', modelId, status: 'confirmed', availability: 'unknown' });
  assert.throws(() => repository.catalog.importArchiveCatalog(prepared.command, rawPack), /基线|预览/u);
  const fresh = prepare(repository, rawPack, first.revision.id);
  repository.receive({ commandId: randomUUID(), model: { brand: '合成品牌', name: '固定旧库型号', edition: '1990', year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified' },
    lengthMinutes: 90, quantities: { sealedBlank: 1, openedBlank: 0, legacyUsed: 0, unclassified: 0 } });
  assert.throws(() => repository.catalog.importArchiveCatalog(fresh.command, rawPack), /基线|预览/u);
  assert.equal(repository.catalog.sources({ offset: 0, limit: 25 }).total, 1);
  assert.equal(repository.catalog.history({ bookId: 'synthetic-book', offset: 0, limit: 25 }).total, 1);
});

test('同ZIP同命令与新命令均幂等，后续用户改版后旧命令只返原回执且新导入禁止倒退', async t => {
  const { repository, filePath } = await fixture(t), entries = archived([item(), item('b')]), rawPack = pack(entries);
  const prepared = prepare(repository, rawPack), result = repository.catalog.importArchiveCatalog(prepared.command, rawPack);
  assert.deepEqual(repository.catalog.importArchiveCatalog(prepared.command, rawPack), result);
  const again = prepare(repository, rawPack, result.revision.id);
  assert.deepEqual(repository.catalog.importArchiveCatalog(again.command, rawPack), result);
  assert.equal(repository.catalog.sources({ offset: 0, limit: 25 }).total, 1);
  assert.equal(repository.catalog.history({ bookId: 'synthetic-book', offset: 0, limit: 25 }).total, 1);
  assert.throws(() => repository.catalog.importArchiveCatalog(prepared.command, pack(entries, '更改原文')), /同一操作编号/u);
  const changedItems = entries.map(entry => entry.referenceId === 'a' ? { ...entry, notes: '用户后续修订' } : entry);
  const revisionRequest = { sourceId: result.revision.sourceId, expectedCurrentRevisionId: result.revision.id, items: changedItems,
    mappings: entries.map(i => ({ fromReferenceIds: [i.referenceId], toReferenceIds: [i.referenceId] })) };
  const preview = repository.catalog.previewRevision(revisionRequest);
  const changed = repository.catalog.publishRevision({ ...revisionRequest, commandId: randomUUID(), baselineFingerprint: preview.baselineFingerprint, userConfirmed: true });
  const before = databaseRows(filePath);
  assert.deepEqual(repository.catalog.importArchiveCatalog(prepared.command, rawPack), result);
  assert.throws(() => prepare(repository, rawPack, changed.revision.id), /已经导入|随后|覆盖/u);
  assert.deepEqual(databaseRows(filePath), before);
  assert.equal(repository.catalog.history({ bookId: 'synthetic-book', offset: 0, limit: 25 }).currentRevisionId, changed.revision.id);
});

test('archive-import回执和完整绑定通过冷开/只读备份校验，原命令结果与个人资料继续保留', async t => {
  const { repository, filePath } = await fixture(t), entries = archived([item(), item('b')]), rawPack = pack(entries);
  const before = databaseRows(filePath, false), prepared = prepare(repository, rawPack);
  const result = repository.catalog.importArchiveCatalog(prepared.command, rawPack);
  repository.close();
  const cold = createCollectionRepository({ filePath });
  try {
    assert.deepEqual(cold.catalog.revision({ id: result.revision.id }), result);
    assert.deepEqual(cold.catalog.importArchiveCatalog(prepared.command, rawPack), result);
    assert.deepEqual(databaseRows(filePath, false), before);
  } finally { cold.close(); }
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    const version = db.prepare('PRAGMA data_version').get();
    verifyReferenceCatalogDatabase(db); verifyReferenceCatalogZipDatabase(db);
    assert.deepEqual(db.prepare('PRAGMA data_version').get(), version);
    assert.equal(db.prepare("SELECT count(*) n FROM reference_catalog_ledger WHERE kind='archive-import'").get()?.n, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});
