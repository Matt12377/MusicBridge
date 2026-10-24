import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import * as dto from '@music-bridge/contracts';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createLocalAlbumOwnerService } from '../../src/collection/local-album-browser/owner-port.js';
import { createMobileOwnerService } from '../../src/mobile/owner-service.js';
import { seedMobileSqlWaveLibrary } from '../helpers/mobile-sql-owned-wave-library.js';

const vectors: Array<{ online: boolean; raw: boolean; ram: 'available' | 'missing'; persisted: 'available' | 'missing' | null; expected: dto.LocalAlbumSummary['artworkState'] }> = [
  { online: false, raw: false, ram: 'available', persisted: null, expected: 'source-unavailable' },
  { online: false, raw: true, ram: 'missing', persisted: null, expected: 'available' },
  { online: false, raw: false, ram: 'missing', persisted: 'available', expected: 'available' },
  { online: false, raw: true, ram: 'available', persisted: 'missing', expected: 'source-unavailable' },
  { online: true, raw: false, ram: 'available', persisted: null, expected: 'available' },
  { online: true, raw: true, ram: 'missing', persisted: null, expected: 'missing' },
];
async function fixture(t: test.TestContext, vector: typeof vectors[number]) {
  assert.ok(process.env.TMPDIR?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const directory = await mkdtemp(path.join(process.env.TMPDIR!, 'mac72-artwork-')), file = path.join(directory, 'catalog.sqlite');
  const repository = createCollectionRepository({ filePath: file });
  const datasetId = randomUUID(), ownerEpoch = randomUUID();
  const seeded = await seedMobileSqlWaveLibrary(repository, datasetId, path.join(directory, '合成来源'), vector.raw);
  const cover = await readFile(new URL('../fixtures/mbrs012-source/owned-cover-16.jpg', import.meta.url));
  const sha256 = createHash('sha256').update(cover).digest('hex');
  assert.equal(sha256, '555f7915442690ccb14754bd0da000ceadfbdcfb50b4e3402f55d4806e3e989d');
  const image: dto.LocalArtworkImage = { original: { mime: 'image/jpeg', bytes: cover.length, sha256, width: 16, height: 16 },
    display: { mime: 'image/jpeg', bytes: cover.length, sha256, width: 16, height: 16, dataUrl: `data:image/jpeg;base64,${cover.toString('base64')}` } };
  const service = createLocalAlbumOwnerService({ repository, assertCurrent() {},
    mobileSqlWorker: { databaseFile: file, workerFactory: options => new Worker(new URL('../../src/collection/local-album-browser/mobile-sql-worker-entry.ts', import.meta.url), { ...options, execArgv: ['--import', 'tsx'] }) },
    async readRootViews() { return [{ root: repository.localCatalog.root(seeded.rootId), label: '合成来源', availability: vector.online ? 'ONLINE' : 'SOURCE_ROOT_OFFLINE' }]; },
    async readArtwork() { return { image: vector.ram === 'available' ? image : null, status: 'ready' }; },
    // 原可信库存作者的受控返回；不是源扫描、物理封面发现或磁盘持久化验收。
    savedArtworkInventory: { revision: () => '合成持久库存-v1', read: () => vector.persisted },
  });
  t.after(async () => { await service.privateMobile.closeStructure!(); service.close(); repository.close(); await rm(directory, { recursive: true, force: true }); });
  const request: dto.LocalAlbumQuery = { query: '', rootId: null, filter: 'all', offset: 0, limit: 10 };
  const initial = await service.queryAlbums(request), album = initial.items[0]!;
  await service.getArtwork({ albumKey: album.id, rootId: album.rootId, editionId: album.editionId,
    representativeTrackId: album.representativeTrackId, revision: album.revision, refresh: true });
  // 原公开查询将真实RAM观察提升；离线是否使用RAM仍交给原SQL作者判定。
  const original = await service.queryAlbums(request);
  const mobile = createMobileOwnerService({ collection: repository, datasetId, ownerEpoch, localAlbums: service, assertCurrent() {} });
  const input = { kind: 'catalog' as const, datasetId, request: { operation: 'listAlbums' as const, serverId: 'server:synthetic',
    offset: 0, limit: 10, q: '', albumId: null, itemId: null, expectedRevision: null } };
  await mobile.refreshCatalog();
  const baseline = mobile.dispatchCurrentCatalog(input);
  assert.ok(!('kind' in baseline) && 'total' in baseline); assert.equal(baseline.total, 1);
  assert.equal(original.items[0]!.artworkState, vector.expected);
  return { mobile, input, baseline };
}

test('MAC72 封面六向量原同步作者合法基线', { timeout: 25_000 }, async t => {
  for (const vector of vectors) {
    await fixture(t, vector);
    console.log(JSON.stringify({ 事件: '封面作者合法基线', 在线: vector.online, 原始有图: vector.raw, RAM状态: vector.ram, 持久状态: vector.persisted, 预期状态: vector.expected }));
  }
});

test('MAC72 离线RAM与持久优先级在隔离结构后保持原闭集移动DTO', { timeout: 25_000 }, async t => {
  for (const vector of vectors) {
    const f = await fixture(t, vector);
    const actual = await f.mobile.dispatchMobile(f.input);
    assert.deepEqual(actual, f.baseline);
  }
});
