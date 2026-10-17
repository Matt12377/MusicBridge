import test from 'node:test'
import assert from 'node:assert/strict'
import { LOCAL_LYRICS_LIMITS, LOCAL_LYRICS_SOURCES } from '@music-bridge/contracts'
import { LocalLyricsProviderSession, parseLocalLyricsSearch, parseLocalLyricsBody, localLyricsMatchScore } from '../src/collection/local-library-lyrics/providers.js'
import type { LocalLyricsTrackCapture, LocalLyricsProviderTransportPort } from '../src/collection/local-library-lyrics/types.js'
const raw = (v: unknown): Uint8Array => Buffer.from(JSON.stringify(v))
const track: LocalLyricsTrackCapture = { trackId: 'track', title: '歌曲', artist: '艺人', album: '专辑', language: 'zh', version: 'original', durationMs: 120000, wholeTrack: false, format: 'flac', rootRevision: 'r', fileRevision: 'f', locationRevision: 'l', metadataRevision: 'm', lrc: 'false', embedded: 'false' }
const lrc = '[00:01.00]第一句\n[00:02.00]第二句'
const fixtures = {
  netease: { search: { result: { songs: [{ id: 1, name: track.title, ar: [{ name: track.artist }], al: { name: track.album }, dt: 120000, language: 'zh' }] } }, body: { lrc: { lyric: lrc } } },
  qq: { search: { data: { song: { list: [{ mid: 'mid', name: track.title, singer: [{ name: track.artist }], album: { name: track.album }, interval: 120, language: 'zh' }] } } }, body: { lyric: Buffer.from(lrc).toString('base64') } },
  kugou: { search: { data: { info: [{ hash: 'hash', songname: track.title, singername: track.artist, album_name: track.album, duration: 120, language: 'zh' }] } }, body: { content: Buffer.from(lrc).toString('base64') } },
  kuwo: { search: { data: { list: [{ rid: 1, name: track.title, artist: track.artist, album: track.album, duration: 120, language: 'zh' }] } }, body: { data: { lrclist: [{ time: '1', lineLyric: '第一句' }, { time: '2', lineLyric: '第二句' }] } } },
  lrclib: { search: [{ id: 1, trackName: track.title, artistName: track.artist, albumName: track.album, duration: 120, language: 'zh', syncedLyrics: lrc }], body: { syncedLyrics: lrc } },
}
test('五歌词来源分别解析原响应和正文并保完整UTF8身份', async () => {
  const joins: AbortSignal[] = []
  const port: LocalLyricsProviderTransportPort = { async request(s, op) { return raw(fixtures[s][op]) }, async join(s) { joins.push(s) } }
  const session = new LocalLyricsProviderSession(port, () => 0)
  const r = await session.track(track, new AbortController().signal)
  assert.equal(r.candidates.length, 5); assert.equal(joins.length, 5)
  assert.deepEqual(r.sources.map(s => s.state), Array(5).fill('ok'))
  for (const c of r.candidates) { assert.equal(c.body, lrc); assert.equal(c.view.score, 100); assert.equal('id' in c.view, false) }
  assert.equal(new Set(r.candidates.map(c => c.view.candidateId)).size, 5)
})
test('歌词来源独立失败不泄原异常也不丢其他来源候选', async () => {
  const port: LocalLyricsProviderTransportPort = { async request(s, op) { if (s === 'qq') throw new Error('/private/provider Cookie=secret'); return raw(fixtures[s][op]) }, async join() {} }
  const r = await new LocalLyricsProviderSession(port, () => 0).track(track, new AbortController().signal)
  assert.equal(r.candidates.length, 4); assert.equal(r.sources.find(s => s.source === 'qq')?.state, 'failed'); assert.equal(JSON.stringify(r).includes('secret'), false)
})
test('歌词语言版本live与时长不匹配拒绝自动推荐', () => {
  const s = parseLocalLyricsSearch('lrclib', fixtures.lrclib.search)[0]!
  assert.equal(localLyricsMatchScore(track, { ...s, durationMs: 130000 }), 0)
  assert.equal(localLyricsMatchScore(track, { ...s, language: 'en' }), 0)
  assert.equal(localLyricsMatchScore(track, { ...s, version: 'live' }), 0)
  assert.ok(localLyricsMatchScore({ ...track, durationMs: null }, s) < 95)
  assert.throws(() => parseLocalLyricsSearch('netease', { error: 'private' }))
})
test('歌词整个session共享每源12与总60候选预算而非每曲重置', async () => {
  const calls: string[] = []
  const port: LocalLyricsProviderTransportPort = { async request(s, op) { calls.push(s); if (op === 'search') { const song = fixtures[s].search; if (s === 'lrclib') return raw(Array.from({ length: 13 }, (_, i) => ({ ...fixtures.lrclib.search[0], id: i }))); return raw(song) } return raw(fixtures[s].body) }, async join() {} }
  const p = new LocalLyricsProviderSession(port, () => 0)
  const first = await p.track(track, new AbortController().signal)
  assert.equal(first.candidates.filter(c => c.view.source === 'lrclib').length, 12)
  const count = calls.filter(s => s === 'lrclib').length
  const second = await p.track({ ...track, trackId: 'second' }, new AbortController().signal)
  assert.equal(second.sources.find(s => s.source === 'lrclib')?.state, 'budget'); assert.equal(calls.filter(s => s === 'lrclib').length, count)
  assert.ok(first.candidates.length + second.candidates.length <= 60)
})
test('歌词source raw和正文限额拒绝且Base64非法UTF8不被替换', async () => {
  for (const tooLarge of [false, true]) {
    const port: LocalLyricsProviderTransportPort = { async request() { return tooLarge ? new Uint8Array(LOCAL_LYRICS_LIMITS.sourceRawBytes + 1) : raw([{ ...fixtures.lrclib.search[0], syncedLyrics: '字'.repeat(22000) }]) }, async join() {} }
    const r = await new LocalLyricsProviderSession(port, () => 0).track(track, new AbortController().signal)
    assert.equal(r.candidates.length, 0)
  }
  assert.throws(() => parseLocalLyricsBody('qq', { lyric: Buffer.from([0xc3, 0x28]).toString('base64') }))
  assert.throws(() => parseLocalLyricsBody('kugou', { content: 'YQ===' }))
})
test('歌词15秒异步期限取消实际请求并join不逐body重置', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let now = 0, aborted = 0, joined = 0
  const port: LocalLyricsProviderTransportPort = { request(_s, _op, _input, signal) { return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { aborted++; reject(new Error('abort')) }, { once: true }) }) }, async join() { joined++ } }
  const pending = new LocalLyricsProviderSession(port, () => now).track(track, new AbortController().signal)
  now = 15000; t.mock.timers.tick(15000)
  const r = await pending
  assert.equal(aborted, 5); assert.equal(joined, 5); assert.equal(r.candidates.length, 0)
  assert.deepEqual(r.sources.map(s => s.state), Array(LOCAL_LYRICS_SOURCES.length).fill('budget'))
})
test('歌词一个来源join失败仍等待其他四个关闭而不提前发布', async t => {
  const sources = new Map<AbortSignal, string>()
  let release!: () => void, entered!: () => void
  const waiting = new Promise<void>(r => { entered = r }), held = new Promise<void>(r => { release = r })
  t.after(() => release())
  const port: LocalLyricsProviderTransportPort = { async request(source, operation, _input, signal) { sources.set(signal, source); return raw(fixtures[source][operation]) }, async join(signal) { if (sources.get(signal) === 'netease') throw new Error('close failure'); if (sources.get(signal) === 'qq') { entered(); await held } } }
  const pending = new LocalLyricsProviderSession(port, () => 0).track(track, new AbortController().signal)
  const rejected = assert.rejects(pending, /CLOSED/u)
  let settled = false; void pending.finally(() => { settled = true }).catch(() => {})
  await waiting; await new Promise<void>(r => setImmediate(r)); assert.equal(settled, false)
  release(); await rejected
})


