import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { createCollectionRepository } from '../src/collection/repository.js';
import { createLocalAlbumOwnerService } from '../src/collection/local-album-browser/owner-port.js';
import { createLocalSourceTickets } from '../src/collection/local-source-tickets.js';
import { createMobileOwnerSourceService } from '../src/mobile/source-service.js';
import { mobileLocalContentDigest, mobileTrackId } from '../src/mobile/local-album-identity.js';
import { seedMobileSqlWaveLibrary } from './helpers/mobile-sql-owned-wave-library.js';

async function fixture(t: test.TestContext) {
  assert.ok(process.env.TMPDIR?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const directory = await mkdtemp(path.join(process.env.TMPDIR!, 'mousa-source-read-'));
  const repository = createCollectionRepository({ filePath: path.join(directory, 'catalog.sqlite') });
  const datasetId = randomUUID(), ownerEpoch = randomUUID(), media = path.join(directory, '合成来源');
  const seeded = await seedMobileSqlWaveLibrary(repository, datasetId, media);
  let inventoryReads = 0;
  const localAlbums = createLocalAlbumOwnerService({ repository, datasetId, assertCurrent() {},
    async readArtwork() { return { image: null, status: 'ready' }; },
    async readRootViews() { return [{ root: repository.localCatalog.root(seeded.rootId), label: '受控来源', availability: 'ONLINE' }]; },
    withArtworkInventoryRead(read) { inventoryReads++; return read(); },
  });
  const tickets = createLocalSourceTickets(repository, ownerEpoch, datasetId, () => {});
  const service = createMobileOwnerSourceService({ collection: repository, datasetId, ownerEpoch, localAlbums, tickets, assertCurrent() {} });
  t.after(async () => { await service.close(); tickets.seal(); localAlbums.close(); repository.close(); await rm(directory, { recursive: true, force: true }); });
  await localAlbums.privateMobile.refresh();
  const trackId = seeded.trackIds[0]!;
  const page = localAlbums.privateMobile.current({ kind: 'members', offset: 0, limit: 2, query: '', rootId: null,
    albumKey: null, trackId, editionId: null, groupHash: null });
  assert.equal(page.items.length, 1);
  const digest = mobileLocalContentDigest(datasetId, repository.localCatalog.trackDetail(trackId));
  const prepared = await service.dispatch({ operation: 'prepare', selection: { resourceId: randomUUID(),
    trackId: mobileTrackId(datasetId, trackId, page.items[0]!.groupHash), versionId: `lv:${digest}`, contentRevision: `lc:${digest}` } });
  assert.equal(prepared.kind, 'mobile-source-prepared'); assert.ok(prepared.kind === 'mobile-source-prepared');
  return { service, source: prepared.source, file: path.join(media, '合成专辑/1.wav'),
    inventoryReads: () => inventoryReads, original: seeded.header };
}

test('手机连续源读取保留完整校验边界，不为租约内部检查重复访问目录库存', async t => {
  const f = await fixture(t), readId = randomUUID();
  for (let start = 0; start < 512; start += 128) {
    const before = f.inventoryReads();
    const result = await f.service.dispatch({ operation: 'read', handle: f.source.handle, readId, start, maxBytes: 128 });
    assert.equal(result.kind, 'mobile-source-read'); assert.ok(result.kind === 'mobile-source-read');
    assert.equal(result.bytes.length, 128);
    if (start === 0) assert.deepEqual(result.bytes.subarray(0, f.original.length), f.original);
    assert.ok(f.inventoryReads() - before <= 4, `单块读取完整目录核验超过读操作边界预算：${f.inventoryReads() - before}`);
  }
});

test('手机源读取实际 FD 已读但文件随后改变时，返回前后核仍拒绝字节', async t => {
  const f = await fixture(t), probe = await open(f.file, 'r'), prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const nativeRead = prototype.read;
  let changed = false;
  t.mock.method(prototype, 'read', async function (this: object, ...args: unknown[]) {
    const result = await Reflect.apply(nativeRead, this, args);
    if (!changed) { changed = true; await appendFile(f.file, Buffer.from([0])); }
    return result;
  });
  const result = await f.service.dispatch({ operation: 'read', handle: f.source.handle, readId: randomUUID(), start: 0, maxBytes: 32 });
  assert.equal(changed, true); assert.ok(result.kind === 'mobile-error'); assert.equal(result.code, 'SOURCE_CHANGED');
  assert.equal(f.service.resourceSnapshot().openLeases, 0);
});

for (const mode of ['同块重试', '文件末尾'] as const) test(`手机源${mode}没有执行真实 read 时仍核验文件变化`, async t => {
  const f = await fixture(t), readId = randomUUID();
  const request = { operation: 'read' as const, handle: f.source.handle, readId,
    start: mode === '文件末尾' ? f.source.size : 0, maxBytes: 32 };
  const before = await f.service.dispatch(request);
  assert.ok(before.kind === 'mobile-source-read');
  assert.equal(before.bytes.length, mode === '文件末尾' ? 0 : 32);
  await appendFile(f.file, Buffer.from([0]));
  const after = await f.service.dispatch({ ...request, ...(mode === '文件末尾' ? { readId: randomUUID() } : {}) });
  assert.ok(after.kind === 'mobile-error'); assert.equal(after.code, 'SOURCE_CHANGED');
  assert.equal(f.service.resourceSnapshot().openLeases, 0);
});
