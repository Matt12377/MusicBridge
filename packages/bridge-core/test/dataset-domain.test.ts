import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { IpcRequest, PhysicalLinkResult, MasterDraftResult } from '@music-bridge/contracts';
import { createCollectionRepository } from '../src/collection/repository.js';
import { createBackupWorkflowStore } from '../src/recording/backup-workflow-store.js';
import { createDatasetDomain, createTestDatasetDomain, prepareOwnedDatasetDomain, createCollectionRoonProjectionPort } from '../src/collection/dataset-domain.js';
import type { DatasetProjectionPort, DatasetProjectionCommand, DatasetProjectionCommandPayloads } from '../src/collection/dataset-owner-protocol.js';
import { createSyntheticRoonLibrary } from '../src/roon/synthetic-library.js';
import { recordingPlanFixture } from './helpers/recording-plan-fixture.js';
import type { RecordingAttemptDriverRequest } from '../src/recording/attempt-coordinator.js';

const page = { offset: 0, limit: 20 };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function projectionPort(handler: (command: DatasetProjectionCommand, payload: DatasetProjectionCommandPayloads[DatasetProjectionCommand]) => Promise<unknown>): DatasetProjectionPort {
  return { call: handler as DatasetProjectionPort['call'] };
}
async function projectionFixture(t: test.TestContext) {
  const library = createSyntheticRoonLibrary();
  const albums = await library.browseAlbums(page);
  const tracks = await Promise.all(albums.items.map(album => library.browseAlbum(album.reference, page)));
  const calls: DatasetProjectionCommand[] = [];
  let offline = false;
  const port = projectionPort(async (command, payload) => {
    calls.push(command);
    if (offline) throw new Error('合成媒体库已断开');
    if (command === 'captureAlbumMetadata') return { scope: 'library-generation-1', projectionId: randomUUID(), metadata: library.getAlbumSnapshot((payload as { reference: string }).reference) };
    if (command === 'captureTrackMetadataBatch') return { scope: 'library-generation-1', projectionId: randomUUID(), metadata: (payload as { references: readonly string[] }).references.map(reference => library.getTrackSnapshot(reference)) };
    if (command === 'acquirePermit') return { ...payload, permitId: randomUUID() };
    if (command === 'releasePermit') return { released: true };
    const browse = payload as { query: string; page: typeof page };
    return browse.query.trim() ? library.searchLibrary(browse.query, browse.page, 'album') : library.browseAlbums(browse.page);
  });
  const collection = createCollectionRepository({ filePath: ':memory:' }), maintenance = createBackupWorkflowStore({ filePath: ':memory:' });
  const domain = createDatasetDomain({ collectionRepository: collection, backupWorkflowStore: maintenance, projection: port });
  t.after(() => domain.close());
  const request = (command: IpcRequest['command'], payload: unknown): IpcRequest => ({ version: 1, id: randomUUID(), command, payload, expectedDatasetId: domain.datasetId }) as IpcRequest;
  return { domain, collection, maintenance, library, albums, tracks, calls, request, offline: () => { offline = true; } };
}

test('owner异步关联仍使用原幂等收据；断开媒体库后的重放不索取新元数据或许可', async t => {
  const f = await projectionFixture(t);
  const command = f.request('physicalLinks.register', { commandId: randomUUID(), reference: f.albums.items[0]!.reference, physicalAbsenceConfirmed: true, userConfirmed: true });
  const result = await f.domain.dispatch(command) as PhysicalLinkResult;
  assert.ok(result.digitalId);
  assert.deepEqual(f.calls, ['captureAlbumMetadata', 'acquirePermit', 'releasePermit']);
  const stored = f.collection.links.digitalDetail(result.digitalId!);
  assert.equal(stored.album.metadata.title, '关联验收专辑');
  assert.doesNotMatch(JSON.stringify(stored), /musicbridge-v2|synthetic-private|itemKey/u);
  f.offline();
  assert.deepEqual(await f.domain.dispatch(command), result);
  assert.deepEqual(f.calls, ['captureAlbumMetadata', 'acquirePermit', 'releasePermit']);
  await assert.rejects(f.domain.dispatch({ ...command, expectedDatasetId: randomUUID() }), /工作库/u);
  assert.equal(f.collection.links.digitalList(page).total, 1);
});

