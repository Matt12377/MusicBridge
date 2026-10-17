import assert from 'node:assert/strict';
import test from 'node:test';
import { mobileCatalogResponseSnapshot, type MobileAlbum, type MobileTrack } from '@music-bridge/contracts';
import type { MobileOwnerCatalogRequest, MobileOwnerCatalogSnapshot, MobileOwnerPrivateFailure } from '../../src/mobile/types.js';
import { directoryFixture } from './mobile-directory-fixture.js';

type Fixture = Awaited<ReturnType<typeof directoryFixture>>;
function snapshot(value: MobileOwnerCatalogSnapshot | MobileOwnerPrivateFailure): MobileOwnerCatalogSnapshot {
  if ('kind' in value) assert.fail(`真实扫描目录请求被安全拒绝：${value.status}/${value.code}；不能以 BUSY 或空页掩盖。`);
  assert.ok(Array.isArray(value.items));
  assert.equal(value.items.length, Math.min(value.limit, value.total - value.offset));
  return value;
}
function album(value: MobileAlbum | MobileTrack): MobileAlbum {
  const checked = mobileCatalogResponseSnapshot('album', value);
  assert.ok(checked.ok, '专辑必须通过现有公开 DTO 校验。');
  return checked.value;
}
function track(value: MobileAlbum | MobileTrack): MobileTrack {
  const checked = mobileCatalogResponseSnapshot('track', value);
  assert.ok(checked.ok, '曲目必须通过现有公开 DTO 校验。');
  return checked.value;
}
function withoutArtwork(value: MobileOwnerCatalogSnapshot): MobileOwnerCatalogSnapshot {
  return { ...value, items: value.items.map(item => {
    const { artworkId: _artworkId, ...facts } = item;
    return facts;
  }) };
}
async function complete(f: Fixture, operation: 'listAlbums' | 'listTracks', albumId: string | null = null) {
  const items: Array<MobileAlbum | MobileTrack> = [];
  let offset = 0, expectedRevision: string | null = null, total = -1;
  for (let page = 0; page < 16; page++) {
    const current = snapshot(await f.catalogDispatch({ operation, albumId, offset, limit: 2, expectedRevision }));
    assert.equal(current.operation, operation); assert.equal(current.offset, offset); assert.equal(current.limit, 2);
    if (expectedRevision === null) { expectedRevision = current.libraryRevision; total = current.total; }
    assert.equal(current.libraryRevision, expectedRevision); assert.equal(current.total, total);
    assert.equal(new Set(current.items.map(item => item.id)).size, current.items.length);
    for (const item of current.items) assert.ok(!items.some(previous => previous.id === item.id), '跨页不能重复身份。');
    items.push(...current.items); offset += current.items.length;
    if (offset === total) return { items, total, revision: expectedRevision };
    assert.ok(current.items.length > 0 && offset < total, '不能将缺项或空页伪装成分页完成。');
  }
  assert.fail('五首合成曲目的有限分页未在固定上限内完成。');
}
function assertNoEditionOrSelectedCover(f: Fixture): void {
  assert.ok(f.repository.privateMobileCatalogAccess);
  const counts = f.repository.privateMobileCatalogAccess(db => ({
    editions: Number(db.prepare('SELECT count(*) n FROM local_catalog_editions').get()!.n),
    links: Number(db.prepare('SELECT count(*) n FROM local_catalog_edition_tracks').get()!.n),
    selectedCovers: Number(db.prepare('SELECT count(*) n FROM local_artwork_selections').get()!.n),
  }));
  assert.deepEqual(counts, { editions: 0, links: 0, selectedCovers: 0 }, '测试必须从零手工发行与零选图的真实扫描结果开始。');
}