/** 受控私有transport规范化形状，不将真实平台身份或公开URL交给Core候选。 */
function searches(source:typeof LOCAL_LYRICS_SOURCES[number],count:number):unknown {
  switch(source){
    case 'netease':return {result:{songs:Array.from({length:count},(_,i)=>({...fixtures.netease.search.result.songs[0],id:i+1}))}};
    case 'qq':return {data:{song:{list:Array.from({length:count},(_,i)=>({...fixtures.qq.search.data.song.list[0],mid:'mid-'+i}))}}};
    case 'kugou':return {data:{info:Array.from({length:count},(_,i)=>({...fixtures.kugou.search.data.info[0],hash:'hash-'+i}))}};
    case 'kuwo':return {data:{list:Array.from({length:count},(_,i)=>({...fixtures.kuwo.search.data.list[0],rid:i+1}))}};
    case 'lrclib':return Array.from({length:count},(_,i)=>({...fixtures.lrclib.search[0],id:i+1}));
  }
}

test('QQ明确单首无词code -1901保来源ok并继续同源正常第二候选',async()=>{
  const ids:string[]=[],joins:AbortSignal[]=[];
  const port:LocalLyricsProviderTransportPort={async request(source,operation,input){if(operation==='search')return raw(searches(source,source==='qq'?2:0));const id='id'in input?input.id:'';ids.push(id);return raw(id==='mid-0'?{code:-1901}:{code:0,lyric:Buffer.from(lrc).toString('base64')});},async join(signal){joins.push(signal)}};
  const result=await new LocalLyricsProviderSession(port,()=>0).track(track,new AbortController().signal);
  assert.equal(parseLocalLyricsBody('qq',{code:-1901}),'');assert.deepEqual(ids,['mid-0','mid-1']);assert.equal(result.candidates.length,1);assert.equal(result.candidates[0]!.view.source,'qq');assert.equal(result.candidates[0]!.body,lrc);assert.equal(result.sources.find(s=>s.source==='qq')!.state,'ok');assert.equal(joins.length,5);
});

