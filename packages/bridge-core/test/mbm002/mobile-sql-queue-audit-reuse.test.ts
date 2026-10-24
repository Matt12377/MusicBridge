import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { verifyLocalCatalogDatabase } from '../../src/collection/local-catalog-store.js';
import { verifyLocalScanDatabase } from '../../src/collection/local-scan-store.js';
import { createLocalAlbumOwnerService } from '../../src/collection/local-album-browser/owner-port.js';
import { seedMobileSqlWaveLibrary } from '../helpers/mobile-sql-owned-wave-library.js';

const query = { kind: 'groups' as const, offset: 0, limit: 25, query: '', rootId: null,
  albumKey: null, trackId: null, editionId: null, groupHash: null };

async function fixture(t: test.TestContext) {
  assert.ok(process.env.TMPDIR?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const directory = await mkdtemp(path.join(process.env.TMPDIR!, 'mobile-queue-audit-'));
  const databaseFile = path.join(directory, 'catalog.sqlite');
  const repository = createCollectionRepository({ filePath: databaseFile });
  const datasetId = randomUUID();
  const seeded = await seedMobileSqlWaveLibrary(repository, datasetId, path.join(directory, '合成来源'));
  let audits = 0, workers = 0;
  let live = true, cancelNext = false, queueRevision = 0, expectedFatalClose = false;
  let beforePost: ((frame: Record<string, unknown>) => void) | undefined;
  const queueId = randomUUID();
  const service = createLocalAlbumOwnerService({ repository, datasetId, assertCurrent() { if (!live) throw new Error('合成Owner读已撤销。'); },
    mobileSqlWorker: { databaseFile, workerFactory(options) {
      workers++;
      const worker = new Worker(new URL('../../src/collection/local-album-browser/mobile-sql-worker-entry.ts', import.meta.url),
        { ...options, execArgv: ['--import', 'tsx'] });
      const post = worker.postMessage.bind(worker);
      worker.postMessage = (...args: Parameters<Worker['postMessage']>) => {
        const frame = args[0] as Record<string, unknown>;
        if (frame?.type === 'job' && beforePost) { const hook = beforePost; beforePost = undefined; hook(frame); }
        post(...args);
      };
      worker.on('message', value => {
        if (value?.type === 'stage' && value.stage === 'audit-begin') audits++;
        if (value?.type === 'stage' && value.stage === 'entered' && cancelNext) { cancelNext = false; live = false; }
      });
      return worker;
    } },
    readArtwork: async () => ({ image: null, status: 'ready' }),
    readRootViews: async () => repository.localCatalog.roots().map(root => ({ root, label: '合成来源', availability: 'ONLINE' as const })),
  });
  t.after(async () => {
    try {
      const results = await Promise.allSettled([service.privateMobile.closeStructure?.(), service.privateMobile.closeIndex?.()]);
      const rejected = results.filter(result => result.status === 'rejected');
      if (expectedFatalClose) assert.ok(rejected.length, '故意损坏后的fatal不能被close伪装成功。');
      else for (const result of rejected) throw result.reason;
    } finally { service.close(); repository.close(); await rm(directory, { recursive: true, force: true }); }
  });
  await service.privateMobile.refresh();
  const read = () => service.privateMobile.structure!(query);
  const queue = () => repository.mbQueue.save({ expectedRevision: String(queueRevision), queue: { schemaVersion: '1.2', datasetId,
    queueId, revision: String(++queueRevision), currentEntryId: null, restartPolicy: { reResolve: true, autoplay: false }, entries: [] } });
  return { repository, service, datasetId, read, queue, seeded, directory, databaseFile, audits: () => audits,
    workers: () => workers,
    beforeNextJob: (hook: (frame: Record<string, unknown>) => void) => { beforePost = hook; },
    cancelNext: () => { cancelNext = true; }, resume: () => { live = true; }, expectFatalClose: () => { expectedFatalClose = true; } };
}

test('已确认的单行队列CAS不使隔离只读Actor重复全库开库审计', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const initial = await f.read();
  assert.equal(f.audits(), 1);
  const revision = f.service.privateMobile.revision();
  f.queue();
  assert.equal(f.service.privateMobile.revision(), revision, '队列自身不改变目录逻辑修订。');
  assert.deepEqual(await f.read(), initial, '内容和来源修订必须保持相同。');
  assert.equal(f.audits(), 1, '合法且已证明的单行队列写不能重新全库审计。');
});

test('多个合法队列CAS连续链保留原审计，链超过128段则重审', { timeout: 20_000 }, async t => {
  const f = await fixture(t), initial = await f.read();
  for (let i = 0; i < 5; i++) f.queue();
  assert.deepEqual(await f.read(), initial); assert.equal(f.audits(), 1);
  for (let i = 0; i < 129; i++) f.queue();
  assert.deepEqual(await f.read(), initial); assert.equal(f.audits(), 2);
});

test('同Owner未知表写即使不改逻辑目录也不能借后续队列证明', { timeout: 20_000 }, async t => {
  const f = await fixture(t), initial = await f.read();
  f.repository.localCatalog.privateRead(db => db.prepare('UPDATE source_roots SET data=data WHERE id=?').run(f.seeded.sourceId));
  f.queue();
  assert.deepEqual(await f.read(), initial); assert.equal(f.audits(), 2);
});

