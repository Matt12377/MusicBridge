import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { deserialize, serialize } from 'node:v8';
import { createCollectionRepository } from '../src/collection/repository.js';
import { captureLocalCatalogAuditState, clearLocalCatalogAuditState, commitLocalCatalogStartupAudit,
  continueReadonlyQueueCatalogAudit, createLocalCatalogStore, localCatalogLibraryObservationSourceForDatabase,
  restoreLocalCatalogAuditState, verifyLocalCatalogDatabase, type LocalCatalogAuditState } from '../src/collection/local-catalog-store.js';
import { captureLocalScanAuditState, clearLocalScanAuditState, continueReadonlyQueueScanAudit, createLocalScanStore,
  recoverLocalScanJobs, restoreLocalScanAuditState, verifyLocalScanDatabase,
  type LocalScanAuditState, type ScanPreparedBatch, type ScanPreparedItem } from '../src/collection/local-scan-store.js';
import { currentScanOriginIndex } from '../src/collection/local-scan-origin-index.js';
import { publishLocalAuditWritePoint, isLocalAuditWritePointCurrent, withoutLocalAuditObserverSchema } from '../src/collection/local-audit-write-observer.js';
import { assertSourceWritesMainActor } from '../src/collection/source-writes-authority.js';
import { authorizeSourceDirectory } from '../src/recording/source-files.js';
import { readSourceRootForDatabase } from '../src/recording/source-store.js';

// 仅自建SQLite和空目录；解析、技术参数和身份均为合成输入，不读取正式曲库或音频。
const parserVersion = 'music-metadata-11.15.0/mbrs003-v1';
const accepted: ScanPreparedItem = { relative: '合成专辑/曲目.wav', signature: '合成签名', parserVersion,
  outcome: 'accepted', fields: { title: '合成歌曲', artist: '合成艺人', album: '合成专辑' }, failureCode: null, reused: false,
  readFacts: { technical: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48000, channels: 2,
    bitsPerSample: 16, durationSeconds: 1, evidence: 'bounded-parser-reported' }, coverEvidence: [],
    readEvidence: { bytesRead: 44, readCalls: 1, maxReadBytes: 44, allocationBytes: 44, elapsedMs: 1,
      wholeAudioHash: false, wholeAudioDecode: false } } };
type Snapshots = { catalog: LocalCatalogAuditState; scan: LocalScanAuditState };
const roundtrip = <T>(value: T): T => deserialize(serialize(value)) as T;

