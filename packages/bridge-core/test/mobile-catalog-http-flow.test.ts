import { createCatalogHttpObservation } from '../src/mobile/catalog-http-observation.js';
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
import { MOBILE_CATALOG_TRACE_PREFIX, MOBILE_CATALOG_MARKER_PREFIX, catalogTraceEvent, withCatalogTrace, copyCatalogTraceRecord, copyCatalogTraceSeed, catalogTraceNonce, createCatalogTraceRelay } from '../src/mobile/catalog-private-trace.js';
// @ts-expect-error 独立冻结ESM reader不依赖产品编译产物，运行时真实导入并交叉核闭schema。
import { createCatalogPrivateReader, copyCatalogPrivateRecord } from '../../../scripts/diagnostics/mobile/catalog-http-sidecar-reader.mjs';

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
  const details=Array.from({length:3000},(_,i):LocalLibraryTrackDetail=>{
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
    track:(id:string)=>{if(mode==='close'&&id===uuid(2614))throw new SourceCatalogReleaseError();return detail(id).track;},
    privateAssetLocator:(id:string)=>({asset:details.find(d=>d.asset.id===id)!.asset,relative:'禁止输出的音频.flac'}),
  },sources:{root:()=>({id:SOURCE,path:'/synthetic/never-opened',dev:'1',ino:'1',authorized:true,label:'禁止输出的根'})},
  localScan:{privateFileState:()=>null,privateDisplayFileParameters:(id:string)=>{
    const value=detail(id).fileParameters!;
    if(id!==uuid(2614))return value;
    if(mode==='missing')return null;
    if(mode==='duration')return {...value,durationMs:null};
    if(mode==='audio')return {...value,codec:'Codec With Spaces'};
    return value;
  }}} as unknown as CollectionRepository;
  const albumKey=`directory-${'a'.repeat(64)}`;
  const localAlbums={privateMobile:{refresh:async()=>{},revision:()=> 'source:1',current:(request:{offset:number;limit:number})=>{
    queries++;return {revision:'source:1',total:3000,items:details.slice(request.offset,request.offset+request.limit).map(d=>({
      album:{id:albumKey,rootId:ROOT,title:'禁止输出的专辑',artists:[],versionLabel:mode==='dto'&&d.track.id===uuid(2614)?17:null,trackCount:3000,artworkState:'missing'},
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
    if(text.startsWith(MOBILE_CATALOG_TRACE_PREFIX)||text.startsWith(MOBILE_CATALOG_MARKER_PREFIX)){
      if(sinkFails)throw new Error('合成私有sink失败');
      const row=JSON.parse(text.slice(text.startsWith(MOBILE_CATALOG_MARKER_PREFIX)?MOBILE_CATALOG_MARKER_PREFIX.length:MOBILE_CATALOG_TRACE_PREFIX.length));
      if(row.component==='main'||forwarding)stream.write(Buffer.from(text));else{forwarding=true;try{child.stdout.emit('data',Buffer.from(text));}finally{forwarding=false;}}
      return true;
    }
    return Reflect.apply(originalWrite,this,[chunk,...rest]);
  } as typeof process.stdout.write;
  const service=createMobileBackend({serverId:'server.catalog',datasetId:DATASET,authKey:new Uint8Array(32).fill(7),displayName:'合成目录',environment:'development',assertCurrent(){},
    resizeArtwork(){throw new Error('不读封面');},enablePlayback:true,privateProviderDiagnostics:enabled,requestOwner:r=>supervisor.requestMobileMain(r)});
  service.activatePlayback('https://127.0.0.1:34443');
  const permit=await service.auth.issuePairing(),pair=await service.auth.claim({pairingSecret:permit.pairingSecret,installationId:'installation.catalog.test',deviceName:'合成设备'},'claim.catalog.test');
  const observation=createCatalogHttpObservation(enabled);
  const query=async (cursor?:string)=>{
    const context=createMobileCapabilityContext(randomUUID(),'main','http',null,new AbortController().signal,()=>{})!;
    const lease=observation.begin(context.requestSha256);if(lease)context.privateContentDiagnostic=true;
    const decoded=decodeMobileRequest('listTracks',{method:'GET',path:'/mobile/v1/tracks',headers:[],query:[['limit','100'],...(cursor?[['cursor',cursor] as [string,string]]:[])],body:new Uint8Array()},{responseOrigin:'https://127.0.0.1:34443',requestPath:'/mobile/v1/tracks'});assert.ok(decoded.ok);
    try {
      const response=await withMobileCapabilityContext(context,async()=>{
        const value=await service.backend.dispatch({operation:'listTracks',request:decoded.value,accessToken:pair.accessToken,signal:new AbortController().signal});
        await value.beforeSend?.();return value;
      });
      lease?.finish(response.status,false,true);
      return JSON.parse(Buffer.from(response.body).toString('utf8')) as MobileTrackPage;
    }catch(error){lease?.finish(error instanceof MobileServiceError?error.status:503,true,true);throw error;}
  };
  t.after(async()=>{await service.close();await supervisor.shutdown();channels.port1.close();channels.port2.close();process.stdout.write=originalWrite;stream.end();fs.rmSync(directory,{recursive:true,force:true});assert.equal(kills,0);assert.deepEqual(reasons,[]);});
  return {query,lines,reader,ports,counts:()=>({calls,queries}),setMode:(v:string)=>mode=v,setSinkFailure:(v:boolean)=>sinkFails=v,
    corruptCoreSeed(){ports[1]!.transform=(x:any)=>{if(x.catalogTrace)x.catalogTrace.nonceSha256='f'.repeat(64);};},
    corruptOwnerSeed(){ownerMutate=(x:any)=>{if(x.catalogTrace)x.catalogTrace.hopSha256='f'.repeat(64);};}};
}

test('M48真实原RPC闭环：26页双Owner成功后首503独立保留，恢复页继续完整发布',async t=>{
 const f=await fixture(t);let cursor:string|undefined;
 for(let i=0;i<26;i++){const page=await f.query(cursor);assert.equal(page.items.length,100);assert.ok(page.nextCursor);cursor=page.nextCursor;await turn();}
 assert.equal(f.counts().queries,52);f.setMode('missing');
 await assert.rejects(f.query(cursor),e=>e instanceof MobileServiceError&&e.code==='BUSY'&&e.status===503);await turn();await turn();
 f.setMode('good');const resumed=await f.query(cursor);assert.equal(resumed.items.length,100);await turn();await turn();
 const rows=f.lines as any[],samples=rows.filter(x=>x.schema==='mb.catalog-http-sample.v1');
 // 使用与45聚合阶段同代的连续reader；旧首success/首failure选择仍由sidecar专叶验证。
 assert.equal(samples.length,28);assert.ok(samples.every(x=>x.complete&&!x.truncated));assert.equal(samples[0].nonceCount,2);
 assert.equal(samples[26].selection,'failure');assert.equal(samples[26].status,503);assert.equal(samples[27].selection,'success');assert.equal(samples[27].status,200);
 assert.ok(rows.some(x=>x.stage==='owner.item.file-parameters'&&x.offset===2600&&x.rowOrdinal===14&&x.phase==='reject'));
 assert.ok(rows.some(x=>x.stage==='core.result'&&x.phase==='reject'));assert.ok(rows.some(x=>x.stage==='main.result'&&x.phase==='reject'));
 for(const sample of samples){assert.ok(sample.scopes.every((scope:any)=>scope.records<=64));assert.ok(rows.filter(x=>x.requestSha256===sample.requestSha256).length<=2*64+1);}
 assert.equal(f.reader.snapshot().invalidRecords,0);assert.equal(f.reader.snapshot().nonceCount,0);assert.equal(f.reader.snapshot().httpCount,0);
 assert.doesNotMatch(JSON.stringify(rows),/禁止|synthetic|60000000-0000|flac|token|cookie|path|signature/u);
});
test('M28真实原RPC默认关闭，不产生目录私有输出且读/重校验各一次',async t=>{
 const f=await fixture(t,false);const page=await f.query();await turn();assert.equal(page.items.length,100);assert.equal(f.counts().queries,2);assert.deepEqual(f.lines,[]);
});
