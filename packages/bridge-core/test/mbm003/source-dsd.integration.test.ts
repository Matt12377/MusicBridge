import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MobileTrack } from '@music-bridge/contracts';
import type { DatasetProjectionPort, DatasetProjectionCommand, DatasetProjectionCommandPayloads, DatasetProjectionCommandResults } from '../../src/collection/dataset-owner-protocol.js';
import type { MobileOwnerSourceRequest, MobileOwnerSourceResult } from '../../src/mobile/source-protocol.js';
import type { MobilePlaybackPreparedSource, MobilePlaybackSourceRequest } from '../../src/mobile/source-types.js';
import type { MobileOwnerPrivateFailure } from '../../src/mobile/types.js';
import { backendFixture, preparationWindow, valueHash } from './fixture-helpers.js';

// 真 Reader/Scanner、原单连接目录和 SAB 保护；只消费本轮专用 native 后端，不替代 Main/HTTP 或真机。
async function fixture(t: TestContext) {
  const f = await backendFixture(t), { core } = f, cache = await f.cache();
  const repository = core.repository.createCollectionRepository({ filePath: path.join(f.directory, 'collection.sqlite') });
  f.onClose(() => repository.close());
  const source = repository.sources.authorize(randomUUID(), await core.files.authorizeSourceDirectory(f.media));
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  const admission = core.admission.createScanReadAdmission({ isBusy: () => false }), context = { datasetId: f.datasetId, epoch: f.ownerEpoch };
  f.onClose(() => admission.close());
  const projection: DatasetProjectionPort = {
    async call<C extends DatasetProjectionCommand>(command: C, payload: DatasetProjectionCommandPayloads[C]): Promise<DatasetProjectionCommandResults[C]> {
      let value: unknown;
      if (command === 'scanReadAcquire') value = admission.acquire(context);
      else if (command === 'scanReadWatchRevocation') value = await admission.watchRevocation(context, (payload as { permitId: string }).permitId);
      else if (command === 'scanReadRelease') value = admission.release(context, (payload as { permitId: string }).permitId);
      else throw new Error('此夹具只提供真实扫描准入。');
      return value as DatasetProjectionCommandResults[C];
    },
  };
  const events: string[] = [], reader = core.reader.createMetadataReader({ concurrency: 1, maxPending: 1, dsdMetadataEnabled: cache.qualified,
    onLifecycle(event) { events.push(event.type); } });
  f.onClose(() => reader.close());
  const assertCurrent = () => { f.assertCurrent(); repository.readonlySnapshotStamp(); };
  const scanner = core.scanner.createLocalScanCoordinator({ repository, datasetId: f.datasetId, projection, reader, assertCurrent, dsdMetadataEnabled: cache.qualified });
  f.onClose(() => scanner.close());
  const started = scanner.start({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision });
  await scanner.privateWait(started.jobId);
  assert.equal(scanner.get(started.jobId).phase, 'completed');
  assert.deepEqual(scanner.get(started.jobId).progress, { visited: '2', accepted: '2', rejected: '0' });
  assert.equal(events.filter(event => event === 'read-complete').length, 2);
  assert.equal(events.filter(event => event === 'worker-start').length, events.filter(event => event === 'worker-exit').length);
  assert.equal(events.filter(event => event === 'lease-acquired').length, events.filter(event => event === 'lease-released').length);
  const tracks = repository.localCatalog.pageTracks({ offset: 0, limit: 200 }).items; assert.equal(tracks.length, 2);
  const selections = new Map<string, MobilePlaybackSourceRequest>();
  for (const ext of ['dsf', 'dff']) {
    const track = tracks.find(item => repository.localCatalog.privateAssetLocator(item.assetId).relative === `source.${ext}`); assert.ok(track);
    const observed = repository.localScan.privateCurrentFileState(root.id, `source.${ext}`); assert.ok(observed?.value.readFacts);
    assert.equal(observed.value.outcome, 'accepted'); assert.equal(observed.value.trackId, track.id);
    assert.deepEqual(observed.value.readFacts.technical, { container: ext.toUpperCase(), codec: 'DSD', lossless: true,
      sampleRateHz: 2_822_400, bitsPerSample: 1, channels: 2, durationSeconds: 32768 / 2822400, evidence: 'bounded-parser-reported' });
    assert.equal(observed.value.readFacts.readEvidence.wholeAudioHash, false); assert.equal(observed.value.readFacts.readEvidence.wholeAudioDecode, false);
    // 使用原 MB_ONLY 命令补合成源标题；不伪造扫描事实，也不写源标签。
    repository.localCatalog.overrideMetadata({ commandId: randomUUID(), trackId: track.id, expectedRevision: null, fields: { title: `自有 ${ext} 合成源` } });
    const edition = repository.localCatalog.createEdition({ commandId: randomUUID(), title: `自有 ${ext}`, edition: '实际扫描' });
    repository.localCatalog.linkEditionTrack({ commandId: randomUUID(), editionId: edition.id, trackId: track.id, disc: 1, trackNumber: 1, sequence: 1 });
    const asset = repository.localCatalog.asset(track.assetId), identity = valueHash([f.datasetId, asset.id, asset.fileRevision, track.selectionRevision, track.segment]);
    selections.set(ext, { resourceId: randomUUID(), trackId: `lt:${f.datasetId}:${track.id}:${edition.id}`, versionId: 'lv:' + identity, contentRevision: 'lc:' + identity });
  }
  const tickets = core.tickets.createLocalSourceTickets(repository, f.ownerEpoch, f.datasetId, assertCurrent); f.onClose(() => tickets.seal());
  const service = core.source.createMobileOwnerSourceService({ collection: repository, tickets, datasetId: f.datasetId, ownerEpoch: f.ownerEpoch, assertCurrent, preparedCache: cache });
  f.onClose(() => service.close());
  const catalog = core.owner.createMobileOwnerService({ collection: repository, datasetId: f.datasetId, ownerEpoch: f.ownerEpoch, assertCurrent, dsdToPcmAvailable: () => cache.qualified });
  const catalogRequest = { kind: 'catalog' as const, datasetId: f.datasetId, request: { operation: 'listTracks' as const, serverId: `server:${randomUUID()}`,
    offset: 0, limit: 100, q: '', albumId: null, itemId: null, expectedRevision: null, catalogPlaybackEnabled: true } };
  assert.equal(core.ownerProtocol.isMobileOwnerPrivateRequest(catalogRequest), true);
  const catalogResult = catalog.dispatch(catalogRequest); assert.equal(core.ownerProtocol.isMobileOwnerPrivateResult(catalogResult, catalogRequest), true);
  assert.ok('items' in catalogResult); assert.equal(catalogResult.items.length, 2);
  const catalogTracks = catalogResult.items as readonly MobileTrack[];
  for (const track of catalogTracks) { assert.equal(track.availability, 'available'); assert.equal(track.audio.bitsPerSample, 1); assert.equal(track.audio.sampleRateHz, 2822400); }
  async function dispatch(request: MobileOwnerSourceRequest) {
    assert.equal(core.protocol.isMobileOwnerSourceRequest(request), true);
    const result = await service.dispatch(request);
    if (result.kind !== 'mobile-error') assert.equal(core.protocol.isMobileOwnerSourceResult(result, request), true);
    return result;
  }
  function selection(ext = 'dsf', accepted = true): MobilePlaybackSourceRequest {
    const value = selections.get(ext); assert.ok(value);
    return { ...value, resourceId: randomUUID(), ...(accepted ? { acceptedProcessingModes: ['dsd_to_pcm'] as const, preparationWindow: preparationWindow(),
      dsdTarget: { maxChannels: 2, accepts24Bit48KhzFlac: true } } : {}) };
  }
  async function prepare(value: MobilePlaybackSourceRequest) {
    const result = await dispatch({ operation: 'prepare', selection: value }); assert.equal(result.kind, 'mobile-source-preparing');
    assert.ok(result.kind === 'mobile-source-preparing'); return result.source;
  }
  async function ready(handle: string): Promise<MobilePlaybackPreparedSource> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const result = await dispatch({ operation: 'status', handle });
      if (result.kind === 'mobile-source-prepared') return result.source;
      assert.equal(result.kind, 'mobile-source-preparing'); assert.ok(Date.now() < deadline);
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
  }
  function quiet() {
    const snapshot = service.resourceSnapshot();
    for (const key of ['liveResources', 'preparing', 'releasing', 'readers', 'activeIo', 'openLeases', 'reservations', 'tickets', 'retainedFences', 'lanes'] as const) assert.equal(snapshot[key], 0, key);
    assert.equal(cache.snapshot().jobs, 0); assert.equal(cache.snapshot().waitingResources, 0); assert.equal(cache.snapshot().active, 0); assert.equal(tickets.size, 0);
  }
  return { ...f, repository, cache, service, catalogTracks, selection, dispatch, prepare, ready, quiet };
}
function rejected(result: MobileOwnerSourceResult | MobileOwnerPrivateFailure, code: string, status = 409) {
  assert.equal(result.kind, 'mobile-error'); assert.ok(result.kind === 'mobile-error'); assert.equal(result.status, status); assert.equal(result.code, code);
  assert.equal(result.outcome, null); assert.deepEqual(Reflect.ownKeys(result).sort(), ['code', 'kind', 'outcome', 'retryable', 'status']);
}
function ack(result: MobileOwnerSourceResult | MobileOwnerPrivateFailure) {
  assert.equal(result.kind, 'mobile-source-ack'); assert.ok(result.kind === 'mobile-source-ack'); assert.equal(result.quiet, true);
}
async function allBytes(f: Awaited<ReturnType<typeof fixture>>, source: MobilePlaybackPreparedSource) {
  const readId = randomUUID(), chunks: Uint8Array[] = []; let start = 0;
  while (start < source.size) {
    const result = await f.dispatch({ operation: 'read', handle: source.handle, readId, start, maxBytes: 97 });
    assert.ok(result.kind === 'mobile-source-read'); assert.ok(result.bytes.length > 0 && result.bytes.length <= 97);
    chunks.push(result.bytes); start += result.bytes.length;
  }
  ack(await f.dispatch({ operation: 'close-read', handle: source.handle, readId })); return Buffer.concat(chunks);
}

