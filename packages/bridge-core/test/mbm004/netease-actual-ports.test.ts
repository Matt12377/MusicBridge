import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { MOBILE_OPERATION_TABLE, mobileDataSnapshot } from '@music-bridge/contracts';
import type { MobileRequestMap, MobileTrack, MobileTrackSelection } from '@music-bridge/contracts';
import { NeteaseClient } from '../../src/netease/client.js';
import { createActualMobileNeteasePorts } from '../../src/netease/mobile-actual-ports.js';
import { createMobileContentProviderService } from '../../src/mobile/content-provider-service.js';
import { createMobileNeteaseCatalogService } from '../../src/mobile/netease-catalog-service.js';
import { createMobileNeteaseSourceService } from '../../src/mobile/netease-source-service.js';
import { captureMobileContentRequest } from '../../src/mobile/content-protocol.js';
import type { MobileContentOperation } from '../../src/mobile/content-types.js';
import type { MobileNeteaseScope } from '../../src/mobile/netease-source-types.js';
import { MobileServiceError } from '../../src/mobile/types.js';
import type { GatewayFetch } from '../../src/stream/upstream-policy.js';

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
function safeError(code: string, status?: number) { return (value: unknown) => value instanceof MobileServiceError && value.code === code && (status === undefined || value.status === status); }
function flac() {
  const value = Buffer.alloc(150000); value.write('fLaC'); value[4] = 0x80; value.writeUIntBE(34, 5, 3);
  value.writeUInt16BE(4096, 8); value.writeUInt16BE(4096, 10);
  value.writeBigUInt64BE(192000n << 44n | 1n << 41n | 23n << 36n | 192000n, 18);
  for (let n = 42; n < value.length; n++) value[n] = n % 251;
  return value;
}
async function fixture(t: TestContext) {
  const audio = flac(), calls: { method: string; params: Record<string, unknown> }[] = [], ranges: string[] = [], stages: string[] = [];
  const songs = Array.from({ length: 103 }, (_, index) => ({ id: String(index + 1), name: index < 2 ? '同名合成曲' : `合成曲${index + 1}`,
    ar: [{ id: '17', name: '合成艺人' }], al: { id: '5', name: '合成原发行' }, dt: 1500, alia: [index === 1 ? '另一录制' : '原发行'] }));
  let accountId: string | number = '700', generation = 1, deviceEpoch = 1, active = true, clock = 1700000000000;
  let metadataSuffix = '', md5Suffix = 'a', trial = false, permissionCode = 200, streamCalls = 0;
  let lyrics: Record<string, unknown> = { code: 200, lrc: { lyric: '[00:00.000]第一行\n[00:00.500]第二行' }, tlyric: { lyric: '[00:00.000]译文' } };
  let songGate: { started: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> } | null = null;
  const gates: { release: ReturnType<typeof deferred<void>> }[] = [];
  function song(id: string) { const found = songs.find(value => value.id === id); assert.ok(found); return { ...found, name: found.name + metadataSuffix, ar: found.ar.map(a => ({ ...a })), al: { ...found.al }, alia: [...found.alia] }; }
  function response(body: unknown) { return { body, cookie: ['synthetic-sdk-wrapper-cookie'] }; }
  function log(method: string, params: Record<string, unknown>) { calls.push({ method, params: { ...params } }); assert.equal(typeof params.timeout, 'number'); }
  const api = {
    async login_qr_key() { return response({ code: 200 }); }, async login_qr_create() { return response({ code: 200 }); },
    async login_qr_check() { return response({ code: 200 }); }, async login_status() { return response({ code: 200 }); }, async logout() { return response({ code: 200 }); },
    async user_account(params: Record<string, unknown>) { log('user_account', params); return response({ code: 200, account: { id: accountId } }); },
    async song_detail(params: Record<string, unknown>) { log('song_detail', params); assert.equal(typeof params.ids, 'string');
      if (songGate) { const gate = songGate; songGate = null; gate.started.resolve(); await gate.release.promise; }
      return response({ code: 200, songs: String(params.ids).split(',').map(song) }); },
    async song_url_v1(params: Record<string, unknown>) { log('song_url_v1', params); streamCalls++;
      return response({ code: 200, data: [{ id: params.id, code: permissionCode, freeTrialInfo: trial ? { start: 0, end: 1 } : null,
        md5: md5Suffix.repeat(32), size: audio.length, expi: 300, url: `https://mobile-audio.invalid/${String(params.id)}.flac`, level: 'hires', type: 'flac', br: 9216000 }] }); },
    async recommend_songs(params: Record<string, unknown>) { log('recommend_songs', params); return response({ code: 200, data: { dailySongs: songs.slice(0, 2).map(v => ({ id: v.id })) } }); },
    async personal_fm(params: Record<string, unknown>) { log('personal_fm', params); return response({ code: 200, data: [{ id: '1' }] }); },
    async user_playlist(params: Record<string, unknown>) { log('user_playlist', params); return response({ code: 200, more: false, playlist: [{ id: '9', specialType: 10, creator: { userId: accountId } }] }); },
    async playlist_detail(params: Record<string, unknown>) { log('playlist_detail', params); return response({ code: 200, playlist: { id: params.id,
      name: `合成集合${String(params.id)}`, trackCount: 3, updateTime: 7, trackIds: songs.slice(0, 3).map(v => ({ id: v.id })) } }); },
    async personalized(params: Record<string, unknown>) { log('personalized', params); return response({ code: 200, result: [{ id: '9' }, { id: '10' }] }); },
    async toplist(params: Record<string, unknown>) { log('toplist', params); return response({ code: 200, list: [{ id: '11' }, { id: '12' }] }); },
    async album_new(params: Record<string, unknown>) { log('album_new', params); return response({ code: 200, total: 1, albums: [{ id: '5', name: '合成原发行', artists: [{ name: '合成艺人' }], size: 103 }] }); },
    async album(params: Record<string, unknown>) { log('album', params); assert.equal(params.id, '5'); return response({ code: 200,
      album: { id: '5', name: '合成原发行', artists: [{ name: '合成艺人' }], size: 103 }, songs: songs.map(v => song(v.id)) }); },
    async lyric_new(params: Record<string, unknown>) { log('lyric_new', params); return response(lyrics); },
  };
  const fetcher: GatewayFetch = async (_url, init) => {
    const headers = new Headers(init.headers), range = headers.get('range'); assert.ok(range); ranges.push(range);
    assert.equal(headers.get('cookie'), null); assert.equal(headers.get('accept-encoding'), 'identity');
    const match = /^bytes=([0-9]+)-([0-9]+)$/u.exec(range); assert.ok(match);
    const start = Number(match[1]), end = Number(match[2]); assert.ok(end - start < 65536);
    return new Response(Uint8Array.from(audio.subarray(start, end + 1)), { status: 206,
      headers: { 'content-range': `bytes ${start}-${end}/${audio.length}`, 'content-length': String(end - start + 1), etag: '"synthetic-exact-source"' } });
  };
  const client = new NeteaseClient('synthetic-local-credential', api, async () => undefined, { now: () => clock });
  const current = async (scope: MobileNeteaseScope, stage: 'acquire' | 'lease') => {
    stages.push(stage); if (!active || scope.deviceEpoch !== deviceEpoch || scope.ownerEpoch !== 'owner-1' || scope.datasetId !== 'dataset-1') throw new MobileServiceError(409, 'SOURCE_CHANGED');
    if (stage === 'acquire' && scope.accessGeneration !== generation) throw new MobileServiceError(401, 'UNAUTHORIZED');
  };
  const actual = createActualMobileNeteasePorts({ client, serverId: 'server-1', datasetId: 'dataset-1', ownerEpoch: 'owner-1',
    identityKey32: new Uint8Array(32).fill(19), assertCurrent: current, now: () => clock, fetch: fetcher });
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
    accountId: (value: string | number) => { accountId = value; }, metadata: (value: string) => { metadataSuffix = value; },
    md5: (value: string) => { md5Suffix = value; }, trial: () => { trial = true; }, permission: (value: number) => { permissionCode = value; },
    streamCalls: () => streamCalls, lyrics: (value: Record<string, unknown>) => { lyrics = value; }, stop: () => { active = false; },
    blockSong: () => { const gate = { started: deferred<void>(), release: deferred<void>() }; gates.push(gate); songGate = gate; return gate; } };
}