async function fixture(t: TestContext) {
  const temporary = process.env.TMPDIR;
  assert.ok(temporary && path.isAbsolute(temporary));
  if (process.platform === 'darwin') assert.ok(path.resolve(temporary) === '/Volumes/LifeWeave/Developer/CommandLine/tmp' || path.resolve(temporary).startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const directory = await mkdtemp(path.join(temporary, 'local-audit-snapshot-'));
  const media = path.join(directory, '合成空来源'), filePath = path.join(directory, 'work.sqlite');
  await mkdir(media);
  const repository = createCollectionRepository({ filePath }), connections = new Set<DatabaseSync>();
  t.after(async () => { for (const connection of connections) connection.close(); repository.close(); await rm(directory, { recursive: true, force: true }); });
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media));
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  const identity = { datasetId: randomUUID(), assertCurrent() {} };
  repository.localCatalog.privateBindWorkbenchDataset(identity);
  const settings = repository.localCatalog.privateScanSettingsStore(identity);
  settings.save(identity, { schema: 1, kind: 'settings', eventId: randomUUID(), commandId: randomUUID(),
    datasetId: identity.datasetId, expectedRevision: '1', settings: { revision: '2', albumConcurrency: 4 } });
  function commit(item: ScanPreparedItem) {
    const pending = repository.localScan.start({ commandId: randomUUID(), datasetId: identity.datasetId,
      libraryRootId: root.id, expectedRootRevision: root.revision, parserVersion }).job;
    const job = repository.localScan.resume({ commandId: randomUUID(), jobId: pending.jobId, expectedRevision: pending.jobRevision });
    const batch: ScanPreparedBatch = { batchId: randomUUID(), jobId: job.jobId, expectedJobRevision: job.jobRevision,
      checkpointBefore: job.checkpointRef, items: [item], frontier: [], completed: true };
    repository.localScan.privatePrepareBatch({ commandId: randomUUID(), jobId: job.jobId, batch });
    return repository.localScan.privateCommitBatch({ commandId: randomUUID(), jobId: job.jobId,
      batchId: batch.batchId, expectedRevision: job.jobRevision });
  }
  commit(structuredClone(accepted));
  const job = commit({ ...structuredClone(accepted), fields: {}, reused: true, readFacts: null });
  const state = repository.localScan.privateCurrentFileState(root.id, accepted.relative);
  assert.ok(state?.value.assetId && state.value.trackId);
  const track = repository.localCatalog.track(state.value.trackId), asset = repository.localCatalog.asset(state.value.assetId);
  const metadata = repository.localCatalog.metadata(track.id), parameters = repository.localScan.privateDisplayFileParameters(track.id, asset);
  assert.ok(parameters);
  const db = repository.localCatalog.privateRead(current => current);
  verifyLocalCatalogDatabase(db); verifyLocalScanDatabase(db);
  function snapshots(): Snapshots {
    const catalog = captureLocalCatalogAuditState(db), scan = captureLocalScanAuditState(db);
    assert.ok(catalog); assert.ok(scan); return { catalog, scan };
  }
  function reader() {
    const connection = new DatabaseSync(filePath, { readOnly: true, enableForeignKeyConstraints: true, allowExtension: false });
    connections.add(connection); connection.exec('PRAGMA query_only=ON;PRAGMA trusted_schema=OFF;PRAGMA busy_timeout=1000');
    const read = <T>(operation: (current: DatabaseSync) => T): T => operation(connection);
    const conflict = (message: string): never => { throw new Error(message); };
    const sources = { root: (id: string) => readSourceRootForDatabase(connection, id, conflict) };
    const catalog = createLocalCatalogStore({ read, conflict, sources }); catalog.privateBindWorkbenchDataset(identity);
    const scan = createLocalScanStore({ read, conflict, sources, catalog });
    return { db: connection, catalog, scan };
  }
  function saveQueue() {
    return repository.mbQueue.save({ expectedRevision: '0', queue: { schemaVersion: '1.2', datasetId: identity.datasetId,
      queueId: randomUUID(), revision: '1', currentEntryId: null, entries: [], restartPolicy: { reResolve: true, autoplay: false } } });
  }
  return { repository, db, identity, source, root, job, track, asset, metadata, parameters, snapshots, reader, saveQueue, commit };
}
function restore(reader: ReturnType<Awaited<ReturnType<typeof fixture>>['reader']>, states: Snapshots) {
  assert.equal(restoreLocalCatalogAuditState(reader.db, states.catalog), true);
  assert.equal(restoreLocalScanAuditState(reader.db, states.scan), true);
}

