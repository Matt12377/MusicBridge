import assert from 'node:assert/strict';
import test from 'node:test';
import { NeteaseClient } from '../../src/netease/client.js';
import type { NeteaseMobileReadRequest } from '../../src/netease/types.js';
import { createActualMobileNeteasePorts } from '../../src/netease/mobile-actual-ports.js';
import { parseResolvedAudioStream } from '../../src/netease/parse.js';
import { BridgeError } from '../../src/shared/errors.js';
import { MobileServiceError } from '../../src/mobile/types.js';

const unsafe = Number.MAX_SAFE_INTEGER + 1, credential = 'synthetic-mobile-read-private-cookie';
const signal = () => new AbortController().signal;
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const refused = (error: unknown): boolean => error instanceof BridgeError && error.code === 'NETEASE_REQUEST_FAILED';
const song = () => ({ id: 702, name: '合成曲目', ar: [{ id: 703, name: '合成艺人' }],
  al: { id: 704, name: '合成专辑', picUrl: 'https://p1.music.126.net/synthetic-cover.jpg' }, dt: 1000, alia: ['合成版本', '不参与当前版本的别名'] });
const album = () => ({ id: 704, name: '合成专辑', artists: [{ id: 703, name: '合成艺人' }], size: 1,
  type: '专辑', publishTime: 1700000000000, picUrl: 'https://p1.music.126.net/synthetic-cover.jpg' });
const collection = () => ({ id: 701, name: '合成喜欢歌单', trackCount: 1, trackIds: [{ id: 702 }], updateTime: 1,
  coverImgUrl: 'https://p1.music.126.net/synthetic-cover.jpg' });
const stream = () => ({ id: 702, code: 200, freeTrialInfo: null, md5: 'a'.repeat(32), size: 4096, expi: 60,
  url: 'https://m7.music.126.net/synthetic-audio.flac', level: 'hires', type: 'flac', br: 1500000 });
type Packet = Record<string, unknown>;
interface Case { name: string; method: string; request: NeteaseMobileReadRequest; body(): Packet; extra(value: Packet): void }
const cases: Case[] = [
  { name: 'daily', method: 'recommend_songs', request: { operation: 'daily' }, body: () => ({ code: 200, data: { dailySongs: [song()] } }),
    extra: value => { ((value.data as { dailySongs: ReturnType<typeof song>[] }).dailySongs[0]!.al as Packet).picId = unsafe; } },
  { name: 'recommended', method: 'personalized', request: { operation: 'recommended-playlists', limit: 100 }, body: () => ({ code: 200, result: [{ id: 701 }] }),
    extra: value => { (value.result as Packet[])[0]!.picId = unsafe; } },
  { name: 'newAlbums', method: 'album_new', request: { operation: 'new-albums', offset: 0, limit: 100 }, body: () => ({ code: 200, total: 1, albums: [album()] }),
    extra: value => { (value.albums as Packet[])[0]!.picId = unsafe; } },
  { name: 'charts', method: 'toplist', request: { operation: 'charts' }, body: () => ({ code: 200, list: [{ id: 701 }] }),
    extra: value => { (value.list as Packet[])[0]!.coverImgId = unsafe; } },
  { name: 'FM', method: 'personal_fm', request: { operation: 'personal-fm' }, body: () => ({ code: 200, data: [song()] }),
    extra: value => { ((value.data as ReturnType<typeof song>[])[0]!.al as Packet).picId = unsafe; } },
  { name: 'likedSearch', method: 'user_playlist', request: { operation: 'user-playlists', userId: '700', offset: 0, limit: 100 },
    body: () => ({ code: 200, more: false, playlist: [{ id: 701, specialType: 10, creator: { userId: 700 } }] }),
    extra: value => { (value.playlist as Packet[])[0]!.coverImgId = unsafe; } },
  { name: 'playlistDetail', method: 'playlist_detail', request: { operation: 'playlist-detail', id: '701' }, body: () => ({ code: 200, playlist: collection() }),
    extra: value => { (value.playlist as Packet).coverImgId = unsafe; } },
  { name: 'songDetail', method: 'song_detail', request: { operation: 'song-detail', ids: ['702'] }, body: () => ({ code: 200, songs: [song()] }),
    extra: value => { ((value.songs as ReturnType<typeof song>[])[0]!.al as Packet).picId = unsafe; } },
  { name: 'album', method: 'album', request: { operation: 'album', id: '704' }, body: () => ({ code: 200, album: album(), songs: [song()] }),
    extra: value => { (value.album as Packet).picId = unsafe; } },
  { name: 'lyrics', method: 'lyric_new', request: { operation: 'lyrics', id: '702' }, body: () => ({ code: 200, data: { lrc: { lyric: '[00:00.00]合成歌词' }, uncollected: false } }),
    extra: value => { (value.data as Packet).unusedImageId = unsafe; } },
  { name: 'stream', method: 'song_url_v1', request: { operation: 'stream', id: '702', quality: 'hires' }, body: () => ({ code: 200, data: [stream()] }),
    extra: value => { (value.data as Packet[])[0]!.unusedImageId = unsafe; } },
];
function clientFor(methods: Record<string, (params: Record<string, unknown>) => unknown | Promise<unknown>>) {
  const unexpected = async (): Promise<never> => { throw new Error('合成响应夹具不得调用其它SDK能力。'); };
  return new NeteaseClient(credential, { song_detail: unexpected, song_url_v1: unexpected, login_qr_key: unexpected,
    login_qr_create: unexpected, login_qr_check: unexpected, login_status: unexpected, logout: unexpected,
    ...methods } as NonNullable<ConstructorParameters<typeof NeteaseClient>[1]>, async () => undefined);
}
async function read(client: NeteaseClient, request: NeteaseMobileReadRequest) {
  const value = await client.mobileRead(request, { signal: signal(), timeoutMs: 10000 }); await client.awaitMobileQuiet(); return value;
}

