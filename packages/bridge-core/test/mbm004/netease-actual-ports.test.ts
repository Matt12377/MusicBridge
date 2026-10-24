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
import type { MobileContentOperation } from '../../src/mobile/content-types.js';
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
  const songs = Array.from({ length: 103 }, (_, index) => ({ id: String(index + 1), name: index < 2 ? '同名合成曲' : `合成曲${index + 1}`,
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
      name: `合成集合${String(params.id)}`, ...(covers ? { coverImgUrl: 'https://p1.music.126.net/synthetic-cover.jpg' } : {}), trackCount: 3, updateTime: 7, trackIds: songs.slice(0, 3).map(v => ({ id: v.id })) } }); },
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

test('R17_TRACK_ALIAS 实际SDK到正式track RPC仅换九主机保持完整指纹，路径元数据音频仍严格拒绝', async t => {
  const f = await fixture(t, true), listed = (await f.daily()).reply.body.items[0]!;
  const rpc = createMobileContentRpcPort({ initialize: async () => {}, invalidateDevice: async () => {},
    resolveScope: async principal => ({ ...f.scope, ...principal }),
    assertScope: (scope, stage, owned) => f.actual.assertCurrent(captureMobileNeteaseScope(scope), stage, owned),
    content: { async dispatch() { throw new Error('此夹具只用正式track通道'); } },
    source: async () => { throw new Error('曲目重核不准备播放资源'); },
    readTrack: (scope, id, expected, owned) => f.actual.readObservedTrack(captureMobileNeteaseScope(scope), id, expected, owned),
  });
  t.after(() => rpc.close());
  const base = () => ({ type: 'mobile-content-core-request' as const, id: randomUUID() });
  const initialized = await rpc.request({ ...base(), action: 'initialize', serverId: f.scope.serverId, datasetId: f.scope.datasetId,
    key: new Uint8Array(32).fill(1) }, signal());
  assert.ok(initialized.action === 'initialize' && 'ok' in initialized && initialized.ok);
  const original = await rpc.request({ ...base(), action: 'track', operation: 'read', scope: f.scope,
    trackId: listed.id, expectedSelection: null, expectedFingerprint: null }, signal());
  assert.ok(original.action === 'track' && original.kind === 'track');
  assert.equal(original.track.audio.codec, 'flac'); assert.ok(original.track.artworkId);
  const revalidate = () => rpc.request({ ...base(), action: 'track', operation: 'revalidate', scope: f.scope,
    trackId: listed.id, expectedSelection: selection(original.track), expectedFingerprint: original.fingerprint }, signal());
  const picture = 'https://p1.music.126.net/synthetic-cover.jpg';
  for (let host = 1; host <= 9; host++) {
    f.songs[0]!.al.picUrl = picture.replace('p1.', `p${host}.`);
    const result = await revalidate(); assert.ok(result.action === 'track' && result.kind === 'track-validated');
    assert.equal(result.fingerprint, original.fingerprint);
  }
  const rejected = async () => { const result = await revalidate();
    assert.ok('kind' in result && result.kind === 'error'); assert.equal(result.status, 409); assert.equal(result.code, 'SOURCE_CHANGED'); };
  f.songs[0]!.al.picUrl = picture.replace('p1.', 'p9.') + '?changed=1'; await rejected();
  f.songs[0]!.al.picUrl = picture; f.metadata('真实元数据改变'); await rejected();
  f.metadata(''); f.md5('b'); await rejected(); f.md5('a');
  // 真正改变受控FLAC STREAMINFO位深；原md5/selection不变时仍由完整事实指纹挡住。
  f.audio.writeBigUInt64BE(192000n << 44n | 1n << 41n | 15n << 36n | 192000n, 18); await rejected();
  assert.equal(f.sources.resourceSnapshot().live, 0); assert.equal(f.sources.resourceSnapshot().pending, 0);
});

test('R14_VENDOR_DIGEST 实际API正式摘要不依赖私有开关，匹配才发布真实音频事实而不外泄摘要', async t => {
  for (const [enabled, tag, compatible, relation] of [
    [true, 'A'.repeat(32), true, null],
    [true, 'b'.repeat(32), false, 'bare32hex.mismatch'],
    [true, 'synthetic-private-unquoted', false, 'unquotedother.not-comparable'],
    [false, 'a'.repeat(32), true, null],
  ] as const) await t.test(`${enabled}/${relation ?? 'disabled'}`, async child => {
    const f = await fixture(child, false, enabled), listed = (await f.daily()).reply.body.items[0]!;
    const publicBefore = JSON.stringify(listed); f.probeEtag(tag);
    const lines: string[] = [], context = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, signal(), line => lines.push(line));
    assert.ok(context); context.privateContentDiagnostic = true;
    try { await withMobileCapabilityContext(context, async () => {
      if (compatible) {
        const exact = await f.actual.catalog.track(f.scope, selection(listed), signal());
        assert.equal(exact.track.audio.codec, 'flac'); assert.equal(exact.track.audio.bitsPerSample, 24);
        assert.deepEqual(selection(exact.track), selection(listed));
        assert.doesNotMatch(JSON.stringify(exact.track), /contentDigest|diagnosticMediaMd5|md5|https?:|synthetic-local-credential/u);
      } else await assert.rejects(f.actual.catalog.track(f.scope, selection(listed), signal()), safeError('UNSUPPORTED_FORMAT', 409));
    }); }
    finally { closeMobileCapabilityContext(context); }
    const records = lines.map(line => JSON.parse(line.slice(MOBILE_CAPABILITY_TRACE_PREFIX.length)) as Record<string, unknown>);
    const notes = records.filter(row => String(row.stage).startsWith('provider.audio-probe.validator.'));
    assert.deepEqual(notes.map(row => row.stage), relation ? [`provider.audio-probe.validator.${relation}`] : []);
    if (relation) {
      const stage = relation === 'bare32hex.mismatch' ? 'provider.audio-probe.reject.etag-invalid.bare32hex' : 'provider.audio-probe.reject.etag-date.invalid.last-modified.valid.other';
      assert.ok(records.some(row => row.stage === stage && row.code === 'UNSUPPORTED_FORMAT'));
      assert.equal(notes[0]!.phase, 'cache'); assert.equal(notes[0]!.initState, 'none'); assert.equal(notes[0]!.code, 'OK');
      assert.equal(Object.keys(notes[0]!).length, 15);
    }
    assert.equal(compatible ? f.ranges.length >= 3 : f.ranges.length === 1, true); assert.equal(JSON.stringify(listed), publicBefore);
    assert.equal(listed.audio.codec, 'unknown'); assert.equal(f.sources.resourceSnapshot().live, 0);
    assert.doesNotMatch(lines.join(''), /synthetic|credential|cookie|https?:|GMT|headers|message|stack/u);
    assert.equal(lines.join('').includes('a'.repeat(32)), false); assert.equal(lines.join('').includes(tag), false);
    assert.doesNotMatch(publicBefore, /contentDigest|diagnosticMediaMd5|md5|https?:|synthetic-local-credential/u);
  });
});

test('喜欢歌单摘要保留当前集合签发的封面标识并可读取同一图片', async t => {
  const f = await fixture(t, true);
  const liked = await f.provider.dispatch({ operation: 'getNeteaseLikedPlaylist', request: request('getNeteaseLikedPlaylist'), scope: f.scope, signal: signal() });
  assert.equal(typeof liked.reply.body.artworkId, 'string');
  const recommended = await f.provider.dispatch({ operation: 'listNeteaseRecommendedPlaylists', request: request('listNeteaseRecommendedPlaylists'), scope: f.scope, signal: signal() });
  const sameCollection = recommended.reply.body.items.find(item => item.id === liked.reply.body.playlistId);
  assert.ok(sameCollection);
  assert.equal(liked.reply.body.artworkId, sameCollection.artworkId);
  await liked.beforeSend();
  const image = await f.actual.readArtwork(f.scope, liked.reply.body.artworkId!, signal());
  assert.equal(image.contentType, 'image/jpeg');
  assert.equal(image.bytes.byteLength, 8);
  assert.doesNotMatch(JSON.stringify(liked.reply.body), /https?:|synthetic-local-credential|synthetic-sdk-wrapper-cookie/u);
});

test('喜欢歌单没有来源封面时继续省略可选标识，不构造占位身份', async t => {
  const f = await fixture(t);
  const liked = await f.provider.dispatch({ operation: 'getNeteaseLikedPlaylist', request: request('getNeteaseLikedPlaylist'), scope: f.scope, signal: signal() });
  assert.equal(Object.hasOwn(liked.reply.body, 'artworkId'), false);
  await liked.beforeSend();
});

