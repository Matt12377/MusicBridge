import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionRepository } from '../../src/collection/repository.js';
import type { LocalAlbumSqlMobileRow } from '../../src/collection/local-album-browser/sql-types.js';
import { createMobileLocalAlbumProjection, type MobileLocalAlbums } from '../../src/mobile/local-album-projection.js';
import { MobileServiceError } from '../../src/mobile/types.js';
import { createLocalAlbumOwnerService } from '../../src/collection/local-album-browser/owner-port.js';
import { LocalAlbumReadError } from '../../src/collection/local-album-browser/grouping.js';

const datasetId = '30000000-0000-4000-8000-000000000001';
function fixture() {
  let revision = 'source:1', queries = 0, revisions = 0, total = 1;
  let duringRead = () => {};
  const row = { album: {
    id: `directory-${'c'.repeat(64)}`, rootId: '40000000-0000-4000-8000-000000000001', title: '合成专辑',
    artists: ['合成艺人'], versionLabel: null, trackCount: 1, artworkState: 'missing',
  }, groupHash: 'a'.repeat(64), artworkSourceRevision: 'b'.repeat(64), member: null } as unknown as LocalAlbumSqlMobileRow;
  const localAlbums = { privateMobile: {
    refresh: async () => {},
    revision: () => { revisions++; return revision; },
    current: (request: { offset: number; limit: number }) => {
      queries++; const before = revision; duringRead();
      return { revision: before, total, items: request.offset === 0 ? [row].slice(0, request.limit) : [] };
    },
  } } as unknown as MobileLocalAlbums;
  const projection = createMobileLocalAlbumProjection({ collection: {} as CollectionRepository,
    datasetId, ownerEpoch: 'owner.synthetic', assertCurrent() {}, localAlbums });
  const request = { operation: 'listAlbums' as const, serverId: 'server.synthetic', offset: 0, limit: 50,
    q: '', albumId: null, itemId: null, expectedRevision: null as string | null };
  return { projection, request, stats: () => ({ queries, revisions }),
    change: () => { revision = 'source:2'; }, during: (operation: () => void) => { duringRead = operation; },
    setTotal: (value: number) => { total = value; } };
}

test('手机专辑分页只执行目标页查询，修订核验不重复遍历全库', () => {
  const f = fixture(), page = f.projection.catalog(f.request);
  assert.equal(page.items.length, 1); assert.equal(page.total, 1);
  assert.equal(page.items[0]!.title, '合成专辑');
  assert.deepEqual(f.stats(), { queries: 1, revisions: 2 });
});

test('内容轻量目录修订与原 DTO 共用唯一作者，不执行目录页查询', () => {
  const f = fixture(), before = f.projection.catalogRevision();
  assert.deepEqual(f.stats(), { queries: 0, revisions: 1 });
  assert.equal(before, f.projection.catalog(f.request).libraryRevision);
  const playback = f.projection.catalogRevision(true);
  assert.equal(playback, f.projection.catalog({ ...f.request, catalogPlaybackEnabled: true }).libraryRevision);
  assert.notEqual(playback, before);
  const queries = f.stats().queries; f.change();
  assert.notEqual(f.projection.catalogRevision(true), playback);
  assert.equal(f.stats().queries, queries, '来源修订变化仍只核原水位，不读全库目录。');
});

test('轻量修订核验仍拒绝旧游标，并在目标页期间发生变化时拒绝回包', () => {
  const f = fixture(), first = f.projection.catalog(f.request);
  f.change(); const before = f.stats().queries;
  assert.throws(() => f.projection.catalog({ ...f.request, expectedRevision: first.libraryRevision }),
    (error: unknown) => error instanceof MobileServiceError && error.code === 'SOURCE_CHANGED');
  assert.equal(f.stats().queries, before, '旧游标在查询目录前拒绝。');
  const g = fixture(); g.during(g.change);
  assert.throws(() => g.projection.catalog(g.request),
    (error: unknown) => error instanceof MobileServiceError && error.code === 'SOURCE_CHANGED');
});

test('移除修订探测页不改变真实目录的容量拒绝', () => {
  const f = fixture(); f.setTotal(300001);
  assert.throws(() => f.projection.catalog(f.request),
    (error: unknown) => error instanceof MobileServiceError && error.code === 'CONTENT_LIMIT_EXCEEDED');
});

test('轻量修订仍受 Owner、撤销、库存读取范围和来源末核保护', async () => {
  let source = 'source:1', current = true, active = true, inInventory = false, changeAtSeal = false;
  let inventoryReads = 0;
  const service = createLocalAlbumOwnerService({
    repository: { localCatalog: { roots: () => [], privateAlbumBrowserRevision: () => source },
      localScan: { privateAlbumBrowserRevision: () => 'scan:1' } } as unknown as CollectionRepository,
    assertCurrent() { if (!current) throw new Error('合成 Owner 已失效。'); },
    assertReadActive() { assert.equal(inInventory, true); if (!active) throw new Error('合成读取已撤销。');
      if (changeAtSeal) source = 'source:2'; },
    readRootViews: async () => [], readArtwork: async () => ({ image: null, status: 'ready' }),
    withArtworkInventoryRead(read) { inventoryReads++; inInventory = true; try { return read(); } finally { inInventory = false; } },
  });
  await service.privateMobile.refresh();
  const first = service.privateMobile.revision(); assert.match(first, /^[a-f0-9]{64}$/u); assert.equal(inventoryReads, 1);
  current = false; assert.throws(() => service.privateMobile.revision(), /Owner 已失效/u); current = true;
  active = false; assert.throws(() => service.privateMobile.revision(), /读取已撤销/u); active = true;
  changeAtSeal = true;
  assert.throws(() => service.privateMobile.revision(),
    (error: unknown) => error instanceof LocalAlbumReadError && error.code === 'SNAPSHOT_CHANGED');
  changeAtSeal = false; assert.notEqual(service.privateMobile.revision(), first);
  service.close(); assert.throws(() => service.privateMobile.revision(),
    (error: unknown) => error instanceof LocalAlbumReadError && error.code === 'SNAPSHOT_CHANGED');
});
