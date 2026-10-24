import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  MOBILE_OPERATION_TABLE, mobileCatalogResponseSnapshot, type MobileAlbum, type MobileSearchQuery,
  type MobileTrack, type MobileTrackPage, type MobileUIAlbumRecord,
} from '@music-bridge/contracts';
import { createMobileContentRuntime } from '../../src/mobile/content-runtime.js';
import { captureMobileContentRequest } from '../../src/mobile/content-protocol.js';
import { createMobileContentRpcPort, type MobileContentRpcPortOptions } from '../../src/mobile/content-rpc-port.js';
import { captureMobileContentCoreRequest, captureMobileContentCoreResponse,
  type MobileContentCoreResponse } from '../../src/mobile/content-rpc.js';
import type { MobileContentScope } from '../../src/mobile/content-types.js';
import { isMobileOwnerPrivateRequest, isMobileOwnerPrivateResult } from '../../src/mobile/owner-protocol.js';
import type { DatasetOwnerEndpoint } from '../../src/collection/dataset-owner-protocol.js';
import type { NeteaseMobileReadPort, NeteaseMobileReadRequest, NeteaseMobileAccountInvalidation } from '../../src/netease/types.js';
import { MobileServiceError, type MobileOwnerPrivateResult } from '../../src/mobile/types.js';