test('审计快照：完整核验经v8跨连接恢复，原目录、扫描和参数读取一致且不重放全账本', async t => {
  const f = await fixture(t), states = roundtrip(f.snapshots()), reader = f.reader();
  assert.ok(states.catalog.observationHistory); assert.ok(states.scan.origins);
  for (const state of [states.catalog, states.scan]) for (const name of ['db', 'handle', 'point', 'dataVersion']) assert.equal(Object.hasOwn(state, name), false);
  assert.throws(() => reader.catalog.privateRead(() => true), /完整核验/u);
  const prepared: string[] = [], prepare = reader.db.prepare.bind(reader.db);
  t.mock.method(reader.db, 'prepare', (sql: string) => { prepared.push(sql); return prepare(sql); });
  restore(reader, states);
  assert.equal(reader.db.prepare('SELECT count(*) n FROM sqlite_temp_schema').get()?.n, 0, '只读Actor不安装SQL函数或TEMP触发器');
  assert.equal(reader.db.prepare('PRAGMA function_list').all().some(row => typeof row.name === 'string' && row.name.startsWith('mousa_local_audit_')), false);
  assert.equal(reader.db.prepare('SELECT total_changes() n').get()?.n, 0, '新连接未执行任何数据库写入');
  assert.deepEqual(reader.catalog.pageTracks({ offset: 0, limit: 20 }).items, [f.track]);
  assert.deepEqual(reader.catalog.metadata(f.track.id), f.metadata);
  assert.deepEqual(reader.scan.get(f.job.jobId), f.job);
  assert.deepEqual(reader.scan.privateCurrentFileState(f.root.id, accepted.relative), f.repository.localScan.privateCurrentFileState(f.root.id, accepted.relative));
  assert.deepEqual(reader.scan.privateDisplayFileParameters(f.track.id, f.asset), f.parameters);
  assert.deepEqual(reader.catalog.privateScanSettingsStore(f.identity).read(f.identity), { revision: '2', albumConcurrency: 4 });
  assert.ok(localCatalogLibraryObservationSourceForDatabase(reader.db)); assert.ok(currentScanOriginIndex(reader.db));
  assert.equal(prepared.some(sql => sql === 'PRAGMA integrity_check' || sql.includes('FROM local_catalog_ledger ORDER BY rowid')
    || sql.includes('FROM local_scan_batches ORDER BY rowid')), false);
  // 调用者修改导出树不能改动已经绑定本连接的作者或重新铸造Source actor。
  states.catalog.rows.clear(); states.scan.rows.clear(); states.scan.origins!.entries.clear();
  assert.deepEqual(reader.catalog.metadata(f.track.id), f.metadata);
  assert.deepEqual(reader.scan.privateDisplayFileParameters(f.track.id, f.asset), f.parameters);
  assert.throws(() => assertSourceWritesMainActor(states.catalog.sourceWrites), /GRANT_REQUIRED/u);
});

test('审计快照：事务内恢复必须经原COMMIT和scan发布，观察handle与origin重新绑定新连接', async t => {
  const f = await fixture(t), reader = f.reader();
  reader.db.exec('BEGIN'); restore(reader, roundtrip(f.snapshots()));
  assert.equal(currentScanOriginIndex(reader.db), undefined, '未提交的候选位置不供普通读者使用');
  const publish = recoverLocalScanJobs(reader.db, 'cold-open');
  commitLocalCatalogStartupAudit(reader.db); publish();
  assert.ok(localCatalogLibraryObservationSourceForDatabase(reader.db)); assert.ok(currentScanOriginIndex(reader.db));
  assert.deepEqual(reader.scan.privateDisplayFileParameters(f.track.id, f.asset), f.parameters);
});

test('审计快照：合法本连接元数据写保留新计数，但过期观察history不能复活', async t => {
  const f = await fixture(t);
  assert.ok(f.snapshots().catalog.observationHistory);
  f.repository.localCatalog.overrideMetadata({ commandId: randomUUID(), trackId: f.track.id, expectedRevision: null, fields: { title: '合法新标题' } });
  const states = f.snapshots(), reader = f.reader();
  assert.equal(states.catalog.observationHistory, null); assert.equal(localCatalogLibraryObservationSourceForDatabase(f.db), undefined);
  restore(reader, roundtrip(states));
  assert.equal(localCatalogLibraryObservationSourceForDatabase(reader.db), undefined);
  assert.deepEqual(reader.catalog.metadata(f.track.id), f.repository.localCatalog.metadata(f.track.id));
});

test('审计快照：本连接队列纯写可捕获；外部提交先失效，仅原只读队列连续链可续接', async t => {
  const f = await fixture(t), reader = f.reader(); restore(reader, roundtrip(f.snapshots()));
  const previousVersion = Number(reader.db.prepare('PRAGMA data_version').get()?.data_version);
  f.saveQueue();
  const current = f.snapshots();
  assert.ok(current.catalog.observationHistory); assert.ok(current.scan.origins);
  assert.equal(localCatalogLibraryObservationSourceForDatabase(f.db), undefined, '纯history可导出，但旧活handle不能续借全局SQL点');
  assert.equal(captureLocalCatalogAuditState(reader.db), undefined); assert.equal(captureLocalScanAuditState(reader.db), undefined);
  reader.db.exec('BEGIN'); reader.db.prepare('SELECT count(*) FROM sqlite_master').get();
  continueReadonlyQueueCatalogAudit(reader.db, previousVersion); continueReadonlyQueueScanAudit(reader.db, previousVersion);
  assert.ok(captureLocalCatalogAuditState(reader.db)); assert.ok(captureLocalScanAuditState(reader.db));
  reader.db.exec('ROLLBACK');
});

