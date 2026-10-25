import assert from 'node:assert/strict';
import test, { mock, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ScanPreparedBatch, ScanPreparedItem } from '../../src/collection/local-scan-store.js';

const originModule = new URL('../../src/collection/local-scan-origin-index.ts', import.meta.url).href;
const originalOrigin = await import(originModule) as typeof import('../../src/collection/local-scan-origin-index.js');
let occupiedBytes: number | undefined;
let lastIndex: ReturnType<typeof originalOrigin.createScanOriginIndex> | undefined;
// 只把原计数置于硬预算边缘；生产 addScanOriginBatch 仍自行触发真实 32MiB 上限。
// 两个真实合成批即可覆盖失败调度，无产品预算开关、巨型库或伪造的成功索引。
mock.module(originModule, { namedExports: { ...originalOrigin, createScanOriginIndex() {
  const index = originalOrigin.createScanOriginIndex();
  if (occupiedBytes !== undefined) { index.bytes = occupiedBytes; lastIndex = index; }
  return index;
} } });
const { createCollectionRepository } = await import('../../src/collection/repository.js');
const { verifyLocalCatalogDatabase } = await import('../../src/collection/local-catalog-store.js');
const { verifyLocalScanDatabase } = await import('../../src/collection/local-scan-store.js');
const { authorizeSourceDirectory } = await import('../../src/recording/source-files.js');
const maximumBytes = 32 * 1024 * 1024;
const expected = { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48000,
  channels: 2, bitsPerSample: 16, durationMs: 1000, evidence: 'bounded-parser-reported' };

async function fixture(t: TestContext) {
  assert.ok(process.env.TMPDIR?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const directory = await mkdtemp(path.join(process.env.TMPDIR!, 'origin-overflow-'));
  const media = path.join(directory, '合成空来源'), filePath = path.join(directory, 'collection.sqlite');
  await mkdir(media);
  const repository = createCollectionRepository({ filePath });
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media));
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  const datasetId = randomUUID(), parserVersion = 'music-metadata-11.15.0/mbrs003-v1';
  const input: ScanPreparedItem = { relative: '合成专辑/01.wav', signature: '合成固定签名', parserVersion,
    outcome: 'accepted', fields: { title: '合成歌曲', artist: '合成艺人', album: '合成专辑' },
    failureCode: null, reused: false, readFacts: { technical: { container: 'WAVE', codec: 'PCM', lossless: true,
      sampleRateHz: 48000, channels: 2, bitsPerSample: 16, durationSeconds: 1, evidence: 'bounded-parser-reported' },
    coverEvidence: [], readEvidence: { bytesRead: 44, readCalls: 1, maxReadBytes: 44, allocationBytes: 44,
      elapsedMs: 1, wholeAudioHash: false, wholeAudioDecode: false } } };
  for (const reused of [false, true]) {
    const current = repository.localCatalog.root(root.id);
    const pending = repository.localScan.start({ commandId: randomUUID(), datasetId, libraryRootId: current.id,
      expectedRootRevision: current.revision, parserVersion }).job;
    const job = repository.localScan.resume({ commandId: randomUUID(), jobId: pending.jobId, expectedRevision: pending.jobRevision });
    const batch: ScanPreparedBatch = { batchId: randomUUID(), jobId: job.jobId, expectedJobRevision: job.jobRevision,
      checkpointBefore: job.checkpointRef, items: [{ ...input, ...(reused ? { fields: {}, reused: true, readFacts: null } : {}) }],
      frontier: [], completed: true };
    repository.localScan.privatePrepareBatch({ commandId: randomUUID(), jobId: job.jobId, batch });
    assert.equal(repository.localScan.privateCommitBatch({ commandId: randomUUID(), jobId: job.jobId,
      batchId: batch.batchId, expectedRevision: job.jobRevision }).phase, 'completed');
  }
  const db = repository.localCatalog.privateRead(value => value);
  const state = repository.localScan.privateCurrentFileState(root.id, input.relative)!.value;
  assert.ok(state.assetId && state.trackId);
  verifyLocalScanDatabase(db);
  const read = () => repository.localScan.privateDisplayFileParameters(state.trackId!, repository.localCatalog.asset(state.assetId!));
  assert.deepEqual(read(), expected);
  t.after(async () => {
    occupiedBytes = undefined; lastIndex = undefined;
    if (db.isTransaction) db.exec('ROLLBACK');
    repository.close(); await rm(directory, { recursive: true, force: true });
  });
  return { repository, db, filePath, state, read,
    warm: () => repository.localScan.privateWarmDisplayFileParameters(),
    overflow(kind: 'batches' | 'jobs' = 'batches') {
      originalOrigin.discardScanOriginIndex(db);
      // 两个 job 占 544 字节，随后首个真实候选跨过剩余的 56 字节。
      occupiedBytes = kind === 'batches' ? maximumBytes - 600 : maximumBytes;
    },
  };
}

