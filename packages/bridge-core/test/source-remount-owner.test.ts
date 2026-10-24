import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isMobileTrack } from '@music-bridge/contracts';
import { createCollectionRepository } from '../src/collection/repository.js';
import { verifyLocalCatalogDatabase } from '../src/collection/local-catalog-store.js';
import { verifyLocalScanDatabase, type ScanPreparedBatch, type ScanPreparedItem } from '../src/collection/local-scan-store.js';
import { createLocalSourceTickets } from '../src/collection/local-source-tickets.js';
import { isLocalSourceCaptureResult, type LocalSourceCaptureResult } from '../src/collection/local-source-ticket-types.js';
import { authorizeSourceDirectory, readonlySourceCatalogFileAvailable } from '../src/recording/source-files.js';
import { LocalFileSourcePool } from '../src/stream/local-file-source.js';
import { createMobileOwnerService } from '../src/mobile/owner-service.js';
import type { MobileOwnerPrivateResult } from '../src/mobile/types.js';

const historicalTables = ['local_catalog_assets', 'local_catalog_tracks', 'local_catalog_ledger', 'local_scan_jobs',
  'local_scan_batches', 'local_scan_receipts', 'local_scan_checkpoints', 'local_scan_file_state'];
function firstTrack(page: MobileOwnerPrivateResult) {
  assert.ok(!('kind' in page) && 'items' in page);
  const item = page.items[0]; assert.ok(isMobileTrack(item)); return item;
}

