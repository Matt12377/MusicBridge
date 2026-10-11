import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, chmod, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createLocalScanCoordinator } from '../../src/collection/local-scan-coordinator.js';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';
import { createScanReadAdmission } from '../../src/library/scan-read-admission.js';
import { resolveAlbumNameCandidates, inferAlbumBoundaries } from '../../src/library/local-name-rules.js';
import type { DatasetProjectionPort, DatasetProjectionCommand, DatasetProjectionCommandPayloads, DatasetProjectionCommandResults } from '../../src/collection/dataset-owner-protocol.js';
import type { MetadataReaderPort } from '../../src/library/metadata-reader-types.js';
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';

test('MBRS004 AT005/006：关闭AI，实际扫描入库与重扫保留人工名称、发行版成员和CD边界', { timeout: 30_000 }, async t => {
  const policy = buildStoragePolicy(), temporary = policy.check(process.env.TMPDIR!, { mustExist: true });
  const directory = await mkdtemp(path.join(temporary, 'musicbridge-mbrs004-rules-')); await chmod(directory, 0o700);
  const media = path.join(directory, '合成媒体'); await mkdir(media, { mode: 0o700 });
  const bytes = Buffer.from('MBRS004 合成Reader事实，不是可播放音频');
  for (const cd of ['CD1', 'CD2']) { await mkdir(path.join(media, cd), { mode: 0o700 }); await writeFile(path.join(media, cd, '01.wav'), bytes, { flag: 'wx', mode: 0o600 }); }
  const repository = createCollectionRepository({ filePath: path.join(directory, 'collection.v1.sqlite') });
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media));
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  const context = { datasetId: randomUUID(), epoch: randomUUID() }, admission = createScanReadAdmission({ isBusy: () => false });
  const projection: DatasetProjectionPort = { async call<K extends DatasetProjectionCommand>(command: K, payload: DatasetProjectionCommandPayloads[K]): Promise<DatasetProjectionCommandResults[K]> {
    let result: unknown;
    if (command === 'scanReadAcquire') result = admission.acquire(context);
    else if (command === 'scanReadWatchRevocation') result = await admission.watchRevocation(context, (payload as { permitId: string }).permitId);
    else if (command === 'scanReadRelease') result = admission.release(context, (payload as { permitId: string }).permitId);
    else throw new Error('本验收关闭AI和外部投影，只允许实际扫描票据');
    return result as DatasetProjectionCommandResults[K];
  } };
  let reads = 0, changed = false;
  // Reader标签为受控合成事实；coordinator、stat、准入、唯一持久writer均为生产本体。
  const reader: MetadataReaderPort = { async read(input) {
    reads++;
    const updated = changed && input.relative === 'CD1/01.wav';
    return { status: 'ok', parserVersion: 'music-metadata-11.15.0/mbrs003-v4', fields: { title: updated ? '新标签歌曲' : '歌曲 [首版]', artist: '歌手', album: updated ? '专辑 [Remastered]' : '专辑 [首版]' },
      technical: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48000, channels: 2, bitsPerSample: 16, durationSeconds: 1, evidence: 'bounded-parser-reported' }, coverEvidence: [],
      readEvidence: { bytesRead: bytes.length, readCalls: 1, maxReadBytes: bytes.length, allocationBytes: bytes.length, elapsedMs: 1, wholeAudioHash: false, wholeAudioDecode: false } };
  }, async close() {} };
  const coordinator = createLocalScanCoordinator({ repository, datasetId: context.datasetId, assertCurrent: () => { repository.list({ offset: 0, limit: 1 }); }, projection, reader });
  t.after(async () => { await coordinator.close(); admission.close(); repository.close(); });
  const scan = async () => {
    const started = coordinator.start({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision });
    await coordinator.privateWait(started.jobId); assert.equal(coordinator.get(started.jobId).phase, 'completed');
    assert.deepEqual(coordinator.get(started.jobId).progress, { visited: '2', accepted: '2', rejected: '0' });
  };
  await scan(); assert.equal(reads, 2);
  const tracks = repository.localCatalog.pageTracks({ offset: 0, limit: 200 }).items;
  const edition = repository.localCatalog.createEdition({ commandId: randomUUID(), title: '人工专辑', edition: '人工发行版 [首版]' });
  const links = tracks.map((track, index) => repository.localCatalog.linkEditionTrack({ commandId: randomUUID(), editionId: edition.id, trackId: track.id, disc: index + 1, trackNumber: 1, sequence: index + 1 }));
  for (const track of tracks) repository.localCatalog.overrideMetadata({ commandId: randomUUID(), trackId: track.id, expectedRevision: null, fields: { title: '人工歌曲', artist: '人工歌手', album: '人工专辑' } });
  const before = tracks.map(track => repository.localCatalog.metadata(track.id));
  await scan(); assert.equal(reads, 2, '未变文件跳过Reader，AI关闭不妨碍现有增量建库');
  assert.deepEqual(repository.localCatalog.pageTracks({ offset: 0, limit: 200 }).items, tracks);
  assert.deepEqual(repository.localCatalog.editionTracks(edition.id), links);
  assert.deepEqual(tracks.map(track => repository.localCatalog.metadata(track.id)), before);
  const members = tracks.map(track => ({ trackId: track.id, ...repository.localCatalog.metadata(track.id).raw }));
  const input = { artistName: '歌手', albumName: '专辑 [首版]', members, manual: { artistName: '人工歌手', albumName: '人工专辑', boundaryId: edition.id }, aiMode: 'off' as const };
  const names = resolveAlbumNameCandidates(input);
  assert.equal(names.artist.display, '人工歌手'); assert.equal(names.album.display, '人工专辑'); assert.equal(names.manual?.boundaryId, edition.id);
  assert.deepEqual(names.members.map(member => member.trackId), tracks.map(track => track.id));
  assert.ok(names.memberEvidence.every(member => member.album?.raw === '专辑 [首版]' && member.album.versionTokens.some(token => token.raw === '首版')));
  const facts = [{ id: root.id, parentId: null, name: '根', directAudioCount: 0 }, { id: edition.id, parentId: root.id, name: '专辑', directAudioCount: 0 }, ...links.map((link, index) => ({ id: link.id, parentId: edition.id, name: `CD${index + 1}`, directAudioCount: 1 }))];
  assert.deepEqual(inferAlbumBoundaries(facts, root.id).map(candidate => candidate.boundaryId), [edition.id, edition.id]);
  assert.equal(inferAlbumBoundaries(facts, root.id, [{ directoryId: links[0]!.id, boundaryId: edition.id }])[0]?.reason, 'manual');
  // 仅主动改变测试私有副本，让第三次扫描进入新raw观察路径，而非复用旧签名。
  const updatedBytes = Buffer.concat([bytes, Buffer.from(' 合成标签更新')]);
  await writeFile(path.join(media, 'CD1', '01.wav'), updatedBytes); changed = true;
  const changedTrackId = repository.localScan.privateFileState(root.id, 'CD1/01.wav')!.value.trackId!;
  const beforeObservations = repository.localCatalog.observations(changedTrackId).length;
  await scan(); assert.equal(reads, 3, '只有签名变化的CD1重新读取，CD2保持增量复用');
  assert.equal(repository.localCatalog.observations(changedTrackId).length, beforeObservations + 1);
  assert.equal(repository.localCatalog.metadata(changedTrackId).raw.title, '新标签歌曲');
  assert.equal(repository.localCatalog.metadata(changedTrackId).raw.album, '专辑 [Remastered]');
  assert.deepEqual(repository.localCatalog.pageTracks({ offset: 0, limit: 200 }).items, tracks);
  assert.deepEqual(repository.localCatalog.edition(edition.id), edition);
  assert.deepEqual(repository.localCatalog.editionTracks(edition.id), links);
  for (const track of tracks) assert.deepEqual(repository.localCatalog.metadata(track.id).effective, { title: '人工歌曲', artist: '人工歌手', album: '人工专辑' });
  const rescanned = resolveAlbumNameCandidates({ ...input, members: tracks.map(track => ({ trackId: track.id, ...repository.localCatalog.metadata(track.id).raw })) });
  assert.equal(rescanned.album.display, '人工专辑'); assert.equal(rescanned.manual?.boundaryId, edition.id);
  assert.ok(rescanned.memberEvidence.find(member => member.trackId === changedTrackId)?.album?.versionTokens.some(token => token.raw === 'Remastered'));
  for (const cd of ['CD1', 'CD2']) {
    const expected = cd === 'CD1' ? updatedBytes : bytes;
    assert.equal(createHash('sha256').update(await readFile(path.join(media, cd, '01.wav'))).digest('hex'), createHash('sha256').update(expected).digest('hex'));
  }
});
