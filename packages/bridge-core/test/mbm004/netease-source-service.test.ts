import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { MobileTrack } from '@music-bridge/contracts';
import { createMobileNeteaseSourceService } from '../../src/mobile/netease-source-service.js';
import { MobilePlaybackError } from '../../src/mobile/playback-types.js';
import type { MobileContentScope } from '../../src/mobile/content-types.js';
import type { MobileNeteaseStreamLease, MobileNeteaseSourceLimits } from '../../src/mobile/netease-source-types.js';
import type { MobilePlaybackSourceRequest } from '../../src/mobile/source-types.js';

// 合成字节经真实头部解析；注入 lease 不冒充真实 Provider/网络/普通 App。
const scope:MobileContentScope={serverId:'server-1',datasetId:'dataset-1',deviceId:'device-1',deviceEpoch:1,accessGeneration:1,ownerEpoch:'owner-1',accountDomain:'account-1',providerEpoch:'provider-1'};
const RESOURCE1='00000000-0000-4000-8000-000000000001',RESOURCE2='00000000-0000-4000-8000-000000000002';
const READ1='00000000-0000-4000-8000-000000000101',READ2='00000000-0000-4000-8000-000000000102',READ3='00000000-0000-4000-8000-000000000103';
const request={resourceId:RESOURCE1,trackId:'track-1',versionId:'version-1',contentRevision:'content-1'};
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};}
function flac(){const b=Buffer.alloc(150000);b.write('fLaC');b[4]=0x80;b.writeUIntBE(34,5,3);b.writeUInt16BE(4096,8);b.writeUInt16BE(4096,10);b.writeBigUInt64BE(192000n<<44n|1n<<41n|23n<<36n|192000n,18);for(let i=42;i<b.length;i++)b[i]=i%251;return b;}
function fixture(t:TestContext,qualified=true,limits?:Partial<MobileNeteaseSourceLimits>){let clock=1000,active=true,version='version-1',generation=1,opens=0;
 const data=flac(),leases:MobileNeteaseStreamLease[]=[],released=new Set<MobileNeteaseStreamLease>(),readNames=new Set<string>();
 let releaseGate:ReturnType<typeof deferred<void>>|undefined;
 let openGate:ReturnType<typeof deferred<void>>|undefined,readGate:ReturnType<typeof deferred<void>>|undefined,closeFail=false,readCloseFail=false;
 const stream={async open(input:{selection:{trackId:string;source:'local'|'netease';versionId:string;contentRevision:string}}){opens++;
  const lease:MobileNeteaseStreamLease={account:{accountDomain:'account-1',providerEpoch:'provider-1'},selection:{...input.selection},sourceIdentity:'source-1',size:data.length,expiresAtMs:clock+300000,rangeSupported:true,
   async verify(){if(version!==input.selection.versionId)throw new MobilePlaybackError(409,'SOURCE_CHANGED');},async renew(){return{expiresAtMs:clock+300000};},
   async read(id,start,n){readNames.add(id);if(readGate)await readGate.promise;return data.slice(start,start+n);},async closeRead(id){if(readCloseFail)throw new Error('实际 read 尚未 quiet');readNames.delete(id);},
   async release(){if(releaseGate)await releaseGate.promise;if(closeFail)throw new Error('实际 release 尚未确认');released.add(lease);}};
  leases.push(lease);if(openGate)await openGate.promise;return lease;
 }};
 const track:MobileTrack={id:'track-1',source:'netease',sourceItemId:'song-1',albumId:'album-1',title:'合成曲',artists:['合成艺人'],versionId:'version-1',contentRevision:'content-1',editionLabel:'原发行',durationMs:1000,audio:{codec:'flac',container:'flac',sampleRateHz:192000,bitsPerSample:24,channels:2},availability:'available'};
 const service=createMobileNeteaseSourceService({account:{async current(){return{accountDomain:'account-1',providerEpoch:'provider-1'};}},
  catalog:{async resolveTrack(_s,selection){return{...track,id:selection.trackId,versionId:version};},async resolveAlbum(){throw new Error('本用例不请求专辑');}},streams:stream,
  async assertCurrent(s,stage){if(!active||s.providerEpoch!=='provider-1')throw new MobilePlaybackError(409,'SOURCE_CHANGED');if(s.deviceId==='device-1'&&s.deviceEpoch!==1)throw new MobilePlaybackError(403,'DEVICE_REVOKED');if(stage==='acquire'&&s.accessGeneration!==generation)throw new MobilePlaybackError(401,'UNAUTHORIZED');},isQualified:()=>qualified,nowMs:()=>clock,...(limits?{limits}:{})});
 t.after(async()=>{openGate?.resolve();readGate?.resolve();releaseGate?.resolve();if(!closeFail&&!service.resourceSnapshot().fatal){await service.close();assert.equal(service.resourceSnapshot().live,0);assert.equal(readNames.size,0);}});
 return{service,port:service.bind(scope),data,leases,released,readNames,opens:()=>opens,change:()=>{active=false;},version:()=>{version='version-2';},advance:(n:number)=>{clock+=n;},refresh:()=>{generation++;},openGate:()=>{openGate=deferred<void>();return openGate;},readGate:()=>{readGate=deferred<void>();return readGate;},failClose:()=>{closeFail=true;},restoreClose:()=>{closeFail=false;readCloseFail=false;},failReadClose:()=>{readCloseFail=true;},releaseGate:()=>{releaseGate=deferred<void>();return releaseGate;}};
}
test('真实 FLAC 头与精确目录一致后才 ready，Range 随机起点及连续块有界',async t=>{
 const f=fixture(t),p=await f.port.prepare(request,new AbortController().signal);assert.ok(!('preparing' in p));assert.equal(p.sourceAudio.sampleRateHz,192000);assert.equal(p.actualAudio.bitsPerSample,24);assert.equal(p.size,f.data.length);assert.equal(p.seekable,true);
 const bytes=await f.port.read(p.handle,READ1,100,65536,new AbortController().signal);assert.deepEqual(bytes,new Uint8Array(f.data.slice(100,65636)));
 const tail=await f.port.read(p.handle,READ1,65636,65536,new AbortController().signal);assert.deepEqual(tail,new Uint8Array(f.data.slice(65636,131172)));
 await assert.rejects(f.port.read(p.handle,READ2,0,65537,new AbortController().signal));
 await assert.rejects(f.port.read(p.handle,READ1,0,1,new AbortController().signal));
 await f.port.closeRead(p.handle,READ1);await f.port.release(p.handle);assert.equal(f.released.size,1);
});
test('同 handle 不跨设备/epoch/账户复用，正常 access refresh 保留原 lease',async t=>{
 const f=fixture(t),p=await f.port.prepare(request,new AbortController().signal);f.refresh();await f.port.verify(p.handle);
 const other=f.service.bind({...scope,deviceId:'device-2'});await assert.rejects(other.verify(p.handle),(e:unknown)=>e instanceof MobilePlaybackError&&e.status===404);
 const changed=f.service.bind({...scope,deviceEpoch:2});await assert.rejects(changed.verify(p.handle),(e:unknown)=>e instanceof MobilePlaybackError&&e.status===404);
 await assert.rejects(f.service.bind({...scope,accountDomain:'account-2'}).verify(p.handle),(e:unknown)=>e instanceof MobilePlaybackError&&e.status===404);
});
test('未资格零 open，版本变更和目录/实际音频不一致不 mint ready',async t=>{
 const f=fixture(t,false);assert.equal(f.service.qualified,false);await assert.rejects(f.port.prepare(request,new AbortController().signal),(e:unknown)=>e instanceof MobilePlaybackError&&e.code==='UNSUPPORTED_FORMAT');assert.equal(f.opens(),0);
 const g=fixture(t);g.version();await assert.rejects(g.port.prepare(request,new AbortController().signal),(e:unknown)=>e instanceof MobilePlaybackError&&e.code==='SOURCE_CHANGED');assert.equal(g.opens(),0);
});
test('准备取消后迟到 lease 实际释放，原 resource 不重开',async t=>{
 const f=fixture(t),gate=f.openGate(),controller=new AbortController();const preparing=f.port.prepare(request,controller.signal);await new Promise<void>(r=>setImmediate(r));controller.abort();
 await assert.rejects(preparing);const release=f.port.release(request.resourceId);gate.resolve();await release;assert.equal(f.released.size,1);
 await assert.rejects(f.port.prepare(request,new AbortController().signal),(e:unknown)=>e instanceof MobilePlaybackError&&e.code==='RESOURCE_RELEASED');assert.equal(f.opens(),1);
});
test('读取迟到时设备撤销拒绝 bytes，另一个资源独立存活并可释放',async t=>{
 const f=fixture(t),p=await f.port.prepare(request,new AbortController().signal),other=f.service.bind({...scope,deviceId:'device-2'});
 const q=await other.prepare({...request,resourceId:RESOURCE2},new AbortController().signal),gate=f.readGate();
 const read=f.port.read(p.handle,READ2,0,16,new AbortController().signal);await new Promise<void>(r=>setImmediate(r));const retirement=f.service.revokeDevice('device-1',1);gate.resolve();await assert.rejects(read);await retirement;
 await other.verify(q.handle);await other.release(q.handle);assert.equal(f.released.size,2);
});
test('原五分钟 lease 到期不复活，renew 使用实际新期限不延长十二小时上界',async t=>{
 const f=fixture(t),p=await f.port.prepare(request,new AbortController().signal);f.advance(299000);await f.port.renew(p.handle);f.advance(2000);await f.port.verify(p.handle);
 f.advance(300000);await assert.rejects(f.port.renew(p.handle),(e:unknown)=>e instanceof MobilePlaybackError&&e.code==='RESOURCE_EXPIRED');
});
test('closeRead 退休后不能复用 readId，release 真 quiet 前保持 live 容量',async t=>{
 const f=fixture(t),p=await f.port.prepare(request,new AbortController().signal);await f.port.read(p.handle,READ1,0,4,new AbortController().signal);await f.port.closeRead(p.handle,READ1);
 await assert.rejects(f.port.read(p.handle,READ1,4,4,new AbortController().signal),(e:unknown)=>e instanceof MobilePlaybackError&&e.code==='RESOURCE_RELEASED');
 const gate=f.readGate(),pending=f.port.read(p.handle,READ3,0,16,new AbortController().signal);await new Promise<void>(r=>setImmediate(r));const release=f.port.release(p.handle);
 assert.equal(f.service.resourceSnapshot().live,1);gate.resolve();await assert.rejects(pending);await release;assert.equal(f.service.resourceSnapshot().live,0);
});
test('实际 close 拒绝不报 retired，资格封闭且保护和容量保留',async t=>{
 const f=fixture(t),p=await f.port.prepare(request,new AbortController().signal);f.failClose();await assert.rejects(f.port.release(p.handle));assert.equal(f.service.qualified,false);assert.equal(f.service.resourceSnapshot().live,1);assert.equal(f.released.size,0);
 await assert.rejects(f.port.prepare({...request,resourceId:RESOURCE2},new AbortController().signal));await assert.rejects(f.service.close());
 // 受控端口清理其自身记录不冒充产品 quiet；产品仍为 fatal retained。
 f.restoreClose();for(const lease of f.leases)await lease.release();
});
test('原 Source UUID 与闭集规则拒绝扩展字段和别名，零打开资源',async t=>{
 const f=fixture(t);
 for(const invalid of [{...request,resourceId:'resource-1'},{...request,resourceId:RESOURCE1+'\n'},{...request,path:'/private'},{...request,acceptedProcessingModes:[]}]){
  await assert.rejects(f.port.prepare(invalid as unknown as MobilePlaybackSourceRequest,new AbortController().signal),(e:unknown)=>e instanceof MobilePlaybackError&&e.code==='INVALID_REQUEST');
 }
 assert.equal(f.opens(),0);const p=await f.port.prepare(request,new AbortController().signal);
 await assert.rejects(f.port.read(p.handle,'read-1',0,4,new AbortController().signal),(e:unknown)=>e instanceof MobilePlaybackError&&e.code==='INVALID_REQUEST');
});
test('异步后 lease 身份和原方法不变，变异拒绝且只用原 cleanup 引用',async t=>{
 for(const key of ['account','selection','sourceIdentity','size','rangeSupported','read','verify','renew','closeRead','release','expiresAtMs'] as const){
  const f=fixture(t),p=await f.port.prepare(request,new AbortController().signal),lease=f.leases[0]!;
  const changed={account:{accountDomain:'account-2',providerEpoch:'provider-1'},selection:{...lease.selection,versionId:'version-2'},sourceIdentity:'source-2',size:lease.size+1,rangeSupported:false,read:async()=>new Uint8Array(4),verify:async()=>{},renew:async()=>({expiresAtMs:1234}),closeRead:async()=>{},release:async()=>{},expiresAtMs:undefined};
  Object.defineProperty(lease,key,{value:changed[key],enumerable:true,configurable:true,writable:true});
  await assert.rejects(f.port.verify(p.handle),(e:unknown)=>e instanceof MobilePlaybackError&&e.code==='SOURCE_CHANGED');
  await f.port.release(p.handle);assert.equal(f.released.size,1);
 }
 const g=fixture(t),p=await g.port.prepare(request,new AbortController().signal),gate=g.readGate();
 const pending=g.port.read(p.handle,READ1,0,4,new AbortController().signal);await new Promise<void>(r=>setImmediate(r));
 Object.defineProperty(g.leases[0]!,'size',{value:g.data.length+1});gate.resolve();
 await assert.rejects(pending,(e:unknown)=>e instanceof MobilePlaybackError&&e.code==='SOURCE_CHANGED');await g.port.release(p.handle);
});
test('close/release 先到保存原 tombstone，迟到 read/prepare 不能重开',async t=>{
 const f=fixture(t),p=await f.port.prepare(request,new AbortController().signal);
 await f.port.closeRead(p.handle,READ1);await assert.rejects(f.port.read(p.handle,READ1,0,4,new AbortController().signal),(e:unknown)=>e instanceof MobilePlaybackError&&e.code==='RESOURCE_RELEASED');
 await f.port.release(RESOURCE2);await assert.rejects(f.port.prepare({...request,resourceId:RESOURCE2},new AbortController().signal),(e:unknown)=>e instanceof MobilePlaybackError&&e.code==='RESOURCE_RELEASED');
 assert.equal(f.opens(),1);
});
test('header probe 的 closeRead 拒绝保留原 lease/capacity，不能被后续 release 冒充 quiet',async t=>{
 const f=fixture(t);f.failReadClose();await assert.rejects(f.port.prepare(request,new AbortController().signal));
 assert.equal(f.service.qualified,false);assert.equal(f.service.resourceSnapshot().live,1);assert.equal(f.released.size,0);
 await assert.rejects(f.port.release(request.resourceId));await assert.rejects(f.service.close());
 assert.equal(f.released.size,0);assert.ok(f.readNames.size>0);f.restoreClose();for(const lease of f.leases){for(const id of f.readNames)await lease.closeRead(id);await lease.release();}
 // 受控端口自行关闭不是产品 ACK；原服务仍封闭且保留记录。
 assert.equal(f.service.resourceSnapshot().live,1);
});
test('release 等待有界，迟到实际 quiet 不改写原 UNKNOWN/fatal 保留事实',async t=>{
 const f=fixture(t,true,{releaseMs:20}),p=await f.port.prepare(request,new AbortController().signal),gate=f.releaseGate();
 await assert.rejects(f.port.release(p.handle),(e:unknown)=>e instanceof MobilePlaybackError&&e.code==='BUSY');
 assert.equal(f.service.qualified,false);assert.equal(f.service.resourceSnapshot().live,1);assert.equal(f.released.size,0);
 gate.resolve();await new Promise<void>(r=>setImmediate(r));await assert.rejects(f.service.close());
 assert.equal(f.released.size,1);assert.equal(f.service.resourceSnapshot().live,1);
});