test('无词仅跳过明确空正文，坏协议Base64或空白正文仍失败且不吞后续错误',async()=>{
  for(const body of [{code:-1902},{code:0},{code:0,lyric:'YQ==='},{code:0,lyric:Buffer.from(' \n').toString('base64')},{code:-1901,lyric:Buffer.from(lrc).toString('base64')}]){
    const ids:string[]=[];const port:LocalLyricsProviderTransportPort={async request(source,operation,input){if(source!=='qq')return raw(fixtures[source][operation]);if(operation==='search')return raw(searches('qq',3));const id='id'in input?input.id:'';ids.push(id);return raw(id==='mid-0'?{code:-1901}:body)},async join(){}};
    const result=await new LocalLyricsProviderSession(port,()=>0).track(track,new AbortController().signal);assert.deepEqual(ids,['mid-0','mid-1']);assert.equal(result.sources.find(s=>s.source==='qq')!.state,'failed');assert.equal(result.candidates.filter(c=>c.view.source==='qq').length,0);assert.equal(result.candidates.length,4);
  }
  for(const source of LOCAL_LYRICS_SOURCES)assert.throws(()=>parseLocalLyricsBody(source,{unexpected:'坏协议'}));
});

test('跳过无词仍共享每源12总60及1MiB raw与64KiB正文边界',async()=>{
  const calls:string[]=[],joins:AbortSignal[]=[];const port:LocalLyricsProviderTransportPort={async request(source,operation,input){calls.push(source+':'+operation);if(operation==='search')return raw(searches(source,source==='qq'?14:13));return raw(source==='qq'&&'id'in input&&input.id==='mid-0'?{code:-1901}:fixtures[source].body)},async join(signal){joins.push(signal)}};
  const session=new LocalLyricsProviderSession(port,()=>0),first=await session.track(track,new AbortController().signal);assert.equal(first.candidates.length,60);for(const source of LOCAL_LYRICS_SOURCES)assert.equal(first.candidates.filter(c=>c.view.source===source).length,12);assert.equal(joins.length,5);const before=calls.length;
  assert.deepEqual((await session.track({...track,trackId:'second'},new AbortController().signal)).sources.map(s=>s.state),Array(5).fill('budget'));assert.equal(calls.length,before);
  for(const size of [LOCAL_LYRICS_LIMITS.bodyBytes,LOCAL_LYRICS_LIMITS.bodyBytes+1]){
    const body='a'.repeat(size);const limited:LocalLyricsProviderTransportPort={async request(source,operation,input){if(operation==='search')return raw(searches(source,source==='qq'?2:0));return raw('id'in input&&input.id==='mid-0'?{code:-1901}:{code:0,lyric:Buffer.from(body).toString('base64')})},async join(){}};
    const r=await new LocalLyricsProviderSession(limited,()=>0).track(track,new AbortController().signal);assert.equal(r.candidates.length,size===LOCAL_LYRICS_LIMITS.bodyBytes?1:0);if(r.candidates.length)assert.equal(Buffer.byteLength(r.candidates[0]!.body),size);else assert.equal(r.sources.find(s=>s.source==='qq')!.state,'failed');
  }
  const search=raw(searches('qq',2)),empty={code:-1901,padding:''};empty.padding='x'.repeat(LOCAL_LYRICS_LIMITS.sourceRawBytes-search.byteLength-raw(empty).byteLength);let bodyCalls=0;
  const limited:LocalLyricsProviderTransportPort={async request(source,operation){if(operation==='search')return source==='qq'?search:raw(searches(source,0));bodyCalls++;return raw(bodyCalls===1?empty:fixtures.qq.body)},async join(){}};
  const r=await new LocalLyricsProviderSession(limited,()=>0).track(track,new AbortController().signal);assert.equal(bodyCalls,2);assert.equal(r.candidates.length,0);assert.equal(r.sources.find(s=>s.source==='qq')!.state,'budget');assert.equal(LOCAL_LYRICS_LIMITS.sessionBodyBytes,8*1024*1024);assert.equal(LOCAL_LYRICS_LIMITS.providerMs,15000);
});

