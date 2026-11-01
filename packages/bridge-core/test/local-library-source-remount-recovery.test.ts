import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createCollectionRepository } from '../src/collection/repository.js';
import { recoverLocalLibrarySourceRemounts } from '../src/collection/local-library-source-remount-recovery.js';
import { captureLocalCatalogAuditState, verifyLocalCatalogDatabase } from '../src/collection/local-catalog-store.js';
import { captureLocalScanAuditState, verifyLocalScanDatabase, type ScanPreparedBatch, type ScanPreparedItem } from '../src/collection/local-scan-store.js';
import { currentScanOriginIndex } from '../src/collection/local-scan-origin-index.js';
import { authorizeSourceDirectory, openLocalPlaybackReadonlySource, sourceRootAvailability, type RootCapability } from '../src/recording/source-files.js';
import { isSourceSmbMountEvidence, observeSourceSmbMountEvidence, type SourceSmbMountEvidence } from '../src/recording/source-smb-mount-evidence.js';
import type { LibraryRootRole } from '@music-bridge/contracts';

const share = 'b'.repeat(64);
const evidence = (mountSourceSha256 = share): SourceSmbMountEvidence => ({ version: 1, provider: 'DARWIN_KERNEL_FSTATFS_SMB_V1',
  mountSourceSha256, mountEvidenceSha256: 'c'.repeat(64) });

