import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createActualMobileNeteasePorts } from '../../src/netease/mobile-actual-ports.js';
import { projectMobileReadResponse } from '../../src/netease/mobile-read-response.js';
import type { NeteaseMobileReadPort, NeteaseMobileReadRequest } from '../../src/netease/types.js';
import type { MobileDirectoryArtist, MobileDirectoryQuery } from '../../src/mobile/directory-rpc.js';
import { MobileServiceError } from '../../src/mobile/types.js';

const identity = { serverId: 'server.directory.synthetic', datasetId: 'dataset.directory.synthetic', ownerEpoch: 'owner.directory.synthetic' };
const signal = () => new AbortController().signal;
const query = (extra: Partial<MobileDirectoryQuery> = {}): MobileDirectoryQuery => ({ kind: 'artists', query: '合成艺人',
  artistId: null, offset: 0, limit: 50, expectedRevision: null, ...extra });
const artist = (id = '17', name = `合成艺人${id}`) => ({ id, name, albumSize: 2, musicSize: 3,
  briefDesc: '合成人物资料', picUrl: 'https://p1.music.126.net/synthetic-artist.jpg' });
const album = (id = '27') => ({ id, name: `合成专辑${id}`, artists: [{ name: '合成艺人' }], size: 1,
  type: '专辑', publishTime: Date.UTC(2020, 0, 1) });
const changed = (error: unknown): boolean => error instanceof MobileServiceError && error.status === 409 && error.code === 'SOURCE_CHANGED';
type Reply = (request: NeteaseMobileReadRequest, owned: AbortSignal) => unknown | Promise<unknown>;
async function fixture(t: TestContext, reply: Reply) {
  const state = { alive: true, providerEpoch: 'provider.directory.synthetic', artworkReads: 0, audioReads: 0 };
  const calls: NeteaseMobileReadRequest[] = [];
  const client: NeteaseMobileReadPort = { configured: true,
    async mobileAccount() { return { accountId: '700', providerEpoch: state.providerEpoch }; },
    async mobileRead(request, options) {
      assert.ok(options?.signal); calls.push(structuredClone(request));
      const raw = await reply(request, options.signal);
      return { providerEpoch: state.providerEpoch, response: projectMobileReadResponse(raw, request.operation) };
    }, onMobileAccountInvalidated() { return () => {}; }, async awaitMobileQuiet() {} };
  const actual = createActualMobileNeteasePorts({ client, ...identity, identityKey32: new Uint8Array(32).fill(23),
    now: () => 1_700_000_000_000,
    assertCurrent: async () => { if (!state.alive) throw new MobileServiceError(409, 'SOURCE_CHANGED'); },
    fetch: async () => { state.audioReads++; throw new Error('合成目录测试不打开音频或外网。'); },
    artworkFetch: async (url, init) => {
      assert.equal(new URL(url).href, 'https://p1.music.126.net/synthetic-artist.jpg?param=512y512');
      assert.equal(new Headers(init.headers).get('cookie'), null); state.artworkReads++;
      return new Response(new Uint8Array([255, 216, 255, 224, 0, 2, 255, 217]),
        { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '8' } });
    } });
  t.after(() => actual.close());
  const account = await actual.account.current(signal()); assert.ok(account);
  const scope = { ...identity, ...account, deviceId: 'device.directory.synthetic', deviceEpoch: 1, accessGeneration: 1 };
  return { actual, scope, state, calls, read: (input = query(), parent = signal()) => actual.readDirectory(scope, input, parent) };
}

test('4.1网易云搜索明确Count零时缺省列表是零结果，非零缺列表仍拒绝', async t => {
  for (const kind of ['tracks', 'albums', 'artists'] as const) {
    let total = 0;
    const f = await fixture(t, request => {
      assert.equal(request.operation, 'directory-search');
      return { body: { code: 200, result: { [kind === 'tracks' ? 'songCount' : kind === 'albums' ? 'albumCount' : 'artistCount']: total } } };
    });
    const empty = await f.read(query({ kind }));
    assert.deepEqual(empty.items, []); assert.equal(empty.total, 0); assert.equal(empty.nextOffset, null);
    assert.equal(empty.offset, 0); assert.equal(empty.limit, 50); assert.match(empty.revision, /^nr:[a-f0-9]{64}$/u);
    total = 1; await assert.rejects(f.read(query({ kind })), error => error instanceof MobileServiceError);
    assert.equal(f.state.audioReads, 0); assert.equal(f.state.artworkReads, 0);
  }
});

test('4.1网易云搜索按服务端offset完整翻页，稳定锚和原查询绑定修订', async t => {
  const f = await fixture(t, request => {
    assert.equal(request.operation, 'directory-search'); if (request.operation !== 'directory-search') throw new Error('操作超界。');
    return { code: 200, result: { artistCount: 125,
      artists: Array.from({ length: Math.min(request.limit, 125 - request.offset) }, (_, n) => artist(String(request.offset + n + 1))) } };
  });
  const first = await f.read(), second = await f.read(query({ offset: 50, expectedRevision: first.revision })),
    third = await f.read(query({ offset: 100, expectedRevision: first.revision }));
  assert.equal(first.items.length, 50); assert.equal(second.items.length, 50); assert.equal(third.items.length, 25);
  assert.equal(first.nextOffset, 50); assert.equal(second.nextOffset, 100); assert.equal(third.nextOffset, null);
  assert.equal(third.total, 125); assert.equal(third.revision, first.revision);
  assert.equal(new Set([...first.items, ...second.items, ...third.items].map(item => item.id)).size, 125);
  await assert.rejects(f.read(query({ query: '另一条查询', offset: 50, expectedRevision: first.revision })), changed);
  assert.equal(f.state.audioReads, 0);
});