function observe(t: TestContext, db: DatabaseSync, afterPage?: () => void) {
  const prepare = DatabaseSync.prototype.prepare, counts = { jobs: 0, pages: 0, history: 0, ledger: 0 };
  t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql);
    if (this !== db) return statement;
    const jobs = sql === 'SELECT id,library_root_id FROM local_scan_jobs ORDER BY id';
    const page = sql.includes("FROM local_scan_batches WHERE rowid>? AND phase='committed'");
    const ledger = sql === 'SELECT result FROM local_catalog_ledger WHERE command_id IN (?,?)';
    if (jobs || page || ledger) {
      const all = statement.all;
      t.mock.method(statement, 'all', (...args: unknown[]) => {
        const rows = Reflect.apply(all, statement, args);
        if (jobs) counts.jobs++;
        if (page) { counts.pages++; afterPage?.(); }
        if (ledger) counts.ledger++;
        return rows;
      });
    }
    if (sql.includes('FROM local_scan_batches b') && sql.includes('json_each(b.result') && sql.endsWith('ORDER BY b.rowid DESC LIMIT 200')) {
      const iterate = statement.iterate;
      t.mock.method(statement, 'iterate', (...args: unknown[]) => { counts.history++; return Reflect.apply(iterate, statement, args); });
    }
    return statement;
  });
  return counts;
}

for (const kind of ['batches', 'jobs'] as const) {
  test(`origin ${kind} 超预算：同SQL点重复请求不再重建，仍逐次读取原200候选和原账本`, async t => {
    const f = await fixture(t), counts = observe(t, f.db);
    f.overflow(kind);
    const changes = f.db.prepare('SELECT total_changes() n').get()!.n;
    assert.deepEqual(f.read(), expected); await f.warm();
    assert.equal(lastIndex?.overflow, true);
    assert.equal(originalOrigin.currentScanOriginIndex(f.db), undefined, 'overflow不能成为空的有效索引');
    const builds = counts.jobs, histories = counts.history, ledgers = counts.ledger;
    assert.equal(builds, 1);
    for (let index = 0; index < 3; index++) { assert.deepEqual(f.read(), expected); await f.warm(); }
    assert.equal(counts.jobs, builds, '同一个真实SQL点的预算失败不能每次重新枚举全历史');
    assert.equal(counts.history, histories + 3); assert.equal(counts.ledger, ledgers + 3);
    assert.equal(f.db.prepare('SELECT total_changes() n').get()!.n, changes);
  });
}

