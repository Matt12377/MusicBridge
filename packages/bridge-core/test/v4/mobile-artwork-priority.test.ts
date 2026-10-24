import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, open } from 'node:fs/promises';
import path from 'node:path';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createLocalScanCoordinator } from '../../src/collection/local-scan-coordinator.js';
import { createLocalSourceTickets } from '../../src/collection/local-source-tickets.js';
import { createLocalAlbumOwnerRuntime } from '../../src/collection/local-album-browser/owner-runtime.js';
import { createMobileOwnerSourceService } from '../../src/mobile/source-service.js';
import { mobileLocalContentDigest } from '../../src/mobile/local-album-identity.js';
import { authorizeSourceDirectory, withCheckedReadonlyMetadataSource } from '../../src/recording/source-files.js';
import { createScanReadAdmission } from '../../src/library/scan-read-admission.js';
import { RUST_MEDIA_METADATA_PARSER_VERSION, type MetadataReaderPort } from '../../src/library/metadata-reader-types.js';
import type { DatasetProjectionPort } from '../../src/collection/dataset-owner-protocol.js';
import { LocalFileSourcePool, AssetLease } from '../../src/stream/local-file-source.js';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function fixture(t: TestContext) {
  assert.ok(process.env.TMPDIR?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const dir = await mkdtemp(path.join(process.env.TMPDIR!, 'mobile-artwork-priority-')), media = path.join(dir, 'media'); await mkdir(media);
  // 只有解析器使用合成端口；FD、签名、批次和SQLite均走原生产链。
  const bytes = Buffer.alloc(2048); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8); await writeFile(path.join(media, 'source.wav'), bytes);
  const repository = createCollectionRepository({ filePath: path.join(dir, 'collection.sqlite') }), datasetId = randomUUID(), ownerEpoch = randomUUID();
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media));
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  const gate = createScanReadAdmission({ isBusy: () => false }), context = { datasetId, epoch: ownerEpoch };
  const projection: DatasetProjectionPort = { async call(command, payload) {
    if (command === 'scanReadStatus') return { status: 'ready' } as never;
    if (command === 'scanReadAcquire') return gate.acquire(context, Object.hasOwn(payload, 'purpose') ? 'local-album-display' : 'scan') as never;
    if (command === 'scanReadWatchRevocation') return gate.watchRevocation(context, (payload as { permitId: string }).permitId) as never;
    if (command === 'scanReadRelease') return gate.release(context, (payload as { permitId: string }).permitId) as never;
    throw new Error('合成夹具不提供业务上游。');
  } };
  const reader: MetadataReaderPort = { async read(input, signal) {
    return withCheckedReadonlyMetadataSource(input.root, input.relative, input.expectedSignature, signal!, async handle => {
      const out = Buffer.alloc(12), got = await handle.read(out, 0, 12, 0);
      return { status: 'ok', parserVersion: RUST_MEDIA_METADATA_PARSER_VERSION, fields: { title: '合成曲目', album: '合成专辑' },
        technical: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48000, channels: 2, bitsPerSample: 16, durationSeconds: 1, evidence: 'bounded-parser-reported' }, coverEvidence: [],
        readEvidence: { bytesRead: got.bytesRead, readCalls: 1, maxReadBytes: 12, allocationBytes: 12, elapsedMs: 0, wholeAudioHash: false, wholeAudioDecode: false } };
    });
  }, async close() {} };
  const scanner = createLocalScanCoordinator({ repository, datasetId, assertCurrent() {}, reader, projection });
  const job = scanner.start({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision });
  await scanner.privateWait(job.jobId); assert.equal(scanner.get(job.jobId).phase, 'completed');
  const track = repository.localCatalog.pageTracks({ offset: 0, limit: 10 }).items[0]!;
  const edition = repository.localCatalog.createEdition({ commandId: randomUUID(), title: '合成发行', edition: '测试' });
  repository.localCatalog.linkEditionTrack({ commandId: randomUUID(), editionId: edition.id, trackId: track.id, disc: 1, trackNumber: 1, sequence: 1 });
  const content = mobileLocalContentDigest(datasetId, repository.localCatalog.trackDetail(track.id));
  const runtime = createLocalAlbumOwnerRuntime({ repository, datasetId, projection, assertCurrent() {}, readRootViews: async () => [{ root: repository.localCatalog.root(root.id), label: '合成来源', availability: 'ONLINE' }] });
  const tickets = createLocalSourceTickets(repository, ownerEpoch, datasetId, () => {});
  let service: ReturnType<typeof createMobileOwnerSourceService> | undefined;
  t.after(async () => { await service?.close(); tickets.seal(); await runtime.close(); await scanner.close(); gate.close(); repository.close(); await rm(dir, { recursive: true }); });
  const selection = () => ({ resourceId: randomUUID(), trackId: `lt:${datasetId}:${track.id}:${edition.id}`, versionId: `lv:${content}`, contentRevision: `lc:${content}` });
  return { repository, runtime, tickets, selection, datasetId, ownerEpoch, media,
    connect(beginActivity?: () => () => void) { service = createMobileOwnerSourceService({ collection: repository, tickets, datasetId, ownerEpoch, assertCurrent() {}, ...(beginActivity ? { beginActivity } : {}) }); return service; } };
}

