import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import test from 'node:test';
import { buildStoragePolicy } from '../../../apps/desktop/scripts/build-storage-root.mjs';
import { createCollectionRepository } from '../src/collection/repository.js';
import { verifyReferenceCatalogDatabase, verifyReferenceCatalogZipDatabase } from '../src/collection/reference-catalog-store.js';
import { isCatalogRevisionDetail, isCatalogRevisionPreview, type CanonicalReference, type CatalogMatch, type ImportReferenceArchiveCatalogRequest } from '@music-bridge/contracts';

const page = { offset: 0, limit: 25 };
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
  const storage = buildStoragePolicy();
  const temporaryRoot = storage.check(process.env.TMPDIR ?? '', { mustExist: true });
  const directory = await mkdtemp(path.join(temporaryRoot, 'musicbridge-archive-catalog-'));
  storage.check(directory, { mustExist: true });
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

test('656旧编号和634新编号零交集，旧库存关联/愿望/进度与个人数据保留，新资料不推断拥有', async t => {
  const { repository, filePath, modelId } = await fixture(t);
  const oldItems = Array.from({ length: 656 }, (_, n) => item(`old-${n}`));
  const first = publish(repository, oldItems);
  set(repository, first.revision.id, { referenceId: 'old-0', modelId, status: 'confirmed', availability: 'unknown' });
  set(repository, first.revision.id, { referenceId: 'old-1', modelId, status: 'candidate', availability: 'unknown' });
  set(repository, first.revision.id, { referenceId: 'old-2', modelId, status: 'needs-review', availability: 'unknown' });
  const prior = set(repository, first.revision.id, { referenceId: 'old-3', modelId: null, status: 'unmatched', availability: 'missing' });
  const want = repository.collectionProgress.saveWant({ commandId: randomUUID(), id: null, expectedVersion: 0,
    revisionId: first.revision.id, referenceId: 'old-0', priority: 'normal', preferredCondition: '良好', notes: '旧版目标保留',
    targetLengthMinutes: 60, packagingTarget: '未拆封', priceTarget: null, userConfirmed: true });
  const progress = repository.collectionProgress.current({ revisionId: first.revision.id, page });
  const captured = repository.collectionProgress.capture({ commandId: randomUUID(), revisionId: first.revision.id,
    expectedFingerprint: progress.fingerprint, userConfirmed: true });
  const historicProgress = repository.collectionProgress.snapshot({ id: captured.id, page });
  const personal = databaseRows(filePath, false), allBefore = databaseRows(filePath);
  const rawPack = pack(archived(Array.from({ length: 634 }, (_, n) => item(`r3-${n}`))));
  const planned = prepare(repository, rawPack, first.revision.id);
  assert.equal(isCatalogRevisionPreview(planned.preview), true);
  assert.deepEqual(databaseRows(filePath), allBefore, '历史保留预览只读');
  assert.deepEqual(planned.preview.delta.removedReferenceIds, oldItems.map(i => i.referenceId));
  assert.deepEqual(planned.preview.delta.preservedHistory?.referenceIds, planned.preview.delta.removedReferenceIds);
  assert.equal(planned.preview.delta.preservedHistory?.revisionId, first.revision.id);
  assert.equal(planned.preview.delta.preservedHistory?.snapshotId, prior.snapshot.id);
  assert.equal(planned.preview.delta.preservedHistory?.matchVersion, prior.matchVersion);
  assert.match(planned.preview.delta.preservedHistory!.fingerprint, /^[0-9a-f]{64}$/u);
  const result = repository.catalog.importArchiveCatalog(planned.command, rawPack);
  assert.equal(result.revision.items.length, 634); assert.equal(result.revision.previousRevisionId, first.revision.id);
  assert.equal(result.currentCounts.total, 634); assert.equal(result.currentCounts.owned, 0);
  assert.equal(result.currentCounts.unknown, 634); assert.equal(result.revision.mappings.length, 0);
  assert.deepEqual(repository.catalog.revision({ id: first.revision.id }).revision, prior.revision);
  assert.deepEqual(repository.catalog.revision({ id: first.revision.id }).matches, prior.matches);
  assert.deepEqual(repository.catalog.source({ id: first.revision.sourceId }).rawPack, pack(oldItems, '旧版'));
  assert.deepEqual(repository.catalog.snapshot({ id: prior.snapshot.id }), prior.snapshot);
  assert.deepEqual(repository.collectionProgress.snapshot({ id: captured.id, page }), historicProgress);
  assert.equal(repository.collectionProgress.wants({ page }).items[0]?.entry.id, want.id);
  assert.equal(repository.collectionProgress.wants({ page }).items[0]?.needsReview, true);
  assert.equal(repository.collectionProgress.current({ revisionId: result.revision.id, page }).historicalWantedCount, 1);
  assert.deepEqual(databaseRows(filePath, false), personal);
  for (const table of allBefore.filter(row => ['reference_sources', 'reference_catalog_revisions', 'reference_catalog_matches', 'reference_catalog_snapshots'].includes(row.name))) {
    const after = databaseRows(filePath).find(row => row.name === table.name)!;
    for (const row of table.rows) assert.ok(after.rows.some(candidate => JSON.stringify(candidate) === JSON.stringify(row)), `${table.name} 原行保留`);
  }
  const originalSnapshots = allBefore.find(row => row.name === 'reference_catalog_snapshots')!.rows;
  const importedSnapshots = databaseRows(filePath).find(row => row.name === 'reference_catalog_snapshots')!.rows;
  assert.equal(originalSnapshots.length, 5);
  assert.equal(importedSnapshots.length, originalSnapshots.length + 2);
  assert.equal(importedSnapshots.filter(row => row.revision_id === first.revision.id).length, 6);
  assert.equal(importedSnapshots.filter(row => row.revision_id === result.revision.id).length, 1);
  assert.throws(() => set(repository, first.revision.id, { referenceId: 'old-4', modelId, status: 'candidate', availability: 'unknown' }), /历史目录/u);
  const after = databaseRows(filePath);
  assert.deepEqual(repository.catalog.importArchiveCatalog(planned.command, rawPack), result);
  const repeat = prepare(repository, rawPack, result.revision.id);
  assert.deepEqual(repository.catalog.importArchiveCatalog(repeat.command, rawPack).revision, result.revision);
  const afterRepeat = databaseRows(filePath);
  assert.deepEqual(afterRepeat.filter(row => row.name !== 'reference_catalog_ledger'), after.filter(row => row.name !== 'reference_catalog_ledger'));

  const destination = path.join(path.dirname(filePath), 'restored.sqlite'), db = new DatabaseSync(filePath, { readOnly: true });
  try { verifyReferenceCatalogDatabase(db); verifyReferenceCatalogZipDatabase(db); await backup(db, destination); } finally { db.close(); }
  const restored = createCollectionRepository({ filePath: destination });
  try {
    assert.deepEqual(restored.catalog.revision({ id: first.revision.id }).matches, prior.matches);
    assert.deepEqual(restored.catalog.revision({ id: result.revision.id }).revision, result.revision);
    assert.deepEqual(restored.collectionProgress.snapshot({ id: captured.id, page }), historicProgress);
  } finally { restored.close(); }
});