test('无词后下一正文取消仍实际abort并等同源join完成才发布',async t=>{
  const controller=new AbortController();let entered!:()=>void,released!:()=>void;const stage=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>released=r);let aborted=0,joined=0,settled=false;const signals=new Map<AbortSignal,string>();
  t.after(()=>{controller.abort();released()});const port:LocalLyricsProviderTransportPort={async request(source,operation,input,signal){signals.set(signal,source);if(operation==='search')return raw(searches(source,source==='qq'?2:0));if('id'in input&&input.id==='mid-0')return raw({code:-1901});entered();return new Promise<Uint8Array>((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted++;reject(new Error('受控取消'))},{once:true}));},async join(signal){joined++;if(signals.get(signal)==='qq')await held}};
  const pending=new LocalLyricsProviderSession(port,()=>0).track(track,controller.signal);void pending.finally(()=>{settled=true}).catch(()=>{});
  await Promise.race([stage,pending.then(()=>{throw new Error('未到达无词后的正文请求')})]);controller.abort();await new Promise<void>(r=>setImmediate(r));assert.equal(aborted,1);assert.equal(settled,false);assert.equal(joined,5);released();const result=await pending;assert.equal(result.sources.find(s=>s.source==='qq')!.state,'cancelled');assert.equal(result.candidates.length,0);assert.ok([...signals.keys()].every(s=>s.aborted));
});

