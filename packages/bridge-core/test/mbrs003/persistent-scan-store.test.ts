import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';
import type { ScanPreparedBatch } from '../../src/collection/local-scan-store.js';
import { DatabaseSync } from 'node:sqlite';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { readBackupIndex } from '../../src/recording/backup-index.js';
import { isolateRestoredDatabase, verifyRestoredDatabaseIsolation } from '../../src/recording/restore-database.js';
import { openCollectionDataset } from '../../src/recording/restore-dataset-runtime.js';
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';

async function copy31(t: { after(fn: () => Promise<unknown>): void }) {
  const storage = buildStoragePolicy(), temporary = storage.check(process.env.TMPDIR!, { mustExist: true });
  const directory = await mkdtemp(path.join(temporary, 'musicbridge-scan-store-')); storage.check(directory, { mustExist: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'collection.v1.sqlite');
  await writeFile(file, await readFile(new URL('./fixtures/schema31-nonempty-local.sqlite', import.meta.url)), { flag: 'wx', mode: 0o600 });
  return { directory, file };
}
function inspect(file: string) {
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  try {
    const version = db.prepare('PRAGMA user_version').get()?.user_version;
    const tables = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    return { version, tables, rows: tables.map(row => [row.name, db.prepare(`SELECT * FROM "${String(row.name)}" ORDER BY rowid`).all()]) };
  } finally { db.close(); }
}

test('MBRS003 store：固定31迁移beforeCommit故障完整回滚DDL与全部旧行，重开真实升级32', async t => {
  const f = await copy31(t), before = inspect(f.file); let faults = 0;
  const failed = createCollectionRepository({ filePath: f.file, beforeCommit(action) { if (action === 'migrate-local-scan') { faults++; throw new Error('合成迁移提交故障'); } } });
  try { assert.throws(() => failed.list({ offset: 0, limit: 1 }), /不可用/u); } finally { failed.close(); }
  assert.equal(faults, 1); assert.deepEqual(inspect(f.file), before);
  const repository = createCollectionRepository({ filePath: f.file });
  try { assert.ok(repository.list({ offset: 0, limit: 1 }).items.length > 0); } finally { repository.close(); }
  const after = inspect(f.file); assert.equal(after.version, 32);
  assert.equal(after.tables.filter(row => String(row.name).startsWith('local_scan_')).length, 5);
  assert.deepEqual(after.rows.filter(([name]) => !String(name).startsWith('local_scan_')), before.rows);
});

test('MBRS003 store：32隔离备份与恢复默认库保留目录旧行和raw人工事实，撤来源许可', async t => {
  const f = await copy31(t), repository = createCollectionRepository({ filePath: f.file });
  try { repository.list({ offset: 0, limit: 1 }); } finally { repository.close(); }
  const before = inspect(f.file); readBackupIndex(f.file);
  const restoreDirectory = path.join(f.directory, 'restore'); await mkdir(restoreDirectory);
  const restoreFile = path.join(restoreDirectory, 'collection.v1.sqlite');
  await writeFile(restoreFile, await readFile(f.file), { flag: 'wx', mode: 0o600 });
  isolateRestoredDatabase(restoreFile); verifyRestoredDatabaseIsolation(restoreFile); readBackupIndex(restoreFile);
  const after = inspect(restoreFile); assert.equal(after.version, 32);
  assert.deepEqual(after.rows.filter(([name]) => String(name).startsWith('local_catalog_') || String(name).startsWith('local_scan_')),
    before.rows.filter(([name]) => String(name).startsWith('local_catalog_') || String(name).startsWith('local_scan_')));
  const opened = await openCollectionDataset(restoreDirectory);
  try { assert.equal(opened.databaseFile, restoreFile); assert.ok(opened.repository.list({ offset: 0, limit: 1 }).items.length > 0); }
  finally { opened.close(); }
  const db = new DatabaseSync(restoreFile, { readOnly: true, allowExtension: false });
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok'); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare("SELECT count(*) n FROM source_roots WHERE json_extract(data,'$.authorized') IS NOT 0").get()?.n, 0);
  } finally { db.close(); }
});

test('MBRS003 store：未来33与篡改32扫描DDL均拒冷开备份和隔离恢复，原字节不被恢复改写', async t => {
  for (const kind of ['future', 'ddl'] as const) {
    const f = await copy31(t), repository = createCollectionRepository({ filePath: f.file });
    try { repository.list({ offset: 0, limit: 1 }); } finally { repository.close(); }
    const db = new DatabaseSync(f.file);
    try { db.exec(kind === 'future' ? 'PRAGMA user_version=33' : 'DROP INDEX local_scan_batches_job'); } finally { db.close(); }
    const before = await readFile(f.file);
    assert.throws(() => readBackupIndex(f.file)); assert.throws(() => isolateRestoredDatabase(f.file));
    assert.deepEqual(await readFile(f.file), before);
    const cold = createCollectionRepository({ filePath: f.file });
    try { assert.throws(() => cold.list({ offset: 0, limit: 1 })); } finally { cold.close(); }
    await assert.rejects(openCollectionDataset(f.directory));
  }
});

