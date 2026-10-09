import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import fs, { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, rename, writeFile, type FileHandle } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { setImmediate as immediate } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MobilePlaybackPreparedSource, MobilePlaybackSourceRequest } from '../../src/mobile/playback-types.js';
import type { MobileOwnerSourceRequest, MobileOwnerSourceResult } from '../../src/mobile/source-protocol.js';
import type { MobileOwnerCatalogRequest, MobileOwnerCatalogSnapshot, MobileOwnerPrivateFailure, MobileOwnerPrivateRequest } from '../../src/mobile/types.js';
import type { MobileTrack } from '@music-bridge/contracts';
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
    'mobile/owner-service', 'mobile/owner-protocol', 'mobile/catalog-service', 'mobile/sealed-state-store',
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
  const owner = await import(new URL('../../dist/mobile/owner-service.js', import.meta.url).href) as typeof import('../../src/mobile/owner-service.js');
  const ownerProtocol = await import(new URL('../../dist/mobile/owner-protocol.js', import.meta.url).href) as typeof import('../../src/mobile/owner-protocol.js');
  await assertBoundBytes(); return { reader, repository, scanner, admission, files, tickets, fence, locks, protocol, source, owner, ownerProtocol, assertBoundBytes };
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
  const catalog = modules.owner.createMobileOwnerService({ collection: repository, datasetId, ownerEpoch, assertCurrent });
  const serverId = `server:${randomUUID()}`;
  function catalogDispatch(overrides: Partial<MobileOwnerCatalogRequest> = {}): MobileOwnerCatalogSnapshot | MobileOwnerPrivateFailure {
    const request: MobileOwnerPrivateRequest = { kind: 'catalog', datasetId, request: { operation: 'listTracks', serverId,
      offset: 0, limit: 100, q: '', albumId: null, itemId: null, expectedRevision: null, ...overrides } };
    assert.equal(modules.ownerProtocol.isMobileOwnerPrivateRequest(request), true, '测试只发送当前可信私有闭集请求。');
    const result = catalog.dispatch(request);
    assert.equal(modules.ownerProtocol.isMobileOwnerPrivateResult(result, request), true, '目录结果必须通过原私有合同。');
    return result as MobileOwnerCatalogSnapshot | MobileOwnerPrivateFailure;
  }
  function catalogTracks(overrides: Partial<MobileOwnerCatalogRequest> = {}): MobileOwnerCatalogSnapshot {
    const result = catalogDispatch(overrides);
    if ('kind' in result) {
      const fixtures = [...selections].map(([id, selected]) => {
        const trackId = selected.trackId.split(':')[2]!, original = repository.localCatalog.trackDetail(trackId);
        const parameters = repository.localScan.privateDisplayFileParameters(trackId, original.asset);
        const scannerCodec = repository.localScan.privateCurrentFileState(root.id, path.basename(inputs.entry(id).file))?.value.readFacts?.technical.codec ?? null;
        return { id, titlePresent: Boolean(original.metadata.effective.title), scannerCodec, fileParameters: parameters === null ? null : {
          container: parameters.container, codec: parameters.codec, lossless: parameters.lossless,
          sampleRateHz: parameters.sampleRateHz, channels: parameters.channels, bitsPerSample: parameters.bitsPerSample, durationMs: parameters.durationMs,
        } };
      });
      assert.fail(`当前合成目录应能产生完整安全快照：${JSON.stringify({ status: result.status, code: result.code, fixtures })}`);
    }
    return result;
  }
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
    tracks, tickets, service, cleanup, selection, relative, dispatch, prepare, catalogDispatch, catalogTracks, close, retireOwner() { ownerAlive = false; } };
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

function catalogTrack(snapshot: MobileOwnerCatalogSnapshot, id: string): MobileTrack {
  const item = snapshot.items.find(value => value.id === id);
  assert.ok(item && 'availability' in item, '应消费原 Owner 的完整曲目投影。');
  return item;
}