test('MBM003原Owner真实链：扫描DSF/DFF、目录真实可用、旧客户端与声道不足零转换，采纳后全FLAC和缓存复用', { timeout: 60_000 }, async t => {
  const f = await fixture(t), initial = f.cache.snapshot();
  rejected(await f.dispatch({ operation: 'prepare', selection: f.selection('dsf', false) }), 'UNSUPPORTED_FORMAT');
  const limited = f.selection('dff'); limited.dsdTarget = { maxChannels: 1, accepts24Bit48KhzFlac: true };
  rejected(await f.dispatch({ operation: 'prepare', selection: limited }), 'UNSUPPORTED_FORMAT'); assert.deepEqual(f.cache.snapshot(), initial); f.quiet();
  for (const ext of ['dsf', 'dff']) {
    const selected = f.selection(ext), before = await lstat(path.join(f.media, `source.${ext}`), { bigint: true });
    const short = await f.prepare(selected); assert.equal(short.processing.mode, 'dsd_to_pcm');
    assert.equal('actualAudio' in short, false); assert.equal('size' in short, false);
    const source = await f.ready(short.handle), bytes = await allBytes(f, source);
    assert.equal(bytes.toString('ascii', 0, 4), 'fLaC'); assert.equal(bytes.length, source.size);
    assert.deepEqual(source.actualAudio, { codec: 'flac', container: 'flac', sampleRateHz: 48000, bitsPerSample: 24, channels: 2 });
    const second = await f.prepare(f.selection(ext)), hit = await f.ready(second.handle); assert.equal(hit.processing.fromPreparedCache, true);
    assert.deepEqual(await allBytes(f, hit), bytes);
    ack(await f.dispatch({ operation: 'renew', handle: source.handle }));
    ack(await f.dispatch({ operation: 'release', handle: source.handle })); ack(await f.dispatch({ operation: 'release', handle: hit.handle }));
    const after = await lstat(path.join(f.media, `source.${ext}`), { bigint: true });
    for (const field of ['dev', 'ino', 'size', 'mode', 'uid', 'gid', 'nlink', 'mtimeNs', 'ctimeNs', 'birthtimeNs'] as const) assert.equal(after[field], before[field]);
  }
  f.quiet(); await f.unchanged(); await f.close();
});