test('移动SDK响应：十一种操作的无关图片ID扩展不影响实际字段，裸body与SDK包装保持等价', async () => {
  for (const fixture of cases) {
    let extended = false, wrapped = false;
    const client = clientFor({ [fixture.method]: params => {
      assert.ok(Number(params.timeout) > 0 && Number(params.timeout) <= 10000);
      const body = fixture.body();
      if (extended) { fixture.extra(body); body.privateExtension = '不进入移动结果的合成扩展'; }
      return wrapped ? { status: 200, body, cookie: ['不进入移动结果的合成Cookie'] } : body;
    } });
    const baseline = await read(client, fixture.request); extended = true; wrapped = true;
    const actual = await read(client, fixture.request);
    assert.deepEqual(actual, baseline, fixture.name);
    assert.equal(JSON.stringify(actual).includes('不进入移动结果'), false);
  }
});

test('移动SDK响应：song/album/playlist/lyrics/stream实际使用的字段原值保留', async () => {
  for (const fixture of cases.filter(value => ['songDetail', 'album', 'playlistDetail', 'lyrics', 'stream'].includes(value.name))) {
    const client = clientFor({ [fixture.method]: () => ({ body: fixture.body() }) }), response = (await read(client, fixture.request)).response as Packet;
    if (fixture.name === 'songDetail') {
      const value = (response.songs as ReturnType<typeof song>[])[0]!;
      assert.equal(value.name, song().name); assert.deepEqual(plain(value.ar), song().ar); assert.deepEqual(plain(value.al), song().al);
      assert.equal(value.dt, song().dt); assert.equal(value.alia[0], song().alia[0]);
    }
    if (fixture.name === 'album') {
      const value = response.album as ReturnType<typeof album>;
      assert.equal(value.name, album().name); assert.equal(value.publishTime, album().publishTime); assert.equal(value.picUrl, album().picUrl);
      assert.equal(value.artists[0]!.name, album().artists[0]!.name); assert.equal((response.songs as ReturnType<typeof song>[])[0]!.name, song().name);
    }
    if (fixture.name === 'playlistDetail') assert.deepEqual(plain(response.playlist), collection());
    if (fixture.name === 'lyrics') assert.deepEqual(plain(response.data), (fixture.body().data));
    if (fixture.name === 'stream') {
      assert.deepEqual(plain(response.data), [stream()]);
      const resolved = parseResolvedAudioStream(response, '702', 'hires');
      assert.equal(resolved.upstreamUrl, stream().url); assert.equal(resolved.actualQuality, 'hires'); assert.equal(resolved.bitrate, stream().br);
    }
  }
});

