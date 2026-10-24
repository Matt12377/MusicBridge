import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ClientRequest } from 'node:http';
import { MOBILE_OPERATION_TABLE, mobileDataSnapshot, mobileRecord } from '@music-bridge/contracts';
import type { MobileRequestMap, MobileTrack, MobileTrackSelection } from '@music-bridge/contracts';
import { NeteaseClient } from '../../src/netease/client.js';
import { createActualMobileNeteasePorts } from '../../src/netease/mobile-actual-ports.js';
import { createMobileContentProviderService } from '../../src/mobile/content-provider-service.js';
import { createMobileNeteaseCatalogService } from '../../src/mobile/netease-catalog-service.js';
import { createMobileNeteaseSourceService } from '../../src/mobile/netease-source-service.js';
import { captureMobileContentRequest } from '../../src/mobile/content-protocol.js';
import type { MobileContentOperation, MobileContentSnapshot } from '../../src/mobile/content-types.js';
import { captureMobileContentScope } from '../../src/mobile/content-types.js';
import type { MobileNeteaseScope } from '../../src/mobile/netease-source-types.js';
import { captureMobileNeteaseScope } from '../../src/mobile/netease-source-types.js';
import { createMobileContentRpcPort } from '../../src/mobile/content-rpc-port.js';
import { createMobileArtworkFetch } from '../../src/netease/mobile-artwork-transport.js';
import { MobileServiceError } from '../../src/mobile/types.js';
import type { GatewayFetch } from '../../src/stream/upstream-policy.js';
import { BridgeError } from '../../src/shared/errors.js';
import { createMobileCapabilityContext, withMobileCapabilityContext, closeMobileCapabilityContext, copyMobileCapabilityTraceRecord, mobileCapabilityReject, MOBILE_CAPABILITY_TRACE_PREFIX } from '../../src/mobile/capability-trace.js';
import { mobileContentTrackFingerprint } from '../../src/mobile/content-rpc.js';