test('手机封面超时收口：原10秒后真实连接close未到时cancel不得提前quiet', async t => {
  for (const operation of ['read','revalidate'] as const) await t.test(operation, async child => {
    const entered=deferred<void>();let releaseClose=()=>{},destroyed=false,hold=false;
    const transport=createMobileArtworkFetch({resolver:()=>({async resolve4(){return['8.8.8.8'];},async resolve6(){return[];},cancel(){}}),
      request:()=>{
        const emitter=new EventEmitter();let closed=false;
        releaseClose=()=>{if(!closed){closed=true;emitter.emit('close');}};
        const request=Object.assign(emitter,{maxHeadersCount:0,
          end():EventEmitter{entered.resolve();return emitter;},
          destroy():EventEmitter{destroyed=true;return emitter;},
        });return request as unknown as ClientRequest;
      }});
    const f=await fixture(child,true,false,(url,init)=>hold?transport(url,init):Promise.resolve(new Response(
      new Uint8Array([255,216,1,2,3,4,255,217]),{headers:{'Content-Type':'image/jpeg','Content-Length':'8'}})));
    const track=(await f.daily()).reply.body.items[0]!;assert.ok(typeof track.artworkId==='string');
    const seed=await f.actual.readArtwork(f.scope,track.artworkId,signal());
    const expected=captureMobileContentScope(f.scope);
    const rpc=createMobileContentRpcPort({initialize:async()=>{},invalidateDevice:async()=>{},resolveScope:async principal=>({...f.scope,...principal}),
      assertScope:current=>{assert.deepEqual(current,expected);},content:{async dispatch(){throw new Error('此夹具不读取JSON内容');}},
      source:async()=>{throw new Error('此夹具不读取音乐');},
      readArtwork:(scope,id,owned)=>f.actual.readArtwork(captureMobileNeteaseScope(scope),id,owned),
      assertArtwork:(scope,id,owned)=>f.actual.assertArtwork(captureMobileNeteaseScope(scope),id,owned),
    });
    const base=()=>({type:'mobile-content-core-request' as const,id:randomUUID()});
    await rpc.request({...base(),action:'initialize',serverId:f.scope.serverId,datasetId:f.scope.datasetId,key:new Uint8Array(32).fill(1)},signal());
    hold=true;child.mock.timers.enable({apis:['setTimeout']});
    const original={...base(),action:'artwork' as const,operation,scope:f.scope,artworkId:track.artworkId,expectedRevision:operation==='read'?null:seed.revision};
    let cancelFinished=false;let cancelling:ReturnType<typeof rpc.request>|undefined;
    const reading=rpc.request(original,signal());
    try{
      await entered.promise;
      child.mock.timers.tick(10_000); // 产品期限仍注册10000ms，不缩短期限制造负例。
      await reading;assert.equal(destroyed,true);
      cancelling=rpc.request({...base(),action:'cancel',requestId:original.id,snapshotId:null,scope:f.scope},signal())
        .then(reply=>{cancelFinished=true;return reply;});
      for(let index=0;index<80;index++)await Promise.resolve();
      assert.equal(cancelFinished,false,'真实close未发生，不能确认quiet');
      releaseClose();const cancelled=await cancelling;
      assert.ok(cancelled.action==='cancel'&&cancelled.kind==='cancelled');assert.equal(cancelled.quiet,true);
    }finally{
      releaseClose();await reading;if(cancelling)await cancelling;child.mock.timers.reset();await rpc.close();
    }
  });
});

test('手机网易云封面：实际adapter投影专辑歌曲与集合ID，按原身份取图且不输出URL', async t => {
  const f = await fixture(t, true), daily = await f.daily(), track = daily.reply.body.items[0]!;
  assert.ok(track.artworkId?.startsWith('naw:'));
  const albums = await f.provider.dispatch({ operation: 'listNeteaseNewAlbums', request: request('listNeteaseNewAlbums'), scope: f.scope, signal: signal() });
  assert.ok(albums.reply.body.items[0]?.artworkId?.startsWith('naw:'));
  const collections = await f.provider.dispatch({ operation: 'listNeteaseRecommendedPlaylists', request: request('listNeteaseRecommendedPlaylists'), scope: f.scope, signal: signal() });
  const collectionId = collections.reply.body.items[0]?.artworkId; assert.ok(collectionId?.startsWith('naw:'));
  assert.doesNotMatch(JSON.stringify([daily.reply.body, albums.reply.body, collections.reply.body]), /https?:|music\.126\.net|cookie/iu);
  for (const id of [track.artworkId, albums.reply.body.items[0]?.artworkId, collectionId]) {
    assert.ok(typeof id === 'string' && id.startsWith('naw:'), '合成正例必须给出真实封面ID');
    const image = await f.actual.readArtwork(f.scope, id, signal()); assert.equal(image.contentType, 'image/jpeg');
    assert.equal(image.bytes.length, 8); assert.equal(await f.actual.assertArtwork(f.scope, id, signal()), image.revision);
  }
  f.client.setCredential('synthetic-new-artwork-account');
  const account = await f.actual.account.current(signal()); assert.ok(account);
  await assert.rejects(f.actual.readArtwork({ ...f.scope, ...account }, track.artworkId!, signal()), safeError('SOURCE_CHANGED', 409));
});

test('手机网易云登录：fresh临时503不清账户或图片资格，明确失效清旧网络lease及旧图', async t => {
  const f = await fixture(t, true), track = (await f.daily()).reply.body.items[0]!;
  const opened = await f.actual.streams.open({ scope: f.scope, resourceId: randomUUID(), selection: selection(track) }, signal());
  try {
    f.advance(11_000); f.accountFailure(new BridgeError('NETEASE_REQUEST_FAILED', '合成临时失败'));
    await assert.rejects(f.actual.account.current(signal()), safeError('BUSY', 503));
    f.accountFailure(null); assert.deepEqual(await f.actual.account.current(signal()), { accountDomain: f.scope.accountDomain, providerEpoch: f.scope.providerEpoch });
    await opened.verify(signal()); await f.actual.readArtwork(f.scope, track.artworkId!, signal());
    f.advance(11_000); f.accountFailure(new BridgeError('AUTH_EXPIRED', '合成登录到期'));
    assert.equal(await f.actual.account.current(signal()), null);
    await assert.rejects(opened.verify(signal()));
    await assert.rejects(f.actual.readArtwork(f.scope, track.artworkId!, signal()), safeError('RESOURCE_REVOKED', 403));
    f.accountFailure(null); f.advance(11_000); assert.ok(await f.actual.account.current(signal()));
    await assert.rejects(f.actual.readArtwork(f.scope, track.artworkId!, signal()), safeError('SOURCE_CHANGED', 409));
  } finally { await opened.release(); }
});

test('私有账号原因诊断：默认关闭，开启仅8次闭集原因且不含账号正文或原错误文本', async t => {
  const off = await fixture(t); off.advance(11_000); off.accountFailure(new BridgeError('NETEASE_REQUEST_FAILED', '不得记录的原始错误'));
  const absent: string[] = [], offContext = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, signal(), line => absent.push(line));
  await withMobileCapabilityContext(offContext, () => assert.rejects(off.actual.account.current(signal())));
  closeMobileCapabilityContext(offContext); assert.deepEqual(absent, []);
  const f = await fixture(t, false, true), lines: string[] = [];
  const context = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, signal(), line => lines.push(line));
  try { await withMobileCapabilityContext(context, async () => {
    f.advance(11_000); f.accountFailure(new BridgeError('NETEASE_REQUEST_FAILED', '禁止的原消息 https://secret.invalid/', { details: { reason: 'request-timeout' } }));
    await assert.rejects(f.actual.account.current(signal()));
    f.accountFailure(null); f.accountId(Number.MAX_SAFE_INTEGER + 1); await assert.rejects(f.actual.account.current(signal()));
    f.accountId('700'); f.accountFailure(new BridgeError('NETEASE_REQUEST_FAILED', '禁止的cookie正文')); await assert.rejects(f.actual.account.current(signal()));
    f.accountFailure(new BridgeError('AUTH_EXPIRED', '禁止的登录正文')); assert.equal(await f.actual.account.current(signal()), null);
    f.client.setCredential(''); assert.equal(await f.actual.account.current(signal()), null);
    f.client.setCredential('synthetic-private-diagnostic-credential'); f.accountFailure(null); assert.ok(await f.actual.account.current(signal()));
    f.accountFailure(new BridgeError('NETEASE_REQUEST_FAILED', '禁止的超时消息', { details: { reason: 'request-timeout' } }));
    for (let i = 0; i < 4; i++) { f.advance(11_000); await assert.rejects(f.actual.account.current(signal())); }
  }); } finally { closeMobileCapabilityContext(context); }
  const records = lines.map(line => JSON.parse(line.slice(MOBILE_CAPABILITY_TRACE_PREFIX.length)) as { stage: string; phase: string });
  assert.equal(records.filter(row => row.phase === 'ok' || row.phase === 'reject').length, 8);
  for (const reason of ['ready', 'auth-expired', 'not-configured', 'timeout', 'shape', 'unknown'])
    assert.ok(records.some(row => row.stage === `provider.account.${reason}`));
  assert.doesNotMatch(lines.join(''), /secret\.invalid|禁止|不得|credential|cookie正文|accountId/iu);
});