/** 自有 PCM 原件和原扫描提交；仅旧挂载 dev 是合成历史输入，另外四项全部取当前真实 stat。 */
async function fixture(t: test.TestContext) {
  const temporary = process.env.TMPDIR;
  if (typeof temporary !== 'string' || !temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/')) throw new Error('合成重挂载库只能使用外置临时目录。');
  const directory = await mkdtemp(path.join(temporary, 'source-remount-owner-')), media = path.join(directory, '合成来源');
  const databaseFile = path.join(directory, 'collection.sqlite'), datasetId = randomUUID(), ownerEpoch = randomUUID();
  const owners: Array<{ close(): Promise<void> }> = [];
  t.after(async () => { for (const owner of owners) await owner.close(); await rm(directory, { recursive: true, force: true }); });
  function openOwner() {
    const repository = createCollectionRepository({ filePath: databaseFile }), pool = new LocalFileSourcePool();
    const tickets = createLocalSourceTickets(repository, ownerEpoch, datasetId, () => {});
    const catalog = createMobileOwnerService({ collection: repository, datasetId, ownerEpoch, assertCurrent() {} });
    let closed = false;
    const owner = { repository, pool, tickets, catalog, async close() {
      if (closed) return;
      await pool.close(); tickets.seal(); repository.close(); closed = true;
    } };
    owners.push(owner); return owner;
  }
  const owner = openOwner(), { repository } = owner;
  await mkdir(media, { mode: 0o700 });
  const relative = '合成原件.wav', bytes = Buffer.alloc(44 + 480 * 4);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22); bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(192000, 28);
  bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  await writeFile(path.join(media, relative), bytes, { flag: 'wx', mode: 0o600 });
  const currentCapability = await authorizeSourceDirectory(media), stat = await lstat(path.join(media, relative), { bigint: true });
  assert.equal(String(stat.dev), currentCapability.dev);
  const previousDev = (BigInt(currentCapability.dev) + 9000n).toString();
  const captured = repository.sources.authorize(randomUUID(), { ...currentCapability, dev: previousDev });
  const current = { ...currentCapability, id: captured.id };
  const signature = [previousDev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: captured.id, role: 'library' });
  const parserVersion = 'source-remount-owner-wave-v1';
  const item: ScanPreparedItem = { relative, signature, parserVersion, outcome: 'accepted',
    fields: { title: '重挂载原曲目', album: '合成原专辑', artist: '合成艺人' }, failureCode: null, reused: false,
    readFacts: { technical: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48000, channels: 2, bitsPerSample: 16,
      durationSeconds: 0.01, evidence: 'bounded-parser-reported' }, coverEvidence: [],
    readEvidence: { bytesRead: 44, readCalls: 1, maxReadBytes: 44, allocationBytes: 44, elapsedMs: 1, wholeAudioHash: false, wholeAudioDecode: false } } };
  const pending = repository.localScan.start({ commandId: randomUUID(), datasetId, libraryRootId: root.id, expectedRootRevision: root.revision, parserVersion }).job;
  const running = repository.localScan.resume({ commandId: randomUUID(), jobId: pending.jobId, expectedRevision: pending.jobRevision });
  const batch: ScanPreparedBatch = { batchId: randomUUID(), jobId: running.jobId, expectedJobRevision: running.jobRevision,
    checkpointBefore: running.checkpointRef, items: [item], frontier: [], completed: true };
  repository.localScan.privatePrepareBatch({ commandId: randomUUID(), jobId: running.jobId, batch });
  const completed = repository.localScan.privateCommitBatch({ commandId: randomUUID(), jobId: running.jobId, batchId: batch.batchId, expectedRevision: running.jobRevision });
  assert.equal(completed.phase, 'completed');
  const fileState = repository.localScan.privateCurrentFileState(root.id, relative); assert.ok(fileState?.value.trackId && fileState.value.assetId);
  const track = repository.localCatalog.track(fileState.value.trackId), asset = repository.localCatalog.asset(fileState.value.assetId);
  const edition = repository.localCatalog.createEdition({ commandId: randomUUID(), title: '合成原专辑', edition: '原扫描身份' });
  repository.localCatalog.linkEditionTrack({ commandId: randomUUID(), editionId: edition.id, trackId: track.id, disc: 1, trackNumber: 1, sequence: 1 });
  const selection = { local_track_id: track.id, asset_id: asset.id, expected_asset_revision: asset.fileRevision };
  const evidenceSha256 = createHash('sha256').update(JSON.stringify({ captured, current, signature })).digest('hex');
  const remount = () => repository.sources.privateReauthorizeRemount(randomUUID(), captured, current, evidenceSha256);
  const snapshot = (repo = repository) => repo.localCatalog.privateRead(db => Object.fromEntries(historicalTables.map(table =>
    [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
  const catalog = (actual = owner) => actual.catalog.dispatch({ kind: 'catalog', datasetId, request: { operation: 'listTracks',
    serverId: 'server.remount.synthetic', offset: 0, limit: 10, q: '', albumId: null, itemId: null, expectedRevision: null, catalogPlaybackEnabled: true } });
  const capture = (actual = owner) => {
    const result = actual.tickets.captureMobile(selection); assert.equal(isLocalSourceCaptureResult(result), true);
    const received: unknown = structuredClone(result); assert.equal(isLocalSourceCaptureResult(received), true);
    assert.ok(isLocalSourceCaptureResult(received)); return received;
  };
  const prepare = (result: LocalSourceCaptureResult, actual = owner) => actual.pool.prepare({ source_kind: 'local_file', status: 'prepared_descriptor', facts: result.facts },
    { ownerId: randomUUID(), attempt: 1, isCurrent: () => actual.tickets.revalidate(result.ticketId) });
  return { owner, openOwner, databaseFile, repository, captured, current, root, selection, signature, relative, bytes,
    evidenceSha256, remount, snapshot, catalog, capture, prepare };
}

test('重挂载原Owner：原扫描事实经票据、闭集校验和structuredClone取得真实FD及目录可播放资格', async t => {
  const f = await fixture(t), before = f.snapshot();
  assert.equal(firstTrack(f.catalog()).availability, 'unavailable');
  f.remount();
  const capture = f.capture(); assert.equal(capture.facts.observation!.signature, f.signature);
  assert.equal(capture.facts.sourceRoot.readonlyRemountProof?.previousDev, f.captured.dev);
  assert.equal(capture.facts.sourceRoot.dev, f.current.dev);
  assert.equal(readonlySourceCatalogFileAvailable(capture.facts.sourceRoot, f.relative, f.signature, 'WAVE'), true);
  const lease = await f.prepare(capture);
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of lease.readSlice(0, f.bytes.length - 1, new AbortController().signal)) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), f.bytes); await lease.verify();
  } finally { await lease.close(); f.owner.tickets.release(capture.ticketId); }
  assert.deepEqual(f.owner.pool.resourceSnapshot(), { openLeases: 0, reservations: 0 });
  assert.equal(firstTrack(f.catalog()).availability, 'available');
  assert.deepEqual(f.snapshot(), before, '重新授权不得覆写catalog/scan身份、旧签名或原账本。');
});

