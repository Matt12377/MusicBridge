import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createLocalAlbumOwnerService } from '../../src/collection/local-album-browser/owner-port.js';
import { createMobileOwnerService } from '../../src/mobile/owner-service.js';
import type { MobileOwnerCatalogRequest } from '../../src/mobile/types.js';
import { readLibraryOperationLine } from '../../src/shared/library-operation-log.js';
import { seedMobileSqlWaveLibrary } from '../helpers/mobile-sql-owned-wave-library.js';

test('真实合成Repository与持久SQL Worker的热成员搜索保留原Owner完整DTO及写后修订', { timeout: 20_000 }, async t => {
  const temporary = process.env.TMPDIR;
  if (typeof temporary !== 'string' || !temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/')) throw new Error('合成搜索库必须使用外置临时目录。');
  const directory = await mkdtemp(path.join(temporary, 'mobile-sql-search-owner-')), databaseFile = path.join(directory, 'catalog.sqlite');
  const repository = createCollectionRepository({ filePath: databaseFile }), datasetId = randomUUID(), ownerEpoch = randomUUID();
  const logs: NonNullable<ReturnType<typeof readLibraryOperationLine>>[] = [], exits: number[] = [];
  let tail = '';
  const seeded = await seedMobileSqlWaveLibrary(repository, datasetId, path.join(directory, '合成来源'));
  const service = createLocalAlbumOwnerService({ repository, datasetId, assertCurrent() {},
    mobileSqlWorker: { databaseFile, workerFactory(options) {
      const worker = new Worker(new URL('../../src/collection/local-album-browser/mobile-sql-worker-entry.ts', import.meta.url),
        { ...options, stdout: true, execArgv: ['--import', 'tsx'] });
      worker.stdout!.on('data', chunk => {
        tail += String(chunk); const lines = tail.split('\n'); tail = lines.pop() ?? '';
        for (const line of lines) { const record = readLibraryOperationLine(line); if (record) logs.push(record); }
      });
      worker.on('exit', code => exits.push(code)); return worker;
    } },
    async readRootViews() { return [{ root: repository.localCatalog.root(seeded.rootId), label: '合成来源', availability: 'ONLINE' }]; },
    async readArtwork() { return { image: null, status: 'ready' }; },
  });
  let closed = false;
  const close = async () => { if (!closed) { await service.privateMobile.closeStructure!(); service.close(); closed = true; } };
  t.after(async () => { await close(); repository.close(); await rm(directory, { recursive: true, force: true }); });
  const mobile = createMobileOwnerService({ collection: repository, datasetId, ownerEpoch, localAlbums: service, assertCurrent() {} });
  const requests: MobileOwnerCatalogRequest[] = ['2her', '合成曲目1', '合成艺人', '合成专辑'].flatMap(q => [0, 1, 3]
    .map((offset): MobileOwnerCatalogRequest => ({ operation: 'listTracks', serverId: 'server.search.synthetic', q, offset, limit: 1,
      albumId: null, itemId: null, expectedRevision: null })));
  const dispatch = (request: MobileOwnerCatalogRequest) => mobile.dispatch({ kind: 'catalog', datasetId, request });
  const original = async (request: MobileOwnerCatalogRequest) => {
    const descriptor = Object.getOwnPropertyDescriptor(service.privateMobile, 'structure')!;
    try { delete service.privateMobile.structure; return await dispatch(request); }
    finally { Object.defineProperty(service.privateMobile, 'structure', descriptor); }
  };
  const expected = [];
  for (const request of requests) expected.push(await original(request));
  await service.privateMobile.prepare!();
  for (let index = 0; index < requests.length; index++) assert.deepEqual(await dispatch(requests[index]!), expected[index]);
  const before = await dispatch(requests[0]!); assert.ok(!('kind' in before) && 'total' in before); assert.equal(before.total, 0);
  repository.localCatalog.observeMetadata({ commandId: randomUUID(), trackId: seeded.trackIds[0]!, source: 'synthetic',
    parserVersion: 'search-change-v1', fields: { title: '2her新观察' } });
  const expectedChanged = await original(requests[0]!), after = await dispatch(requests[0]!);
  assert.deepEqual(after, expectedChanged); assert.ok(!('kind' in after) && 'total' in after); assert.equal(after.total, 1);
  assert.notEqual(after.libraryRevision, before.libraryRevision);
  await close(); assert.deepEqual(exits, [0]);
  assert.ok(logs.some(row => row.action === 'albums.mobile-members' && row.code === 'SEARCH_DIRECTORY_FAST'));
  assert.equal(logs.filter(row => row.action === 'albums.mobile-members' && row.code === 'FULL_FALLBACK').length, 0);
});