test('私有发现首错区分feed、song-detail、stream、audio probe与DTO映射，不重放或改写原拒绝', async t => {
  for (const phase of ['feed', 'song-detail', 'stream', 'audio-probe', 'mapping'] as const) await t.test(phase, async child => {
    const f = await fixture(child, false, true), lines: string[] = [];
    const refusal = async () => { throw new BridgeError('NETEASE_REQUEST_FAILED', '禁止记录的上游正文 https://secret.invalid/'); };
    if (phase === 'feed') f.api.recommend_songs = refusal;
    if (phase === 'song-detail') f.api.song_detail = refusal;
    if (phase === 'stream') f.api.song_url_v1 = refusal;
    const observedTrack = phase === 'audio-probe' ? (await f.daily()).reply.body.items[0]! : null;
    if (phase === 'audio-probe') f.probeFailure();
    if (phase === 'mapping') f.songs[0]!.dt = 0;
    const context = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, signal(), line => lines.push(line));
    const read = () => observedTrack ? f.actual.catalog.track(f.scope, selection(observedTrack), signal()) : f.daily();
    try { await withMobileCapabilityContext(context, async () => { await assert.rejects(read()); await assert.rejects(read()); }); }
    finally { closeMobileCapabilityContext(context); }
    const records = lines.map(line => JSON.parse(line.slice(MOBILE_CAPABILITY_TRACE_PREFIX.length)) as { stage: string; code: string });
    assert.equal(records.filter(row => row.stage.startsWith('provider.content.')).length, 1);
    const originalCode=phase==='audio-probe'?'UNKNOWN':phase==='mapping'?'SOURCE_CHANGED':'NETEASE_REQUEST_FAILED';
    const expectedStage=phase==='mapping'?'provider.content.mapping.duration':`provider.content.${phase}`;
    assert.ok(records.some(row => row.stage === expectedStage && row.code===originalCode));
    assert.doesNotMatch(lines.join(''), /secret\.invalid|禁止记录|message|stack|cookie|credential/iu);
  });
});

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
  assert.deepEqual(captured(daily.reply.body.items[0]!.audio), captured({ codec: 'unknown', container: 'unknown' }));
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
  const resolved = await f.actual.catalog.track(f.scope, selected, signal());
  assert.deepEqual(selection(resolved.track), selected); assert.equal(resolved.track.audio.sampleRateHz, 192000); assert.equal(resolved.track.audio.bitsPerSample, 24);
  const prepared = await port.prepare({ resourceId: randomUUID(), trackId: track.id, versionId: track.versionId, contentRevision: track.contentRevision }, signal());
  assert.ok(!('preparing' in prepared)); assert.deepEqual(captured(prepared.sourceAudio), captured(resolved.track.audio)); assert.deepEqual(captured(prepared.actualAudio), captured(resolved.track.audio));
  assert.equal(prepared.processing.mode, 'direct'); assert.equal(prepared.seekable, true); assert.equal(prepared.size, f.audio.length);
  f.refresh(); await port.verify(prepared.handle); f.advance(1000);
  const readId = randomUUID(), [, block] = await Promise.all([port.renew(prepared.handle), port.read(prepared.handle, readId, 43, 65536, signal())]);
  assert.deepEqual(block, Uint8Array.from(f.audio.subarray(43, 65579)));
  await assert.rejects(f.provider.dispatch({ operation: 'getNeteaseDailyRecommendations', request: request('getNeteaseDailyRecommendations'), scope: f.scope, signal: signal() }), safeError('UNAUTHORIZED', 401));
  await assert.rejects(f.sources.bind({ ...f.scope, deviceId: 'device-2' }).verify(prepared.handle));
  await assert.rejects(f.sources.bind({ ...f.scope, deviceEpoch: 2 }).verify(prepared.handle));
  assert.deepEqual(captured((await f.actual.catalog.track(f.scope, selected, signal())).track.audio), captured(resolved.track.audio));
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
  f.lyrics({ code: 301, lrc: { lyric: '' } }); await assert.rejects(f.actual.resolveLyrics(f.scope, selected, signal()), safeError('RESOURCE_REVOKED', 403));
});
test('原试用/权限失败和实际版本变化不伪造available，FLAC实际样本时长保留并拒绝大偏差', async t => {
  const f = await fixture(t), track = (await f.daily()).reply.body.items[0]!; assert.equal(track.durationMs, 1500);
  assert.equal((await f.actual.catalog.track(f.scope, selection(track), signal())).track.durationMs, 1000);
  f.md5('b'); await assert.rejects(f.actual.catalog.track(f.scope, selection(track), signal()), safeError('SOURCE_CHANGED', 409));
  const g = await fixture(t); g.trial(); const trial = (await g.daily()).reply.body.items[0]!; assert.equal(trial.availability, 'unavailable');
  await assert.rejects(g.actual.catalog.track(g.scope, selection(trial), signal()), safeError('RESOURCE_REVOKED', 403));
  const h = await fixture(t); h.permission(403); const denied = (await h.daily()).reply.body.items[0]!; assert.equal(denied.availability, 'unavailable');
  await assert.rejects(h.actual.catalog.track(h.scope, selection(denied), signal()), safeError('RESOURCE_REVOKED', 403));
  const i = await fixture(t); i.songs[0]!.dt = 4000; const drift = (await i.daily()).reply.body.items[0]!;
  await assert.rejects(i.actual.catalog.track(i.scope, selection(drift), signal()), safeError('SOURCE_CHANGED', 409));
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

test('r7: 目录列表只读真实批量媒体描述，不依赖HTTP音频资格且播放仍必须探测', async t => {
  const f = await fixture(t); f.probeFailure();
  const daily = await f.daily(), tracks = daily.reply.body.items;
  assert.equal(tracks.length, 2); assert.equal(f.streamCalls(), 1); assert.equal(f.ranges.length, 0);
  for (const track of tracks) {
    assert.deepEqual(captured(track.audio), captured({ codec: 'unknown', container: 'unknown' }));
    assert.equal(track.availability, 'available');
  }
  await assert.rejects(f.actual.catalog.track(f.scope, selection(tracks[0]!), signal()));
});

test('r7: 喜欢歌单只兼容精确字符串10且外来creator不取得当前账户身份', async t => {
  const f = await fixture(t); let creator = '700';
  f.api.user_playlist = async params => ({ body: { code: 200, more: false,
    playlist: [{ id: '9', specialType: '10', creator: { userId: creator } }] }, cookie: [] }) as never;
  const liked = await f.provider.dispatch({ operation: 'getNeteaseLikedPlaylist', request: request('getNeteaseLikedPlaylist'), scope: f.scope, signal: signal() });
  assert.equal(liked.reply.body.trackCount, 3);
  creator = '701';
  await assert.rejects(f.provider.dispatch({ operation: 'getNeteaseLikedPlaylist', request: request('getNeteaseLikedPlaylist'), scope: f.scope, signal: signal() }), safeError('RESOURCE_REVOKED', 403));
});

test('r7: 新碟真实大总数按当前页与稳定首屏锚读取，不全量拉取', async t => {
  const f = await fixture(t), reads: { offset: number; limit: number }[] = [];
  f.api.album_new = async params => {
    const offset = Number(params.offset), limit = Number(params.limit); reads.push({ offset, limit });
    return { body: { code: 200, total: 5000, albums: Array.from({ length: Math.min(limit, 5000 - offset) }, (_, n) => ({
      id: String(offset + n + 1), name: `合成新碟${offset + n + 1}`, artists: [{ name: '合成艺人' }], size: 3 })) }, cookie: [] } as never;
  };
  const first = await f.provider.dispatch({ operation: 'listNeteaseNewAlbums', request: request('listNeteaseNewAlbums', { limit: 2 }), scope: f.scope, signal: signal() });
  assert.equal(first.reply.body.items.length, 2); assert.equal(typeof first.reply.body.nextCursor, 'string');
  assert.ok(reads.length <= 2); assert.ok(reads.every(v => v.limit <= 100));
  const next = await f.provider.dispatch({ operation: 'listNeteaseNewAlbums', request: request('listNeteaseNewAlbums', { limit: 2, cursor: first.reply.body.nextCursor! }), scope: f.scope, signal: signal() });
  assert.equal(next.reply.body.items.length, 2); assert.equal(next.reply.body.feedRevision, first.reply.body.feedRevision);
  assert.equal(new Set([...first.reply.body.items, ...next.reply.body.items].map(v => v.id)).size, 4);
  assert.ok(reads.length <= 5); assert.ok(reads.every(v => v.offset <= 100 && v.limit <= 100));
});

test('r7: 推荐按完整合格序列分页，榜单保留只验证当前页集合', async t => {
  for (const operation of ['listNeteaseRecommendedPlaylists', 'listNeteaseCharts'] as const) await t.test(operation, async child => {
    const f = await fixture(child), reads: string[] = [], original = f.api.playlist_detail;
    f.api.personalized = async () => ({ body: { code: 200, result: ['9', '10', '11', '12'].map(id => ({ id })) }, cookie: [] });
    f.api.toplist = async () => ({ body: { code: 200, list: ['9', '10', '11', '12'].map(id => ({ id })) }, cookie: [] });
    f.api.playlist_detail = async params => { reads.push(String(params.id));
      if (Number(params.id) >= 11) return { body: { code: 200, playlist: { id: params.id, name: '未显示集合', trackCount: 2, trackIds: [{ id: '1' }] } }, cookie: [] } as never;
      return original(params);
    };
    const page = await f.provider.dispatch({ operation, request: request(operation, { limit: 2 }), scope: f.scope, signal: signal() });
    assert.equal(page.reply.body.items.length, 2);
    if(operation==='listNeteaseRecommendedPlaylists'){
      assert.equal(page.reply.body.nextCursor,null);assert.deepEqual(reads.sort(),['10','11','12','9']);
    }else{assert.equal(typeof page.reply.body.nextCursor,'string');assert.deepEqual(reads.sort(),['10','9']);}
    await page.beforeSend();
  });
});

test('r7: 批量描述符必须精确匹配有序请求，响应重排合法而缺失重复额外ID拒绝', async t => {
  const f = await fixture(t), original = f.api.song_url_v1; let kind: 'missing'|'duplicate'|'extra'|null = null;
  f.api.song_url_v1 = async params => { const raw = await original(params), rows=streamBody(raw).data;
    if (kind === 'missing') rows.pop();
    if (kind === 'duplicate') rows[1] = { ...rows[0]! };
    if (kind === 'extra') rows.push({ ...rows[0]!, id: '999' });
    rows.reverse(); return raw;
  };
  const first = (await f.daily()).reply.body.items;
  assert.equal(first.length, 2); assert.notEqual(first[0]!.id, first[1]!.id); assert.ok(first[0]!.id.endsWith(':1'));
  for (const failure of ['missing', 'duplicate', 'extra'] as const) { kind = failure;
    await assert.rejects(f.daily(), safeError('SOURCE_CHANGED', 409));
  }
});

test('R18_STREAM_DIAGNOSTICS 榜单详情五类原拒绝保精确首因，关闭诊断仍原409且不重放SDK', async t => {
  const cases: [string, string, (rows: Record<string, unknown>[]) => void][] = [
    ['invalid', 'provider.content.stream.batch.id-invalid', rows => { rows[0]!.id = '0'; }],
    ['unexpected', 'provider.content.stream.batch.unexpected-id', rows => { rows[0]!.id = '999'; }],
    ['duplicate', 'provider.content.stream.batch.duplicate-id', rows => { rows[1] = { ...rows[0]! }; }],
    ['missing', 'provider.content.stream.batch.missing-id', rows => { rows.pop(); }],
    ['status-unknown', 'provider.content.stream.item-status', rows => { rows[0]!.code = 500; }],
    ['status-missing', 'provider.content.stream.item-status', rows => { delete rows[0]!.code; }],
    ['status-string', 'provider.content.stream.item-status', rows => { rows[0]!.code = '403'; }],
  ];
  for (const enabled of [false, true]) for (const [reason, stage, change] of cases) await t.test(`${enabled}-${reason}`, async child => {
    const f = await fixture(child, false, enabled), summary = await f.provider.dispatch({ operation: 'listNeteaseCharts',
      request: request('listNeteaseCharts', { limit: 1 }), scope: f.scope, signal: signal() });
    const collection = summary.reply.body.items[0]!, original = f.api.song_url_v1;
    f.api.song_url_v1 = async params => { const raw = await original(params); change(streamBody(raw).data); return raw; };
    const before = new Map(['playlist_detail', 'song_detail', 'song_url_v1'].map(method => [method, f.calls.filter(call => call.method === method).length]));
    const diagnostic = await diagnosticReject(() => f.provider.dispatch({ operation: 'getNeteaseDiscoveryCollectionTracks',
      request: request('getNeteaseDiscoveryCollectionTracks', { kind: collection.kind, accountDomain: f.scope.accountDomain,
        collectionRevision: collection.collectionRevision, limit: 50 }, { collectionId: collection.id }), scope: f.scope, signal: signal() }));
    const providerRows = diagnostic.records.filter(row => String(row.stage).startsWith('provider.content.'));
    assert.deepEqual(providerRows.map(row => row.stage), enabled ? [stage] : []);
    if (enabled) { assert.equal(providerRows[0]!.code, 'SOURCE_CHANGED'); assert.equal(providerRows[0]!.phase, 'reject');
      assert.ok(copyMobileCapabilityTraceRecord(providerRows[0])); assert.equal(Object.keys(providerRows[0]!).length, 15); }
    for (const [method, count] of before) assert.equal(f.calls.filter(call => call.method === method).length - count, 1);
    assert.equal(f.ranges.length, 0); assert.equal(f.sources.resourceSnapshot().live, 0); assert.equal(f.sources.resourceSnapshot().pending, 0);
    assert.doesNotMatch(diagnostic.lines.join(''), /合成|mobile-audio|https?:|sourceItemId|collectionId|credential|cookie|message|stack|providerValue/u);
  });
});

test('R18_STREAM_DIAGNOSTICS 单首明确401或403或404不阻断榜单目录，仍不得取得播放资格', async t => {
  for (const code of [401, 403, 404]) await t.test(String(code), async child => {
    const f = await fixture(child), original = f.api.song_url_v1;
    const summary = await f.provider.dispatch({ operation: 'listNeteaseCharts', request: request('listNeteaseCharts', { limit: 1 }), scope: f.scope, signal: signal() });
    const collection = summary.reply.body.items[0]!;
    f.api.song_url_v1 = async params => { const raw = await original(params); streamBody(raw).data[0]!.code = code; return raw; };
    const page = await f.provider.dispatch({ operation: 'getNeteaseDiscoveryCollectionTracks',
      request: request('getNeteaseDiscoveryCollectionTracks', { kind: collection.kind, accountDomain: f.scope.accountDomain,
        collectionRevision: collection.collectionRevision, limit: 50 }, { collectionId: collection.id }), scope: f.scope, signal: signal() });
    assert.equal(page.reply.body.items.length, 3);
    assert.deepEqual(page.reply.body.items.map(track => track.availability), ['unavailable', 'available', 'available']);
    await page.beforeSend();
    await assert.rejects(f.actual.catalog.track(f.scope, selection(page.reply.body.items[0]!), signal()), safeError('RESOURCE_REVOKED', 403));
    assert.equal(f.ranges.length, 0);
  });
});

test('r7: 单曲明确不可用保留真实目录，未知状态和损坏URL不降级成成功', async t => {
  for (const kind of ['permission', 'preview', 'null-url'] as const) await t.test(kind, async child => {
    const f = await fixture(child), original = f.api.song_url_v1; let denied = true;
    f.api.song_url_v1 = async params => { const raw = await original(params), body=streamBody(raw); return { ...raw, body: { ...body,
      data: body.data.map((row, index) => index || !denied ? row : kind === 'permission' ? { ...row, code: 403 }
        : kind === 'preview' ? { ...row, freeTrialInfo: { start: 0, end: 1 } } : { ...row, url: null }) } } as never; };
    const list = (await f.daily()).reply.body.items;
    assert.equal(list[0]!.availability, 'unavailable'); assert.equal(list[1]!.availability, 'available'); assert.equal(f.ranges.length, 0);
    await assert.rejects(f.actual.catalog.track(f.scope, selection(list[0]!), signal()), safeError('RESOURCE_REVOKED', 403));
    denied = false; const available = (await f.daily()).reply.body.items[0]!;
    assert.notEqual(available.versionId, list[0]!.versionId);
    await assert.rejects(f.actual.catalog.track(f.scope, selection(list[0]!), signal()), safeError('SOURCE_CHANGED', 409));
  });
  for (const change of [{ code: 500 }, { code: undefined }, { url: 'file:///合成非法源' }, { md5: '' }, { size: Number.MAX_SAFE_INTEGER + 1 }]) await t.test(Object.keys(change)[0]!, async child => {
    const f = await fixture(child), original = f.api.song_url_v1;
    f.api.song_url_v1 = async params => { const raw = await original(params), body=streamBody(raw); return { ...raw, body: { ...body,
      data: body.data.map((row, index) => index ? row : { ...row, ...change }) } } as never; };
    await assert.rejects(f.daily());
  });
});

test('r7: 目录与真实播放共用md5和size身份，URL刷新不改selection且目录刷新不污染活动lease', async t => {
  const f = await fixture(t), original = f.api.song_url_v1; let rotated = false;
  f.api.song_url_v1 = async params => { const raw = await original(params); if(rotated)streamBody(raw).data.forEach(row => { row.url = String(row.url)+'?synthetic=rotated'; }); return raw; };
  const first = (await f.daily()).reply.body.items[0]!; rotated = true;
  const next = (await f.daily()).reply.body.items[0]!; assert.deepEqual(selection(next), selection(first));
  const resolved = await f.actual.catalog.track(f.scope, selection(first), signal());
  assert.deepEqual(selection(resolved.track), selection(first)); assert.equal(resolved.track.audio.bitsPerSample, 24);
  const port = f.sources.bind(f.scope), resource = await port.prepare({ resourceId: randomUUID(), trackId:first.id,versionId:first.versionId,contentRevision:first.contentRevision }, signal());
  const list = await f.daily(); assert.equal(list.reply.body.items[0]!.audio.codec, 'unknown');
  await port.verify(resource.handle); await port.renew(resource.handle);
  await port.release(resource.handle); assert.equal(f.sources.resourceSnapshot().live, 0);
  f.md5('b'); assert.notEqual((await f.daily()).reply.body.items[0]!.versionId, first.versionId);
  await assert.rejects(f.actual.resolveSelection(f.scope, { trackId: first.id, versionId: first.versionId, contentRevision: first.contentRevision }, signal()), safeError('SOURCE_CHANGED', 409));
});

test('r7: 新碟跨首屏和末页完整分页，真实锚或total变化拒绝旧cursor', async t => {
  const f = await fixture(t); let changed = false, total = 125;
  f.api.album_new = async params => { const offset = Number(params.offset), limit = Number(params.limit);
    return { body: { code: 200, total, albums: Array.from({ length: Math.min(limit, Math.max(0, total - offset)) }, (_, n) => ({
      id: String(offset + n + 1), name: `合成新碟${offset + n + 1}${changed && offset + n === 0 ? '更新' : ''}`,
      artists: [{ name: '合成艺人' }], size: 3 })) }, cookie: [] } as never;
  };
  const first = await f.provider.dispatch({ operation: 'listNeteaseNewAlbums', request: request('listNeteaseNewAlbums', { limit: 100 }), scope: f.scope, signal: signal() });
  const query = { limit: 100, cursor: first.reply.body.nextCursor! };
  const last = await f.provider.dispatch({ operation: 'listNeteaseNewAlbums', request: request('listNeteaseNewAlbums', query), scope: f.scope, signal: signal() });
  assert.equal(last.reply.body.items.length, 25); assert.equal(last.reply.body.nextCursor, null);
  assert.equal(new Set([...first.reply.body.items, ...last.reply.body.items].map(v => v.id)).size, 125);
  changed = true;
  await assert.rejects(f.provider.dispatch({ operation: 'listNeteaseNewAlbums', request: request('listNeteaseNewAlbums', query), scope: f.scope, signal: signal() }), safeError('SOURCE_CHANGED', 409));
  changed = false; total = 126;
  await assert.rejects(f.provider.dispatch({ operation: 'listNeteaseNewAlbums', request: request('listNeteaseNewAlbums', query), scope: f.scope, signal: signal() }), safeError('SOURCE_CHANGED', 409));
});

test('r7: 喜欢歌单不以任意首歌单兜底，闭集原因在每请求可见且默认关闭', async t => {
  const f = await fixture(t, false, true), lines: string[] = [];
  f.api.user_playlist = async () => ({ body: { code: 200, more: false, playlist: [{ id: '9', specialType: '010' }] }, cookie: [] }) as never;
  for (let n = 0; n < 2; n++) { const context = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, signal(), line => lines.push(line));
    try { await withMobileCapabilityContext(context, () => assert.rejects(f.provider.dispatch({ operation: 'getNeteaseLikedPlaylist', request: request('getNeteaseLikedPlaylist'), scope: f.scope, signal: signal() }), safeError('RESOURCE_REVOKED', 403))); }
    finally { closeMobileCapabilityContext(context); }
  }
  const records = lines.map(line => JSON.parse(line.slice(MOBILE_CAPABILITY_TRACE_PREFIX.length)) as { stage: string });
  assert.equal(records.filter(row => row.stage === 'provider.content.liked.not-found').length, 2);
  assert.ok(records.some(row => row.stage === 'provider.content.liked.marker-string'));
  assert.doesNotMatch(lines.join(''), /synthetic|合成|specialType|playlistId|cookie|https?:|message|stack/u);
  const g = await fixture(t), quiet: string[] = []; g.api.user_playlist = f.api.user_playlist;
  const context = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, signal(), line => quiet.push(line));
  try { await withMobileCapabilityContext(context, () => assert.rejects(g.provider.dispatch({ operation: 'getNeteaseLikedPlaylist', request: request('getNeteaseLikedPlaylist'), scope: g.scope, signal: signal() }))); }
  finally { closeMobileCapabilityContext(context); }
  assert.equal(quiet.some(line => line.includes('provider.content.')), false);
});

