import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, writeFile, type FileHandle } from 'node:fs/promises';
import { setImmediate as immediate } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MobilePlaybackPreparedSource, MobilePlaybackSourceRequest } from '../../src/mobile/playback-types.js';
import type { MobileOwnerSourceRequest, MobileOwnerSourceResult } from '../../src/mobile/source-protocol.js';
import type { MobileOwnerPrivateFailure } from '../../src/mobile/types.js';
import type { DatasetProjectionPort, DatasetProjectionCommand, DatasetProjectionCommandPayloads, DatasetProjectionCommandResults } from '../../src/collection/dataset-owner-protocol.js';
import { audioFixture, loadFreshMetadataReader, coreAudioIds } from '../helpers/mbrs003-audio-fixtures.js';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const hash = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
const valueHash = (value: unknown): string => hash(Buffer.from(JSON.stringify(value)));
interface BoundFile { path: string; bytes: number; sha256: string }
interface BoundOutput extends BoundFile { sourcePath: string; sourceSha256: string; mtimeMs: number }
interface Preparation {
  schema: string; status: string; readerBindingSha256: string; inputsUnchanged: boolean; outputsUnchanged: boolean;
  sourceInputs: BoundFile[]; outputs: BoundOutput[];
  stages: { name: string; compilerExit: number; startedMs: number; finishedMs: number }[];
}

async function wholeFile(file: string) {
  assert.equal(await realpath(file), file);
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await fd.stat({ bigint: true });
    assert.equal(before.isFile(), true); assert.equal(before.nlink, 1n);
    assert.ok(before.size > 0n && before.size <= 16n * 1024n * 1024n);
    const bytes = await fd.readFile(), after = await fd.stat({ bigint: true }), named = await lstat(file, { bigint: true });
    const axes = (v: typeof before) => [v.dev, v.ino, v.size, v.mode, v.uid, v.gid, v.nlink, v.mtimeNs, v.ctimeNs];
    assert.deepEqual(axes(after), axes(before)); assert.deepEqual(axes(named), axes(before));
    assert.equal(named.isSymbolicLink(), false); assert.equal(bytes.length, Number(before.size));
    return { bytes, sha256: hash(bytes), stat: before };
  } finally { await fd.close(); }
}

let moduleFlight: ReturnType<typeof loadModules> | undefined;
async function loadModules() {
  const reader = await loadFreshMetadataReader();
  const bindingFile = process.env.MBRS003_READER_BUILD_BINDING;
  assert.ok(bindingFile && path.isAbsolute(bindingFile), '必须消费本轮真实 Reader/完整 Core 编译收据。');
  const binding = await wholeFile(bindingFile), receiptFile = path.join(path.dirname(bindingFile), 'preparation-receipt.json');
  const receipt = await wholeFile(receiptFile), preparation = JSON.parse(receipt.bytes.toString('utf8')) as Preparation;
  assert.equal(preparation.schema, 'core-test.reader-preparation.v1'); assert.equal(preparation.status, 'FRESH_READER_PREPARED');
  assert.equal(preparation.readerBindingSha256, binding.sha256); assert.equal(preparation.inputsUnchanged, true); assert.equal(preparation.outputsUnchanged, true);
  assert.equal(new Set(preparation.sourceInputs.map(row => row.path)).size, preparation.sourceInputs.length);
  assert.equal(new Set(preparation.outputs.map(row => row.path)).size, preparation.outputs.length);
  const stage = preparation.stages.find(row => row.name === 'fresh-core-compiler'); assert.ok(stage); assert.equal(stage.compilerExit, 0);
  const checked: BoundFile[] = [];
  const modules = ['mobile/source-service', 'mobile/source-protocol', 'mobile/playback-types', 'mobile/types',
    'collection/repository', 'collection/local-source-tickets', 'collection/local-source-ticket-types',
    'collection/local-scan-coordinator', 'collection/local-scan-store', 'application/local-source-resolver',
    'recording/source-files', 'stream/local-file-source', 'stream/local-source-fence', 'stream/physical-resource-locks', 'library/scan-read-admission'];
  for (const module of modules) {
    const sourcePath = `packages/bridge-core/src/${module}.ts`, source = preparation.sourceInputs.find(row => row.path === sourcePath); assert.ok(source);
    checked.push(source);
    for (const extension of ['.js', '.js.map', '.d.ts']) {
      const relative = `packages/bridge-core/dist/${module}${extension}`, artifact = preparation.outputs.find(row => row.path === relative); assert.ok(artifact);
      assert.equal(artifact.sourcePath, sourcePath); assert.equal(artifact.sourceSha256, source.sha256);
      assert.ok(artifact.mtimeMs >= stage.startedMs && artifact.mtimeMs <= stage.finishedMs);
      const actual = await wholeFile(path.join(repositoryRoot, relative));
      assert.ok(actual.stat.mtimeNs >= BigInt(stage.startedMs) * 1_000_000n && actual.stat.mtimeNs <= BigInt(stage.finishedMs) * 1_000_000n);
      checked.push(artifact);
    }
  }
  async function assertBoundBytes() {
    assert.equal((await wholeFile(bindingFile!)).sha256, binding.sha256); assert.equal((await wholeFile(receiptFile)).sha256, receipt.sha256);
    for (const row of checked) {
      const actual = await wholeFile(path.join(repositoryRoot, row.path)); assert.equal(actual.bytes.length, row.bytes); assert.equal(actual.sha256, row.sha256);
    }
  }
  await assertBoundBytes();
  const repository = await import(new URL('../../dist/collection/repository.js', import.meta.url).href) as typeof import('../../src/collection/repository.js');
  const scanner = await import(new URL('../../dist/collection/local-scan-coordinator.js', import.meta.url).href) as typeof import('../../src/collection/local-scan-coordinator.js');
  const admission = await import(new URL('../../dist/library/scan-read-admission.js', import.meta.url).href) as typeof import('../../src/library/scan-read-admission.js');
  const files = await import(new URL('../../dist/recording/source-files.js', import.meta.url).href) as typeof import('../../src/recording/source-files.js');
  const tickets = await import(new URL('../../dist/collection/local-source-tickets.js', import.meta.url).href) as typeof import('../../src/collection/local-source-tickets.js');
  const fence = await import(new URL('../../dist/stream/local-source-fence.js', import.meta.url).href) as typeof import('../../src/stream/local-source-fence.js');
  const locks = await import(new URL('../../dist/stream/physical-resource-locks.js', import.meta.url).href) as typeof import('../../src/stream/physical-resource-locks.js');
  const protocol = await import(new URL('../../dist/mobile/source-protocol.js', import.meta.url).href) as typeof import('../../src/mobile/source-protocol.js');
  const source = await import(new URL('../../dist/mobile/source-service.js', import.meta.url).href) as typeof import('../../src/mobile/source-service.js');
  await assertBoundBytes(); return { reader, repository, scanner, admission, files, tickets, fence, locks, protocol, source, assertBoundBytes };
}
const core = () => moduleFlight ??= loadModules();