test('原Client仅交出受限SDK正文与真实账户代际，未知参数/不安全整数拒绝且不转发凭据', async t => {
  const f = await fixture(t), account = await f.client.mobileAccount(); assert.equal(account.accountId, '700');
  const raw = await f.client.mobileRead({ operation: 'song-detail', ids: ['1'] });
  assert.deepEqual(Object.keys(raw).sort(), ['providerEpoch', 'response']); assert.equal(JSON.stringify(raw).includes('synthetic-sdk-wrapper-cookie'), false);
  const count = f.calls.length; await assert.rejects(f.client.mobileRead({ operation: 'daily', cookie: 'forged' } as never)); assert.equal(f.calls.length, count);
  f.accountId(Number.MAX_SAFE_INTEGER + 1); await assert.rejects(f.client.mobileAccount());
  f.accountId('90071992547410000000000000000000'); assert.equal((await f.client.mobileAccount()).accountId, '90071992547410000000000000000000');
});
test('八个Provider只读操作独立闭合真实原字段、分页游标与kind，公开不含上游URL或SDKCookie', async t => {
  const f = await fixture(t), daily = await f.daily(); assert.equal(daily.reply.body.items.length, 2);
  assert.equal(daily.reply.body.items[0]!.audio.bitsPerSample, 24); assert.equal(daily.reply.body.items[0]!.audio.sampleRateHz, 192000);
  assert.notEqual(daily.reply.body.items[0]!.id, daily.reply.body.items[1]!.id); assert.equal(daily.reply.body.items[0]!.title, daily.reply.body.items[1]!.title);
  const liked = await f.provider.dispatch({ operation: 'getNeteaseLikedPlaylist', request: request('getNeteaseLikedPlaylist'), scope: f.scope, signal: signal() });
  const query = { playlistId: liked.reply.body.playlistId, playlistRevision: liked.reply.body.playlistRevision, accountDomain: f.scope.accountDomain, limit: 2 };
  const first = await f.provider.dispatch({ operation: 'listNeteaseLikedPlaylistTracks', request: request('listNeteaseLikedPlaylistTracks', query), scope: f.scope, signal: signal() });
  assert.equal(first.reply.body.items.length, 2); assert.equal(typeof first.reply.body.nextCursor, 'string');
  const second = await f.provider.dispatch({ operation: 'listNeteaseLikedPlaylistTracks', request: request('listNeteaseLikedPlaylistTracks', { ...query, cursor: first.reply.body.nextCursor! }), scope: f.scope, signal: signal() });
  assert.equal(second.reply.body.items.length, 1); assert.equal(second.reply.body.nextCursor, null); assert.equal(new Set([...first.reply.body.items, ...second.reply.body.items].map(v => v.id)).size, 3);
  await assert.rejects(f.provider.dispatch({ operation: 'listNeteaseLikedPlaylistTracks', request: request('listNeteaseLikedPlaylistTracks', { ...query, cursor: first.reply.body.nextCursor! }), scope: { ...f.scope, deviceId: 'device-2' }, signal: signal() }), safeError('CURSOR_INVALID'));
  const recommended = await f.provider.dispatch({ operation: 'listNeteaseRecommendedPlaylists', request: request('listNeteaseRecommendedPlaylists'), scope: f.scope, signal: signal() });
  const charts = await f.provider.dispatch({ operation: 'listNeteaseCharts', request: request('listNeteaseCharts'), scope: f.scope, signal: signal() });
  assert.ok(recommended.reply.body.items.every(v => v.kind === 'playlist')); assert.ok(charts.reply.body.items.every(v => v.kind === 'chart'));
  const collection = charts.reply.body.items[0]!;
  const tracks = await f.provider.dispatch({ operation: 'getNeteaseDiscoveryCollectionTracks', request: request('getNeteaseDiscoveryCollectionTracks', { kind: 'chart', accountDomain: f.scope.accountDomain, collectionRevision: collection.collectionRevision, limit: 2 }, { collectionId: collection.id }), scope: f.scope, signal: signal() });
  assert.equal(tracks.reply.body.collection.id, collection.id); assert.equal(tracks.reply.body.items.length, 2);
  const albums = await f.provider.dispatch({ operation: 'listNeteaseNewAlbums', request: request('listNeteaseNewAlbums'), scope: f.scope, signal: signal() }); assert.equal(albums.reply.body.items[0]!.trackCount, 103);
  const fm = await f.provider.dispatch({ operation: 'getNeteasePersonalFM', request: request('getNeteasePersonalFM'), scope: f.scope, signal: signal() }); assert.equal(fm.reply.body.items.length, 1);
  const publicText = JSON.stringify([daily.reply, liked.reply, first.reply, second.reply, recommended.reply, charts.reply, tracks.reply, albums.reply, fm.reply]);
  assert.equal(publicText.includes('https://'), false); assert.equal(publicText.includes('synthetic-local-credential'), false); assert.equal(publicText.includes('synthetic-sdk-wrapper-cookie'), false);
});
test('真实完整专辑103曲按原身份分页而不截断，metadata变化使旧album revision与selection拒绝', async t => {
  const f = await fixture(t), track = (await f.daily()).reply.body.items[0]!;
  const first = await f.actual.resolveAlbumTracks(f.scope, track.albumId, { offset: 0, limit: 100 }, signal());
  const last = await f.actual.resolveAlbumTracks(f.scope, track.albumId, { offset: 100, limit: 100 }, signal());
  assert.equal(first.total, 103); assert.equal(first.items.length, 100); assert.equal(last.items.length, 3); assert.equal(first.revision, last.revision);
  assert.equal(new Set([...first.items, ...last.items].map(v => v.id)).size, 103); assert.ok(first.items.every(v => v.albumId === track.albumId));
  await f.actual.assertAlbumRevision(f.scope, track.albumId, first.revision, signal()); f.metadata('修订');
  await assert.rejects(f.actual.assertAlbumRevision(f.scope, track.albumId, first.revision, signal()), safeError('SOURCE_CHANGED', 409));
  await assert.rejects(f.actual.catalog.track(f.scope, selection(track), signal()), safeError('SOURCE_CHANGED', 409));
});
test('实际catalog/source/HTTP组合保持FLAC24/192，普通refresh不撤原lease且跨设备/epoch拒绝', async t => {
  const f = await fixture(t), track = (await f.daily()).reply.body.items[0]!, selected = selection(track), port = f.sources.bind(f.scope);
  const prepared = await port.prepare({ resourceId: randomUUID(), trackId: track.id, versionId: track.versionId, contentRevision: track.contentRevision }, signal());
  assert.ok(!('preparing' in prepared)); assert.deepEqual(captured(prepared.sourceAudio), captured(track.audio)); assert.deepEqual(captured(prepared.actualAudio), captured(track.audio));
  assert.equal(prepared.processing.mode, 'direct'); assert.equal(prepared.seekable, true); assert.equal(prepared.size, f.audio.length);
  f.refresh(); await port.verify(prepared.handle); f.advance(1000);
  const readId = randomUUID(), [, block] = await Promise.all([port.renew(prepared.handle), port.read(prepared.handle, readId, 43, 65536, signal())]);
  assert.deepEqual(block, Uint8Array.from(f.audio.subarray(43, 65579)));
  await assert.rejects(f.provider.dispatch({ operation: 'getNeteaseDailyRecommendations', request: request('getNeteaseDailyRecommendations'), scope: f.scope, signal: signal() }), safeError('UNAUTHORIZED', 401));
  await assert.rejects(f.sources.bind({ ...f.scope, deviceId: 'device-2' }).verify(prepared.handle));
  await assert.rejects(f.sources.bind({ ...f.scope, deviceEpoch: 2 }).verify(prepared.handle));
  assert.deepEqual(captured((await f.actual.catalog.track(f.scope, selected, signal())).track.audio), captured(track.audio));
  await port.closeRead(prepared.handle, readId); await port.release(prepared.handle); assert.equal(f.sources.resourceSnapshot().live, 0);
});
test('完整歌词超过旧500行仍保全，4096UTF8边界与末行变化进入整份revision', async t => {
  const f = await fixture(t), track = (await f.daily()).reply.body.items[0]!, selected = selection(track);
  const complete = Array.from({ length: 601 }, (_, i) => `[${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000]第${i}行`).join('\n');
  f.lyrics({ code: 200, lrc: { lyric: complete } }); const first = await f.actual.resolveLyrics(f.scope, selected, signal());
  assert.equal(first.body.status, 'ready'); assert.equal(first.body.lines.length, 601); assert.equal(first.body.lines[600]!.text, '第600行');
  f.lyrics({ code: 200, lrc: { lyric: complete.replace('第600行', '末行修订') } }); const next = await f.actual.resolveLyrics(f.scope, selected, signal());
  assert.equal(next.body.status, 'ready'); assert.notEqual(next.body.lyricRevision, first.body.lyricRevision);
  const longText = '字'.repeat(1365); f.lyrics({ code: 200, lrc: { lyric: `[00:00.000]${longText}` }, tlyric: { lyric: '[00:00.000]完整翻译' } });
  const long = await f.actual.resolveLyrics(f.scope, selected, signal()); assert.equal(long.body.lines[0]!.text, longText); assert.equal(long.body.lines[0]!.secondaryText, '完整翻译');
  f.lyrics({ code: 200, lrc: { lyric: '完整纯文本\n第二行' } }); const plain = await f.actual.resolveLyrics(f.scope, selected, signal());
  assert.equal(plain.body.synchronized, false); assert.deepEqual(plain.body.lines.map(v => v.startMs), [null, null]);
});
test('歌词坏行/2001行/单行或整份越预算安全失败，仅真实缺失和纯音乐标志返回对应状态', async t => {
  const f = await fixture(t), track = (await f.daily()).reply.body.items[0]!, selected = selection(track);
  for (const lyric of ['[00:61.000]坏秒数', '[00:00.000]正常\n[broken]坏行', `[00:00.000]${'字'.repeat(1366)}`,
    Array.from({ length: 2001 }, () => '[00:00.000]行').join('\n'), '字'.repeat(700000)]) {
    f.lyrics({ code: 200, lrc: { lyric } }); await assert.rejects(f.actual.resolveLyrics(f.scope, selected, signal()), safeError('BUSY', 503));
  }
  f.lyrics({ code: 200 }); await assert.rejects(f.actual.resolveLyrics(f.scope, selected, signal()), safeError('BUSY', 503));
  f.lyrics({ code: 200, uncollected: true }); assert.equal((await f.actual.resolveLyrics(f.scope, selected, signal())).body.status, 'missing');
  f.lyrics({ code: 200, nolyric: true }); assert.equal((await f.actual.resolveLyrics(f.scope, selected, signal())).body.status, 'instrumental');
  f.lyrics({ code: 301, lrc: { lyric: '' } }); await assert.rejects(f.actual.resolveLyrics(f.scope, selected, signal()), safeError('UNAUTHORIZED', 401));
});
test('原试用/权限失败和实际版本变化不伪造available，FLAC实际样本时长保留并拒绝大偏差', async t => {
  const f = await fixture(t), track = (await f.daily()).reply.body.items[0]!; assert.equal(track.durationMs, 1000);
  f.md5('b'); await assert.rejects(f.actual.catalog.track(f.scope, selection(track), signal()), safeError('SOURCE_CHANGED', 409));
  const g = await fixture(t); g.trial(); await assert.rejects(g.daily(), safeError('RESOURCE_REVOKED', 403));
  const h = await fixture(t); h.permission(403); await assert.rejects(h.daily(), safeError('RESOURCE_REVOKED', 403));
  const i = await fixture(t); i.songs[0]!.dt = 4000; await assert.rejects(i.daily(), safeError('SOURCE_CHANGED', 409));
});
test('原SDK忽略cancel的迟到工作仍被quiet跟踪，关闭不提前回报或发布迟到metadata', async t => {
  const f = await fixture(t), gate = f.blockSong(), controller = new AbortController();
  const requestFlight = f.actual.provider.read({ operation: 'getNeteaseDailyRecommendations', scope: f.scope,
    request: request('getNeteaseDailyRecommendations'), offset: 0, limit: 20, expectedRevision: null, signal: controller.signal });
  const refused = assert.rejects(requestFlight); await gate.started.promise; controller.abort(); await refused;
  let quiet = false; const closing = f.actual.close().then(() => { quiet = true; });
  await new Promise<void>(r => setImmediate(r)); assert.equal(quiet, false); gate.release.resolve(); await closing; assert.equal(quiet, true);
  assert.equal(f.actual.qualified, false); assert.equal(f.streamCalls(), 0);
});
test('当前账户和deviceepoch撤换封原metadata与网络lease，原Provider关闭后callback与cursor不再可用', async t => {
  const f = await fixture(t), first = await f.daily(), track = first.reply.body.items[0]!;
  const opened = await f.actual.streams.open({ scope: f.scope, resourceId: randomUUID(), selection: selection(track) }, signal());
  const events: { previousProviderEpoch: string; nextProviderEpoch: string }[] = []; const unlisten = f.actual.onAccountInvalidated(event => { events.push(event); });
  f.accountId('701'); f.client.setCredential('synthetic-replacement-credential'); assert.equal(events.length, 1);
  assert.notEqual(events[0]!.previousProviderEpoch, events[0]!.nextProviderEpoch); await assert.rejects(opened.verify(signal())); await opened.release();
  await assert.rejects(first.beforeSend()); await assert.rejects(f.actual.catalog.track(f.scope, selection(track), signal()));
  const account = await f.actual.account.current(signal()); assert.ok(account); assert.notEqual(account.accountDomain, f.scope.accountDomain);
  const nextScope = { ...f.scope, ...account }; f.revoke(); await assert.rejects(f.actual.resolveTrackId(nextScope, track.id, signal()));
  unlisten(); f.provider.close(); await assert.rejects(f.provider.dispatch({ operation: 'getNeteaseDailyRecommendations', request: request('getNeteaseDailyRecommendations'), scope: nextScope, signal: signal() }), safeError('BUSY', 503));
  // 在账户和设备仍有效的独立实例上核关闭，不能靠先前撤权掩盖旧发送回调或游标失效。
  const g = await fixture(t), page = await g.provider.dispatch({ operation: 'listNeteaseCharts',
    request: request('listNeteaseCharts', { limit: 1 }), scope: g.scope, signal: signal() });
  const cursor = page.reply.body.nextCursor; assert.equal(typeof cursor, 'string'); await page.beforeSend();
  g.provider.close(); await assert.rejects(page.beforeSend(), safeError('BUSY', 503));
  await assert.rejects(g.provider.dispatch({ operation: 'listNeteaseCharts', request: request('listNeteaseCharts', { limit: 1, cursor: cursor! }),
    scope: g.scope, signal: signal() }), safeError('BUSY', 503));
});