test('r7-liked-native: 原生5优先于历史10且数值和精确字符串保持同一规则', async t => {
  for (const native of [5, '5'] as const) await t.test(String(typeof native), async child => {
    const f = await fixture(child);
    f.api.user_playlist = async () => ({ body: { code: 200, more: false, playlist: [
      { id: '9', specialType: 10, userId: '700' }, { id: '13', specialType: native, userId: '700', creator: { userId: 700 } },
    ] }, cookie: [] }) as never;
    const result = await f.provider.dispatch({ operation: 'getNeteaseLikedPlaylist', request: request('getNeteaseLikedPlaylist'), scope: f.scope, signal: signal() });
    assert.ok(result.reply.body.playlistId.endsWith(':13'));
  });
});

test('r7-liked-native: 旧10只能在有界扫描确认无原生5后选中，不能抢走后页原生身份', async t => {
  const f = await fixture(t), pages: number[] = [];
  f.api.user_playlist = async params => { const offset = Number(params.offset); pages.push(offset);
    return { body: { code: 200, more: offset === 0, playlist: offset === 0
      ? [{ id: '9', specialType: 10, userId: '700' }, ...Array.from({ length: 99 }, (_, n) => ({ id: String(100 + n), specialType: 0 }))]
      : [{ id: '13', specialType: 5, userId: '700' }] }, cookie: [] } as never;
  };
  const result = await f.provider.dispatch({ operation: 'getNeteaseLikedPlaylist', request: request('getNeteaseLikedPlaylist'), scope: f.scope, signal: signal() });
  assert.ok(result.reply.body.playlistId.endsWith(':13')); assert.deepEqual(pages, [0, 100]);
});

