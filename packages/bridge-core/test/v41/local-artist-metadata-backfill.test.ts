import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ScanJobRecord } from '@music-bridge/contracts';
import { createArtistMetadataBackfillCoordinator } from '../../src/collection/local-artist-metadata-backfill.js';
import { ArtistMetadataBackfillDeferred, type ArtistMetadataBackfillCandidate } from '../../src/collection/local-artist-metadata-types.js';
import type { CollectionRepository } from '../../src/collection/repository.js';
import type { MetadataReadResult } from '../../src/library/metadata-reader-types.js';
import { RUST_MEDIA_METADATA_PARSER_VERSION } from '../../src/library/metadata-reader-types.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const success = (): MetadataReadResult => ({ status: 'ok', parserVersion: RUST_MEDIA_METADATA_PARSER_VERSION,
  fields: { artist: '周杰伦', artists: ['周杰伦'], albumArtist: 'Various Artists', albumArtists: ['Various Artists'] },
  technical: { container: 'FLAC', codec: 'FLAC', lossless: true, sampleRateHz: 44100, channels: 2, bitsPerSample: 16, durationSeconds: 10, evidence: 'bounded-parser-reported' },
  coverEvidence: [], readEvidence: { bytesRead: 10, readCalls: 1, maxReadBytes: 10, allocationBytes: 10, elapsedMs: 1, wholeAudioHash: false, wholeAudioDecode: false } });
function temporaryDirectory(): string {
  const root = path.join(process.env.DEV_BUILD_ROOT ?? '/Volumes/LifeWeave/Developer/CommandLine', 'tmp');
  mkdirSync(root, { recursive: true }); return mkdtempSync(path.join(root, 'mousa41-artist-backfill-'));
}
function fixture(count = 3) {
  let highWater = 10;
  const candidates: ArtistMetadataBackfillCandidate[] = Array.from({ length: count }, (_, n) => ({ ordinal: n + 1,
    track: { id: id(n + 1), assetId: id(n + 101), selectionRevision: '1', segment: null },
    asset: { id: id(n + 101), libraryRootId: id(1001), sourceRootId: id(1002), rootRevision: '1', fileRevision: '1', locationRevision: '1', sampleFrames: null, timebaseHz: null },
    relative: `${n + 1}.flac`, signature: `signature-${n + 1}`, scanJobId: id(2001), complete: false }));
  const commits: string[] = [];
  const collection = { localCatalog: {
    privateArtistSearchChanges: () => ({ highWater, rebuild: false, trackIds: [] }),
    privateArtistMetadataBackfillCandidates: (after: number, limit: number) => {
      const rest = candidates.filter(candidate => candidate.ordinal > after);
      return { items: rest.slice(0, limit).map(candidate => structuredClone(candidate)), hasMore: rest.length > limit };
    },
    privateCommitArtistMetadataBackfill: (candidate: ArtistMetadataBackfillCandidate) => {
      candidates.find(value => value.track.id === candidate.track.id)!.complete = true; commits.push(candidate.track.id); highWater++;
    },
  } } as unknown as CollectionRepository;
  return { collection, candidates, commits, restore() { highWater = 1; candidates.forEach(candidate => { candidate.complete = false; }); } };
}

test('补读按真实提交推进持久游标，重开继续且失败不会被报告为完成', async t => {
  const directory = temporaryDirectory(); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = fixture(), reads: string[] = [];
  const options = { collection: f.collection, directory, assertCurrent() {}, read: async (candidate: ArtistMetadataBackfillCandidate): Promise<MetadataReadResult> => {
    reads.push(candidate.track.id); return candidate.ordinal === 2 ? { status: 'failure', code: 'PARSE_FAILED', readEvidence: null } : success();
  } };
  const first = createArtistMetadataBackfillCoordinator(options);
  assert.equal((await first.runBatch(1)).cursor, 1); await first.close();
  const resumed = createArtistMetadataBackfillCoordinator(options); t.after(() => resumed.close());
  await resumed.runBatch(1); const result = await resumed.runBatch(1);
  assert.equal(result.cursor, 3); assert.equal(result.succeeded, 2); assert.equal(result.failed, 1);
  assert.equal(result.enumerationComplete, true); assert.equal(result.phase, 'needs-attention');
  assert.deepEqual(reads, [id(1), id(2), id(3)]); assert.deepEqual(f.commits, [id(1), id(3)]);
});

