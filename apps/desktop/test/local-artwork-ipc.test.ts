import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID,createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { LocalArtworkCandidate,LocalArtworkContext,LocalArtworkTarget } from '@music-bridge/contracts';
import { installLocalArtworkHandlers } from '../src/main/local-artwork-ipc.js';

const datasetId=randomUUID(),id=randomUUID(),target:LocalArtworkTarget={trackId:id,editionId:id,expectedEditionRevision:'1',expectedTrackRevision:'1',expectedSourceRevision:'a'.repeat(64)};
const view:LocalArtworkContext={trackId:id,trackRevision:'1',target,editions:[{id,title:'独立发行',edition:'',revision:'1'}],selection:null,candidates:[],remoteProvider:'off-pending-license',sourceFilesWrite:'OFF',status:'missing'};
function deferred<T>() { let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve}; }
// 合成JPEG容器/fake codec仅用于Main IPC路由，真实native解码单独验证。
function jpeg(width:number,height:number):Buffer {
  const seg=(marker:number,b:Buffer)=>{const h=Buffer.from([255,marker,0,0]);h.writeUInt16BE(b.length+2,2);return Buffer.concat([h,b]);};
  const q=Buffer.alloc(65,1);q[0]=0;const tables=[0,16].map(info=>{const b=Buffer.alloc(18);b[0]=info;b[1]=1;return b;});
  const frame=Buffer.from([8,0,0,0,0,1,1,17,0]);frame.writeUInt16BE(height,1);frame.writeUInt16BE(width,3);
  return Buffer.concat([Buffer.from([255,216]),seg(219,q),seg(196,Buffer.concat(tables)),seg(192,frame),seg(218,Buffer.from([1,1,0,0,63,0])),Buffer.from([63,255,217])]);
}
function fixture(extra:any={}) {
  const handlers=new Map<string,(event:{trusted:boolean},value:unknown)=>unknown>(),calls:any[]=[];
  const control=installLocalArtworkHandlers({handle:(channel,handler)=>handlers.set(channel,handler),requireTrusted:(e:{trusted:boolean})=>{if(!e.trusted)throw new Error('不可信窗口');},eventKey:()=> 'controlled-window',supervisor:{request:async(command:string,payload:any,scope?:string)=>{calls.push({command,payload,scope});return command==='commandOutbox.context'?{datasetId}:view;},requestInternal:async(command:string,payload:any,scope:string)=>{calls.push({command,payload,scope});if(command==='localArtwork.cancelLookup')return {cancelled:true};if(command==='localArtwork.readCandidates')return {status:'source-unavailable',items:[]};return view;}} as any,pick:async()=>({canceled:true,filePaths:[]}),decode:(bytes:Buffer)=>{const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);return {isEmpty:()=>false,getSize:()=>({width,height}),resize:()=>{throw 0},toJPEG:()=>jpeg(width,height)};},...extra});
  return {handlers,calls,control,call:(channel:string,value:unknown)=>Promise.resolve().then(()=>handlers.get(channel)!({trusted:true},value))};
}
test('Main闭集拒绝路径、URL、getter和不可信窗口，不派发任何Owner请求',async()=>{
  const f=fixture();let invoked=0;
  const bad=Object.defineProperty({...target},'trackId',{enumerable:true,get(){invoked++;return id;}});
  for(const value of [{datasetId,target,url:'http://127.0.0.1'},{datasetId,target:bad},{datasetId,target:{...target,path:'/私有'}}])await assert.rejects(()=>f.call('localArtwork:find',value));
  await assert.rejects(()=>f.call('localArtwork:search',{datasetId,target,query:'https://localhost/'}));
  await assert.rejects(async()=>f.handlers.get('localArtwork:context')!({trusted:false},{datasetId,request:{trackId:id,editionId:id}}));
  assert.equal(invoked,0);assert.equal(f.calls.length,0);f.control.close();
});
test('拖图只向可信stage发送完整解码副本与SHA，源图片及选择都不写',async()=>{
  const f=fixture(),file=new URL('../../../packages/bridge-core/test/fixtures/mbrs003/audio/inputs/cover-small.png',import.meta.url),before=await readFile(file),hash=createHash('sha256').update(before).digest('hex');
  await f.call('localArtwork:import',{datasetId,target,bytes:new Uint8Array(before)});
  const staged=f.calls.find(v=>v.command==='localArtwork.stage');assert.ok(staged);assert.equal(staged.scope,datasetId);assert.equal(staged.payload.image.original.sha256,hash);assert.equal(staged.payload.origin,'manual');assert.match(staged.payload.image.display.dataUrl,/^data:image\/jpeg;base64,/u);
  assert.ok(f.calls.every(v=>['commandOutbox.context','localArtwork.stage'].includes(v.command)));assert.deepEqual(await readFile(file),before);assert.equal(view.selection,null);f.control.close();
});
test('取消保留物理查找占位直到旧Owner结果收口，迟到不能进入stage',async()=>{
  const gate=deferred<any>(),started=deferred<void>();let reads=0,stages=0;
  const f=fixture({supervisor:{request:async(command:string)=>command==='commandOutbox.context'?{datasetId}:view,requestInternal:async(command:string)=>{if(command==='localArtwork.readCandidates'){reads++;started.resolve();return gate.promise;}if(command==='localArtwork.stage'){stages++;return view;}return {cancelled:true};}}});
  const pending=f.call('localArtwork:find',{datasetId,target});await started.promise;await f.call('localArtwork:cancel',{datasetId,target});
  await assert.rejects(()=>f.call('localArtwork:find',{datasetId,target}));assert.equal(reads,1);
  gate.resolve({status:'source-unavailable',items:[]});await assert.rejects(()=>pending);assert.equal(stages,0);
  await f.call('localArtwork:find',{datasetId,target});assert.equal(reads,2);f.control.close();
});
test('Provider失败脱敏，封面通道关闭/失败不调用播放或写回接口',async()=>{
  const f=fixture({providers:{'cover-art-archive-v1':{search:async()=>{throw new Error('/合成私有 Token-secret 上游堆栈');},close(){}}}});
  await assert.rejects(()=>f.call('localArtwork:search',{datasetId,target,query:'实际专辑关键词'}),error=>error instanceof Error&&error.message.includes('保留')&&!error.message.includes('Token-secret')&&!error.message.includes('私有'));
  assert.equal((await f.call('localArtwork:context',{datasetId,request:{trackId:id,editionId:id}}) as LocalArtworkContext).remoteProvider,'cover-art-archive-v1');
  f.control.close();await assert.rejects(()=>f.call('localArtwork:find',{datasetId,target}));assert.ok(f.calls.every(v=>['commandOutbox.context','localArtwork.context'].includes(v.command)));
});
test('首张坏图不挡后续好图，本地读取和远程检索均保留原手选',async()=>{
  const file=new URL('../../../packages/bridge-core/test/fixtures/mbrs003/audio/inputs/cover-small.png',import.meta.url),good=await readFile(file),bad=Buffer.from(good);bad[29]!^=1;
  const display=jpeg(16,16),sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
  const savedCandidate:LocalArtworkCandidate={id:randomUUID(),editionId:id,origin:'manual',sourceIdentity:'b'.repeat(64),sourceLabel:'原手选',provider:'local-readonly-v1',license:'user-supplied',expiresAt:new Date(Date.now()+600_000).toISOString(),original:{mime:'image/png',bytes:good.length,sha256:sha(good),width:16,height:16},display:{mime:'image/jpeg',bytes:display.length,sha256:sha(display),width:16,height:16,dataUrl:`data:image/jpeg;base64,${display.toString('base64')}`}};
  const original:LocalArtworkContext={...view,status:'ready',selection:{id:randomUUID(),editionId:id,revision:'1',mode:'manual',candidate:savedCandidate}};
  const source={releaseId:'76df3287-6cda-33eb-8e9a-044b5e15ffdd',imageId:'123',releaseTitle:'合成专辑',artist:'合成歌手',releaseDate:'1969',country:'GB',releaseUrl:'https://musicbrainz.org/release/76df3287-6cda-33eb-8e9a-044b5e15ffdd',front:true,approved:true,musicBrainzMetadataLicense:'CC0-core' as const,imageRights:'unverified' as const,imageVariant:'original' as const,policyVersion:'2026-10-07-caa-personal-v1' as const};
  for(const channel of ['localArtwork:find','localArtwork:search']){
    const staged:any[]=[];
    const f=fixture({supervisor:{request:async(command:string)=>command==='commandOutbox.context'?{datasetId}:original,requestInternal:async(command:string,payload:any)=>{
      if(command==='localArtwork.readCandidates')return {status:'ready',items:[{origin:'local-independent',sourceIdentity:'c'.repeat(64),sourceLabel:'坏图',base64:bad.toString('base64')},{origin:'embedded',sourceIdentity:'d'.repeat(64),sourceLabel:'后续好图',base64:good.toString('base64')}]};
      assert.equal(command,'localArtwork.stage');staged.push(payload);return original;
    }},providers:{'cover-art-archive-v1':{search:async()=>[{bytes:bad,source},{bytes:good,source:{...source,imageId:'124'}}],close(){}}}});
    const result=await f.call(channel,{datasetId,target,...(channel.endsWith('search')?{query:'合成专辑'}:{})}) as LocalArtworkContext;
    assert.equal(staged.length,1,channel);assert.equal(staged[0].image.original.sha256,sha(good));assert.deepEqual(result.selection,original.selection);
    f.control.close();
  }
  assert.deepEqual(await readFile(file),good);
});
