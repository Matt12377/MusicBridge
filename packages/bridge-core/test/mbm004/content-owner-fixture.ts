import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MobileTrack, MobileTrackSelection } from '@music-bridge/contracts';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createLocalScanCoordinator } from '../../src/collection/local-scan-coordinator.js';
import type { DatasetOwnerEndpoint, DatasetProjectionCommand, DatasetProjectionCommandPayloads, DatasetProjectionCommandResults, DatasetProjectionPort } from '../../src/collection/dataset-owner-protocol.js';
import { createScanReadAdmission } from '../../src/library/scan-read-admission.js';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';
import { createMobileOwnerService } from '../../src/mobile/owner-service.js';
import { createMobileContentOwnerService } from '../../src/mobile/content-owner-service.js';
import type { MobileContentOwnerRequest, MobileContentOwnerResult, MobileContentOwnerSnapshot } from '../../src/mobile/owner-content-protocol.js';
import { isMobileOwnerPrivateRequest, isMobileOwnerPrivateResult } from '../../src/mobile/owner-protocol.js';
import type { MobileContentScope, MobileContentStateLimits } from '../../src/mobile/content-types.js';
import { audioFixture, loadFreshMetadataReader } from '../helpers/mbrs003-audio-fixtures.js';

export const contentLimits: MobileContentStateLimits = { stateBytes: 4 * 1024 * 1024, receipts: 1024,
  albums: 1000, favoriteTracks: 1000, playlists: 1000, playlistTracks: 1000 };
export const selected = (track: MobileTrack): MobileTrackSelection => ({ trackId: track.id, source: track.source,
  versionId: track.versionId, contentRevision: track.contentRevision });
export function snapshot(result: MobileContentOwnerResult): MobileContentOwnerSnapshot {
  assert.equal(result.kind, 'content-snapshot'); if (result.kind !== 'content-snapshot') throw new Error('没有真实内容快照。'); return result;
}