test('r7-liked-native: 顶层owner与creator任一冲突或原生身份歧义均拒绝', async t => {
  for (const records of [
    [{ id: '13', specialType: 5, userId: '700', creator: { userId: '701' } }],
    [{ id: '13', specialType: 5, userId: '701', creator: { userId: '700' } }],
    [{ id: '13', specialType: 5, userId: '701', creator: { userId: '702' } }],
    [{ id: '13', specialType: 5, userId: '700' }, { id: '14', specialType: '5', userId: '700' }],
  ]) await t.test(`合成候选${records.length}`, async child => {
    const f = await fixture(child); f.api.user_playlist = async () => ({ body: { code: 200, more: false, playlist: records }, cookie: [] }) as never;
    await assert.rejects(f.provider.dispatch({ operation: 'getNeteaseLikedPlaylist', request: request('getNeteaseLikedPlaylist'), scope: f.scope, signal: signal() }), safeError('SOURCE_CHANGED', 409));
  });
});

test('r7-liked-native: 扫描达到原上限仍有后页时不把历史10当成完整成功', async t => {
  const f = await fixture(t), pages: number[] = [];
  f.api.user_playlist = async params => { const offset = Number(params.offset); pages.push(offset);
    return { body: { code: 200, more: true, playlist: Array.from({ length: 100 }, (_, n) => ({ id: String(offset + n + 1),
      specialType: offset === 0 && n === 0 ? 10 : 0, userId: '700' })) }, cookie: [] } as never;
  };
  await assert.rejects(f.provider.dispatch({ operation: 'getNeteaseLikedPlaylist', request: request('getNeteaseLikedPlaylist'), scope: f.scope, signal: signal() }), safeError('BUSY', 503));
  assert.equal(pages.length, 10); assert.equal(f.calls.some(call => call.method === 'playlist_detail'), false);
});