/** 审计真实同步短 FD 的配对；不替代安全根检查、不模拟扫描事实或音频内容。 */
function auditCatalogFileDescriptors(t: TestContext) {
  const opened = new Set<number>(), originalOpen = fs.openSync, originalClose = fs.closeSync;
  let opens = 0, closes = 0, restored = false;
  const opening = t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    const flags = args[1];
    assert.equal(typeof flags, 'number', '目录资格只允许明确的只读、不跟随符号链接标志。');
    assert.equal(Number(flags) & (constants.O_WRONLY | constants.O_RDWR), 0, '目录资格不能打开写描述符。');
    assert.equal(Number(flags) & constants.O_NOFOLLOW, constants.O_NOFOLLOW, '目录资格不能跟随末级符号链接。');
    const descriptor = Reflect.apply(originalOpen, fs, args) as number;
    opened.add(descriptor); opens++; return descriptor;
  });
  const closing = t.mock.method(fs, 'closeSync', (descriptor: number) => {
    Reflect.apply(originalClose, fs, [descriptor]);
    if (opened.delete(descriptor)) closes++;
  });
  syncBuiltinESMExports();
  function restore() {
    if (restored) return; restored = true;
    opening.mock.restore(); closing.mock.restore(); syncBuiltinESMExports();
  }
  t.after(restore);
  return { restore, get opens() { return opens; }, assertQuiet() {
    assert.equal(opened.size, 0, '目录响应返回前所有实际短 FD 必须关闭。');
    assert.equal(opens, closes, '目录查询不能留下同步文件描述符。');
  } };
}

/** 在原冻结 WAV 用例中补目录门禁，不增加顶层用例或子测试计数。 */
async function assertCatalogWavAvailability(t: TestContext, f: Fixture) {
  const selected = f.selection(), file = path.join(f.media, f.relative());
  const before = await wholeFile(file), stamp = f.repository.readonlySnapshotStamp(), resources = f.service.resourceSnapshot();
  const audit = auditCatalogFileDescriptors(t);
  try {
    const readonly = f.catalogTracks(), disabled = f.catalogTracks({ catalogPlaybackEnabled: false });
    assert.equal(catalogTrack(readonly, selected.trackId).availability, 'unavailable');
    assert.equal(catalogTrack(disabled, selected.trackId).availability, 'unavailable');
    assert.equal(readonly.libraryRevision, disabled.libraryRevision);
    assert.equal(audit.opens, 0, '001查询不能为历史参数打开媒体 FD。'); audit.assertQuiet();
    const enabled = f.catalogTracks({ catalogPlaybackEnabled: true }), projected = catalogTrack(enabled, selected.trackId);
    assert.equal(projected.availability, 'available', '当前授权、真实Scanner合格的完整WAV必须让设备目录允许点播。');
    assert.ok(audit.opens > 0, '审计必须观察到WAV头检查的真实只读短FD，不能以零次开关冒充已核关闭。');
    assert.notEqual(enabled.libraryRevision, readonly.libraryRevision, '启用边界变化必须使原目录页身份失效。');
    assert.equal(projected.versionId, selected.versionId); assert.equal(projected.contentRevision, selected.contentRevision);
    const detail = f.catalogTracks({ operation: 'getTrack', limit: 1, itemId: selected.trackId, catalogPlaybackEnabled: true });
    assert.deepEqual(catalogTrack(detail, selected.trackId), projected, '列表和详情必须给出同一当前可用性。');
    safeFailure(f.catalogDispatch({ catalogPlaybackEnabled: true, expectedRevision: readonly.libraryRevision }) as MobileOwnerPrivateFailure, 409, 'SOURCE_CHANGED');
    for (let index = 0; index < 4; index++) {
      assert.equal(catalogTrack(f.catalogTracks({ catalogPlaybackEnabled: true }), selected.trackId).availability, 'available'); audit.assertQuiet();
    }
    assert.deepEqual(f.repository.readonlySnapshotStamp(), stamp, '目录查询不能改写工作库。');
    assert.deepEqual(f.service.resourceSnapshot(), resources, '目录查询不能产生播放资源、lane、持久FD或资源墓碑。');
    assert.equal(f.tickets.size, 0, '目录资格不能签发读取票据。');
    audit.assertQuiet();
  } finally { audit.restore(); }
  const after = await wholeFile(file);
  const sourceAxes = (value: typeof before.stat) => [value.dev, value.ino, value.size, value.mode, value.uid, value.gid, value.nlink, value.mtimeNs, value.ctimeNs];
  assert.equal(after.sha256, before.sha256); assert.deepEqual(sourceAxes(after.stat), sourceAxes(before.stat), '可用性查询不能修改合成原件的内容或身份轴。');
  const named = after.stat, writer = f.modules.locks.physicalResourceLocks.acquireWrite([{ dev: String(named.dev), ino: String(named.ino) }]);
  await writer.release();
  // available仍是即时目录事实；原源服务负责真正准备读取能力，不能靠目录提前prepare。
  const source = await f.prepare(selected);
  assert.equal(source.contentType, 'audio/wav');
  assert.deepEqual({ ...source.actualAudio }, { ...catalogTrack(f.catalogTracks({ catalogPlaybackEnabled: true }), selected.trackId).audio });
  quietAck(await f.dispatch({ operation: 'release', handle: source.handle })); assertQuiet(f.service);
}

