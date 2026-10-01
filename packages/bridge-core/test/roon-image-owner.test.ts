import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoonPublicLibrary, type RoonPublicLibraryOptions } from '../src/roon/public-library.js';
import { createRoonLibraryService } from '../src/roon/library.js';
import { withLibraryRead, assertLibraryReadCurrent, currentLibraryRead } from '../src/shared/library-read-lifetime.js';
const JPEG = Buffer.from([0xff,0xd8,0xff,0xe0,0,0x10,0x4a,0x46]);
const image = () => ({contentType:'image/jpeg',body:JPEG});
const turn = () => new Promise<void>(r=>setImmediate(r));
const pause = (ms:number) => new Promise<void>(r=>setTimeout(r,ms));
function fixture(options:RoonPublicLibraryOptions = {}) {
 const callbacks: Array<(error:string|false,type?:string,body?:Buffer)=>void> = [];
 const service = createRoonLibraryService({browse:{browse(){},load(){}},image:{get_image(_key,_options,callback){callbacks.push(callback)}},requestTimeoutMs:1000});
 service.browseArtists = async()=>({offset:0,level:0,items:[{kind:'artist',title:'合成艺人',itemKey:'synthetic-artist'}]});
 service.getArtistImageKey = async()=> 'same-private-key';
 const library = createRoonPublicLibrary(()=>service,options);
 return {library,service,callbacks,reference:library.registerNowPlayingArtwork('same-private-key')};
}
const read = <T>(signal:AbortSignal, ms:number, work:()=>T)=>withLibraryRead({signal,deadlineAtMs:Date.now()+ms,now:Date.now,isCurrent:()=>true},work);
const captured = <T>(promise:Promise<T>)=>promise.then(value=>({value}),error=>({error}));
const code = (v:unknown)=>v instanceof Error && 'code' in v?v.code:undefined;

