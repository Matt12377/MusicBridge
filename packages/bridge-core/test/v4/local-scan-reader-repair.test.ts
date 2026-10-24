import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { LibraryRoot } from '@music-bridge/contracts';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createLocalScanCoordinator } from '../../src/collection/local-scan-coordinator.js';
import { createLocalAlbumOwnerRuntime } from '../../src/collection/local-album-browser/owner-runtime.js';
import { createBackupWorkflowStore } from '../../src/recording/backup-workflow-store.js';
import { authorizeSourceDirectory, sourceRootAvailability } from '../../src/recording/source-files.js';
import { createScanReadAdmission } from '../../src/library/scan-read-admission.js';
import { RUST_MEDIA_METADATA_PARSER_VERSION, type MetadataReaderPort, type MetadataReadResult } from '../../src/library/metadata-reader-types.js';
import type { DatasetProjectionPort, DatasetProjectionCommand, DatasetProjectionCommandPayloads, DatasetProjectionCommandResults } from '../../src/collection/dataset-owner-protocol.js';

const failedRelative = '甲专辑/01.wav';
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
function wav(): Buffer {
  const bytes = Buffer.alloc(844); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22); bytes.writeUInt32LE(48000, 24);
  bytes.writeUInt32LE(192000, 28); bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(800, 40);
  return bytes;
}
function accepted(relative: string): MetadataReadResult {
  return { status: 'ok', parserVersion: RUST_MEDIA_METADATA_PARSER_VERSION,
    fields: { title: path.posix.basename(relative, '.wav'), artist: '合成艺人', album: path.posix.dirname(relative), year: '2026', track: relative.endsWith('01.wav') ? '1' : '2' },
    technical: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48000, channels: 2, bitsPerSample: 16, durationSeconds: 1, evidence: 'bounded-parser-reported' },
    coverEvidence: [], readEvidence: { bytesRead: 0, readCalls: 0, maxReadBytes: 0, allocationBytes: 0, elapsedMs: 0, wholeAudioHash: false, wholeAudioDecode: false } };
}
function projection(datasetId: string) {
  const gate = createScanReadAdmission({ isBusy: () => false }), scope = { datasetId, epoch: randomUUID() };
  const port: DatasetProjectionPort = {
    async call<K extends DatasetProjectionCommand>(command: K, payload: DatasetProjectionCommandPayloads[K]): Promise<DatasetProjectionCommandResults[K]> {
      let value: unknown;
      if (command === 'scanReadAcquire') value = gate.acquire(scope);
      else if (command === 'scanReadWatchRevocation') value = await gate.watchRevocation(scope, (payload as { permitId: string }).permitId);
      else if (command === 'scanReadRelease') value = gate.release(scope, (payload as { permitId: string }).permitId);
      else throw new Error('合成读取修复回归不访问Provider或设备。');
      return value as DatasetProjectionCommandResults[K];
    },
  };
  return { gate, port };
}