test('移动SDK响应：无关getter和Proxy不读取，外层body及实际字段getter或Proxy在执行前拒绝', async () => {
  let reads = 0, traps = 0;
  const unused = () => { reads++; throw new Error('不应读取无关扩展。'); };
  const proxy = new Proxy({}, { getPrototypeOf() { traps++; throw new Error('不应执行Proxy trap。'); }, ownKeys() { traps++; return []; }, getOwnPropertyDescriptor() { traps++; throw new Error('不应执行Proxy trap。'); } });
  const body = { code: 200, result: [{ id: 701 }] } as Packet;
  Object.defineProperty(body, 'unusedGetter', { enumerable: true, get: unused }); body.unusedProxy = proxy;
  const wrapper = { body } as Packet; Object.defineProperty(wrapper, 'unusedWrapper', { enumerable: true, get: unused });
  const client = clientFor({ personalized: () => wrapper });
  await read(client, { operation: 'recommended-playlists', limit: 20 }); assert.deepEqual({ reads, traps }, { reads: 0, traps: 0 });
  const getterBody = Object.defineProperty({}, 'body', { enumerable: true, get() { reads++; return { code: 200, result: [] }; } });
  const used = Object.defineProperty({ id: 702 }, 'name', { enumerable: true, get: unused });
  const packets = [getterBody, proxy, { body: proxy }, { body: { code: 200, result: [proxy] } }, { body: { code: 200, songs: [used] } }];
  for (const [index, packet] of packets.entries()) {
    const method = index === 4 ? 'song_detail' : 'personalized', request = index === 4 ? cases[7]!.request : { operation: 'recommended-playlists' as const, limit: 20 };
    await assert.rejects(read(clientFor({ [method]: () => packet }), request), refused);
  }
  assert.deepEqual({ reads, traps }, { reads: 0, traps: 0 });
});

test('移动SDK响应：使用字段unsafe、污染key、缺失或错误列表和洞不变成成功空页', async () => {
  const badId = { code: 200, result: [{ id: unsafe }] }, badCode = { code: unsafe, result: [] };
  const polluted = JSON.parse('{"code":200,"result":[],"__proto__":{"poison":true}}') as unknown;
  const ownConstructor = { code: 200, result: [], constructor: { prototype: {} } };
  const missing = { code: 200 }, wrong = { code: 200, result: {} }, sparse = { code: 200, result: new Array(1) };
  for (const body of [badId, badCode, polluted, ownConstructor, missing, wrong, sparse]) {
    await assert.rejects(read(clientFor({ personalized: () => ({ body }) }), { operation: 'recommended-playlists', limit: 20 }), refused);
  }
});

test('移动SDK响应：数组先限长，节点与字节仍有界；无关巨大扩展不遍历', async () => {
  let reads = 0;
  const huge: unknown[] = []; huge.length = 100000000;
  Object.defineProperty(huge, '0', { enumerable: true, get() { reads++; return { id: 701 }; } });
  await assert.rejects(read(clientFor({ personalized: () => ({ body: { code: 200, result: huge } }) }), { operation: 'recommended-playlists', limit: 20 }), refused);
  assert.equal(reads, 0);
  const heavy = { code: 200, album: album(), songs: Array.from({ length: 10000 }, song) };
  await assert.rejects(read(clientFor({ album: () => ({ body: heavy }) }), { operation: 'album', id: '704' }), refused);
  await assert.rejects(read(clientFor({ playlist_detail: () => ({ body: { code: 200, playlist: { ...collection(), name: 'a'.repeat(2 * 1024 * 1024 + 1) } } }) }), { operation: 'playlist-detail', id: '701' }), refused);
  const unknown = Object.defineProperty({}, 'huge', { get() { reads++; return huge; }, enumerable: true });
  const value = await read(clientFor({ personalized: () => ({ body: { code: 200, result: [], unneeded: unknown } }) }), { operation: 'recommended-playlists', limit: 20 });
  assert.deepEqual(plain(value.response), { code: 200, result: [] }); assert.equal(reads, 0);
});