// 原Client/scheduler/解析器与新适配器组合；SDK和HTTP均为合成受控端口，不连接账号或用户媒体。
const signal = () => new AbortController().signal;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function request<O extends MobileContentOperation>(operation: O, query: Record<string, string | number> = {}, pathParameters: Record<string, string> = {}): MobileRequestMap[O] {
  let path: string = MOBILE_OPERATION_TABLE[operation].path;
  for (const [key, value] of Object.entries(pathParameters)) path = path.replace(`{${key}}`, encodeURIComponent(value));
  return captureMobileContentRequest(operation, { path, pathParameters, query, body: null });
}
function selection(track: MobileTrack): MobileTrackSelection { return { trackId: track.id, source: track.source, versionId: track.versionId, contentRevision: track.contentRevision }; }
function captured(value: unknown) { const snapshot = mobileDataSnapshot(value); assert.ok(snapshot.ok); return snapshot.value; }
function streamBody(reply: { body: unknown }): { code: number; data: Record<string, unknown>[] } {
  assert.ok(mobileRecord(reply.body) && reply.body.code === 200 && Array.isArray(reply.body.data) && reply.body.data.every(mobileRecord));
  return reply.body as { code: number; data: Record<string, unknown>[] };
}
function safeError(code: string, status?: number) { return (value: unknown) => value instanceof MobileServiceError && value.code === code && (status === undefined || value.status === status); }
function flac() {
  const value = Buffer.alloc(150000); value.write('fLaC'); value[4] = 0x80; value.writeUIntBE(34, 5, 3);
  value.writeUInt16BE(4096, 8); value.writeUInt16BE(4096, 10);
  value.writeBigUInt64BE(192000n << 44n | 1n << 41n | 23n << 36n | 192000n, 18);
  for (let n = 42; n < value.length; n++) value[n] = n % 251;
  return value;
}
async function fixture(t: TestContext, covers = false, privateProviderDiagnostics = false, artworkFetch?: GatewayFetch) {
  const audio = flac(), calls: { method: string; params: Record<string, unknown> }[] = [], ranges: string[] = [], stages: string[] = [];
  const songs = Array.from({ length: 251 }, (_, index) => ({ id: String(index + 1), name: index < 2 ? '同名合成曲' : `合成曲${index + 1}`,
    ar: [{ id: '17', name: '合成艺人' }], al: { id: '5', name: '合成原发行', ...(covers ? { picUrl: 'https://p1.music.126.net/synthetic-cover.jpg' } : {}) }, dt: 1500, alia: [index === 1 ? '另一录制' : '原发行'] }));
  let accountId: string | number = '700', generation = 1, deviceEpoch = 1, active = true, clock = 1700000000000;
  let metadataSuffix = '', md5Suffix = 'a', trial = false, permissionCode = 200, streamCalls = 0;
  let accountFailure: BridgeError | null = null, probeFailure = false, probeEtag: string | null = null;
  let lyrics: Record<string, unknown> = { code: 200, lrc: { lyric: '[00:00.000]第一行\n[00:00.500]第二行' }, tlyric: { lyric: '[00:00.000]译文' } };
  let songGate: { started: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> } | null = null;
  const gates: { release: ReturnType<typeof deferred<void>> }[] = [];
  function song(id: string) { const found = songs.find(value => value.id === id); assert.ok(found); return { ...found, name: found.name + metadataSuffix, ar: found.ar.map(a => ({ ...a })), al: { ...found.al }, alia: [...found.alia] }; }
  function response(body: unknown) { return { body, cookie: ['synthetic-sdk-wrapper-cookie'] }; }
  function log(method: string, params: Record<string, unknown>) { calls.push({ method, params: { ...params } }); assert.equal(typeof params.timeout, 'number'); }
  const api = {
    async login_qr_key() { return response({ code: 200 }); }, async login_qr_create() { return response({ code: 200 }); },
    async login_qr_check() { return response({ code: 200 }); }, async login_status() { return response({ code: 200 }); }, async logout() { return response({ code: 200 }); },
    async user_account(params: Record<string, unknown>) { log('user_account', params); if (accountFailure) throw accountFailure; return response({ code: 200, account: { id: accountId } }); },
    async song_detail(params: Record<string, unknown>) { log('song_detail', params); assert.equal(typeof params.ids, 'string');
      if (songGate) { const gate = songGate; songGate = null; gate.started.resolve(); await gate.release.promise; }
      return response({ code: 200, songs: String(params.ids).split(',').map(song) }); },
    async song_url_v1(params: Record<string, unknown>) { log('song_url_v1', params); streamCalls++;
      return response({ code: 200, data: String(params.id).split(',').map(id => ({ id, code: permissionCode, freeTrialInfo: trial ? { start: 0, end: 1 } : null,
        md5: md5Suffix.repeat(32), size: audio.length, expi: 300, url: `https://mobile-audio.invalid/${id}.flac`, level: 'hires', type: 'flac', br: 9216000 })) }); },
    async recommend_songs(params: Record<string, unknown>) { log('recommend_songs', params); return response({ code: 200, data: { dailySongs: songs.slice(0, 2).map(v => ({ id: v.id })) } }); },
    async personal_fm(params: Record<string, unknown>) { log('personal_fm', params); return response({ code: 200, data: [{ id: '1' }] }); },
    async user_playlist(params: Record<string, unknown>) { log('user_playlist', params); return response({ code: 200, more: false, playlist: [{ id: '9', specialType: 10, creator: { userId: accountId } }] }); },
    async playlist_detail(params: Record<string, unknown>) { log('playlist_detail', params); return response({ code: 200, playlist: { id: params.id,
      name: `合成集合${String(params.id)}`, ...(covers ? { coverImgUrl: 'https://p1.music.126.net/synthetic-cover.jpg' } : {}), trackCount: 251, updateTime: 7, trackIds: songs.slice(0, 251).map(v => ({ id: v.id })) } }); },
    async personalized(params: Record<string, unknown>) { log('personalized', params); return response({ code: 200, result: [{ id: '9' }, { id: '10' }] }); },
    async toplist(params: Record<string, unknown>) { log('toplist', params); return response({ code: 200, list: [{ id: '11' }, { id: '12' }] }); },
    async album_new(params: Record<string, unknown>) { log('album_new', params); return response({ code: 200, total: 1, albums: [{ id: '5', name: '合成原发行', artists: [{ name: '合成艺人' }], size: 103, ...(covers ? { picUrl: 'https://p1.music.126.net/synthetic-cover.jpg' } : {}) }] }); },
    async album(params: Record<string, unknown>) { log('album', params); assert.equal(params.id, '5'); return response({ code: 200,
      album: { id: '5', name: '合成原发行', artists: [{ name: '合成艺人' }], size: 103, ...(covers ? { picUrl: 'https://p1.music.126.net/synthetic-cover.jpg' } : {}) }, songs: songs.map(v => song(v.id)) }); },
    async lyric_new(params: Record<string, unknown>) { log('lyric_new', params); return response(lyrics); },
  };
  const fetcher: GatewayFetch = async (_url, init) => {
    if (probeFailure) throw new Error('禁止记录的音频请求正文 https://secret.invalid/');
    const headers = new Headers(init.headers), range = headers.get('range'); assert.ok(range); ranges.push(range);
    assert.equal(headers.get('cookie'), null); assert.equal(headers.get('accept-encoding'), 'identity');
    const match = /^bytes=([0-9]+)-([0-9]+)$/u.exec(range); assert.ok(match);
    const start = Number(match[1]), end = Number(match[2]); assert.ok(end - start < 65536);
    return new Response(Uint8Array.from(audio.subarray(start, end + 1)), { status: 206,
      headers: { 'content-range': `bytes ${start}-${end}/${audio.length}`, 'content-length': String(end - start + 1), etag: probeEtag ?? '"synthetic-exact-source"',
        ...(probeEtag === null ? {} : { date: new Date(clock).toUTCString(), 'last-modified': 'synthetic-private-invalid-date' }) } });
  };
  const client = new NeteaseClient('synthetic-local-credential', api, async () => undefined, { now: () => clock });
  const current = async (scope: MobileNeteaseScope, stage: 'acquire' | 'lease') => {
    stages.push(stage); if (!active || scope.deviceEpoch !== deviceEpoch || scope.ownerEpoch !== 'owner-1' || scope.datasetId !== 'dataset-1') throw new MobileServiceError(409, 'SOURCE_CHANGED');
    if (stage === 'acquire' && scope.accessGeneration !== generation) throw new MobileServiceError(401, 'UNAUTHORIZED');
  };
  const actual = createActualMobileNeteasePorts({ client, serverId: 'server-1', datasetId: 'dataset-1', ownerEpoch: 'owner-1',
    identityKey32: new Uint8Array(32).fill(19), assertCurrent: current, now: () => clock, fetch: fetcher, privateProviderDiagnostics,
    ...(artworkFetch ? { artworkFetch } : covers ? { artworkFetch: async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers); assert.equal(headers.get('cookie'), null); assert.equal(headers.get('authorization'), null);
      return new Response(new Uint8Array([255,216,1,2,3,4,255,217]), { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '8' } });
    } } : {}) });
  const account = await actual.account.current(signal()); assert.ok(account);
  const scope: MobileNeteaseScope = { serverId: 'server-1', datasetId: 'dataset-1', deviceId: 'device-1', deviceEpoch: 1,
    accessGeneration: 1, ownerEpoch: 'owner-1', ...account };
  const provider = createMobileContentProviderService({ provider: actual.provider, cursorKey: new Uint8Array(32).fill(23), now: () => clock,
    assertCurrent: s => actual.assertCurrent(s, 'acquire', signal()) });
  const catalog = createMobileNeteaseCatalogService({ port: actual.catalog, assertCurrent: s => current(s, 'lease'), playbackQualified: () => actual.qualified });
  const sources = createMobileNeteaseSourceService({ account: actual.account, catalog, streams: actual.streams, assertCurrent: current,
    isQualified: () => actual.qualified, nowMs: () => clock });
  t.after(async () => { for (const gate of gates) gate.release.resolve(); await sources.close(); await actual.close(); provider.close();
    assert.equal(sources.resourceSnapshot().live, 0); assert.equal(sources.resourceSnapshot().pending, 0); });
  const daily = () => provider.dispatch({ operation: 'getNeteaseDailyRecommendations', request: request('getNeteaseDailyRecommendations'), scope, signal: signal() });
  return { actual, provider, sources, client, scope, daily, audio, calls, ranges, stages, api, songs,
    advance: (ms: number) => { clock += ms; }, refresh: () => { generation++; }, revoke: () => { deviceEpoch++; },
    accountFailure: (value: BridgeError | null) => { accountFailure = value; },
    probeFailure: () => { probeFailure = true; },
    probeEtag: (value: string) => { probeEtag = value; },
    accountId: (value: string | number) => { accountId = value; }, metadata: (value: string) => { metadataSuffix = value; },
    md5: (value: string) => { md5Suffix = value; }, trial: () => { trial = true; }, permission: (value: number) => { permissionCode = value; },
    streamCalls: () => streamCalls, lyrics: (value: Record<string, unknown>) => { lyrics = value; }, stop: () => { active = false; },
    blockSong: () => { const gate = { started: deferred<void>(), release: deferred<void>() }; gates.push(gate); songGate = gate; return gate; } };
}


