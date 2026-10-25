import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { LocalArtistPage, LocalArtistSearchResult } from '@music-bridge/contracts';
import { createDatasetDomain } from '../../src/collection/dataset-domain.js';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createBackupWorkflowStore } from '../../src/recording/backup-workflow-store.js';
import type { DatasetProjectionPort, DatasetWorkbenchExecutionContext } from '../../src/collection/dataset-owner-protocol.js';
import { RUST_MEDIA_METADATA_PARSER_VERSION, type MetadataReadResult } from '../../src/library/metadata-reader-types.js';
import { seedMobileSqlWaveLibrary } from '../helpers/mobile-sql-owned-wave-library.js';

type ArtistReadCommand = 'localArtist.list' | 'localArtist.search';
type ArtistReadResult = LocalArtistPage | LocalArtistSearchResult;
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const artistNames = (result: ArtistReadResult) => ('artists' in result ? result.artists.items : result.items).map(item => item.name);
const result = (): MetadataReadResult => ({ status: 'ok', parserVersion: RUST_MEDIA_METADATA_PARSER_VERSION,
  fields: { artists: ['补读艺人'], albumArtist: '补读专辑艺人', albumArtists: ['补读专辑艺人'] },
  technical: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48000, channels: 2, bitsPerSample: 16,
    durationSeconds: 0.01, evidence: 'bounded-parser-reported' }, coverEvidence: [],
  readEvidence: { bytesRead: 44, readCalls: 1, maxReadBytes: 44, allocationBytes: 44, elapsedMs: 1,
    wholeAudioHash: false, wholeAudioDecode: false } });

/** 生产 Domain、原索引与真实合成账本；只替换 FD 标签读取和每批数量，不接真实库或 Provider。 */
async function fixture(t: TestContext) {
  const temporary = process.env.TMPDIR;
  assert.ok(typeof temporary === 'string' && temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const directory = await mkdtemp(path.join(temporary, 'mousa41-artist-retry-'));
  const file = path.join(directory, 'catalog.sqlite'), collection = createCollectionRepository({ filePath: file });
  collection.localCatalog.roots();
  const maintenance = createBackupWorkflowStore({ filePath: path.join(directory, 'workflow.sqlite') });
  const identity = maintenance.datasetIdentities.bind('default', file, false), epoch = randomUUID();
  collection.localCatalog.privateBindWorkbenchDataset(identity);
  await seedMobileSqlWaveLibrary(collection, identity.datasetId, path.join(directory, '合成来源'), false,
    ['合成专辑/1.wav', '合成专辑/2.wav']);
  const projection: DatasetProjectionPort = { async call() { throw new Error('本回归不取得真实 Source、Provider 或 Roon 资格。'); } };
  const domain = createDatasetDomain({ collectionRepository: collection, backupWorkflowStore: maintenance,
    collectionDatasetIdentity: identity, localSourceEpoch: epoch, projection, commitBoot() {} });
  t.after(async () => { try { await domain.close(); } finally { await rm(directory, { recursive: true, force: true }); } });
  let clock = 0, reads = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(performance, 'now', () => clock);
  const catalog = collection.localCatalog, enumerate = catalog.privateArtistMetadataBackfillCandidates;
  t.mock.method(catalog, 'privateArtistMetadataBackfillCandidates', (after: number) => enumerate.call(catalog, after, 1));
  t.mock.method(domain.localScan!, 'privateReadArtistMetadata', async () => { reads++; return result(); });
  await domain.prepareWorkbench(); await domain.commitBoot();
  const context: DatasetWorkbenchExecutionContext = { identity: { datasetId: identity.datasetId, epoch },
    signal: new AbortController().signal, deadlineAtMs: 60_000 };
  await domain.dispatchWorkbenchOwner!({ command: 'lifecycle.mainReady', payload: {} }, context);
  return {
    domain, collection, get reads() { return reads; },
    read: (command: ArtistReadCommand) => domain.dispatch({ version: 1, id: randomUUID(), expectedDatasetId: identity.datasetId,
      command, payload: { query: '', offset: 0, limit: 20 } }) as Promise<ArtistReadResult>,
    async advance(ms: number) { clock += ms; t.mock.timers.tick(ms); await turn(); await turn(); },
  };
}

for (const command of ['localArtist.list', 'localArtist.search'] as const) {
  test(`${command} 准备后的客户端重试先读到当前索引，静默后补读仍自动继续`, { timeout: 30_000 }, async t => {
    const f = await fixture(t);
    await assert.rejects(f.read(command), { code: 'PREPARING' });
    await f.domain.localArtists!.refresh();
    const revision = f.domain.localAlbums!.privateMobile.revision();

    // 首轮已经向客户端返回 PREPARING；让 resume(0) 和真实客户端最大 2 秒重试间隔完整经过。
    await f.advance(0); await f.advance(2000);
    const retried = await f.read(command);
    assert.equal(retried.revision, revision);
    assert.ok(artistNames(retried).includes('合成艺人'));
    assert.equal(f.reads, 0, '准备完成到客户端重试之间，后台不得抢先推进同一真实曲库修订');
    assert.equal(f.collection.localCatalog.privateArtistMetadataBackfillCandidates(0, 1).items[0]!.complete, false,
      '交互成功不能以补读全部完成为前提');

    // 最近一次交互安静超过有界窗口，原 paused 重试调度自行恢复，不需要新的 Main-ready 或人工操作。
    await f.advance(5001);
    assert.equal(f.reads, 1);
    const changed = f.domain.localAlbums!.privateMobile.revision();
    assert.notEqual(changed, revision, '补读仍通过原主库观察提交推进真实修订');
    assert.equal(f.collection.localCatalog.privateArtistMetadataBackfillCandidates(0, 1).items[0]!.complete, true);

    await assert.rejects(f.read(command), { code: 'PREPARING' }, '修订已变化时仍须准备，不能把旧索引当作当前结果');
    await f.domain.localArtists!.refresh();
    const updated = await f.read(command);
    assert.equal(updated.revision, changed);
    assert.ok(artistNames(updated).includes('补读艺人'));
  });
}
