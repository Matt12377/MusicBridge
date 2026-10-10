/** 外置隔离资料库的实际档案门禁；不接受生产 profile，也不直接写 SQLite。 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { parseReferenceSourcePack, type CanonicalReference } from '../packages/contracts/src/index.js';
import { prepareCassetteArchive, loadCassetteArchive, getCassetteArchiveRecord, getCassetteArchiveAsset } from '../packages/bridge-core/src/collection/cassette-archive.js';
import { createCollectionRepository } from '../packages/bridge-core/src/collection/repository.js';
import { openCollectionDataset } from '../packages/bridge-core/src/recording/restore-dataset-runtime.js';
import { dispatchDatasetCommand, type DatasetDispatchTarget } from '../packages/bridge-core/src/collection/dataset-dispatch.js';
import { projectCassetteReference, createCassetteCatalogService } from '../apps/desktop/src/main/cassette-catalog-service.js';

const [archivePath, profile, evidence] = process.argv.slice(2);
if (!archivePath || !profile || !evidence || !profile.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-tape-r3-')
  || !/^musicbridge-ui-e2e-tape-r3[A-Za-z0-9._-]*$/u.test(path.basename(profile)) || !evidence.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-tape-r3-'))
  throw new Error('门禁必须明确使用外置任务的隔离 profile 和证据目录。');
assert.equal(process.versions.node.split('.')[0], '22');
await mkdir(profile, { recursive: true, mode: 0o700 });
await mkdir(evidence, { recursive: true, mode: 0o700 });
const directory = path.join(profile, 'data');
await mkdir(directory, { recursive: true, mode: 0o700 });
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const archiveRoot = path.join(directory, 'reference-archives');
const began = performance.now();
console.log('开始流式校验并归档实际完整 ZIP。');
const archive = await prepareCassetteArchive({ archivePath, archiveRoot });
const pack = parseReferenceSourcePack(archive.rawPack)!;
assert.ok(pack);
assert.equal(pack.items.length, 634);
assert.equal(new Set(pack.items.map(item => item.referenceId)).size, 634);
assert.equal(archive.summary.primaryCount, 618);
assert.equal(archive.summary.missingPrimaryCount, 16);
assert.equal(archive.summary.assetCount, 1744);
const preparationMs = performance.now() - began;
console.log('完整档案已归档，开始隔离资料库事务与守恒验证。');
let dataset = await openCollectionDataset(directory), repository = dataset.repository;
assert.equal(repository.catalog.sources({ offset: 0, limit: 25 }).total, 0, '只在新隔离库执行种子与故障注入');
const id = dataset.datasetId, first = pack.items[0]!;
const received = repository.receive({ commandId: randomUUID(), model: {
  brand: first.brand, name: first.model, edition: '', year: null, format: 'cassette', tapeType: first.iec, identification: 'unidentified',
}, lengthMinutes: null, quantities: { sealedBlank: 0, openedBlank: 0, legacyUsed: 0, unclassified: 2 } });
const legacyItems: CanonicalReference[] = pack.items.slice(0, 3).map(({ archive: _archive, ...item }) => item);
const oldRaw = JSON.stringify({ schemaVersion: 1, bookId: pack.bookId, title: '合成既有资料目录，供守恒验证', sourceVersion: 'synthetic-legacy', items: legacyItems });
const oldSource = repository.catalog.registerSource({ commandId: randomUUID(), rawPack: oldRaw, packHash: sha(oldRaw), userConfirmed: true });
const draft = { sourceId: oldSource.id, expectedCurrentRevisionId: null, items: legacyItems, mappings: [] };
const oldPreview = repository.catalog.previewRevision(draft);
let oldDetail = repository.catalog.publishRevision({ ...draft, commandId: randomUUID(), baselineFingerprint: oldPreview.baselineFingerprint, userConfirmed: true });
oldDetail = repository.catalog.setMatch({ commandId: randomUUID(), revisionId: oldDetail.revision.id, expectedMatchVersion: oldDetail.matchVersion,
  match: { referenceId: first.referenceId, modelId: received.modelId, status: 'candidate', availability: 'unknown' }, userConfirmed: true });
function rows(includeReferences: boolean): Record<string, string> {
  const db = new DatabaseSync(dataset.databaseFile, { readOnly: true });
  try {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => String(row.name));
    return Object.fromEntries(names.filter(name => includeReferences || !name.startsWith('reference_')).map(name =>
      [name, sha(JSON.stringify(db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()))]));
  } finally { db.close(); }
}
const inventoryBefore = rows(false), allBefore = rows(true), priorMatches = oldDetail.matches;
const oldHead = oldDetail.revision.id;
const backupDb = new DatabaseSync(dataset.databaseFile, { readOnly: true });
const backupFile = path.join(evidence, 'isolated-before-import.sqlite');
try { await backup(backupDb, backupFile); } finally { backupDb.close(); }
dataset.close();
let rejectCommit = true;
repository = createCollectionRepository({ filePath: path.join(directory, 'collection.v1.sqlite'), referenceArchiveRoot: archiveRoot,
  beforeCommit: action => { if (rejectCommit && action === 'import-reference-archive-catalog') throw new Error('合成提交故障'); } });
const runtime = { collection: repository, commandOutbox: { context: () => ({ datasetId: id }) } } as DatasetDispatchTarget;
const previewRequest = { archiveSha256: archive.summary.sha256, expectedDatasetId: id, expectedCurrentRevisionId: oldHead };
const preview = repository.catalog.previewArchiveCatalog(previewRequest, archive.rawPack);
const request = { ...previewRequest, commandId: randomUUID(), baselineFingerprint: preview.baselineFingerprint, userConfirmed: true as const };
await assert.rejects(dispatchDatasetCommand(runtime, { version: 1, id: randomUUID(), command: 'referenceCatalog.importArchive', payload: request }));
assert.deepEqual(rows(true), allBefore);
rejectCommit = false;
const imported = await dispatchDatasetCommand(runtime, { version: 1, id: randomUUID(), command: 'referenceCatalog.importArchive', payload: request }) as ReturnType<typeof repository.catalog.importArchiveCatalog>;
assert.equal(imported.revision.items.length, 634);
assert.equal(imported.revision.mappings.length, 3);
const byReference = <T extends { referenceId: string }>(values: readonly T[]) => [...values].sort((a, b) => a.referenceId.localeCompare(b.referenceId));
assert.deepEqual(byReference(imported.matches.filter(match => priorMatches.some(old => old.referenceId === match.referenceId))), byReference(priorMatches));
assert.deepEqual(rows(false), inventoryBefore);
assert.equal(repository.list({ offset: 0, limit: 100 }).total, 1);
assert.equal(imported.currentCounts.owned, 0, '候选匹配不能确认拥有');
assert.equal(imported.currentCounts.missing, 0, '缺图/未匹配不能推断缺失或需要购买');
const stableRevisionCount = repository.catalog.history({ bookId: pack.bookId, offset: 0, limit: 25 }).total;
assert.equal(repository.catalog.importArchiveCatalog(request, archive.rawPack).revision.id, imported.revision.id);
const repeatedRequest = { archiveSha256: archive.summary.sha256, expectedDatasetId: id, expectedCurrentRevisionId: imported.revision.id };
const repeatedPreview = repository.catalog.previewArchiveCatalog(repeatedRequest, archive.rawPack);
assert.equal(repository.catalog.importArchiveCatalog({ ...repeatedRequest, commandId: randomUUID(), baselineFingerprint: repeatedPreview.baselineFingerprint, userConfirmed: true }, archive.rawPack).revision.id, imported.revision.id);
assert.equal(repository.catalog.history({ bookId: pack.bookId, offset: 0, limit: 25 }).total, stableRevisionCount);
const manifestBefore = await stat(path.join(archive.directory, 'manifest.json'), { bigint: true });
const repeatedArchive = await prepareCassetteArchive({ archivePath, archiveRoot });
assert.equal(repeatedArchive.directory, archive.directory);
const manifestAfter = await stat(path.join(repeatedArchive.directory, 'manifest.json'), { bigint: true });
assert.equal(manifestBefore.ino, manifestAfter.ino);
assert.equal(manifestBefore.mtimeNs, manifestAfter.mtimeNs);
assert.deepEqual(rows(false), inventoryBefore);
let transcriptionAssociations = 0, transcriptions = 0, untranslatedAssociations = 0;
for (const item of pack.items) {
  const record = await getCassetteArchiveRecord(archive, item.referenceId);
  const sourceInfo = record.r3_information as { source_transcriptions: { transcription_zh: string | null }[] };
  const detail = await projectCassetteReference(archive, item.referenceId);
  for (const transcription of sourceInfo.source_transcriptions) {
    transcriptionAssociations++;
    if (transcription.transcription_zh === null) {
      assert.ok(detail.sections.some(section => section.text === '此原书区域尚未提供中文转录，原始页码与区域信息已保留。'));
      untranslatedAssociations++;
    } else {
      assert.ok(detail.sections.some(section => section.text === transcription.transcription_zh), `${item.referenceId} 正文保持完整`);
      transcriptions++;
    }
  }
  const correction = (record.r3_information as { availability_correction?: unknown }).availability_correction;
  if (correction !== undefined && correction !== null) {
    assert.ok(detail.sections.some(section => section.title === 'r3 资料纠正' && section.text === JSON.stringify(correction, null, 2)));
  }
  for (const asset of detail.assets.filter(asset => asset.origin === 'book')) {
    assert.ok(asset.id.endsWith(':original'), '详情读取原书原图；封面墙继续使用小图');
  }
}
const withPhoto = pack.items.find(item => archive.index.references[item.referenceId]!.realPhotoIds.length)!;
const photoDetail = await projectCassetteReference(archive, withPhoto.referenceId);
assert.ok(photoDetail.assets.some(asset => asset.origin === 'real-photo-reference'));
const imageService = createCassetteCatalogService({ dataDirectory: () => directory, chooseArchive: async () => null,
  request: async () => { throw new Error('图片读取不需要Core写入'); } });
for (const origin of ['book', 'real-photo-reference', 'opaque-display'] as const) {
  const asset = photoDetail.assets.find(asset => asset.origin === origin);
  if (!asset) continue;
  const response = await imageService.image(asset.url, 'GET');
  assert.equal(response.status, 200);
  assert.ok((await response.arrayBuffer()).byteLength > 0);
}
assert.equal((await getCassetteArchiveAsset(archive, first.archive!.primaryAssetId!)).contentType, 'image/png');
repository.close();
dataset = await openCollectionDataset(directory); repository = dataset.repository;
assert.equal(dataset.datasetId, id);
const cold = repository.catalog.revision({ id: imported.revision.id });
assert.equal(cold.revision.items.length, 634);
assert.deepEqual(cold.matches, imported.matches);
assert.deepEqual(rows(false), inventoryBefore);
const loaded = await loadCassetteArchive(archiveRoot, archive.summary.sha256);
assert.equal(loaded.summary.sha256, archive.summary.sha256);
let scopeReads = 0;
const switchingRuntime = { collection: repository, commandOutbox: { context: () => ({ datasetId: scopeReads++ === 0 ? id : randomUUID() }) } } as DatasetDispatchTarget;
await assert.rejects(dispatchDatasetCommand(switchingRuntime, { version: 1, id: randomUUID(), command: 'referenceCatalog.previewArchive',
  payload: { ...repeatedRequest, expectedCurrentRevisionId: imported.revision.id } }), /校验期间资料库已切换/u);
assert.deepEqual(rows(false), inventoryBefore);
const result = {
  taskId: 'TAPE-CATALOG-R3', node: process.versions.node, baseSha: 'c0b945a2b8d0f6f3ee2d9ea9d2cb50a787dc7f95',
  evidenceKind: '实际来源档案、隔离资料库、合成既有库存；不是生产导入或Owner验收',
  profile, datasetId: id, archive: archive.summary, logicalImageCount: Object.keys(archive.index.assets).length,
  importedReferenceCount: cold.revision.items.length, syntheticInventoryModelsBefore: 1, syntheticInventoryModelsAfter: 1,
  syntheticInventoryUnitsBefore: 2, syntheticInventoryUnitsAfter: 2, preservedMatchCount: priorMatches.length,
  transcriptionAssociationCount: transcriptionAssociations, nonNullTranscriptionAssociationCount: transcriptions, untranslatedAssociationCount: untranslatedAssociations,
  preservedNonReferenceTables: Object.keys(inventoryBefore).length,
  failureRollback: true, repeatedImportSameRevision: true, repeatedArchiveSameInode: true, restartPersisted: true,
  datasetSwitchDuringValidationRejected: true,
  revisionId: imported.revision.id, sourceId: imported.revision.sourceId, preparationMs, elapsedMs: performance.now() - began,
  beforeBackupSha256: sha(await readFile(backupFile)), carryover: ['生产profile导入待协调时点', 'CI未执行', 'Owner成品试用未执行'],
};
await writeFile(path.join(evidence, 'actual-import.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
await writeFile(path.join(evidence, 'inventory-before.json'), JSON.stringify(inventoryBefore, null, 2) + '\n');
await writeFile(path.join(evidence, 'inventory-after.json'), JSON.stringify(rows(false), null, 2) + '\n');
dataset.close();
console.log(JSON.stringify(result, null, 2));