test('M24 红心第201首无注册专辑仍完整251项分页且不伪造正整数专辑', async t => {
  const f = await fixture(t, true); f.songs[200]!.al.id = '0';
  const metadata = await f.provider.dispatch({ operation: 'getNeteaseLikedPlaylist', request: request('getNeteaseLikedPlaylist'), scope: f.scope, signal: signal() });
  const query = { playlistId: metadata.reply.body.playlistId, playlistRevision: metadata.reply.body.playlistRevision, accountDomain: f.scope.accountDomain, limit: 50 };
  let cursor: string | null = null; const items: MobileTrack[] = [];
  do { const page: MobileContentSnapshot<'listNeteaseLikedPlaylistTracks'> = await f.provider.dispatch({ operation: 'listNeteaseLikedPlaylistTracks', request: request('listNeteaseLikedPlaylistTracks', { ...query, ...(cursor ? { cursor } : {}) }), scope: f.scope, signal: signal() });
    items.push(...page.reply.body.items); cursor = page.reply.body.nextCursor; await page.beforeSend(); } while (cursor);
  assert.equal(items.length, 251); assert.equal(new Set(items.map(v => v.id)).size, 251);
  const item = items[200]!; assert.match(item.albumId, /^nu:[a-f0-9]{64}$/u); assert.equal(item.sourceItemId, '201');
  assert.equal(item.availability, 'available'); assert.equal(item.audio.codec, 'unknown');
});