test('重挂载原Owner：错Root与错proof不能穿过私有捕获合同或真实FD准备', async t => {
  const f = await fixture(t); f.remount(); const original = f.capture();
  for (const mode of ['root-id', 'proof-root', 'proof-dev', 'proof-path', 'proof-extra'] as const) {
    const capture = structuredClone(original), source = capture.facts.sourceRoot, proof = source.readonlyRemountProof!;
    if (mode === 'root-id') source.id = randomUUID();
    else if (mode === 'proof-root') proof.sourceRootId = randomUUID();
    else if (mode === 'proof-dev') proof.currentDev = f.captured.dev;
    else if (mode === 'proof-path') proof.pathSha256 = '0'.repeat(64);
    else Object.assign(proof, { extra: true });
    assert.equal(isLocalSourceCaptureResult(capture), false, mode);
    await assert.rejects(f.owner.pool.prepare({ source_kind: 'local_file', status: 'prepared_descriptor', facts: capture.facts },
      { ownerId: randomUUID(), attempt: 1, isCurrent: () => true }), mode);
    assert.equal(readonlySourceCatalogFileAvailable(source, f.relative, f.signature, 'WAVE'), false, mode);
    assert.deepEqual(f.owner.pool.resourceSnapshot(), { openLeases: 0, reservations: 0 });
  }
});

test('重挂载原Owner：真实撤权使旧票据及已开FD失效，proof不产生后续许可', async t => {
  const f = await fixture(t); f.remount(); const captured = f.capture(), lease = await f.prepare(captured);
  f.repository.sources.revoke({ commandId: randomUUID(), id: f.captured.id });
  assert.equal(f.owner.tickets.revalidate(captured.ticketId), false);
  assert.throws(() => f.owner.tickets.captureMobile(f.selection));
  await assert.rejects(f.prepare(captured)); await assert.rejects(lease.verify()); await lease.close();
  assert.equal(readonlySourceCatalogFileAvailable(f.repository.sources.root(f.captured.id), f.relative, f.signature, 'WAVE'), false);
  const page = f.catalog();
  if (!('kind' in page) && 'items' in page) assert.ok(page.items.every(item => isMobileTrack(item) && item.availability === 'unavailable'));
  else assert.ok('kind' in page && page.kind === 'mobile-error');
  assert.deepEqual(f.owner.pool.resourceSnapshot(), { openLeases: 0, reservations: 0 });
});

test('重挂载原Owner：冷开原完整catalog和scan审计成功，旧签名保持且新Owner仍可读取', async t => {
  const f = await fixture(t), before = f.snapshot(); f.remount(); await f.owner.close();
  const readonly = new DatabaseSync(f.databaseFile, { readOnly: true, allowExtension: false, enableForeignKeyConstraints: true });
  try {
    readonly.exec('PRAGMA query_only=ON;PRAGMA trusted_schema=OFF;BEGIN');
    verifyLocalCatalogDatabase(readonly); verifyLocalScanDatabase(readonly);
    assert.equal(readonly.prepare('PRAGMA query_only').get()?.query_only, 1); readonly.exec('ROLLBACK');
  } finally { readonly.close(); }
  const cold = f.openOwner(); assert.deepEqual(f.snapshot(cold.repository), before);
  assert.equal(cold.repository.localScan.privateCurrentFileState(f.root.id, f.relative)?.value.signature, f.signature);
  const capture = f.capture(cold); assert.equal(capture.facts.observation!.signature, f.signature);
  const lease = await f.prepare(capture, cold); try { await lease.verify(); } finally { await lease.close(); }
  assert.equal(firstTrack(f.catalog(cold)).availability, 'available');
});
