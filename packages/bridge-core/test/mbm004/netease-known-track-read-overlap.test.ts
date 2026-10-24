import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import type { MobileTrackSelection } from '@music-bridge/contracts';
import { MOBILE_OPERATION_TABLE } from '@music-bridge/contracts';
import { NeteaseClient } from '../../src/netease/client.js';
import { createActualMobileNeteasePorts } from '../../src/netease/mobile-actual-ports.js';
import { createMobileNeteaseCatalogService } from '../../src/mobile/netease-catalog-service.js';
import { createMobileNeteaseSourceService } from '../../src/mobile/netease-source-service.js';
import { captureMobileContentRequest } from '../../src/mobile/content-protocol.js';
import { MobileServiceError } from '../../src/mobile/types.js';
import type { MobileNeteaseScope } from '../../src/mobile/netease-source-types.js';
import type { GatewayFetch } from '../../src/stream/upstream-policy.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() {
  let release!: () => void, started!: () => void;
  return { held: new Promise<void>(r => { release = r; }), began: new Promise<void>(r => { started = r; }),
    release: () => release(), start: () => started() };
}

// 真正Client/scheduler、Provider解析、HTTP Range音频事实与Source prepare组合；无账号/外网/用户文件。
async function fixture(t: TestContext) {
  const audio = Buffer.alloc(150000); audio.write('fLaC'); audio[4] = 0x80; audio.writeUIntBE(34, 5, 3);
  audio.writeUInt16BE(4096, 8); audio.writeUInt16BE(4096, 10);
  audio.writeBigUInt64BE(192000n << 44n | 1n << 41n | 23n << 36n | 192000n, 18);
  const calls: string[] = [], stages: string[] = [], ranges: string[] = [];
  const held: ReturnType<typeof gate>[] = [];
  let detailGate: ReturnType<typeof gate> | undefined, streamGate: ReturnType<typeof gate> | undefined;
  let detailFailure = false, streamFailure = false, account = '700', generation = 1, active = true;
  let title = '合成曲', md5 = 'a', physical = 0;
  const now = 1700000000000;
  const song = () => ({ id: '1', name: title, ar: [{ id: '17', name: '合成艺人' }],
    al: { id: '5', name: '合成发行' }, dt: 1000, alia: ['原发行'] });
  const body = (value: unknown) => ({ body: value });
  const api = {
    async login_qr_key() { return body({ code: 200 }); }, async login_qr_create() { return body({ code: 200 }); },
    async login_qr_check() { return body({ code: 200 }); }, async login_status() { return body({ code: 200 }); },
    async logout() { return body({ code: 200 }); },
    async user_account() { calls.push('account'); return body({ code: 200, account: { id: account } }); },
    async recommend_songs() { calls.push('daily'); return body({ code: 200, data: { dailySongs: [{ id: '1' }] } }); },
    async song_detail() {
      calls.push('detail'); physical++;
      try { if (detailGate) { const g = detailGate; detailGate = undefined; g.start(); await g.held; }
        return body({ code: 200, songs: detailFailure ? [] : [song()] }); }
      finally { physical--; }
    },
    async song_url_v1(params: Record<string, unknown>) {
      calls.push('stream'); physical++;
      try { if (streamGate) { const g = streamGate; streamGate = undefined; g.start(); await g.held; }
        return body({ code: 200, data: String(params.id).split(',').map(id => ({ id, code: streamFailure ? 500 : 200,
          freeTrialInfo: null, md5: md5.repeat(32), size: audio.length, expi: 300,
          url: 'https://synthetic-audio.invalid/one.flac', level: 'hires', type: 'flac', br: 9216000 })) }); }
      finally { physical--; }
    },
  };
  const fetcher: GatewayFetch = async (_url, init) => {
    const range = new Headers(init.headers).get('range'); assert.ok(range); ranges.push(range);
    const m = /^bytes=([0-9]+)-([0-9]+)$/u.exec(range); assert.ok(m);
    const start = Number(m[1]), end = Number(m[2]); assert.ok(end-start < 65536);
    return new Response(Uint8Array.from(audio.subarray(start,end+1)), {status:206,
      headers:{'content-range':`bytes ${start}-${end}/${audio.length}`,'content-length':String(end-start+1),etag:'"synthetic-source"'}});
  };
  const client = new NeteaseClient('synthetic-local-credential', api, async () => undefined, { now: () => now });
  const current = async (scope: MobileNeteaseScope, stage: 'acquire' | 'lease') => {
    stages.push(stage);
    if (!active || scope.accessGeneration !== generation) throw new MobileServiceError(409, 'SOURCE_CHANGED');
  };
  const actual = createActualMobileNeteasePorts({ client, serverId:'server-1', datasetId:'dataset-1', ownerEpoch:'owner-1',
    identityKey32:new Uint8Array(32).fill(19), assertCurrent:current, now:()=>now, fetch:fetcher });
  const accountScope = await actual.account.current(new AbortController().signal); assert.ok(accountScope);
  const scope: MobileNeteaseScope = {serverId:'server-1',datasetId:'dataset-1',deviceId:'device-1',deviceEpoch:1,
    accessGeneration:1,ownerEpoch:'owner-1',...accountScope};
  const catalog = createMobileNeteaseCatalogService({port:actual.catalog,assertCurrent:s=>current(s,'lease'),playbackQualified:()=>actual.qualified});
  const sources = createMobileNeteaseSourceService({account:actual.account,catalog,streams:actual.streams,assertCurrent:current,
    isQualified:()=>actual.qualified,nowMs:()=>now});
  const listed = await actual.provider.read({operation:'getNeteaseDailyRecommendations',scope,
    request:captureMobileContentRequest('getNeteaseDailyRecommendations',{path:MOBILE_OPERATION_TABLE.getNeteaseDailyRecommendations.path,pathParameters:{},query:{},body:null}),
    offset:0,limit:100,expectedRevision:null,signal:new AbortController().signal});
  const track = (listed.body as {items: MobileTrackSelection[]}).items[0] as unknown as {id:string;versionId:string;contentRevision:string}; assert.ok(track);
  const selection:MobileTrackSelection = {trackId:track.id,source:'netease',versionId:track.versionId,contentRevision:track.contentRevision};
  calls.length=0;stages.length=0;ranges.length=0;
  t.after(async()=>{for(const g of held)g.release();await sources.close();await actual.close();assert.equal(physical,0);});
  return {actual,sources,scope,selection,calls,stages,ranges,physical:()=>physical,
    holdDetail(){const g=gate();held.push(g);detailGate=g;return g;},
    holdStream(){const g=gate();held.push(g);streamGate=g;return g;},
    failDetail(){detailFailure=true;},failStream(){streamFailure=true;},
    providerGenerationChange(){client.setCredential('synthetic-replacement');},generationChange(){generation++;},revoke(){active=false;},
    metadataChange(){title+='改变';},mediaChange(){md5='b';},
    invoke(kind:'directory'|'exact',signal=new AbortController().signal){return kind==='directory'
      ?actual.resolveSelection(scope,{trackId:selection.trackId,versionId:selection.versionId,contentRevision:selection.contentRevision},signal)
      :actual.catalog.track(scope,selection,signal);},
    async prepare(){await actual.resolveSelection(scope,{trackId:selection.trackId,versionId:selection.versionId,contentRevision:selection.contentRevision},new AbortController().signal);
      return sources.bind(scope).prepare({trackId:selection.trackId,versionId:selection.versionId,contentRevision:selection.contentRevision,
        resourceId:randomUUID()},new AbortController().signal);},
  };
}

