import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCollectionRepository, type CollectionRepository } from '../../src/collection/repository.js';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';
import { openCollectionDataset } from '../../src/recording/restore-dataset-runtime.js';
import { readBackupIndex } from '../../src/recording/backup-index.js';
import { isolateRestoredDatabase, verifyRestoredDatabaseIsolation } from '../../src/recording/restore-database.js';
import { createBackupWorkflowStore } from '../../src/recording/backup-workflow-store.js';
import { createBackupCoordinator } from '../../src/recording/backup-coordinator.js';
import { prepareRestoredDataset } from '../../src/recording/restore-activation-files.js';
import { archiveBackupFixture } from '../helpers/archive-backup-fixture.js';
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';

async function seed(repository: CollectionRepository, directory: string) {
  buildStoragePolicy().check(directory, { mustExist: true });
  const sourcePath = path.join(directory, '本地合成来源'); await mkdir(sourcePath);
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(sourcePath));
  const catalog = repository.localCatalog;
  const root = catalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  const asset = catalog.registerAsset({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: '1', relative: '合成/片段.flac', sha256: 'c'.repeat(64), sampleFrames: '96000', timebaseHz: 48000 });
  const track = catalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: { startFrame: '48000', endFrameExclusive: '96000', timebaseHz: 48000 } });
  const edition = catalog.createEdition({ commandId: randomUUID(), title: '恢复发行版', edition: '合成首版' });
  const link = catalog.linkEditionTrack({ commandId: randomUUID(), editionId: edition.id, trackId: track.id, disc: 1, trackNumber: 2, sequence: 1 });
  const raw = catalog.observeMetadata({ commandId: randomUUID(), trackId: track.id, source: 'synthetic', parserVersion: 'fixture-1', fields: { title: '原始标题', artist: '原始艺人' } });
  const overrideCommand = randomUUID();
  const override = catalog.overrideMetadata({ commandId: overrideCommand, trackId: track.id, expectedRevision: null, fields: { title: '人工标题' } });
  return { source, root, asset, track, edition, link, raw, override, overrideCommand, metadata: catalog.metadata(track.id), receipt: catalog.receipt(overrideCommand) };
}
function retained(repository: CollectionRepository, facts: Awaited<ReturnType<typeof seed>>, revoked: boolean): void {
  const catalog = repository.localCatalog;
  assert.deepEqual(catalog.root(facts.root.id), facts.root); assert.deepEqual(catalog.asset(facts.asset.id), facts.asset);
  assert.deepEqual(catalog.track(facts.track.id), facts.track); assert.deepEqual(catalog.edition(facts.edition.id), facts.edition);
  assert.deepEqual(catalog.editionTracks(facts.edition.id), [facts.link]); assert.deepEqual(catalog.observations(facts.track.id), [facts.raw]);
  assert.deepEqual(catalog.metadata(facts.track.id), facts.metadata); assert.deepEqual(catalog.receipt(facts.overrideCommand), facts.receipt);
  assert.deepEqual(repository.sources.root(facts.source.id), { ...facts.source, authorized: !revoked });
  if (revoked) assert.throws(() => catalog.registerAsset({ commandId: randomUUID(), libraryRootId: facts.root.id, expectedRootRevision: '1', relative: '新文件.flac', sha256: null, sampleFrames: null, timebaseHz: null }), /授权/u);
}
function schema32(file: string): void {
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  try { assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 34); assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok'); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); }
  finally { db.close(); }
}
function localRows(file: string) {
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  try { return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'local_catalog_*' ORDER BY name").all().map(row => [row.name, db.prepare(`SELECT * FROM "${String(row.name)}" ORDER BY rowid`).all()]); }
  finally { db.close(); }
}

test('MBRS002 restore：固定30默认collection.v1.sqlite正式迁移、冷启与隔离快照保留31实体及人工覆盖，撤销原许可', async t => {
  const storage = buildStoragePolicy(), temporary = storage.check(process.env.TMPDIR!, { mustExist: true });
  const directory = await mkdtemp(path.join(temporary, 'musicbridge-local-restore-default-')); storage.check(directory, { mustExist: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'collection.v1.sqlite');
  await writeFile(file, await readFile(new URL('./fixtures/schema30-synthetic.sqlite', import.meta.url)), { flag: 'wx', mode: 0o600 });
  const opened = await openCollectionDataset(directory), datasetId = opened.datasetId;
  let facts: Awaited<ReturnType<typeof seed>>;
  try { assert.equal(opened.databaseFile, file); facts = await seed(opened.repository, directory); }
  finally { opened.close(); }
  schema32(file);
  const expectedRows = localRows(file);
  const cold = await openCollectionDataset(directory);
  const snapshotPath = path.join(directory, '隔离快照'); await mkdir(snapshotPath);
  try {
    assert.equal(cold.datasetId, datasetId); retained(cold.repository, facts, false);
    const snapshot = await cold.repository.backupSnapshot({ ...await authorizeSourceDirectory(snapshotPath), id: randomUUID() });
    assert.equal(snapshot.schemaVersion, 34); assert.equal(snapshot.relative, 'collection.sqlite');
  } finally { cold.close(); }
  const restoredFile = path.join(snapshotPath, 'collection.sqlite');
  schema32(restoredFile); readBackupIndex(restoredFile); isolateRestoredDatabase(restoredFile);
  verifyRestoredDatabaseIsolation(restoredFile); readBackupIndex(restoredFile);
  assert.deepEqual(localRows(restoredFile), expectedRows);
  for (let pass = 0; pass < 2; pass++) {
    const restored = createCollectionRepository({ filePath: restoredFile });
    try { retained(restored, facts, true); }
    finally { restored.close(); }
  }
  const final = await openCollectionDataset(directory);
  try { assert.equal(final.datasetId, datasetId); retained(final.repository, facts, false); }
  finally { final.close(); }
  assert.deepEqual(localRows(file), expectedRows); assert.deepEqual(localRows(restoredFile), expectedRows);
});

test('MBRS002 restore：实际备份→核验→隔离恢复→激活collection.sqlite→冷启保留31数据及覆盖，原来源许可不复活', async t => {
  const f = await archiveBackupFixture(t), facts = await seed(f.repository, f.directory);
  const expectedRows = localRows(f.filePath);
  const backup = await f.api.createArchiveBackup(f.backupRequest);
  const privatePath = path.join(f.directory, '应用私有目录'), restorePath = path.join(f.directory, '隔离恢复');
  await mkdir(privatePath); await mkdir(restorePath);
  const privateRoot = { ...await authorizeSourceDirectory(privatePath), id: randomUUID() };
  const defaultFile = path.join(privatePath, 'collection.v1.sqlite'), initial = createCollectionRepository({ filePath: defaultFile });
  try { initial.list({ offset: 0, limit: 1 }); } finally { initial.close(); }
  const defaultBytes = await readFile(defaultFile), storePath = path.join(privatePath, 'backup-maintenance.v1.sqlite');
  const store = createBackupWorkflowStore({ filePath: storePath }), coordinator = createBackupCoordinator({ store, repository: f.repository, privateRoot });
  let restored: NonNullable<ReturnType<typeof store.job>['output']>, restoreJobId: string;
  try {
    const source = await coordinator.authorize({ commandId: randomUUID(), kind: 'backup-source', absolutePath: backup.directory.path });
    const destination = await coordinator.authorize({ commandId: randomUUID(), kind: 'restore-destination', absolutePath: restorePath });
    const verification = coordinator.start({ commandId: randomUUID(), kind: 'verify', rootId: source.id, userConfirmed: true });
    await coordinator.idle(); assert.equal(store.job(verification.id).view.state, 'succeeded');
    const restore = coordinator.start({ commandId: randomUUID(), kind: 'restore', rootId: source.id, destinationId: destination.id, verificationId: verification.id, userConfirmed: true });
    await coordinator.idle(); assert.equal(store.job(restore.id).view.state, 'succeeded'); restoreJobId = restore.id; restored = store.job(restore.id).output!;
  } finally { await coordinator.close(); }
  const datasetsPath = path.join(privatePath, 'restored-datasets'); await mkdir(datasetsPath);
  const datasets = { ...await authorizeSourceDirectory(datasetsPath), id: randomUUID() }, maintenance = createBackupWorkflowStore({ filePath: storePath });
  let pendingId: string;
  try {
    const pending = maintenance.activations.begin({ commandId: randomUUID(), restoreJobId, expectedActiveId: null, userConfirmed: true, stopPlaybackConfirmed: true });
    pendingId = pending.view.id;
    const prepared = await prepareRestoredDataset({ id: pendingId, source: restored, destination: datasets, userConfirmed: true, signal: new AbortController().signal });
    maintenance.activations.prepared(pendingId, prepared);
  } finally { maintenance.close(); }
  const active = await openCollectionDataset(privatePath); let activeFile: string, activeDatasetId: string;
  try {
    assert.equal(active.pendingActivationId, pendingId); assert.notEqual(active.datasetId, pendingId);
    activeDatasetId = active.datasetId; activeFile = active.databaseFile;
    assert.equal(path.basename(activeFile), 'collection.sqlite'); assert.notEqual(activeFile, defaultFile);
    retained(active.repository, facts, true); active.commit();
  } finally { active.close(); }
  schema32(activeFile); verifyRestoredDatabaseIsolation(activeFile); readBackupIndex(activeFile);
  assert.deepEqual(localRows(activeFile), expectedRows);
  const cold = await openCollectionDataset(privatePath);
  try {
    assert.equal(cold.datasetId, activeDatasetId); assert.equal(cold.pendingActivationId, undefined); assert.equal(cold.databaseFile, activeFile); retained(cold.repository, facts, true);
    const updated = cold.repository.localCatalog.overrideMetadata({ commandId: randomUUID(), trackId: facts.track.id, expectedRevision: '1', fields: { title: '激活后人工标题' } });
    assert.equal(updated.revision, '2'); assert.deepEqual(cold.repository.localCatalog.observations(facts.track.id), [facts.raw]);
  } finally { cold.close(); }
  const again = await openCollectionDataset(privatePath);
  try { assert.equal(again.repository.localCatalog.metadata(facts.track.id).effective.title, '激活后人工标题'); assert.equal(again.repository.sources.root(facts.source.id).authorized, false); }
  finally { again.close(); }
  assert.deepEqual(await readFile(defaultFile), defaultBytes); retained(f.repository, facts, false);
});

test('MBRS002 restore：未来schema拒绝备份索引、隔离写入及默认工作库选择，保留原字节', async t => {
  const storage = buildStoragePolicy(), temporary = storage.check(process.env.TMPDIR!, { mustExist: true });
  const directory = await mkdtemp(path.join(temporary, 'musicbridge-local-restore-future-')); storage.check(directory, { mustExist: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'collection.v1.sqlite'), repository = createCollectionRepository({ filePath: file });
  repository.list({ offset: 0, limit: 1 }); repository.close();
  const db = new DatabaseSync(file); try { db.exec('PRAGMA user_version=35'); } finally { db.close(); }
  const bytes = await readFile(file);
  assert.throws(() => readBackupIndex(file)); assert.throws(() => isolateRestoredDatabase(file)); assert.throws(() => verifyRestoredDatabaseIsolation(file));
  await assert.rejects(openCollectionDataset(directory)); assert.deepEqual(await readFile(file), bytes);
});