test('移动prepare实际Promise持有token，完成后存活资源不持续阻塞', { timeout: 8000 }, async t => {
  const f = await fixture(t), entered = deferred(), finish = deferred(); let activities = 0, begins = 0;
  const service = f.connect(() => { activities++; begins++; let done = false; return () => { if (!done) { done = true; activities--; } }; }), original = LocalFileSourcePool.prototype.prepare;
  t.mock.method(LocalFileSourcePool.prototype, 'prepare', async function (this: LocalFileSourcePool, ...args: Parameters<typeof original>) { entered.resolve(); await finish.promise; return original.apply(this, args); });
  const selected = f.selection(), prepare = service.dispatch({ operation: 'prepare', selection: selected }); await entered.promise;
  try { assert.equal(activities, 1, '准备在途必须有token。'); } finally { finish.resolve(); }
  assert.equal((await prepare).kind, 'mobile-source-prepared'); assert.equal(activities, 0); assert.equal(begins, 1);
  assert.equal(service.resourceSnapshot().liveResources, 1, '存活lease不能充当前台活动。');
  await service.dispatch({ operation: 'release', handle: selected.resourceId }); assert.equal(activities, 0);
});

test('同Owner token幂等：A不清B，活动中新claim0，所有归还加100ms quiet后恢复', { timeout: 8000 }, async t => {
  const f = await fixture(t); let now = performance.now(); t.mock.method(performance, 'now', () => now);
  const begin = (f.runtime as typeof f.runtime & { beginMobileActivity?: () => () => void }).beginMobileActivity;
  assert.equal(typeof begin, 'function', '必须接入实际Owner前台计数。');
  const releaseA = begin!(), releaseB = begin!(), queue = f.repository.privateLocalAlbumArtworkQueue!, claim = queue.claim.bind(queue); let claims = 0;
  t.mock.method(queue, 'claim', () => { claims++; return null; });
  const worker = f.runtime.background!; worker.start(); await worker.runPending(); assert.equal(claims, 0);
  releaseA(); releaseA(); now += 101; await worker.runPending(); assert.equal(claims, 0);
  releaseB(); await worker.runPending(); assert.equal(claims, 0);
  now += 101; await worker.runPending(); assert.ok(claims > 0, '所有活动退出后后台应恢复。');
});


test('移动准备取消后迟到Promise仍持token，release等待原工作退出后才quiet', { timeout: 8000 }, async t => {
  const f = await fixture(t), entered = deferred(), finish = deferred(); let count = 0;
  const service = f.connect(() => { count++; return () => { count--; }; }), original = LocalFileSourcePool.prototype.prepare;
  t.mock.method(LocalFileSourcePool.prototype, 'prepare', async function (this: LocalFileSourcePool, ...args: Parameters<typeof original>) { entered.resolve(); await finish.promise; return original.apply(this, args); });
  const selected = f.selection(), prepare = service.dispatch({ operation: 'prepare', selection: selected }); await entered.promise;
  let settled = false; const closing = service.dispatch({ operation: 'release', handle: selected.resourceId }).then(value => { settled = true; return value; });
  await turn(); try { assert.equal(settled, false); assert.equal(count, 1); } finally { finish.resolve(); }
  assert.equal((await prepare).kind, 'mobile-error'); assert.equal((await closing).kind, 'mobile-source-ack'); assert.equal(count, 0);
});

