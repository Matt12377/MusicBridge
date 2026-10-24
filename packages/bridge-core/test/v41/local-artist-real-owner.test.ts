import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createLocalAlbumOwnerService } from '../../src/collection/local-album-browser/owner-port.js';
import { createLocalArtistSearchService } from '../../src/collection/local-artist-search.js';
import { readLibraryOperationLine } from '../../src/shared/library-operation-log.js';
import { seedMobileSqlWaveLibrary } from '../helpers/mobile-sql-owned-wave-library.js';

test('首次艺人索引沿原目录摘要读取成员，不能逐页重复整库SQL', { timeout: 30_000 }, async t => {
  const temporary = process.env.TMPDIR;
  assert.ok(typeof temporary === 'string' && temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const directory = await mkdtemp(path.join(temporary, 'mousa41-artist-real-owner-'));
  const repository = createCollectionRepository({ filePath: path.join(directory, 'catalog.sqlite') });
  const datasetId = randomUUID();
  const seeded = await seedMobileSqlWaveLibrary(repository, datasetId, path.join(directory, '合成来源'), false,
    ['合成专辑/1.wav', '另一专辑/2.wav']);
  const localAlbums = createLocalAlbumOwnerService({ repository, assertCurrent() {},
    readRootViews: async () => [{ root: repository.localCatalog.root(seeded.rootId), label: '合成来源', availability: 'ONLINE' }],
    readArtwork: async () => ({ image: null, status: 'ready' }),
  });
  const service = createLocalArtistSearchService({ collection: repository, localAlbums, directory: null, assertCurrent() {} });
  const records: NonNullable<ReturnType<typeof readLibraryOperationLine>>[] = [];
  const original = console.info;
  console.info = (...values: unknown[]) => {
    if (values.length === 1 && typeof values[0] === 'string') {
      const record = readLibraryOperationLine(values[0]); if (record) records.push(record);
    }
  };
  t.after(async () => { console.info = original; await service.close(); localAlbums.close(); repository.close(); await rm(directory, { recursive: true, force: true }); });
  const page = await service.queryArtists({ query: '合成艺人', offset: 0, limit: 20 });
  assert.equal(page.total, 1); assert.equal(page.items[0]!.trackCount, 2);
  assert.equal((await service.search({ query: 'hechengyiren', offset: 0, limit: 20 })).tracks.total, 2);
  const reads = records.filter(row => row.action === 'albums.mobile-members');
  assert.ok(reads.some(row => row.code === 'DIRECTORY_FAST'));
  assert.equal(reads.filter(row => row.code === 'FULL_FALLBACK').length, 0, '未预热目录摘要会让每一页重复整库物化');
});