test('r7: 当前页集合损坏保持拒绝并提供闭集可归因原因，不输出正文', async t => {
  const base = { id: '9', name: '合成集合', trackCount: 2, trackIds: [{ id: '1' }, { id: '2' }] };
  for (const [reason, row] of [
    ['track-ids-missing', { id: '9', name: '合成集合', trackCount: 2 }],
    ['count-mismatch', { ...base, trackCount: 3 }],
    ['duplicate-ids', { ...base, trackIds: [{ id: '1' }, { id: '1' }] }],
    ['invalid-name', { ...base, name: '\u0000禁止正文' }],
  ] as const) await t.test(reason, async child => {
    const f = await fixture(child, false, true), lines: string[] = [];
    f.api.playlist_detail = async () => ({ body: { code: 200, playlist: row }, cookie: [] }) as never;
    const context = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, signal(), line => lines.push(line));
    try { await withMobileCapabilityContext(context, () => assert.rejects(f.provider.dispatch({ operation: 'listNeteaseRecommendedPlaylists',
      request: request('listNeteaseRecommendedPlaylists', { limit: 1 }), scope: f.scope, signal: signal() }), safeError('SOURCE_CHANGED', 409))); }
    finally { closeMobileCapabilityContext(context); }
    const records = lines.map(line => JSON.parse(line.slice(MOBILE_CAPABILITY_TRACE_PREFIX.length)) as { stage: string });
    assert.ok(records.some(record => record.stage === `provider.content.collection.${reason}`));
    assert.doesNotMatch(lines.join(''), /禁止|合成|trackIds|trackCount|credential|cookie|message|stack|https?:/u);
  });
});

test('r9-liked: 一致外来5和10只跳过，不阻断当前账户唯一原生5', async t => {
  for (const reverse of [false, true]) await t.test(reverse ? '外来候选在后' : '外来候选在前', async child => {
    const f = await fixture(child), original = f.api.playlist_detail, reads: string[] = [];
    const foreign = [{ id: '21', specialType: 5, userId: '701' },
      { id: '22', specialType: '5', creator: { userId: 702 } },
      { id: '23', specialType: 10, userId: 703, creator: { userId: '703' } }];
    const owned = { id: '13', specialType: '5', userId: '700', creator: { userId: 700 } };
    f.api.user_playlist = async () => ({ body: { code: 200, more: false,
      playlist: reverse ? [owned, ...foreign] : [...foreign, owned] }, cookie: [] }) as never;
    f.api.playlist_detail = async params => { reads.push(String(params.id)); return original(params); };
    const result = await f.provider.dispatch({ operation: 'getNeteaseLikedPlaylist', request: request('getNeteaseLikedPlaylist'), scope: f.scope, signal: signal() });
    assert.ok(result.reply.body.playlistId.endsWith(':13')); assert.deepEqual(reads, ['13']); await result.beforeSend();
  });
});

test('r9-liked: 外来原生5不能抢占后页原生身份或阻止完成扫描后的历史10', async t => {
  for (const native of [true, false]) await t.test(native ? '后页原生5' : '完整扫描后兼容10', async child => {
    const f = await fixture(child), pages: number[] = [], reads: string[] = [], original = f.api.playlist_detail;
    f.api.user_playlist = async params => { const offset = Number(params.offset); pages.push(offset);
      return { body: { code: 200, more: offset === 0, playlist: offset === 0
        ? [{ id: '21', specialType: 5, userId: '701' }, { id: '9', specialType: 10, userId: '700' },
          ...Array.from({ length: 98 }, (_, n) => ({ id: String(100 + n), specialType: 0 }))]
        : native ? [{ id: '13', specialType: 5, userId: '700' }]
          : [{ id: '22', specialType: '5', userId: '702', creator: { userId: 702 } }] }, cookie: [] } as never;
    };
    f.api.playlist_detail = async params => { reads.push(String(params.id)); return original(params); };
    const result = await f.provider.dispatch({ operation: 'getNeteaseLikedPlaylist', request: request('getNeteaseLikedPlaylist'), scope: f.scope, signal: signal() });
    assert.ok(result.reply.body.playlistId.endsWith(native ? ':13' : ':9')); assert.deepEqual(pages, [0, 100]);
    assert.deepEqual(reads, [native ? '13' : '9']);
  });
});

test('r9-liked: 只有一致外来候选仍为未找到，冲突或无效owner不允许伪装成外来跳过', async t => {
  const f = await fixture(t);
  let candidates: Record<string, unknown>[] = [
    { id: '21', specialType: 5, userId: '701', creator: { userId: 701 } },
    { id: '22', specialType: 10, creator: { userId: '702' } } ];
  f.api.user_playlist = async () => ({ body: { code: 200, more: false, playlist: candidates }, cookie: [] }) as never;
  await assert.rejects(f.provider.dispatch({ operation: 'getNeteaseLikedPlaylist', request: request('getNeteaseLikedPlaylist'), scope: f.scope, signal: signal() }), safeError('RESOURCE_REVOKED', 403));
  assert.equal(f.calls.some(call => call.method === 'playlist_detail'), false);
  for (const owner of [0, '0', null, '无效身份']) {
    for (const candidate of [{ id: '21', specialType: 5, userId: owner, creator: { userId: '701' } },
      { id: '21', specialType: 5, userId: '701', creator: { userId: owner } }]) {
      candidates = [candidate, { id: '13', specialType: 5, userId: '700' }];
      await assert.rejects(f.provider.dispatch({ operation: 'getNeteaseLikedPlaylist', request: request('getNeteaseLikedPlaylist'), scope: f.scope, signal: signal() }), safeError('SOURCE_CHANGED', 409));
    }
  }
  candidates = [{ id: '13', specialType: 5 }];
  const compatible = await f.provider.dispatch({ operation: 'getNeteaseLikedPlaylist', request: request('getNeteaseLikedPlaylist'), scope: f.scope, signal: signal() });
  assert.ok(compatible.reply.body.playlistId.endsWith(':13'));
});

async function sourceDiagnosticReject(work: () => Promise<unknown>, privateContext = true) {
  const lines: string[] = [], context = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, signal(), line => lines.push(line));
  assert.ok(context); if (privateContext) context.privateContentDiagnostic = true;
  try { await withMobileCapabilityContext(context, () => assert.rejects(work(), safeError('SOURCE_CHANGED', 409))); }
  finally { closeMobileCapabilityContext(context); }
  const records = lines.map(line => copyMobileCapabilityTraceRecord(JSON.parse(line.slice(MOBILE_CAPABILITY_TRACE_PREFIX.length))));
  assert.ok(records.every(value => value !== null));
  assert.doesNotMatch(lines.join(''), /synthetic|credential|cookie|https?:|headerSha|metadataSuffix|message|stack/u);
  return records.filter(value => value!.phase === 'reject');
}

test('R15_SOURCE_DIAGNOSTICS exact选择只记录原version或revision首拒，私有关闭不改变拒绝', async t => {
  for (const field of ['versionId', 'contentRevision'] as const) await t.test(field, async child => {
    const f = await fixture(child, false, true), listed = (await f.daily()).reply.body.items[0]!;
    const selected = { ...selection(listed), [field]: 'synthetic-selection-changed' };
    const records = await sourceDiagnosticReject(() => f.actual.catalog.track(f.scope, selected, signal()));
    assert.deepEqual(records.map(row => row!.stage), ['provider.source.selection.exact.' + (field === 'versionId' ? 'version' : 'revision')]);
    assert.equal(records[0]!.code, 'SOURCE_CHANGED'); assert.equal(Object.keys(records[0]!).length, 15);
  });
  for (const [enabled, privateContext] of [[false, true], [true, false]] as const) await t.test('disabled-' + enabled + '-' + privateContext, async child => {
    const f = await fixture(child, false, enabled), listed = (await f.daily()).reply.body.items[0]!;
    const records = await sourceDiagnosticReject(() => f.actual.catalog.track(f.scope, { ...selection(listed), versionId: 'synthetic-selection-changed' }, signal()), privateContext);
    assert.equal(records.length, 0);
  });
});

