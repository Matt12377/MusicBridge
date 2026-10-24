import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createBackupWorkflowStore } from '../../src/recording/backup-workflow-store.js';
import { createArtistMetadataBackfillCoordinator } from '../../src/collection/local-artist-metadata-backfill.js';
import { createLocalScanCoordinator } from '../../src/collection/local-scan-coordinator.js';
import { createDatasetDomain } from '../../src/collection/dataset-domain.js';
import { createScanReadAdmission } from '../../src/library/scan-read-admission.js';
import { withCheckedReadonlyMetadataSource } from '../../src/recording/source-files.js';
import type { DatasetProjectionPort, DatasetProjectionCommandResults } from '../../src/collection/dataset-owner-protocol.js';
import { localLibraryManagementDigest, type LocalLibraryManagementBindingRecord,
  type LocalLibraryManagementOperationRecord } from '../../src/collection/local-library-workbench/owner-journal.js';
import { RUST_MEDIA_METADATA_PARSER_VERSION, type MetadataReadResult, type MetadataReadInput } from '../../src/library/metadata-reader-types.js';
import { seedMobileSqlWaveLibrary } from '../helpers/mobile-sql-owned-wave-library.js';

const fields = { artists: ['合成艺人'], albumArtists: ['合成专辑艺人'], albumArtist: '合成专辑艺人' };
const success = (): MetadataReadResult => ({ status: 'ok', parserVersion: RUST_MEDIA_METADATA_PARSER_VERSION, fields,
  technical: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48000, channels: 2, bitsPerSample: 16,
    durationSeconds: 0.01, evidence: 'bounded-parser-reported' }, coverEvidence: [],
  readEvidence: { bytesRead: 44, readCalls: 1, maxReadBytes: 44, allocationBytes: 44, elapsedMs: 1,
    wholeAudioHash: false, wholeAudioDecode: false } });

