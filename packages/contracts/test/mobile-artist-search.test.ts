import assert from 'node:assert/strict';
import test from 'node:test';
import { captureMobileArtist, captureMobileArtistPage, isMobileArtistSearchPath,
  MobileArtistSearchContractError, parseMobileArtistSearchRoute } from '../src/mobile-artist-search.js';

const ARTIST = `local-artist:${'a'.repeat(64)}`;
function route(path: string, query: [string, string][], method = 'GET', body: unknown = null) {
  return parseMobileArtistSearchRoute({ method, path, query, body });
}

test('4.1 搜索类型与来源严格独立，查询保持原字节', () => {
  for (const kind of ['tracks', 'albums', 'artists']) {
    for (const source of ['local', 'netease']) {
      const value = route(`/mobile/v1/search/${kind}`, [['q', '同名 音乐'], ['source', source], ['limit', '20']]);
      assert.equal(value.kind, kind); assert.equal(value.source, source); assert.equal(value.query, '同名 音乐');
      assert.equal(value.limit, 20); assert.equal(value.cursor, null); assert.equal(value.artistId, null);
    }
  }
});

test('4.1 拒绝重复来源、未知键、裸offset、越界limit与空搜索', () => {
  const invalid: [string, string][][] = [
    [['q', 'music'], ['source', 'local'], ['source', 'netease']],
    [['q', 'music'], ['source', 'all']], [['q', 'music']],
    [['q', 'music'], ['source', 'local'], ['offset', '100']],
    [['q', 'music'], ['source', 'local'], ['limit', '0']],
    [['q', 'music'], ['source', 'local'], ['limit', '101']],
    [['q', 'music'], ['source', 'local'], ['limit', '01']],
    [['q', ''], ['source', 'local']], [['q', ' '.repeat(3)], ['source', 'local']],
    [['q', 'x'.repeat(201)], ['source', 'local']], [['q', 'music\n'], ['source', 'local']],
    [['q', 'music'], ['source', 'local'], ['cursor', '']],
    [['q', 'music'], ['source', 'local'], ['cursor', 'x'.repeat(2049)]],
  ];
  for (const query of invalid) assert.throws(() => route('/mobile/v1/search/tracks', query), MobileArtistSearchContractError);
});

test('4.1 本地列表仅本地，人物作品保持明确来源与关系', () => {
  assert.equal(route('/mobile/v1/library/artists', []).source, 'local');
  assert.throws(() => route('/mobile/v1/library/artists', [['source', 'netease']]), MobileArtistSearchContractError);
  const local = route(`/mobile/v1/library/artists/${encodeURIComponent(ARTIST)}/albums`, [['source', 'local'], ['relation', 'appearsOn']]);
  assert.equal(local.artistId, ARTIST); assert.equal(local.relation, 'appearsOn');
  assert.equal(local.operation, 'listLibraryArtistAlbums');
  assert.equal(route('/mobile/v1/library/artists/123/albums', [['source', 'netease']]).relation, 'albums');
  assert.throws(() => route('/mobile/v1/library/artists/123/albums', [['source', 'netease'], ['relation', 'appearsOn']]), MobileArtistSearchContractError);
  assert.throws(() => route(`/mobile/v1/library/artists/${ARTIST}`, [['source', 'netease']]), MobileArtistSearchContractError);
});

test('4.1 PUT关联只接受期望字段与显式null，不接受额外权限或source字段', () => {
  const path = `/mobile/v1/library/artists/${ARTIST}/link`;
  const unlink = route(path, [], 'PUT', { neteaseArtistId: null });
  assert.equal(unlink.operation, 'setLibraryArtistLink'); assert.equal(unlink.neteaseArtistId, null);
  assert.equal(route(path, [], 'PUT', { neteaseArtistId: '123' }).neteaseArtistId, '123');
  for (const body of [{}, { neteaseArtistId: '' }, { neteaseArtistId: 123 },
    { neteaseArtistId: 'https://provider.invalid' }, { neteaseArtistId: '123', source: 'netease' },
    { neteaseArtistId: null, permission: true }]) {
    assert.throws(() => route(path, [], 'PUT', body), MobileArtistSearchContractError);
  }
  assert.throws(() => route(path, [], 'GET'), MobileArtistSearchContractError);
  assert.throws(() => route('/mobile/v1/search/tracks', [['source', 'local'], ['q', 'music']], 'GET', {}), MobileArtistSearchContractError);
});

test('4.1 本地人物不接受跨source或二次编码身份', () => {
  for (const id of ['../private', '123', `local-artist:${'a'.repeat(63)}`, `${ARTIST}%2Fprivate`]) {
    assert.throws(() => route(`/mobile/v1/library/artists/${encodeURIComponent(id)}/tracks`, [['source', 'local']]), MobileArtistSearchContractError);
  }
  assert.equal(isMobileArtistSearchPath('/mobile/v1/search/tracks'), true);
  assert.equal(isMobileArtistSearchPath('/mobile/v1/library/artists'), true);
  assert.equal(isMobileArtistSearchPath('/mobile/v1/tracks'), false);
  assert.equal(isMobileArtistSearchPath('/mobile/v1/library/artists/a/unknown'), false);
});

test('4.1 Artist回执闭集不允许URL、负计数、伪造关联或未知linkState', () => {
  const value = { id: ARTIST, name: '合成人物', source: 'local', albumCount: 2, trackCount: 3,
    linkedNeteaseId: '123', linkState: 'manual' };
  assert.equal(captureMobileArtist(value).ok, true);
  for (const bad of [{ ...value, artworkUrl: 'https://provider.invalid/private' }, { ...value, albumCount: -1 },
    { ...value, linkState: 'unlinked' }, { ...value, linkedNeteaseId: 'nt:123' },
    { ...value, linkState: 'guessed' }, { ...value, name: ' ' }, { ...value, biography: '字'.repeat(20001) }]) {
    assert.equal(captureMobileArtist(bad).ok, false);
  }
});

test('4.1 ArtistPage要求cursor键、来源一致、唯一身份与有界条数', () => {
  const item = { id: ARTIST, name: '合成人物', source: 'local', albumCount: 1, trackCount: 2 };
  assert.equal(captureMobileArtistPage({ items: [item], nextCursor: null, libraryRevision: 'r1' }, 'local').ok, true);
  for (const page of [{ items: [item], libraryRevision: 'r1' },
    { items: [item, item], nextCursor: null, libraryRevision: 'r1' },
    { items: [item], nextCursor: null, libraryRevision: 'r1', total: 999 },
    { items: [], nextCursor: 'cursor', libraryRevision: 'r1' }]) {
    assert.equal(captureMobileArtistPage(page, 'local').ok, false);
  }
  assert.equal(captureMobileArtistPage({ items: [item], nextCursor: null, libraryRevision: 'r1' }, 'netease').ok, false);
});