for (const kind of ['directory','exact'] as const) {
  test(`M63 ${kind}已知rawId的detail held时stream真实启动，完整结果仍等待两支`,async t=>{
    const f=await fixture(t),g=f.holdDetail();let settled=false;
    const work=f.invoke(kind).then(v=>{settled=true;return v;});
    await g.began;await tick();
    try {assert.equal(f.calls.filter(x=>x==='stream').length,1);assert.equal(settled,false);}
    finally {g.release();await work;}
    assert.equal(f.calls.filter(x=>x==='detail').length,1);assert.equal(f.physical(),0);
  });
}

test('M63 detail失败仍等待已并行stream真正quiet，双失败保持原detail优先',async t=>{
  for(const kind of ['directory','exact'] as const)await t.test(kind,async child=>{
    const f=await fixture(child),g=f.holdStream();f.failDetail();f.failStream();let settled=false;
    const work=f.invoke(kind).then(()=>{settled=true;return null;},e=>{settled=true;return e;});
    await tick();
    try {assert.equal(f.calls.filter(x=>x==='stream').length,1);assert.equal(f.physical(),1);assert.equal(settled,false);}
    finally {g.release();}
    const error=await work;assert.ok(error instanceof MobileServiceError);assert.equal(error.code,'RESOURCE_REVOKED');assert.equal(f.physical(),0);
  });
});