test('审计快照：原扫描合法联合提交后两域计数当前，未知同连接SQL写不能导出', async t => {
  const f = await fixture(t);
  f.commit({ ...structuredClone(accepted), relative: '另一专辑/新曲.wav', signature: '另一合成签名' });
  const states = f.snapshots(), reader = f.reader(); restore(reader, roundtrip(states));
  assert.equal(reader.catalog.pageTracks({ offset: 0, limit: 20 }).total, 2);
  // 即使正文相同，绕开原作者的UPDATE也不能被捕获成已核增量。
  f.db.exec('UPDATE local_catalog_tracks SET data=data');
  assert.equal(captureLocalCatalogAuditState(f.db), undefined);
  assert.ok(captureLocalScanAuditState(f.db), '未知catalog写不冒充scan写；整体缓存仍因catalog失败拒绝');
});

test('审计快照：库存收货、策略和其它表写入保留纯history/origin，旧活SQL点仍拒绝', async t => {
  const f = await fixture(t), before = f.snapshots();
  const schema = f.db.prepare('SELECT type,name,sql FROM main.sqlite_schema ORDER BY type,name').all();
  const received = f.repository.receive({ commandId: randomUUID(), model: { brand: '合成品牌', name: '合成磁带', edition: '测试',
    year: null, format: 'cassette', tapeType: 'II', identification: 'verified' }, lengthMinutes: 90,
    quantities: { sealedBlank: 2, openedBlank: 0, legacyUsed: 0, unclassified: 0 } });
  f.repository.setPolicy({ commandId: randomUUID(), modelId: received.modelId, expectedRevision: 1,
    collectorPolicy: 'preserve-sealed', minimumSealedReserve: 1 });
  f.db.prepare('UPDATE collection_models SET revision=revision WHERE id=?').run(received.modelId);
  assert.equal(localCatalogLibraryObservationSourceForDatabase(f.db), undefined);
  assert.equal(currentScanOriginIndex(f.db), undefined);
  // queue的原发布链也不能借纯引用重新打开旧活point。
  f.saveQueue();
  assert.equal(currentScanOriginIndex(f.db), undefined);
  const after = f.snapshots();
  assert.deepEqual(after.catalog.rows, before.catalog.rows); assert.deepEqual(after.scan.rows, before.scan.rows);
  assert.deepEqual(after.catalog.observationHistory, before.catalog.observationHistory);
  assert.deepEqual(after.scan.origins, before.scan.origins);
  assert.deepEqual(f.db.prepare('SELECT type,name,sql FROM main.sqlite_schema ORDER BY type,name').all(), schema, '观察器不修改主库schema');
  const reader = f.reader(); restore(reader, roundtrip(after));
  assert.ok(localCatalogLibraryObservationSourceForDatabase(reader.db)); assert.ok(currentScanOriginIndex(reader.db));
  assert.deepEqual(reader.catalog.metadata(f.track.id), f.metadata);
  assert.deepEqual(reader.scan.privateDisplayFileParameters(f.track.id, f.asset), f.parameters);
});

test('审计快照：未知scan同值写仍使capture失效，不能因全局行数不变放行', async t => {
  const f = await fixture(t);
  f.db.exec('UPDATE local_scan_jobs SET data=data');
  assert.equal(captureLocalScanAuditState(f.db), undefined);
  assert.ok(captureLocalCatalogAuditState(f.db));
});

test('审计快照：未知catalog前缀不能被后续合法发布洗掉，完整重核后才恢复资格', async t => {
  const f = await fixture(t);
  f.db.exec('UPDATE local_catalog_tracks SET data=data');
  f.repository.localCatalog.overrideMetadata({ commandId: randomUUID(), trackId: f.track.id, expectedRevision: null,
    fields: { title: '未知前缀之后的合法标题' } });
  assert.equal(captureLocalCatalogAuditState(f.db), undefined);
  assert.equal(f.repository.localCatalog.metadata(f.track.id).effective.title, '未知前缀之后的合法标题', '业务读写仍按原路径工作');
  verifyLocalCatalogDatabase(f.db); verifyLocalScanDatabase(f.db);
  assert.ok(f.snapshots());
});

