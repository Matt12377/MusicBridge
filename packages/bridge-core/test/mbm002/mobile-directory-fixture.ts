import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { constants, fstatSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLocalArtworkCommandResult, isLocalArtworkImage, type LocalArtworkImage, type LocalArtworkSourceCopies, type MobileTrack } from '@music-bridge/contracts';
import type { MobilePlaybackPreparedSource, MobilePlaybackSourceRequest } from '../../src/mobile/playback-types.js';
import type { MobileOwnerSourceRequest, MobileOwnerSourceResult } from '../../src/mobile/source-protocol.js';
import type { MobileOwnerArtworkSnapshot, MobileOwnerCatalogRequest, MobileOwnerCatalogSnapshot, MobileOwnerPrivateFailure, MobileOwnerPrivateRequest } from '../../src/mobile/types.js';
import type { DatasetProjectionPort, DatasetProjectionCommand, DatasetProjectionCommandPayloads, DatasetProjectionCommandResults } from '../../src/collection/dataset-owner-protocol.js';
import { audioFixture, loadFreshMetadataReader } from '../helpers/mbrs003-audio-fixtures.js';
import type { AudioFixtureEntry } from '../helpers/mbrs003-audio-fixtures.js';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const hash = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
interface BoundFile { path: string; bytes: number; sha256: string }
interface BoundOutput extends BoundFile { sourcePath: string; sourceSha256: string; mtimeMs: number }
interface Preparation {
  schema: string; status: string; readerBindingSha256: string; inputsUnchanged: boolean; outputsUnchanged: boolean;
  sourceInputs: BoundFile[]; outputs: BoundOutput[];
  stages: { name: string; compilerExit: number; startedMs: number; finishedMs: number }[];
}
export interface DirectoryInputs {
  directory: string;
  entry(id: string): AudioFixtureEntry;
  assertUnchanged(): Promise<void>;
  bytes(id: string): Promise<Buffer>;
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
    'collection/local-scan-coordinator', 'collection/local-scan-store', 'collection/local-album-browser/owner-runtime',
    'collection/local-relocation-coordinator', 'application/local-source-resolver',
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
  const album = await import(new URL('../../dist/collection/local-album-browser/owner-runtime.js', import.meta.url).href) as typeof import('../../src/collection/local-album-browser/owner-runtime.js');
  const relocation = await import(new URL('../../dist/collection/local-relocation-coordinator.js', import.meta.url).href) as typeof import('../../src/collection/local-relocation-coordinator.js');
  await assertBoundBytes(); return { reader, repository, scanner, admission, files, tickets, fence, locks, protocol, source, owner, ownerProtocol, album, relocation, assertBoundBytes };
}
const core = () => moduleFlight ??= loadModules();

type CoreModules = Awaited<ReturnType<typeof core>>;
const directories = Object.freeze([
  Object.freeze({ relative: '目录甲', count: 2 }),
  Object.freeze({ relative: '目录乙', count: 2 }),
  Object.freeze({ relative: '目录丙', count: 1 }),
]);

/** 原生产工厂集中接线；当前1059不注入新resolver，不让因果RED提前失败在不存在的入口。 */
function createServices(modules: CoreModules, context: {
  repository: ReturnType<CoreModules['repository']['createCollectionRepository']>;
  tickets: ReturnType<CoreModules['tickets']['createLocalSourceTickets']>;
  localAlbums: ReturnType<CoreModules['album']['createLocalAlbumOwnerRuntime']>['localAlbums'];
  datasetId: string; ownerEpoch: string; assertCurrent(): void;
}) {
  const common = { collection: context.repository, datasetId: context.datasetId, ownerEpoch: context.ownerEpoch, assertCurrent: context.assertCurrent, localAlbums: context.localAlbums };
  return {
    catalog: modules.owner.createMobileOwnerService(common),
    service: modules.source.createMobileOwnerSourceService({ ...common, tickets: context.tickets }),
  };
}