async function fixture(t: TestContext) {
  const temporary = process.env.TMPDIR;
  assert.ok(temporary && path.isAbsolute(temporary));
  if (process.platform === 'darwin') assert.ok(path.resolve(temporary).startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const directory = await mkdtemp(path.join(temporary, 'library-source-remount-')), filePath = path.join(directory, 'collection.sqlite');
  let db: DatabaseSync | undefined, beforeRemountCommit: (() => void) | undefined;
  const repository = createCollectionRepository({ filePath, beforeCommit(action) {
    if (action === 'reauthorize-source-remount') beforeRemountCommit?.();
  } });
  const connections = [repository];
  t.after(async () => { for (const connection of connections) connection.close(); await rm(directory, { recursive: true, force: true }); });
  let rootNumber = 0;
  async function addRoot(name: string, role: LibraryRootRole = 'library', overrides: Partial<RootCapability> = {}) {
    const media = path.join(directory, name); await mkdir(media);
    const actual = await authorizeSourceDirectory(media);
    const captured = repository.sources.authorize(randomUUID(), { ...actual, dev: (BigInt(actual.dev) + 100n + BigInt(rootNumber++)).toString(), ...overrides });
    const current = { ...actual, id: captured.id }, root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: captured.id, role });
    return { media, captured, current, root };
  }
  const first = await addRoot('合成华语'), relative = '合成原件.wav', file = path.join(first.media, relative), bytes = Buffer.alloc(96);
  bytes.write('RIFF'); bytes.write('WAVE', 8); await writeFile(file, bytes);
  const stat = await lstat(file, { bigint: true }), signature = [first.captured.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  const parserVersion = 'source-remount-recovery-test-v1', datasetId = randomUUID();
  const item: ScanPreparedItem = { relative, signature, parserVersion, outcome: 'accepted',
    fields: { title: '合成歌曲', album: '合成专辑', artist: '合成艺人' }, failureCode: null, reused: false,
    readFacts: { technical: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48000, channels: 2, bitsPerSample: 16,
      durationSeconds: 1, evidence: 'bounded-parser-reported' }, coverEvidence: [],
    readEvidence: { bytesRead: 44, readCalls: 1, maxReadBytes: 44, allocationBytes: 44, elapsedMs: 1, wholeAudioHash: false, wholeAudioDecode: false } } };
  const pending = repository.localScan.start({ commandId: randomUUID(), datasetId, libraryRootId: first.root.id, expectedRootRevision: first.root.revision, parserVersion }).job;
  const running = repository.localScan.resume({ commandId: randomUUID(), jobId: pending.jobId, expectedRevision: pending.jobRevision });
  const batch: ScanPreparedBatch = { batchId: randomUUID(), jobId: running.jobId, expectedJobRevision: running.jobRevision,
    checkpointBefore: running.checkpointRef, items: [item], frontier: [], completed: true };
  repository.localScan.privatePrepareBatch({ commandId: randomUUID(), jobId: running.jobId, batch });
  repository.localScan.privateCommitBatch({ commandId: randomUUID(), jobId: running.jobId, batchId: batch.batchId, expectedRevision: running.jobRevision });
  db = repository.localCatalog.privateRead(database => database);
  const database = db;
  const verify = () => { verifyLocalCatalogDatabase(database); verifyLocalScanDatabase(database); };
  verify();
  const history = () => Object.fromEntries(['local_catalog_assets', 'local_catalog_tracks', 'local_catalog_ledger', 'local_scan_jobs',
    'local_scan_batches', 'local_scan_receipts', 'local_scan_file_state'].map(table => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  return { repository, db: database, first, addRoot, verify, history, relative, signature, filePath, connections,
    beforeRemountCommit: (callback: () => void) => { beforeRemountCommit = callback; } };
}

test('SMB冷恢复：同根原位续接已核审计，冷重开仍可沿旧观察读取且目录历史不变', async t => {
  const f = await fixture(t), before = f.history(), catalog = captureLocalCatalogAuditState(f.db), scan = captureLocalScanAuditState(f.db);
  assert.ok(catalog?.observationHistory); assert.ok(scan?.origins); assert.ok(currentScanOriginIndex(f.db));
  const noRecheck = () => { throw new Error('合法Source两行写不能重放目录历史'); };
  const result = await recoverLocalLibrarySourceRemounts(f.repository, () => {}, { observeMount: async () => evidence(), verifyCatalog: noRecheck, verifyScan: noRecheck });
  assert.equal(result.recovered, 1); assert.equal(result.audit, 'reused');
  const restored = f.repository.sources.root(f.first.captured.id);
  assert.equal(restored.id, f.first.captured.id); assert.equal(restored.ino, f.first.captured.ino);
  assert.equal(restored.dev, f.first.current.dev); assert.ok(restored.readonlyRemountProof?.version === 2);
  assert.equal(restored.readonlyRemountProof.mountSourceSha256, share);
  assert.deepEqual(f.history(), before);
  assert.deepEqual(captureLocalCatalogAuditState(f.db)?.rows, catalog.rows);
  assert.deepEqual(captureLocalScanAuditState(f.db)?.rows, scan.rows);
  assert.ok(captureLocalCatalogAuditState(f.db)?.observationHistory); assert.ok(currentScanOriginIndex(f.db));
  const lease = await openLocalPlaybackReadonlySource(restored, f.relative, f.signature);
  try { await lease.verify(); } finally { await lease.close(); }
  f.repository.close();
  const cold = createCollectionRepository({ filePath: f.filePath }); f.connections.push(cold);
  const root = cold.sources.root(restored.id);
  assert.deepEqual(root, restored); assert.equal(await sourceRootAvailability(root), 'ONLINE');
  const reopened = await openLocalPlaybackReadonlySource(root, f.relative, f.signature);
  try { await reopened.verify(); } finally { await reopened.close(); }
});

test('SMB冷恢复：已有v1可升级，同源多代恢复并回用旧设备号保留初代和中间观察', async t => {
  const f = await fixture(t), middleDev = (BigInt(f.first.current.dev) + 900n).toString();
  const middle = f.repository.sources.privateReauthorizeRemount(randomUUID(), f.first.captured, { ...f.first.current, dev: middleDev }, 'a'.repeat(64));
  assert.equal(middle.readonlyRemountProof?.version, 1); f.verify();
  const first = await recoverLocalLibrarySourceRemounts(f.repository, () => {}, { observeMount: async () => evidence() });
  assert.equal(first.audit, 'reused'); assert.equal(first.recovered, 1);
  let current = f.repository.sources.root(f.first.captured.id);
  assert.ok(current.readonlyRemountProof?.version === 2); assert.deepEqual(current.readonlyRemountProof.previousDevs, [f.first.captured.dev, middleDev]);
  const departedDev = (BigInt(f.first.current.dev) + 901n).toString();
  f.repository.sources.privateReauthorizeRemount(randomUUID(), current, { ...f.first.current, dev: departedDev }, 'd'.repeat(64), share); f.verify();
  const second = await recoverLocalLibrarySourceRemounts(f.repository, () => {}, { observeMount: async () => evidence() });
  assert.equal(second.recovered, 1); assert.equal(second.audit, 'reused');
  current = f.repository.sources.root(f.first.captured.id);
  assert.ok(current.readonlyRemountProof?.version === 2); assert.deepEqual(current.readonlyRemountProof.previousDevs, [f.first.captured.dev, middleDev, departedDev]);
  for (const device of [f.first.captured.dev, middleDev, departedDev]) {
    const signature = [device, ...f.signature.split(':').slice(1)].join(':'), lease = await openLocalPlaybackReadonlySource(current, f.relative, signature);
    try { await lease.verify(); } finally { await lease.close(); }
  }
});

test('SMB冷恢复：分享来源改变、inode改变、撤权和非library根均不恢复，其他根独立可恢复', async t => {
  const f = await fixture(t), bound = f.repository.sources.privateReauthorizeRemount(randomUUID(), f.first.captured,
    { ...f.first.current, dev: (BigInt(f.first.current.dev) + 900n).toString() }, 'a'.repeat(64), share);
  const inode = await f.addRoot('合成错误inode', 'library', { ino: '0' }), revoked = await f.addRoot('合成撤权'), reference = await f.addRoot('合成录音参考', 'recording-reference');
  f.repository.sources.revoke({ commandId: randomUUID(), id: revoked.captured.id });
  const good = await f.addRoot('合成独立来源', 'library', { label: '保留原自定义显示名' }); f.verify();
  const result = await recoverLocalLibrarySourceRemounts(f.repository, () => {}, { observeMount: async root => evidence(root.id === bound.id ? 'e'.repeat(64) : share) });
  assert.equal(result.recovered, 1); assert.equal(result.audit, 'reused');
  assert.deepEqual(f.repository.sources.root(bound.id), bound);
  assert.deepEqual(f.repository.sources.root(inode.captured.id), inode.captured);
  assert.equal(f.repository.sources.root(revoked.captured.id).authorized, false);
  assert.deepEqual(f.repository.sources.root(reference.captured.id), reference.captured);
  assert.equal(await sourceRootAvailability(f.repository.sources.root(good.captured.id)), 'ONLINE');
  assert.equal(f.repository.sources.root(good.captured.id).label, '保留原自定义显示名');
});

test('SMB冷恢复：不可信kernel证据和已断开来源保持离线，不影响另一原根', async t => {
  const f = await fixture(t), unavailable = await f.addRoot('合成已断开'), good = await f.addRoot('合成在线'); f.verify();
  const before = f.repository.sources.root(f.first.captured.id);
  const result = await recoverLocalLibrarySourceRemounts(f.repository, () => {}, { observeMount: async root => {
    if (root.id === unavailable.captured.id) throw new Error('合成SMB挂载未证实');
    if (root.id === before.id) return { ...evidence(), rawSource: '不允许流入证明的挂载文本' } as SourceSmbMountEvidence;
    return evidence();
  } });
  assert.equal(result.recovered, 1); assert.equal(result.failed, 1);
  assert.deepEqual(f.repository.sources.root(before.id), before);
  assert.deepEqual(f.repository.sources.root(unavailable.captured.id), unavailable.captured);
  assert.equal(await sourceRootAvailability(f.repository.sources.root(good.captured.id)), 'ONLINE');
});

test('SMB冷恢复：未知同连接目录写不能被合法Source事务认可，必须完整重核', async t => {
  const f = await fixture(t); f.db.exec('UPDATE local_catalog_tracks SET data=data');
  assert.equal(captureLocalCatalogAuditState(f.db), undefined);
  let catalogChecks = 0, scanChecks = 0;
  const result = await recoverLocalLibrarySourceRemounts(f.repository, () => {}, { observeMount: async () => evidence(),
    verifyCatalog(db, check) { catalogChecks++; verifyLocalCatalogDatabase(db, check); }, verifyScan(db, check) { scanChecks++; verifyLocalScanDatabase(db, check); } });
  assert.equal(result.recovered, 1); assert.equal(result.audit, 'rechecked'); assert.equal(catalogChecks, 1); assert.equal(scanChecks, 1);
  assert.ok(captureLocalCatalogAuditState(f.db)); assert.ok(captureLocalScanAuditState(f.db)); assert.ok(currentScanOriginIndex(f.db));
});

test('SMB冷恢复：原事务内额外scan写及单根回滚不能续借旧审计，成功的其他根仍恢复', async t => {
  const f = await fixture(t), good = await f.addRoot('合成第二根'); f.verify();
  let calls = 0;
  f.beforeRemountCommit(() => {
    if (++calls === 1) throw new Error('合成第一根事务回滚');
    f.db.exec('UPDATE local_scan_file_state SET data=data');
  });
  const result = await recoverLocalLibrarySourceRemounts(f.repository, () => {}, { observeMount: async () => evidence() });
  assert.equal(result.recovered, 1); assert.equal(result.failed, 1); assert.equal(result.audit, 'rechecked');
  assert.deepEqual(f.repository.sources.root(f.first.captured.id), f.first.captured);
  assert.equal(await sourceRootAvailability(f.repository.sources.root(good.captured.id)), 'ONLINE');
  assert.ok(captureLocalCatalogAuditState(f.db)); assert.ok(captureLocalScanAuditState(f.db));
});

test('SMB实际证据：闭集只接收摘要，本地目录不能伪装为共享盘', async t => {
  const f = await fixture(t);
  assert.equal(isSourceSmbMountEvidence(evidence()), true);
  assert.equal(isSourceSmbMountEvidence({ ...evidence(), source: '//不允许输出的挂载文本' }), false);
  assert.equal(isSourceSmbMountEvidence({ ...evidence(), mountSourceSha256: '损坏' }), false);
  const accessor = { ...evidence() }; Object.defineProperty(accessor, 'mountEvidenceSha256', { enumerable: true, get() { throw new Error('禁止调用访问器'); } });
  assert.equal(isSourceSmbMountEvidence(accessor), false);
  await assert.rejects(observeSourceSmbMountEvidence(f.first.current));
});