test('owner一次选曲批次保持顺序并拒绝重复引用，公开草稿仍无运行引用；重放不依赖媒体库', async t => {
  const f = await projectionFixture(t), first = f.tracks[0]!.items[0]!, second = f.tracks[1]!.items[0]!;
  const command = f.request('recordingDrafts.append', { commandId: randomUUID(), title: '异步精选', programType: 'compilation', references: [second.reference, first.reference], userConfirmed: true });
  await assert.rejects(f.domain.dispatch({ ...command, payload: { ...(command.payload as object), references: [second.reference, second.reference] } }), /选曲请求无效/u);
  assert.deepEqual(f.calls, []);
  const saved = await f.domain.dispatch(command) as MasterDraftResult;
  const snapshot = f.collection.drafts.detail(saved.draftId);
  assert.deepEqual(snapshot.tracks.map(track => track.metadata.title), ['另一首合成曲目', '合成关联曲目']);
  assert.equal(snapshot.sourceLockEligible, false);
  assert.doesNotMatch(JSON.stringify(snapshot), /musicbridge-v2|synthetic-private|itemKey/u);
  assert.deepEqual(f.calls, ['captureTrackMetadataBatch', 'acquirePermit', 'releasePermit']);
  f.offline(); assert.deepEqual(await f.domain.dispatch(command), saved);
  assert.deepEqual(f.calls, ['captureTrackMetadataBatch', 'acquirePermit', 'releasePermit']);
});

test('许可失效阻断消费，事务消费失败仍释放已取得许可', async () => {
  const events: string[] = [];
  const port = projectionPort(async (command, payload) => {
    events.push(command);
    if (command === 'captureAlbumMetadata') return { scope: 'current', projectionId: randomUUID(), metadata: { title: '合成' } };
    if (command === 'acquirePermit') return { ...payload, permitId: randomUUID() };
    if (command === 'releasePermit') return { released: true };
    throw new Error('本例没有其他投影');
  });
  const projection = createCollectionRoonProjectionPort(port, () => {});
  await assert.rejects(projection.projectAlbum('合成引用', () => { throw new Error('合成CAS冲突'); }), /CAS/u);
  assert.deepEqual(events, ['captureAlbumMetadata', 'acquirePermit', 'releasePermit']);
  let consumed = false;
  const unavailable = createCollectionRoonProjectionPort(projectionPort(async command => {
    if (command === 'captureAlbumMetadata') return { scope: 'expired', projectionId: randomUUID(), metadata: { title: '旧快照' } };
    throw new Error('媒体库代际已失效');
  }), () => {});
  await assert.rejects(unavailable.projectAlbum('合成引用', () => { consumed = true; }), /代际/u);
  assert.equal(consumed, false);
});

test('关闭时封住迟到元数据写入，并等待旧dispatch真正结束后才关闭两库', async t => {
  const captureEntered = deferred<void>(), finishCapture = deferred<void>();
  const collection = createCollectionRepository({ filePath: ':memory:' }), maintenance = createBackupWorkflowStore({ filePath: ':memory:' });
  const domain = createDatasetDomain({ collectionRepository: collection, backupWorkflowStore: maintenance, projection: projectionPort(async command => {
    if (command === 'captureAlbumMetadata') { captureEntered.resolve(); await finishCapture.promise; return { scope: 'old', projectionId: randomUUID(), metadata: { title: '不应写入' } }; }
    throw new Error('关闭后不得再索取许可');
  }) });
  t.after(() => domain.close());
  const library = createSyntheticRoonLibrary(), reference = (await library.browseAlbums(page)).items[0]!.reference;
  const pending = domain.dispatch({ version: 1, id: randomUUID(), command: 'physicalLinks.register', payload: { commandId: randomUUID(), reference, physicalAbsenceConfirmed: true, userConfirmed: true }, expectedDatasetId: domain.datasetId });
  const rejected = assert.rejects(pending, /关闭/u);
  await captureEntered.promise;
  let closed = false;
  const closing = domain.close(async () => { assert.equal(collection.links.digitalList(page).total, 0); maintenance.overview(); }).then(() => { closed = true; });
  await domain.backups.close();
  assert.equal(closed, false);
  assert.equal(collection.links.digitalList(page).total, 0);
  maintenance.overview();
  await assert.rejects(domain.dispatch({ version: 1, id: randomUUID(), command: 'commandOutbox.context', payload: {} }), /关闭/u);
  finishCapture.resolve(); await rejected; await closing;
  assert.throws(() => collection.list(page)); assert.throws(() => maintenance.overview());
});

test('协调器关闭后仍保留真实两库直到本地收口回调完成，最终自然close释放连接', async t => {
  const collection = createCollectionRepository({ filePath: ':memory:' }), maintenance = createBackupWorkflowStore({ filePath: ':memory:' });
  const domain = createTestDatasetDomain({ collectionRepository: collection, backupWorkflowStore: maintenance });
  const entered = deferred<void>(), resume = deferred<void>();
  t.after(() => domain.close());
  const closing = domain.close(async () => { entered.resolve(); await resume.promise; });
  await entered.promise;
  assert.equal(collection.list(page).total, 0); assert.equal(maintenance.overview().jobs.length, 0);
  assert.throws(() => domain.assertOpen(), /关闭/u);
  resume.resolve(); await closing; await domain.close();
  assert.throws(() => collection.list(page)); assert.throws(() => maintenance.overview());
});