test('R15_SOURCE_DIAGNOSTICS single与batch媒体描述符差异在目录选择重核首拒且不新开HTTP', async t => {
  const f = await fixture(t, false, true), listed = (await f.daily()).reply.body.items[0]!;
  const observed = await f.actual.readObservedTrack(f.scope, listed.id, selection(listed), signal()), before = f.ranges.length;
  const original = f.client.mobileRead.bind(f.client);
  t.mock.method(f.client, 'mobileRead', async (request: Parameters<typeof f.client.mobileRead>[0], options: Parameters<typeof f.client.mobileRead>[1]) => {
    const result = await original(request, options);
    if (request.operation !== 'streams') return result;
    const next = structuredClone(result);
    assert.ok(mobileRecord(next.response) && Array.isArray(next.response.data));
    for (const row of next.response.data) { assert.ok(mobileRecord(row)); row.md5 = 'b'.repeat(32); }
    return next;
  });
  const records = await sourceDiagnosticReject(() => f.actual.resolveSelection(f.scope,
    { trackId: observed.id, versionId: observed.versionId, contentRevision: observed.contentRevision }, signal()));
  assert.deepEqual(records.map(row => row!.stage), ['provider.source.selection.directory.version']);
  assert.equal(f.ranges.length, before); assert.equal(f.sources.resourceSnapshot().live, 0);
});

test('R17_SOURCE_ALIAS 仅九主机变化保留完整指纹及prepare，查询变化仍独立拒绝', async t => {
  const f = await fixture(t, true, true), listed = (await f.daily()).reply.body.items[0]!;
  const first = await f.actual.readObservedTrack(f.scope, listed.id, selection(listed), signal()); assert.ok(first.artworkId);
  f.songs[0]!.al.picUrl = 'https://p2.music.126.net/synthetic-cover.jpg';
  const next = (await f.actual.catalog.track(f.scope, selection(first), signal())).track;
  assert.deepEqual(selection(next), selection(first)); assert.deepEqual(next.audio, first.audio);
  assert.equal(next.artworkId, first.artworkId); assert.equal(mobileContentTrackFingerprint(next), mobileContentTrackFingerprint(first));
  assert.deepEqual(captured(await f.actual.resolveSelection(f.scope,
    { trackId: first.id, versionId: first.versionId, contentRevision: first.contentRevision }, signal())), captured(selection(first)));
  const prepared = await f.sources.bind(f.scope).prepare({ resourceId: randomUUID(),
    trackId: first.id, versionId: first.versionId, contentRevision: first.contentRevision }, signal());
  assert.deepEqual(captured(prepared.sourceAudio), captured(first.audio));
  await f.sources.bind(f.scope).release(prepared.handle); assert.equal(f.sources.resourceSnapshot().live, 0);
  assert.equal((await f.actual.readArtwork(f.scope, first.artworkId!, signal())).artworkId, first.artworkId);
  f.songs[0]!.al.picUrl += '?changed=1';
  const records = await sourceDiagnosticReject(() => f.actual.readArtwork(f.scope, first.artworkId!, signal()));
  assert.deepEqual(records.map(row => row!.stage), ['provider.artwork.url-changed']);
});

test('R15_SOURCE_DIAGNOSTICS refresh分开metadata与mediaBase原拒绝，opened实际头变化仍拒绝并收口', async t => {
  for (const kind of ['metadata', 'media-base', 'observed'] as const) await t.test(kind, async child => {
    const f = await fixture(child, false, true), listed = (await f.daily()).reply.body.items[0]!;
    const exact = await f.actual.readObservedTrack(f.scope, listed.id, selection(listed), signal());
    if (kind === 'metadata') f.metadata('synthetic-metadata-change');
    else if (kind === 'media-base') f.md5('b');
    else f.audio.writeUInt16BE(2048, 8); // 保留合法STREAMINFO与音频轴，只改变实际头部。
    const before = f.ranges.length;
    const records = await sourceDiagnosticReject(() => f.actual.streams.open({ scope: f.scope, resourceId: randomUUID(), selection: selection(exact) }, signal()));
    assert.deepEqual(records.map(row => row!.stage), ['provider.source.' + (kind === 'observed' ? 'open.observed' : 'refresh.' + kind)]);
    if (kind !== 'observed') assert.equal(f.ranges.length, before);
    await f.actual.close(); assert.equal(f.actual.qualified, false);
  });
});

test('R15_SOURCE_DIAGNOSTICS 更内层既有首拒不会被选择旁注替换', async t => {
  const f = await fixture(t, false, true), listed = (await f.daily()).reply.body.items[0]!;
  const records = await sourceDiagnosticReject(async () => {
    mobileCapabilityReject('provider.artwork.url-changed', new MobileServiceError(409, 'SOURCE_CHANGED'));
    return f.actual.catalog.track(f.scope, { ...selection(listed), versionId: 'synthetic-selection-changed' }, signal());
  });
  assert.deepEqual(records.map(row => row!.stage), ['provider.artwork.url-changed']);
});

async function diagnosticReject(work: () => Promise<unknown>, code = 'SOURCE_CHANGED', status = 409) {
  const lines: string[] = [], context = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, signal(), line => lines.push(line));
  try { await withMobileCapabilityContext(context, () => assert.rejects(work(), safeError(code, status))); }
  finally { closeMobileCapabilityContext(context); }
  return { lines, records: lines.map(line => JSON.parse(line.slice(MOBILE_CAPABILITY_TRACE_PREFIX.length)) as Record<string, unknown>) };
}

test('r9-mapping: 真实SDK到集合详情保留字段拒绝语义并保存最细首因', async t => {
  const cases: [string, (row: Record<string, unknown>) => void][] = [
    ['song-title', row => { row.name = ''; }],
    ['album-shape', row => { row.al = []; }],
    ['album-id', row => { row.al = { id: '-1', name: '禁止输出的专辑' }; }],
    ['album-name', row => { row.al = { id: '5', name: '' }; }],
    ['artists-shape', row => { row.ar = []; }],
    ['artist-id', row => { row.ar = [{ id: '-1', name: '禁止输出的艺人' }]; }],
    ['artist-name', row => { row.ar = [{ id: '17', name: '' }]; }],
    ['duration', row => { row.dt = 0; }],
  ];
  for (const [reason, change] of cases) await t.test(reason, async child => {
    const f = await fixture(child, true, true);
    const summary = await f.provider.dispatch({ operation: 'listNeteaseRecommendedPlaylists', request: request('listNeteaseRecommendedPlaylists', { limit: 1 }), scope: f.scope, signal: signal() });
    const collection = summary.reply.body.items[0]!, original = f.api.song_detail;
    f.api.song_detail = async params => { const reply = await original(params); assert.ok(mobileRecord(reply.body) && Array.isArray(reply.body.songs));
      const row = reply.body.songs[0]; assert.ok(mobileRecord(row)); change(row); return reply; };
    const diagnostic = await diagnosticReject(() => f.provider.dispatch({ operation: 'getNeteaseDiscoveryCollectionTracks',
      request: request('getNeteaseDiscoveryCollectionTracks', { kind: collection.kind, accountDomain: f.scope.accountDomain,
        collectionRevision: collection.collectionRevision, limit: 50 }, { collectionId: collection.id }), scope: f.scope, signal: signal() }), reason==='album-shape'?'BUSY':'SOURCE_CHANGED', reason==='album-shape'?503:409);
    assert.deepEqual(diagnostic.records.filter(row => String(row.stage).startsWith('provider.content.')).map(row => row.stage),
      [reason==='album-shape'?'provider.content.song-detail':`provider.content.mapping.${reason}`]);
    assert.equal(f.ranges.length, 0);
    assert.doesNotMatch(diagnostic.lines.join(''), /禁止|合成|songId|albumId|artistId|credential|cookie|message|stack|https?:/u);
  });
});