async function warm(t: { after(fn: () => Promise<unknown>): void }, beforeCommit?: (action: string) => void) {
  const f = await copy31(t), sourcePath = path.join(f.directory, '合成空来源'); await mkdir(sourcePath);
  const repository = createCollectionRepository({ filePath: f.file, ...(beforeCommit ? { beforeCommit } : {}) });
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(sourcePath));
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  const datasetId = randomUUID(), commandId = randomUUID(), parserVersion = 'music-metadata-11.15.0/mbrs003-v1';
  const request = { commandId, datasetId, libraryRootId: root.id, expectedRootRevision: root.revision, parserVersion };
  return { ...f, repository, root, source, request, datasetId, parserVersion };
}
function oneBatch(job: { jobId: string; jobRevision: string; checkpointRef: string | null }, parserVersion: string, completed = true): ScanPreparedBatch {
  return { batchId: randomUUID(), jobId: job.jobId, expectedJobRevision: job.jobRevision, checkpointBefore: job.checkpointRef,
    items: [{ relative: '合成.flac', signature: '1:2:3:4:5', parserVersion, outcome: 'accepted', fields: { title: '原始标签' }, failureCode: null, reused: false,
      readFacts: { technical: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48000, channels: 2, bitsPerSample: 16, durationSeconds: 1, evidence: 'bounded-parser-reported' }, coverEvidence: [],
        readEvidence: { bytesRead: 44, readCalls: 1, maxReadBytes: 44, allocationBytes: 44, elapsedMs: 1, wholeAudioHash: false, wholeAudioDecode: false } } }],
    frontier: completed ? [] : [''], completed };
}
function scanRows(file: string) {
  const value = inspect(file);
  return value.rows.filter(([name]) => String(name).startsWith('local_scan_') || String(name).startsWith('local_catalog_'));
}

test('MBRS003 warm：同command完整start复用原job和receipt，改变body拒绝，200分页闭集保留真实总数', async t => {
  const f = await warm(t);
  try {
    const first = f.repository.localScan.start(f.request), second = f.repository.localScan.start({ ...f.request });
    assert.equal(first.created, true); assert.equal(second.created, false); assert.deepEqual(second.job, first.job);
    assert.equal(f.repository.localScan.receipt(f.request.commandId)?.result.jobId, first.job.jobId);
    assert.throws(() => f.repository.localScan.start({ ...f.request, parserVersion: 'other-parser' }));
    for (let n = 1; n <= 200; n++) f.repository.localScan.start({ ...f.request, commandId: randomUUID() });
    const page = f.repository.localScan.page(f.datasetId, { offset: 0, limit: 200 });
    assert.equal(page.total, 201); assert.equal(page.items.length, 200); assert.equal(page.hasMore, true);
    assert.equal(f.repository.localScan.page(f.datasetId, { offset: 200, limit: 200 }).items.length, 1);
    assert.throws(() => f.repository.localScan.page(f.datasetId, { offset: 0, limit: 201 }));
    assert.equal(f.repository.localScan.get(first.job.jobId).phase, 'pending');
  } finally { f.repository.close(); }
});

test('MBRS003 warm：prepared批完整body不可换，commit故障实体子ledger回执checkpoint全回滚后原批可提交', async t => {
  let fail = false;
  const f = await warm(t, action => { if (fail && action === 'local-scan:commit-batch') throw new Error('合成批提交故障'); });
  try {
    const started = f.repository.localScan.start(f.request).job;
    const job = f.repository.localScan.resume({ commandId: randomUUID(), jobId: started.jobId, expectedRevision: started.jobRevision });
    const batch = oneBatch(job, f.parserVersion), prepare = { commandId: randomUUID(), jobId: job.jobId, batch };
    f.repository.localScan.privatePrepareBatch(prepare);
    assert.deepEqual(f.repository.localScan.privatePrepareBatch({ ...prepare, batch: structuredClone(batch) }), job);
    assert.throws(() => f.repository.localScan.privatePrepareBatch({ ...prepare, batch: { ...batch, items: [{ ...batch.items[0]!, fields: { title: '换过的body' } }] } }));
    const commit = { commandId: randomUUID(), jobId: job.jobId, batchId: batch.batchId, expectedRevision: job.jobRevision };
    const before = scanRows(f.file); fail = true;
    assert.throws(() => f.repository.localScan.privateCommitBatch(commit));
    assert.deepEqual(scanRows(f.file), before); assert.equal(f.repository.localScan.receipt(commit.commandId), null);
    assert.deepEqual(f.repository.localScan.get(job.jobId), job); assert.deepEqual(f.repository.localScan.privatePreparedBatches(job.jobId), [batch]);
    fail = false; const result = f.repository.localScan.privateCommitBatch(commit);
    assert.equal(result.phase, 'completed'); assert.deepEqual(result.progress, { visited: '1', accepted: '1', rejected: '0' });
    const state = f.repository.localScan.privateFileState(f.root.id, '合成.flac')!;
    assert.equal(state.jobId, job.jobId); assert.ok(state.value.assetId); assert.ok(state.value.trackId);
    const asset = f.repository.localCatalog.privateAssetLocator(state.value.assetId!);
    assert.equal(asset.asset.sampleFrames, null); assert.equal(asset.asset.timebaseHz, null); assert.equal(asset.relative, '合成.flac');
    assert.equal(f.repository.localCatalog.metadata(state.value.trackId!).effective.title, '原始标签');
  } finally { f.repository.close(); }
});