/** 真 SQLite/原 Scanner/固定 Reader/真 FD；同进程 Owner 组合，不冒充 RPC、HTTPS、设备或听感。 */
async function fixture(t: TestContext, ids: readonly string[] = ['core-wav']) {
  const inputs = await audioFixture(t), modules = await core(), cleanup: (() => Promise<void> | void)[] = [];
  let closeFlight: Promise<void> | undefined, ownerAlive = true;
  async function close() {
    if (closeFlight) return closeFlight;
    closeFlight = (async () => {
      const errors: unknown[] = [];
      for (const run of [...cleanup].reverse()) try { await run(); } catch (error) { errors.push(error); }
      try { await modules.assertBoundBytes(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, '手机原文件夹具未完全 quiet 关闭。');
    })(); return closeFlight;
  }
  t.after(close);
  const directory = path.join(inputs.directory, 'mobile-source'), media = path.join(directory, 'media');
  await mkdir(directory, { mode: 0o700 }); await chmod(directory, 0o700); await mkdir(media, { mode: 0o700 });
  const originals = new Map<string, Buffer>();
  for (const id of ids) {
    const bytes = await inputs.bytes(id); originals.set(id, bytes);
    await writeFile(path.join(media, path.basename(inputs.entry(id).file)), bytes, { mode: 0o600, flag: 'wx' });
  }
  const repository = modules.repository.createCollectionRepository({ filePath: path.join(directory, 'collection.sqlite') });
  cleanup.push(() => repository.close());
  const datasetId = randomUUID(), ownerEpoch = randomUUID();
  const capability = await modules.files.authorizeSourceDirectory(media), source = repository.sources.authorize(randomUUID(), capability);
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  const admission = modules.admission.createScanReadAdmission({ isBusy: () => false }), context = { datasetId, epoch: ownerEpoch };
  cleanup.push(() => admission.close());
  const projection: DatasetProjectionPort = {
    async call<C extends DatasetProjectionCommand>(command: C, payload: DatasetProjectionCommandPayloads[C]): Promise<DatasetProjectionCommandResults[C]> {
      let result: unknown;
      if (command === 'scanReadAcquire') result = admission.acquire(context);
      else if (command === 'scanReadWatchRevocation') result = await admission.watchRevocation(context, (payload as { permitId: string }).permitId);
      else if (command === 'scanReadRelease') result = admission.release(context, (payload as { permitId: string }).permitId);
      else throw new Error('此夹具不提供家庭播放、Provider或假扫描事实。');
      return result as DatasetProjectionCommandResults[C];
    },
  };
  const lifecycle: string[] = [], reader = modules.reader.createMetadataReader({ concurrency: 1, maxPending: 1, onLifecycle(event) { lifecycle.push(event.type); } });
  cleanup.push(() => reader.close());
  function assertCurrent() { if (!ownerAlive) throw new Error('受控 Owner epoch 已退休。'); repository.readonlySnapshotStamp(); }
  const scanner = modules.scanner.createLocalScanCoordinator({ repository, datasetId, projection, reader, assertCurrent });
  cleanup.push(() => scanner.close());
  const started = scanner.start({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision });
  await scanner.privateWait(started.jobId); assert.equal(scanner.get(started.jobId).phase, 'completed');
  assert.deepEqual(scanner.get(started.jobId).progress, { visited: String(ids.length), accepted: String(ids.length), rejected: '0' });
  assert.equal(lifecycle.filter(event => event === 'read-complete').length, ids.length);
  assert.equal(lifecycle.filter(event => event === 'worker-start').length, lifecycle.filter(event => event === 'worker-exit').length);
  assert.equal(lifecycle.filter(event => event === 'lease-acquired').length, lifecycle.filter(event => event === 'lease-released').length);
  const tracks = repository.localCatalog.pageTracks({ offset: 0, limit: 200 }).items; assert.equal(tracks.length, ids.length);
  const selections = new Map<string, MobilePlaybackSourceRequest>(), editionIds = new Map<string, string>();
  for (const id of ids) {
    const relative = path.basename(inputs.entry(id).file), track = tracks.find(item => repository.localCatalog.privateAssetLocator(item.assetId).relative === relative); assert.ok(track);
    const observed = repository.localScan.privateCurrentFileState(root.id, relative); assert.ok(observed?.value.readFacts);
    assert.equal(observed.value.outcome, 'accepted'); assert.equal(observed.value.trackId, track.id); assert.equal(observed.value.assetId, track.assetId);
    const edition = repository.localCatalog.createEdition({ commandId: randomUUID(), title: `自有 ${id}`, edition: '扫描原件' }); editionIds.set(id, edition.id);
    repository.localCatalog.linkEditionTrack({ commandId: randomUUID(), editionId: edition.id, trackId: track.id, disc: 1, trackNumber: 1, sequence: 1 });
    const asset = repository.localCatalog.asset(track.assetId), identity = valueHash([datasetId, asset.id, asset.fileRevision, track.selectionRevision, track.segment]);
    selections.set(id, { resourceId: randomUUID(), trackId: `lt:${datasetId}:${track.id}:${edition.id}`, versionId: 'lv:' + identity, contentRevision: 'lc:' + identity });
  }
  const tickets = modules.tickets.createLocalSourceTickets(repository, ownerEpoch, datasetId, assertCurrent);
  cleanup.push(() => tickets.seal());
  const service = modules.source.createMobileOwnerSourceService({ collection: repository, tickets, datasetId, ownerEpoch, assertCurrent });
  cleanup.push(async () => { await service.close(); assertQuiet(service); });
  function selection(id = ids[0]!, resourceId: string = randomUUID()) { const selected = selections.get(id); assert.ok(selected); return { ...selected, resourceId }; }
  function relative(id = ids[0]!) { return path.basename(inputs.entry(id).file); }
  async function dispatch(request: MobileOwnerSourceRequest) {
    assert.equal(modules.protocol.isMobileOwnerSourceRequest(request), true);
    const result = await service.dispatch(request);
    if (result.kind !== 'mobile-error') assert.equal(modules.protocol.isMobileOwnerSourceResult(result, request), true);
    return result;
  }
  async function prepare(value = selection()): Promise<MobilePlaybackPreparedSource> {
    const result = await dispatch({ operation: 'prepare', selection: value }); assert.equal(result.kind, 'mobile-source-prepared');
    if (result.kind !== 'mobile-source-prepared') throw new Error('真实源准备未成功。'); return result.source;
  }
  return { modules, inputs, media, repository, root, source, datasetId, ownerEpoch, originals, selections, editionIds,
    tracks, tickets, service, cleanup, selection, relative, dispatch, prepare, close, retireOwner() { ownerAlive = false; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function assertQuiet(service: ReturnType<Awaited<ReturnType<typeof core>>['source']['createMobileOwnerSourceService']>) {
  const snapshot = service.resourceSnapshot();
  for (const key of ['liveResources', 'preparing', 'releasing', 'readers', 'activeIo', 'openLeases', 'reservations', 'tickets', 'retainedFences', 'lanes'] as const) assert.equal(snapshot[key], 0, `${key} 必须实际归零。`);
}
function safeFailure(result: MobileOwnerSourceResult | MobileOwnerPrivateFailure, status: number, code: string) {
  assert.equal(result.kind, 'mobile-error'); assert.ok(result.kind === 'mobile-error');
  assert.equal(result.status, status); assert.equal(result.code, code); assert.equal(result.outcome, null);
  assert.deepEqual(Reflect.ownKeys(result).sort(), ['code', 'kind', 'outcome', 'retryable', 'status']); return result;
}
function readBytes(result: MobileOwnerSourceResult | MobileOwnerPrivateFailure): Uint8Array {
  assert.equal(result.kind, 'mobile-source-read'); assert.ok(result.kind === 'mobile-source-read');
  assert.equal(Object.getPrototypeOf(result.bytes), Uint8Array.prototype); return result.bytes;
}
function quietAck(result: MobileOwnerSourceResult | MobileOwnerPrivateFailure) { assert.equal(result.kind, 'mobile-source-ack'); assert.ok(result.kind === 'mobile-source-ack'); assert.equal(result.quiet, true); }

/** 只延迟已执行真实 FileHandle.read 的返回，不伪造 FD、字节、扫描观察或 qualified DTO。 */
async function holdOneActualRead(t: TestContext, f: Fixture, initiallyArmed = true) {
  const probe = await open(path.join(f.media, f.relative()), constants.O_RDONLY | constants.O_NOFOLLOW);
  const prototype = Object.getPrototypeOf(probe) as { read: FileHandle['read'] }; await probe.close();
  const original = prototype.read;
  let enter!: () => void, resume!: () => void, consumed = false, armed = initiallyArmed, calls = 0;
  const entered = new Promise<void>(resolve => { enter = resolve; }), resumed = new Promise<void>(resolve => { resume = resolve; });
  f.cleanup.push(resume);
  t.mock.method(prototype, 'read', async function (this: FileHandle, ...args: unknown[]) {
    calls++; const result = await Reflect.apply(original, this, args);
    if (armed && !consumed) { consumed = true; enter(); await resumed; }
    return result;
  });
  return { entered, resume, arm() { armed = true; }, get calls() { return calls; } };
}

test('MBM002 真 Scanner 的 WAV 原件按完整字节与独立 Range 读取，不把切片声称为音频解码', async t => {
  const f = await fixture(t), selected = f.selection(), source = await f.prepare(selected), original = f.originals.get('core-wav')!;
  assert.equal(source.handle, selected.resourceId); assert.equal(source.size, original.length); assert.equal(source.contentType, 'audio/wav');
  assert.deepEqual(source.sourceAudio, source.actualAudio); assert.deepEqual(source.processing, { mode: 'direct', reason: '原工作库当前扫描文件的直接只读传输。', fromPreparedCache: false });
  const readId = randomUUID(), blocks: Uint8Array[] = [];
  for (let offset = 0; offset < original.length;) {
    const bytes = readBytes(await f.dispatch({ operation: 'read', handle: source.handle, readId, start: offset, maxBytes: 64 * 1024 }));
    assert.ok(bytes.length > 0 && bytes.length <= 64 * 1024); blocks.push(bytes); offset += bytes.length;
  }
  assert.deepEqual(Buffer.concat(blocks), original);
  assert.equal(readBytes(await f.dispatch({ operation: 'read', handle: source.handle, readId, start: original.length, maxBytes: 64 * 1024 })).length, 0);
  const ranges = await Promise.all([7, original.length - 17].map(start => f.dispatch({ operation: 'read', handle: source.handle, readId: randomUUID(), start, maxBytes: 13 })));
  assert.deepEqual(readBytes(ranges[0]!), new Uint8Array(original.subarray(7, 20)));
  assert.deepEqual(readBytes(ranges[1]!), new Uint8Array(original.subarray(original.length - 17, original.length - 4)));
  quietAck(await f.dispatch({ operation: 'release', handle: source.handle })); assertQuiet(f.service);
});

test('MBM002 五个可直接读取格式保真实参数与源字节，实际 AAC 显式不支持而不伪造转码', async t => {
  const f = await fixture(t, coreAudioIds);
  for (const [id, contentType] of [['core-flac', 'audio/flac'], ['core-mp3', 'audio/mpeg'], ['core-m4a-alac', 'audio/mp4'], ['core-wav', 'audio/wav'], ['core-aiff', 'audio/aiff']] as const) {
    const source = await f.prepare(f.selection(id)), observed = f.repository.localScan.privateCurrentFileState(f.root.id, f.relative(id))!.value.readFacts!.technical;
    assert.equal(source.contentType, contentType); assert.equal(source.sourceAudio.sampleRateHz, observed.sampleRateHz); assert.equal(source.sourceAudio.channels, observed.channels);
    assert.equal(source.sourceAudio.bitsPerSample ?? null, observed.bitsPerSample); assert.deepEqual(source.actualAudio, source.sourceAudio);
    assert.equal(source.durationMs, Math.round(observed.durationSeconds! * 1000)); assert.equal(source.processing.mode, 'direct'); assert.equal(source.processing.fromPreparedCache, false);
    const original = f.originals.get(id)!, start = Math.min(19, original.length - 1);
    assert.deepEqual(readBytes(await f.dispatch({ operation: 'read', handle: source.handle, readId: randomUUID(), start, maxBytes: 64 * 1024 })), new Uint8Array(original.subarray(start, start + 64 * 1024)));
    quietAck(await f.dispatch({ operation: 'release', handle: source.handle })); assertQuiet(f.service);
  }
  safeFailure(await f.dispatch({ operation: 'prepare', selection: f.selection('core-m4a-aac') }), 409, 'UNSUPPORTED_FORMAT'); assertQuiet(f.service);
});

test('MBM002 准备必须匹配真实工作库、发行归属与完整内容版本，未知身份不能取得 FD', async t => {
  const f = await fixture(t), selection = f.selection();
  const cases: [MobilePlaybackSourceRequest, number, string][] = [
    [{ ...selection, resourceId: randomUUID(), versionId: 'lv:' + '0'.repeat(64) }, 409, 'SOURCE_CHANGED'],
    [{ ...selection, resourceId: randomUUID(), contentRevision: 'lc:' + '0'.repeat(64) }, 409, 'SOURCE_CHANGED'],
    [{ ...selection, resourceId: randomUUID(), trackId: selection.trackId.replace(f.datasetId, randomUUID()) }, 404, 'INVALID_REQUEST'],
    [{ ...selection, resourceId: randomUUID(), trackId: `lt:${f.datasetId}:${f.tracks[0]!.id}:${randomUUID()}` }, 404, 'INVALID_REQUEST'],
    [{ ...selection, resourceId: randomUUID(), trackId: `lt:${f.datasetId}:${randomUUID()}:${f.editionIds.get('core-wav')}` }, 404, 'INVALID_REQUEST'],
  ];
  for (const [request, status, code] of cases) { safeFailure(await f.dispatch({ operation: 'prepare', selection: request }), status, code); assertQuiet(f.service); }
});

test('MBM002 未扫描文件与有真实段选取的曲目明确拒绝，不能借已有整文件扫描观察', async t => {
  const f = await fixture(t), original = f.originals.get('core-wav')!;
  await writeFile(path.join(f.media, 'not-scanned.wav'), original, { mode: 0o600, flag: 'wx' });
  const asset = f.repository.localCatalog.registerAsset({ commandId: randomUUID(), libraryRootId: f.root.id, expectedRootRevision: f.root.revision,
    relative: 'not-scanned.wav', sha256: null, sampleFrames: null, timebaseHz: null });
  const whole = f.repository.localCatalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: null });
  // 段资产的帧数来自这份自有 WAV 的真实 fmt/data 字节，不修改原 Scanner 的观察。
  assert.equal(original.subarray(0, 4).toString('ascii'), 'RIFF'); assert.equal(original.subarray(8, 12).toString('ascii'), 'WAVE');
  let blockAlign = 0, timebaseHz = 0, dataBytes = 0;
  for (let at = 12; at + 8 <= original.length;) {
    const kind = original.subarray(at, at + 4).toString('ascii'), bytes = original.readUInt32LE(at + 4); assert.ok(at + 8 + bytes <= original.length);
    if (kind === 'fmt ') { assert.equal(original.readUInt16LE(at + 8), 1); blockAlign = original.readUInt16LE(at + 20); timebaseHz = original.readUInt32LE(at + 12); }
    if (kind === 'data') dataBytes += bytes;
    at += 8 + bytes + (bytes % 2);
  }
  assert.ok(blockAlign > 0 && dataBytes >= 128 * blockAlign); assert.equal(dataBytes % blockAlign, 0);
  await writeFile(path.join(f.media, 'segment.wav'), original, { mode: 0o600, flag: 'wx' });
  const segmentAsset = f.repository.localCatalog.registerAsset({ commandId: randomUUID(), libraryRootId: f.root.id, expectedRootRevision: f.root.revision,
    relative: 'segment.wav', sha256: hash(original), sampleFrames: String(dataBytes / blockAlign), timebaseHz });
  const segment = f.repository.localCatalog.createTrack({ commandId: randomUUID(), assetId: segmentAsset.id,
    segment: { startFrame: '0', endFrameExclusive: '128', timebaseHz } });
  for (const track of [whole, segment]) {
    const edition = f.repository.localCatalog.createEdition({ commandId: randomUUID(), title: '明确缺乏整文件读取资格', edition: '独立测试' });
    f.repository.localCatalog.linkEditionTrack({ commandId: randomUUID(), editionId: edition.id, trackId: track.id, disc: 1, trackNumber: 1, sequence: 1 });
    const selected = f.repository.localCatalog.asset(track.assetId), identity = valueHash([f.datasetId, selected.id, selected.fileRevision, track.selectionRevision, track.segment]);
    safeFailure(await f.dispatch({ operation: 'prepare', selection: { resourceId: randomUUID(), trackId: `lt:${f.datasetId}:${track.id}:${edition.id}`,
      versionId: 'lv:' + identity, contentRevision: 'lc:' + identity } }), 409, track.segment === null ? 'SOURCE_CHANGED' : 'UNSUPPORTED_FORMAT'); assertQuiet(f.service);
  }
});

test('MBM002 release 先到和 prepare 在途晚到均保原资源 tombstone，quiet ACK 后不能再开 FD', async t => {
  const f = await fixture(t), early = f.selection();
  quietAck(await f.dispatch({ operation: 'release', handle: early.resourceId }));
  safeFailure(await f.dispatch({ operation: 'prepare', selection: early }), 410, 'RESOURCE_RELEASED'); assertQuiet(f.service);
  const late = f.selection(), preparing = f.dispatch({ operation: 'prepare', selection: late });
  await Promise.resolve(); assert.equal(f.service.resourceSnapshot().retainedFences, 1, '此时已实际捕获事实并保留保护，FD 准备仍在途。');
  const released = await f.dispatch({ operation: 'release', handle: late.resourceId });
  quietAck(released); safeFailure(await preparing, 410, 'RESOURCE_RELEASED'); assertQuiet(f.service);
  safeFailure(await f.dispatch({ operation: 'prepare', selection: late }), 410, 'RESOURCE_RELEASED'); assertQuiet(f.service);
});

test('MBM002 同资源精确 prepare 只返回原句柄，改正文拒绝且返回副本不能改原音频事实', async t => {
  const f = await fixture(t), selected = f.selection();
  const [first, duplicate] = await Promise.all([f.prepare(selected), f.prepare({ ...selected })]); assert.deepEqual(first, duplicate);
  assert.equal(f.service.resourceSnapshot().openLeases, 1); assert.equal(f.tickets.size, 1);
  first.sourceAudio.sampleRateHz = 8_000;
  assert.deepEqual(await f.prepare({ ...selected }), duplicate);
  safeFailure(await f.dispatch({ operation: 'prepare', selection: { ...selected, contentRevision: 'lc:' + '0'.repeat(64) } }), 409, 'IDEMPOTENCY_CONFLICT');
  quietAck(await f.dispatch({ operation: 'release', handle: selected.resourceId }));
  safeFailure(await f.dispatch({ operation: 'prepare', selection: selected }), 410, 'RESOURCE_RELEASED'); assertQuiet(f.service);
});

test('MBM002 八资源与每资源四读槽保持原上限，关闭原读 ID 后不可复用', async t => {
  const f = await fixture(t), sources = await Promise.all(Array.from({ length: 8 }, () => f.prepare()));
  assert.equal(f.service.resourceSnapshot().openLeases, 8); assert.equal(f.service.resourceSnapshot().lanes, 8);
  assert.equal(safeFailure(await f.dispatch({ operation: 'prepare', selection: f.selection() }), 429, 'RESOURCE_BUSY').retryable, true);
  const readIds: string[][] = [];
  for (const source of sources) {
    const ids = Array.from({ length: 4 }, () => randomUUID()); readIds.push(ids);
    for (const readId of ids) assert.equal(readBytes(await f.dispatch({ operation: 'read', handle: source.handle, readId, start: 0, maxBytes: 1 })).length, 1);
    assert.equal(safeFailure(await f.dispatch({ operation: 'read', handle: source.handle, readId: randomUUID(), start: 0, maxBytes: 1 }), 429, 'RESOURCE_BUSY').retryable, true);
  }
  assert.equal(f.service.resourceSnapshot().readers, 32);
  quietAck(await f.dispatch({ operation: 'close-read', handle: sources[0]!.handle, readId: readIds[0]![0]! }));
  safeFailure(await f.dispatch({ operation: 'read', handle: sources[0]!.handle, readId: readIds[0]![0]!, start: 1, maxBytes: 1 }), 410, 'RESOURCE_RELEASED');
  assert.equal(readBytes(await f.dispatch({ operation: 'read', handle: sources[0]!.handle, readId: randomUUID(), start: 0, maxBytes: 1 })).length, 1);
  await Promise.all(sources.map(source => f.dispatch({ operation: 'release', handle: source.handle }).then(quietAck))); assertQuiet(f.service);
});

test('MBM002 多于旧 Pool owner 表容量的顺序资源沿固定 lane 单调续用而不泄漏票据', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 24; index++) {
    const source = await f.prepare(); assert.equal(f.service.resourceSnapshot().openLeases, 1);
    quietAck(await f.dispatch({ operation: 'renew', handle: source.handle }));
    quietAck(await f.dispatch({ operation: 'release', handle: source.handle })); assertQuiet(f.service);
  }
  assert.equal(f.service.resourceSnapshot().records, 24);
});