test('r9-mapping: 集合身份和成员ID各自闭合，旧revision仍拒绝且同素材封面不漂移', async t => {
  for (const reason of ['collection-identity', 'collection-member-id', 'revision-mismatch'] as const) await t.test(reason, async child => {
    const f = await fixture(child, true, true), original = f.api.playlist_detail; let reject = false;
    f.api.playlist_detail = async params => { const reply = await original(params); assert.ok(mobileRecord(reply.body) && mobileRecord(reply.body.playlist));
      if (reject && reason === 'collection-identity') reply.body.playlist.id = '999';
      if (reject && reason === 'collection-member-id') reply.body.playlist.trackIds = [{ id: '0' }, { id: '2' }, { id: '3' }]; return reply; };
    const summary = await f.provider.dispatch({ operation: 'listNeteaseCharts',
      request: request('listNeteaseCharts', { limit: 1 }), scope: f.scope, signal: signal() });
    const collection = summary.reply.body.items[0]!, query = { kind: collection.kind, accountDomain: f.scope.accountDomain,
      collectionRevision: collection.collectionRevision, limit: 50 };
    const read = () => f.provider.dispatch({ operation: 'getNeteaseDiscoveryCollectionTracks',
      request: request('getNeteaseDiscoveryCollectionTracks', query, { collectionId: collection.id }), scope: f.scope, signal: signal() });
    const detail = await read(); assert.equal(detail.reply.body.collection.artworkId, collection.artworkId);
    assert.equal(detail.reply.body.collection.collectionRevision, collection.collectionRevision); await detail.beforeSend();
    reject = true;
    if (reason === 'revision-mismatch') query.collectionRevision = 'nr:' + 'f'.repeat(64);
    const diagnostic = await diagnosticReject(read);
    assert.deepEqual(diagnostic.records.filter(row => String(row.stage).startsWith('provider.content.mapping')).map(row => row.stage), [`provider.content.mapping.${reason}`]);
  });
});

test('r9-mapping: 闭集23阶段保持原15字段，未知阶段或正文拒绝，默认关闭', async t => {
  const f = await fixture(t, false, true); f.songs[0]!.ar[0]!.id = '-1';
  const diagnostic = await diagnosticReject(f.daily), record = diagnostic.records.find(row => row.phase === 'reject'); assert.ok(record);
  const suffixes = ['song-id', 'song-title', 'album-shape', 'album-id', 'album-name', 'artists-shape', 'artist-id', 'artist-name',
    'duration', 'edition', 'collection-identity', 'collection-member-id', 'directory-snapshot', 'track-dto', 'reply-dto', 'revision-mismatch'];
  const stages = [...suffixes.map(value => `provider.content.mapping.${value}`), ...['scope', 'identity', 'signature', 'generation',
    'url-missing', 'url-changed', 'revision-changed'].map(value => `provider.artwork.${value}`)];
  for (const stage of stages) { const copied = copyMobileCapabilityTraceRecord({ ...record, stage }); assert.ok(copied, stage); assert.equal(Object.keys(copied).length, 15); }
  assert.equal(copyMobileCapabilityTraceRecord({ ...record, stage: 'provider.content.mapping.unknown' }), null);
  assert.equal(copyMobileCapabilityTraceRecord({ ...record, body: '禁止输出的正文' }), null);
  const g = await fixture(t); g.songs[0]!.ar[0]!.id = '-1'; const quiet = await diagnosticReject(g.daily);
  assert.equal(quiet.records.some(row => String(row.stage).startsWith('provider.content.')), false);
});

test('R10_TRACK scoped SDK quiet只等原signal，abort后的迟到SDK与无关请求分别静止',async t=>{
  const f=await fixture(t),a=new AbortController(),b=new AbortController(),first=deferred<void>(),second=deferred<void>(),startedA=deferred<void>(),startedB=deferred<void>();
  const original=f.api.song_detail;f.api.song_detail=async params=>{if(params.ids==='1'){startedA.resolve();await first.promise;}else{startedB.resolve();await second.promise;}return original(params);};
  const readA=f.client.mobileRead({operation:'song-detail',ids:['1']},{signal:a.signal}).catch(()=>undefined);
  const readB=f.client.mobileRead({operation:'song-detail',ids:['2']},{signal:b.signal});
  try{
    await Promise.all([startedA.promise,startedB.promise]);a.abort();await readA;let quietA=false,global=false;
    const quiet=f.client.awaitMobileQuiet(a.signal).then(()=>{quietA=true;}),all=f.client.awaitMobileQuiet().then(()=>{global=true;});
    for(let i=0;i<80;i++)await Promise.resolve();assert.equal(quietA,false);assert.equal(global,false);
    first.resolve();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(quietA,true);assert.equal(global,false);
    await f.client.awaitMobileQuiet(new AbortController().signal);second.resolve();await Promise.all([quiet,all,readB]);
  }finally{first.resolve();second.resolve();await Promise.allSettled([readA,readB]);}
});

test('R10_TRACK 专用详情真实探测audio且保目录selection，取消只等本次迟到SDK不占播放资源',async t=>{
  const f=await fixture(t),original=f.api.song_detail,entered=deferred<void>(),release=deferred<void>(),otherEntered=deferred<void>(),otherRelease=deferred<void>();let hold=false;
  f.api.song_detail=async params=>{if(hold){if(params.ids==='1'){entered.resolve();await release.promise;}else{otherEntered.resolve();await otherRelease.promise;}}return original(params);};
  const directory=(await f.daily()).reply.body.items[0]!,observed=await f.actual.readObservedTrack(f.scope,directory.id,null,signal());
  assert.deepEqual(selection(observed),selection(directory));assert.equal(directory.audio.codec,'unknown');assert.equal(observed.audio.codec,'flac');assert.equal(observed.audio.bitsPerSample,24);
  assert.equal(f.sources.resourceSnapshot().live,0);assert.equal(f.sources.resourceSnapshot().pending,0);
  assert.deepEqual(selection(await f.actual.readObservedTrack(f.scope,directory.id,selection(directory),signal())),selection(directory));
  hold=true;const controller=new AbortController();let done=false;
  const reading=f.actual.readObservedTrack(f.scope,directory.id,null,controller.signal).catch(error=>{done=true;assert.ok(error instanceof MobileServiceError);});
  const other=f.client.mobileRead({operation:'song-detail',ids:['2']},{signal:new AbortController().signal});
  try{
    await Promise.all([entered.promise,otherEntered.promise]);controller.abort();for(let i=0;i<80;i++)await Promise.resolve();assert.equal(done,false);
    release.resolve();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(done,true);otherRelease.resolve();await Promise.all([reading,other]);
    hold=false;f.md5('b');await assert.rejects(f.actual.readObservedTrack(f.scope,directory.id,selection(directory),signal()),safeError('SOURCE_CHANGED',409));
  }finally{release.resolve();otherRelease.resolve();await Promise.allSettled([reading,other]);}
});

test('R10_ARTIST 可选艺人注册ID缺省与精确零不使整页喜欢或榜单详情失败，selection保持同一内容',async t=>{
  for(const route of ['liked','chart'] as const)await t.test(route,async child=>{
    const f=await fixture(child),artist=f.songs[0]!.ar[0]! as unknown as Record<string,unknown>;
    const summary=route==='liked'?await f.provider.dispatch({operation:'getNeteaseLikedPlaylist',request:request('getNeteaseLikedPlaylist'),scope:f.scope,signal:signal()})
      :await f.provider.dispatch({operation:'listNeteaseCharts',request:request('listNeteaseCharts',{limit:1}),scope:f.scope,signal:signal()});
    const body=summary.reply.body as unknown as Record<string,unknown>,collection=(body.items as {id:string;kind:string;collectionRevision:string}[]|undefined)?.[0];
    const read=()=>route==='liked'?f.provider.dispatch({operation:'listNeteaseLikedPlaylistTracks',request:request('listNeteaseLikedPlaylistTracks',{
      playlistId:String(body.playlistId),playlistRevision:String(body.playlistRevision),accountDomain:f.scope.accountDomain,limit:50}),scope:f.scope,signal:signal()})
      :f.provider.dispatch({operation:'getNeteaseDiscoveryCollectionTracks',request:request('getNeteaseDiscoveryCollectionTracks',{
        kind:collection!.kind,collectionRevision:collection!.collectionRevision,accountDomain:f.scope.accountDomain,limit:50},{collectionId:collection!.id}),scope:f.scope,signal:signal()});
    let original:MobileTrackSelection|undefined;
    for(const value of [undefined,0,'0']){if(value===undefined)delete artist.id;else artist.id=value;
      const page=await read();assert.equal(page.reply.body.items.length,3);const track=page.reply.body.items[0]!;
      assert.deepEqual(track.artists,['合成艺人']);if(original)assert.deepEqual(selection(track),original);else original=selection(track);
      assert.equal(track.sourceItemId,'1');assert.equal(track.audio.codec,'unknown');await page.beforeSend();
    }
    for(const value of [-1,'-1','00','0.0','',1.5,Number.MAX_SAFE_INTEGER+1]){artist.id=value;await assert.rejects(read());}
  });
});