test('MBP-007：不同公开alias同私有key取消首消费者不取消其他',async()=>{
 const f=fixture(); const alias=(await f.library.browseArtists({offset:0,limit:20})).items[0]!.reference;
 const a=new AbortController(),b=new AbortController();
 const first=captured(read(a.signal,1000,()=>f.library.getImage(f.reference)));
 const second=captured(read(b.signal,1000,()=>f.library.getImage(alias))); await turn(); a.abort(); await turn();
 f.callbacks[0]!(false,'image/jpeg',JPEG);
 const [one,two]=await Promise.all([first,second]); assert.equal(code('error' in one?one.error:undefined),'READ_CANCELLED'); assert.ok('value' in two,'第二消费者必须继续成功'); assert.equal(f.callbacks.length,1);
});
test('MBP-007：首消费者短deadline不能成为共享SDK期限',async()=>{
 const f=fixture();const alias=(await f.library.browseArtists({offset:0,limit:20})).items[0]!.reference;
 const first=captured(read(new AbortController().signal,15,()=>f.library.getImage(f.reference)));
 const second=captured(read(new AbortController().signal,1000,()=>f.library.getImage(alias)));
 await pause(30); f.callbacks[0]!(false,'image/jpeg',JPEG);
 const [one,two]=await Promise.all([first,second]); assert.equal(code('error' in one?one.error:undefined),'READ_DEADLINE');assert.ok('value' in two);assert.equal(f.callbacks.length,1);
});
test('MBP-007：cache hit必须先检查当前消费者取消',async()=>{
 const f=fixture();const warm=f.library.getImage(f.reference); f.callbacks[0]!(false,'image/jpeg',JPEG);await warm;
 const controller=new AbortController();let pending!:Promise<unknown>;
 read(controller.signal,1000,()=>{controller.abort();pending=f.library.getImage(f.reference)});
 await assert.rejects(pending,e=>code(e)==='READ_CANCELLED');
});
test('MBP-007：最后消费者取消立即结束本地等待且迟到不warm',async()=>{
 const f=fixture(); const pending: Array<(v:ReturnType<typeof image>)=>void>=[];f.service.getImage=()=>new Promise(r=>pending.push(r));
 const controller=new AbortController();const old=captured(read(controller.signal,1000,()=>f.library.getImage(f.reference)));await turn();controller.abort();
 const early=await Promise.race([old,pause(20).then(()=>null)]);pending[0]!(image());await old;
 const next=f.library.getImage(f.reference);await turn();pending[1]?.(image());await next;assert.notEqual(early,null,'不能等待无法取消的底层Promise');assert.equal(pending.length,2);
});
test('MBP-007：negative负年龄不得fresh',async()=>{
 let now=1000,calls=0;const f=fixture({now:()=>now});f.service.getImage=async()=>{calls++;throw new Error('合成失败')};
 await assert.rejects(f.library.getImage(f.reference));now=900;await assert.rejects(f.library.getImage(f.reference));assert.equal(calls,2);
});
test('MBP-007：negative128条目有界',async()=>{
 let calls=0;const f=fixture();f.service.getImage=async()=>{calls++;throw new Error('合成失败')};
 for(let i=0;i<129;i++)await assert.rejects(f.library.getImage(f.library.registerNowPlayingArtwork(`negative-${i}`)));
 await assert.rejects(f.library.getImage(f.library.registerNowPlayingArtwork('negative-0')));assert.equal(calls,130);
});
test('MBP-007：逻辑flight32预算拒绝第33个未结算工作',async()=>{
 const f=fixture();const held:Array<(v:ReturnType<typeof image>)=>void>=[];f.service.getImage=()=>new Promise(r=>held.push(r));
 const reads=Array.from({length:33},(_,i)=>captured(f.library.getImage(f.library.registerNowPlayingArtwork(`flight-${i}`))));await turn();
 const overflow=await Promise.race([reads[32],pause(20).then(()=>null)]);for(const finish of held)finish(image());await Promise.all(reads);assert.notEqual(overflow,null);assert.ok(overflow&&'error' in overflow);assert.equal(held.length,32);
});
test('MBP-007：subscriber256预算拒绝同key第257个等待者',async()=>{
 const f=fixture();const reads=Array.from({length:257},()=>captured(f.library.getImage(f.reference)));await turn();
 const overflow=await Promise.race([reads[256],pause(20).then(()=>null)]);f.callbacks[0]!(false,'image/jpeg',JPEG);await Promise.all(reads);assert.notEqual(overflow,null);assert.ok(overflow&&'error' in overflow);assert.equal(f.callbacks.length,1);
});

