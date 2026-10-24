import assert from 'node:assert/strict';
import test from 'node:test';
import { NeteaseClient } from '../../src/netease/client.js';
import type { NeteaseMobileReadRequest } from '../../src/netease/types.js';
import { withLibraryRead } from '../../src/shared/library-read-lifetime.js';
import { BridgeError } from '../../src/shared/errors.js';

const credential = 'synthetic-directory-client-private';
const signal = () => new AbortController().signal;
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const artist = (id = '17') => ({ id, name: '合成艺人', albumSize: 2, musicSize: 3, briefDesc: '合成简介',
  picUrl: 'https://p1.music.126.net/synthetic-artist.jpg' });
const album = () => ({ id: '27', name: '合成专辑', artist: { id: '17', name: '合成艺人' }, size: 1 });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function clientFor(methods: Record<string, (params: Record<string, unknown>) => unknown | Promise<unknown>>) {
  const unexpected = async (): Promise<never> => { throw new Error('合成目录测试不得调用其它SDK能力。'); };
  return new NeteaseClient(credential, { song_detail: unexpected, song_url_v1: unexpected,
    login_qr_key: unexpected, login_qr_create: unexpected, login_qr_check: unexpected,
    login_status: unexpected, logout: unexpected, ...methods } as NonNullable<ConstructorParameters<typeof NeteaseClient>[1]>, async () => {});
}
const cancelled = (error: unknown): boolean => error instanceof BridgeError && error.code === 'READ_CANCELLED';
const refused = (error: unknown): boolean => error instanceof BridgeError && error.code === 'NETEASE_REQUEST_FAILED';

test('4.1桌面搜索联想只投有界去重关键词，人物资料和艺人专辑沿原SDK读取', async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const method = (name: string, response: unknown) => (params: Record<string, unknown>) => { calls.push({ method: name, params }); return response; };
  const client = clientFor({
    search_suggest: method('search_suggest', { body: { code: 200, result: { allMatch: [{ keyword: '合成' }, { keyword: '合成' },
      { keyword: ' 合成延伸 ' }, { keyword: '' }, { keyword: 123 }], privateExtension: credential } } }),
    artists: method('artists', { body: { code: 200, artist: artist(), hotSongs: [] }, cookie: [credential] }),
    artist_desc: method('artist_desc', { body: { code: 200, briefDesc: '完整合成人物资料' } }),
    artist_album: method('artist_album', { body: { code: 200, artist: artist(), hotAlbums: [album()], more: false } }),
  });
  assert.deepEqual(await client.searchSuggestions('合成'), { keywords: ['合成', '合成延伸'] });
  const profile = await client.getArtistProfile('17');
  assert.deepEqual({ id: profile.id, name: profile.name, albumCount: profile.albumCount, trackCount: profile.trackCount, biography: profile.biography },
    { id: '17', name: '合成艺人', albumCount: 2, trackCount: 3, biography: '完整合成人物资料' });
  const albums = await client.getArtistAlbums('17', { offset: 1, limit: 1 });
  assert.equal(albums.offset, 1); assert.equal(albums.limit, 1); assert.equal(albums.total, 2);
  assert.equal(albums.items[0]!.id, '27'); assert.equal(albums.hasMore, false);
  assert.deepEqual(calls.map(row => row.method), ['search_suggest', 'artists', 'artist_desc', 'artist_album']);
  for (const call of calls) assert.equal(call.params.cookie, credential);
  assert.equal(calls[0]!.params.type, 'mobile'); assert.equal(calls[0]!.params.keywords, '合成');
  assert.equal(calls[3]!.params.id, '17'); assert.equal(calls[3]!.params.offset, 1); assert.equal(calls[3]!.params.limit, 1);
  assert.equal(JSON.stringify({ profile, albums }).includes(credential), false);
});

test('4.1桌面人物详情和艺人专辑拒绝上游返回的其他艺人身份', async () => {
  const profile = clientFor({ artists: () => ({ body: { code: 200, artist: artist('18'), hotSongs: [] } }) });
  await assert.rejects(profile.getArtistProfile('17'), refused);
  const albums = clientFor({ artist_album: () => ({ body: { code: 200, artist: artist('18'), hotAlbums: [album()], more: false } }) });
  await assert.rejects(albums.getArtistAlbums('17', { offset: 0, limit: 10 }), refused);
});

test('4.1桌面新增三操作继承取消与失效scope，迟到SDK响应不能成为当前结果', async () => {
  const cases = [
    { name: 'search_suggest', response: { body: { code: 200, result: { allMatch: [] } } }, run: (client: NeteaseClient) => client.searchSuggestions('合成') },
    { name: 'artists', response: { body: { code: 200, artist: artist(), hotSongs: [] } }, run: (client: NeteaseClient) => client.getArtistProfile('17') },
    { name: 'artist_album', response: { body: { code: 200, artist: artist(), hotAlbums: [], more: false } }, run: (client: NeteaseClient) => client.getArtistAlbums('17', { offset: 0, limit: 10 }) },
  ];
  for (const row of cases) for (const mode of ['cancel', 'scope'] as const) {
    const entered = deferred(), release = deferred(); let calls = 0, alive = true;
    const client = clientFor({ [row.name]: async () => { calls++; entered.resolve(); await release.promise; return row.response; } });
    const controller = new AbortController();
    const pending = withLibraryRead({ signal: controller.signal, deadlineAtMs: Date.now() + 10_000, now: Date.now,
      isCurrent: () => alive }, () => row.run(client));
    const rejected = assert.rejects(pending, cancelled);
    try {
      await entered.promise;
      if (mode === 'cancel') controller.abort(); else alive = false;
      release.resolve(); await rejected; assert.equal(calls, 1, `${row.name}/${mode}`);
    } finally { release.resolve(); }
  }
});