test('4.1网易云续页拒绝首屏身份被搬到后页，不能静默形成重复或漏项', async t => {
  let duplicate = false;
  const f = await fixture(t, request => {
    assert.equal(request.operation, 'directory-search'); if (request.operation !== 'directory-search') throw new Error('操作超界。');
    const artists = Array.from({ length: Math.min(request.limit, 125 - request.offset) }, (_, n) => artist(String(request.offset + n + 1)));
    if (duplicate && request.offset === 100) artists[0] = artist('1');
    return { code: 200, result: { artistCount: 125, artists } };
  });
  const first = await f.read(); duplicate = true;
  await assert.rejects(f.read(query({ offset: 100, expectedRevision: first.revision })), changed);
});

test('4.1网易云读取续页期间首屏变动或总数变动均拒绝旧修订', async t => {
  let anchorReads = 0, mutateAfterSelected = false, total = 125;
  const f = await fixture(t, request => {
    assert.equal(request.operation, 'directory-search'); if (request.operation !== 'directory-search') throw new Error('操作超界。');
    if (request.offset === 0) anchorReads++;
    const changedName = mutateAfterSelected && anchorReads >= 3;
    return { code: 200, result: { artistCount: total,
      artists: Array.from({ length: Math.min(request.limit, total - request.offset) }, (_, n) =>
        artist(String(request.offset + n + 1), changedName ? `变更后${request.offset + n + 1}` : `合成艺人${request.offset + n + 1}`)) } };
  });
  const first = await f.read(); mutateAfterSelected = true;
  await assert.rejects(f.read(query({ offset: 100, expectedRevision: first.revision })), changed);
  mutateAfterSelected = false; total = 126;
  await assert.rejects(f.read(query({ offset: 100, expectedRevision: first.revision })), changed);
});

test('4.1网易云艺人详情使用r头像并由原艺人资料接口核验，不泄露图片URL', async t => {
  const f = await fixture(t, request => {
    assert.equal(request.operation, 'artist-profile');
    if (request.operation !== 'artist-profile') throw new Error('头像不能回退到专辑或曲目接口。');
    assert.equal(request.id, '17'); return { code: 200, artist: artist(), hotSongs: [] };
  });
  const result = await f.read(query({ artistId: '17', query: '', limit: 1 }));
  assert.equal(result.total, 1); const value = result.items[0] as MobileDirectoryArtist;
  assert.equal(value.biography, '合成人物资料'); assert.equal(value.credit, '人物资料来自网易云');
  assert.match(value.artworkId!, /^naw:[a-f0-9]{16}:r:17:[a-f0-9]{64}:[a-f0-9]{32}$/u);
  assert.doesNotMatch(JSON.stringify(result), /https?:|cookie|credential|upstream|stack/iu);
  const image = await f.actual.readArtwork(f.scope, value.artworkId!, signal());
  assert.equal(image.contentType, 'image/jpeg'); assert.equal(image.bytes.length, 8); assert.equal(f.state.artworkReads, 1);
  await assert.rejects(f.actual.readArtwork(f.scope, value.artworkId!.replace(':r:17:', ':a:17:'), signal()), changed);
  assert.equal(f.state.artworkReads, 1); assert.equal(f.state.audioReads, 0);
});

test('4.1网易云艺人专辑核请求艺人身份，错误艺人不得借相同albumSize通过', async t => {
  let artistId = '17';
  const f = await fixture(t, request => {
    assert.equal(request.operation, 'artist-albums');
    return { code: 200, artist: { ...artist(artistId), albumSize: 1 }, hotAlbums: [album()], more: false };
  });
  const input = query({ kind: 'albums', artistId: '17', query: '', limit: 1 });
  const first = await f.read(input); assert.equal(first.items.length, 1); assert.equal(first.total, 1);
  assert.equal(first.items[0]!.source, 'netease'); assert.match(first.items[0]!.id, /^na:/u);
  artistId = '18'; await assert.rejects(f.read(input), changed);
});

test('4.1网易云scope在SDK等待中失效或返回Provider代际不符均不发布', async t => {
  let expire = false;
  const f = await fixture(t, () => {
    if (expire) f.state.alive = false;
    return { code: 200, result: { artistCount: 1, artists: [artist()] } };
  });
  const first = await f.read(); assert.equal(first.items.length, 1);
  expire = true; await assert.rejects(f.read(), changed);
  f.state.alive = true; expire = false; f.state.providerEpoch = 'provider.directory.changed';
  await assert.rejects(f.read(), changed);
});

test('4.1网易云预先取消不发SDK请求，上游登录失效不伪造空页', async t => {
  let code = 200;
  const f = await fixture(t, () => ({ code, result: { artistCount: 0, artists: [] } }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.read(query(), controller.signal), error => error instanceof MobileServiceError && error.code === 'BUSY');
  assert.equal(f.calls.length, 0);
  code = 301;
  await assert.rejects(f.read(), error => error instanceof MobileServiceError && error.status === 403 && error.code === 'RESOURCE_REVOKED');
  assert.equal(f.calls.length, 1);
});
