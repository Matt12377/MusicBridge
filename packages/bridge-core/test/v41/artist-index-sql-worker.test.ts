import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MessageChannel, Worker, type MessagePort } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import * as dto from '@music-bridge/contracts';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createBackupWorkflowStore } from '../../src/recording/backup-workflow-store.js';
import { createLocalCatalogStore, verifyLocalCatalogDatabase } from '../../src/collection/local-catalog-store.js';
import { createLocalAlbumOwnerService } from '../../src/collection/local-album-browser/owner-port.js';
import { LocalAlbumReadError } from '../../src/collection/local-album-browser/grouping.js';
import type { LocalAlbumSqlMobileQuery, LocalAlbumLyricsInventory } from '../../src/collection/local-album-browser/sql-types.js';
import type { LocalLyricsInventoryRecord } from '../../src/collection/local-library-workbench/owner-journal.js';
import { seedMobileSqlWaveLibrary } from '../helpers/mobile-sql-owned-wave-library.js';
import { readLibraryOperationLine } from '../../src/shared/library-operation-log.js';

const query = (kind: LocalAlbumSqlMobileQuery['kind'] = 'groups'): LocalAlbumSqlMobileQuery => ({ kind, offset: 0, limit: 100,
  query: '', rootId: null, albumKey: null, trackId: null, editionId: null, groupHash: null });
const rejectedSnapshot = (error: unknown) => error instanceof LocalAlbumReadError && error.code === 'SNAPSHOT_CHANGED';