test('生产owner在同一持久dataset重启后沿用身份与业务数据；testMode不会取得真实输出资格', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mbp-008-owned-dataset-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const unavailable = projectionPort(async () => { throw new Error('本例无真实Roon'); });
  const first = await prepareOwnedDatasetDomain({ dataDirectory: directory, epoch: randomUUID(), testMode: true, projection: unavailable });
  t.after(() => first.close());
  const identity = first.datasetId;
  first.collection.receive({ commandId: randomUUID(), model: { brand: '合成', name: 'owner持久化', edition: '测试', year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified' }, lengthMinutes: 60, quantities: { openedBlank: 1, sealedBlank: 0, legacyUsed: 0, unclassified: 0 } });
  await first.commitBoot(); await first.close();
  const second = await prepareOwnedDatasetDomain({ dataDirectory: directory, epoch: randomUUID(), testMode: true, projection: unavailable });
  t.after(() => second.close());
  assert.equal(second.datasetId, identity); assert.equal(second.collection.list(page).total, 1);
  assert.equal(second.recordingDeviceSelection, undefined);
  await second.commitBoot(); await second.close();
});

test('owner关闭录音时真实输入释放与quiet屏障仍能持久化，关闭标记只阻断新派发', async t => {
  const f = await recordingPlanFixture(t, false, { format: 'dat' });
  const frozen = await f.plans.freeze(await f.planRequest());
  let stops = 0, closes = 0;
  const maintenance = createBackupWorkflowStore({ filePath: ':memory:' });
  const domain = createTestDatasetDomain({ collectionRepository: f.repository, backupWorkflowStore: maintenance, closeConnections() { maintenance.close(); }, recordingAttemptAdmissionProvider: {
    async authorize() {}, async start() { return { async stop() { ++stops; }, async close() { ++closes; } }; },
  } });
  f.registerDependentCleanup(() => domain.close());
  const attempt = await domain.recordingAttempts.begin({ commandId: randomUUID(), planVersionId: frozen.id, planContentHash: frozen.contentHash, userConfirmed: true });
  await domain.close(async () => {
    const rows = f.repository.recordingAttempts.outputRunRecoveryRows();
    assert.equal(rows.length, 1); assert.equal(rows[0]!.attemptId, attempt.id); assert.equal(rows[0]!.quietPersisted, true);
    assert.equal(f.repository.recordingAttempts.get({ attemptId: attempt.id }).attempt!.status, 'interrupted');
  });
  assert.equal(stops, 1); assert.equal(closes, 1);
});

test('Print关闭失败仍停止原Attempt输入与后继资源，收口后拒绝成功并保留两库；失败关闭不重试', async t => {
  const f = await recordingPlanFixture(t, false, { format: 'dat' });
  const frozen = await f.plans.freeze(await f.planRequest());
  const maintenance = createBackupWorkflowStore({ filePath: ':memory:' });
  f.registerDependentCleanup(async () => { maintenance.close(); });
  let stops = 0, closes = 0, connectionCloses = 0, barrierReached = false;
  let input: RecordingAttemptDriverRequest['input'] | undefined;
  const domain = createTestDatasetDomain({ collectionRepository: f.repository, backupWorkflowStore: maintenance,
    closeConnections() { ++connectionCloses; }, recordingAttemptAdmissionProvider: {
      async authorize() {}, async start(request) { input = request.input; return { async stop() { ++stops; }, async close() { ++closes; } }; },
    },
  });
  const originalPrintClose = domain.recordingPrints.close;
  f.registerDependentCleanup(async () => { originalPrintClose(); });
  const failure = new Error('合成Print关闭故障');
  const printClose = t.mock.method(domain.recordingPrints, 'close', async () => { throw failure; });
  const attempt = await domain.recordingAttempts.begin({ commandId: randomUUID(), planVersionId: frozen.id, planContentHash: frozen.contentHash, userConfirmed: true });
  const closing = domain.close(async () => { barrierReached = true; assert.equal(f.repository.recordingAttempts.outputRunRecoveryRows()[0]!.quietPersisted, true); });
  await assert.rejects(closing, error => error === failure);
  assert.equal(stops, 1); assert.equal(closes, 1); assert.equal(barrierReached, true); assert.equal(connectionCloses, 0);
  assert.equal(f.repository.recordingAttempts.get({ attemptId: attempt.id }).attempt!.status, 'interrupted');
  assert.ok(input);
  await assert.rejects(input.consumer.readFrames(0, 1), error => error instanceof Error && 'code' in error && error.code === 'LEASE_CLOSED');
  await assert.rejects(domain.sources.authorize(randomUUID(), f.directory), /源文件操作无效/u);
  assert.throws(domain.assertOpen, /关闭/u);
  assert.ok(f.repository.list(page).total > 0); maintenance.overview();
  assert.equal(domain.close(), closing, '重放失败close必须沿用原Promise，不能再次清理原scope');
  await assert.rejects(domain.close(), error => error === failure);
  assert.equal(printClose.mock.callCount(), 1); assert.equal(stops, 1); assert.equal(closes, 1);
});