test('媒体忙保留pending与原游标，后续受理成功才记作已补读', async t => {
  const f = fixture(1); let busy = true;
  const coordinator = createArtistMetadataBackfillCoordinator({ collection: f.collection, directory: null, assertCurrent() {},
    read: async () => { if (busy) throw new ArtistMetadataBackfillDeferred(); return success(); } });
  t.after(() => coordinator.close());
  const deferred = await coordinator.runBatch(1);
  assert.equal(deferred.phase, 'paused'); assert.equal(deferred.cursor, 0); assert.equal(deferred.pending, 1); assert.equal(deferred.failed, 0);
  busy = false; const done = await coordinator.runBatch(1);
  assert.equal(done.phase, 'completed'); assert.equal(done.succeeded, 1); assert.equal(f.commits.length, 1);
});

test('主库恢复到旧版本时，sidecar旧成功不能跳过已回退的原元数据', async t => {
  const directory = temporaryDirectory(); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = fixture(1); let reads = 0;
  const options = { collection: f.collection, directory, assertCurrent() {}, read: async () => { reads++; return success(); } };
  const first = createArtistMetadataBackfillCoordinator(options); await first.runBatch(1); await first.close();
  f.restore(); const restored = createArtistMetadataBackfillCoordinator(options); t.after(() => restored.close());
  const result = await restored.runBatch(1);
  assert.equal(reads, 2); assert.equal(result.phase, 'completed'); assert.equal(f.commits.length, 2);
});

test('Reader未确认关闭的失败停在pending，不推进或继续下一文件', async t => {
  const f = fixture(); let reads = 0;
  const coordinator = createArtistMetadataBackfillCoordinator({ collection: f.collection, directory: null, assertCurrent() {}, read: async () => {
    reads++; return { status: 'failure', code: 'LEASE_RELEASE_FAILED', readEvidence: null };
  } }); t.after(() => coordinator.close());
  await assert.rejects(coordinator.runBatch(3));
  assert.equal(reads, 1); const state = coordinator.status();
  assert.equal(state.cursor, 0); assert.equal(state.pending, 1); assert.equal(state.failed, 0); assert.equal(state.phase, 'needs-attention');
});

test('立即失败的补读批次仍让前台事件插入，忙时保留下一条原游标', async t => {
  const f = fixture(25); let foreground = false, reads = 0;
  const coordinator = createArtistMetadataBackfillCoordinator({ collection: f.collection, directory: null, assertCurrent() {},
    isBusy: () => foreground,
    read: async () => {
      reads++;
      setImmediate(() => { foreground = true; });
      return { status: 'failure', code: 'CONTENT_CHANGED', readEvidence: null };
    },
  });
  t.after(() => coordinator.close());
  const state = await coordinator.runBatch(25);
  assert.equal(reads, 1, '立即返回的失败不能用微任务连续占满原Owner');
  assert.equal(state.cursor, 1); assert.equal(state.failed, 1); assert.equal(state.phase, 'paused');
});