async function fixture(t: TestContext) {
  const temporary = process.env.TMPDIR; assert.ok(temporary && path.isAbsolute(temporary));
  if (process.platform === 'darwin') assert.ok(temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  assert.ok((await lstat(temporary)).isDirectory());
  const directory = await mkdtemp(path.join(temporary, 'musicbridge-reader-repair-')), media = path.join(directory, 'media'), remounted = path.join(directory, 'remounted');
  const bytes = wav(), files: string[] = [];
  for (const album of ['甲专辑', '乙专辑']) {
    await mkdir(path.join(media, album), { recursive: true, mode: 0o700 });
    for (const name of ['01.wav', '02.wav']) {
      const relative = `${album}/${name}`; files.push(relative);
      await writeFile(path.join(media, relative), bytes, { mode: 0o600, flag: 'wx' });
    }
  }
  const database = path.join(directory, 'collection.sqlite'), maintenanceFile = path.join(directory, 'maintenance.sqlite');
  let root: LibraryRoot | undefined, datasetId: string | undefined, broken = false, currentMedia = media;
  const reads: string[] = [];
  async function open() {
    const repository = createCollectionRepository({ filePath: database }), maintenance = createBackupWorkflowStore({ filePath: maintenanceFile });
    repository.localCatalog.roots();
    const identity = maintenance.datasetIdentities.bind('default', database, false);
    if (datasetId) assert.equal(identity.datasetId, datasetId); datasetId = identity.datasetId;
    repository.localCatalog.privateBindWorkbenchDataset(identity);
    if (!root) {
      const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media));
      root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
    }
    const admitted = projection(identity.datasetId);
    // 只切换读取结果，文件内容不变；精确验证失败事实能被后续可信读取修复。
    const reader: MetadataReaderPort = { async read(input) {
      reads.push(input.relative);
      return broken && input.relative === failedRelative ? { status: 'failure', code: 'PARSE_FAILED', readEvidence: null } : accepted(input.relative);
    }, async close() {} };
    const settings = repository.localCatalog.privateScanSettingsStore(identity);
    const scanner = createLocalScanCoordinator({ repository, identity, settings, datasetId: identity.datasetId,
      assertCurrent: () => identity.assertCurrent(), reader, projection: admitted.port });
    const owner = createLocalAlbumOwnerRuntime({ repository, datasetId: identity.datasetId, assertCurrent: () => identity.assertCurrent(),
      async readRootViews() { return Promise.all(repository.localCatalog.roots().map(async value => {
        const source = repository.sources.root(value.sourceRootId);
        return { root: value, label: source.label, availability: await sourceRootAvailability(source) };
      })); },
      readLibraryOrganizations: () => repository.localCatalog.privateLibraryManagementOrganizations(identity),
    });
    return { repository, maintenance, identity, scanner, owner, admitted };
  }
  let current = await open(), closed = false;
  async function close() {
    if (closed) return; closed = true;
    await current.owner.close(); await current.scanner.close(); current.admitted.gate.close();
    assert.deepEqual(current.admitted.gate.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: true });
    current.repository.close(); current.maintenance.close();
  }
  t.after(async () => { await close(); for (const relative of files) assert.equal(digest(await readFile(path.join(currentMedia, relative))), digest(bytes)); });
  async function scan() {
    const request = { commandId: randomUUID(), libraryRootId: root!.id, expectedRootRevision: root!.revision };
    const pending = current.scanner.start(request); await current.scanner.privateWait(pending.jobId);
    const done = current.scanner.get(pending.jobId); assert.equal(done.phase, 'completed'); return done;
  }
  return { current: () => current, root: () => root!, reads,
    setBroken(value: boolean) { broken = value; }, scan,
    async relink() {
      await rename(media, remounted); currentMedia = remounted;
      const source = current.repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(remounted));
      root = current.repository.localCatalog.relinkRoot({ commandId: randomUUID(), rootId: root!.id, expectedRevision: root!.revision, sourceRootId: source.id, role: 'library' });
      return root;
    },
    async cold() { await close(); current = await open(); closed = false; },
    counts() {
      const ro = new DatabaseSync(database, { readOnly: true });
      try { return { assets: Number(ro.prepare('SELECT count(*) n FROM local_catalog_assets').get()!.n), tracks: Number(ro.prepare('SELECT count(*) n FROM local_catalog_tracks').get()!.n) }; }
      finally { ro.close(); }
    },
  };
}