test('审计快照：未知scan前缀后正常扫描仍不能刷新资格，完整重核后才恢复', async t => {
  const f = await fixture(t);
  f.db.exec('UPDATE local_scan_jobs SET data=data');
  const job = f.commit({ ...structuredClone(accepted), relative: '合法新增/曲目.wav', signature: '未知前缀后的合成签名' });
  assert.equal(job.phase, 'completed'); assert.equal(captureLocalScanAuditState(f.db), undefined);
  verifyLocalCatalogDatabase(f.db); verifyLocalScanDatabase(f.db);
  assert.ok(f.snapshots());
});

test('审计快照：新库迁移后的完整核验可恢复观察器，普通发布不能认可schema变化', async t => {
  const f = await fixture(t);
  f.db.exec('CREATE TABLE audit_recheck_schema(data TEXT)');
  f.repository.localCatalog.overrideMetadata({ commandId: randomUUID(), trackId: f.track.id, expectedRevision: null, fields: { title: 'schema变化后的合法标题' } });
  assert.equal(captureLocalCatalogAuditState(f.db), undefined); assert.equal(captureLocalScanAuditState(f.db), undefined);
  verifyLocalCatalogDatabase(f.db); verifyLocalScanDatabase(f.db);
  const states = f.snapshots(), reader = f.reader(); restore(reader, roundtrip(states));
  assert.equal(reader.catalog.metadata(f.track.id).effective.title, 'schema变化后的合法标题');
});

test('审计观察器：trusted_schema OFF下实际记录完成扫描快照两表的未知写入', t => {
  for (const table of ['local_scan_snapshot_commits', 'local_scan_snapshot_chunks']) {
    const db = new DatabaseSync(':memory:'); t.after(() => db.close());
    db.exec('PRAGMA trusted_schema=OFF;CREATE TABLE local_scan_snapshot_commits(data TEXT);CREATE TABLE local_scan_snapshot_chunks(data TEXT)');
    const point = publishLocalAuditWritePoint(db, 'scan'); assert.ok(point);
    assert.equal(isLocalAuditWritePointCurrent(db, 'scan', point), true);
    db.exec(`INSERT INTO ${table}(data) VALUES('合成未知快照写')`);
    assert.equal(isLocalAuditWritePointCurrent(db, 'scan', point), false);
  }
});

test('审计观察器：只精确过滤自身TEMP对象，重建同名触发器及主schema变化均不准入', async t => {
  const f = await fixture(t);
  const rows = f.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_temp_schema ORDER BY type,name').all();
  assert.ok(rows.length > 0); assert.equal(withoutLocalAuditObserverSchema(f.db, rows).length, 0);
  const first = rows[0]!; assert.equal(typeof first.name, 'string'); assert.equal(typeof first.sql, 'string');
  f.db.exec(`DROP TRIGGER temp."${String(first.name)}"`);
  f.db.exec(String(first.sql).replace(/^CREATE TRIGGER /u, 'CREATE TEMP TRIGGER '));
  const rebuilt = f.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_temp_schema ORDER BY type,name').all();
  assert.equal(withoutLocalAuditObserverSchema(f.db, rebuilt).length, rebuilt.length, 'SQL相同也不能掩盖未知TEMP schema改动');
  assert.equal(captureLocalCatalogAuditState(f.db), undefined); assert.equal(captureLocalScanAuditState(f.db), undefined);
  const other = await fixture(t);
  other.db.exec('CREATE TABLE audit_unknown_main(data TEXT)');
  assert.equal(captureLocalCatalogAuditState(other.db), undefined); assert.equal(captureLocalScanAuditState(other.db), undefined);
});

test('审计观察器：未知TEMP表保留在原录音审计输入中，并撤销快照捕获', async t => {
  const f = await fixture(t);
  f.db.exec('CREATE TEMP TABLE unexpected_audit_temp(value TEXT)');
  const rows = f.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_temp_schema ORDER BY type,name').all();
  assert.ok(withoutLocalAuditObserverSchema(f.db, rows).some(row => row.name === 'unexpected_audit_temp'));
  assert.equal(captureLocalCatalogAuditState(f.db), undefined); assert.equal(captureLocalScanAuditState(f.db), undefined);
});