/** 真 SQLite/原 Scanner/新鲜 Reader/只读原 FD 的同进程组合；不是 RPC、Main、账号或设备证据。 */
export async function ownerFixture(t: TestContext) {
  const inputs = await audioFixture(t), readerModule = await loadFreshMetadataReader();
  const directory = path.join(inputs.directory, 'content-owner'), media = path.join(directory, 'media'), disc = path.join(media, 'disc');
  await mkdir(directory, { mode: 0o700 }); await chmod(directory, 0o700);
  await mkdir(media, { mode: 0o700 }); await mkdir(disc, { mode: 0o700 });
  const original = await inputs.bytes('core-wav'), file = path.join(disc, 'source.wav');
  await writeFile(file, original, { flag: 'wx', mode: 0o600 });
  const repository = createCollectionRepository({ filePath: path.join(directory, 'collection.sqlite') });
  const datasetId = randomUUID(), ownerEpoch = randomUUID(), serverId = 'server:' + randomUUID();
  let alive = true, millis = Date.parse('2030-01-01T00:00:00Z');
  const assertCurrent = (): void => { if (!alive) throw new Error('自有 Owner 已关闭。'); repository.readonlySnapshotStamp(); };
  const capability = await authorizeSourceDirectory(media), source = repository.sources.authorize(randomUUID(), capability);
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  const admission = createScanReadAdmission({ isBusy: () => false }), context = { datasetId, epoch: ownerEpoch };
  const projection: DatasetProjectionPort = {
    async call<C extends DatasetProjectionCommand>(command: C, payload: DatasetProjectionCommandPayloads[C]): Promise<DatasetProjectionCommandResults[C]> {
      let value: unknown;
      if (command === 'scanReadAcquire') value = admission.acquire(context);
      else if (command === 'scanReadWatchRevocation') value = await admission.watchRevocation(context, (payload as { permitId: string }).permitId);
      else if (command === 'scanReadRelease') value = admission.release(context, (payload as { permitId: string }).permitId);
      else throw new Error('夹具不提供 Provider、家庭队列或伪造扫描事实。');
      return value as DatasetProjectionCommandResults[C];
    },
  };
  const reader = readerModule.createMetadataReader({ concurrency: 1, maxPending: 1 });
  const scanner = createLocalScanCoordinator({ repository, datasetId, projection, reader, assertCurrent });
  const key = randomBytes(32);
  let service: ReturnType<typeof createMobileContentOwnerService> | undefined, closing: Promise<void> | undefined;
  async function close() {
    closing ??= (async () => {
      const failures: unknown[] = [];
      for (const stop of [() => service?.close(), () => scanner.close(), () => reader.close(), () => admission.close()]) {
        try { await stop(); } catch (error) { failures.push(error); }
      }
      try { assert.deepEqual(await readFile(file), original, '内容写入不得改源媒体。'); } catch (error) { failures.push(error); }
      alive = false;
      try { repository.close(); } catch (error) { failures.push(error); }
      key.fill(0);
      if (failures.length) throw new AggregateError(failures, '自有内容夹具未完全关闭。');
    })(); return closing;
  }
  t.after(close);
  const started = scanner.start({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision });
  await scanner.privateWait(started.jobId); assert.equal(scanner.get(started.jobId).phase, 'completed');
  assert.deepEqual(scanner.get(started.jobId).progress, { visited: '1', accepted: '1', rejected: '0' });
  const tracks = repository.localCatalog.pageTracks({ offset: 0, limit: 10 }).items; assert.equal(tracks.length, 1);
  const local = tracks[0]!, asset = repository.localCatalog.asset(local.assetId);
  const observed = repository.localScan.privateCurrentFileState(root.id, path.join('disc', 'source.wav'));
  assert.ok(observed?.value.readFacts); assert.equal(observed.value.assetId, asset.id);
  const edition = repository.localCatalog.createEdition({ commandId: randomUUID(), title: '真实夹具发行', edition: '自有扫描原件' });
  repository.localCatalog.linkEditionTrack({ commandId: randomUUID(), editionId: edition.id, trackId: local.id, disc: 1, trackNumber: 1, sequence: 1 });
  const catalog = createMobileOwnerService({ collection: repository, datasetId, ownerEpoch, assertCurrent });
  const identity = createHash('sha256').update(JSON.stringify([datasetId, asset.id, asset.fileRevision, local.selectionRevision, local.segment])).digest('hex');
  const selection: MobileTrackSelection = { source: 'local', trackId: `lt:${datasetId}:${local.id}:${edition.id}`,
    versionId: `lv:${identity}`, contentRevision: `lc:${identity}` };
  service = createMobileContentOwnerService({ collection: repository, datasetId, ownerEpoch,
    catalog, limits: contentLimits, assertCurrent, now: () => millis });
  const scope: MobileContentScope = { serverId, datasetId, ownerEpoch, deviceId: 'device.1', deviceEpoch: 1,
    accessGeneration: 1, accountDomain: 'local:' + datasetId, providerEpoch: null };
  async function dispatch(request: MobileContentOwnerRequest): Promise<MobileContentOwnerResult> {
    const envelope = { kind: 'content' as const, datasetId, request };
    assert.equal(isMobileOwnerPrivateRequest(envelope), true, '只使用实际物理 Owner 的闭合集合。');
    assert.ok(service);
    const result = await service.dispatch(request);
    assert.equal(isMobileOwnerPrivateResult(result, envelope), true, '真实原 client/worker 响应校验器必须接受。'); return result;
  }
  async function initialize(): Promise<void> {
    assert.equal((await dispatch({ action: 'initialize', serverId, datasetId, key })).kind, 'content-initialized');
    assert.equal((await dispatch({ action: 'updateScope', scope })).kind, 'content-scope-updated');
  }
  await initialize();
  const localResult = await dispatch({ action: 'local-track', scope, selection });
  assert.equal(localResult.kind, 'content-track'); if (localResult.kind !== 'content-track') throw new Error('Scanner 原曲目未取得实际投影。');
  const track = localResult.track, detail = localResult.detail;
  return { directory, media, disc, file, original, repository, catalog, get service() { assert.ok(service); return service; }, scope, key, track, detail, selection,
    datasetId, ownerEpoch, serverId, edition, root, assertCurrent, dispatch, close,
    advance(ms: number) { millis += ms; },
    async restart(initializeOwner = true) {
      assert.ok(service); await service.close();
      service = createMobileContentOwnerService({ collection: repository, datasetId, ownerEpoch, catalog,
        limits: contentLimits, assertCurrent, now: () => millis });
      if (initializeOwner) await initialize(); return service;
    } };
}

/** Root 的 runtime 组合沿同一 SQLite/Scanner；此受控端口不冒充 Worker 或 production boot。 */
export async function makeContentRuntimeOwnerFixture(t: TestContext) {
  const fixture = await ownerFixture(t);
  await fixture.restart(false);
  const ownerEndpoint: DatasetOwnerEndpoint = {
    async prepare() { fixture.assertCurrent(); return { datasetId: fixture.datasetId, epoch: fixture.ownerEpoch }; },
    async commitBoot() { fixture.assertCurrent(); },
    async dispatch() { throw new Error('内容夹具不提供普通 IPC、Provider 或家庭队列。'); },
    async mobileMain(request) {
      fixture.assertCurrent(); assert.equal(isMobileOwnerPrivateRequest(request), true);
      assert.equal(request.datasetId, fixture.datasetId);
      if (request.kind === 'content') return fixture.dispatch(request.request);
      if (request.kind === 'catalog') {
        const result = fixture.catalog.dispatch(request);
        assert.equal(isMobileOwnerPrivateResult(result, request), true); return result;
      }
      throw new Error('内容夹具只支持原 content/catalog 私有闭集。');
    },
    close: fixture.close,
  };
  return { ...fixture, ownerEndpoint, collection: fixture.repository,
    get contentOwner() { return fixture.service; },
    restartRuntimeOwner: () => fixture.restart(false),
    async init() { return ownerEndpoint.prepare(); } };
}