for (const change of ['DML', 'DDL', 'ROLLBACK', 'EXTERNAL'] as const) {
  test(`origin超预算：真实${change}改变水位后允许重新构造，不延续失败点或成功证明`, async t => {
    const f = await fixture(t), counts = observe(t, f.db);
    f.overflow(); await f.warm(); assert.equal(counts.jobs, 1);
    const write = (db: DatabaseSync) => db.prepare("UPDATE physical_sequences SET next_value=next_value+1 WHERE format='cassette'").run();
    if (change === 'DML') assert.equal(write(f.db).changes, 1);
    else if (change === 'DDL') f.db.exec('CREATE INDEX synthetic_origin_extra ON local_scan_batches(fingerprint)');
    else if (change === 'ROLLBACK') { f.db.exec('BEGIN'); assert.equal(write(f.db).changes, 1); f.db.exec('ROLLBACK'); }
    else {
      const external = new DatabaseSync(f.filePath);
      try { assert.equal(write(external).changes, 1); } finally { external.close(); }
      // 原目录与扫描审核都受外部提交撤销；先完整重核合成库，再只丢候选位置，不能借旧审核签资格。
      occupiedBytes = undefined; verifyLocalCatalogDatabase(f.db); verifyLocalScanDatabase(f.db); f.overflow();
    }
    await f.warm(); assert.equal(counts.jobs, 2);
    assert.equal(originalOrigin.currentScanOriginIndex(f.db), undefined);
    assert.deepEqual(f.read(), expected); await f.warm(); assert.equal(counts.jobs, 2);
  });
}

test('origin失败点改变后，新的完整构造仍可发布并恢复候选点读', async t => {
  const f = await fixture(t), counts = observe(t, f.db);
  f.overflow(); await f.warm(); assert.equal(lastIndex?.overflow, true);
  f.db.prepare("UPDATE physical_sequences SET next_value=next_value+1 WHERE format='cassette'").run();
  occupiedBytes = undefined;
  await f.warm();
  assert.equal(counts.jobs, 2); assert.ok(originalOrigin.currentScanOriginIndex(f.db));
  const histories = counts.history;
  assert.deepEqual(f.read(), expected);
  assert.equal(counts.history, histories, '新完整集合真实发布后才恢复候选点读');
  assert.ok(counts.ledger > 0, '有效候选也不能省略原资产账本');
});

for (const phase of ['before-read', 'after-overflow'] as const) {
  test(`origin ${phase} 期间事务未闭合：取消不能记作同水位的永久预算失败`, async t => {
    const f = await fixture(t);
    let armed = phase === 'after-overflow';
    const counts = observe(t, f.db, () => {
      if (!armed) return; armed = false;
      setImmediate(() => f.db.exec('BEGIN'));
    });
    f.overflow();
    const warming = f.warm();
    if (phase === 'before-read') f.db.exec('BEGIN');
    await warming;
    assert.equal(f.db.isTransaction, true);
    assert.equal(lastIndex?.overflow, phase === 'after-overflow');
    f.db.exec('ROLLBACK');
    const builds = counts.jobs;
    await f.warm(); assert.equal(counts.jobs, builds + 1, 'SQL点相同但先前取消或事务未闭合，必须能够重新构造');
    assert.equal(lastIndex?.overflow, true);
    assert.deepEqual(f.read(), expected); await f.warm(); assert.equal(counts.jobs, builds + 1);
  });
}

test('origin超预算后的fallback仍拒绝真实损坏的资产账本，不把失败记忆当参数证明', async t => {
  const f = await fixture(t), counts = observe(t, f.db);
  f.overflow(); await f.warm();
  const row = f.db.prepare("SELECT command_id,result FROM local_catalog_ledger WHERE operation='register-asset' AND json_extract(result,'$.id')=?").get(f.state.assetId!);
  assert.ok(row); const value = JSON.parse(String(row.result)); value.fileRevision = (BigInt(value.fileRevision) + 1n).toString();
  f.db.exec('DROP TRIGGER local_catalog_ledger_no_update');
  f.db.prepare('UPDATE local_catalog_ledger SET result=? WHERE command_id=?').run(JSON.stringify(value), String(row.command_id));
  assert.equal(f.read(), null); await f.warm();
  assert.ok(counts.history > 0); assert.ok(counts.ledger > 0);
  assert.equal(originalOrigin.currentScanOriginIndex(f.db), undefined);
});