async function fixture(t: TestContext, count = 2) {
  const temporary = process.env.TMPDIR;
  assert.ok(typeof temporary === 'string' && temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const directory = await mkdtemp(path.join(temporary, 'mousa41-backfill-active-')), file = path.join(directory, 'catalog.sqlite');
  const repository = createCollectionRepository({ filePath: file }); repository.list({ offset: 0, limit: 1 });
  const state = createBackupWorkflowStore({ filePath: path.join(directory, 'identity.sqlite') });
  const identity = state.datasetIdentities.bind('default', file, false), catalog = repository.localCatalog;
  catalog.privateBindWorkbenchDataset(identity);
  t.after(async () => { repository.close(); state.close(); await rm(directory, { recursive: true, force: true }); });
  const roots: { rootId: string; trackId: string; sourceId: string; binding: LocalLibraryManagementBindingRecord }[] = [];
  for (let n = 0; n < count; n++) {
    const seeded = await seedMobileSqlWaveLibrary(repository, identity.datasetId, path.join(directory, `合成来源${n}`), false, ['合成专辑/1.wav']);
    const root = catalog.root(seeded.rootId), commandId = randomUUID();
    const operation: LocalLibraryManagementOperationRecord = { schema: 1, kind: 'operation', datasetId: identity.datasetId,
      key: commandId, revision: 1, original: { command: 'library.import.confirm', request: { commandId, choiceId: 'controlled-backfill-choice', role: 'catalog' } },
      originalSha256: '', receipt: { commandId, kind: 'library.import.confirm', state: 'succeeded', libraryIds: [root.id], message: null } };
    operation.originalSha256 = localLibraryManagementDigest(operation.original);
    const binding: LocalLibraryManagementBindingRecord = { schema: 1, kind: 'binding', datasetId: identity.datasetId,
      key: root.id, revision: 1, libraryId: root.id, sourceRootId: root.sourceRootId, rootRevision: root.revision,
      role: 'catalog', name: `合成库${n}`, active: true, watchEnabled: false, operationId: commandId };
    catalog.privateLibraryManagementCompareAndSwap(identity, [{ record: binding, expectedRevision: null }, { record: operation, expectedRevision: null }]);
    roots.push({ rootId: root.id, trackId: seeded.trackIds[0]!, sourceId: root.sourceRootId, binding });
  }
  function remove(index: number, running = false) {
    const entry = roots[index]!, commandId = randomUUID();
    const operation: LocalLibraryManagementOperationRecord = { schema: 1, kind: 'operation', datasetId: identity.datasetId,
      key: commandId, revision: 1, original: { command: 'library.remove', request: { commandId, libraryIds: [entry.rootId] } },
      originalSha256: '', receipt: { commandId, kind: 'library.remove', state: running ? 'running' : 'succeeded', libraryIds: [entry.rootId], message: null } };
    operation.originalSha256 = localLibraryManagementDigest(operation.original);
    catalog.privateLibraryManagementCompareAndSwap(identity, [
      ...(running ? [] : [{ record: { ...entry.binding, revision: 2, active: false, operationId: commandId }, expectedRevision: 1 }]),
      { record: operation, expectedRevision: null },
    ]);
  }
  return { repository, catalog, roots, remove, identity };
}

function deferred() {
  let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function scannerFixture(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, options: {
  beforeAdmission?: () => Promise<void>; read?: (input: MetadataReadInput) => Promise<MetadataReadResult>;
} = {}) {
  const admission = createScanReadAdmission({ isBusy: () => false }), context = { datasetId: f.identity.datasetId, epoch: randomUUID() };
  let admissions = 0, reads = 0;
  const projection: DatasetProjectionPort = { async call(command, payload) {
    let result: unknown;
    if (command === 'scanReadAcquire') { admissions++; await options.beforeAdmission?.(); result = admission.acquire(context); }
    else if (command === 'scanReadWatchRevocation') result = await admission.watchRevocation(context, (payload as { permitId: string }).permitId);
    else if (command === 'scanReadRelease') result = admission.release(context, (payload as { permitId: string }).permitId);
    else throw new Error('本补读夹具只允许原生产扫描票据。');
    return result as DatasetProjectionCommandResults[typeof command];
  } };
  const scanner = createLocalScanCoordinator({ repository: f.repository, datasetId: f.identity.datasetId,
    assertCurrent() { f.identity.assertCurrent(); }, projection,
    reader: { async read(input) { reads++; return options.read ? options.read(input) : success(); }, async close() {} } });
  t.after(async () => { await scanner.close(); admission.close(); });
  return { scanner, get admissions() { return admissions; }, get reads() { return reads; } };
}

test('真实管理账本过滤停用库后再分页，保留历史资产且拒绝撤库前捕获的补读', async t => {
  const f = await fixture(t), original = f.catalog.privateArtistMetadataBackfillCandidates(0, 1);
  assert.equal(original.hasMore, true); assert.equal(original.items[0]!.track.id, f.roots[0]!.trackId);
  f.remove(0);
  const current = f.catalog.privateArtistMetadataBackfillCandidates(0, 1);
  assert.equal(current.hasMore, false); assert.equal(current.items.length, 1); assert.equal(current.items[0]!.track.id, f.roots[1]!.trackId);
  assert.equal(f.catalog.track(f.roots[0]!.trackId).id, f.roots[0]!.trackId, '撤库只封住新补读，不删除历史曲目');
  const stamp = f.repository.readonlySnapshotStamp();
  assert.throws(() => f.catalog.privateCommitArtistMetadataBackfill(original.items[0]!, fields, 'owned-backfill-v1'), { code: 'INVENTORY_CONFLICT' });
  assert.deepEqual(f.repository.readonlySnapshotStamp(), stamp);
});

test('原remove尚未终结也封住新补读，不能借旧active绑定绕过', async t => {
  const f = await fixture(t, 1), captured = f.catalog.privateArtistMetadataBackfillCandidates(0, 1).items[0]!;
  f.remove(0, true);
  assert.deepEqual(f.catalog.privateArtistMetadataBackfillCandidates(0, 1), { items: [], hasMore: false });
  assert.throws(() => f.catalog.privateCommitArtistMetadataBackfill(captured, fields, 'owned-backfill-v1'), { code: 'INVENTORY_CONFLICT' });
});

test('等待Reader时撤库，迟到完整标签不得追加到已移除的真实曲目', async t => {
  const f = await fixture(t, 1); let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const coordinator = createArtistMetadataBackfillCoordinator({ collection: f.repository, directory: null, assertCurrent() {},
    read: async () => { entered(); await gate; return success(); } });
  t.after(async () => { release(); await coordinator.close(); });
  const batch = coordinator.runBatch(1); await ready; f.remove(0); const stamp = f.repository.readonlySnapshotStamp(); release();
  const result = await batch;
  assert.equal(result.failed, 1); assert.equal(result.succeeded, 0); assert.deepEqual(f.repository.readonlySnapshotStamp(), stamp);
  assert.deepEqual(f.catalog.privateArtistMetadataBackfillCandidates(0, 1).items, []);
});

test('原文件修订、根修订或授权变化，均拒绝旧补读捕获', async t => {
  for (const mutation of ['file', 'root', 'authorization'] as const) {
    await t.test(mutation, async child => {
      const f = await fixture(child, 1), captured = f.catalog.privateArtistMetadataBackfillCandidates(0, 1).items[0]!;
      if (mutation === 'authorization') f.repository.sources.revoke({ commandId: randomUUID(), id: captured.asset.sourceRootId });
      else if (mutation === 'root') f.catalog.relinkRoot({ commandId: randomUUID(), rootId: captured.asset.libraryRootId,
        expectedRevision: captured.asset.rootRevision, sourceRootId: captured.asset.sourceRootId, role: 'library' });
      else f.catalog.replaceAsset({ commandId: randomUUID(), libraryRootId: captured.asset.libraryRootId,
        expectedRootRevision: captured.asset.rootRevision, assetId: captured.asset.id, expectedFileRevision: captured.asset.fileRevision,
        expectedLocationRevision: captured.asset.locationRevision, relative: captured.relative, sha256: null, sampleFrames: null, timebaseHz: null });
      const stamp = f.repository.readonlySnapshotStamp();
      assert.throws(() => f.catalog.privateCommitArtistMetadataBackfill(captured, fields, 'owned-backfill-v1'), { code: 'INVENTORY_CONFLICT' });
      assert.deepEqual(f.repository.readonlySnapshotStamp(), stamp);
    });
  }
});

test('真实目录已有完整tag数组时只结算补读状态，不再打开文件', async t => {
  const f = await fixture(t, 1), entry = f.roots[0]!;
  f.catalog.observeMetadata({ commandId: randomUUID(), trackId: entry.trackId, source: 'tag', parserVersion: RUST_MEDIA_METADATA_PARSER_VERSION, fields });
  assert.equal(f.catalog.privateArtistMetadataBackfillCandidates(0, 1).items[0]!.complete, true);
  const stamp = f.repository.readonlySnapshotStamp(); let reads = 0;
  const coordinator = createArtistMetadataBackfillCoordinator({ collection: f.repository, directory: null, assertCurrent() {},
    read: async () => { reads++; throw new Error('完整数组不允许再次读取音频'); } }); t.after(() => coordinator.close());
  const result = await coordinator.runBatch(1);
  assert.equal(result.succeeded, 1); assert.equal(result.failed, 0); assert.equal(reads, 0); assert.deepEqual(f.repository.readonlySnapshotStamp(), stamp);
});

test('候选捕获后撤库，补读入口在申请读取票据前拒绝旧候选', async t => {
  const f = await fixture(t, 1), captured = f.catalog.privateArtistMetadataBackfillCandidates(0, 1).items[0]!;
  const s = scannerFixture(t, f); f.remove(0);
  const result = await s.scanner.privateReadArtistMetadata(captured, new AbortController().signal);
  assert.equal(result.status, 'failure'); assert.equal(s.admissions, 0); assert.equal(s.reads, 0);
});

test('原读取准入等待期间撤库，取票后仍拒绝调用Reader并释放原票据', async t => {
  const f = await fixture(t, 1), captured = f.catalog.privateArtistMetadataBackfillCandidates(0, 1).items[0]!;
  const entered = deferred(), gate = deferred();
  const s = scannerFixture(t, f, { beforeAdmission: async () => { entered.resolve(); await gate.promise; } });
  t.after(() => gate.resolve());
  const pending = s.scanner.privateReadArtistMetadata(captured, new AbortController().signal);
  await entered.promise; f.remove(0); gate.resolve();
  const result = await pending;
  assert.equal(result.status, 'failure'); assert.equal(s.admissions, 1); assert.equal(s.reads, 0);
});

test('Reader自身排队期间撤库，原只读FD入口也会拒绝打开阶段', async t => {
  const f = await fixture(t, 1), captured = f.catalog.privateArtistMetadataBackfillCandidates(0, 1).items[0]!;
  const entered = deferred(), gate = deferred(); let opens = 0;
  // 用受控Reader延迟进入原只读FD链；不调用解析器，不触碰用户音频。
  const s = scannerFixture(t, f, { read: async input => {
    entered.resolve(); await gate.promise;
    try {
      return await withCheckedReadonlyMetadataSource(input.root, input.relative, input.expectedSignature,
        new AbortController().signal, async () => success(), input.assertCurrent,
        event => { if (event.type === 'lease-acquired') opens++; });
    } catch { return { status: 'failure', code: 'REVOKED', readEvidence: null }; }
  } });
  t.after(() => gate.resolve());
  const pending = s.scanner.privateReadArtistMetadata(captured, new AbortController().signal);
  await entered.promise; f.remove(0); gate.resolve();
  assert.equal((await pending).status, 'failure'); assert.equal(s.reads, 1); assert.equal(opens, 0);
});

test('未提供数据集快照能力的领域仍拒绝重试完成快照', async t => {
  const temporary = process.env.TMPDIR; assert.ok(typeof temporary === 'string' && temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const directory = await mkdtemp(path.join(temporary, 'mousa41-no-snapshot-'));
  const repository = createCollectionRepository({ filePath: path.join(directory, 'catalog.sqlite') });
  const state = createBackupWorkflowStore({ filePath: path.join(directory, 'workflow.sqlite') });
  const domain = createDatasetDomain({ collectionRepository: repository, backupWorkflowStore: state });
  t.after(async () => { await domain.close(); await rm(directory, { recursive: true, force: true }); });
  await seedMobileSqlWaveLibrary(repository, domain.datasetId, path.join(directory, '合成来源'), false, ['合成专辑/1.wav']);
  const job = repository.localScan.page(domain.datasetId, { offset: 0, limit: 1 }).items[0]!;
  assert.equal(job.phase, 'completed');
  await assert.rejects(domain.localScan!.retryCompletedSnapshot(job.jobId), /只有资源已关闭的完成扫描可独立重试快照/u);
});