// 实际 Runtime/RPC/Provider/目录适配器；Owner 身份和正式 SDK 回包受控，不开真实账号或音频。
const SERVER = 'server.album-runtime', DATASET = '20000000-0000-4000-8000-000000000014';
const OWNER = '20000000-0000-4000-8000-000000000015';
const signal = () => new AbortController().signal;
const base = () => ({ type: 'mobile-content-core-request' as const, id: randomUUID() });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function albumRequest(scope: Readonly<MobileContentScope>, albumId: string, query: MobileSearchQuery | null = null,
  expected?: { fingerprint: string; revision?: string }) {
  return { ...base(), action: 'album-catalog' as const, operation: query === null ? 'getAlbum' as const : 'listTracks' as const,
    mode: expected ? 'revalidate' as const : 'read' as const, scope, albumId, query,
    expectedFingerprint: expected?.fingerprint ?? null, expectedRevision: expected?.revision ?? null };
}
function success<T>(response: MobileContentCoreResponse): { body: T; fingerprint: string } {
  assert.ok('kind' in response && response.kind === 'album-catalog',
    `原专辑读取必须成功，实际${'kind' in response && response.kind === 'error' ? `${response.status}/${response.code}` : response.action}`);
  return response as unknown as { body: T; fingerprint: string };
}
function failure(response: MobileContentCoreResponse, code?: string, status?: number) {
  assert.ok('kind' in response && response.kind === 'error');
  if (code !== undefined) assert.equal(response.code, code);
  if (status !== undefined) assert.equal(response.status, status);
  assert.equal(response.retryable, false);
  assert.doesNotMatch(JSON.stringify(response), /https?:|cookie|credential|upstream|stack/iu);
}
async function fixture(t: TestContext, ownerEpoch = OWNER, covers = false) {
  const clock = { now: Date.now() }; t.mock.method(Date, 'now', () => clock.now);
  const state = { accountId: '700', providerEpoch: 'provider.album.1', count: 103, suffix: '', alive: true,
    audioOpens: 0, quietCalls: 0, rawFailure: undefined as MobileServiceError | undefined, albumReads: 0,
    shrinkAtAlbumRead: 0, malformed: '' as '' | 'duplicate' | 'foreign' | 'count',
    albumCover: covers ? 'https://p1.music.126.net/synthetic-album-cover.jpg' : '',
    songCover: covers ? 'https://p1.music.126.net/synthetic-song-cover.jpg' : '', artworkOpens: 0 };
  const calls: NeteaseMobileReadRequest[] = [], ownerActions: string[] = [];
  const listeners = new Set<(event: NeteaseMobileAccountInvalidation) => void>();
  const rawPending = new Map<AbortSignal, Set<Promise<void>>>();
  const gates: { operation: 'album' | 'song-detail'; entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>; used: boolean }[] = [];
  const album = () => ({ id: '5', name: '合成原发行' + state.suffix, artists: [{ id: '17', name: '合成艺人' }],
    size: state.count + (state.malformed === 'count' ? 1 : 0), publishTime: Date.parse('2020-01-01T00:00:00Z'),
    ...(state.albumCover ? { picUrl: state.albumCover } : {}) });
  const song = (id: string) => ({ id, name: `合成曲${id}` + state.suffix, ar: [{ id: '17', name: '合成艺人' }],
    al: { id: state.malformed === 'foreign' && id === '1' ? '6' : '5', name: '合成原发行',
      ...(id === '2' && state.songCover ? { picUrl: state.songCover } : {}) }, dt: 120_000, alia: [] });
  const client: NeteaseMobileReadPort = { configured: true,
    async mobileAccount() { return { accountId: state.accountId, providerEpoch: state.providerEpoch }; },
    async mobileRead(request, options) {
      calls.push(structuredClone(request)); if (state.rawFailure) throw state.rawFailure;
      const gate = gates.find(value => !value.used && value.operation === request.operation);
      if (gate) {
        gate.used = true; const owned = options?.signal; assert.ok(owned); gate.entered.resolve();
        const pending = rawPending.get(owned) ?? new Set<Promise<void>>(); pending.add(gate.release.promise); rawPending.set(owned, pending);
        void gate.release.promise.then(() => { pending.delete(gate.release.promise); if (pending.size === 0) rawPending.delete(owned); });
        let abort!: () => void;
        const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(new MobileServiceError(503, 'BUSY'));
          owned.addEventListener('abort', abort, { once: true }); if (owned.aborted) abort(); });
        try { await Promise.race([gate.release.promise, cancelled]); }
        finally { owned.removeEventListener('abort', abort); }
      }
      let response: unknown;
      if (request.operation === 'new-albums') response = { code: 200, total: 1, albums: request.offset === 0 ? [album()] : [] };
      else if (request.operation === 'album') {
        assert.equal(request.id, '5'); state.albumReads++;
        if (state.shrinkAtAlbumRead === state.albumReads) state.count = 1;
        const songs = Array.from({ length: state.count }, (_, index) => song(String(index + 1)));
        if (state.malformed === 'duplicate' && songs.length > 1) songs[1] = song('1');
        response = { code: 200, album: album(), songs };
      } else if (request.operation === 'song-detail') response = { code: 200, songs: request.ids.map(song) };
      else if (request.operation === 'streams') response = { code: 200, data: request.ids.map(id => id === '102'
        ? { id, code: 403, url: null } : { id, code: 200, md5: 'a'.repeat(32), size: 150_000, expi: 300,
          url: `https://synthetic-album.invalid/${id}.flac`, level: 'hires', type: 'flac', br: 9216000 }) };
      else throw new Error('专辑目录不能调用播放、歌词或其他Provider接口。');
      return { providerEpoch: state.providerEpoch, response };
    }, onMobileAccountInvalidated(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async awaitMobileQuiet(owned) { state.quietCalls++;
      while (owned ? rawPending.get(owned)?.size : rawPending.size) {
        await Promise.allSettled(owned ? [...(rawPending.get(owned) ?? [])] : [...rawPending.values()].flatMap(value => [...value]));
      }
    } };
  const endpoint: DatasetOwnerEndpoint = { async prepare() { return { datasetId: DATASET, epoch: ownerEpoch }; },
    async commitBoot() {}, async dispatch() { throw new Error('专辑读取不发送普通Owner写命令。'); }, async close() {},
    async mobileMain(request) {
      assert.equal(isMobileOwnerPrivateRequest(request), true); assert.equal(request.kind, 'content');
      if (request.kind !== 'content') throw new Error('目录不读本地Owner。');
      ownerActions.push(request.request.action); let result: MobileOwnerPrivateResult;
      const q = request.request;
      if (q.action === 'initialize') result = { kind: 'content-initialized', serverId: SERVER, datasetId: DATASET, ownerEpoch };
      else if (q.action === 'updateScope') result = { kind: 'content-scope-updated', datasetId: DATASET, ownerEpoch, scope: q.scope };
      else if (q.action === 'invalidateScope') result = { kind: 'content-scope-invalidated', datasetId: DATASET, ownerEpoch, scopeKind: q.kind };
      else throw new Error('普通Provider专辑读取不能借收藏/歌单plan制造事实。');
      assert.equal(isMobileOwnerPrivateResult(result, request), true); return result;
    } };
  const runtime = createMobileContentRuntime({ owner: endpoint, netease: client,
    assertCurrent() { if (!state.alive) throw new MobileServiceError(409, 'SOURCE_CHANGED'); },
    artworkFetch: async (url, init) => {
      assert.ok(covers);
      const requested = new URL(url); assert.equal(requested.search, '?param=512y512'); requested.search = '';
      assert.ok(requested.href === state.albumCover || requested.href === state.songCover);
      assert.equal(new Headers(init.headers).get('cookie'), null); state.artworkOpens++;
      return new Response(new Uint8Array([255, 216, 255, 224, 0, 2, 255, 217]),
        { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '8' } });
    },
    streamFetch: async () => { state.audioOpens++; throw new Error('专辑目录不允许探测/打开音频。'); } });
  t.after(async () => { for (const gate of gates) gate.release.resolve(); await runtime.close(); });
  const initialized = await runtime.request({ ...base(), action: 'initialize', serverId: SERVER, datasetId: DATASET,
    key: new Uint8Array(32).fill(17) }, signal()); assert.ok('ok' in initialized && initialized.ok);
  const rpc = (request: unknown, parent = signal()) => runtime.request(request, parent);
  async function scope(deviceId = 'device.album.1', accessGeneration = 1, deviceEpoch = 1) {
    const response = await rpc({ ...base(), action: 'scope', principal: { serverId: SERVER, datasetId: DATASET, deviceId, deviceEpoch, accessGeneration } });
    assert.ok('kind' in response && response.kind === 'scope'); return response.scope;
  }
  const firstScope = await scope();
  const path = MOBILE_OPERATION_TABLE.listNeteaseNewAlbums.path;
  const request = captureMobileContentRequest('listNeteaseNewAlbums', { path, pathParameters: {}, query: { limit: 10 }, body: null });
  const discovery = await rpc({ ...base(), action: 'dispatch', operation: 'listNeteaseNewAlbums', scope: firstScope, request });
  assert.ok('kind' in discovery && discovery.kind === 'snapshot');
  const feed = discovery.reply.body as { items: MobileUIAlbumRecord[] };
  const albumId = feed.items[0]!.id;
  assert.match(albumId, /^na:[a-f0-9]{16}:5$/u);
  const checked = await rpc({ ...base(), action: 'revalidate', snapshotId: discovery.snapshotId, scope: firstScope });
  assert.ok('kind' in checked && checked.kind === 'validated');
  const query = (extra: MobileSearchQuery = {}): MobileSearchQuery => ({ source: 'netease', albumId, limit: 50, ...extra });
  return { runtime, rpc, state, calls, ownerActions, scope, firstScope, albumId, query, feed, clock,
    blockRaw(operation: 'album' | 'song-detail') { const gate = { operation, entered: deferred(), release: deferred(), used: false }; gates.push(gate); return gate; },
    async changeAccount(accountId: string, providerEpoch: string) {
      const previousProviderEpoch = state.providerEpoch; state.accountId = accountId; state.providerEpoch = providerEpoch;
      for (const listener of listeners) listener({ previousProviderEpoch, nextProviderEpoch: providerEpoch });
      await runtime.providerChanged();
    } };
}
test('R16_ARTWORK 缺图歌曲使用已核归属的专辑封面，独立曲图与精确播放身份保留', async t => {
  const f = await fixture(t, OWNER, true); f.state.count = 3;
  const album = success<MobileAlbum>(await f.rpc(albumRequest(f.firstScope, f.albumId))).body;
  assert.ok(album.artworkId);
  const page = success<MobileTrackPage>(await f.rpc(albumRequest(f.firstScope, f.albumId, f.query()))).body;
  assert.equal(page.items[0]!.artworkId, album.artworkId);
  assert.equal(page.items[2]!.artworkId, album.artworkId);
  assert.ok(page.items[1]!.artworkId); assert.notEqual(page.items[1]!.artworkId, album.artworkId);
  for (const artworkId of new Set(page.items.map(row => row.artworkId!))) {
    const image = await f.rpc({ ...base(), action: 'artwork', operation: 'read', scope: f.firstScope,
      artworkId, expectedRevision: null });
    assert.ok('kind' in image && image.kind === 'artwork', JSON.stringify(image));
    assert.equal(image.contentType, 'image/jpeg'); assert.equal(image.bytes.length, 8);
  }
  assert.equal(f.state.artworkOpens, 2); assert.equal(f.state.audioOpens, 0);
  const selection = (row: MobileTrack) => ({ id: row.id, source: row.source,
    versionId: row.versionId, contentRevision: row.contentRevision });
  f.state.albumCover = '';
  const without = success<MobileTrackPage>(await f.rpc(albumRequest(f.firstScope, f.albumId, f.query()))).body;
  assert.equal(without.items[0]!.artworkId, undefined);
  assert.deepEqual(without.items.map(selection), page.items.map(selection));
  assert.doesNotMatch(JSON.stringify(page), /https?:|music\.126\.net|cookie/iu);
  f.state.malformed = 'foreign';
  failure(await f.rpc(albumRequest(f.firstScope, f.albumId, f.query())), 'SOURCE_CHANGED', 409);
});
test('R14_RUNTIME 新碟na详情到103首完整分页含不可播放，计数/顺序/版本与原公开形态一致', async t => {
  const f = await fixture(t), album = success<MobileAlbum>(await f.rpc(albumRequest(f.firstScope, f.albumId))).body;
  assert.equal(album.id, f.feed.items[0]!.id); assert.equal(album.trackCount, 103); assert.equal(album.source, 'netease');
  assert.ok(mobileCatalogResponseSnapshot('album', album).ok); assert.equal(Object.hasOwn(album, 'year'), false);
  const tracks: MobileTrack[] = [], revisions = new Set<string>(), cursors = new Set<string>(); let cursor: string | undefined;
  do {
    const request = albumRequest(f.firstScope, f.albumId, f.query(cursor ? { cursor } : {}));
    const page = success<MobileTrackPage>(await f.rpc(request)); assert.ok(mobileCatalogResponseSnapshot('trackPage', page.body).ok);
    tracks.push(...page.body.items); revisions.add(page.body.libraryRevision);
    // 新签游标可有不同签发时刻；同一页真实事实未变时发送前复验必须成功。
    f.clock.now += 1_000;
    const ack = await f.rpc(albumRequest(f.firstScope, f.albumId, request.query, { fingerprint: page.fingerprint, revision: page.body.libraryRevision }));
    assert.ok('kind' in ack && ack.kind === 'album-catalog-validated');
    cursor = page.body.nextCursor ?? undefined;
    if (cursor) { assert.equal(cursors.has(cursor), false); cursors.add(cursor); }
  } while (cursor);
  assert.equal(revisions.size, 1); assert.equal(tracks.length, album.trackCount); assert.equal(new Set(tracks.map(row => row.id)).size, 103);
  assert.deepEqual(tracks.map(row => row.sourceItemId), Array.from({ length: 103 }, (_, index) => String(index + 1)));
  assert.equal(tracks[101]!.availability, 'unavailable'); assert.equal(tracks.filter(row => row.availability === 'unavailable').length, 1);
  assert.ok(tracks.every(row => row.albumId === album.id && row.durationMs === 120_000 && row.audio.codec === 'unknown'));
  assert.equal(f.state.audioOpens, 0); assert.ok(f.calls.every(row => ['new-albums', 'album', 'song-detail', 'streams'].includes(row.operation)));
  assert.ok(f.ownerActions.every(action => ['initialize', 'updateScope'].includes(action)));
  assert.doesNotMatch(JSON.stringify({ album, tracks }), /synthetic-album|https?:|cookie|accountDomain|providerEpoch|ownerEpoch/iu);
});
test('R14_CURSOR 同一有效scope的album/limit/q、篡改过期和跨设备/授权/账户/Provider/Owner均不能借旧页', async t => {
  const f = await fixture(t), page = success<MobileTrackPage>(await f.rpc(albumRequest(f.firstScope, f.albumId, f.query()))).body;
  assert.ok(page.nextCursor); const cursor = page.nextCursor;
  for (const query of [f.query({ cursor, limit: 49 }), f.query({ cursor, q: 'changed' }),
    f.query({ cursor: cursor.slice(0, -1) + (cursor.endsWith('A') ? 'B' : 'A') })]) {
    failure(await f.rpc(albumRequest(f.firstScope, f.albumId, query)), 'CURSOR_INVALID', 409);
  }
  const otherAlbum = f.albumId.replace(/:5$/u, ':6');
  failure(await f.rpc(albumRequest(f.firstScope, otherAlbum, f.query({ albumId: otherAlbum, cursor }))), 'CURSOR_INVALID', 409);
  const secondDevice = await f.scope('device.album.2');
  failure(await f.rpc(albumRequest(secondDevice, f.albumId, f.query({ cursor }))), 'CURSOR_INVALID', 409);
  const renewed = await f.scope(f.firstScope.deviceId, 2);
  failure(await f.rpc(albumRequest(renewed, f.albumId, f.query({ cursor }))), 'CURSOR_INVALID', 409);
  for (const field of ['accountDomain', 'providerEpoch', 'ownerEpoch', 'deviceEpoch', 'accessGeneration'] as const) {
    const value = typeof renewed[field] === 'number' ? Number(renewed[field]) + 1 : 'changed.fixture';
    failure(await f.rpc(albumRequest({ ...renewed, [field]: value }, f.albumId, f.query({ cursor }))));
  }
  const current = success<MobileTrackPage>(await f.rpc(albumRequest(renewed, f.albumId, f.query()))).body;
  assert.ok(current.nextCursor);
  await f.changeAccount('700', 'provider.album.2'); const nextProvider = await f.scope(f.firstScope.deviceId, 2);
  failure(await f.rpc(albumRequest(nextProvider, f.albumId, f.query({ cursor: current.nextCursor }))), 'CURSOR_INVALID', 409);
  const providerPage = success<MobileTrackPage>(await f.rpc(albumRequest(nextProvider, f.albumId, f.query()))).body;
  assert.ok(providerPage.nextCursor);
  await f.changeAccount('701', 'provider.album.2'); const changed = await f.scope(f.firstScope.deviceId, 2);
  failure(await f.rpc(albumRequest(changed, f.albumId, f.query({ cursor: providerPage.nextCursor }))), 'CURSOR_INVALID', 409);
  const fresh = success<MobileTrackPage>(await f.rpc(albumRequest(changed, f.albumId, f.query()))).body;
  assert.ok(fresh.nextCursor); f.clock.now += 300_001;
  failure(await f.rpc(albumRequest(changed, f.albumId, f.query({ cursor: fresh.nextCursor }))), 'CURSOR_INVALID', 409);
  const requests = f.calls.filter(row => row.operation === 'album').length;
  failure(await f.rpc(albumRequest(changed, 'na:0000000000000000:5')), 'INVALID_REQUEST', 400);
  assert.equal(f.calls.filter(row => row.operation === 'album').length, requests);
});
test('R14_OWNER 同key/库/账户/设备的新合法Owner不能接续旧Owner签发页', async t => {
  const first = await fixture(t), page = success<MobileTrackPage>(await first.rpc(albumRequest(first.firstScope, first.albumId, first.query()))).body;
  assert.ok(page.nextCursor); await first.runtime.close();
  const next = await fixture(t, '20000000-0000-4000-8000-000000000016');
  assert.equal(next.albumId, first.albumId); assert.equal(next.firstScope.accountDomain, first.firstScope.accountDomain);
  assert.equal(next.firstScope.providerEpoch, first.firstScope.providerEpoch); assert.notEqual(next.firstScope.ownerEpoch, first.firstScope.ownerEpoch);
  failure(await next.rpc(albumRequest(next.firstScope, next.albumId, next.query({ cursor: page.nextCursor }))), 'CURSOR_INVALID', 409);
});
test('R14_REVISION 旧cursor缩短及前检后竞态缩短先报SOURCE_CHANGED，发送前原页变化不重签冒充', async t => {
  for (const race of [false, true]) await t.test(race ? '前检后缩短' : '前检前缩短', async child => {
    const f = await fixture(child), first = success<MobileTrackPage>(await f.rpc(albumRequest(f.firstScope, f.albumId, f.query())));
    assert.ok(first.body.nextCursor);
    if (race) f.state.shrinkAtAlbumRead = f.state.albumReads + 2; else f.state.count = 1;
    failure(await f.rpc(albumRequest(f.firstScope, f.albumId, f.query({ cursor: first.body.nextCursor }))), 'SOURCE_CHANGED', 409);
  });
  const f = await fixture(t), read = success<MobileTrackPage>(await f.rpc(albumRequest(f.firstScope, f.albumId, f.query())));
  f.state.suffix = '元数据变化';
  failure(await f.rpc(albumRequest(f.firstScope, f.albumId, f.query(), { fingerprint: read.fingerprint, revision: read.body.libraryRevision })), 'SOURCE_CHANGED', 409);
});
test('R14_PROVIDER 成员重复/归属错误/计数不等/原上游失败不变成成功空页', async t => {
  const f = await fixture(t);
  for (const malformed of ['duplicate', 'foreign', 'count'] as const) {
    f.state.malformed = malformed; failure(await f.rpc(albumRequest(f.firstScope, f.albumId, f.query())), 'SOURCE_CHANGED', 409);
  }
  f.state.malformed = '';
  for (const error of [new MobileServiceError(403, 'RESOURCE_REVOKED'), new MobileServiceError(503, 'BUSY')]) {
    f.state.rawFailure = error; failure(await f.rpc(albumRequest(f.firstScope, f.albumId, f.query())), error.code, error.status);
  }
  assert.equal(f.state.audioOpens, 0);
});
test('R14_RAW_QUIET 实际适配器在SDK表层abort后仍等原raw工作，详情和专辑页不能提前ACK', async t => {
  for (const operation of ['getAlbum', 'listTracks', 'continuationRevision'] as const) await t.test(operation, async child => {
    const f = await fixture(child), parent = new AbortController();
    let query: MobileSearchQuery | null = operation === 'getAlbum' ? null : f.query();
    if (operation === 'continuationRevision') {
      const first = success<MobileTrackPage>(await f.rpc(albumRequest(f.firstScope, f.albumId, f.query()))).body;
      assert.ok(first.nextCursor); query = f.query({ cursor: first.nextCursor });
    }
    const gate = f.blockRaw('album'), request = albumRequest(f.firstScope, f.albumId, query);
    const reading = f.rpc(request, parent.signal); await gate.entered.promise; parent.abort(); failure(await reading, 'BUSY', 503);
    let quiet = false;
    const cancelling = f.rpc({ ...base(), action: 'cancel', requestId: request.id, snapshotId: null, scope: f.firstScope })
      .then(value => { quiet = true; return value; });
    try {
      for (let index = 0; index < 100; index++) await Promise.resolve();
      const requests = f.calls.filter(row => row.operation === 'album').length;
      failure(await f.rpc(request), 'BUSY', 503);
      assert.equal(f.calls.filter(row => row.operation === 'album').length, requests,
        '原request id真实quiet前仍占位，不能再次执行目录SDK。');
      assert.equal(quiet, false, '表层SDK abort不能冒充原raw Promise静止。');
      assert.ok(f.state.quietCalls > 0, '须沿原owned signal核对SDK真实quiet。');
    } finally { gate.release.resolve(); }
    const ack = await cancelling; assert.ok('kind' in ack && ack.kind === 'cancelled' && ack.quiet);
    success<MobileAlbum>(await f.rpc(albumRequest(f.firstScope, f.albumId)));
    assert.equal(f.state.audioOpens, 0);
  });
});
const staticScope: MobileContentScope = { serverId: SERVER, datasetId: DATASET, deviceId: 'device.rpc.album', deviceEpoch: 1,
  accessGeneration: 1, ownerEpoch: OWNER, accountDomain: 'account.rpc.album', providerEpoch: 'provider.rpc.album' };