test('部分交集仅沿用相同编号，退出当前版的关联保留在原修订而不自动迁移', async t => {
  const { repository, modelId } = await fixture(t), first = publish(repository, [item('a'), item('b'), item('c')]);
  const prior = set(repository, first.revision.id, { referenceId: 'a', modelId, status: 'confirmed', availability: 'unknown' });
  set(repository, first.revision.id, { referenceId: 'b', modelId: null, status: 'unmatched', availability: 'missing' });
  const rawPack = pack(archived([item('b', { notes: '新版资料' }), item('new')]));
  const planned = prepare(repository, rawPack, first.revision.id);
  assert.deepEqual(planned.preview.delta.preservedHistory?.referenceIds, ['a', 'c']);
  assert.deepEqual(planned.preview.delta.updatedReferenceIds, ['b']);
  const result = repository.catalog.importArchiveCatalog(planned.command, rawPack);
  assert.deepEqual(result.revision.mappings, [{ fromReferenceIds: ['b'], toReferenceIds: ['b'] }]);
  assert.equal(result.matches.find(m => m.referenceId === 'b')?.availability, 'missing');
  assert.equal(result.matches.find(m => m.referenceId === 'new')?.modelId, null);
  assert.equal(repository.catalog.revision({ id: first.revision.id }).matches.find(m => m.referenceId === 'a')?.modelId, modelId);
  assert.deepEqual(repository.catalog.snapshot({ id: prior.snapshot.id }), prior.snapshot);
});