async function exercise(t: TestContext, edition: boolean) {
  const f = await fixture(t); assert.deepEqual((await f.scan()).progress, { visited: '4', accepted: '4', rejected: '0' });
  const first = f.current(), tracks = first.repository.localCatalog.pageTracks({ offset: 0, limit: 20 }).items;
  const originalIds = tracks.map(track => ({ trackId: track.id, assetId: track.assetId })).sort((a, b) => a.trackId.localeCompare(b.trackId));
  const failedTrack = tracks.find(track => first.repository.localCatalog.privateAssetLocator(track.assetId).relative === failedRelative)!;
  assert.ok(failedTrack);
  first.repository.localCatalog.overrideMetadata({ commandId: randomUUID(), trackId: failedTrack.id, expectedRevision: null, fields: { title: '人工标题保留' } });
  const originalMetadata = first.repository.localCatalog.metadata(failedTrack.id);
  if (edition) {
    const album = first.repository.localCatalog.createEdition({ commandId: randomUUID(), title: '合成发行', edition: '原发行' });
    const members = tracks.filter(track => first.repository.localCatalog.privateAssetLocator(track.assetId).relative.startsWith('甲专辑/'));
    for (const [index, track] of members.entries()) first.repository.localCatalog.linkEditionTrack({ commandId: randomUUID(), editionId: album.id, trackId: track.id, disc: 1, trackNumber: index + 1, sequence: index + 1 });
  }
  const query = (filter: 'all' | 'metadata-issue' = 'all') => f.current().owner.localAlbums.queryAlbums({ query: '', rootId: f.root().id, filter, offset: 0, limit: 20 });
  const baseline = await query(); assert.equal(baseline.total, 2); assert.equal((await query('metadata-issue')).total, 0);
  const baselineAlbumIds = baseline.items.map(album => album.id).sort();
  const originalMembership = new Map<string, string[]>();
  for (const album of baseline.items) {
    const members = await first.owner.localAlbums.queryAlbumTracks({ albumKey: album.id, rootId: album.rootId, offset: 0, limit: 20 });
    originalMembership.set(album.id, members.items.map(item => item.facts.track.id).sort());
  }

  const oldAsset = first.repository.localCatalog.asset(failedTrack.assetId), root = await f.relink();
  assert.equal(root.id, oldAsset.libraryRootId); assert.equal(root.revision, '2');
  f.setBroken(true); const failed = await f.scan(); assert.deepEqual(failed.progress, { visited: '4', accepted: '3', rejected: '1' });
  assert.deepEqual(first.repository.localCatalog.asset(oldAsset.id), oldAsset);
  assert.deepEqual(first.repository.localCatalog.metadata(failedTrack.id), originalMetadata);
  assert.ok((await query('metadata-issue')).total > 0);
  assert.deepEqual(f.counts(), { assets: 4, tracks: 4 });

  // 新任务仍用同一当前root；失败项必须重读，不能让上次accepted缓存遮住修复结果。
  f.setBroken(false); const readsBefore = f.reads.length, repaired = await f.scan();
  assert.notEqual(repaired.jobId, failed.jobId); assert.equal(repaired.rootRevision, root.revision);
  assert.deepEqual(repaired.progress, { visited: '4', accepted: '4', rejected: '0' });
  assert.deepEqual(f.reads.slice(readsBefore), [failedRelative]);
  const repairedAsset = first.repository.localCatalog.asset(oldAsset.id);
  assert.equal(repairedAsset.id, oldAsset.id); assert.equal(repairedAsset.sourceRootId, root.sourceRootId); assert.equal(repairedAsset.rootRevision, root.revision);
  assert.equal(repairedAsset.fileRevision, '2'); assert.equal(repairedAsset.locationRevision, '2');
  assert.deepEqual(first.repository.localCatalog.metadata(failedTrack.id), originalMetadata);
  assert.deepEqual(f.counts(), { assets: 4, tracks: 4 });
  const repairedIds = first.repository.localCatalog.pageTracks({ offset: 0, limit: 20 }).items.map(track => ({ trackId: track.id, assetId: track.assetId })).sort((a, b) => a.trackId.localeCompare(b.trackId));
  assert.deepEqual(repairedIds, originalIds);
  assert.equal((await query('metadata-issue')).total, 0);
  assert.deepEqual((await query()).items.map(album => album.id).sort(), baselineAlbumIds);
  for (const [albumKey, expected] of originalMembership) {
    const members = await first.owner.localAlbums.queryAlbumTracks({ albumKey, rootId: root.id, offset: 0, limit: 20 });
    assert.deepEqual(members.items.map(item => item.facts.track.id).sort(), expected);
  }

  await f.cold(); const cold = f.current();
  assert.deepEqual(cold.repository.localCatalog.asset(oldAsset.id), repairedAsset);
  assert.deepEqual(cold.repository.localCatalog.metadata(failedTrack.id), originalMetadata);
  assert.deepEqual(f.counts(), { assets: 4, tracks: 4 }); assert.equal((await query('metadata-issue')).total, 0);
  assert.deepEqual((await query()).items.map(album => album.id).sort(), baselineAlbumIds);
  const afterCold = f.reads.length; await cold.scanner.privateRecoverAvailable(); assert.equal(f.reads.length, afterCold);
}

test('V4：读取修复后的fresh增量扫描更新原目录资产并清除元数据异常，冷恢复不重建专辑', { timeout: 30_000 }, async t => exercise(t, false));
test('V4：读取修复后保留原发行及曲目成员，失败产生的空目录异常消失', { timeout: 30_000 }, async t => exercise(t, true));