/** 五份原WAV/真实SQLite、Reader及Scanner；不构造发行，不伪造元数据、手机ID、RPC或真机证据。 */
export async function directoryFixture(t: TestContext, options: { allowEditionRelations?: boolean; withArtwork?: boolean } = {}) {
  const inputs: DirectoryInputs = await audioFixture(t), modules = await core();
  const cleanup: (() => Promise<void> | void)[] = [], lifecycle: string[] = [];
  const originals = new Map<string, Buffer>(), proofs = new Map<string, Awaited<ReturnType<typeof wholeFile>>>();
  const coverRelative = '目录甲/cover.jpg', coverInput = fileURLToPath(new URL('../fixtures/mbrs012-source/owned-cover-16.jpg', import.meta.url));
  let cover: Awaited<ReturnType<typeof wholeFile>> | undefined;
  let artworkProbeDepth = 0;
  const coverHandles = new Map<FileHandle, number>(), verifiedCoverHandles = new Set<FileHandle>();
  const artworkActivity = { displayGranted: 0, displayReleased: 0, maximumPermits: 0, normalizes: 0, coverBodyReads: 0, coverBodyBytes: 0 };
  const permitPurposes = new Map<string, 'scan' | 'local-album-display'>();
  function assertCoverHandlesClosed(): void {
    for (const [handle, fd] of coverHandles) {
      assert.equal(handle.fd, -1, '目标cover真实FileHandle必须已关闭。');
      if (!verifiedCoverHandles.has(handle)) {
        assert.throws(() => fstatSync(fd), (error: unknown) => (error as NodeJS.ErrnoException).code === 'EBADF', '首次release前核原cover fd确已失效。');
        verifiedCoverHandles.add(handle);
      }
    }
  }
  let ownerAlive = true, closeFlight: Promise<void> | undefined;
  let activeService: ReturnType<CoreModules['source']['createMobileOwnerSourceService']> | undefined;
  let activeScanner: ReturnType<CoreModules['scanner']['createLocalScanCoordinator']> | undefined;
  let activeAdmission: ReturnType<CoreModules['admission']['createScanReadAdmission']> | undefined;
  let activeTickets: ReturnType<CoreModules['tickets']['createLocalSourceTickets']> | undefined;
  const directory = path.join(inputs.directory, 'mobile-directory'), media = path.join(directory, 'media');
  function assertQuiet(): void {
    if (activeService) {
      const snapshot = activeService.resourceSnapshot();
      for (const key of ['liveResources', 'preparing', 'releasing', 'readers', 'activeIo', 'openLeases', 'reservations', 'tickets', 'retainedFences', 'lanes'] as const) assert.equal(snapshot[key], 0, `${key} 必须实际归零。`);
    }
    if (activeTickets) assert.equal(activeTickets.size, 0, '原事实票据必须真实释放。');
    if (activeAdmission) {
      const counts = activeAdmission.resourceCounts();
      for (const key of ['permits', 'revoked', 'watches', 'timers'] as const) assert.equal(counts[key], 0, '原扫描许可必须实际归零。');
    }
    if (options.withArtwork) {
      assert.equal(permitPurposes.size, 0); assert.equal(artworkActivity.displayGranted, artworkActivity.displayReleased);
      for (const handle of coverHandles.keys()) assert.equal(handle.fd, -1, '关闭后不能遗留目标cover句柄。');
    }
    if (activeScanner) {
      const turn = activeScanner.privateReaderTurn();
      assert.equal(turn.occupied, false); assert.equal(turn.waiting, 0); assert.equal(turn.readerConcurrency, 1);
    }
    assert.equal(lifecycle.filter(event => event === 'worker-start').length, lifecycle.filter(event => event === 'worker-exit').length);
    assert.equal(lifecycle.filter(event => event === 'lease-acquired').length, lifecycle.filter(event => event === 'lease-released').length);
  }
  async function assertOriginals(): Promise<void> {
    for (const [relative, proof] of proofs) {
      const actual = await wholeFile(path.join(media, relative));
      assert.equal(actual.sha256, proof.sha256); assert.deepEqual(actual.bytes, proof.bytes);
      const axes = (value: typeof proof.stat) => [value.dev, value.ino, value.size, value.mode, value.uid, value.gid, value.nlink, value.mtimeNs, value.ctimeNs];
      assert.deepEqual(axes(actual.stat), axes(proof.stat), '合成原件身份及字节必须保持。');
    }
    if (proofs.size === 5 || options.withArtwork && proofs.size === 6) {
      assert.deepEqual((await readdir(media)).sort(), directories.map(item => item.relative).sort());
      for (const item of directories) assert.deepEqual((await readdir(path.join(media, item.relative))).sort(),
        [...Array.from({ length: item.count }, (_, index) => `${String(index + 1).padStart(2, '0')}.wav`),
          ...(proofs.has(`${item.relative}/cover.jpg`) ? ['cover.jpg'] : [])].sort());
    }
    if (cover) {
      const actual = await wholeFile(coverInput), axes = (value: typeof actual.stat) => [value.dev, value.ino, value.size, value.mode, value.uid, value.gid, value.nlink, value.mtimeNs, value.ctimeNs];
      assert.equal(actual.sha256, cover.sha256); assert.deepEqual(axes(actual.stat), axes(cover.stat));
    }
    await inputs.assertUnchanged();
  }
  function close(): Promise<void> {
    if (closeFlight) return closeFlight;
    closeFlight = (async () => {
      const errors: unknown[] = [];
      for (const run of [...cleanup].reverse()) try { await run(); } catch (error) { errors.push(error); }
      ownerAlive = false;
      for (const run of [() => assertQuiet(), () => assertOriginals(), () => modules.assertBoundBytes()]) try { await run(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, '手机目录夹具未完全关闭或只读守恒失败。', { cause: errors[0] });
    })();
    return closeFlight;
  }
  t.after(close);
  await mkdir(directory, { mode: 0o700 }); await chmod(directory, 0o700); await mkdir(media, { mode: 0o700 });
  const bytes = await inputs.bytes('core-wav');
  assert.equal(inputs.entry('core-wav').expectedCover, undefined, '固定WAV清单没有内嵌图声明，实际扫描还须核空证据。');
  for (const item of directories) {
    await mkdir(path.join(media, item.relative), { mode: 0o700 });
    for (let index = 0; index < item.count; index++) {
      const relative = `${item.relative}/${String(index + 1).padStart(2, '0')}.wav`;
      await writeFile(path.join(media, relative), bytes, { mode: 0o600, flag: 'wx' });
      const proof = await wholeFile(path.join(media, relative));
      assert.equal(proof.sha256, inputs.entry('core-wav').sha256);
      originals.set(relative, Buffer.from(bytes)); proofs.set(relative, proof);
    }
  }
  const repository = modules.repository.createCollectionRepository({ filePath: path.join(directory, 'collection.sqlite') });
  cleanup.push(() => repository.close());
  function assertNoEditions(): void {
    assert.ok(repository.privateMobileCatalogAccess);
    repository.privateMobileCatalogAccess(db => {
      for (const table of ['local_catalog_editions', 'local_catalog_edition_tracks', 'local_artwork_selections'])
        assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get()?.n, 0, '目录夹具不能借发行或选图登记绕过原拒绝。');
      assert.equal(db.prepare("SELECT count(*) n FROM local_catalog_ledger WHERE operation IN ('create-edition','link-edition-track')").get()?.n, 0);
    });
  }
  function assertEditionPolicy(): void {
    if (!options.allowEditionRelations) { assertNoEditions(); return; }
    assert.ok(repository.privateMobileCatalogAccess);
    repository.privateMobileCatalogAccess(db => assert.equal(db.prepare('SELECT count(*) n FROM local_artwork_selections').get()?.n, 0, '允许真发行关系不授予选图写入。'));
  }
  cleanup.push(assertEditionPolicy);
  const datasetId = randomUUID(), ownerEpoch = randomUUID(), serverId = `server:${randomUUID()}`;
  const capability = await modules.files.authorizeSourceDirectory(media), source = repository.sources.authorize(randomUUID(), capability);
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  const admission = modules.admission.createScanReadAdmission({ isBusy: () => false }), context = { datasetId, epoch: ownerEpoch };
  activeAdmission = admission; cleanup.push(() => admission.close());
  const projection: DatasetProjectionPort = {
    async call<C extends DatasetProjectionCommand>(command: C, payload: DatasetProjectionCommandPayloads[C], read?: { signal?: AbortSignal; deadlineAtMs?: number }): Promise<DatasetProjectionCommandResults[C]> {
      let result: unknown;
      if (command === 'scanReadAcquire') {
        const purpose = (payload as { purpose?: 'local-album-display' }).purpose === 'local-album-display' ? 'local-album-display' : 'scan';
        const acquired = admission.acquire(context, purpose); result = acquired;
        if (options.withArtwork && acquired.status === 'granted') {
          permitPurposes.set(acquired.permitId, purpose);
          if (purpose === 'local-album-display') artworkActivity.displayGranted++;
          artworkActivity.maximumPermits = Math.max(artworkActivity.maximumPermits, admission.resourceCounts().permits);
          assert.ok(artworkActivity.maximumPermits <= 2);
        }
      }
      else if (command === 'scanReadWatchRevocation') result = await admission.watchRevocation(context, (payload as { permitId: string }).permitId);
      else if (command === 'scanReadRelease') {
        const permitId = (payload as { permitId: string }).permitId, purpose = permitPurposes.get(permitId), errors: unknown[] = [];
        if (purpose === 'local-album-display') try { assertCoverHandlesClosed(); } catch (error) { errors.push(error); }
        result = admission.release(context, permitId); permitPurposes.delete(permitId);
        if (purpose === 'local-album-display') artworkActivity.displayReleased++;
        if (errors.length) throw errors[0];
      }
      else if (command === 'normalizeLocalAlbumArtwork' && options.withArtwork) {
        // 受控Main边界只回传已逐字核对的同一JPEG，不冒Native解码的新证据。
        assert.ok(cover); assert.ok(read && Number.isFinite(read.deadlineAtMs) && read.deadlineAtMs! > performance.now());
        assert.equal(read.signal?.aborted ?? false, false);
        const copies = (payload as { copies: LocalArtworkSourceCopies }).copies;
        assert.equal(isLocalArtworkCommandResult('localArtwork.readCandidates', copies), true);
        assert.equal(copies.status, 'ready'); assert.equal(copies.items.length, 1);
        const copy = copies.items[0]!;
        assert.equal(copy.origin, 'local-independent'); assert.equal(copy.sourceLabel, 'cover.jpg'); assert.ok(copy.sourceIdentity.length > 0);
        const bytes = Buffer.from(copy.base64, 'base64'); assert.equal(bytes.toString('base64'), copy.base64);
        assert.deepEqual(bytes, cover.bytes); assert.equal(hash(bytes), cover.sha256);
        assert.ok(coverHandles.size > 0); assertCoverHandlesClosed();
        assert.equal(artworkActivity.displayGranted, artworkActivity.displayReleased);
        const image: LocalArtworkImage = { original: { mime: 'image/jpeg', bytes: bytes.length, sha256: cover.sha256, width: 16, height: 16 },
          display: { mime: 'image/jpeg', bytes: bytes.length, sha256: cover.sha256, width: 16, height: 16, dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}` } };
        assert.equal(isLocalArtworkImage(image), true); artworkActivity.normalizes++; result = { image, status: 'ready' };
      }
      else throw new Error('目录夹具只连接原Scanner准入，不提供Provider、家庭播放或假事实。');
      return result as DatasetProjectionCommandResults[C];
    },
  };
  const reader = modules.reader.createMetadataReader({ concurrency: 1, maxPending: 1, onLifecycle(event) { lifecycle.push(event.type); } });
  cleanup.push(() => reader.close());
  function assertCurrent(): void { if (!ownerAlive) throw new Error('合成Owner世代已退休。'); repository.readonlySnapshotStamp(); }
  const scanner = modules.scanner.createLocalScanCoordinator({ repository, datasetId, projection, reader, assertCurrent });
  activeScanner = scanner; cleanup.push(() => scanner.close());
  assertNoEditions();
  const started = scanner.start({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision });
  await scanner.privateWait(started.jobId);
  const completed = scanner.get(started.jobId);
  assert.equal(completed.phase, 'completed'); assert.equal(completed.datasetId, datasetId);
  assert.deepEqual(completed.progress, { visited: '5', accepted: '5', rejected: '0' });
  assert.equal(lifecycle.filter(event => event === 'read-complete').length, 5);
  const page = repository.localCatalog.pageTracks({ offset: 0, limit: 200 }), tracks = page.items;
  assert.equal(page.total, 5); assert.equal(tracks.length, 5); assert.equal(new Set(tracks.map(track => track.assetId)).size, 5);
  const scanned = [...originals.keys()].map(relative => {
    const found = tracks.find(track => repository.localCatalog.privateAssetLocator(track.assetId).relative === relative); assert.ok(found);
    const state = repository.localScan.privateCurrentFileState(root.id, relative)?.value; assert.ok(state?.readFacts);
    assert.equal(state.outcome, 'accepted'); assert.equal(state.trackId, found.id); assert.equal(state.assetId, found.assetId);
    assert.deepEqual(state.readFacts.coverEvidence, [], '实际固定Reader不得给五份WAV投影内嵌图。');
    const detail = repository.localCatalog.trackDetail(found.id), asset = repository.localCatalog.asset(found.assetId);
    assert.deepEqual(detail.track, found); assert.deepEqual(detail.asset, asset);
    assert.equal(state.libraryRootId, root.id); assert.equal(asset.rootRevision, root.revision); assert.equal(asset.sourceRootId, source.id);
    assert.equal(detail.editions.length, 0); assert.equal(detail.metadata.effective.title, inputs.entry('core-wav').expectedTags!.title);
    assert.equal(detail.metadata.effective.artist, inputs.entry('core-wav').expectedTags!.artist);
    assert.equal(detail.metadata.effective.album, inputs.entry('core-wav').expectedTags!.album);
    const parameters = repository.localScan.privateDisplayFileParameters(found.id, asset, 'mobile-catalog'); assert.ok(parameters);
    assert.equal(parameters.container, 'WAVE'); assert.equal(parameters.sampleRateHz, 44100); assert.equal(parameters.channels, 2);
    assert.equal(parameters.bitsPerSample, 16); assert.ok(parameters.durationMs !== null && parameters.durationMs > 0);
    return { relative, track: found, asset, detail, state, parameters };
  });
  for (const item of directories) assert.equal(scanned.filter(record => path.posix.dirname(record.relative) === item.relative).length, item.count);
  if (options.withArtwork) {
    cover = await wholeFile(coverInput);
    assert.equal(cover.bytes.length, 960); assert.equal(cover.sha256, '555f7915442690ccb14754bd0da000ceadfbdcfb50b4e3402f55d4806e3e989d');
    await writeFile(path.join(media, coverRelative), cover.bytes, { mode: 0o600, flag: 'wx' });
    const copied = await wholeFile(path.join(media, coverRelative)); assert.equal(copied.sha256, cover.sha256); proofs.set(coverRelative, copied);
    const probe = await open(path.join(media, coverRelative), constants.O_RDONLY | constants.O_NOFOLLOW), prototype = Object.getPrototypeOf(probe), originalRead = prototype.read;
    await probe.close();
    const mocked = t.mock.method(prototype, 'read', async function (this: FileHandle, ...args: unknown[]) {
      let target = false;
      try { const info = fstatSync(this.fd, { bigint: true }); target = artworkProbeDepth > 0 && info.dev === copied.stat.dev && info.ino === copied.stat.ino; } catch { /* 其它FD保持原行为。 */ }
      if (target && !coverHandles.has(this)) coverHandles.set(this, this.fd);
      const value = await Reflect.apply(originalRead, this, args) as Awaited<ReturnType<FileHandle['read']>>;
      if (target) { artworkActivity.coverBodyReads++; artworkActivity.coverBodyBytes += value.bytesRead; }
      return value;
    });
    cleanup.push(() => mocked.mock.restore());
  }
  assertNoEditions(); assertQuiet(); await assertOriginals();
  const relocation = modules.relocation.createLocalRelocationCoordinator({ repository, assertCurrent, beforeMutation: () => scanner.yieldForMedia() });
  cleanup.push(() => relocation.close());
  const views = await relocation.roots();
  assert.equal(views.length, 1); assert.deepEqual(views[0]!.root, root); assert.equal(views[0]!.availability, 'ONLINE');
  const albumRuntime = modules.album.createLocalAlbumOwnerRuntime({ repository, projection, datasetId, assertCurrent, readRootViews: () => relocation.roots() });
  cleanup.push(async () => {
    try { await albumRuntime.close(); }
    catch (error) {
      const errors: unknown[] = [error];
      try { albumRuntime.localAlbums.close(); } catch (failure) { errors.push(failure); }
      throw new AggregateError(errors, '原专辑Runtime关闭未完全确认。', { cause: errors[0] });
    }
  });
  const localAlbums = albumRuntime.localAlbums;
  const tickets = modules.tickets.createLocalSourceTickets(repository, ownerEpoch, datasetId, assertCurrent);
  activeTickets = tickets; cleanup.push(() => tickets.seal());
  const { catalog, service } = createServices(modules, { repository, tickets, localAlbums, datasetId, ownerEpoch, assertCurrent });
  activeService = service; cleanup.push(() => service.close());
  const initialStamp = repository.readonlySnapshotStamp();
  function readonlyStamp() { return repository.readonlySnapshotStamp(); }
  function assertReadonly(stamp = initialStamp): void { assert.deepEqual(readonlyStamp(), stamp, '手机目录/源读取不得改变原主库水位。'); assertEditionPolicy(); }
  async function readonlyCall<T>(operation: () => Promise<T> | T): Promise<T> {
    const stamp = readonlyStamp(), errors: unknown[] = [];
    let result: T | undefined;
    try { result = await operation(); } catch (error) { errors.push(error); }
    try { assertReadonly(stamp); } catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, '手机读取及主库守恒同时失败。', { cause: errors[0] });
    return result as T;
  }
  async function catalogDispatch(overrides: Partial<MobileOwnerCatalogRequest> = {}): Promise<MobileOwnerCatalogSnapshot | MobileOwnerPrivateFailure> {
    const request: MobileOwnerPrivateRequest = { kind: 'catalog', datasetId, request: { operation: 'listTracks', serverId,
      offset: 0, limit: 100, q: '', albumId: null, itemId: null, expectedRevision: null, catalogPlaybackEnabled: true, ...overrides } };
    assert.equal(modules.ownerProtocol.isMobileOwnerPrivateRequest(request), true);
    const result = await readonlyCall(() => catalog.dispatch(request));
    assert.equal(modules.ownerProtocol.isMobileOwnerPrivateResult(result, request), true);
    return result as MobileOwnerCatalogSnapshot | MobileOwnerPrivateFailure;
  }
  async function sourceDispatch(request: MobileOwnerSourceRequest): Promise<MobileOwnerSourceResult | MobileOwnerPrivateFailure> {
    assert.equal(modules.protocol.isMobileOwnerSourceRequest(request), true);
    const result = await readonlyCall(() => service.dispatch(request));
    if (result.kind === 'mobile-error') assert.deepEqual(Reflect.ownKeys(result).sort(), ['code', 'kind', 'outcome', 'retryable', 'status']);
    else assert.equal(modules.protocol.isMobileOwnerSourceResult(result, request), true);
    return result;
  }
  async function artworkDispatch(artworkId: string): Promise<MobileOwnerArtworkSnapshot | MobileOwnerPrivateFailure> {
    const request: MobileOwnerPrivateRequest = { kind: 'artwork', datasetId, request: { serverId, artworkId } };
    assert.equal(modules.ownerProtocol.isMobileOwnerPrivateRequest(request), true);
    artworkProbeDepth++;
    try {
      const result = await readonlyCall(() => catalog.dispatch(request));
      assert.equal(modules.ownerProtocol.isMobileOwnerPrivateResult(result, request), true);
      return result as MobileOwnerArtworkSnapshot | MobileOwnerPrivateFailure;
    } finally { artworkProbeDepth--; }
  }
  async function prepareFromTrack(track: MobileTrack, resourceId: string = randomUUID()): Promise<MobilePlaybackPreparedSource> {
    const selection: MobilePlaybackSourceRequest = { resourceId, trackId: track.id, versionId: track.versionId, contentRevision: track.contentRevision };
    const result = await sourceDispatch({ operation: 'prepare', selection });
    assert.equal(result.kind, 'mobile-source-prepared');
    if (result.kind !== 'mobile-source-prepared') throw new Error('当前目录返回的真实曲目未取得原文件读取资格。');
    return result.source;
  }
  return { modules, inputs, directory, media, directories, repository, datasetId, ownerEpoch, serverId, root, source,
    tracks, scanned, originals, completed, lifecycle, reader, scanner, admission, tickets, catalog, service, relocation, albumRuntime, localAlbums, initialStamp,
    catalogDispatch, sourceDispatch, artworkDispatch, prepareFromTrack, readonlyStamp, assertReadonly, assertNoEditions, assertOriginals, assertQuiet, close,
    artwork: cover ? { relative: coverRelative, bytes: Buffer.from(cover.bytes), sha256: cover.sha256,
      metrics: () => ({ ...artworkActivity, actualCoverBodyHandles: coverHandles.size, verifiedClosedCoverHandles: verifiedCoverHandles.size }) } : undefined };
}
export type DirectoryFixture = Awaited<ReturnType<typeof directoryFixture>>;