test('MBRS003 warm：已提交UNKNOWN冷重试复用同完整request和receipt，不重造assettrackledger或checkpoint', async t => {
  const f = await warm(t);
  const started = f.repository.localScan.start(f.request).job;
  const job = f.repository.localScan.resume({ commandId: randomUUID(), jobId: started.jobId, expectedRevision: started.jobRevision });
  const batch = oneBatch(job, f.parserVersion);
  const prepare = { commandId: randomUUID(), jobId: job.jobId, batch }, commit = { commandId: randomUUID(), jobId: job.jobId, batchId: batch.batchId, expectedRevision: job.jobRevision };
  f.repository.localScan.privatePrepareBatch(prepare);
  const result = f.repository.localScan.privateCommitBatch(commit), receipt = f.repository.localScan.receipt(commit.commandId), state = f.repository.localScan.privateFileState(f.root.id, '合成.flac');
  f.repository.close(); const before = scanRows(f.file);
  const cold = createCollectionRepository({ filePath: f.file });
  try {
    assert.deepEqual(cold.localScan.privateCommitBatch(structuredClone(commit)), result);
    assert.deepEqual(cold.localScan.receipt(commit.commandId), receipt);
    assert.deepEqual(cold.localScan.privateFileState(f.root.id, '合成.flac'), state);
    assert.deepEqual(scanRows(f.file), before);
  } finally { cold.close(); }
});

test('MBRS003 warm：prepared冷开只暂停不执行，明确resume用当前CAS提交原body；取消不删既有实体rawmanual', async t => {
  const f = await warm(t);
  const started = f.repository.localScan.start(f.request).job;
  const job = f.repository.localScan.resume({ commandId: randomUUID(), jobId: started.jobId, expectedRevision: started.jobRevision });
  const batch = oneBatch(job, f.parserVersion, false);
  f.repository.localScan.privatePrepareBatch({ commandId: randomUUID(), jobId: job.jobId, batch });
  f.repository.close(); const before = scanRows(f.file);
  const cold = createCollectionRepository({ filePath: f.file });
  try {
    const paused = cold.localScan.get(job.jobId); assert.equal(paused.phase, 'paused'); assert.equal(paused.checkpointRef, null);
    assert.deepEqual(cold.localScan.privatePreparedBatches(job.jobId), [batch]);
    assert.equal(cold.localScan.privateFileState(f.root.id, '合成.flac'), null);
    assert.deepEqual(scanRows(f.file).filter(([name]) => String(name).startsWith('local_catalog_')), before.filter(([name]) => String(name).startsWith('local_catalog_')));
    const resumed = cold.localScan.resume({ commandId: randomUUID(), jobId: paused.jobId, expectedRevision: paused.jobRevision });
    const committed = cold.localScan.privateCommitBatch({ commandId: randomUUID(), jobId: resumed.jobId, batchId: batch.batchId, expectedRevision: resumed.jobRevision });
    const state = cold.localScan.privateFileState(f.root.id, '合成.flac')!, trackId = state.value.trackId!;
    cold.localCatalog.overrideMetadata({ commandId: randomUUID(), trackId, expectedRevision: null, fields: { title: '人工仍优先' } });
    const saved = cold.localCatalog.metadata(trackId), cancel = { commandId: randomUUID(), jobId: committed.jobId, expectedRevision: committed.jobRevision };
    assert.equal(cold.localScan.cancel(cancel).phase, 'cancelled'); assert.equal(cold.localScan.cancel({ ...cancel }).phase, 'cancelled');
    assert.deepEqual(cold.localCatalog.metadata(trackId), saved); assert.deepEqual(cold.localScan.privateFileState(f.root.id, '合成.flac'), state);
    assert.ok(cold.localCatalog.asset(state.value.assetId!));
  } finally { cold.close(); }
});