test('退出编号再次出现时核对其最近历史身份，不回填更早历史或绕过身份保护', async t => {
  const { repository, filePath } = await fixture(t);
  const a = publish(repository, [item('old-a', { model: '更早身份A' })]);
  const b = publish(repository, [item('old-a', { model: '最近身份B' })], a.revision.id);
  const rawPack = pack(archived([item('r3-new')]));
  const current = repository.catalog.importArchiveCatalog(prepare(repository, rawPack, b.revision.id).command, rawPack);
  const nextHash = hash('后续合成档案'), before = databaseRows(filePath);
  for (const model of ['更早身份A', '不相关身份C']) {
    const rejected = pack(archived([item('old-a', { model })], nextHash));
    assert.throws(() => prepare(repository, rejected, current.revision.id, nextHash), /身份/u);
    assert.deepEqual(databaseRows(filePath), before);
  }
  const accepted = pack(archived([item('old-a', { model: '最近身份B' })], nextHash));
  const planned = prepare(repository, accepted, current.revision.id, nextHash);
  const result = repository.catalog.importArchiveCatalog(planned.command, accepted);
  assert.equal(result.revision.items[0]?.model, '最近身份B');
  assert.equal(repository.catalog.revision({ id: a.revision.id }).revision.items[0]?.model, '更早身份A');
  assert.equal(repository.catalog.revision({ id: b.revision.id }).revision.items[0]?.model, '最近身份B');
});

test('暖开库在预览后缺失旧快照时拒绝无证明导入，所有表相对故障注入后保持原值', async t => {
  const { repository, filePath } = await fixture(t), first = publish(repository, [item('old-a')]);
  const rawPack = pack(archived([item('r3-new')])), planned = prepare(repository, rawPack, first.revision.id);
  const db = new DatabaseSync(filePath);
  try {
    const sql = String(db.prepare("SELECT sql FROM sqlite_master WHERE name='reference_catalog_snapshots_no_delete'").get()!.sql);
    db.exec('DROP TRIGGER reference_catalog_snapshots_no_delete');
    db.prepare('DELETE FROM reference_catalog_snapshots WHERE revision_id=?').run(first.revision.id);
    db.exec(sql);
  } finally { db.close(); }
  const before = databaseRows(filePath);
  assert.throws(() => repository.catalog.importArchiveCatalog(planned.command, rawPack), /保留|快照|损坏/u);
  assert.deepEqual(databaseRows(filePath), before);
});

test('合法形状但匹配事实错误的旧快照不能作为历史保留证明', async t => {
  const { repository, filePath } = await fixture(t), first = publish(repository, [item('old-a')]);
  const rawPack = pack(archived([item('r3-new')]));
  const db = new DatabaseSync(filePath);
  try {
    const value = { ...first.snapshot, id: randomUUID(), counts: { ...first.snapshot.counts, missing: 1, unknown: 0 },
      entries: [{ referenceId: 'old-a', state: 'missing', stockCount: 0, matches: [{ referenceId: 'old-a', modelId: null, status: 'unmatched', availability: 'missing' }] }] };
    db.prepare('INSERT INTO reference_catalog_snapshots VALUES(?,?,?,?)').run(value.id, first.revision.id, 0, JSON.stringify(value));
  } finally { db.close(); }
  const before = databaseRows(filePath);
  assert.throws(() => prepare(repository, rawPack, first.revision.id), /保留|快照|损坏/u);
  assert.deepEqual(databaseRows(filePath), before);
});