const completedScan = (n = 1): ScanJobRecord => ({ schemaVersion: '1.2', jobId: id(3000 + n), datasetId: id(4001),
  libraryRootId: id(1001), sourceRootId: id(1002), rootRevision: '1', jobRevision: '5', checkpointRef: null,
  progress: { visited: '3', accepted: '3', rejected: '0' }, phase: 'completed', failureCode: null });
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test('已完成游标只由新扫描回执回退，完整数组不读FD且原失败pin不盲重试', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const directory = temporaryDirectory(); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = fixture(), reads: string[] = []; let recovered = false, checks = 0;
  const options = { collection: f.collection, directory, assertCurrent() {}, read: async (candidate: ArtistMetadataBackfillCandidate): Promise<MetadataReadResult> => {
    reads.push(candidate.track.id); return recovered ? success() : { status: 'failure', code: 'CONTENT_CHANGED', readEvidence: null };
  } };
  const first = createArtistMetadataBackfillCoordinator(options);
  const failed = await first.runBatch(3); assert.equal(failed.enumerationComplete, true); assert.equal(failed.failed, 3);
  const job = completedScan(); recovered = true;
  f.candidates[0]!.complete = true;
  f.candidates[1]!.scanJobId = job.jobId; f.candidates[1]!.signature = '新扫描已确认的签名';
  await first.recoverAfterScan(job, () => { checks++; });
  assert.equal(first.status().cursor, 0); assert.equal(first.status().enumerationComplete, false); assert.equal(checks, 2);
  const repaired = await first.runBatch(3);
  assert.equal(repaired.succeeded, 2); assert.equal(repaired.failed, 1); assert.equal(repaired.enumerationComplete, true);
  assert.deepEqual(reads, [id(1), id(2), id(3), id(2)]);
  await first.recoverAfterScan(job, () => {});
  assert.equal(first.status().cursor, 3); assert.equal(first.status().enumerationComplete, true);
  await first.close();
  const reopened = createArtistMetadataBackfillCoordinator(options); t.after(() => reopened.close());
  reopened.start(); await reopened.recoverAfterScan(job, () => {});
  assert.equal(reopened.status().cursor, 3); await reopened.runBatch(3);
  assert.deepEqual(reads, [id(1), id(2), id(3), id(2)], '重启和同扫描重复通知不能重读旧失败');
  await assert.rejects(reopened.recoverAfterScan({ ...job, sourceRootId: id(9999) }, () => {}), /原扫描身份已变化/u);
});

test('人工暂停跨恢复事件和重启持久保留，交互resume与Main启动不能解除', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const directory = temporaryDirectory(); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = fixture(1); let reads = 0;
  const options = { collection: f.collection, directory, assertCurrent() {}, read: async (): Promise<MetadataReadResult> => {
    reads++; return { status: 'failure', code: 'CONTENT_CHANGED', readEvidence: null };
  } };
  const first = createArtistMetadataBackfillCoordinator(options); await first.runBatch(1); await first.pause();
  const job = completedScan(); f.candidates[0]!.scanJobId = job.jobId;
  await first.recoverAfterScan(job, () => {}); first.start();
  await first.suspend(); first.resume();
  assert.equal((await first.runBatch(1)).phase, 'paused'); assert.equal(first.status().cursor, 0); assert.equal(reads, 1);
  await first.close();
  const reopened = createArtistMetadataBackfillCoordinator(options); t.after(() => reopened.close());
  reopened.start(); reopened.resume(); t.mock.timers.tick(0); await turn();
  assert.equal((await reopened.runBatch(1)).phase, 'paused'); assert.equal(reads, 1);
  assert.equal(reopened.status().failed, 1, '旧失败明细不能在迁移或恢复时被清除');
});

test('交互借用时完成事件只登记，归还后仍等待原自动启动资格', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(1); let reads = 0;
  const coordinator = createArtistMetadataBackfillCoordinator({ collection: f.collection, directory: null, assertCurrent() {},
    read: async () => { reads++; return success(); } }); t.after(() => coordinator.close());
  await coordinator.suspend(); await coordinator.recoverAfterScan(completedScan(), () => {});
  assert.equal((await coordinator.runBatch(1)).phase, 'paused'); coordinator.resume();
  t.mock.timers.tick(0); await turn(); assert.equal(reads, 0, 'resume不能替代本代Main-ready的首次start');
  coordinator.start(); t.mock.timers.tick(0);
  const result = await coordinator.runBatch(1); assert.equal(result.succeeded, 1); assert.equal(reads, 1);
});