test('MBM003真实源变化围栏：ready后自有源修改拒409，派生bytes保持，全部原SAB和FD只在quiet后释放', { timeout: 45_000 }, async t => {
  const f = await fixture(t), short = await f.prepare(f.selection()), source = await f.ready(short.handle), full = await allBytes(f, source);
  const cacheRoot = path.join(f.directory, 'mobile-dsd-cache'), entry = (await readdir(cacheRoot))[0]!;
  const file = path.join(f.media, 'source.dsf'), changed = Buffer.from(f.originals.get('dsf')!); changed[100] = changed[100]! ^ 0xff; await writeFile(file, changed);
  rejected(await f.dispatch({ operation: 'read', handle: source.handle, readId: randomUUID(), start: 0, maxBytes: 64 }), 'SOURCE_CHANGED');
  rejected(await f.dispatch({ operation: 'renew', handle: source.handle }), 'SOURCE_CHANGED');
  assert.deepEqual(await readFile(path.join(cacheRoot, entry, 'audio.flac')), full); assert.deepEqual(await readFile(file), changed);
  assert.deepEqual(await readFile(path.join(f.media, 'source.dff')), f.originals.get('dff'));
  ack(await f.dispatch({ operation: 'release', handle: source.handle })); f.quiet(); await f.close();
});

test('MBM003真实释放与迟到ID：preparing取消等待实际后台静止，先close-read和release的原ID均不能重开', { timeout: 45_000 }, async t => {
  const f = await fixture(t), selected = f.selection(), short = await f.prepare(selected);
  ack(await f.dispatch({ operation: 'release', handle: short.handle })); f.quiet();
  rejected(await f.dispatch({ operation: 'prepare', selection: selected }), 'RESOURCE_RELEASED', 410);
  const next = await f.prepare(f.selection()), source = await f.ready(next.handle), readId = randomUUID();
  ack(await f.dispatch({ operation: 'close-read', handle: source.handle, readId }));
  rejected(await f.dispatch({ operation: 'read', handle: source.handle, readId, start: 0, maxBytes: 32 }), 'RESOURCE_RELEASED', 410);
  ack(await f.dispatch({ operation: 'release', handle: source.handle })); f.quiet(); await f.unchanged(); await f.close();
});