// 真实只读线程与合成扫描/歌词账本；不连接正式库、Provider、App 或设备。
async function fixture(t: test.TestContext, fault = 'normal') {
  assert.ok(process.env.TMPDIR?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const directory = await mkdtemp(path.join(process.env.TMPDIR!, 'artist-index-worker-')), databaseFile = path.join(directory, 'catalog.sqlite');
  const repository = createCollectionRepository({ filePath: databaseFile });
  repository.localCatalog.roots();
  const maintenance = createBackupWorkflowStore({ filePath: path.join(directory, 'maintenance.sqlite') });
  const identity = maintenance.datasetIdentities.bind('default', databaseFile, false), datasetId = identity.datasetId;
  repository.localCatalog.privateBindWorkbenchDataset(identity);
  const seeded = await seedMobileSqlWaveLibrary(repository, datasetId, path.join(directory, '合成来源'), false,
    ['全有词/1.wav', '无词/2.wav', '未观察/3.wav']);
  for (const trackId of seeded.trackIds) repository.localCatalog.observeMetadata({ commandId: randomUUID(), trackId,
    source: 'synthetic', parserVersion: 'artist-index-v1', fields: { year: '2001', artists: ['合成艺人', '客座艺人'], albumArtists: ['专辑艺人'] } });
  const rows = seeded.trackIds.map(trackId => {
    const detail = repository.localCatalog.track(trackId), asset = repository.localCatalog.asset(detail.assetId);
    return { trackId, rootId: seeded.rootId, fileRevision: asset.fileRevision };
  });
  const inventory: LocalLyricsInventoryRecord = { scope: { datasetId, libraryId: seeded.rootId, albumId: randomUUID(), captureId: randomUUID() },
    captureFingerprint: createHash('sha256').update('合成原歌词库存').digest('hex'), revision: 0,
    observations: rows.map((row, index) => ({ trackId: row.trackId, fileRevision: row.fileRevision,
      lrc: index === 0 ? 'true' : index === 1 ? 'false' : 'unknown', embedded: index === 2 ? 'unknown' : 'false' })) };
  repository.localCatalog.privateLyricsCompareAndSwap(datasetId, 'inventory', inventory, null);
  const lyrics: LocalAlbumLyricsInventory = { revision: () => repository.localCatalog.privateLyricsInventoryRevision(datasetId),
    read: (trackId, rootId, revision) => repository.localCatalog.privateLyricsInventoryRead(datasetId, trackId, rootId, revision) };
  const gate = new Int32Array(new SharedArrayBuffer(7 * 4)), stages: string[] = [], ports: MessagePort[] = [];
  const stats = { indexCreated: 0, mobileCreated: 0, indexExited: [] as number[], logs: [] as NonNullable<ReturnType<typeof readLibraryOperationLine>>[] };
  const listeners = new Map<string, Array<() => void>>();
  let controller: MessagePort | undefined, cancellation: Int32Array | undefined, saved: 'available' | 'missing' | null = null;
  const record = (name: string) => { stages.push(name); for (const resolve of listeners.get(name) ?? []) resolve(); listeners.delete(name); };
  const event = (name: string) => stages.includes(name) ? Promise.resolve() : new Promise<void>(resolve => listeners.set(name, [...listeners.get(name) ?? [], resolve]));
  const service = createLocalAlbumOwnerService({ repository, datasetId, lyricsInventory: lyrics, assertCurrent: () => identity.assertCurrent(),
    mobileSqlWorker: { databaseFile, workerFactory(options) {
      const index = options.workerData.purpose === 'artist-index';
      if (!index) { stats.mobileCreated++; return new Worker(new URL('../../src/collection/local-album-browser/mobile-sql-worker-entry.ts', import.meta.url), { ...options, execArgv: ['--import', 'tsx'] }); }
      stats.indexCreated++;
      const channel = new MessageChannel(); ports.push(channel.port1); controller = channel.port1;
      channel.port1.on('message', value => record(value.type));
      const worker = new Worker(new URL('../helpers/mobile-sql-lifecycle-worker-fixture.ts', import.meta.url), { ...options, stdout: true, execArgv: ['--import', 'tsx'],
        workerData: { ...options.workerData, testLifecycleFault: fault, testLifecycleControl: channel.port2, testLifecycleGate: gate.buffer }, transferList: [channel.port2] });
      let changedAfterRollback = false;
      worker.on('message', message => {
        // 比真实 Worker 的末点更晚、比 actor 的 receive 更早；只改变主库物理点，不改变公开专辑修订。
        if (fault === 'owner-unrelated-change' && !changedAfterRollback && message?.type === 'result') {
          changedAfterRollback = true;
          repository.localCatalog.privateRead(db => db.prepare('UPDATE local_catalog_tracks SET data=data WHERE id=?').run(rows[0]!.trackId));
          record('owner.unrelated-commit');
        }
      });
      let tail = '';
      worker.stdout!.on('data', chunk => { tail += String(chunk); const lines = tail.split('\n'); tail = lines.pop() ?? ''; for (const line of lines) { const row = readLibraryOperationLine(line); if (row) stats.logs.push(row); } });
      const post = worker.postMessage.bind(worker);
      worker.postMessage = ((message: unknown, ...rest: unknown[]) => {
        const value = message as { type?: string; cancellation?: SharedArrayBuffer };
        if (value.type === 'job' && value.cancellation) cancellation = new Int32Array(value.cancellation);
        Reflect.apply(post, worker, [message, ...rest]);
      }) as Worker['postMessage'];
      worker.on('exit', code => { stats.indexExited.push(code); }); return worker;
    } },
    savedArtworkInventory: { revision: () => String(saved), read: () => saved },
    async readRootViews() { return [{ root: repository.localCatalog.root(seeded.rootId), label: '原作者合成来源', availability: 'ONLINE' }]; },
    async readArtwork() { return { image: null, status: 'ready' }; },
  });
  const release = () => { controller?.postMessage('释放受控闸门'); Atomics.store(gate, 2, 1); Atomics.notify(gate, 2); };
  const close = () => Promise.all([service.privateMobile.closeIndex?.(), service.privateMobile.closeStructure?.()]);
  t.after(async () => { release(); try { await close(); } finally { service.close(); repository.close(); maintenance.close(); for (const port of ports) port.close(); await rm(directory, { recursive: true, force: true }); } });
  await service.privateMobile.refresh();
  assert.equal(typeof service.privateMobile.indexRead, 'function', '持久 Owner 必须安装独立异步索引入口。');
  return { directory, databaseFile, repository, service, datasetId, rows, lyrics, stats, gate, event, stages, release, close,
    cancellation: () => cancellation, setSaved: (value: 'available' | 'missing' | null) => { saved = value; }, arm: () => { Atomics.store(gate, 0, 1); Atomics.store(gate, 2, 0); } };
}

test('艺人索引读取保留原完整专辑/歌词/成员，并复用独立 actor 与目录快路', { timeout: 25_000 }, async t => {
  const f = await fixture(t);
  assert.equal(f.stats.indexCreated, 0, '构造与 Root refresh 不应提前启动索引审计。');
  await f.service.privateMobile.prepare!();
  assert.equal(f.stats.indexCreated, 0, '原移动 startup prepare 不得夹带索引审计。');
  const baseline = f.service.privateMobile.current(query());
  assert.deepEqual(new Set(baseline.items.map(row => row.album.lyricsPresence)), new Set(['true', 'false', 'unknown']));
  assert.ok(baseline.items.every(row => row.album.year === '2001' && row.album.sourceLabel === '原作者合成来源' && row.album.kind === 'source-directory'));
  assert.deepEqual(await f.service.privateMobile.indexRead!(query()), baseline);
  const members = f.service.privateMobile.current(query('members'));
  assert.deepEqual(await f.service.privateMobile.indexRead!(query('members')), members);
  assert.deepEqual(await f.service.privateMobile.indexRead!(query('members')), members);
  assert.equal(f.stats.indexCreated, 1); assert.equal(f.stats.mobileCreated, 1);
  assert.equal(f.stages.filter(name => name === 'lifecycle.audit-begin').length, 1);
  await f.close();
  assert.deepEqual(f.stats.indexExited, [0]);
  assert.equal(f.stats.logs.filter(row => row.action === 'albums.compact-groups' && row.code === 'COMPACT_BUILT').length, 1);
  assert.ok(f.stats.logs.some(row => row.action === 'albums.mobile-members' && row.code === 'DIRECTORY_FAST'));
});

test('艺人索引的原歌词窄口只接已审计只读事务，库存真值及失效语义不降级', { timeout: 20_000 }, async t => {
  const f = await fixture(t), db = new DatabaseSync(f.databaseFile, { readOnly: true, enableForeignKeyConstraints: true, allowExtension: false });
  db.exec('PRAGMA query_only=ON;PRAGMA trusted_schema=OFF');
  verifyLocalCatalogDatabase(db);
  const store = createLocalCatalogStore({ read: read => read(db), sources: { root() { throw new Error('索引不能读取 Source 能力。'); } }, conflict(message) { throw new Error(message); } });
  const read = <T>(operation: (view: LocalAlbumLyricsInventory) => T, revision = f.lyrics.revision()) => store.privateWithArtistIndexLyricsRead(f.datasetId, revision, () => {}, operation);
  assert.throws(() => read(() => null), rejectedSnapshot, '无事务不可借用已审计快照。');
  db.exec('BEGIN');
  try {
    let retained: LocalAlbumLyricsInventory | undefined;
    assert.deepEqual(read(view => { retained = view; return f.rows.map(row => view.read(row.trackId, row.rootId, row.fileRevision)); }), ['true', 'false', 'unknown']);
    assert.throws(() => retained!.read(f.rows[0]!.trackId, f.rows[0]!.rootId, f.rows[0]!.fileRevision), rejectedSnapshot);
    assert.throws(() => read(() => null, '999999'), rejectedSnapshot, '水位不匹配必须拒绝，不能造 unknown。');
    assert.throws(() => read(async () => '不得跨 await'), rejectedSnapshot);
    assert.equal(read(view => view.read(f.rows[0]!.trackId, randomUUID(), f.rows[0]!.fileRevision)), 'unknown');
    assert.equal(read(view => view.read(f.rows[0]!.trackId, f.rows[0]!.rootId, '过期文件修订')), 'unknown');
  } finally { db.exec('ROLLBACK'); db.close(); }
});

test('艺人索引 SQL 在途时原移动 actor 可响应，sidecar 写入不误改主库快照', { timeout: 25_000 }, async t => {
  const f = await fixture(t, 'sql-hold'); await f.service.privateMobile.prepare!(); f.arm();
  const stamp = f.repository.readonlySnapshotStamp(), reading = f.service.privateMobile.indexRead!(query());
  await f.event('sql.entered');
  const sidecar = new DatabaseSync(path.join(f.directory, 'artist-sidecar.sqlite'));
  try { sidecar.exec('CREATE TABLE facts(id TEXT PRIMARY KEY) STRICT;BEGIN IMMEDIATE;INSERT INTO facts VALUES (\'合成派生索引\');COMMIT'); }
  finally { sidecar.close(); }
  assert.deepEqual(f.repository.readonlySnapshotStamp(), stamp);
  let timer: ReturnType<typeof setTimeout> | undefined, mobile: unknown;
  try { mobile = await Promise.race([f.service.privateMobile.structure!(query()), new Promise(resolve => { timer = setTimeout(() => resolve(null), 1000); })]); }
  finally { if (timer) clearTimeout(timer); f.release(); }
  assert.ok(mobile, '索引慢 SQL 不得挤占原移动结构 actor。');
  assert.deepEqual(await reading, f.service.privateMobile.current(query()));
});

test('艺人索引回包后重新进入 Owner 真实封面库存 frame', { timeout: 25_000 }, async t => {
  const f = await fixture(t, 'sql-hold'); f.arm();
  const reading = f.service.privateMobile.indexRead!(query()); await f.event('sql.entered'); f.setSaved('available'); f.release();
  const result = await reading;
  assert.deepEqual(result, f.service.privateMobile.current(query()));
  assert.ok(result.items.every(row => row.album.artworkAvailable && row.album.artworkState === 'available' && row.album.statuses.includes('has-artwork')));
});

test('艺人索引共享 builder 撤销进入真实 SQL UDF，回滚后可复用 actor', { timeout: 25_000 }, async t => {
  const f = await fixture(t, 'sql-hold'), lifetime = new AbortController(); f.arm();
  const reading = f.service.privateMobile.indexRead!(query(), lifetime.signal).then(value => ({ value }), error => ({ error }));
  await f.event('sql.entered'); lifetime.abort();
  try {
    for (let n = 0; n < 100 && (!f.cancellation() || Atomics.load(f.cancellation()!, 0) === 0); n++) await delay(10);
    assert.equal(Atomics.load(f.cancellation()!, 0), 1, '共享 builder 的停止必须传到当前真实 SQL 作业。');
  } finally { f.release(); }
  const result = await reading; assert.ok('error' in result && rejectedSnapshot(result.error));
  assert.ok(f.stages.includes('lifecycle.rollback'));
  assert.equal((await f.service.privateMobile.indexRead!(query())).total, 3);
  assert.equal(f.stats.indexCreated, 1);
});

test('艺人索引跨 await 的主库变更拒绝旧页，下次读取重新审计', { timeout: 25_000 }, async t => {
  const f = await fixture(t, 'sql-hold'); f.arm();
  const reading = f.service.privateMobile.indexRead!(query()).then(value => ({ value }), error => ({ error }));
  await f.event('sql.entered');
  try { f.repository.localCatalog.observeMetadata({ commandId: randomUUID(), trackId: f.rows[0]!.trackId,
    source: 'synthetic', parserVersion: 'artist-index-v2', fields: { title: 'Owner 已更新的曲目' } }); }
  finally { f.release(); }
  const result = await reading; assert.ok('error' in result && rejectedSnapshot(result.error));
  assert.deepEqual(await f.service.privateMobile.indexRead!(query('members')), f.service.privateMobile.current(query('members')));
  assert.equal(f.stages.filter(name => name === 'lifecycle.audit-begin').length, 2);
});

test('艺人索引末帧保留主库物理点围栏，公开修订相同也拒绝迟到页', { timeout: 25_000 }, async t => {
  const f = await fixture(t, 'owner-unrelated-change'), revision = f.service.privateMobile.revision(), stamp = f.repository.readonlySnapshotStamp();
  await assert.rejects(f.service.privateMobile.indexRead!(query()), rejectedSnapshot);
  assert.ok(f.stages.includes('owner.unrelated-commit'));
  assert.equal(f.service.privateMobile.revision(), revision);
  assert.notDeepEqual(f.repository.readonlySnapshotStamp(), stamp, '不能只靠同一公开 revision 接纳异步页。');
  assert.deepEqual(await f.service.privateMobile.indexRead!(query()), f.service.privateMobile.current(query()));
});

test('艺人索引关闭必须等原连接关闭与真实线程 exit', { timeout: 25_000 }, async t => {
  const f = await fixture(t, 'exit-hold'); await f.service.privateMobile.indexRead!(query());
  let settled = false;
  const closing = f.close().then(() => { settled = true; }); await f.event('lifecycle.exit-held');
  try { await delay(50); assert.equal(settled, false); assert.ok(f.stages.includes('lifecycle.closed')); assert.deepEqual(f.stats.indexExited, []); }
  finally { f.release(); }
  await closing; assert.deepEqual(f.stats.indexExited, [0]);
});