function replaceFirstAlbum(f: Awaited<ReturnType<typeof fixture>>, album: unknown, omit = false) {
  const original = f.api.song_detail;
  f.api.song_detail = async params => {
    const result = await original(params);
    for (const song of (result.body as { songs: Record<string, unknown>[] }).songs) if (song.id === '1') {
      if (omit) delete song.al; else song.al = album;
    }
    return result;
  };
}

test('M24 精确未注册标记0/字符串0/null/缺字段及缺专辑记录有真实曲目身份', async t => {
  const samples = [{ id: 0, name: '合成未注册' }, { id: '0', name: '' }, { id: null }, {}, null, undefined];
  for (const [index, album] of samples.entries()) await t.test(String(index), async t => {
    const f = await fixture(t); replaceFirstAlbum(f, album, album === undefined);
    const track = (await f.daily()).reply.body.items[0]!;
    assert.match(track.albumId, /^nu:[a-f0-9]{64}$/u); assert.equal(track.sourceItemId, '1');
    const observed = await f.actual.readObservedTrack(f.scope, track.id, selection(track), signal());
    assert.equal(observed.albumId, track.albumId); assert.equal(observed.audio.codec, 'flac');
    assert.deepEqual(selection(observed), selection(track));
    assert.equal(f.calls.some(v => v.method === 'album'), false);
  });
});