test('队列触发器追加写不会被单行CAS证明覆盖', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  f.repository.localCatalog.privateRead(db => db.exec('CREATE TRIGGER synthetic_queue_extra AFTER INSERT ON mb_playback_queue BEGIN UPDATE source_roots SET data=data; END'));
  const initial = await f.read(); f.queue();
  assert.deepEqual(await f.read(), initial); assert.equal(f.audits(), 2);
});

test('触发器偷偷损坏曲目必须重审并拒绝，不能只看逻辑水位', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  f.repository.localCatalog.privateRead(db => db.exec("CREATE TRIGGER synthetic_queue_corrupt AFTER INSERT ON mb_playback_queue BEGIN UPDATE local_catalog_tracks SET data='{}'; END"));
  await f.read(); f.expectFatalClose(); f.queue();
  await assert.rejects(f.read()); assert.equal(f.audits(), 2);
});

test('外部SQLite提交必须重审或拒绝，不借队列链绕过', { timeout: 20_000 }, async t => {
  const f = await fixture(t); f.queue(); const initial = await f.read();
  const outside = new DatabaseSync(f.databaseFile);
  try { outside.exec("UPDATE mb_playback_queue SET revision='2',data=json_set(data,'$.revision','2')"); } finally { outside.close(); }
  const result = await f.read().then(page => ({ page }), error => ({ error }));
  if ('page' in result) { assert.deepEqual(result.page, initial); assert.equal(f.audits(), 2, '外部真实提交必须重新完整审计。'); }
  else assert.equal(result.error.code, 'UNAVAILABLE');
});

test('真正元数据变化重审并返回当前目录', { timeout: 20_000 }, async t => {
  const f = await fixture(t), initial = await f.read();
  f.repository.localCatalog.observeMetadata({ commandId: randomUUID(), trackId: f.seeded.trackIds[0]!, source: 'synthetic',
    parserVersion: 'queue-audit-current-v2', fields: { title: '新曲目', artist: '新合成艺人', album: '新合成专辑' } });
  const changed = await f.read(); assert.notEqual(changed.revision, initial.revision); assert.equal(f.audits(), 2);
});

test('新扫描及目录变化保留首次完整审计', { timeout: 20_000 }, async t => {
  const f = await fixture(t), initial = await f.read();
  await seedMobileSqlWaveLibrary(f.repository, f.datasetId, path.join(f.directory, '另一合成来源'));
  await f.service.privateMobile.refresh();
  const changed = await f.read(); assert.equal(changed.total, initial.total + 1); assert.notEqual(changed.revision, initial.revision);
  assert.equal(f.audits(), 2);
});

test('撤销的已续接作业不发布可借的审计资格', { timeout: 20_000 }, async t => {
  const f = await fixture(t), initial = await f.read(); f.queue(); f.cancelNext();
  await assert.rejects(f.read()); f.resume();
  assert.deepEqual(await f.read(), initial); assert.equal(f.audits(), 2);
});

test('Owner失效换代后不能借前代队列证明', { timeout: 20_000 }, async t => {
  const f = await fixture(t), initial = await f.read(); f.service.invalidate(); f.queue();
  assert.deepEqual(await f.read(), initial); assert.equal(f.audits(), 2);
});

test('队列证明捕获后才发生外部提交：当次拒绝并撤销SAB，恢复后同Actor重新全审', { timeout: 20_000 }, async t => {
  const f = await fixture(t), initial = await f.read(); f.queue();
  const revision = f.service.privateMobile.revision();
  assert.equal(f.workers(), 1);
  let injected = false, cancellation: Int32Array | undefined;
  f.beforeNextJob(frame => {
    assert.equal(frame.jobId, 2); assert.equal(frame.queueFromJob, 1, '必须已捕获合法队列连续性，才能注入该竞态。');
    cancellation = new Int32Array(frame.cancellation as SharedArrayBuffer);
    const outside = new DatabaseSync(f.databaseFile);
    try { outside.exec("UPDATE mb_playback_queue SET revision='2',data=json_set(data,'$.revision','2')"); }
    finally { outside.close(); }
    injected = true;
  });
  await assert.rejects(f.read());
  assert.equal(injected, true); assert.ok(cancellation); assert.equal(Atomics.load(cancellation, 0), 1);
  assert.equal(f.audits(), 1, '竞态故意发生在已获准的复用作业内，原Owner末核必须拒绝它。');
  // 外部提交也会使原Owner证书失效；按原完整核验恢复其资格，保持原结构Actor与连接。
  f.repository.privateMobileCatalogAccess!(db => { verifyLocalCatalogDatabase(db); verifyLocalScanDatabase(db); });
  assert.equal(f.service.privateMobile.revision(), revision, '外部队列写没有改变目录逻辑修订。');
  assert.deepEqual(await f.read(), initial);
  assert.equal(f.audits(), 2, '旧job的撤销SAB必须强制同Actor重新全审，不能留下复用资格。');
  assert.equal(f.workers(), 1, '不得靠替换Actor绕过旧job撤销验证。');
});