test('MBM扫描目录衔接：零手工发行的目录与完整成员分页保持同一opaque身份和修订', async t => {
  const f = await directoryFixture(t);
  assert.equal(f.tracks.length, 5); assertNoEditionOrSelectedCover(f);
  const albums = await complete(f, 'listAlbums'), global = await complete(f, 'listTracks');
  assert.equal(albums.total, 3); assert.equal(global.total, 5); assert.equal(albums.revision, global.revision);
  const members: MobileTrack[] = [];
  for (const raw of albums.items) {
    const selected = album(raw), detail = snapshot(await f.catalogDispatch({ operation: 'getAlbum', itemId: selected.id, limit: 1 }));
    assert.equal(detail.total, 1); assert.equal(detail.libraryRevision, albums.revision);
    assert.deepEqual(album(detail.items[0]!), selected);
    const page = await complete(f, 'listTracks', selected.id);
    assert.equal(page.revision, albums.revision); assert.equal(page.total, selected.trackCount);
    for (const rawMember of page.items) {
      const member = track(rawMember); assert.equal(member.albumId, selected.id); members.push(member);
      const found = snapshot(await f.catalogDispatch({ operation: 'getTrack', itemId: member.id, limit: 1 }));
      assert.equal(found.total, 1); assert.equal(found.libraryRevision, albums.revision);
      assert.deepEqual(track(found.items[0]!), member);
    }
  }
  assert.equal(new Set(members.map(item => item.id)).size, 5);
  const canonical = (values: MobileTrack[]) => values.slice().sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(canonical(members), canonical(global.items.map(track)), '专辑成员与全局曲目必须是同一组身份和完整事实。');
  assertNoEditionOrSelectedCover(f); f.assertReadonly(); await f.assertOriginals();
});

test('MBM扫描目录衔接：无封面孤儿并发首载与真实冷读计数晋升不改变手机目录修订', async t => {
  const f = await directoryFixture(t); assertNoEditionOrSelectedCover(f);
  const requests: Partial<MobileOwnerCatalogRequest>[] = [
    { operation: 'listAlbums', offset: 0, limit: 2 }, { operation: 'listTracks', offset: 0, limit: 2 },
  ];
  const [albums, tracks] = await Promise.all(requests.map(async request => snapshot(await f.catalogDispatch(request))));
  assert.ok(albums && tracks); assert.equal(albums.total, 3); assert.equal(tracks.total, 5);
  assert.equal(albums.libraryRevision, tracks.libraryRevision, 'iOS 同时加载两类目录时必须取得同一语义修订。');
  const query = { rootId: null, filter: 'all' as const, query: '', offset: 0, limit: 60 };
  const beforeArtwork = await f.localAlbums.queryAlbums(query), selected = beforeArtwork.items[0]!;
  assert.ok(selected); assert.equal(selected.artworkState, 'unknown');
  const cold = await f.localAlbums.getArtwork({ albumKey: selected.id, rootId: selected.rootId, editionId: selected.editionId,
    representativeTrackId: selected.representativeTrackId, revision: selected.revision });
  assert.equal(cold.status, 'ready'); assert.equal(cold.image, null);
  const promoted = await f.localAlbums.queryAlbums(query);
  assert.equal(promoted.counts['missing-artwork'], beforeArtwork.counts['missing-artwork'] + 1, '真实无图冷读必须晋升确定的missing计数事实。');
  const afterTracks = snapshot(await f.catalogDispatch({ operation: 'listTracks', offset: 0, limit: 2 }));
  assert.deepEqual(withoutArtwork(afterTracks), withoutArtwork(tracks), '封面冷读和计数晋升不能改变手机全局曲目的身份、音频事实或修订。');
  const again = snapshot(await f.catalogDispatch({ operation: 'listAlbums', offset: 0, limit: 2 }));
  assert.deepEqual(withoutArtwork(again), withoutArtwork(albums), '读取全局孤儿或封面计数晋升不能改变原目录或使其失去资格。');
  assert.equal((await f.localAlbums.queryAlbums(query)).counts['missing-artwork'], promoted.counts['missing-artwork'], '手机适配不能反复invalidate原albumRuntime的有效计数。');
  assertNoEditionOrSelectedCover(f); f.assertReadonly(); await f.assertOriginals();
});