async function assertCatalogOfflineAndMissing(t: TestContext) {
  for (const fault of ['offline-root', 'missing-file'] as const) {
    const f = await fixture(t), selected = f.selection();
    assert.equal(catalogTrack(f.catalogTracks({ catalogPlaybackEnabled: true }), selected.trackId).availability, 'available');
    const original = fault === 'offline-root' ? f.media : path.join(f.media, f.relative());
    const isolated = path.join(f.inputs.directory, fault);
    await rename(original, isolated);
    try {
      const resources = f.service.resourceSnapshot(), stamp = f.repository.readonlySnapshotStamp();
      assert.equal(catalogTrack(f.catalogTracks({ catalogPlaybackEnabled: true }), selected.trackId).availability, 'unavailable');
      assert.equal(catalogTrack(f.catalogTracks({ operation: 'getTrack', limit: 1, itemId: selected.trackId, catalogPlaybackEnabled: true }), selected.trackId).availability, 'unavailable');
      assert.deepEqual(f.service.resourceSnapshot(), resources); assert.equal(f.tickets.size, 0);
      assert.deepEqual(f.repository.readonlySnapshotStamp(), stamp);
    } finally { await rename(isolated, original); }
    assertQuiet(f.service);
  }
}

async function assertCatalogSourceChanged(t: TestContext) {
  const f = await fixture(t), selected = f.selection(), file = path.join(f.media, f.relative());
  assert.equal(catalogTrack(f.catalogTracks({ catalogPlaybackEnabled: true }), selected.trackId).availability, 'available');
  const bytes = f.originals.get('core-wav')!, writer = await open(file, constants.O_WRONLY | constants.O_NOFOLLOW);
  try { await writer.write(Buffer.from([0]), 0, 1, bytes.length); } finally { await writer.close(); }
  const stamp = f.repository.readonlySnapshotStamp(), resources = f.service.resourceSnapshot();
  assert.equal(catalogTrack(f.catalogTracks({ catalogPlaybackEnabled: true }), selected.trackId).availability, 'unavailable');
  assert.deepEqual(f.repository.readonlySnapshotStamp(), stamp); assert.deepEqual(f.service.resourceSnapshot(), resources); assert.equal(f.tickets.size, 0);
  safeFailure(await f.dispatch({ operation: 'prepare', selection: selected }), 409, 'SOURCE_CHANGED'); assertQuiet(f.service);
}

async function assertCatalogRevoked(t: TestContext) {
  const f = await fixture(t), selected = f.selection();
  assert.equal(catalogTrack(f.catalogTracks({ catalogPlaybackEnabled: true }), selected.trackId).availability, 'available');
  f.repository.sources.revoke({ commandId: randomUUID(), id: f.source.id });
  const stamp = f.repository.readonlySnapshotStamp(), resources = f.service.resourceSnapshot();
  const page = f.catalogTracks({ catalogPlaybackEnabled: true }); assert.equal(page.total, 0); assert.deepEqual(page.items, []);
  safeFailure(f.catalogDispatch({ operation: 'getTrack', limit: 1, itemId: selected.trackId, catalogPlaybackEnabled: true }) as MobileOwnerPrivateFailure, 404, 'INVALID_REQUEST');
  assert.deepEqual(f.repository.readonlySnapshotStamp(), stamp); assert.deepEqual(f.service.resourceSnapshot(), resources); assert.equal(f.tickets.size, 0);
  safeFailure(await f.dispatch({ operation: 'prepare', selection: selected }), 404, 'INVALID_REQUEST'); assertQuiet(f.service);
}