test('4.1桌面搜索联想和艺人专辑保留明确零结果', async () => {
  const client = clientFor({ search_suggest: () => ({ body: { code: 200, result: {} } }),
    artist_album: () => ({ body: { code: 200, artist: { ...artist(), albumSize: 0 }, hotAlbums: [], more: false } }) });
  assert.deepEqual(await client.searchSuggestions('不存在的合成词'), { keywords: [] });
  const page = await client.getArtistAlbums('17', { offset: 0, limit: 10 });
  assert.deepEqual(page.items, []); assert.equal(page.total, 0); assert.equal(page.hasMore, false);
});

test('4.1移动新增目录SDK操作严格映射原方法和分页，只捕获实际使用字段', async () => {
  let unusedReads = 0;
  const withUnused = (value: object) => Object.defineProperty(value, 'unusedSecret', { enumerable: true,
    get() { unusedReads++; throw new Error('无关SDK扩展不得求值。'); } });
  const cases: { request: NeteaseMobileReadRequest; method: string; response: unknown; params: Record<string, unknown> }[] = [
    { request: { operation: 'directory-search', kind: 'artists', query: '合成', offset: 7, limit: 3 }, method: 'search',
      response: { code: 200, result: { artistCount: 1, artists: [withUnused({ ...artist(), picId: Number.MAX_SAFE_INTEGER + 1 })] } },
      params: { keywords: '合成', type: 100, offset: 7, limit: 3 } },
    { request: { operation: 'artist-profile', id: '17' }, method: 'artists',
      response: { code: 200, artist: withUnused(artist()), hotSongs: [{ id: '901', unusedCookie: credential }] }, params: { id: '17' } },
    { request: { operation: 'artist-songs', id: '17' }, method: 'artists',
      response: { code: 200, artist: artist(), hotSongs: [{ id: '901', unusedCookie: credential }] }, params: { id: '17' } },
    { request: { operation: 'artist-albums', id: '17', offset: 7, limit: 3 }, method: 'artist_album',
      response: { code: 200, artist: artist(), hotAlbums: [withUnused(album())], more: false }, params: { id: '17', offset: 7, limit: 3 } },
  ];
  for (const row of cases) {
    let calls = 0;
    const client = clientFor({ [row.method]: params => {
      calls++; for (const [key, value] of Object.entries(row.params)) assert.equal(params[key], value);
      assert.equal(params.cookie, credential); assert.ok(Number(params.timeout) > 0 && Number(params.timeout) <= 10000);
      return { status: 200, body: withUnused(row.response as object), cookie: [credential] };
    } });
    const result = await client.mobileRead(row.request, { signal: signal(), timeoutMs: 10000 }); await client.awaitMobileQuiet();
    const serialized = JSON.stringify(result.response);
    assert.equal(calls, 1); assert.equal(serialized.includes(credential), false); assert.equal(serialized.includes('picId'), false);
    assert.equal(serialized.includes('unused'), false);
    const body = result.response as Record<string, unknown>;
    if (row.request.operation === 'artist-profile' || row.request.operation === 'artist-songs') assert.deepEqual(plain(body.hotSongs), [{ id: '901' }]);
  }
  assert.equal(unusedReads, 0);
});

test('4.1移动曲目/专辑/艺人搜索使用各自上游type并保留零Count', async () => {
  for (const [kind, type, count] of [['tracks', 1, 'songCount'], ['albums', 10, 'albumCount'], ['artists', 100, 'artistCount']] as const) {
    const client = clientFor({ search: params => {
      assert.equal(params.type, type); return { body: { code: 200, result: { [count]: 0 } } };
    } });
    const result = await client.mobileRead({ operation: 'directory-search', kind, query: '合成零结果', offset: 0, limit: 10 }, { signal: signal() });
    assert.deepEqual(plain(result.response), { code: 200, result: { [count]: 0 } }); await client.awaitMobileQuiet();
  }
});

test('4.1移动目录SDK取消只结束本地等待，原signal静止须等不可撤销SDK返回', async () => {
  const entered = deferred(), release = deferred(), controller = new AbortController();
  const client = clientFor({ search: async () => { entered.resolve(); await release.promise;
    return { body: { code: 200, result: { artistCount: 0, artists: [] } } }; } });
  const pending = client.mobileRead({ operation: 'directory-search', kind: 'artists', query: '合成', offset: 0, limit: 10 }, { signal: controller.signal });
  const rejected = assert.rejects(pending, cancelled);
  try {
    await entered.promise; controller.abort(); await rejected;
    let quiet = false; const settled = client.awaitMobileQuiet(controller.signal).then(() => { quiet = true; });
    await Promise.resolve(); assert.equal(quiet, false);
    release.resolve(); await settled; assert.equal(quiet, true);
  } finally { release.resolve(); await client.awaitMobileQuiet(); }
});

test('4.1移动目录使用字段的访问器与不安全ID被拒绝，无关扩展不扩大公开响应', async () => {
  let reads = 0;
  const accessor = Object.defineProperty(artist(), 'name', { enumerable: true, get() { reads++; return '不能求值'; } });
  for (const value of [accessor, { ...artist(), id: Number.MAX_SAFE_INTEGER + 1 }]) {
    const client = clientFor({ artists: () => ({ body: { code: 200, artist: value, hotSongs: [] } }) });
    await assert.rejects(client.mobileRead({ operation: 'artist-profile', id: '17' }, { signal: signal() }), refused);
    await client.awaitMobileQuiet();
  }
  assert.equal(reads, 0);
});