const staticAlbum: MobileAlbum = { id: 'na:0123456789abcdef:5', source: 'netease', title: '合成原发行', artists: ['合成艺人'], editionLabel: '', trackCount: 0 };
async function rpcFixture(t: TestContext, read: (signal: AbortSignal) => Promise<MobileAlbum>) {
  const options: MobileContentRpcPortOptions & { readAlbum(scope: Readonly<MobileContentScope>, id: string, owned: AbortSignal): Promise<MobileAlbum> } = {
    initialize: async () => undefined, invalidateDevice: async () => undefined, content: { async dispatch() { throw new Error('不走内容写入。'); } },
    resolveScope: async () => staticScope, assertScope: scope => { assert.deepEqual({ ...scope }, staticScope); },
    source: async () => { throw new Error('目录不准备音频。'); }, readAlbum: (_scope, _id, owned) => read(owned), maxInflight: 2 };
  const rpc = createMobileContentRpcPort(options); t.after(() => rpc.close());
  const initialized = await rpc.request({ ...base(), action: 'initialize', serverId: SERVER, datasetId: DATASET, key: new Uint8Array(32).fill(19) }, signal());
  assert.ok('ok' in initialized && initialized.ok); return rpc;
}
test('R14_RPC 仅闭形原scope/album/query/指纹通过，拒凭据/getter/错回应绑定', async t => {
  const rpc = await rpcFixture(t, async () => structuredClone(staticAlbum)), request = albumRequest(staticScope, staticAlbum.id);
  const captured = captureMobileContentCoreRequest(request), response = await rpc.request(captured, signal()); success<MobileAlbum>(response);
  let getters = 0; const accessor = { ...request }; Object.defineProperty(accessor, 'albumId', { enumerable: true, get() { getters++; return staticAlbum.id; } });
  for (const raw of [{ ...request, cookie: 'synthetic-secret' }, accessor,
    { ...request, query: {} }, { ...request, mode: 'revalidate', expectedFingerprint: null },
    { ...request, operation: 'listTracks', query: { source: 'local', albumId: staticAlbum.id } },
    { ...request, operation: 'listTracks', query: { source: 'netease', albumId: 'na:other' } }]) {
    assert.throws(() => captureMobileContentCoreRequest(raw), MobileServiceError);
  }
  assert.equal(getters, 0);
  for (const raw of [{ ...response, id: randomUUID() }, { ...response, albumId: 'na:other' },
    { ...response, scope: { ...staticScope, accountDomain: 'other' } }, { ...response, token: 'synthetic-secret' },
    { ...response, body: { ...staticAlbum, id: 'na:other' } }, { ...response, fingerprint: 'f'.repeat(64) }]) {
    assert.throws(() => captureMobileContentCoreResponse(raw, captured));
  }
});
test('R14_QUIET 原专辑取消不把迟到读取当quiet，控制槽等待真实工作后才释放且不发布迟回', async t => {
  const entered = deferred(), release = deferred(); let reads = 0, aborted = false, settled = 0;
  t.after(() => release.resolve());
  const rpc = await rpcFixture(t, async owned => { reads++; owned.addEventListener('abort', () => { aborted = true; }, { once: true });
    entered.resolve(); await release.promise; return structuredClone(staticAlbum); });
  const request = albumRequest(staticScope, staticAlbum.id), parent = new AbortController();
  const reading = rpc.request(request, parent.signal, () => { settled++; });
  await entered.promise; failure(await rpc.request(albumRequest(staticScope, staticAlbum.id), signal()), 'BUSY', 503);
  parent.abort(); failure(await reading, 'BUSY', 503); assert.equal(aborted, true); assert.equal(reads, 1);
  let quiet = false;
  const cancel = rpc.request({ ...base(), action: 'cancel', requestId: request.id, snapshotId: null, scope: staticScope }, signal())
    .then(value => { quiet = true; return value; });
  for (let index = 0; index < 80; index++) await Promise.resolve(); assert.equal(quiet, false);
  failure(await rpc.request(albumRequest(staticScope, staticAlbum.id), signal()), 'BUSY', 503); assert.equal(reads, 1);
  release.resolve(); const ack = await cancel; assert.ok('kind' in ack && ack.kind === 'cancelled' && ack.quiet);
  assert.equal(settled, 0, '专辑读取没有供播放资源使用的迟回发布权限。');
  success<MobileAlbum>(await rpc.request(albumRequest(staticScope, staticAlbum.id), signal())); assert.equal(reads, 2);
});