test('无词阶段消耗原15秒期限，下一正文不重置source异步时钟',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const controller=new AbortController();let now=0,entered!:()=>void,aborted=0,joined=0;const stage=new Promise<void>(r=>entered=r);t.after(()=>controller.abort());
  const port:LocalLyricsProviderTransportPort={async request(source,operation,input,signal){if(operation==='search')return raw(searches(source,source==='qq'?2:0));if('id'in input&&input.id==='mid-0'){now=14000;t.mock.timers.tick(14000);return raw({code:-1901})}entered();return new Promise<Uint8Array>((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted++;reject(new Error('单源期限到达'))},{once:true}));},async join(){joined++}};
  const pending=new LocalLyricsProviderSession(port,()=>now).track(track,controller.signal);await Promise.race([stage,pending.then(()=>{throw new Error('下一正文未实际受理')})]);now=14999;t.mock.timers.tick(999);assert.equal(aborted,0);now=15000;t.mock.timers.tick(1);const result=await pending;assert.equal(aborted,1);assert.equal(joined,5);assert.equal(result.sources.find(s=>s.source==='qq')!.state,'budget');assert.equal(result.candidates.length,0);
});


test('原source剩余期限传第五私有context，跨track新signal及后续无词body都不续期',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const base=1700000000000;let now=0,wall=base,searchesQQ=0;const requests:{operation:string;signal:AbortSignal;expiresAtMs:number}[]=[];t.mock.method(Date,'now',()=>wall);
  function advance(value:number){t.mock.timers.tick(value-now);now=value;wall=base+now}
  const port:LocalLyricsProviderTransportPort={async request(source,operation,input,signal,context){assert.ok(context);assert.ok(Number.isSafeInteger(context.expiresAtMs));assert.ok(context.expiresAtMs>Date.now());if(source!=='qq')return raw(searches(source,0));requests.push({operation,signal,expiresAtMs:context.expiresAtMs});if(operation==='search'){searchesQQ++;advance(searchesQQ===1?3000:10000);return raw(searches('qq',2))}if('id'in input&&input.id==='mid-0'){advance(searchesQQ===1?7000:12000);return raw({code:-1901})}return raw(fixtures.qq.body)},async join(){}};
  const session=new LocalLyricsProviderSession(port,()=>now),first=await session.track(track,new AbortController().signal);assert.equal(first.candidates.length,1);advance(9000);
  const second=await session.track({...track,trackId:'next'},new AbortController().signal);assert.equal(second.candidates.length,1);assert.equal(requests.length,6);assert.equal(new Set(requests.map(r=>r.expiresAtMs)).size,1);assert.equal(requests[0]!.expiresAtMs,base+15000);assert.notEqual(requests[0]!.signal,requests[3]!.signal);
  assert.ok(requests.every(r=>r.signal.aborted));advance(15000);const count=requests.length;const third=await session.track({...track,trackId:'expired'},new AbortController().signal);assert.equal(third.sources.find(s=>s.source==='qq')!.state,'budget');assert.equal(requests.length,count);
});

test('非有限wall或已失效不足1ms的context在私有transport前拒绝，旧四参fixture继续兼容',async t=>{
  for(const bad of [Number.NaN,Number.POSITIVE_INFINITY,Number.MAX_SAFE_INTEGER]){
    let requests=0,joined=0;const clock=t.mock.method(Date,'now',()=>bad),port:LocalLyricsProviderTransportPort={async request(source){requests++;return raw(searches(source,0))},async join(){joined++}};
    try{const result=await new LocalLyricsProviderSession(port,()=>0).track(track,new AbortController().signal);assert.equal(requests,0);assert.equal(joined,5);assert.deepEqual(result.sources.map(s=>s.state),Array(5).fill('budget'));}finally{clock.mock.restore()}
  }
  let now=0,requests=0;const clock=t.mock.method(Date,'now',()=>{now+=14999.5;return 1700000000000+Math.floor(now)}),port:LocalLyricsProviderTransportPort={async request(source){requests++;return raw(searches(source,0))},async join(){}};
  try{assert.deepEqual((await new LocalLyricsProviderSession(port,()=>now).track(track,new AbortController().signal)).sources.map(s=>s.state),Array(5).fill('budget'));assert.equal(requests,0);}finally{clock.mock.restore()}
  const legacy:LocalLyricsProviderTransportPort={async request(source,operation,_input,_signal){return raw(fixtures[source][operation])},async join(){}};assert.equal((await new LocalLyricsProviderSession(legacy,()=>0).track(track,new AbortController().signal)).candidates.length,5);
});