test('移动SDK响应：Stream URL、试播拒绝与完整LRC字段不被扩展投影放宽', async () => {
  for (const row of [{ ...stream(), url: 'https://127.0.0.1/private.flac' }, { ...stream(), freeTrialInfo: { start: 0, end: 1000 } }]) {
    const response = (await read(clientFor({ song_url_v1: () => ({ body: { code: 200, data: [row] } }) }), cases[10]!.request)).response;
    assert.throws(() => parseResolvedAudioStream(response, '702', 'hires'));
  }
  const body = { code: 200, lrc: { lyric: '[00:00.00]原完整行' }, yrc: { lyric: '[0,1000](0,1000,0)原完整行' },
    tlyric: { lyric: '[00:00.00]原翻译' }, romalrc: { lyric: '[00:00.00]原音译' }, yromalrc: { lyric: '[00:00.00]原音译' }, uncollected: false };
  const response = await read(clientFor({ lyric_new: () => ({ body }) }), { operation: 'lyrics', id: '702' });
  assert.deepEqual(plain(response.response), body);
  for (const name of ['pureMusic', 'instrumental', 'nolyric', 'uncollected']) {
    for (const nested of [false, true]) {
      const flags = { [name]: true }, body = nested ? { code: 200, data: flags } : { code: 200, ...flags };
      assert.deepEqual(plain((await read(clientFor({ lyric_new: () => ({ body }) }), { operation: 'lyrics', id: '702' })).response), body);
    }
  }
});

test('移动SDK响应：实际喜欢摘要的无关图片ID不再造成503，缺元数据与上游登录拒绝仍明确失败', async () => {
  let invalid = false, feedCode = 200, network = 0;
  const client = clientFor({ user_account: () => ({ body: { code: 200, account: { id: '700' } } }),
    user_playlist: () => ({ body: { code: feedCode, more: false, playlist: [{ id: 701, specialType: 10, creator: { userId: 700 }, coverImgId: unsafe }] } }),
    playlist_detail: () => ({ body: { code: 200, playlist: { ...collection(), name: invalid ? '' : collection().name } } }) });
  const identity = { serverId: 'server.synthetic.projector', datasetId: 'dataset.synthetic.projector', ownerEpoch: 'owner.synthetic.projector' };
  const actual = createActualMobileNeteasePorts({ client, ...identity, identityKey32: new Uint8Array(32).fill(19), assertCurrent: async () => {},
    fetch: async () => { network++; throw new Error('合成目录测试不得外连。'); } });
  try {
    const account = await actual.account.current(signal()); assert.ok(account);
    const scope = { ...identity, ...account, deviceId: 'device.synthetic.projector', deviceEpoch: 1, accessGeneration: 1 };
    const request = () => actual.provider.read({ operation: 'getNeteaseLikedPlaylist', scope,
      request: { path: '/mobile/v1/ui/netease/liked-playlist', pathParameters: {}, query: {}, body: null }, offset: 0, limit: 20, expectedRevision: null, signal: signal() });
    const success = await request(); assert.equal((success.body as Packet).title, collection().name);
    invalid = true; await assert.rejects(request(), error => error instanceof MobileServiceError && error.status === 409 && error.code === 'SOURCE_CHANGED');
    invalid = false; feedCode = 301; await assert.rejects(request(), error => error instanceof MobileServiceError && error.status === 403 && error.code === 'RESOURCE_REVOKED');
    assert.equal(network, 0);
  } finally { await actual.close(); await client.awaitMobileQuiet(); }
});