test('恢复等待前后都核原Owner资格，迟到完成不能登记失效扫描', async t => {
  const f = fixture(1); let release!: () => void, entered!: () => void, valid = true, checks = 0;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const coordinator = createArtistMetadataBackfillCoordinator({ collection: f.collection, directory: null, assertCurrent() {},
    read: async () => { entered(); await gate; return success(); } }); t.after(async () => { release(); await coordinator.close(); });
  const batch = coordinator.runBatch(1); await ready;
  const recovery = coordinator.recoverAfterScan(completedScan(), () => { checks++; if (!valid) throw new Error('原Owner修订已变化'); });
  const rejected = assert.rejects(recovery, /原Owner修订已变化/u); valid = false; release();
  await batch; await rejected; assert.equal(checks, 2); assert.equal(coordinator.status().cursor, 1);
  assert.equal(coordinator.status().enumerationComplete, true);
  valid = true; await coordinator.recoverAfterScan(completedScan(), () => {});
  assert.equal(coordinator.status().cursor, 0, '失效事件不能提前占用持久去重回执');
});

test('关闭中等待FD安全退出，迟到恢复和读取结果均不能再提交', async t => {
  const directory = temporaryDirectory(); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = fixture(1); let release!: () => void, entered!: () => void, aborted = false, closed = false;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const coordinator = createArtistMetadataBackfillCoordinator({ collection: f.collection, directory, assertCurrent() {},
    read: async (_candidate, signal) => { signal.addEventListener('abort', () => { aborted = true; }, { once: true }); entered(); await gate; return success(); } });
  t.after(async () => { release(); await coordinator.close(); });
  const batch = coordinator.runBatch(1); await ready;
  const recovery = coordinator.recoverAfterScan(completedScan(), () => {});
  const rejected = assert.rejects(recovery, /已关闭/u);
  const closing = coordinator.close().then(() => { closed = true; }); await turn();
  assert.equal(aborted, true); assert.equal(closed, false); assert.deepEqual(f.commits, []);
  release(); await batch; await rejected; await closing; assert.deepEqual(f.commits, []);
  const db = new DatabaseSync(path.join(directory, 'metadata-backfill.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) n FROM completed_scans').get()!.n, 0);
    assert.equal(db.prepare('SELECT cursor FROM progress WHERE id=1').get()!.cursor, 0);
  } finally { db.close(); }
});

test('已有v1 sidecar增量接纳控制与去重表，原失败明细游标不重建', async t => {
  const directory = temporaryDirectory(); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'metadata-backfill.sqlite'), old = new DatabaseSync(file);
  old.exec(`CREATE TABLE progress(id INTEGER PRIMARY KEY CHECK(id=1),cursor INTEGER NOT NULL,enumeration_complete INTEGER NOT NULL CHECK(enumeration_complete IN(0,1)),owner_high_water INTEGER NOT NULL) STRICT;
    INSERT INTO progress VALUES(1,1,1,10);
    CREATE TABLE entries(track_id TEXT PRIMARY KEY,pin TEXT NOT NULL,ordinal INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN('pending','succeeded','failed')),code TEXT,attempts INTEGER NOT NULL) STRICT;
    PRAGMA application_id=1296187718; PRAGMA user_version=1`);
  old.prepare('INSERT INTO entries VALUES(?,?,?,?,?,?)').run(id(1), '原失败pin', 1, 'failed', 'CONTENT_CHANGED', 7); old.close();
  const f = fixture(1); let reads = 0;
  const coordinator = createArtistMetadataBackfillCoordinator({ collection: f.collection, directory, assertCurrent() {},
    read: async () => { reads++; return success(); } });
  const status = coordinator.status(); assert.equal(status.cursor, 1); assert.equal(status.failed, 1); assert.equal(status.enumerationComplete, true);
  await coordinator.runBatch(1); assert.equal(reads, 0); await coordinator.close();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 1);
    assert.deepEqual({ ...db.prepare('SELECT * FROM entries').get()! }, { track_id: id(1), pin: '原失败pin', ordinal: 1, status: 'failed', code: 'CONTENT_CHANGED', attempts: 7 });
    assert.equal(db.prepare('SELECT manual_paused FROM backfill_control WHERE id=1').get()!.manual_paused, 0);
  } finally { db.close(); }
});