const errorCode = (outcome:{error:unknown}|{value:unknown}) => 'error' in outcome ? code(outcome.error) : undefined;
test('MBP-007：第二消费者取消不取消首消费者，成功二进制各自clone',async()=>{
 const f=fixture(),a=new AbortController(),b=new AbortController();
 const first=read(a.signal,1000,()=>f.library.getImage(f.reference));const cancelled=captured(read(b.signal,1000,()=>f.library.getImage(f.reference)));b.abort();
 f.callbacks[0]!(false,'image/jpeg',JPEG);const good=await first;assert.equal(errorCode(await cancelled),'READ_CANCELLED');
 good.body[0]=0;const cached=await f.library.getImage(f.reference);assert.equal(cached.body[0],0xff);assert.equal(f.callbacks.length,1);
});
test('MBP-007：首消费者currentness失效不废弃仍有效第二消费者',async()=>{
 const f=fixture();let valid=true;
 const first=captured(withLibraryRead({signal:new AbortController().signal,deadlineAtMs:Date.now()+1000,now:Date.now,isCurrent:()=>valid},()=>f.library.getImage(f.reference)));
 const second=f.library.getImage(f.reference);valid=false;f.callbacks[0]!(false,'image/jpeg',JPEG);
 assert.equal(errorCode(await first),'READ_CANCELLED');assert.deepEqual((await second).body,new Uint8Array(JPEG));
});
test('MBP-007：artist key解析自有ALS，取消一个保留其他并共享二进制',async()=>{
 const f=fixture(),alias=(await f.library.browseArtists({offset:0,limit:20})).items[0]!.reference;
 let finish!:(key:string)=>void,lookups=0;const lifetimes:Array<ReturnType<typeof currentLibraryRead>>=[];
 f.service.getArtistImageKey=async()=>{lookups++;lifetimes.push(currentLibraryRead());const key=await new Promise<string>(r=>finish=r);assertLibraryReadCurrent();return key};
 const a=new AbortController(),first=captured(read(a.signal,1000,()=>f.library.getImage(alias)));const second=f.library.getImage(alias);a.abort();finish('same-private-key');await turn();f.callbacks[0]!(false,'image/jpeg',JPEG);
 assert.equal(errorCode(await first),'READ_CANCELLED');assert.deepEqual((await second).body,new Uint8Array(JPEG));assert.equal(lookups,1);assert.notEqual(lifetimes[0]!.signal,a.signal);
});
test('MBP-007：artist最后取消不写图片key映射或negative',async()=>{
 const f=fixture(),alias=(await f.library.browseArtists({offset:0,limit:20})).items[0]!.reference;
 const finish:Array<(key:string)=>void>=[];f.service.getArtistImageKey=()=>new Promise(r=>finish.push(r));
 const a=new AbortController(),old=captured(read(a.signal,1000,()=>f.library.getImage(alias)));a.abort();await old;finish[0]!('late-key');await turn();
 const fresh=f.library.getImage(alias);assert.equal(finish.length,2);finish[1]!('same-private-key');await turn();f.callbacks[0]!(false,'image/jpeg',JPEG);await fresh;
});
test('MBP-007：logical timeout结束等待，迟到合法结果不warm',async()=>{
 const f=fixture({imageReadTimeoutMs:15}),held:Array<(v:ReturnType<typeof image>)=>void>=[];f.service.getImage=()=>new Promise(r=>held.push(r));
 await assert.rejects(f.library.getImage(f.reference),e=>code(e)==='READ_DEADLINE');held[0]!(image());await turn();
 const next=f.library.getImage(f.reference);assert.equal(held.length,2);held[1]!(image());await next;
});
test('MBP-007：artist解析与binary共享消费者总意图期限',async()=>{
 const f=fixture({imageReadTimeoutMs:35}),alias=(await f.library.browseArtists({offset:0,limit:20})).items[0]!.reference;
 f.service.getArtistImageKey=async()=>{await pause(25);return 'same-private-key'};
 const old=captured(f.library.getImage(alias));await pause(45);assert.equal(errorCode(await old),'READ_DEADLINE');
 f.callbacks[0]!(false,'image/jpeg',JPEG);await turn();const fresh=f.library.getImage(alias);await turn();assert.equal(f.callbacks.length,2);f.callbacks[1]!(false,'image/jpeg',JPEG);await fresh;
});
test('MBP-007：clear旧成功不warm、不删除新flight，旧消费者立即取消',async()=>{
 const f=fixture(),held:Array<(v:ReturnType<typeof image>)=>void>=[];f.service.getImage=()=>new Promise(r=>held.push(r));
 const old=captured(f.library.getImage(f.reference));f.library.invalidateReferences();const ref=f.library.registerNowPlayingArtwork('same-private-key'),fresh=f.library.getImage(ref);
 held[0]!(image());await turn();const shared=f.library.getImage(ref);assert.equal(held.length,2);held[1]!(image());await Promise.all([fresh,shared]);
 assert.equal(errorCode(await old),'READ_CANCELLED');await f.library.getImage(ref);assert.equal(held.length,2);
});
test('MBP-007：service换代且旧对象回调迟到不写新缓存',async()=>{
 const old=fixture(),held:Array<(v:ReturnType<typeof image>)=>void>=[];old.service.getImage=()=>new Promise(r=>held.push(r));
 let current=old.service;const library=createRoonPublicLibrary(()=>current),staleRef=library.registerNowPlayingArtwork('same-private-key'),stale=captured(library.getImage(staleRef));
 const next=fixture();current=next.service;const ref=library.registerNowPlayingArtwork('same-private-key'),fresh=library.getImage(ref);held[0]!(image());next.callbacks[0]!(false,'image/jpeg',JPEG);await fresh;
 assert.ok('error' in await stale);await assert.rejects(library.getImage(staleRef));await library.getImage(ref);assert.equal(next.callbacks.length,1);
});
test('MBP-007：negative TTL边界3s及命中前权限检查',async()=>{
 let now=1000,calls=0;const f=fixture({now:()=>now});f.service.getImage=async()=>{calls++;throw new Error('合成失败')};
 await assert.rejects(f.library.getImage(f.reference));now=3999;await assert.rejects(f.library.getImage(f.reference));assert.equal(calls,1);now=4000;await assert.rejects(f.library.getImage(f.reference));assert.equal(calls,2);
 const a=new AbortController();let revoked!:Promise<unknown>;read(a.signal,1000,()=>{a.abort();revoked=f.library.getImage(f.reference)});await assert.rejects(revoked,e=>code(e)==='READ_CANCELLED');assert.equal(calls,2);
});
test('MBP-007：默认128缓存条目LRU，超单图片4MiB拒绝且不缓存',async()=>{
 const f=fixture(),calls:string[]=[];f.service.getImage=async key=>{calls.push(key);return image()};
 for(let i=0;i<129;i++)await f.library.getImage(f.library.registerNowPlayingArtwork(`lru-${i}`));
 await f.library.getImage(f.library.registerNowPlayingArtwork('lru-0'));assert.equal(calls.length,130);
 let malformedCalls=0;f.service.getImage=async()=>{malformedCalls++;return {contentType:'image/jpeg',body:Buffer.alloc(4*1024*1024+1)}};
 const large=f.library.registerNowPlayingArtwork('too-large');await assert.rejects(f.library.getImage(large),e=>code(e)==='ROON_IMAGE_DECODE_FAILED');await assert.rejects(f.library.getImage(large));assert.equal(malformedCalls,1);
});
test('MBP-007：取消32个Service本地等待不归还真实SDK32，callback恰好一次归还',async()=>{
 const held:Array<(error:string|false,type?:string,body?:Buffer)=>void>=[],service=createRoonLibraryService({browse:{browse(){},load(){}},image:{get_image(_key,_options,callback){held.push(callback)}},requestTimeoutMs:1000});
 const controllers=Array.from({length:32},()=>new AbortController()),reads=controllers.map((a,i)=>captured(read(a.signal,1000,()=>service.getImage(`key-${i}`))));controllers.forEach(a=>a.abort());await Promise.all(reads);
 await assert.rejects(service.getImage('overflow'),/预算/u);assert.equal(held.length,32);held[0]!(false,'image/jpeg',JPEG);held[0]!(false,'image/jpeg',JPEG);
 const next=service.getImage('after-callback');assert.equal(held.length,33);await assert.rejects(service.getImage('still-full'),/预算/u);held[32]!(false,'image/jpeg',JPEG);await next;for(const callback of held.slice(1,32))callback(false,'image/jpeg',JPEG);
});
test('MBP-007：Service本地超时也保留真实SDK32直到迟到callback',async()=>{
 const held:Array<(error:string|false,type?:string,body?:Buffer)=>void>=[],service=createRoonLibraryService({browse:{browse(){},load(){}},image:{get_image(_key,_options,callback){held.push(callback)}},requestTimeoutMs:10});
 const settled=await Promise.all(Array.from({length:32},(_,i)=>captured(service.getImage(`timeout-${i}`))));assert.ok(settled.every(v=>'error' in v));
 await assert.rejects(service.getImage('overflow'),/预算/u);held[0]!(false,'image/jpeg',JPEG);const next=service.getImage('new-after-return');held[32]!(false,'image/jpeg',JPEG);await next;for(const callback of held.slice(1,32))callback(false,'image/jpeg',JPEG);
});
test('MBP-007：32个取消或clear的未结算Promise仍占logical预算直到实际结算',async()=>{
 const f=fixture(),held:Array<(v:ReturnType<typeof image>)=>void>=[],controllers=Array.from({length:32},()=>new AbortController());f.service.getImage=()=>new Promise(r=>held.push(r));
 const reads=controllers.map((a,i)=>captured(read(a.signal,1000,()=>f.library.getImage(f.library.registerNowPlayingArtwork(`held-${i}`)))));controllers.forEach(a=>a.abort());await Promise.all(reads);f.library.invalidateReferences();
 const ref=f.library.registerNowPlayingArtwork('after-clear');await assert.rejects(f.library.getImage(ref),/预算/u);assert.equal(held.length,32);
 held[0]!(image());await turn();const next=f.library.getImage(ref);assert.equal(held.length,33);held[32]!(image());await next;for(const finish of held.slice(1,32))finish(image());await turn();
});
test('MBP-007：真实SDK忙不negative，callback释放后同图片可立即重试',async()=>{
 const f=fixture(),controllers=Array.from({length:32},()=>new AbortController());const held=controllers.map((a,i)=>captured(read(a.signal,1000,()=>f.service.getImage(`held-${i}`))));controllers.forEach(a=>a.abort());await Promise.all(held);
 await assert.rejects(f.library.getImage(f.reference),/request failed/u);f.callbacks[0]!(false,'image/jpeg',JPEG);
 const retry=f.library.getImage(f.reference);assert.equal(f.callbacks.length,33);f.callbacks[32]!(false,'image/jpeg',JPEG);await retry;for(const callback of f.callbacks.slice(1,32))callback(false,'image/jpeg',JPEG);
});
test('MBP-007：默认缓存实际压缩bytes32MiB预算保留，不靠条目数代替',async()=>{
 const f=fixture();let calls=0;const big=Buffer.alloc(4*1024*1024);JPEG.copy(big);f.service.getImage=async()=>{calls++;return {contentType:'image/jpeg',body:big}};
 for(let i=0;i<9;i++)await f.library.getImage(f.library.registerNowPlayingArtwork(`bytes-${i}`));
 await f.library.getImage(f.library.registerNowPlayingArtwork('bytes-8'));assert.equal(calls,9);
 await f.library.getImage(f.library.registerNowPlayingArtwork('bytes-0'));assert.equal(calls,10);
});
test('MBP-007：首消费者deadline时钟跃迁保留其他消费者并准确回执deadline',async()=>{
 const f=fixture();let now=Date.now();const first=captured(withLibraryRead({signal:new AbortController().signal,deadlineAtMs:now+1000,now:()=>now,isCurrent:()=>true},()=>f.library.getImage(f.reference)));
 const second=f.library.getImage(f.reference);now+=1001;f.callbacks[0]!(false,'image/jpeg',JPEG);assert.equal(errorCode(await first),'READ_DEADLINE');await second;
});
test('MBP-007：32个artist resolver真实结算后可进入binary，不被回执微任务误判预算忙',async()=>{
 const f=fixture();f.service.browseArtists=async()=>({offset:0,level:0,items:Array.from({length:32},(_,i)=>({kind:'artist',title:`合成艺人${i}`,itemKey:`artist-${i}`}))});
 f.service.getArtistImageKey=async artist=>artist.itemKey;
 const page=await f.library.browseArtists({offset:0,limit:32}),reads=page.items.map(item=>captured(f.library.getImage(item.reference)));await turn();
 for(const callback of f.callbacks)callback(false,'image/jpeg',JPEG);const outcomes=await Promise.all(reads);assert.equal(f.callbacks.length,32);assert.ok(outcomes.every(outcome=>'value' in outcome));
});
test('MBP-007：默认owned期限固定10s且不继承首消费者期限或信号',async()=>{
 const f=fixture({now:()=>5000});let owner:ReturnType<typeof currentLibraryRead>;f.service.getImage=async()=>{owner=currentLibraryRead();return image()};
 const parent=new AbortController();await read(parent.signal,1000,()=>f.library.getImage(f.reference));assert.equal(owner!.deadlineAtMs,15000);assert.equal(owner!.now(),5000);assert.notEqual(owner!.signal,parent.signal);
});
test('MBP-007：合法单图超过配置缓存预算仍returned-notcached，不negative或截断',async()=>{
 const f=fixture({maxImageCacheBytes:7});let calls=0;f.service.getImage=async()=>{calls++;return image()};
 const one=await f.library.getImage(f.reference),two=await f.library.getImage(f.reference);assert.deepEqual(one.body,new Uint8Array(JPEG));assert.deepEqual(two.body,one.body);assert.notEqual(one.body,two.body);assert.equal(calls,2);
});