test('M63 成功完整prepare的原fresh次数、上游请求及真实probe不减，公开DTO黄金保持',async t=>{
  const f=await fixture(t),value=await f.prepare();assert.ok(!('preparing'in value));
  assert.equal(value.sourceAudio.codec,'flac');assert.equal(value.actualAudio.codec,'flac');
  const counts=Object.fromEntries([...new Set(f.calls)].map(name=>[name,f.calls.filter(x=>x===name).length]));
  const safe={...value,handle:'合成句柄'};const hash=createHash('sha256').update(JSON.stringify(safe)).digest('hex');
  console.log(JSON.stringify({marker:'M63_BASELINE',counts,freshCount:f.stages.length,rangeCount:f.ranges.length,hash}));
  assert.deepEqual(counts,{detail:3,stream:3});assert.equal(f.stages.length,136);assert.equal(f.ranges.length,10);
  assert.equal(hash,'99b0411dfb136793c124907c027345b2b8ba80c67fab8a2fb64fad16ff81c131');
  assert.equal(f.physical(),0);assert.doesNotMatch(JSON.stringify(value),/https?:|credential|cookie/u);
});

test('M63 held stream期间detail已经完成，撤销/代际/元数据/媒体变化均不可发布旧事实',async t=>{
  for(const change of ['revoke','generationChange','metadataChange','mediaChange'] as const)await t.test(change,async child=>{
    const f=await fixture(child),g=change==='metadataChange'?f.holdDetail():f.holdStream();
    const work=f.invoke('exact').then(()=>null,e=>e);await g.began;await tick();f[change]();g.release();
    const error=await work;assert.ok(error instanceof MobileServiceError);assert.equal(error.code,'SOURCE_CHANGED');assert.equal(f.physical(),0);
  });
});

test('M63 abort/close期间保留真实SDK槽直至held支路落定，不发布结果',async t=>{
  for(const closing of [false,true])await t.test(String(closing),async child=>{
    const f=await fixture(child),g=f.holdDetail(),controller=new AbortController();let settled=false;
    const work=f.invoke('exact',controller.signal).then(()=>{settled=true;return null;},e=>{settled=true;return e;});
    await g.began;await tick();const close=closing?f.actual.close():undefined;if(!closing)controller.abort();await tick();
    assert.equal(f.physical(),1);assert.equal(settled,false);g.release();assert.ok(await work instanceof MobileServiceError);await close;assert.equal(f.physical(),0);
  });
});

test('M63 stream先失败仍等detail收口；Provider凭据换代不能发布旧请求',async t=>{
  for(const changed of [false,true])await t.test(String(changed),async child=>{
    const f=await fixture(child),g=f.holdDetail();if(!changed)f.failStream();let settled=false;
    const work=f.invoke('exact').then(()=>{settled=true;return null;},e=>{settled=true;return e;});
    await g.began;await tick();if(changed)f.providerGenerationChange();await tick();
    assert.equal(f.physical(),1);assert.equal(settled,false);g.release();
    const error=await work;assert.ok(error instanceof MobileServiceError);if(!changed)assert.equal(error.code,'SOURCE_CHANGED');
    assert.equal(f.physical(),0);
  });
});
