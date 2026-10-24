import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { MessageChannel, type Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { decodeMobileRequest, isLocalLibraryTrackDetail, type LocalLibraryTrackDetail, type MobileTrackPage } from '@music-bridge/contracts';
import { CoreSupervisor, type CoreChildProcess, type CoreMessagePort } from '../../../apps/desktop/src/main/core-supervisor.js';
import { createMobileBackend } from '../../../apps/desktop/src/main/mobile-backend.js';
import { attachCoreRuntimePort, type CoreRuntimeForIpc } from '../src/utility-main.js';
import { createDatasetOwnerClient } from '../src/collection/dataset-owner-client.js';
import { attachDatasetOwnerWorkerPort } from '../src/collection/dataset-owner-worker.js';
import type { OwnedDatasetDomain } from '../src/collection/dataset-owner-protocol.js';
import type { CollectionRepository } from '../src/collection/repository.js';
import { createMobileOwnerService } from '../src/mobile/owner-service.js';
import type { MobileLocalAlbums } from '../src/mobile/local-album-projection.js';
import { mobileGroupHash } from '../src/mobile/local-album-identity.js';
import { SourceCatalogReleaseError } from '../src/recording/source-files.js';
import { failureForError } from '../src/shared/ipc-failure.js';
import { MobileServiceError, type MobileOwnerPrivateResult } from '../src/mobile/types.js';
import { createMobileCapabilityContext, withMobileCapabilityContext, createMobileContentSampleSelector } from '../src/mobile/capability-trace.js';
import { MOBILE_CATALOG_TRACE_PREFIX, catalogTraceEvent, withCatalogTrace, copyCatalogTraceRecord, copyCatalogTraceSeed, catalogTraceNonce, createCatalogTraceRelay } from '../src/mobile/catalog-private-trace.js';
// @ts-expect-error 独立冻结ESM reader不依赖产品编译产物，运行时真实导入并交叉核闭schema。
import { createCatalogPrivateReader, copyCatalogPrivateRecord } from '../../../scripts/diagnostics/mobile/catalog-private-flow-reader.mjs';

const DATASET='50000000-0000-4000-8000-000000000001',ROOT='50000000-0000-4000-8000-000000000002',SOURCE='50000000-0000-4000-8000-000000000003';
const uuid=(n:number)=>`60000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
class LoopPort implements CoreMessagePort {
  peer!:LoopPort;listener?: (event:{data:unknown})=>void;closed=false;sent:unknown[]=[];transform:(x:any)=>void=()=>{};
  on(_event:'message',f:(event:{data:unknown})=>void){this.listener=f;}start(){}close(){this.closed=true;}
  postMessage(value:unknown){const copy=structuredClone(value);this.transform(copy);this.sent.push(copy);queueMicrotask(()=>{if(!this.closed&&!this.peer.closed)this.peer.listener?.({data:copy});});}
}
async function fixture(t:TestContext, enabled=true) {
  assert.ok(process.env.TMPDIR?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const directory=fs.mkdtempSync(path.join(process.env.TMPDIR!,'catalog-private-flow-'));fs.chmodSync(directory,0o700);
  let mode='good',calls=0,queries=0,kills=0,forwarding=false,sinkFails=false;
  const root={id:ROOT,sourceRootId:SOURCE,role:'library' as const,revision:'1'};
  const details=Array.from({length:200},(_,i):LocalLibraryTrackDetail=>{
    const metadata={title:'禁止输出的合成曲目',artist:'禁止输出的作者'};
    return {track:{id:uuid(i+1),assetId:uuid(i+1001),selectionRevision:'1',segment:null},
      asset:{id:uuid(i+1001),libraryRootId:ROOT,sourceRootId:SOURCE,rootRevision:'1',fileRevision:'1',locationRevision:'1',sampleFrames:null,timebaseHz:null},
      metadata:{raw:metadata,override:null,effective:metadata},versionTokens:[],editions:[],
      fileParameters:{container:'FLAC',codec:'flac',lossless:true,sampleRateHz:44100,channels:2,bitsPerSample:16,durationMs:1000,evidence:'bounded-parser-reported'}};
  });
  assert.ok(details.every(isLocalLibraryTrackDetail));
  const detail=(id:string)=>details.find(x=>x.track.id===id)!;
  const collection={privateMobileDataDirectory:()=>directory,localCatalog:{
    trackDetail:(id:string)=>detail(id),root:()=>root,
    track:(id:string)=>{if(mode==='close'&&id===uuid(197))throw new SourceCatalogReleaseError();return detail(id).track;},
    privateAssetLocator:(id:string)=>({asset:details.find(d=>d.asset.id===id)!.asset,relative:'禁止输出的音频.flac'}),
  },sources:{root:()=>({id:SOURCE,path:'/synthetic/never-opened',dev:'1',ino:'1',authorized:true,label:'禁止输出的根'})},
  localScan:{privateFileState:()=>null,privateDisplayFileParameters:(id:string)=>{
    const value=detail(id).fileParameters!;
    if(id!==uuid(197))return value;
    if(mode==='missing')return null;
    if(mode==='duration')return {...value,durationMs:null};
    if(mode==='audio')return {...value,codec:'Codec With Spaces'};
    return value;
  }}} as unknown as CollectionRepository;
  const albumKey=`directory-${'a'.repeat(64)}`;
  const localAlbums={privateMobile:{refresh:async()=>{},revision:()=> 'source:1',current:(request:{offset:number;limit:number})=>{
    queries++;return {revision:'source:1',total:200,items:details.slice(request.offset,request.offset+request.limit).map(d=>({
      album:{id:albumKey,rootId:ROOT,title:'禁止输出的专辑',artists:[],versionLabel:mode==='dto'&&d.track.id===uuid(197)?17:null,trackCount:200,artworkState:'missing'},
      groupHash:mobileGroupHash(ROOT,albumKey),artworkSourceRevision:'a'.repeat(64),member:{fact:{summary:{track:d.track,asset:d.asset,metadata:d.metadata.effective}}},
    }))};
  }},async getArtwork(){throw new Error('不读封面');}} as unknown as MobileLocalAlbums;
  const owner=createMobileOwnerService({collection,datasetId:DATASET,ownerEpoch:'50000000-0000-4000-8000-000000000009',assertCurrent(){},localAlbums});
  const channels=new MessageChannel(),worker=new EventEmitter();let ownerMutate=(v:any)=>{};
  Object.assign(worker,{postMessage(v:unknown){const copy=structuredClone(v);ownerMutate(copy);channels.port1.postMessage(copy);}});
  channels.port1.on('message',v=>worker.emit('message',v));channels.port1.once('close',()=>worker.emit('exit',0));
  const domain:OwnedDatasetDomain={datasetId:DATASET,async dispatch(){return undefined;},commitBoot(){},async mobileMain(request){calls++;return owner.dispatch(request);},
    async close(before){await before?.();},failureForError(id,error,command){return failureForError(id,error,command??'commandOutbox.context');}};
  attachDatasetOwnerWorkerPort(channels.port2,{async prepare(){return domain;}});
  const reasons:string[]=[],endpoint=createDatasetOwnerClient({worker:worker as unknown as Worker,onFatal:r=>reasons.push(r)});
  await endpoint.prepare();await endpoint.commitBoot();
  const ports:LoopPort[]=[];
  const child={stdout:new EventEmitter(),stderr:new EventEmitter(),exits:[] as Array<(code:number)=>void>,once(_event:'exit',f:(code:number)=>void){this.exits.push(f);},
    exit(code:number){for(const f of this.exits.splice(0))f(code);},kill(){kills++;this.exit(0);return true;},
    postMessage(_v:unknown,transfer?:CoreMessagePort[]){void attachCoreRuntimePort(transfer![0]!,runtime);}};
  const runtime={async start(){},async shutdown(){await endpoint.close();setImmediate(()=>child.exit(0));},getState:()=>({runtime:'ready',roon:'disconnected',provider:'missing',activeStreamCount:0,activePlaybackPresent:false}),datasetOwnerEndpoint:endpoint} as unknown as CoreRuntimeForIpc;
  const supervisor=new CoreSupervisor({entryPath:'/synthetic/catalog-core.js',cwd:'/synthetic',startupTimeoutMs:1000,requestTimeoutMs:1000,
    ...(enabled?{onMobileCapabilityTrace:()=>{}}:{}),dependencies:{fork:()=>child as CoreChildProcess,createChannel(){const a=new LoopPort(),b=new LoopPort();a.peer=b;b.peer=a;ports.push(a,b);return {port1:a,port2:b};}}});
  await supervisor.start();
  const lines:unknown[]=[],reader=createCatalogPrivateReader({onRecord:(r:unknown)=>lines.push(r)}),stream=reader.createStream();
  const originalWrite=process.stdout.write;
  process.stdout.write=function(this:typeof process.stdout,chunk:any,...rest:any[]):boolean{
    const text=Buffer.isBuffer(chunk)?chunk.toString('utf8'):String(chunk);
    if(text.startsWith(MOBILE_CATALOG_TRACE_PREFIX)){
      if(sinkFails)throw new Error('合成私有sink失败');
      const row=JSON.parse(text.slice(MOBILE_CATALOG_TRACE_PREFIX.length));
      if(row.component==='main'||forwarding)stream.write(Buffer.from(text));else{forwarding=true;try{child.stdout.emit('data',Buffer.from(text));}finally{forwarding=false;}}
      return true;
    }
    return Reflect.apply(originalWrite,this,[chunk,...rest]);
  } as typeof process.stdout.write;
  const service=createMobileBackend({serverId:'server.catalog',datasetId:DATASET,authKey:new Uint8Array(32).fill(7),displayName:'合成目录',environment:'development',assertCurrent(){},
    resizeArtwork(){throw new Error('不读封面');},enablePlayback:true,privateProviderDiagnostics:enabled,requestOwner:r=>supervisor.requestMobileMain(r)});
  service.activatePlayback('https://127.0.0.1:34443');
  const permit=await service.auth.issuePairing(),pair=await service.auth.claim({pairingSecret:permit.pairingSecret,installationId:'installation.catalog.test',deviceName:'合成设备'},'claim.catalog.test');
  const query=async (offset=0,selected=true)=>{
    const context=createMobileCapabilityContext(randomUUID(),'main','http',null,new AbortController().signal,()=>{})!;
    if(selected)context.privateContentDiagnostic=true;
    // 真实cursor只由Main CatalogService签发，offset参数只选择先首批再第二批，不自造签名。
    const decoded=decodeMobileRequest('listTracks',{method:'GET',path:'/mobile/v1/tracks',headers:[],query:[['limit','100']],body:new Uint8Array()},{responseOrigin:'https://127.0.0.1:34443',requestPath:'/mobile/v1/tracks'});assert.ok(decoded.ok);
    const base={operation:'listTracks' as const,request:decoded.value,accessToken:pair.accessToken,signal:new AbortController().signal};
    const first=await withMobileCapabilityContext(context,()=>service.backend.dispatch(base));
    const page=JSON.parse(Buffer.from(first.body).toString('utf8')) as MobileTrackPage;
    if(offset===0)return page;
    assert.ok(page.nextCursor);
    const next=decodeMobileRequest('listTracks',{method:'GET',path:'/mobile/v1/tracks',headers:[],query:[['limit','100'],['cursor',page.nextCursor]],body:new Uint8Array()},{responseOrigin:'https://127.0.0.1:34443',requestPath:'/mobile/v1/tracks'});assert.ok(next.ok);
    const nextContext=createMobileCapabilityContext(randomUUID(),'main','http',null,new AbortController().signal,()=>{})!;if(selected)nextContext.privateContentDiagnostic=true;
    const reply=await withMobileCapabilityContext(nextContext,()=>service.backend.dispatch({...base,request:next.value}));
    return JSON.parse(Buffer.from(reply.body).toString('utf8')) as MobileTrackPage;
  };
  t.after(async()=>{await service.close();await supervisor.shutdown();channels.port1.close();channels.port2.close();process.stdout.write=originalWrite;stream.end();fs.rmSync(directory,{recursive:true,force:true});assert.equal(kills,0);assert.deepEqual(reasons,[]);});
  return {query,lines,reader,ports,counts:()=>({calls,queries}),setMode:(v:string)=>mode=v,setSinkFailure:(v:boolean)=>sinkFails=v,
    corruptCoreSeed(){ports[1]!.transform=(x:any)=>{if(x.catalogTrace)x.catalogTrace.nonceSha256='f'.repeat(64);};},
    corruptOwnerSeed(){ownerMutate=(x:any)=>{if(x.catalogTrace)x.catalogTrace.hopSha256='f'.repeat(64);};}};
}

test('M26目录私有真实RPC闭环：单项缺技术参数的503贯穿Main/Core/Owner并保留页序号',async t=>{
  const f=await fixture(t);f.setMode('missing');
  await assert.rejects(f.query(100),e=>e instanceof MobileServiceError&&e.code==='BUSY'&&e.status===503);
  await turn();const rows=f.lines as any[],failure=rows.find(x=>x.stage==='owner.item.file-parameters'&&x.phase==='reject');
  assert.ok(failure);assert.equal(failure.offset,100);assert.equal(failure.limit,100);assert.equal(failure.rowOrdinal,97);assert.equal(failure.code,'BUSY');
  const linked=rows.filter(x=>x.nonceSha256===failure.nonceSha256);assert.ok(linked.some(x=>x.stage==='main.request'));assert.ok(linked.some(x=>x.stage==='core.receive'));assert.ok(linked.some(x=>x.stage==='owner.receive'));assert.ok(linked.some(x=>x.stage==='owner.sql-page'&&x.count===100));
  assert.ok(linked.some(x=>x.stage==='main.result'&&x.phase==='reject'&&x.code==='BUSY'));
  assert.equal(new Set(linked.map(x=>x.requestSha256)).size,1);assert.ok(linked.length<=64);
  assert.doesNotMatch(JSON.stringify(rows),/禁止|synthetic|60000000-0000|标题|flac|token|cookie|path|signature/u);
  assert.equal(f.reader.snapshot().invalidRecords,0);assert.equal(f.reader.snapshot().unregisteredRecords,0);
});

test('M26目录子阶段区分duration/audio/DTO与关闭证明，普通离线仍为unavailable而非503',async t=>{
  const f=await fixture(t);
  // 新内部DTO诚实保留未知时长；旧未协商HTTP仍由Main整数合同拒绝，首因不再归Owner。
  f.setMode('duration');await assert.rejects(f.query(100),e=>e instanceof MobileServiceError&&e.code==='BUSY'&&e.status===503);
  assert.equal((f.lines as any[]).some(x=>x.stage==='owner.item.duration'&&x.phase==='reject'),false);
  assert.ok((f.lines as any[]).some(x=>x.stage==='core.result'&&x.offset===100&&x.phase==='ok'));
  for(const [mode,stage] of [['audio','owner.item.audio-map'],['dto','owner.item.dto'],['close','owner.item.availability']] as const){
    f.setMode(mode);await assert.rejects(f.query(100),e=>e instanceof MobileServiceError&&e.code==='BUSY');
    assert.ok((f.lines as any[]).some(x=>x.stage===stage&&x.offset===100&&x.rowOrdinal===97&&x.phase==='reject'));
    if(mode==='close')assert.ok((f.lines as any[]).some(x=>x.stage==='owner.item.close-proof'&&x.role==='cleanup'&&x.matched===false&&x.code==='BUSY'));
  }
  f.setMode('good');const result=await f.query(100);assert.equal(result.items.length,100);assert.ok(result.items.every(x=>x.availability==='unavailable'));
});

test('M26目录默认关/未选中/坏seed不改业务结果，不新增Owner请求或串线',async t=>{
  for(const mode of ['disabled','unselected','bad-core','bad-owner','sink'] as const)await t.test(mode,async t=>{
    const f=await fixture(t,mode!=='disabled');if(mode==='bad-core')f.corruptCoreSeed();if(mode==='bad-owner')f.corruptOwnerSeed();if(mode==='sink')f.setSinkFailure(true);
    const result=await f.query(0,mode!=='unselected');assert.equal(result.items.length,100);assert.equal(f.counts().queries,1);
    const rows=f.lines as any[];
    if(mode==='disabled'||mode==='unselected'||mode==='sink')assert.equal(rows.length,0);
    if(mode==='bad-core')assert.equal(rows.some(x=>x.component!=='main'),false);
    if(mode==='bad-owner')assert.equal(rows.some(x=>x.component==='owner'),false);
  });
});

test('M26目录并发同页不同请求nonce独立且原关闭收口，不共享诊断状态',async t=>{
  const f=await fixture(t);await Promise.all([f.query(),f.query()]);const rows=f.lines as any[];
  const starts=rows.filter(x=>x.stage==='main.request');assert.equal(starts.length,2);assert.notEqual(starts[0].nonceSha256,starts[1].nonceSha256);assert.notEqual(starts[0].requestSha256,starts[1].requestSha256);
  for(const start of starts){const branch=rows.filter(x=>x.nonceSha256===start.nonceSha256);assert.ok(branch.some(x=>x.component==='owner'));assert.ok(branch.every(x=>x.requestSha256===start.requestSha256));assert.ok(branch.length<=64);}
});

test('M26目录producer与严格stream reader预算/首拒/额外字段/碎片/nonce围栏',()=>{
  const seed={schema:1 as const,requestSha256:'a'.repeat(64),nonceSha256:catalogTraceNonce('nonce.synthetic'),offset:100,limit:100};
  const output:string[]=[];withCatalogTrace(seed,'main',()=>catalogTraceEvent('main.request','begin'),line=>output.push(line));
  withCatalogTrace(seed,'owner',()=>{for(let i=0;i<90;i++)catalogTraceEvent('owner.sql-page','ok');catalogTraceEvent('owner.item.duration','reject',{error:new MobileServiceError(503,'BUSY'),rowOrdinal:97});catalogTraceEvent('owner.item.close-proof','reject',{error:new MobileServiceError(503,'BUSY'),role:'cleanup',matched:false,rowOrdinal:97});},line=>output.push(line));
  const relayLines:string[]=[],relay=createCatalogTraceRelay(true,l=>relayLines.push(l));relay.register(seed);
  const records=output.map(l=>JSON.parse(l.slice(MOBILE_CATALOG_TRACE_PREFIX.length)));for(const row of records)assert.ok(copyCatalogTraceRecord(row)&&copyCatalogPrivateRecord(row));
  for(const line of output.slice(1))relay.feed(line);assert.ok(relayLines.length<=64);assert.ok(relayLines.some(l=>l.includes('owner.item.duration')));assert.ok(relayLines.some(l=>l.includes('owner.item.close-proof')));
  const kept:unknown[]=[],reader=createCatalogPrivateReader({onRecord:(x:unknown)=>kept.push(x)}),stream=reader.createStream();
  const wire=Buffer.from(output[0]+relayLines.join(''));for(let at=0;at<wire.length;at+=7)stream.write(wire.subarray(at,at+7));
  const bad={...records.at(-1),nonceSha256:'b'.repeat(64)};stream.write(MOBILE_CATALOG_TRACE_PREFIX+JSON.stringify(bad)+'\n');stream.write(MOBILE_CATALOG_TRACE_PREFIX+JSON.stringify({...bad,rawBody:'不得透传'})+'\n');stream.end();
  assert.ok(kept.length<=64);assert.ok((kept as any[]).some(x=>x.stage==='owner.item.duration'&&x.phase==='reject'));assert.ok((kept as any[]).some(x=>x.stage==='owner.item.close-proof'&&x.role==='cleanup'));assert.equal(reader.snapshot().unregisteredRecords,1);assert.equal(reader.snapshot().invalidRecords,1);
  let calls=0;assert.equal(withCatalogTrace({bad:true},'owner',()=>++calls),1);assert.equal(withCatalogTrace(seed,'owner',()=>{catalogTraceEvent('owner.receive','ok');return ++calls;},()=>{throw new Error('合成sink');}),2);assert.equal(calls,2);
  assert.equal(copyCatalogTraceSeed({...seed,rawBody:'不能清洗为合法seed'}),undefined);
  const getter=Object.defineProperty({...seed},'offset',{enumerable:true,get(){throw new Error('不得调用getter');}});
  assert.equal(copyCatalogTraceSeed(getter),undefined);
  assert.equal(copyCatalogTraceSeed(new Proxy(seed,{})),undefined);
  assert.equal(copyCatalogPrivateRecord(new Proxy(records[0],{})),null);
  const mismatched={...records.at(-1),offset:101};
  const rejectReader=createCatalogPrivateReader({onRecord(){throw new Error('不应收到串线记录');}}),rejectStream=rejectReader.createStream();
  rejectStream.write(output[0]);rejectStream.write(MOBILE_CATALOG_TRACE_PREFIX+JSON.stringify(mismatched)+'\n');rejectStream.end();
  assert.equal(rejectReader.snapshot().unregisteredRecords,1);
  assert.equal(rejectReader.snapshot().sinkFailures,1);
});