test('MBM002 真 FD 阻止物理写者，事实变更先回滚且原 hold 只在 quiet 后退休', async t => {
  const f = await fixture(t, ['core-wav', 'core-aiff']), selected = f.selection('core-wav'), source = await f.prepare(selected);
  const named = await lstat(path.join(f.media, f.relative('core-wav')), { bigint: true });
  assert.throws(() => f.modules.locks.physicalResourceLocks.acquireWrite([{ dev: String(named.dev), ino: String(named.ino) }]), f.modules.locks.PhysicalResourceBusy);
  const before = f.repository.localCatalog.track(f.tracks.find(track => `lt:${f.datasetId}:${track.id}:${f.editionIds.get('core-wav')}` === selected.trackId)!.id);
  const replacement = f.tracks.find(track => track.id !== before.id)!, change = { commandId: randomUUID(), trackId: before.id,
    expectedSelectionRevision: before.selectionRevision, assetId: replacement.assetId };
  assert.throws(() => f.repository.localCatalog.selectAsset(change), f.modules.fence.LocalFactsFenceBusy);
  assert.deepEqual(f.repository.localCatalog.track(before.id), before, '未静止的事实修改必须真实 ROLLBACK。');
  safeFailure(await f.dispatch({ operation: 'verify', handle: source.handle }), 409, 'SOURCE_CHANGED'); assertQuiet(f.service);
  const changed = f.repository.localCatalog.selectAsset(change); assert.equal(changed.assetId, replacement.assetId);
  const write = f.modules.locks.physicalResourceLocks.acquireWrite([{ dev: String(named.dev), ino: String(named.ino) }]); await write.release();
});