async function assertCatalogUnsupportedFormat(f: Fixture) {
  const wav = f.selection('core-wav'), unsupported = f.selection('core-m4a-aac');
  const original = f.repository.localCatalog.trackDetail(unsupported.trackId.split(':')[2]!);
  const scanner = f.repository.localScan.privateCurrentFileState(f.root.id, f.relative('core-m4a-aac'));
  assert.ok(scanner?.value.readFacts); assert.equal(scanner.value.outcome, 'accepted');
  assert.equal(scanner.value.readFacts.technical.codec, 'MPEG-4/AAC', '消费固定Reader实际原词汇，不向Scanner注入移动标签。');
  const scannerBefore = valueHash(scanner);
  assert.equal(f.repository.localScan.privateDisplayFileParameters(original.track.id, original.asset), null, '普通解析参数接点保持原闭集，不因移动投影改变。');
  const stamp = f.repository.readonlySnapshotStamp(), resources = f.service.resourceSnapshot();
  const readonlyRequest = { operation: 'getTrack' as const, limit: 1, itemId: unsupported.trackId };
  safeFailure(f.catalogDispatch(readonlyRequest) as MobileOwnerPrivateFailure, 503, 'BUSY');
  safeFailure(f.catalogDispatch({ ...readonlyRequest, catalogPlaybackEnabled: false }) as MobileOwnerPrivateFailure, 503, 'BUSY');
  const page = f.catalogTracks({ catalogPlaybackEnabled: true });
  assert.equal(catalogTrack(page, wav.trackId).availability, 'available');
  const unavailable = catalogTrack(page, unsupported.trackId);
  assert.equal(unavailable.availability, 'unavailable');
  assert.equal(unavailable.audio.codec, 'aac'); assert.equal(unavailable.audio.container, 'm4a');
  assert.equal(catalogTrack(f.catalogTracks({ operation: 'getTrack', limit: 1, itemId: unsupported.trackId, catalogPlaybackEnabled: true }), unsupported.trackId).availability, 'unavailable');
  assert.equal(valueHash(f.repository.localScan.privateCurrentFileState(f.root.id, f.relative('core-m4a-aac'))), scannerBefore, '整个Scanner原状态及技术事实必须在目录查询前后完全不变。');
  assert.equal(f.repository.localScan.privateDisplayFileParameters(original.track.id, original.asset), null, '可信移动投影不能污染默认接点或缓存。');
  assert.deepEqual(f.repository.readonlySnapshotStamp(), stamp); assert.deepEqual(f.service.resourceSnapshot(), resources); assert.equal(f.tickets.size, 0);
  safeFailure(await f.dispatch({ operation: 'prepare', selection: unsupported }), 409, 'UNSUPPORTED_FORMAT'); assertQuiet(f.service);
}

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
  const f = await fixture(t);
  await assertCatalogWavAvailability(t, f); await assertCatalogOfflineAndMissing(t);
  const selected = f.selection(), source = await f.prepare(selected), original = f.originals.get('core-wav')!;
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
  await assertCatalogUnsupportedFormat(f);
  for (const [id, contentType] of [['core-flac', 'audio/flac'], ['core-mp3', 'audio/mpeg'], ['core-m4a-alac', 'audio/mp4'], ['core-wav', 'audio/wav'], ['core-aiff', 'audio/aiff']] as const) {
    const selected = f.selection(id), stamp = f.repository.readonlySnapshotStamp(), resources = f.service.resourceSnapshot();
    const listed = catalogTrack(f.catalogTracks({ catalogPlaybackEnabled: true }), selected.trackId);
    const detailed = catalogTrack(f.catalogTracks({ operation: 'getTrack', limit: 1, itemId: selected.trackId, catalogPlaybackEnabled: true }), selected.trackId);
    for (const projected of [listed, detailed]) {
      assert.equal(projected.availability, 'available', `${id} 的原Scanner/Direct共同支持资格必须投影为可点播。`);
      assert.equal(projected.id, selected.trackId); assert.equal(projected.versionId, selected.versionId); assert.equal(projected.contentRevision, selected.contentRevision);
    }
    assert.deepEqual(detailed, listed); assert.deepEqual(f.repository.readonlySnapshotStamp(), stamp);
    assert.deepEqual(f.service.resourceSnapshot(), resources); assert.equal(f.tickets.size, 0);
    const source = await f.prepare(selected), observed = f.repository.localScan.privateCurrentFileState(f.root.id, f.relative(id))!.value.readFacts!.technical;
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
    const trackId = `lt:${f.datasetId}:${track.id}:${edition.id}`;
    const catalog = f.catalogDispatch({ operation: 'getTrack', limit: 1, itemId: trackId, catalogPlaybackEnabled: true });
    if ('kind' in catalog) safeFailure(catalog, 503, 'BUSY');
    else assert.equal(catalogTrack(catalog, trackId).availability, 'unavailable', '未扫描文件或段不能借用整文件Scanner事实投影available。');
    assert.equal(f.tickets.size, 0); assertQuiet(f.service);
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
  await assertCatalogSourceChanged(t);
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
  await assertCatalogRevoked(t);
  const f = await fixture(t), source = await f.prepare(); let invoked = 0;
  const forged = { operation: 'read' as const, handle: source.handle, readId: randomUUID(), start: 0, get maxBytes() { invoked++; return 1; } };
  safeFailure(await f.service.dispatch(forged), 400, 'INVALID_REQUEST'); assert.equal(invoked, 0);
  safeFailure(await f.service.dispatch({ operation: 'read', handle: source.handle, readId: randomUUID(), start: 0, maxBytes: 65537 }), 400, 'INVALID_REQUEST');
  f.retireOwner(); safeFailure(await f.dispatch({ operation: 'verify', handle: source.handle }), 503, 'BUSY'); assertQuiet(f.service);
  safeFailure(await f.dispatch({ operation: 'prepare', selection: f.selection() }), 503, 'BUSY'); assertQuiet(f.service);
});