test('旧库存合法变化允许新预览，预览后的库存变化使历史保留指纹失效', async t => {
  const { repository, filePath, modelId } = await fixture(t), first = publish(repository, [item('old-a')]);
  set(repository, first.revision.id, { referenceId: 'old-a', modelId, status: 'confirmed', availability: 'unknown' });
  const increase = () => repository.receive({ commandId: randomUUID(), model: { brand: '合成品牌', name: '固定旧库型号', edition: '1990', year: 1990,
    format: 'cassette', tapeType: 'II', identification: 'verified' }, lengthMinutes: 90,
    quantities: { sealedBlank: 1, openedBlank: 0, legacyUsed: 0, unclassified: 0 } });
  increase();
  const rawPack = pack(archived([item('r3-new')])), planned = prepare(repository, rawPack, first.revision.id);
  increase(); const before = databaseRows(filePath);
  assert.throws(() => repository.catalog.importArchiveCatalog(planned.command, rawPack), /基线|预览/u);
  assert.deepEqual(databaseRows(filePath), before);
  const fresh = prepare(repository, rawPack, first.revision.id);
  assert.equal(repository.catalog.importArchiveCatalog(fresh.command, rawPack).currentCounts.total, 1);
});

for (const fault of ['循环', '错误顺序', '缺根', '跨书'] as const) {
  test(`暖开目录注入${fault}修订链后停止导入，不能仅凭旧编号存在而放行`, async t => {
    const { repository, filePath } = await fixture(t), first = publish(repository, [item('old-a')]);
    const latest = publish(repository, [item('old-a', { notes: '合法第二版说明' })], first.revision.id);
    const rawPack = pack(archived([item('r3-new')])), planned = prepare(repository, rawPack, latest.revision.id);
    let foreignId: string | null = null;
    if (fault === '跨书') {
      const foreign = item('foreign', { bookId: 'other-book' });
      const text = JSON.stringify({ schemaVersion: 1, bookId: foreign.bookId, title: '其他合成资料', sourceVersion: '1', items: [foreign] });
      const source = repository.catalog.registerSource({ commandId: randomUUID(), rawPack: text, packHash: hash(text), userConfirmed: true });
      const request = { sourceId: source.id, expectedCurrentRevisionId: null, items: [foreign], mappings: [] };
      const preview = repository.catalog.previewRevision(request);
      foreignId = repository.catalog.publishRevision({ ...request, commandId: randomUUID(), baselineFingerprint: preview.baselineFingerprint, userConfirmed: true }).revision.id;
    }
    const value = { ...latest.revision, previousRevisionId: fault === '循环' ? latest.revision.id : fault === '缺根' ? null : fault === '跨书' ? foreignId : first.revision.id,
      sequence: fault === '错误顺序' ? 4 : latest.revision.sequence };
    const db = new DatabaseSync(filePath);
    try {
      const trigger = String(db.prepare("SELECT sql FROM sqlite_master WHERE name='reference_catalog_revisions_no_update'").get()!.sql);
      db.exec('DROP TRIGGER reference_catalog_revisions_no_update');
      db.prepare('UPDATE reference_catalog_revisions SET previous_id=?,sequence=?,data=? WHERE id=?').run(value.previousRevisionId, value.sequence, JSON.stringify(value), latest.revision.id);
      db.exec(trigger);
    } finally { db.close(); }
    const before = databaseRows(filePath);
    assert.throws(() => repository.catalog.importArchiveCatalog(planned.command, rawPack), /修订链|顺序|版次|损坏/u);
    assert.deepEqual(databaseRows(filePath), before);
  });
}