test('M24 无注册专辑不削弱单曲真实FLAC准备/释放且专辑入口不调用上游album', async t => {
  const f = await fixture(t, true); f.songs[0]!.al.id = '0'; const track = (await f.daily()).reply.body.items[0]!;
  const exact = await f.actual.catalog.track(f.scope, selection(track), signal()); assert.equal(exact.track.audio.codec, 'flac');
  const port = f.sources.bind(f.scope), prepared = await port.prepare({ resourceId: randomUUID(), trackId: track.id,
    versionId: track.versionId, contentRevision: track.contentRevision }, signal());
  assert.equal(prepared.sourceAudio?.codec, 'flac'); await port.release(prepared.handle);
  assert.equal(f.sources.resourceSnapshot().live, 0);
  const count = f.calls.filter(v => v.method === 'album').length;
  await assert.rejects(f.actual.catalog.album(f.scope, track.albumId, signal()), safeError('RESOURCE_REVOKED', 403));
  await assert.rejects(f.actual.resolveAlbumTracks(f.scope, track.albumId, { offset: 0, limit: 50 }, signal()), safeError('RESOURCE_REVOKED', 403));
  assert.equal(f.calls.filter(v => v.method === 'album').length, count);
  f.permission(403); const unavailable = (await f.daily()).reply.body.items[0]!; assert.equal(unavailable.availability, 'unavailable');
  await assert.rejects(f.sources.bind(f.scope).prepare({ resourceId: randomUUID(), trackId: track.id,
    versionId: track.versionId, contentRevision: track.contentRevision }, signal()));
});

test('M24 从未注册变为真实专辑会换contentRevision，旧selection被拒且真实专辑保持原na标识', async t => {
  const f = await fixture(t); f.songs[0]!.al.id = '0'; const before = (await f.daily()).reply.body.items[0]!;
  f.songs[0]!.al.id = '5'; const after = (await f.daily()).reply.body.items[0]!;
  assert.match(before.albumId, /^nu:/u); assert.match(after.albumId, /^na:[a-f0-9]{16}:5$/u);
  assert.equal(after.id, before.id); assert.notEqual(after.contentRevision, before.contentRevision);
  await assert.rejects(f.actual.catalog.track(f.scope, selection(before), signal()), safeError('SOURCE_CHANGED', 409));
  assert.equal((await f.actual.catalog.track(f.scope, selection(after), signal())).track.albumId, after.albumId);
});

test('M24 未注册归属按曲目/账号/代际分隔，同范围重复读取稳定且旧scope不能复活', async t => {
  const f = await fixture(t); f.songs[0]!.al.id = '0'; f.songs[1]!.al.id = '0';
  const first = await f.daily(), repeated = await f.daily();
  assert.equal(first.reply.body.items[0]!.albumId, repeated.reply.body.items[0]!.albumId);
  assert.notEqual(first.reply.body.items[0]!.albumId, first.reply.body.items[1]!.albumId);
  f.accountId('701'); f.client.setCredential('synthetic-next-account'); const account = await f.actual.account.current(signal()); assert.ok(account);
  await assert.rejects(f.daily()); const scope = { ...f.scope, ...account };
  const changed = await f.provider.dispatch({ operation: 'getNeteaseDailyRecommendations', request: request('getNeteaseDailyRecommendations'), scope, signal: signal() });
  assert.notEqual(changed.reply.body.items[0]!.albumId, first.reply.body.items[0]!.albumId);
});

test('M24 非法专辑ID/类型不冒充未注册，不跳过坏曲目或给予播放资格', async t => {
  const albums = [-1, 'garbage', [], true, { id: -1 }, { id: '-1' }, { id: '00' }, { id: '' }, { id: '0.0' }, { id: 1.5 }, { id: Number.MAX_SAFE_INTEGER + 1 }, { id: {} }, new Date(0), Object.create({ id: 0 })];
  for (const [index, album] of albums.entries()) await t.test(String(index), async t => {
    const f = await fixture(t); replaceFirstAlbum(f, album);
    await assert.rejects(f.daily()); assert.equal(f.streamCalls(), 0, '坏metadata在申请stream描述符前拒绝');
  });
});