test('ReadRecord跨块持token直到closeReader真实退出，重复close不影响其它reader', { timeout: 8000 }, async t => {
  const f = await fixture(t); let count = 0;
  const service = f.connect(() => { count++; let released = false; return () => { if (!released) { released = true; count--; } }; });
  const selected = f.selection(); assert.equal((await service.dispatch({ operation: 'prepare', selection: selected })).kind, 'mobile-source-prepared'); assert.equal(count, 0);
  const a = randomUUID(), b = randomUUID(), handle = selected.resourceId;
  assert.equal((await service.dispatch({ operation: 'read', handle, readId: a, start: 0, maxBytes: 16 })).kind, 'mobile-source-read'); assert.equal(count, 1);
  assert.equal((await service.dispatch({ operation: 'read', handle, readId: b, start: 0, maxBytes: 16 })).kind, 'mobile-source-read'); assert.equal(count, 2);
  const entered = deferred(), finish = deferred(), original = AssetLease.prototype.readSlice;
  t.mock.method(AssetLease.prototype, 'readSlice', async function* (this: AssetLease, ...args: Parameters<typeof original>) { entered.resolve(); await finish.promise; yield* original.apply(this, args); });
  const reading = service.dispatch({ operation: 'read', handle, readId: a, start: 16, maxBytes: 16 }); await entered.promise;
  let settled = false; const closing = service.dispatch({ operation: 'close-read', handle, readId: a }).then(result => { settled = true; return result; });
  await turn(); try { assert.equal(settled, false); assert.equal(count, 2); } finally { finish.resolve(); }
  assert.equal((await reading).kind, 'mobile-error'); assert.equal((await closing).kind, 'mobile-source-ack'); assert.equal(count, 1);
  await service.dispatch({ operation: 'close-read', handle, readId: a }); assert.equal(count, 1);
  await service.dispatch({ operation: 'close-read', handle, readId: b }); assert.equal(count, 0);
  await service.dispatch({ operation: 'release', handle }); assert.equal(count, 0);
});

test('实际Owner token不撤销已领取后台FD，旧claim自然close之后新claim仍让步', { timeout: 8000 }, async t => {
  const f = await fixture(t), entered = deferred(), finish = deferred(); let now = performance.now(); t.mock.method(performance, 'now', () => now);
  let fd: Awaited<ReturnType<typeof open>> | undefined, signal: AbortSignal | undefined, reads = 0;
  const original = f.runtime.artwork.readSources;
  t.mock.method(f.runtime.artwork, 'readSources', async (...args: Parameters<typeof original>) => {
    reads++; signal = args[2]; fd = await open(path.join(f.media, 'source.wav'), 'r'); entered.resolve();
    try { await finish.promise; } finally { await fd.close(); }
    return { image: null, copies: { status: 'ready', items: [] } } as unknown as Awaited<ReturnType<typeof original>>;
  });
  const worker = f.runtime.background!; worker.start(); const pending = worker.runPending(); await entered.promise;
  const release = f.runtime.beginMobileActivity();
  try { assert.equal(signal?.aborted, false); assert.notEqual(fd?.fd, -1); } finally { finish.resolve(); }
  await pending; assert.equal(fd?.fd, -1); assert.equal(reads, 1);
  await worker.runPending(); assert.equal(reads, 1); release(); now += 101;
  await worker.runPending(); assert.equal(f.repository.privateLocalAlbumArtworkQueue!.inspect(f.datasetId).running, 0);
});

test('真实Source prepare接同Owner后台准入：在途及重复幂等prepare只一token，完成后100ms恢复', { timeout: 8000 }, async t => {
  const f = await fixture(t), entered = deferred(), finish = deferred(); let now = performance.now(); t.mock.method(performance, 'now', () => now);
  const service = f.connect(f.runtime.beginMobileActivity), original = LocalFileSourcePool.prototype.prepare;
  t.mock.method(LocalFileSourcePool.prototype, 'prepare', async function (this: LocalFileSourcePool, ...args: Parameters<typeof original>) { entered.resolve(); await finish.promise; return original.apply(this, args); });
  const queue = f.repository.privateLocalAlbumArtworkQueue!; let claims = 0; t.mock.method(queue, 'claim', () => { claims++; return null; });
  const selection = f.selection(), request = { operation: 'prepare' as const, selection }, a = service.dispatch(request); await entered.promise;
  const b = service.dispatch(request), worker = f.runtime.background!; worker.start(); await worker.runPending();
  try { assert.equal(claims, 0); } finally { finish.resolve(); }
  assert.equal((await a).kind, 'mobile-source-prepared'); assert.equal((await b).kind, 'mobile-source-prepared');
  await worker.runPending(); assert.equal(claims, 0); now += 101; await worker.runPending(); assert.ok(claims > 0);
  await service.dispatch({ operation: 'release', handle: selection.resourceId });
});

test('准备前拒绝/普通失败均原错误且真实收口后无token，非法协议不取得token', { timeout: 8000 }, async t => {
  const f = await fixture(t); let count = 0, begins = 0;
  const service = f.connect(() => { begins++; count++; return () => { count--; }; });
  const selection = f.selection(); selection.contentRevision = 'lc:' + '0'.repeat(64);
  const failed = await service.dispatch({ operation: 'prepare', selection }); assert.equal(failed.kind, 'mobile-error');
  assert.ok(failed.kind === 'mobile-error'); assert.equal(failed.code, 'SOURCE_CHANGED'); assert.equal(count, 0); assert.equal(begins, 1);
  assert.equal((await service.dispatch({ operation: 'read', handle: 'invalid', readId: randomUUID(), start: 0, maxBytes: 64 })).kind, 'mobile-error');
  assert.equal(count, 0); assert.equal(begins, 1);
});