test('MBM002 自有文件在扫描后外部改变时，真实后核拒绝原读取能力并排空 FD', async t => {
  const f = await fixture(t), source = await f.prepare(), file = path.join(f.media, f.relative());
  const writer = await open(file, constants.O_WRONLY | constants.O_NOFOLLOW);
  try { await writer.write(Buffer.from([0]), 0, 1, source.size); } finally { await writer.close(); }
  safeFailure(await f.dispatch({ operation: 'read', handle: source.handle, readId: randomUUID(), start: 0, maxBytes: 1 }), 409, 'SOURCE_CHANGED'); assertQuiet(f.service);
  // 原验证失败保留在资源 tombstone；重复查询/准备不能重开 FD 或把源变化改说成显式释放。
  const retired = f.service.resourceSnapshot();
  safeFailure(await f.dispatch({ operation: 'verify', handle: source.handle }), 409, 'SOURCE_CHANGED');
  safeFailure(await f.dispatch({ operation: 'prepare', selection: f.selection('core-wav', source.handle) }), 409, 'SOURCE_CHANGED'); assertQuiet(f.service);
  assert.deepEqual(f.service.resourceSnapshot(), retired, '原资源失败查询不能增加记录、读能力或 FD。');
  quietAck(await f.dispatch({ operation: 'release', handle: source.handle })); assertQuiet(f.service);
  safeFailure(await f.dispatch({ operation: 'verify', handle: source.handle }), 410, 'RESOURCE_RELEASED'); assertQuiet(f.service);

  // 后台监测先发现变化也必须保留真实原因；等待实际 quiet，而非猜测定时器触发时间。
  const watched = await fixture(t), watchedSource = await watched.prepare(), watchedFile = path.join(watched.media, watched.relative());
  const watchedWriter = await open(watchedFile, constants.O_WRONLY | constants.O_NOFOLLOW);
  try { await watchedWriter.write(Buffer.from([0]), 0, 1, watchedSource.size); } finally { await watchedWriter.close(); }
  const deadline = Date.now() + 5_000;
  while (watched.service.resourceSnapshot().openLeases !== 0 || watched.service.resourceSnapshot().retainedFences !== 0) {
    assert.ok(Date.now() < deadline, '后台真实租约必须在预算内排空 FD 与事实保护。');
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  assertQuiet(watched.service);
  safeFailure(await watched.dispatch({ operation: 'verify', handle: watchedSource.handle }), 409, 'SOURCE_CHANGED');
  safeFailure(await watched.dispatch({ operation: 'prepare', selection: watched.selection('core-wav', watchedSource.handle) }), 409, 'SOURCE_CHANGED');
  assertQuiet(watched.service);
  quietAck(await watched.dispatch({ operation: 'release', handle: watchedSource.handle }));
  safeFailure(await watched.dispatch({ operation: 'verify', handle: watchedSource.handle }), 410, 'RESOURCE_RELEASED'); assertQuiet(watched.service);
});

test('MBM002 close-read 等待受控真实 read 返回后才 quiet，重试块与乱序块不重复读取', { timeout: 30_000 }, async t => {
  const f = await fixture(t), source = await f.prepare(), readId = randomUUID();
  const controlled = await holdOneActualRead(t, f, false);
  const original = f.originals.get('core-wav')!, request = { operation: 'read', handle: source.handle, readId, start: 7, maxBytes: 13 } as const;
  const first = readBytes(await f.dispatch(request)); assert.deepEqual(first, new Uint8Array(original.subarray(7, 20))); assert.equal(controlled.calls, 1); first[0] = 0;
  assert.deepEqual(readBytes(await f.dispatch(request)), new Uint8Array(original.subarray(7, 20)));
  assert.equal(controlled.calls, 1, '同原块只返回原完整字节，不重新执行真实 FD read。');
  safeFailure(await f.dispatch({ ...request, start: 21 }), 409, 'INVALID_REQUEST');
  controlled.arm(); const pending = f.dispatch({ ...request, start: 20 });
  await controlled.entered;
  let acknowledged = false;
  const close = f.dispatch({ operation: 'close-read', handle: source.handle, readId }).then(result => { acknowledged = true; return result; });
  try { await immediate(); assert.equal(acknowledged, false); assert.ok(f.service.resourceSnapshot().activeIo >= 1); }
  finally { controlled.resume(); }
  quietAck(await close); safeFailure(await pending, 410, 'RESOURCE_RELEASED');
  assert.equal(f.service.resourceSnapshot().readers, 0); assert.equal(f.service.resourceSnapshot().openLeases, 1);
  safeFailure(await f.dispatch({ ...request, start: 20 }), 410, 'RESOURCE_RELEASED');
  assert.equal(readBytes(await f.dispatch({ ...request, readId: randomUUID(), start: 20 })).length, 13);
  quietAck(await f.dispatch({ operation: 'release', handle: source.handle })); assertQuiet(f.service);
});

test('MBM002 release 和 service close 在真实 read 在途时不早报 quiet，未知晚到 read 也不能取得能力', { timeout: 30_000 }, async t => {
  const f = await fixture(t), source = await f.prepare(), controlled = await holdOneActualRead(t, f);
  const pending = f.dispatch({ operation: 'read', handle: source.handle, readId: randomUUID(), start: 0, maxBytes: 32 });
  await controlled.entered; let acknowledged = false;
  const release = f.dispatch({ operation: 'release', handle: source.handle }).then(result => { acknowledged = true; return result; });
  const close = f.service.close();
  try { await immediate(); assert.equal(acknowledged, false); assert.equal(f.service.resourceSnapshot().retainedFences, 1); assert.equal(f.service.resourceSnapshot().openLeases, 1); }
  finally { controlled.resume(); }
  quietAck(await release); safeFailure(await pending, 410, 'RESOURCE_RELEASED'); await close; assertQuiet(f.service);
  safeFailure(await f.dispatch({ operation: 'read', handle: source.handle, readId: randomUUID(), start: 0, maxBytes: 1 }), 410, 'RESOURCE_RELEASED');
});

test('MBM002 原 Owner 退休与私有信封伪造均不能产生源读取结果或隐式执行 getter', async t => {
  const f = await fixture(t), source = await f.prepare(); let invoked = 0;
  const forged = { operation: 'read' as const, handle: source.handle, readId: randomUUID(), start: 0, get maxBytes() { invoked++; return 1; } };
  safeFailure(await f.service.dispatch(forged), 400, 'INVALID_REQUEST'); assert.equal(invoked, 0);
  safeFailure(await f.service.dispatch({ operation: 'read', handle: source.handle, readId: randomUUID(), start: 0, maxBytes: 65537 }), 400, 'INVALID_REQUEST');
  f.retireOwner(); safeFailure(await f.dispatch({ operation: 'verify', handle: source.handle }), 503, 'BUSY'); assertQuiet(f.service);
  safeFailure(await f.dispatch({ operation: 'prepare', selection: f.selection() }), 503, 'BUSY'); assertQuiet(f.service);
});