test('审计快照：目录缺失、损坏、预算超限和未完成投影统一拒绝并清除旧资格', async t => {
  const f = await fixture(t), states = roundtrip(f.snapshots()), reader = f.reader();
  const invalid: unknown[] = [undefined, null, {}, { ...states.catalog, point: {} }, { ...states.catalog, bytes: -1 },
    { ...states.catalog, rows: new Map([['local_catalog_tracks', 1]]) },
    { ...states.catalog, rows: new Map([...states.catalog.rows, ['local_catalog_tracks', 300_001]]) },
    { ...states.catalog, sourceWrites: { ...states.catalog.sourceWrites, fullRaw: {} } },
    { ...states.catalog, workbench: { ...states.catalog.workbench, lyrics: undefined } }];
  const incomplete = roundtrip(states.catalog);
  incomplete.workbench.scanSettings.clear();
  incomplete.workbench.workbench.set(f.identity.datasetId, { datasetId: f.identity.datasetId, revision: 1, snapshot: null,
    highWater: 0, pending: { common: {} as never, chunks: [], bytes: 0 } });
  invalid.push(incomplete);
  const brokenHistory = roundtrip(states.catalog);
  const candidates = brokenHistory.observationHistory!.byTrack!.get(f.track.id); assert.ok(candidates);
  candidates[0] = 1;
  invalid.push(brokenHistory, { ...states.catalog, observationHistory: { ...states.catalog.observationHistory, allocationBytes: 1 } });
  let getterCalls = 0;
  const accessor = { ...states.catalog }; Object.defineProperty(accessor, 'bytes', { enumerable: true, get() { getterCalls++; return 0; } });
  invalid.push(accessor, { ...states.catalog, bytes: () => 1 });
  for (const value of invalid) {
    assert.equal(restoreLocalCatalogAuditState(reader.db, states.catalog), true);
    assert.equal(restoreLocalCatalogAuditState(reader.db, value), false);
    assert.equal(captureLocalCatalogAuditState(reader.db), undefined);
    assert.equal(localCatalogLibraryObservationSourceForDatabase(reader.db), undefined);
    assert.throws(() => reader.catalog.privateRead(() => true), /完整核验/u);
  }
  assert.equal(getterCalls, 0, '拒绝访问器时不能执行调用者代码');
});

test('审计快照：扫描缺失、损坏候选与计数超限拒绝；跨域失败后调用者可清除全部审计', async t => {
  const f = await fixture(t), states = roundtrip(f.snapshots()), reader = f.reader();
  const brokenOrigin = roundtrip(states.scan); assert.ok(brokenOrigin.origins);
  brokenOrigin.origins.entries.values().next().value![0] = 0;
  const invalid: unknown[] = [undefined, null, {}, { ...states.scan, dataVersion: 1 }, { ...states.scan, origins: undefined },
    { ...states.scan, bytes: Number.NaN }, { ...states.scan, rows: [] },
    { ...states.scan, rows: new Map([...states.scan.rows, ['local_scan_batches', 3_000_001]]) }, brokenOrigin];
  for (const value of invalid) {
    restore(reader, states);
    assert.equal(restoreLocalScanAuditState(reader.db, value), false);
    clearLocalCatalogAuditState(reader.db); clearLocalScanAuditState(reader.db);
    assert.equal(captureLocalCatalogAuditState(reader.db), undefined); assert.equal(captureLocalScanAuditState(reader.db), undefined);
    assert.equal(currentScanOriginIndex(reader.db), undefined);
  }
});

test('审计快照：尚未完整核验的连接与外键关闭状态不能导出或导入', async t => {
  const f = await fixture(t), states = f.snapshots(), reader = f.reader();
  assert.equal(captureLocalCatalogAuditState(reader.db), undefined); assert.equal(captureLocalScanAuditState(reader.db), undefined);
  restore(reader, states); reader.db.exec('PRAGMA foreign_keys=OFF');
  assert.equal(captureLocalCatalogAuditState(reader.db), undefined); assert.equal(captureLocalScanAuditState(reader.db), undefined);
  assert.equal(restoreLocalCatalogAuditState(reader.db, states.catalog), false); assert.equal(restoreLocalScanAuditState(reader.db, states.scan), false);
});
