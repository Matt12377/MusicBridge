import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import { mkdir, mkdtemp, open, readFile, readdir, writeFile, type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import {
  createSourceWritesMainActor,requestSourceWritesLyricsGrant,consumeSourceWritesLyricsGrantReply,assertSourceWritesLyricsGrant,
  captureSourceWritesLyricsGrantRequest,captureSourceWritesLyricsGrantReply,assertSourceWritesLyricsGrantReplyForRequest,
  captureSourceWritesLyricsVerifyRequest,captureSourceWritesLyricsVerifyReply,assertSourceWritesLyricsVerifyReplyForRequest,assertSourceWritesLyricsVerifyForPending,
  captureSourceWritesLyricsOriginalEvidence,type SourceWritesLyricsGrantRequest,type SourceWritesLyricsOriginalEvidence,
} from '../../src/collection/source-writes-authority.js';
import {createUtilitySourceWritesBridge,type SourceWritesUtilityPort} from '../../src/shared/source-writes-utility-port.js';
import {captureLocalLyricsPhysicalBinding,captureLocalLyricsPhysicalGroup,captureLocalLyricsPhysicalRecord,assertLocalLyricsPhysicalTransition,
  localLyricsPhysicalOperationId,lyricsPhysicalDigest,observeLyricsSourceFormat,createLyricsNativeFidelityPort,
  type LocalLyricsPhysicalBinding,type LocalLyricsPhysicalRecord,type LocalLyricsPhysicalGroup,type LocalLyricsPhysicalMember,type LocalLyricsPhysicalResource,type LocalLyricsPhysicalArtifact} from '../../src/library/lyrics-source-format.js';
import {createCueSyntheticWave,CUE_SYNTHETIC_ARTWORK} from '../../src/library/local-cue-format-qualification.js';
import {createCueNativeActor,loadBundledCueConverter} from '../../src/library/bundled-cue-converter.js';
import {createLocalAudioTagsActor,loadLocalAudioTagsBundle} from '../../src/library/local-audio-tags-actor.js';

const closedPorts=new WeakSet<MessagePort>();
function watchPort(p:MessagePort){p.once('close',()=>closedPorts.add(p));return p;}
function channel(){const c=new MessageChannel();watchPort(c.port1);watchPort(c.port2);return c;}
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function group(count=1):LocalLyricsPhysicalGroup {
  const resource={rootId:randomUUID(),relative:'合成专辑/原件.wav',sha256:'a'.repeat(64),bytes:64,signature:'1:2:64:3:4',birthtimeNs:'5',permissionMode:'384',uid:'1',gid:'1',dev:'1',ino:'2'};
  return {resources:[resource],members:Array.from({length:count},(_,i)=>({trackId:'track-'+i,rootId:randomUUID(),sourceRootId:resource.rootId,fileId:'asset-'+i,rootRevision:'1',fileRevision:'1',locationRevision:'1',metadataRevision:'b'.repeat(64),resourceIndex:0}))};
}
function binding(g=group()):LocalLyricsPhysicalBinding {
  const request={sessionId:randomUUID(),commandId:randomUUID(),embed:true};
  return {datasetId:randomUUID(),ownerEpoch:randomUUID(),sessionId:request.sessionId,commandId:request.commandId,libraryId:randomUUID(),albumId:'album-local-synthetic',captureId:randomUUID(),trackId:g.members[0]!.trackId,candidateId:randomUUID(),bodySha256:'c'.repeat(64),kind:'embed',intentFingerprint:'d'.repeat(64),rootRevision:'1',fileRevision:'1',locationRevision:'1',metadataRevision:'b'.repeat(64),
    originalIntentSha256:'e'.repeat(64),originalRequestSha256:lyricsPhysicalDigest(request),groupCaptureSha256:'f'.repeat(64),protectionSha256:lyricsPhysicalDigest(g),memberCount:g.members.length,resourceCount:g.resources.length,targetCount:2};
}
function initial(g=group()):LocalLyricsPhysicalRecord {
  const b=binding(g);return {schema:1,operationId:localLyricsPhysicalOperationId(b),binding:b,original:g,revision:1,currentOwnerEpoch:b.ownerEpoch,phase:'PREPARED',grant:null,artifacts:{stage:null,backup:null,quarantine:null,target:null},fidelity:null,result:null,physicalClosed:false,protectionReleased:false,unresolved:false};
}
function evidence(q:SourceWritesLyricsGrantRequest,original=q.binding):SourceWritesLyricsOriginalEvidence {
  const request={sessionId:original.sessionId,commandId:original.commandId,embed:true};
  return {originalBinding:original,request,phase:q.revision===1?'PREPARED':'FAILED',revision:q.revision,recordOwnerEpoch:original.ownerEpoch,currentOwnerEpoch:q.binding.ownerEpoch,
    physicalClosed:q.revision!==1,protectionReleased:q.revision!==1,unresolved:false,ledgerSequence:1,
    originalIntentSha256:original.originalIntentSha256,originalRequestSha256:original.originalRequestSha256,groupCaptureSha256:original.groupCaptureSha256,protectionSha256:original.protectionSha256,jobOrigin:null};
}
function reply(q:SourceWritesLyricsGrantRequest){return {version:1 as const,type:'lyrics-source-grant-reply' as const,purpose:'LYRICS' as const,requestId:q.requestId,sequence:q.sequence,revision:q.revision,authorityId:q.authorityId,requestSha256:lyricsPhysicalDigest(q),binding:q.binding,bindingSha256:q.bindingSha256,decision:'granted' as const,nonce:randomUUID(),validUntilMs:Date.now()+30000};}
async function closePorts(...ports:MessagePort[]){await Promise.all(ports.map(p=>closedPorts.has(p)?Promise.resolve():new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('原Node物理端口未关闭。')),2000);p.once('close',()=>{clearTimeout(timer);closedPorts.add(p);resolve()});p.close();})));}
async function message(port:MessagePort,send:()=>void):Promise<unknown>{return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('受控物理消息未在2秒到达。')),2000);port.once('message',raw=>{clearTimeout(timeout);resolve(raw)});send();});}

test('歌词物理闭集保留完整一万成员与两个Root域，getter/clone漂移和2048资源越界拒绝',()=>{
  const g=group(10000);assert.equal(captureLocalLyricsPhysicalGroup(g).members.length,10000);assert.notEqual(g.members[0]!.rootId,g.resources[0]!.rootId);
  assert.throws(()=>captureLocalLyricsPhysicalGroup({...g,members:g.members.map((m,i)=>i?m:{...m,sourceRootId:randomUUID()})}));
  const r=initial();assertLocalLyricsPhysicalTransition(null,r);let got=0;const dangerous={...r};Object.defineProperty(dangerous,'revision',{enumerable:true,get(){got++;return 1}});assert.throws(()=>captureLocalLyricsPhysicalRecord(dangerous));assert.equal(got,0);
  assert.throws(()=>captureLocalLyricsPhysicalRecord(new Proxy(r,{})));assert.throws(()=>captureLocalLyricsPhysicalGroup({...g,resources:Array.from({length:2049},(_,i)=>({...g.resources[0]!,relative:'x'+i,ino:String(i+10)}))}));
  for(const patch of [{protectionReleased:true},{unresolved:true,phase:'CLOSED'},{operationId:'0'.repeat(64)}])assert.throws(()=>captureLocalLyricsPhysicalRecord({...r,...patch}));
});

test('歌词物理状态CAS冷链不跳修订不换正文，UNKNOWN不能回到受理或借closed字段重放',()=>{
  const r=initial(),unknown={...r,revision:2,phase:'UNKNOWN' as const,unresolved:true,result:{state:'unknown' as const,bodySha256:null}};assertLocalLyricsPhysicalTransition(r,unknown);
  assert.throws(()=>assertLocalLyricsPhysicalTransition(r,{...unknown,revision:3}));assert.throws(()=>assertLocalLyricsPhysicalTransition(r,{...unknown,binding:{...r.binding,bodySha256:'9'.repeat(64)}}));
  assert.throws(()=>assertLocalLyricsPhysicalTransition(unknown,{...unknown,revision:3,phase:'GRANTED',physicalClosed:false,protectionReleased:false}));
  const failed={...r,revision:2,phase:'FAILED' as const,physicalClosed:true,protectionReleased:true,result:{state:'failed' as const,bodySha256:null}};assertLocalLyricsPhysicalTransition(r,failed);
  assert.throws(()=>assertLocalLyricsPhysicalTransition(failed,{...r,revision:3}));
});

test('实际专用MessagePort回包才授歌词品牌，回包JSON与grant克隆均不能自签',async()=>{
  const c=channel(),actor=createSourceWritesMainActor(c.port1),b=binding();let consumed=false;
  c.port1.on('message',raw=>{consumed=consumeSourceWritesLyricsGrantReply(actor,raw)});
  const raw=message(c.port2,()=>{}),pending=requestSourceWritesLyricsGrant(actor,b,1,new AbortController().signal),q=captureSourceWritesLyricsGrantRequest(await raw);
  c.port2.postMessage(reply(q));const grant=await pending;assert.equal(consumed,true);assert.equal(assertSourceWritesLyricsGrant(grant,actor,b,1).requestId,q.requestId);
  assert.throws(()=>assertSourceWritesLyricsGrant(structuredClone(grant),actor,b,1));assert.throws(()=>assertSourceWritesLyricsGrant(grant,actor,{...b,bodySha256:'0'.repeat(64)},1));
  assert.throws(()=>consumeSourceWritesLyricsGrantReply(actor,reply(q)));await closePorts(c.port1,c.port2);
});

test('实际歌词回包错原id序号revision或指纹使原port失权，不偷换UUID和迟到ACK',async()=>{
  for(const field of ['requestId','sequence','revision','requestSha256','bindingSha256'] as const){
    const c=channel(),actor=createSourceWritesMainActor(c.port1),b=binding(),raw=message(c.port2,()=>{}),pending=requestSourceWritesLyricsGrant(actor,b,1,new AbortController().signal);
    const rejection=assert.rejects(pending),q=captureSourceWritesLyricsGrantRequest(await raw),wrong={...reply(q),[field]:field==='sequence'||field==='revision'?2:field==='requestId'?randomUUID():'0'.repeat(64)};
    c.port2.postMessage(wrong);await rejection;assert.throws(()=>requestSourceWritesLyricsGrant(actor,b,1,new AbortController().signal));await closePorts(c.port1,c.port2);
  }
  const c=channel(),actor=createSourceWritesMainActor(c.port1),b=binding(),raw=message(c.port2,()=>{}),controller=new AbortController(),pending=requestSourceWritesLyricsGrant(actor,b,1,controller.signal),rejection=assert.rejects(pending);
  const q=captureSourceWritesLyricsGrantRequest(await raw);controller.abort();await rejection;assert.throws(()=>consumeSourceWritesLyricsGrantReply(actor,reply(q)));await closePorts(c.port1,c.port2);
});

test('冷FAILED只读验证区分immutable旧epoch和当前Owner，完整原request及job授权链不可少',()=>{
  const old=binding(),current={...old,ownerEpoch:randomUUID()},q=captureSourceWritesLyricsGrantRequest({version:1,type:'lyrics-source-grant-request',purpose:'LYRICS',requestId:randomUUID(),sequence:1,revision:7,authorityId:randomUUID(),expiresAtMs:Date.now()+2000,binding:current,bindingSha256:lyricsPhysicalDigest(current)});
  const query=captureSourceWritesLyricsVerifyRequest({version:1,type:'lyrics-source-verify-request',purpose:'LYRICS',requestId:randomUUID(),sequence:1,epoch:current.ownerEpoch,datasetId:current.datasetId,grantRequest:q}),result=evidence(q,old);
  const response=captureSourceWritesLyricsVerifyReply({version:1,type:'lyrics-source-verify-reply',purpose:'LYRICS',requestId:query.requestId,sequence:query.sequence,epoch:query.epoch,datasetId:query.datasetId,grantRequestId:q.requestId,authorityId:q.authorityId,binding:current,bindingSha256:q.bindingSha256,revision:7,result});
  assertSourceWritesLyricsVerifyReplyForRequest(response,query);assert.equal(response.result.originalBinding.ownerEpoch,old.ownerEpoch);
  for(const delta of [{currentOwnerEpoch:old.ownerEpoch},{originalRequestSha256:'0'.repeat(64)},{physicalClosed:false},{request:{...result.request,commandId:randomUUID()}}])assert.throws(()=>captureSourceWritesLyricsVerifyReply({...response,result:{...result,...delta}}));
  const jobOrigin={jobId:randomUUID(),originalJobRequestSha256:'8'.repeat(64),library:{datasetId:current.datasetId,libraryId:current.libraryId,captureId:randomUUID()},watermark:'original-owned-watermark',phase:'running' as const};
  assert.equal(captureSourceWritesLyricsOriginalEvidence({...result,jobOrigin}).jobOrigin!.phase,'running');assert.throws(()=>captureSourceWritesLyricsOriginalEvidence({...result,jobOrigin:{...jobOrigin,library:{...jobOrigin.library,datasetId:randomUUID()}}}));
  assert.throws(()=>captureSourceWritesLyricsOriginalEvidence({...result,jobOrigin:{...jobOrigin,sourceUrl:'https://secret.invalid'}}));
});

class ControlledUtilityParent extends EventEmitter implements SourceWritesUtilityPort {
  sent:unknown[]=[];isClosed=false;start(){};postMessage(message:unknown){this.sent.push(message);this.emit('outbound',message)};close(){if(!this.isClosed){this.isClosed=true;this.emit('close')}};
}
test('Utility同一专用物理port闭合grant与readonly原回声，跨请求verification和额外port致fatal',async()=>{
  const parent=new ControlledUtilityParent(),bridge=createUtilitySourceWritesBridge(parent);watchPort(bridge.port);const actor=createSourceWritesMainActor(bridge.port),b=binding();bridge.port.on('message',raw=>consumeSourceWritesLyricsGrantReply(actor,raw));
  const outgoing=new Promise<SourceWritesLyricsGrantRequest>(resolve=>parent.once('outbound',r=>resolve(captureSourceWritesLyricsGrantRequest(r)))),pending=requestSourceWritesLyricsGrant(actor,b,1,new AbortController().signal),q=await outgoing;
  const query=captureSourceWritesLyricsVerifyRequest({version:1,type:'lyrics-source-verify-request',purpose:'LYRICS',requestId:randomUUID(),sequence:1,epoch:b.ownerEpoch,datasetId:b.datasetId,grantRequest:q});
  const wire=message(bridge.port,()=>parent.emit('message',{data:query}));const received=captureSourceWritesLyricsVerifyRequest(await wire);assertSourceWritesLyricsVerifyForPending(actor,received);
  const response=captureSourceWritesLyricsVerifyReply({version:1,type:'lyrics-source-verify-reply',purpose:'LYRICS',requestId:query.requestId,sequence:1,epoch:b.ownerEpoch,datasetId:b.datasetId,grantRequestId:q.requestId,authorityId:q.authorityId,binding:b,bindingSha256:q.bindingSha256,revision:1,result:evidence(q)});
  const returned=new Promise<unknown>(resolve=>parent.once('outbound',resolve));bridge.port.postMessage(response);assertSourceWritesLyricsVerifyReplyForRequest(captureSourceWritesLyricsVerifyReply(await returned),query);
  parent.emit('message',{data:reply(q)});const grant=await pending;assertSourceWritesLyricsGrant(grant,actor,b,1);
  parent.emit('message',{data:query,ports:[{}]});assert.equal(parent.isClosed,true);await closePorts(bridge.port);bridge.close();
});

test('实际WAV与FLAC保护副本歌词经固定Native EOF保持PCM和全部未选metadata，故障副本不获发布证明',{skip:process.platform!=='darwin'||!process.env.MB_V39_CUE_BUNDLE||!process.env.MB_V39_TAGS_BUNDLE},async t=>{
  const root=process.env.MB_V39_NATIVE_PROOF_DIR;assert.ok(root);await mkdir(root,{mode:0o700,recursive:true});const dir=path.join(root,'397-format-'+randomUUID());await mkdir(dir,{mode:0o700});
  const cueRoot=process.env.MB_V39_CUE_BUNDLE!,tagRoot=process.env.MB_V39_TAGS_BUNDLE!,cuePin=process.env.MB_V39_CUE_MANIFEST_SHA256!,tagPin=process.env.MB_V39_TAGS_MANIFEST_SHA256!;assert.ok(cuePin&&tagPin,'固定manifest pin不可由旁边包自行授权');
  const cue=createCueNativeActor(await loadBundledCueConverter(cueRoot,cuePin)),tags=createLocalAudioTagsActor(await loadLocalAudioTagsBundle(tagRoot,tagPin));
  const native=await createLyricsNativeFidelityPort({cueRoot,cueManifestSha256:cuePin,tagsRoot:tagRoot,tagsManifestSha256:tagPin,temporaryRoot:dir}),fixture=createCueSyntheticWave();
  const seed=await open(path.join(dir,'seed.wav'),constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW|constants.O_RDWR,0o600);await seed.writeFile(fixture.wave);
  try{for(const format of ['wav','flac'] as const){
    const commandId=randomUUID(),source=await open(path.join(dir,'source.'+format),constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW|constants.O_RDWR,0o600),copy=await open(path.join(dir,'copy.'+format),constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW|constants.O_RDWR,0o600);
    const claim={commandId,claimId:randomUUID(),async assertCurrent(){assert.ok(source.fd>=0&&copy.fd>=0)}};
    try{
      if(format==='wav')await source.writeFile(fixture.wave);else {const input=await open(path.join(dir,'seed.wav'),constants.O_RDONLY|constants.O_NOFOLLOW);try{await cue.encode({source:input,target:source,demuxer:'wav',format:'flac',startFrame:0,frameCount:fixture.frames,sampleRate:fixture.sampleRate,channels:fixture.channels,sourceClaim:claim,targetClaim:claim});}finally{await input.close();}}
      await tags.run({fd:source.fd,...claim},format==='wav'?'pcm-wav':'flac',{TITLE:'未选标题',ARTIST:'原作者',ALBUM:'合成专辑',DATE:'2001',DISCNUMBER:'2',TRACKNUMBER:'3',LYRICS:'旧歌词',PICTURE:CUE_SYNTHETIC_ARTWORK});
      const original=await readFile(path.join(dir,'source.'+format));await copy.writeFile(original);const signal=new AbortController().signal,baseline=await native.captureOriginal(source,format,claim,signal,path.join(dir,'source.'+format)),before=await observeLyricsSourceFormat(source,format,signal);
      await tags.run({fd:copy.fd,...claim},format==='wav'?'pcm-wav':'flac',{LYRICS:'[00:00.00]所选新歌词\n'});await tags.join(commandId);
      const proof=await native.verifyCopy(baseline,copy,format,'[00:00.00]所选新歌词\n',claim,signal,path.join(dir,'copy.'+format));assert.equal(proof.sourceSha256,digest(original));assert.equal(proof.pcmBytes,fixture.pcm.length);assert.equal(proof.pcmSha256,digest(fixture.pcm));assert.equal(proof.unselectedSha256,before.unselectedSha256);assert.deepEqual(await readFile(path.join(dir,'source.'+format)),original);
      await tags.run({fd:copy.fd,...claim},format==='wav'?'pcm-wav':'flac',{TITLE:'不允许变化的原标题'});await assert.rejects(native.verifyCopy(baseline,copy,format,'[00:00.00]所选新歌词\n',claim,signal,path.join(dir,'copy.'+format)));
    }catch(error){if(error&&typeof error==='object'&&'raw'in error)await writeFile(path.join(dir,'native-failure-'+format+'.json'),JSON.stringify((error as {raw:unknown}).raw,null,2),{flag:'wx',mode:0o600});throw error;}finally{await tags.join(commandId);await cue.join(commandId);await native.join(commandId);await source.close();await copy.close();await assert.rejects(source.stat());await assert.rejects(copy.stat());}
  }}finally{await seed.close();await tags.close();await cue.close();await native.close();}
  t.diagnostic('受控合成WAV/FLAC与固定本机Native真实处理；不是App、真实用户媒体或Main授权验收。');
});

import {stat} from 'node:fs/promises';
import {createCollectionRepository} from '../../src/collection/repository.js';
import {authorizeSourceDirectory,createLyricsSourceFilesAuthor} from '../../src/recording/source-files.js';
import {createSourceSafetyRepository,type PublisherTarget} from '../../src/collection/source-writes-publisher.js';
import {createBackupWorkflowStore} from '../../src/recording/backup-workflow-store.js';
import {createTestDatasetDomain} from '../../src/collection/dataset-domain.js';
import {createLocalSourceWritesStore} from '../../src/collection/local-source-writes-store.js';
import {sourceWritesEvent,sourceWritesRequestFingerprint} from '../../src/collection/local-source-writes-journal.js';
import type {ScanPreparedItem} from '../../src/collection/local-scan-store.js';
import {localLyricsIntentFingerprint} from '../../src/collection/local-library-lyrics/save-coordinator.js';
import type {LocalLyricsSaveIntent,LocalLyricsSelectedBody} from '../../src/collection/local-library-lyrics/types.js';
import type {LocalLyricsWriteBinding} from '../../src/collection/local-library-workbench/lyrics-writer.js';
const nativeConfigured=process.platform==='darwin'&&!!process.env.MB_V39_CUE_BUNDLE&&!!process.env.MB_V39_TAGS_BUNDLE;
async function safetyFixture459(){
  const temporary=process.env.TMPDIR;assert.ok(temporary&&path.isAbsolute(temporary));
  const directory=await mkdtemp(path.join(temporary,'safety459-')),source=path.join(directory,'source');await mkdir(source,{mode:0o700});
  const root={id:randomUUID(),...await authorizeSourceDirectory(source)},target:PublisherTarget={operationId:randomUUID(),root,libraryRootPath:source,relative:'原歌词.lrc',expected:null,attributes:null,change:null,replacementBytes:Buffer.from('[00:00.00]合成歌词\n')};
  return{directory,source,target,safety:createSourceSafetyRepository(path.join(directory,'safety'))};
}
async function holdSafetyProbe459(t:import('node:test').TestContext,directory:string){
  const seed=path.join(directory,'test-owned-handle');await writeFile(seed,'测试自有FD',{flag:'wx',mode:0o600});
  const sample=await open(seed,constants.O_RDONLY),prototype=Object.getPrototypeOf(sample) as {write:(...args:unknown[])=>Promise<unknown>},original=prototype.write;await sample.close();
  let release!:()=>void,notify!:(handle:FileHandle)=>void;
  const held=new Promise<void>(resolve=>{release=resolve}),started=new Promise<FileHandle>(resolve=>{notify=resolve});let intercepted=false;
  t.mock.method(prototype,'write',async function(this:FileHandle,...args:unknown[]){
    if(!intercepted&&Buffer.isBuffer(args[0])&&args[0].equals(Buffer.from('能力观察'))){intercepted=true;notify(this);await held;}
    return original.apply(this,args);
  });
  t.after(release);return{started,release};
}
for(const kind of ['reserve','reserveLyrics'] as const)test(`共享SourceSafety459：${kind}跨真实探针await关闭不能迟到登记，FD与独有link先静止`,async t=>{
  const f=await safetyFixture459(),hold=await holdSafetyProbe459(t,f.directory);
  const reservation=kind==='reserve'?f.safety.reserve([f.target]):f.safety.reserveLyrics([f.target],4096),rejected=assert.rejects(reservation,{issue:'BACKUP_UNAVAILABLE'});
  const fd=await hold.started;assert.ok(fd.fd>=0);let closed=false;const closing=f.safety.close().then(()=>{closed=true;});
  try{
    await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(closed,false);assert.ok(fd.fd>=0);
    await assert.rejects(f.safety.reserve([f.target]),{issue:'BACKUP_UNAVAILABLE'});await assert.rejects(f.safety.reserveLyrics([f.target],1),{issue:'BACKUP_UNAVAILABLE'});
    await assert.rejects(f.safety.preflight([f.target]),{issue:'BACKUP_UNAVAILABLE'});await assert.rejects(f.safety.usage(),{issue:'BACKUP_UNAVAILABLE'});
  }finally{hold.release();}
  await rejected;await closing;assert.equal(fd.fd,-1);assert.deepEqual(await readdir(path.join(f.directory,'safety')),[]);assert.deepEqual(await readdir(f.source),[]);
});
test('共享SourceSafety459：实际Owner最后收口共享仓库，原预留未释放则保两库与材料且不重签closed',async t=>{
  async function owner(){
    const f=await safetyFixture459(),file=path.join(f.directory,'collection.sqlite'),state=createBackupWorkflowStore({filePath:path.join(f.directory,'state.sqlite')}),repository=createCollectionRepository({filePath:file,stagingRoot:path.join(f.directory,'staging')});
    repository.localCatalog.roots();const identity=state.datasetIdentities.bind('default',file,false);let connectionCloses=0;
    const domain=createTestDatasetDomain({collectionRepository:repository,backupWorkflowStore:state,collectionDatasetIdentity:identity,localSourceEpoch:randomUUID(),closeConnections(){connectionCloses++;repository.close();state.close();}});
    await domain.localSourceWrites.prepareRecoveryProtection();const shared=domain.localSourceWrites.privateLyricsSafety().sourceSafety;
    assert.equal(domain.localSourceWrites.privateLyricsSafety().sourceSafety,shared);await assert.rejects(domain.localSourceWrites.closeSourceSafety(),{issue:'RELEASE_UNKNOWN'});
    t.after(()=>{if(connectionCloses===0){repository.close();state.close();}});return{...f,domain,shared,repository,state,get connectionCloses(){return connectionCloses;}};
  }
  const quiet=await owner(),file=path.join(quiet.directory,'last-owned-resource');await writeFile(file,'仅测试持有',{flag:'wx',mode:0o600});const fd=await open(file,constants.O_RDONLY),closeSafety=quiet.shared.close;
  let safetyCloses=0;t.mock.method(quiet.shared,'close',function(){assert.equal(fd.fd,-1);assert.equal(quiet.connectionCloses,0);safetyCloses++;return closeSafety.call(quiet.shared);});
  await quiet.domain.close(()=>fd.close());assert.equal(safetyCloses,1);assert.equal(quiet.connectionCloses,1);await assert.rejects(quiet.shared.usage(),{issue:'BACKUP_UNAVAILABLE'});
  const held=await owner(),reservation=await held.shared.reserveLyrics([held.target],4096),protectedFile=path.join(reservation.directory,'原保全材料');await writeFile(protectedFile,'原材料不删除',{flag:'wx',mode:0o600});
  const closing=held.domain.close();await assert.rejects(closing,{issue:'RELEASE_UNKNOWN'});assert.equal(held.connectionCloses,0);held.repository.readonlySnapshotStamp();held.state.datasetIdentities.bind('default',path.join(held.directory,'collection.sqlite'),false);
  assert.equal(await readFile(protectedFile,'utf8'),'原材料不删除');reservation.release();assert.equal(held.domain.close(),closing);await assert.rejects(held.domain.close(),{issue:'RELEASE_UNKNOWN'});assert.equal(held.connectionCloses,0);
  t.diagnostic('实际Owner/SQLite/共享SourceSafety关闭；Native与Main2000ms未在此例装配或授资格。');
});
async function physicalFixture(t:import('node:test').TestContext,{count=2,embed=false}={}) {
  const rootDir=process.env.MB_V39_NATIVE_PROOF_DIR;assert.ok(rootDir);const dir=path.join(rootDir,'397-sql-'+randomUUID());
  for(const p of [dir,dir+'/source',dir+'/safety',dir+'/staging',dir+'/safety/eof'])await mkdir(p,{mode:0o700});
  const datasetId=randomUUID();let alive=true,epoch=randomUUID(),failCommit=false,repository=createCollectionRepository({filePath:dir+'/catalog.sqlite',stagingRoot:dir+'/staging',beforeCommit(action){if(failCommit&&action==='local-lyrics-physical:publication')throw new Error('明确受控发布事务故障')}});
  const identity={datasetId,assertCurrent(){assert.equal(alive,true)}},capability=await authorizeSourceDirectory(dir+'/source');repository.localCatalog.privateBindWorkbenchDataset(identity);
  const sourceRoot=repository.sources.authorize(randomUUID(),capability),root=repository.localCatalog.registerRoot({commandId:randomUUID(),sourceRootId:sourceRoot.id,role:'library'}),physicalRoot={...capability,id:sourceRoot.id};
  const fixture=createCueSyntheticWave(),sourceBytes:Buffer[]=[];
  for(let i=0;i<count;i++){await writeFile(dir+'/source/歌曲'+i+'.wav',fixture.wave,{flag:'wx',mode:0o600});sourceBytes.push(Buffer.from(fixture.wave));}
  const job=repository.localScan.start({commandId:randomUUID(),datasetId,libraryRootId:root.id,expectedRootRevision:root.revision,parserVersion:'controlled-lyrics397/scan'}).job,
    resumed=repository.localScan.resume({commandId:randomUUID(),jobId:job.jobId,expectedRevision:job.jobRevision});
  const items:ScanPreparedItem[]=[];for(let i=0;i<count;i++){const r=await stat(dir+'/source/歌曲'+i+'.wav',{bigint:true});items.push({relative:'歌曲'+i+'.wav',signature:[r.dev,r.ino,r.size,r.mtimeNs,r.ctimeNs].join(':'),parserVersion:'controlled-lyrics397/scan',outcome:'accepted' as const,fields:{title:'歌曲'+i,artist:'合成作者',album:'合成专辑',disc:'1',track:String(i+1)},failureCode:null,reused:false,
    readFacts:{technical:{container:'WAVE',codec:'PCM',lossless:true,sampleRateHz:fixture.sampleRate,channels:fixture.channels,bitsPerSample:24,durationSeconds:fixture.frames/fixture.sampleRate,evidence:'bounded-parser-reported' as const},coverEvidence:[],readEvidence:{bytesRead:44,readCalls:1,maxReadBytes:44,allocationBytes:44,elapsedMs:1,wholeAudioHash:false,wholeAudioDecode:false}}});}
  const batch={batchId:randomUUID(),jobId:job.jobId,expectedJobRevision:resumed.jobRevision,checkpointBefore:resumed.checkpointRef,items,frontier:[],completed:true};
  repository.localScan.privatePrepareBatch({commandId:randomUUID(),jobId:job.jobId,batch});repository.localScan.privateCommitBatch({commandId:randomUUID(),jobId:job.jobId,batchId:batch.batchId,expectedRevision:resumed.jobRevision});
  const members:LocalLyricsPhysicalMember[]=[];const resources:LocalLyricsPhysicalResource[]=[];
  for(let i=0;i<count;i++){const scan=repository.localScan.privateSourceWriteFileState(root.id,'歌曲'+i+'.wav');assert.ok(scan?.value.trackId&&scan.value.assetId);const trackId=scan.value.trackId,asset=repository.localCatalog.asset(scan.value.assetId),info=await stat(dir+'/source/歌曲'+i+'.wav',{bigint:true});
    members.push({trackId,rootId:root.id,sourceRootId:sourceRoot.id,fileId:asset.id,rootRevision:root.revision,fileRevision:asset.fileRevision,locationRevision:asset.locationRevision,metadataRevision:lyricsPhysicalDigest(repository.localCatalog.metadata(trackId)),resourceIndex:i});
    resources.push({rootId:sourceRoot.id,relative:'歌曲'+i+'.wav',sha256:digest(fixture.wave),bytes:fixture.wave.length,signature:[info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs].join(':'),birthtimeNs:String(info.birthtimeNs),permissionMode:String(info.mode&0o7777n),uid:String(info.uid),gid:String(info.gid),dev:String(info.dev),ino:String(info.ino)});
  }
  const originalGroup:LocalLyricsPhysicalGroup={members,resources},selected:LocalLyricsSelectedBody[]=members.map((m,i)=>({track:{trackId:m.trackId,title:'歌曲'+i,artist:'合成作者',album:'合成专辑',language:'zh',version:'original',durationMs:500,wholeTrack:false,format:'wav',rootRevision:m.rootRevision,fileRevision:m.fileRevision,locationRevision:m.locationRevision,metadataRevision:m.metadataRevision,lrc:'false',embedded:'false'},candidateId:randomUUID(),source:'lrclib',body:'[00:00.00]受控歌曲'+i+'\n',sha256:digest(Buffer.from('[00:00.00]受控歌曲'+i+'\n'))}));
  const request={sessionId:randomUUID(),commandId:randomUUID(),embed},draft={request,scope:{datasetId,libraryId:root.id,albumId:'controlled-album-397',captureId:randomUUID()},captureFingerprint:lyricsPhysicalDigest(originalGroup),selected},intent:LocalLyricsSaveIntent={...draft,fingerprint:localLyricsIntentFingerprint(draft)};
  repository.localCatalog.privateLyricsCompareAndSwap(datasetId,'save',{intent,receipt:{commandId:request.commandId,sessionId:request.sessionId,state:'running',cover:'saved',tracks:selected.map(s=>({trackId:s.track.trackId,lrc:'pending',embed:embed?'pending':'not-requested'})),snapshot:'not-requested'},revision:0,physicalClosed:false,discarded:false},null);
  const cueRoot=process.env.MB_V39_CUE_BUNDLE!,tagsRoot=process.env.MB_V39_TAGS_BUNDLE!,cuePin=process.env.MB_V39_CUE_MANIFEST_SHA256!,tagPin=process.env.MB_V39_TAGS_MANIFEST_SHA256!;
  let ports=channel(),actor=createSourceWritesMainActor(ports.port1),requests=0,mainDecision:'granted'|'rejected'|'hold'='granted';
  function main(){ports.port1.on('message',raw=>consumeSourceWritesLyricsGrantReply(actor,raw));ports.port2.on('message',raw=>{
    const q=captureSourceWritesLyricsGrantRequest(raw),physical=repository.localCatalog.privateLyricsPhysicalRead(identity,localLyricsPhysicalOperationId(q.binding));assert.ok(physical);assert.equal(physical.record.revision,q.revision);
    assert.equal(physical.record.binding.originalIntentSha256,q.binding.originalIntentSha256);requests++;if(mainDecision!=='hold')ports.port2.postMessage(mainDecision==='granted'?reply(q):{...reply(q),decision:'rejected',nonce:null,validUntilMs:null});
  });}
  main();let tags=createLocalAudioTagsActor(await loadLocalAudioTagsBundle(tagsRoot,tagPin)),native=await createLyricsNativeFidelityPort({cueRoot,cueManifestSha256:cuePin,tagsRoot,tagsManifestSha256:tagPin,temporaryRoot:dir+'/safety/eof'});
  function currentGroup():LocalLyricsPhysicalGroup {const current={members:originalGroup.members.map(m=>({...m})),resources:originalGroup.resources.map(r=>({...r}))};for(const m of originalGroup.members){const own=repository.localCatalog.privateLyricsPhysicalRead(identity,localLyricsPhysicalOperationId({datasetId,commandId:request.commandId,trackId:m.trackId,kind:'embed'}));if(own?.record.phase==='CLOSED'&&own.record.artifacts.target)current.resources[m.resourceIndex]=own.record.artifacts.target;}return current;}
  function compose(){return createLyricsSourceFilesAuthor({identity,ownerEpoch:epoch,catalog:repository.localCatalog,mainActor:actor,native,sourceSafety:createSourceSafetyRepository(dir+'/safety'),joinTaggedWriter:commandId=>tags.join(commandId),assertAccepting:()=>identity.assertCurrent(),
    async resolveOriginalGroup(){const actual=currentGroup();return {captureSha256:intent.captureFingerprint,group:actual,roots:[physicalRoot],assertCurrent(){identity.assertCurrent();for(const m of members){const asset=repository.localCatalog.asset(m.fileId),own=repository.localCatalog.privateLyricsPhysicalRead(identity,localLyricsPhysicalOperationId({datasetId,commandId:request.commandId,trackId:m.trackId,kind:'embed'}));assert.equal(asset.fileRevision,own?.record.phase==='CLOSED'?String(BigInt(m.fileRevision)+1n):m.fileRevision);assert.equal(lyricsPhysicalDigest(repository.localCatalog.metadata(m.trackId)),m.metadataRevision);}}};}});}
  let author=compose();
  function makeBinding(index:number,kind:'lrc'|'embed'):LocalLyricsWriteBinding {const s=selected[index]!;return {datasetId,ownerEpoch:epoch,commandId:request.commandId,sessionId:request.sessionId,intentFingerprint:intent.fingerprint,libraryId:root.id,albumId:intent.scope.albumId,captureId:intent.scope.captureId,trackId:s.track.trackId,candidateId:s.candidateId,bodySha256:s.sha256,kind,rootRevision:s.track.rootRevision,fileRevision:s.track.fileRevision,locationRevision:s.track.locationRevision,metadataRevision:s.track.metadataRevision};}
  function enabled(){const store=createLocalSourceWritesStore(repository.localCatalog),before=store.policy(datasetId),command={datasetId,commandId:randomUUID(),expectedPolicyRevision:before.revision,enabled:true},policy={enabled:true,revision:String(BigInt(before.revision)+1n),draining:false};
    store.append(sourceWritesEvent({version:1,eventId:randomUUID(),datasetId,planId:null,occurredAt:new Date().toISOString(),kind:'receipt',command:'localSourceWrites.setPolicy',request:command,requestFingerprint:sourceWritesRequestFingerprint('localSourceWrites.setPolicy',command),receipt:{datasetId,commandId:command.commandId,command:'localSourceWrites.setPolicy',requestFingerprint:sourceWritesRequestFingerprint('localSourceWrites.setPolicy',command),planId:null,jobId:null,outcome:'accepted',policy,issue:null},header:null,intent:null,ownerEpoch:epoch,policy}));assert.equal(store.policy(datasetId).enabled,true);}
  async function close(allowUnresolved=false){const results=await Promise.allSettled([author.close(),tags.close(),closePorts(ports.port1,ports.port2)]);repository.close();alive=false;if(!allowUnresolved)for(const r of results)if(r.status==='rejected')throw r.reason;}
  t.after(async()=>{if(alive)await close(true);});
  return {dir,file:dir+'/catalog.sqlite',datasetId,identity,intent,selected,originalGroup,sourceBytes,makeBinding,enabled,get author(){return author},get catalog(){return repository.localCatalog},get requests(){return requests},get actor(){return actor},get tags(){return tags},setMainDecision(value:'granted'|'rejected'|'hold'){mainDecision=value},setFailure(value:boolean){failCommit=value},close,
    async cold(allowUnresolved=false){if(alive)await close(allowUnresolved);repository=createCollectionRepository({filePath:dir+'/catalog.sqlite',stagingRoot:dir+'/staging'});alive=true;epoch=randomUUID();repository.localCatalog.privateBindWorkbenchDataset(identity);for(const r of resources)repository.localScan.privateSourceWriteFileState(root.id,r.relative);ports=channel();actor=createSourceWritesMainActor(ports.port1);main();tags=createLocalAudioTagsActor(await loadLocalAudioTagsBundle(tagsRoot,tagPin));native=await createLyricsNativeFidelityPort({cueRoot,cueManifestSha256:cuePin,tagsRoot,tagsManifestSha256:tagPin,temporaryRoot:dir+'/safety/eof'});author=compose();},
  };
}

test('实际同SQLite歌词作者默认OFF零Source写，开启后整组LRC独占发布及冷原回执不重放',{skip:!nativeConfigured},async t=>{
  const f=await physicalFixture(t);await assert.rejects(f.author.prepare(f.makeBinding(0,'lrc'),f.intent,f.selected[0]!,{authorityId:randomUUID(),active:true},new AbortController().signal));assert.equal(f.requests,0);
  f.enabled();for(let i=0;i<2;i++){const b=f.makeBinding(i,'lrc'),s=f.selected[i]!,pub=await f.author.prepare(b,f.intent,s,f.actor,new AbortController().signal);assert.equal((await f.author.publishLrcExclusive(pub,Buffer.from(s.body),new AbortController().signal)).state,'saved');await f.author.join(b.commandId);assert.deepEqual(await readFile(f.dir+'/source/歌曲'+i+'.wav'),f.sourceBytes[i]);}
  const count=f.requests;await f.cold();for(let i=0;i<2;i++)assert.equal((await f.author.readOriginal(f.makeBinding(i,'lrc')))?.state,'saved');assert.equal(f.requests,count);
});


test('同SQLite两轨保护副本embed逐轨保持原command整组捕获，EOF及源事实inventory冷读连续',{skip:!nativeConfigured},async t=>{
  const f=await physicalFixture(t,{embed:true});f.enabled();const signal=new AbortController().signal;
  for(let i=0;i<2;i++){
    const b=f.makeBinding(i,'embed'),selected=f.selected[i]!,pub=await f.author.prepare(b,f.intent,selected,f.actor,signal);assert.ok(pub.copy);
    const tagged=await f.tags.run(pub.copy,'pcm-wav',{LYRICS:selected.body},signal);assert.equal(tagged.values.LYRICS,selected.body);await f.tags.join(b.commandId);
    const result=await f.author.publishTaggedCopy(pub,selected.sha256,signal);assert.equal(result.state,'saved');await f.author.join(b.commandId);
    const actual=f.catalog.privateLyricsPhysicalRead(f.identity,localLyricsPhysicalOperationId(b));assert.ok(actual);assert.equal(actual.record.phase,'CLOSED');assert.equal(actual.record.binding.commandId,f.intent.request.commandId);
    assert.equal(actual.record.fidelity?.pcmSha256,digest(createCueSyntheticWave().pcm));assert.equal(actual.record.fidelity?.pcmBytes,createCueSyntheticWave().pcm.length);
    assert.equal(f.catalog.asset(f.originalGroup.members[i]!.fileId).fileRevision,String(BigInt(b.fileRevision)+1n));
    assert.equal(f.catalog.privateLyricsTrackFacts(f.datasetId,b.trackId,b.libraryId,String(BigInt(b.fileRevision)+1n)).embedded,'true');
    for(const kind of ['backup','quarantine'] as const){const fact:LocalLyricsPhysicalArtifact|null=actual.record.artifacts[kind];assert.ok(fact);assert.deepEqual(await readFile(f.dir+'/safety/'+fact.relative),f.sourceBytes[i]);}
  }
  const requests=f.requests;await f.cold();for(let i=0;i<2;i++){const b=f.makeBinding(i,'embed');assert.equal((await f.author.readOriginal(b))?.state,'saved');const source=await open(f.dir+'/source/歌曲'+i+'.wav',constants.O_RDONLY|constants.O_NOFOLLOW);try{const observed=await f.tags.run({fd:source.fd,commandId:b.commandId,claimId:localLyricsPhysicalOperationId(b),async assertCurrent(){f.identity.assertCurrent()}},'pcm-wav',null,signal);await f.tags.join(b.commandId);assert.equal(observed.values.LYRICS,f.selected[i]!.body);}finally{await source.close();}}
  assert.equal(f.requests,requests);
});

test('同stem已有不同LRC绝不覆盖，明确FAILED原id经冷完整probe与新Main许可恢复',{skip:!nativeConfigured},async t=>{
  const f=await physicalFixture(t,{count:1});f.enabled();const original=Buffer.from('他人已存在歌词\n');await writeFile(f.dir+'/source/歌曲0.lrc',original,{flag:'wx',mode:0o600});
  const b=f.makeBinding(0,'lrc'),selected=f.selected[0]!,signal=new AbortController().signal,pub=await f.author.prepare(b,f.intent,selected,f.actor,signal);
  assert.equal((await f.author.publishLrcExclusive(pub,Buffer.from(selected.body),signal)).state,'failed');await f.author.join(b.commandId);assert.deepEqual(await readFile(f.dir+'/source/歌曲0.lrc'),original);
  const record=f.catalog.privateLyricsPhysicalRead(f.identity,localLyricsPhysicalOperationId(b))!.record;assert.equal(record.phase,'FAILED');assert.equal(record.physicalClosed,true);assert.equal(record.protectionReleased,true);
  // 原相同正文的existing结果允许恢复；夹具只移走自己创建的冲突文件，产品作者没有覆盖它。
  await import('node:fs/promises').then(fs=>fs.rename(f.dir+'/source/歌曲0.lrc',f.dir+'/preserved-conflict.lrc'));await f.cold();
  const next=f.makeBinding(0,'lrc'),retried=await f.author.prepareFailedRetry(next,f.intent,selected,f.actor,signal);assert.equal((await f.author.publishLrcExclusive(retried,Buffer.from(selected.body),signal)).state,'saved');await f.author.join(next.commandId);
  assert.equal(f.requests,2);assert.deepEqual(await readFile(f.dir+'/preserved-conflict.lrc'),original);assert.deepEqual(await readFile(f.dir+'/source/歌曲0.wav'),f.sourceBytes[0]);
  const recovered=f.catalog.privateLyricsPhysicalRead(f.identity,localLyricsPhysicalOperationId(next))!.record;assert.equal(recovered.binding.ownerEpoch,record.binding.ownerEpoch);assert.notEqual(recovered.currentOwnerEpoch,record.currentOwnerEpoch);
});

test('Main明确拒绝的无stage FAILED仍可原body冷恢复，未受理查询与陌生作者不生成许可',{skip:!nativeConfigured},async t=>{
  const f=await physicalFixture(t,{count:1});f.enabled();const b=f.makeBinding(0,'lrc'),selected=f.selected[0]!,signal=new AbortController().signal;
  assert.equal(await f.author.readOriginal(b),null);assert.equal(f.requests,0);await assert.rejects(f.author.prepare(b,f.intent,selected,{authorityId:randomUUID(),active:true},signal));assert.equal(f.requests,0);
  f.setMainDecision('rejected');await assert.rejects(f.author.prepare(b,f.intent,selected,f.actor,signal));const failed=f.catalog.privateLyricsPhysicalRead(f.identity,localLyricsPhysicalOperationId(b))!.record;assert.equal(failed.phase,'FAILED');assert.equal(failed.artifacts.stage,null);
  f.setMainDecision('granted');await f.cold();const next=f.makeBinding(0,'lrc'),pub=await f.author.prepareFailedRetry(next,f.intent,selected,f.actor,signal);
  assert.equal((await f.author.publishLrcExclusive(pub,Buffer.from(selected.body),signal)).state,'saved');await f.author.join(next.commandId);assert.equal(f.requests,2);
});


test('完整group中非当前目标源变化整组失权，stage和原标签不能局部发布',{skip:!nativeConfigured},async t=>{
  const f=await physicalFixture(t);f.enabled();const b=f.makeBinding(0,'lrc'),selected=f.selected[0]!,signal=new AbortController().signal,pub=await f.author.prepare(b,f.intent,selected,f.actor,signal);
  const changed=Buffer.from(f.sourceBytes[1]!);changed.writeUInt8(changed.readUInt8(changed.length-1)^1,changed.length-1);await writeFile(f.dir+'/source/歌曲1.wav',changed);await assert.rejects(f.author.publishLrcExclusive(pub,Buffer.from(selected.body),signal));await f.author.join(b.commandId);
  await assert.rejects(stat(f.dir+'/source/歌曲0.lrc'),{code:'ENOENT'});assert.deepEqual(await readFile(f.dir+'/source/歌曲0.wav'),f.sourceBytes[0]);
  const failure=f.catalog.privateLyricsPhysicalRead(f.identity,localLyricsPhysicalOperationId(b))!.record;assert.equal(failure.phase,'FAILED');assert.equal(failure.physicalClosed,true);assert.equal(failure.protectionReleased,true);assert.equal(f.requests,1);
  await assert.rejects(f.author.prepareFailedRetry(b,f.intent,selected,f.actor,signal));assert.equal(f.requests,1);
});

test('Main丢回声保存原UNKNOWN，冷查不重发或换新UUID且同库同专辑pending不能绕开',{skip:!nativeConfigured},async t=>{
  const f=await physicalFixture(t,{count:1});f.enabled();f.setMainDecision('hold');const b=f.makeBinding(0,'lrc'),selected=f.selected[0]!,signal=new AbortController().signal;
  await assert.rejects(f.author.prepare(b,f.intent,selected,f.actor,signal));const before=f.catalog.privateLyricsPhysicalRead(f.identity,localLyricsPhysicalOperationId(b))!.record;assert.equal(before.phase,'UNKNOWN');assert.equal(before.unresolved,true);assert.equal(f.requests,1);
  f.setMainDecision('granted');await f.cold();const next=f.makeBinding(0,'lrc');assert.equal((await f.author.readOriginal(next))?.state,'unknown');await assert.rejects(f.author.prepareFailedRetry(next,f.intent,selected,f.actor,signal));await assert.rejects(f.author.prepare(next,f.intent,selected,f.actor,signal));assert.equal(f.requests,1);
  const draft={...f.intent,request:{...f.intent.request,commandId:randomUUID()}},other={...draft,fingerprint:localLyricsIntentFingerprint(draft)};
  assert.throws(()=>f.catalog.privateLyricsCompareAndSwap(f.datasetId,'save',{intent:other,receipt:{commandId:other.request.commandId,sessionId:other.request.sessionId,state:'running',cover:'saved',tracks:other.selected.map(s=>({trackId:s.track.trackId,lrc:'pending',embed:'not-requested'})),snapshot:'not-requested'},revision:0,physicalClosed:false,discarded:false},null));
  assert.throws(()=>f.catalog.privateLyricsPhysicalRead({datasetId:f.datasetId,assertCurrent(){}},localLyricsPhysicalOperationId(next)));await assert.rejects(stat(f.dir+'/source/歌曲0.lrc'),{code:'ENOENT'});assert.deepEqual(await readFile(f.dir+'/source/歌曲0.wav'),f.sourceBytes[0]);
});

test('同SQLite publication事务失败零事实半提交，已发布命名位保UNKNOWN及保护至原作者物理退出',{skip:!nativeConfigured},async t=>{
  const f=await physicalFixture(t,{count:1});f.enabled();const b=f.makeBinding(0,'lrc'),selected=f.selected[0]!,signal=new AbortController().signal,pub=await f.author.prepare(b,f.intent,selected,f.actor,signal),inventory=f.catalog.privateLyricsInventoryRevision(f.datasetId);
  f.setFailure(true);assert.equal((await f.author.publishLrcExclusive(pub,Buffer.from(selected.body),signal)).state,'unknown');await assert.rejects(f.author.join(b.commandId));
  const record=f.catalog.privateLyricsPhysicalRead(f.identity,localLyricsPhysicalOperationId(b))!.record;assert.equal(record.phase,'UNKNOWN');assert.equal(record.physicalClosed,false);assert.equal(record.protectionReleased,false);assert.equal(record.unresolved,true);
  assert.equal(f.catalog.privateLyricsInventoryRevision(f.datasetId),inventory);assert.equal(f.catalog.privateLyricsTrackFacts(f.datasetId,b.trackId,b.libraryId,b.fileRevision).lrc,'unknown');assert.deepEqual(await readFile(f.dir+'/source/歌曲0.wav'),f.sourceBytes[0]);assert.equal(digest(await readFile(f.dir+'/source/歌曲0.lrc')),selected.sha256);
  const requests=f.requests;await f.cold(true);const next=f.makeBinding(0,'lrc');assert.equal((await f.author.readOriginal(next))?.state,'unknown');await assert.rejects(f.author.prepareFailedRetry(next,f.intent,selected,f.actor,signal));assert.equal(f.requests,requests);
  t.diagnostic('UNKNOWN原保护在进程存活期间故意retain；此夹具进程自然退出后由OS关闭，不宣称未知已解除。');
});


test('原物理SQLite账本旧CAS与跨dataset拒绝，冷publication分块尾commit缺失不能截断为成功',{skip:!nativeConfigured},async t=>{
  const f=await physicalFixture(t,{count:1});f.enabled();const b=f.makeBinding(0,'lrc'),selected=f.selected[0]!,signal=new AbortController().signal,pub=await f.author.prepare(b,f.intent,selected,f.actor,signal);
  assert.equal((await f.author.publishLrcExclusive(pub,Buffer.from(selected.body),signal)).state,'saved');await f.author.join(b.commandId);const record=f.catalog.privateLyricsPhysicalRead(f.identity,localLyricsPhysicalOperationId(b))!.record;
  assert.throws(()=>f.catalog.privateLyricsPhysicalCompareAndSwap(f.identity,{...record,revision:record.revision+1},record.revision-1));assert.throws(()=>f.catalog.privateLyricsPhysicalRead({datasetId:randomUUID(),assertCurrent(){}},record.operationId));
  await f.close();await import('node:fs/promises').then(fs=>fs.copyFile(f.file,f.dir+'/pre-fault-catalog.sqlite',constants.COPYFILE_EXCL));const raw=new DatabaseSync(f.file);try{
    const last=raw.prepare("SELECT rowid AS sequence,command_id FROM local_catalog_ledger WHERE operation='local-lyrics-physical-v1' AND json_extract(result,'$.state.phase')='FACTS_COMMITTED' ORDER BY rowid DESC LIMIT 1").get();assert.ok(last);
    assert.throws(()=>raw.prepare('DELETE FROM local_catalog_ledger WHERE command_id=?').run(last.command_id!));
    // 只在本例自有DB注入冷损坏，并恢复同一原trigger全文；产品入口无此权限或分支。
    const trigger=raw.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='local_catalog_ledger_no_delete'").get();assert.equal(typeof trigger?.sql,'string');
    raw.exec('DROP TRIGGER local_catalog_ledger_no_delete');assert.equal(raw.prepare("DELETE FROM local_catalog_ledger WHERE operation='local-lyrics-physical-v1' AND rowid>=?").run(last.sequence!).changes,3);raw.exec(String(trigger!.sql));
  }finally{raw.close();}
  await assert.rejects(f.cold(),error=>!(error instanceof assert.AssertionError));
});

test('关闭已STAGED但未发布的作者必须实际join与FDquiet，原FAILED冷恢复不留下悬空受理',{skip:!nativeConfigured},async t=>{
  const f=await physicalFixture(t,{count:1});f.enabled();const b=f.makeBinding(0,'lrc'),selected=f.selected[0]!,signal=new AbortController().signal;
  await f.author.prepare(b,f.intent,selected,f.actor,signal);await f.close();await f.cold();const failure=f.catalog.privateLyricsPhysicalRead(f.identity,localLyricsPhysicalOperationId(b))!.record;
  assert.equal(failure.phase,'FAILED');assert.equal(failure.physicalClosed,true);assert.equal(failure.protectionReleased,true);await assert.rejects(stat(f.dir+'/source/歌曲0.lrc'),{code:'ENOENT'});
  const next=f.makeBinding(0,'lrc'),pub=await f.author.prepareFailedRetry(next,f.intent,selected,f.actor,signal);assert.equal((await f.author.publishLrcExclusive(pub,Buffer.from(selected.body),signal)).state,'saved');await f.author.join(next.commandId);
});

import * as sourceWritesDto470 from '@music-bridge/contracts';
import {createLocalSourceWritesService} from '../../src/collection/local-source-writes-service.js';

/** 470只使用原SourceWrites工厂/SQLite与自有FLAC；初始Scan是受控事实，不冒充Scanner/Main/Native资格。 */
async function sourceWritesFixture470(t:import('node:test').TestContext){
  const temporary=process.env.TMPDIR;assert.ok(temporary);assert.ok(temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const directory=await mkdtemp(path.join(temporary,'source-library470-')),file=path.join(directory,'catalog.sqlite'),datasetId=randomUUID();
  const manifestBytes=await readFile(new URL('../fixtures/mbrs012-source/manifest.json',import.meta.url));assert.equal(digest(manifestBytes),'5a3621481eb22801c020589b393c3a1ffa32e3d132766ea6e8db6e33fa47714b');
  const manifest=JSON.parse(manifestBytes.toString('utf8')) as {synthetic:boolean;allContentOwned:boolean;realLibraryUsed:boolean;files:{file:string;bytes:number;sha256:string}[]};
  assert.equal(manifest.synthetic,true);assert.equal(manifest.allContentOwned,true);assert.equal(manifest.realLibraryUsed,false);
  const entry=manifest.files.find(row=>row.file==='owned-stereo-fixed-tags.flac');assert.ok(entry);
  const bytes=await readFile(new URL('../fixtures/mbrs012-source/owned-stereo-fixed-tags.flac',import.meta.url));assert.equal(bytes.length,entry.bytes);assert.equal(digest(bytes),entry.sha256);
  let repository=createCollectionRepository({filePath:file}),alive=true;
  const identity={datasetId,assertCurrent(){assert.equal(alive,true);}};repository.localCatalog.privateBindWorkbenchDataset(identity);
  const libraries=[] as {id:string;trackId:string;file:string;bytes:Buffer}[];
  for(const label of ['甲','乙']){
    const source=path.join(directory,label);await mkdir(source,{mode:0o700});const target=path.join(source,'原曲.flac');await writeFile(target,bytes,{flag:'wx',mode:0o600});
    const capability=repository.sources.authorize(randomUUID(),await authorizeSourceDirectory(source)),root=repository.localCatalog.registerRoot({commandId:randomUUID(),sourceRootId:capability.id,role:'library'}),info=await stat(target,{bigint:true});
    const parserVersion='music-metadata-11.15.0/mbrs003-v1',start=repository.localScan.start({commandId:randomUUID(),datasetId,libraryRootId:root.id,expectedRootRevision:root.revision,parserVersion}).job,running=repository.localScan.resume({commandId:randomUUID(),jobId:start.jobId,expectedRevision:start.jobRevision});
    const prepared:ScanPreparedItem={relative:'原曲.flac',signature:[info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs].join(':'),parserVersion,outcome:'accepted',fields:{title:'原曲'+label,artist:'自有合成作者',album:'库'+label,disc:'1',track:'1'},failureCode:null,reused:false,
      readFacts:{technical:{container:'FLAC',codec:'FLAC',lossless:true,sampleRateHz:48000,channels:2,bitsPerSample:24,durationSeconds:1,evidence:'bounded-parser-reported'},coverEvidence:[],readEvidence:{bytesRead:44,readCalls:1,maxReadBytes:44,allocationBytes:44,elapsedMs:1,wholeAudioHash:false,wholeAudioDecode:false}}};
    const batch={batchId:randomUUID(),jobId:start.jobId,expectedJobRevision:running.jobRevision,checkpointBefore:running.checkpointRef,items:[prepared],frontier:[],completed:true};
    repository.localScan.privatePrepareBatch({commandId:randomUUID(),jobId:start.jobId,batch});repository.localScan.privateCommitBatch({commandId:randomUUID(),jobId:start.jobId,batchId:batch.batchId,expectedRevision:running.jobRevision});
    const scanned=repository.localScan.privateSourceWriteFileState(root.id,'原曲.flac');assert.ok(scanned?.value.trackId);libraries.push({id:root.id,trackId:scanned.value.trackId,file:target,bytes:Buffer.from(bytes)});
  }
  function compose(){return createLocalSourceWritesService({repository,datasetId,ownerEpoch:randomUUID(),assertCurrent(){identity.assertCurrent();repository.readonlySnapshotStamp();}});}
  let api=compose();await api.prepareRecoveryProtection();
  const context=api.get({datasetId,selector:{kind:'context',target:null}});assert.equal(context.kind,'context');assert.ok(context.kind==='context');assert.equal(api.setPolicy({datasetId,commandId:randomUUID(),expectedPolicyRevision:context.context.policy.revision,enabled:true}).outcome,'accepted');
  const ports=channel(),actor=createSourceWritesMainActor(ports.port1);
  function preview(indices:number[]){const target:sourceWritesDto470.LocalSourceWritesTarget=indices.length===1?{mode:'single',trackId:libraries[indices[0]!]!.trackId}:{mode:'batch',trackIds:indices.map(i=>libraries[i]!.trackId)};
    const request:sourceWritesDto470.PreviewLocalSourceWrites={datasetId,commandId:randomUUID(),intent:{kind:'tags',target,fields:{title:{action:'set',value:'新的自有标题'}}}},receipt=api.preview(request);assert.equal(receipt.outcome,'accepted');assert.ok(receipt.planId);return{request,receipt,planId:receipt.planId};}
  function plan(planId:string){const reply=api.get({datasetId,selector:{kind:'plan',planId}});assert.equal(reply.kind,'plan');assert.ok(reply.kind==='plan'&&reply.plan);return reply.plan;}
  async function ready(planId:string){const deadline=Date.now()+15000;for(;;){const value=plan(planId);if(value.state!=='PREVIEWING'){assert.equal(value.state,'READY',value.issues.join(','));await new Promise<void>(resolve=>setImmediate(resolve));return value;}assert.ok(Date.now()<deadline,'原SourceWrites预览未在原时限内完成');await new Promise<void>(resolve=>setTimeout(resolve,10));}}
  const journal=()=>repository.localCatalog.privateSourceWritesRead(view=>structuredClone(view.projection));
  async function close(){if(!alive)return;try{await api.close();await api.closeSourceSafety();}finally{await closePorts(ports.port1,ports.port2);repository.close();alive=false;}}
  t.after(async()=>{if(alive){try{await close();}catch(error){if(!journalCloseUnknown)throw error;}}});let journalCloseUnknown=false;
  return {directory,file,datasetId,identity,libraries,actor,preview,plan,ready,journal,get api(){return api},get repository(){return repository},allowPhysicalUnknown(){journalCloseUnknown=true;},close,
    async cold(){await api.close();await api.closeSourceSafety();repository.close();repository=createCollectionRepository({filePath:file});repository.localCatalog.privateBindWorkbenchDataset(identity);api=compose();await api.prepareRecoveryProtection();}};
}
async function holdSourceHandle470(t:import('node:test').TestContext,file:string,kind:'read'|'write',prototypeFile=file){
  const sample=await open(prototypeFile,constants.O_RDONLY),prototype=Object.getPrototypeOf(sample) as {read:(...args:unknown[])=>Promise<unknown>;write:(...args:unknown[])=>Promise<unknown>};await sample.close();
  let release!:()=>void,notify!:(handle:FileHandle)=>void,held=false;
  const quiet=new Promise<void>(resolve=>{release=resolve}),started=new Promise<FileHandle>(resolve=>{notify=resolve}),original=prototype[kind];
  const mock=t.mock.method(prototype,kind,async function(this:FileHandle,...args:unknown[]){
    if(!held){let named:Awaited<ReturnType<typeof stat>>|undefined;try{named=await stat(file,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      const actual=await this.stat({bigint:true});if(named&&String(named.dev)===String(actual.dev)&&String(named.ino)===String(actual.ino)){held=true;notify(this);await quiet;}}
    return original.apply(this,args);
  });t.after(release);return{started,release,restore(){mock.mock.restore();}};
}
function sourceConfirmation470(datasetId:string,plan:sourceWritesDto470.LocalSourceWritesPlan):sourceWritesDto470.ConfirmLocalSourceWrites{assert.ok(plan.planHash&&plan.contextFingerprint);return{datasetId,commandId:randomUUID(),planId:plan.planId,expectedViewRevision:plan.viewRevision,scope:'SOURCE_FILES',range:plan.range,planHash:plan.planHash,contextFingerprint:plan.contextFingerprint};}

test('按库源写470：PREVIEWING原FD先join，只封原甲plan与grant，乙库及共享Safety保持可用',{concurrency:false},async t=>{
  const f=await sourceWritesFixture470(t),other=f.preview([1]),otherPlan=await f.ready(other.planId),confirm=sourceConfirmation470(f.datasetId,otherPlan),grant=f.api.challenge({datasetId:f.datasetId,confirm},f.actor);
  const held=await holdSourceHandle470(t,f.libraries[0]!.file,'read'),origin=f.preview([0]),fd=await held.started,before=f.journal();assert.ok(fd.fd>=0);assert.equal(before.plans.get(origin.planId)!.items.length,0);
  let stopped=false;const originalStop=f.api.privateStopLibrary(f.libraries[0]!.id),closing=originalStop.then(()=>{stopped=true;});assert.equal(f.api.privateStopLibrary(f.libraries[0]!.id),originalStop);
  try{await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(stopped,false);assert.ok(fd.fd>=0);assert.equal(f.plan(other.planId).state,'READY');assert.equal(f.actor.active,true);}finally{held.release();}
  await closing;assert.equal(fd.fd,-1);assert.equal(f.plan(origin.planId).state,'CANCELLED');assert.equal(f.plan(other.planId).state,'READY');
  assert.equal(f.api.challenge({datasetId:f.datasetId,confirm},f.actor).planId,grant.planId);await f.api.privateLyricsSafety().sourceSafety.usage();
  const after=f.journal();assert.deepEqual([...after.plans.keys()],[...before.plans.keys()]);assert.equal(after.events.filter(event=>event.kind==='receipt').length,before.events.filter(event=>event.kind==='receipt').length);
  for(const lib of f.libraries)assert.deepEqual(await readFile(lib.file),lib.bytes);
  const denied=f.api.preview({datasetId:f.datasetId,commandId:randomUUID(),intent:{kind:'tags',target:{mode:'single',trackId:f.libraries[0]!.trackId},fields:{title:{action:'set',value:'迟到不得复活'}}}});assert.equal(denied.outcome,'rejected');assert.equal(denied.issue,'SOURCE_REVOKED');
  t.diagnostic('原服务/原controller/真实FD关闭；乙库Main actor仅是实际MessagePort品牌，未声称完整Main或Native资格。');
});
test('按库源写470：混甲乙原整组先拒绝撤甲，不cancel别库、不新plan或command',{concurrency:false},async t=>{
  const f=await sourceWritesFixture470(t),held=await holdSourceHandle470(t,f.libraries[0]!.file,'read'),origin=f.preview([0,1]),fd=await held.started,before=f.journal();
  try{await assert.rejects(f.api.privateStopLibrary(f.libraries[0]!.id),{code:'SHARED_RESOURCE_UNKNOWN'});assert.ok(fd.fd>=0);assert.equal(f.plan(origin.planId).state,'PREVIEWING');assert.deepEqual(f.journal(),before);}finally{held.release();}
  const plan=await f.ready(origin.planId);assert.equal(plan.items.length,2);assert.equal(fd.fd,-1);for(const lib of f.libraries)assert.deepEqual(await readFile(lib.file),lib.bytes);
});
test('按库源写470：原publisher stage写FD未闭不能授成功，abort同plan且保源与原材料',{concurrency:false},async t=>{
  const f=await sourceWritesFixture470(t),origin=f.preview([0]),plan=await f.ready(origin.planId),item=plan.items[0]!;
  const stage=path.join(f.directory,'source-writes','safety',item.operationId,'stage'),held=await holdSourceHandle470(t,stage,'write',f.libraries[0]!.file),confirm=sourceConfirmation470(f.datasetId,plan),challenge=f.api.challenge({datasetId:f.datasetId,confirm},f.actor);
  assert.equal(f.api.executeGranted({datasetId:f.datasetId,confirm,grant:challenge.grant},f.actor).outcome,'accepted');const fd=await held.started;assert.ok(fd.fd>=0);const before=f.journal();let stopped=false;
  const closing=f.api.privateStopLibrary(f.libraries[0]!.id).then(()=>{stopped=true;});try{await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(stopped,false);assert.ok(fd.fd>=0);}finally{held.release();}
  await closing;assert.equal(fd.fd,-1);assert.equal(f.plan(origin.planId).state,'CANCELLED');assert.deepEqual(await readFile(f.libraries[0]!.file),f.libraries[0]!.bytes);
  const after=f.journal();assert.deepEqual([...after.plans.keys()],[...before.plans.keys()]);assert.equal(after.events.filter(event=>event.kind==='receipt').length,before.events.filter(event=>event.kind==='receipt').length);
  assert.ok((await readdir(path.join(f.directory,'source-writes','safety',item.operationId))).includes('backup'));await f.api.privateLyricsSafety().sourceSafety.usage();
});
test('按库源写470：冷SQL原READY没有本进程physicalProof仍拒绝，原命令与材料不变',{concurrency:false},async t=>{
  const f=await sourceWritesFixture470(t),origin=f.preview([0]);await f.ready(origin.planId);await f.cold();const before=f.journal();
  await assert.rejects(f.api.privateStopLibrary(f.libraries[0]!.id),{code:'RELEASE_UNKNOWN'});assert.deepEqual(f.journal(),before);const command=f.api.get({datasetId:f.datasetId,selector:{kind:'command',commandId:origin.request.commandId,expectedCommand:'localSourceWrites.preview',requestFingerprint:origin.receipt.requestFingerprint}});assert.equal(command.kind,'command');assert.ok(command.kind==='command');assert.deepEqual(command.receipt,origin.receipt);
  for(const lib of f.libraries)assert.deepEqual(await readFile(lib.file),lib.bytes);assert.equal(f.plan(origin.planId).state,'BLOCKED');
});
test('按库源写470：实际原FD close拒绝保RELEASE_UNKNOWN，原stop重复不转绿、不清材料',{concurrency:false},async t=>{
  const f=await sourceWritesFixture470(t),held=await holdSourceHandle470(t,f.libraries[0]!.file,'read'),origin=f.preview([0]),fd=await held.started,original=fd.close.bind(fd);let refused=false;
  const closeMock=t.mock.method(fd,'close',async()=>{if(!refused){refused=true;throw new Error('受控原FD关闭失败470');}return original();});f.allowPhysicalUnknown();
  const closing=f.api.privateStopLibrary(f.libraries[0]!.id),rejected=assert.rejects(closing,{code:'RELEASE_UNKNOWN'});try{assert.equal(f.api.privateStopLibrary(f.libraries[0]!.id),closing);held.release();await rejected;assert.ok(fd.fd>=0);const retained=f.plan(origin.planId);assert.equal(retained.state,'FAILED');assert.ok(retained.issues.includes('RELEASE_UNKNOWN'));assert.equal(retained.readyAt,null);assert.equal(retained.planHash,null);assert.deepEqual(retained.items,[]);assert.ok(sourceWritesDto470.isLocalSourceWritesPlan(retained));
    const before=f.journal();assert.throws(()=>f.api.preview(origin.request),{code:'INVENTORY_UNAVAILABLE'});assert.throws(()=>f.api.get({datasetId:randomUUID(),selector:{kind:'plan',planId:origin.planId}}),{code:'DATASET_SCOPE_MISMATCH'});assert.deepEqual(f.journal(),before);await assert.rejects(f.api.privateStopLibrary(f.libraries[0]!.id),{code:'RELEASE_UNKNOWN'});assert.deepEqual(f.journal(),before);await assert.rejects(f.api.close(),{code:'RELEASE_UNKNOWN'});await assert.rejects(f.api.closeSourceSafety(),{issue:'RELEASE_UNKNOWN'});for(const lib of f.libraries)assert.deepEqual(await readFile(lib.file),lib.bytes);
  }finally{closeMock.mock.restore();await original();}assert.equal(fd.fd,-1);
  t.diagnostic('受控关闭故障真实保留FD与原claim；手动结束测试自有FD不回写quiet，不提升Owner关闭资格。');
});

async function completedSourcePlan476(f:Awaited<ReturnType<typeof sourceWritesFixture470>>,indices:number[]){
  const origin=f.preview(indices),plan=await f.ready(origin.planId),confirm=sourceConfirmation470(f.datasetId,plan),challenge=f.api.challenge({datasetId:f.datasetId,confirm},f.actor);
  const executed=f.api.executeGranted({datasetId:f.datasetId,confirm,grant:challenge.grant},f.actor);assert.equal(executed.outcome,'accepted');
  const deadline=Date.now()+15000;for(;;){const current=f.plan(origin.planId);if(['COMPLETED','PARTIAL','FAILED','CANCELLED','RECOVERY_REQUIRED'].includes(current.state)){assert.equal(current.state,'COMPLETED',current.issues.join(','));return{origin,confirm,executed,plan:current};}assert.ok(Date.now()<deadline,'原publisher未按原时限完成');await new Promise<void>(resolve=>setTimeout(resolve,10));}
}
test('冷源写闭集476：真实两库publisher全部完成后原同SQL闭口可撤甲，旧账和两库音乐材料保留',{concurrency:false},async t=>{
  const f=await sourceWritesFixture470(t),completed=await completedSourcePlan476(f,[0,1]),written=await Promise.all(f.libraries.map(lib=>readFile(lib.file)));
  const original=f.journal().plans.get(completed.origin.planId)!;assert.equal(original.items.length,2);assert.ok(original.events.some(event=>event.kind==='protection-closed'&&event.operationIds.length===2));
  const materialBefore=new Map<string,Buffer>();for(const item of original.items){const backup=path.join(f.directory,'source-writes','safety',item.item.operationId,'backup');materialBefore.set(backup,await readFile(backup));}
  await f.cold();const before=f.journal(),closed=f.api.privateStopLibrary(f.libraries[0]!.id);assert.equal(f.api.privateStopLibrary(f.libraries[0]!.id),closed);await closed;assert.deepEqual(f.journal(),before);
  for(let i=0;i<f.libraries.length;i++)assert.deepEqual(await readFile(f.libraries[i]!.file),written[i]);for(const [file,bytes]of materialBefore)assert.deepEqual(await readFile(file),bytes);
  const command=f.api.get({datasetId:f.datasetId,selector:{kind:'command',commandId:completed.confirm.commandId,expectedCommand:'localSourceWrites.confirm',requestFingerprint:completed.executed.requestFingerprint}});assert.equal(command.kind,'command');assert.ok(command.kind==='command');assert.deepEqual(command.receipt,completed.executed);
  const other=f.preview([1]);await f.ready(other.planId);assert.equal(f.plan(completed.origin.planId).state,'COMPLETED');
  t.diagnostic('实际SourceWrites plan/grant/publisher/facts/FD与同SQLite冷工厂；未装配完整C03/Main2000ms/Native actor。');
});
test('冷源写闭集476：原READY已完成预览且从未confirm的持久CANCELLED可撤库，原捕获和文件不变',{concurrency:false},async t=>{
  const f=await sourceWritesFixture470(t),origin=f.preview([0]),ready=await f.ready(origin.planId),cancel=f.api.cancel({datasetId:f.datasetId,commandId:randomUUID(),planId:ready.planId,expectedViewRevision:ready.viewRevision});assert.equal(cancel.outcome,'accepted');assert.equal(f.plan(origin.planId).state,'CANCELLED');
  await f.cold();const before=f.journal(),original=before.plans.get(origin.planId)!;assert.ok(original.ready);assert.ok(original.items.length);assert.equal(original.events.some(event=>event.kind==='phase'||event.kind==='facts'||event.kind==='directory-facts'),false);
  assert.equal([...before.receipts.values()].some(event=>event.planId===origin.planId&&event.command==='localSourceWrites.confirm'&&event.receipt.outcome==='accepted'),false);
  await f.api.privateStopLibrary(f.libraries[0]!.id);assert.deepEqual(f.journal(),before);for(const lib of f.libraries)assert.deepEqual(await readFile(lib.file),lib.bytes);
});
test('冷源写闭集476：原真实闭口marker不能覆盖同SQL后来UNKNOWN issue，旧账原材料保留且不补执行',{concurrency:false},async t=>{
  const f=await sourceWritesFixture470(t),completed=await completedSourcePlan476(f,[0]),written=await readFile(f.libraries[0]!.file);await f.cold();
  // 受控持久不确定负例：只写测试自有SQL的原plan状态，保留实际publisher原件与closure，不能把它当新成功。
  const store=createLocalSourceWritesStore(f.repository.localCatalog);store.state(f.datasetId,completed.origin.planId,'RECOVERY_REQUIRED',['RELEASE_UNKNOWN'],true);store.close();f.allowPhysicalUnknown();const before=f.journal();
  assert.ok(before.plans.get(completed.origin.planId)!.events.some(event=>event.kind==='protection-closed'));await assert.rejects(f.api.privateStopLibrary(f.libraries[0]!.id),{code:'RELEASE_UNKNOWN'});assert.deepEqual(f.journal(),before);assert.deepEqual(await readFile(f.libraries[0]!.file),written);
  const command=f.api.get({datasetId:f.datasetId,selector:{kind:'command',commandId:completed.confirm.commandId,expectedCommand:'localSourceWrites.confirm',requestFingerprint:completed.executed.requestFingerprint}});assert.ok(command.kind==='command');assert.deepEqual(command.receipt,completed.executed);assert.deepEqual(f.journal(),before);
});

import {backup as backupSQLite488} from 'node:sqlite';
import {SourcePublisherError as SourcePublisherError488} from '../../src/collection/source-writes-publisher.js';
import {type SourceStoredPlan as SourceStoredPlan488,type SourceWritesRunClosed as SourceWritesRunClosed488,sourceWritesAcceptedScope as sourceWritesAcceptedScope488} from '../../src/collection/local-source-writes-journal.js';

/** 488是原SourceWrites/SQLite/真实FD组件候选；初始Scan仍为470受控种子，不能升级Main/Native/整C03资格。 */
type SourceFixture488=Awaited<ReturnType<typeof sourceWritesFixture470>>;
async function sourceRunClosed488(f:SourceFixture488,planId:string,stage:'preview'|'execute'){
  const deadline=Date.now()+15000;
  for(;;){const stored=f.journal().plans.get(planId);assert.ok(stored);const closed=[...stored.events].reverse().find((event):event is SourceWritesRunClosed488=>event.kind==='run-closed'&&event.stage===stage);
    if(closed)return{stored,closed};assert.ok(!stored.plan.issues.includes('RELEASE_UNKNOWN')&&!stored.plan.issues.includes('COMMIT_UNKNOWN'),stored.plan.issues.join(','));
    assert.ok(Date.now()<deadline,'原run未在原测试时限内产生实际关闭证书');await new Promise<void>(resolve=>setTimeout(resolve,10));}
}
function sourceAcceptScope488(f:SourceFixture488,planId:string,commandId:string,indices:number[]){
  const view=f.journal(),stored=view.plans.get(planId);assert.ok(stored);const scope=sourceWritesAcceptedScope488(stored),receipt=view.receipts.get(commandId);assert.ok(scope&&receipt);
  assert.equal(scope.commandId,commandId);assert.equal(scope.requestFingerprint,receipt.requestFingerprint);assert.equal(scope.ownerEpoch,stored.ownerEpoch);assert.equal(receipt.ownerEpoch,stored.ownerEpoch);
  assert.equal(view.events.indexOf(scope),view.events.indexOf(receipt)+1);
  assert.deepEqual(scope.libraryRoots,indices.map(index=>f.repository.localCatalog.root(f.libraries[index]!.id)));
  return{stored,scope,receipt};
}
function sourceClosureReceipt488(f:SourceFixture488,stored:SourceStoredPlan488,closed:SourceWritesRunClosed488,commandId:string){
  const view=f.journal(),receipt=view.receipts.get(commandId),scope=sourceWritesAcceptedScope488(stored);assert.ok(receipt&&scope);
  assert.equal(closed.runReceiptEventId,receipt.eventId);assert.equal(closed.scopeEventId,scope.eventId);assert.equal(closed.ownerEpoch,stored.ownerEpoch);assert.equal(closed.physicalClosed,true);
  assert.deepEqual(closed.operationIds,stored.items.map(item=>item.item.operationId));const at=stored.events.indexOf(closed);assert.ok(at>0);assert.equal(closed.afterEventHash,stored.events[at-1]!.eventHash);
  assert.equal(closed.closedState,stored.plan.state);
}
function executeSource488(f:SourceFixture488,plan:sourceWritesDto470.LocalSourceWritesPlan){
  const confirm=sourceConfirmation470(f.datasetId,plan),challenge=f.api.challenge({datasetId:f.datasetId,confirm},f.actor),executed=f.api.executeGranted({datasetId:f.datasetId,confirm,grant:challenge.grant},f.actor);assert.equal(executed.outcome,'accepted');return{confirm,executed};
}
async function failActualStageWrite488(t:import('node:test').TestContext,file:string,prototypeFile:string){
  const sample=await open(prototypeFile,constants.O_RDONLY),prototype=Object.getPrototypeOf(sample) as {write:(...args:unknown[])=>Promise<unknown>};await sample.close();
  const original=prototype.write;let failed:FileHandle|null=null;
  const mock=t.mock.method(prototype,'write',async function(this:FileHandle,...args:unknown[]){
    let matching=false;if(!failed){try{const named=await stat(file,{bigint:true}),actual=await this.stat({bigint:true});matching=named.dev===actual.dev&&named.ino===actual.ino;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
    const value=await original.apply(this,args);
    // 先调用真实写入，再只在原stage的可归因零发布点报错；close/claims/namespace/Safety都由原publisher完成。
    if(matching&&!failed){failed=this;throw new SourcePublisherError488('BACKUP_UNAVAILABLE');}return value;
  });
  return{get failedHandle(){return failed},restore(){mock.mock.restore();}};
}
async function failUnmovedReadAfterFact488(t:import('node:test').TestContext,f:SourceFixture488,file:string){
  const firstAsset=f.repository.localCatalog.track(f.libraries[0]!.trackId).assetId,sample=await open(file,constants.O_RDONLY),prototype=Object.getPrototypeOf(sample) as {read:(...args:unknown[])=>Promise<unknown>};await sample.close();
  const original=prototype.read;let failed:FileHandle|null=null;
  const mock=t.mock.method(prototype,'read',async function(this:FileHandle,...args:unknown[]){
    let matching=false;
    if(!failed&&f.repository.localCatalog.asset(firstAsset).fileRevision==='2'){
      const named=await stat(file,{bigint:true}),actual=await this.stat({bigint:true});matching=named.dev===actual.dev&&named.ino===actual.ino;
    }
    const value=await original.apply(this,args);
    // 第二原文件仍未移动；第一项事实已由原同SQL提交，随后真实读取故障应产生PARTIAL。
    if(matching&&!failed){failed=this;throw new SourcePublisherError488('BACKUP_UNAVAILABLE');}return value;
  });
  return{get failedHandle(){return failed},restore(){mock.mock.restore();}};
}
async function sourceMaterials488(f:SourceFixture488,stored:SourceStoredPlan488){
  const result=new Map<string,Buffer>();
  for(const item of stored.items){const directory=path.join(f.directory,'source-writes','safety',item.item.operationId);let names:string[];try{names=await readdir(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    for(const name of ['backup','stage','quarantine'])if(names.includes(name)){const file=path.join(directory,name);result.set(file,await readFile(file));}}
  return result;
}
async function verifyColdSource488(f:SourceFixture488,planId:string,command:sourceWritesDto470.LocalSourceWritesReceiptCommand,commandId:string,receipt:sourceWritesDto470.LocalSourceWritesReceipt){
  const written=await Promise.all(f.libraries.map(library=>readFile(library.file))),materials=await sourceMaterials488(f,f.journal().plans.get(planId)!);
  await f.cold();const before=f.journal(),stopped=f.api.privateStopLibrary(f.libraries[0]!.id);assert.equal(f.api.privateStopLibrary(f.libraries[0]!.id),stopped);await stopped;assert.deepEqual(f.journal(),before);
  const original=f.api.get({datasetId:f.datasetId,selector:{kind:'command',commandId,expectedCommand:command,requestFingerprint:receipt.requestFingerprint}});assert.ok(original.kind==='command');assert.deepEqual(original.receipt,receipt);assert.deepEqual(f.journal(),before);
  for(let index=0;index<f.libraries.length;index++)assert.deepEqual(await readFile(f.libraries[index]!.file),written[index]);for(const [file,bytes]of materials)assert.deepEqual(await readFile(file),bytes);
  const other=f.preview([1]);await f.ready(other.planId);assert.ok(f.journal().plans.has(planId));
  return{before,materials,written};
}

test('冷源写欠证488：未READY原预览失败与取消持久原库归属，真实FD闭口后冷撤甲保乙',{concurrency:false},async t=>{
  for(const outcome of ['failed','cancelled'] as const){
    const f=await sourceWritesFixture470(t),held=await holdSourceHandle470(t,f.libraries[0]!.file,'read'),origin=f.preview([0]);
    const accepted=sourceAcceptScope488(f,origin.planId,origin.request.commandId,[0]);assert.equal(accepted.stored.items.length,0);assert.equal(accepted.stored.ready,null);const fd=await held.started;assert.ok(fd.fd>=0);
    assert.equal(f.journal().plans.get(origin.planId)!.events.some(event=>event.kind==='run-closed'),false);
    if(outcome==='failed')await writeFile(f.libraries[0]!.file,Buffer.concat([f.libraries[0]!.bytes,Buffer.from([1])]));
    else{const current=f.plan(origin.planId),cancel=f.api.cancel({datasetId:f.datasetId,commandId:randomUUID(),planId:origin.planId,expectedViewRevision:current.viewRevision});assert.equal(cancel.outcome,'accepted');assert.equal(f.plan(origin.planId).state,'CANCEL_REQUESTED');}
    held.release();const done=await sourceRunClosed488(f,origin.planId,'preview');held.restore();assert.equal(fd.fd,-1);assert.equal(done.stored.ready,null);assert.equal(done.stored.items.length,0);assert.equal(done.stored.plan.planHash,null);
    assert.equal(done.stored.plan.state,outcome==='failed'?'BLOCKED':'CANCELLED');assert.equal(done.closed.publisher,'not-started');sourceClosureReceipt488(f,done.stored,done.closed,origin.request.commandId);
    const bytes=await Promise.all(f.libraries.map(library=>readFile(library.file)));await f.cold();const before=f.journal();
    // 冷准入必须仅消费原持久roots，不读取后来track/asset来猜受理归属。
    const assetLookup=t.mock.method(f.repository.localCatalog,'asset',()=>{throw new Error('禁止按当前asset补旧归属488');});
    const trackLookup=t.mock.method(f.repository.localCatalog,'track',()=>{throw new Error('禁止按当前track补旧归属488');});
    try{await f.api.privateStopLibrary(f.libraries[0]!.id);assert.equal(assetLookup.mock.callCount(),0);assert.equal(trackLookup.mock.callCount(),0);}finally{assetLookup.mock.restore();trackLookup.mock.restore();}
    assert.deepEqual(f.journal(),before);for(let index=0;index<f.libraries.length;index++)assert.deepEqual(await readFile(f.libraries[index]!.file),bytes[index]);
    const command=f.api.get({datasetId:f.datasetId,selector:{kind:'command',commandId:origin.request.commandId,expectedCommand:'localSourceWrites.preview',requestFingerprint:origin.receipt.requestFingerprint}});assert.ok(command.kind==='command');assert.deepEqual(command.receipt,origin.receipt);
    const history=f.api.history({datasetId:f.datasetId,selector:{kind:'events',planId:origin.planId},cursor:null,limit:100});assert.equal(history.kind,'events');assert.ok(history.items.some(event=>event.eventId===done.closed.eventId));assert.deepEqual(f.journal(),before);
    const other=f.preview([1]);await f.ready(other.planId);
  }
});
test('冷源写欠证488：真实两库publisher原PARTIAL整组资源释放后持久闭口，冷撤不改已应用事实',{concurrency:false},async t=>{
  const f=await sourceWritesFixture470(t),origin=f.preview([0,1]),ready=await f.ready(origin.planId),second=ready.items[1]!,stage=path.join(f.directory,'source-writes','safety',second.operationId,'stage');
  sourceAcceptScope488(f,origin.planId,origin.request.commandId,[0,1]);const fault=await failUnmovedReadAfterFact488(t,f,f.libraries[1]!.file);const executed=executeSource488(f,ready);
  let done:Awaited<ReturnType<typeof sourceRunClosed488>>;try{done=await sourceRunClosed488(f,origin.planId,'execute');}finally{fault.restore();}
  assert.equal(done.stored.plan.state,'PARTIAL');assert.equal(done.closed.publisher,'released');assert.ok(fault.failedHandle);assert.equal(fault.failedHandle.fd,-1);
  assert.equal(done.stored.items[0]!.item.state,'applied');assert.equal(done.stored.items[1]!.item.state,'not-written');assert.equal(done.stored.items[0]!.item.currentFileRevision,'2');assert.equal(done.stored.items[1]!.item.currentFileRevision,'1');
  assert.notDeepEqual(await readFile(f.libraries[0]!.file),f.libraries[0]!.bytes);assert.deepEqual(await readFile(f.libraries[1]!.file),f.libraries[1]!.bytes);
  for(const item of done.stored.items){const quiet=done.stored.events.filter(event=>event.kind==='phase'&&event.fact.operationId===item.item.operationId).at(-1);assert.ok(quiet?.kind==='phase');assert.equal(quiet.fact.phase,'QUIET');assert.ok(done.stored.events.indexOf(quiet)<done.stored.events.indexOf(done.closed));}
  sourceClosureReceipt488(f,done.stored,done.closed,executed.confirm.commandId);assert.equal(done.stored.events.some(event=>event.kind==='recovery-resolved'),false);
  const before=await verifyColdSource488(f,origin.planId,'localSourceWrites.confirm',executed.confirm.commandId,executed.executed);assert.ok(before.materials.size>=4);
});
test('冷源写欠证488：真实publisher原FAILED零发布在资源全释放后冷认证，原stage备份与源材料保留',{concurrency:false},async t=>{
  const f=await sourceWritesFixture470(t),origin=f.preview([0]),ready=await f.ready(origin.planId),stage=path.join(f.directory,'source-writes','safety',ready.items[0]!.operationId,'stage'),fault=await failActualStageWrite488(t,stage,f.libraries[0]!.file),executed=executeSource488(f,ready);
  let done:Awaited<ReturnType<typeof sourceRunClosed488>>;try{done=await sourceRunClosed488(f,origin.planId,'execute');}finally{fault.restore();}
  assert.equal(done.stored.plan.state,'FAILED');assert.deepEqual(done.stored.plan.issues,['BACKUP_UNAVAILABLE']);assert.equal(done.closed.publisher,'released');assert.ok(fault.failedHandle);assert.equal(fault.failedHandle.fd,-1);assert.equal(done.stored.items[0]!.item.state,'not-written');
  assert.equal(done.stored.events.some(event=>event.kind==='facts'||event.kind==='directory-facts'||event.kind==='recovery-resolved'),false);sourceClosureReceipt488(f,done.stored,done.closed,executed.confirm.commandId);
  const before=await verifyColdSource488(f,origin.planId,'localSourceWrites.confirm',executed.confirm.commandId,executed.executed);assert.ok(before.materials.has(stage));assert.ok(before.materials.has(path.join(path.dirname(stage),'backup')));assert.deepEqual(before.written[0],f.libraries[0]!.bytes);
});
test('冷源写欠证488：原CANCELLED必须等待held stage FD与原publisher释放，冷撤不重签原命令',{concurrency:false},async t=>{
  const f=await sourceWritesFixture470(t),origin=f.preview([0]),ready=await f.ready(origin.planId),stage=path.join(f.directory,'source-writes','safety',ready.items[0]!.operationId,'stage'),held=await holdSourceHandle470(t,stage,'write',f.libraries[0]!.file),executed=executeSource488(f,ready),fd=await held.started;
  const cancelRequest={datasetId:f.datasetId,commandId:randomUUID(),planId:origin.planId,expectedViewRevision:f.plan(origin.planId).viewRevision},cancel=f.api.cancel(cancelRequest);assert.equal(cancel.outcome,'accepted');assert.equal(f.plan(origin.planId).state,'CANCEL_REQUESTED');assert.ok(fd.fd>=0);
  const previewClosures=f.journal().plans.get(origin.planId)!.events.filter(event=>event.kind==='run-closed');assert.equal(previewClosures.length,1);assert.equal(previewClosures[0]!.kind,'run-closed');assert.ok(previewClosures[0]?.kind==='run-closed');assert.equal(previewClosures[0].stage,'preview');
  held.release();const done=await sourceRunClosed488(f,origin.planId,'execute');held.restore();assert.equal(fd.fd,-1);assert.equal(done.stored.plan.state,'CANCELLED');assert.equal(done.closed.publisher,'released');sourceClosureReceipt488(f,done.stored,done.closed,executed.confirm.commandId);
  assert.equal(done.stored.events.some(event=>event.kind==='facts'||event.kind==='directory-facts'),false);
  const before=await verifyColdSource488(f,origin.planId,'localSourceWrites.confirm',executed.confirm.commandId,executed.executed);
  const raw=f.api.get({datasetId:f.datasetId,selector:{kind:'command',commandId:cancelRequest.commandId,expectedCommand:'localSourceWrites.cancel',requestFingerprint:cancel.requestFingerprint}});assert.ok(raw.kind==='command');assert.deepEqual(raw.receipt,cancel);assert.equal(before.before.receipts.get(cancelRequest.commandId)!.receipt.commandId,cancelRequest.commandId);
});
/** 只在新增独立SQLite副本构造旧格式欠证负例；原数据库/账本/命令/材料逐字保留，不生成恢复UUID或补证。 */
async function legacyWithoutCertificates488(t:import('node:test').TestContext,f:SourceFixture488){
  const before=f.journal(),copy=path.join(f.directory,'legacy-no-closure488.sqlite'),source=new DatabaseSync(f.file,{readOnly:true});
  try{await backupSQLite488(source,copy);}finally{source.close();}
  assert.notEqual(copy,f.file);const writable=new DatabaseSync(copy);
  try{
    // 仅独立测试副本暂时解除精确DELETE触发器以构造旧schema；恢复原SQL，原库全程只读。
    const trigger=writable.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='local_catalog_ledger_no_delete'").get();assert.ok(trigger&&typeof trigger.sql==='string');
    writable.exec('DROP TRIGGER local_catalog_ledger_no_delete');
    try{writable.prepare("DELETE FROM local_catalog_ledger WHERE operation='SOURCE_WRITES_V1' AND json_extract(request,'$.kind') IN ('accepted-scope','run-closed')").run();}
    finally{writable.exec(trigger.sql as string);}
    assert.equal(writable.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='local_catalog_ledger_no_delete'").get()!.sql,trigger.sql);
  }finally{writable.close();}
  assert.deepEqual(f.journal(),before);const repository=createCollectionRepository({filePath:copy});let alive=true;
  repository.localCatalog.privateBindWorkbenchDataset({datasetId:f.datasetId,assertCurrent(){assert.equal(alive,true);}});
  const api=createLocalSourceWritesService({repository,datasetId:f.datasetId,ownerEpoch:randomUUID(),assertCurrent(){assert.equal(alive,true);repository.readonlySnapshotStamp();}});
  await api.prepareRecoveryProtection();t.after(async()=>{try{await api.close();await api.closeSourceSafety();}finally{repository.close();alive=false;}});
  return{api,journal:()=>repository.localCatalog.privateSourceWritesRead(view=>structuredClone(view.projection)),originalBefore:before};
}
test('冷源写欠证488：旧空归属和旧PARTIAL缺释放证书保持拒绝，真实关闭失败与后来UNKNOWN绝不补绿',{concurrency:false},async t=>{
  // 原空预览取消的真实历史在独立SQL副本移去新增两类内部事件，复制的是旧schema的准确原字段，原件仍在。
  const empty=await sourceWritesFixture470(t),held=await holdSourceHandle470(t,empty.libraries[0]!.file,'read'),origin=empty.preview([0]);await held.started;
  assert.equal(empty.api.cancel({datasetId:empty.datasetId,commandId:randomUUID(),planId:origin.planId,expectedViewRevision:empty.plan(origin.planId).viewRevision}).outcome,'accepted');held.release();await sourceRunClosed488(empty,origin.planId,'preview');held.restore();await empty.cold();
  const legacyEmpty=await legacyWithoutCertificates488(t,empty),beforeEmpty=legacyEmpty.journal();assert.equal(beforeEmpty.plans.get(origin.planId)!.items.length,0);assert.equal(beforeEmpty.plans.get(origin.planId)!.events.some(event=>event.kind==='accepted-scope'||event.kind==='run-closed'),false);
  await assert.rejects(legacyEmpty.api.privateStopLibrary(empty.libraries[0]!.id),{code:'RELEASE_UNKNOWN'});await assert.rejects(legacyEmpty.api.privateStopLibrary(empty.libraries[1]!.id),{code:'RELEASE_UNKNOWN'});assert.deepEqual(legacyEmpty.journal(),beforeEmpty);assert.deepEqual(empty.journal(),legacyEmpty.originalBefore);

  const partial=await sourceWritesFixture470(t),partialOrigin=partial.preview([0,1]),ready=await partial.ready(partialOrigin.planId),stage=path.join(partial.directory,'source-writes','safety',ready.items[1]!.operationId,'stage'),fault=await failUnmovedReadAfterFact488(t,partial,partial.libraries[1]!.file);executeSource488(partial,ready);
  try{assert.equal((await sourceRunClosed488(partial,partialOrigin.planId,'execute')).stored.plan.state,'PARTIAL');}finally{fault.restore();}await partial.cold();
  const materials=await sourceMaterials488(partial,partial.journal().plans.get(partialOrigin.planId)!),legacyPartial=await legacyWithoutCertificates488(t,partial),beforePartial=legacyPartial.journal(),legacyPlan=beforePartial.plans.get(partialOrigin.planId)!;assert.equal(legacyPlan.plan.state,'PARTIAL');assert.ok(legacyPlan.events.some(event=>event.kind==='phase'&&event.fact.phase==='QUIET'));assert.equal(legacyPlan.events.some(event=>event.kind==='run-closed'||event.kind==='protection-closed'),false);
  await assert.rejects(legacyPartial.api.privateStopLibrary(partial.libraries[0]!.id),{code:'RELEASE_UNKNOWN'});assert.deepEqual(legacyPartial.journal(),beforePartial);assert.deepEqual(partial.journal(),legacyPartial.originalBefore);for(const [file,bytes]of materials)assert.deepEqual(await readFile(file),bytes);

  const late=createLocalSourceWritesStore(partial.repository.localCatalog);late.state(partial.datasetId,partialOrigin.planId,'RECOVERY_REQUIRED',['RELEASE_UNKNOWN'],true);late.close();partial.allowPhysicalUnknown();const later=partial.journal();assert.ok(later.plans.get(partialOrigin.planId)!.events.some(event=>event.kind==='run-closed'&&event.stage==='execute'));await assert.rejects(partial.api.privateStopLibrary(partial.libraries[0]!.id),{code:'SHARED_RESOURCE_UNKNOWN'});assert.deepEqual(partial.journal(),later);

  const failed=await sourceWritesFixture470(t),failedOrigin=failed.preview([0]),failedReady=await failed.ready(failedOrigin.planId),failedStage=path.join(failed.directory,'source-writes','safety',failedReady.items[0]!.operationId,'stage'),heldWrite=await holdSourceHandle470(t,failedStage,'write',failed.libraries[0]!.file),executed=executeSource488(failed,failedReady),fd=await heldWrite.started,realClose=fd.close.bind(fd);let refused=false;
  const closeFault=t.mock.method(fd,'close',async()=>{if(!refused){refused=true;throw new Error('受控原publisher FD关闭失败488');}return realClose();});failed.allowPhysicalUnknown();
  try{
    const cancel=failed.api.cancel({datasetId:failed.datasetId,commandId:randomUUID(),planId:failedOrigin.planId,expectedViewRevision:failed.plan(failedOrigin.planId).viewRevision});assert.equal(cancel.outcome,'accepted');heldWrite.release();const deadline=Date.now()+15000;
    for(;;){if(failed.plan(failedOrigin.planId).state==='RECOVERY_REQUIRED')break;assert.ok(Date.now()<deadline,'原发布关闭失败未保留不确定结果');await new Promise<void>(resolve=>setTimeout(resolve,10));}
    heldWrite.restore();assert.ok(fd.fd>=0);assert.equal(failed.journal().plans.get(failedOrigin.planId)!.events.some(event=>event.kind==='run-closed'&&event.stage==='execute'),false);
    const unknown=failed.journal();await assert.rejects(failed.api.privateStopLibrary(failed.libraries[0]!.id),{code:'RELEASE_UNKNOWN'});await assert.rejects(failed.api.privateStopLibrary(failed.libraries[0]!.id),{code:'RELEASE_UNKNOWN'});assert.deepEqual(failed.journal(),unknown);assert.throws(()=>failed.api.preview(failedOrigin.request),{code:'INVENTORY_UNAVAILABLE'});
    const command=failed.api.get({datasetId:failed.datasetId,selector:{kind:'command',commandId:executed.confirm.commandId,expectedCommand:'localSourceWrites.confirm',requestFingerprint:executed.executed.requestFingerprint}});assert.ok(command.kind==='command');assert.deepEqual(command.receipt,executed.executed);assert.deepEqual(failed.journal(),unknown);assert.deepEqual(await readFile(failed.libraries[0]!.file),failed.libraries[0]!.bytes);
  }finally{heldWrite.restore();heldWrite.release();closeFault.mock.restore();await realClose();}
  assert.equal(fd.fd,-1);t.diagnostic('测试手动关闭自有FD只收环境，不回写证书、不释放UNKNOWN许可，也不授Main2000ms或整C03通过。');
});

// 原管理DAL建立同SQLrunning原件仅用于私有scope组件；不代替完整管理runtime/Main撤库资格。
import { localLibraryManagementDigest as removalDigest502, type LocalLibraryManagementOperationRecord as RemovalRecord502 } from '../../src/collection/local-library-workbench/owner-journal.js';
function removalOriginal502(f:Awaited<ReturnType<typeof sourceWritesFixture470>>,libraryIds:string[]){
  const commandId=randomUUID(),original={command:'library.remove' as const,request:{commandId,libraryIds}},originalSha256=removalDigest502(original);
  const operation:RemovalRecord502={schema:1,kind:'operation',datasetId:f.datasetId,key:commandId,revision:1,original,originalSha256,
    receipt:{commandId,kind:'library.remove',state:'running',libraryIds:[...libraryIds],message:null}};
  // running只登记原operation；管理绑定仅由succeeded原import/remove整批写入，不能提前伪造已完成binding。
  f.repository.localCatalog.privateLibraryManagementCompareAndSwap(f.identity,[{record:operation,expectedRevision:null}]);
  return{identity:f.identity,commandId,originalSha256};
}
test('按库源写502：同SQL原全选甲乙可cancel并join原混组，单甲缓存与伪原引用不能补签',{concurrency:false},async t=>{
  const f=await sourceWritesFixture470(t),held=await holdSourceHandle470(t,f.libraries[0]!.file,'read'),origin=f.preview([0,1]);
  try{const fd=await held.started;
  await assert.rejects(f.api.privateStopLibrary(f.libraries[0]!.id),{code:'SHARED_RESOURCE_UNKNOWN'});
  const subset=removalOriginal502(f,[f.libraries[0]!.id]);await assert.rejects(f.api.privateStopLibrary(f.libraries[0]!.id,subset),{code:'SHARED_RESOURCE_UNKNOWN'});
  const all=removalOriginal502(f,f.libraries.map(lib=>lib.id)),before=f.journal();
  for(const invalid of [{...all,originalSha256:'f'.repeat(64)},{...all,identity:{...f.identity}},{...all,commandId:randomUUID()}]){
    await assert.rejects(f.api.privateStopLibrary(f.libraries[0]!.id,invalid));assert.equal(f.plan(origin.planId).state,'PREVIEWING');assert.ok(fd.fd>=0);assert.deepEqual(f.journal(),before);
  }
  let closed=false;const originalStop=f.api.privateStopLibrary(f.libraries[0]!.id,all),stopped=originalStop.then(()=>{closed=true;});
  assert.equal(f.api.privateStopLibrary(f.libraries[0]!.id,all),originalStop);
  try{await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(closed,false);assert.ok(fd.fd>=0);}finally{held.release();}
  await stopped;assert.equal(fd.fd,-1);await assert.rejects(fd.stat(),{code:'EBADF'});assert.equal(f.plan(origin.planId).state,'CANCELLED');
  await f.api.privateStopLibrary(f.libraries[1]!.id,all);for(const lib of f.libraries)assert.deepEqual(await readFile(lib.file),lib.bytes);
  const after=f.journal();assert.deepEqual([...after.plans.keys()],[...before.plans.keys()]);assert.equal(after.events.filter(e=>e.kind==='receipt').length,before.events.filter(e=>e.kind==='receipt').length);
  await assert.rejects(f.api.privateStopLibrary(f.libraries[0]!.id,{...all,originalSha256:'f'.repeat(64)}));assert.equal(f.actor.active,true);
  t.diagnostic('实际同SQL原管理DAL、原SourceWrites整组与实际FileHandle；管理running仅测试建立、Main受控，不授完整C03/Main2000ms或Owner资格。');
  }finally{held.release();}
});


test('源写准备523：同身份冷装配取原Safety而commitBoot前普通写仍拒绝，closing与失权不补签',async t=>{
  const directory=await mkdtemp(path.join(process.env.TMPDIR!,'mb-owner-prepare523-'));
  const repository=createCollectionRepository({filePath:path.join(directory,'collection.sqlite')}),datasetId=randomUUID();
  let booted=false,alive=true;const assertRecoveryCurrent=()=>{assert.equal(alive,true);repository.readonlySnapshotStamp();};
  repository.localCatalog.privateBindWorkbenchDataset({datasetId,assertCurrent:assertRecoveryCurrent});
  const api=createLocalSourceWritesService({repository,datasetId,ownerEpoch:randomUUID(),assertRecoveryCurrent,assertCurrent(){assertRecoveryCurrent();if(!booted)throw Object.assign(new Error('源写 Owner 尚未 commitBoot。'),{code:'INVENTORY_UNAVAILABLE'});}});
  t.after(async()=>{try{await api.close();await api.closeSourceSafety();}finally{repository.close();alive=false;}});
  await api.prepareRecoveryProtection();const before=repository.readonlySnapshotStamp(),shared=api.privateLyricsSafety();
  assert.equal(api.privateLyricsSafety().sourceSafety,shared.sourceSafety);assert.deepEqual(repository.readonlySnapshotStamp(),before);
  const request={datasetId,commandId:randomUUID(),expectedPolicyRevision:sourceWritesDto470.LOCAL_SOURCE_WRITES_DEFAULT_POLICY.revision,enabled:true};
  assert.throws(()=>api.setPolicy(request),error=>error instanceof Error&&error.message==='源写 Owner 尚未 commitBoot。');
  assert.deepEqual(repository.readonlySnapshotStamp(),before);alive=false;assert.throws(()=>api.privateLyricsSafety());alive=true;
  booted=true;const receipt=api.setPolicy(request);assert.equal(receipt.outcome,'accepted');assert.equal(receipt.policy?.enabled,true);
  await api.close();assert.throws(()=>api.privateLyricsSafety());await api.closeSourceSafety();
  t.diagnostic('自有同SQL装配与普通写门禁；真正默认testMode:false工厂和Native正常链仍由对应实际例独立验证。');
});

test('歌词Writer541：同原command写入成功后等待派生finally退休再回读与发布',async t=>{
  const {createLocalWorkbenchLyricsWriter}=await import('../../src/collection/local-library-workbench/lyrics-writer.js');
  const physicalModule:typeof import('../../src/stream/physical-resource-claims.js')=await import('../../src/stream/physical-resource-claims.js');
  const {acquirePhysicalWriteClaims,registerPhysicalWriteClaimDescriptors,closePhysicalWriteClaimDescriptors}=physicalModule;
  const {captureSourceNamespace,acquireSourceNamespaceWrite,assertSourceNamespaceHeld,releaseSourceNamespaceWrite}=await import('../../src/stream/source-namespace-claims.js');
  type TagsReceipt=import('../../src/library/local-audio-tags-actor.js').LocalAudioTagsRunReceipt;
  type SourceAuthor=import('../../src/collection/local-library-workbench/lyrics-writer.js').LocalLyricsSourceFilesAuthor;
  type Publication=import('../../src/collection/local-library-workbench/lyrics-writer.js').LocalLyricsHeldPublication;
  type SaveRecord=import('../../src/collection/local-library-lyrics/types.js').LocalLyricsSaveRecord;
  // 仅组件时序模型：实际Writer和自有FD/claims/命名位；不调用或认证Native，不授Source发布资格。
  const temporary=process.env.TMPDIR;assert.ok(temporary&&path.isAbsolute(temporary));
  const directory=await mkdtemp(path.join(temporary,'lyrics-writer-join541-'));
  const repository=createCollectionRepository({filePath:path.join(directory,'catalog.sqlite')});repository.localCatalog.roots();
  const state=createBackupWorkflowStore({filePath:path.join(directory,'state.sqlite')});
  const identity=state.datasetIdentities.bind('default',path.join(directory,'catalog.sqlite'),false),catalog=repository.localCatalog;
  catalog.privateBindWorkbenchDataset(identity);
  const ports=channel(),mainActor=createSourceWritesMainActor(ports.port1);
  t.after(async()=>{try{await closePorts(ports.port1,ports.port2);}finally{repository.close();state.close();}});
  for(const matchingReadback of [true,false]){
    const source=path.join(directory,matchingReadback?'匹配回读':'正文漂移');await mkdir(source,{mode:0o700});
    const copyPath=path.join(source,'组件副本占位.txt');await writeFile(copyPath,'只验证Writer生命周期，不是Native音频。',{flag:'wx',mode:0o600});
    const copy=await open(copyPath,constants.O_RDWR|constants.O_NOFOLLOW),info=await copy.stat({bigint:true});
    const root={id:randomUUID(),...await authorizeSourceDirectory(source)},resource={dev:String(info.dev),ino:String(info.ino)};
    const physical=await acquirePhysicalWriteClaims([resource]);registerPhysicalWriteClaimDescriptors(physical,[copy]);
    const commandId=randomUUID(),operationId=randomUUID(),body='[00:00.00]原选定歌词\n';
    const selected:LocalLyricsSelectedBody={track:{trackId:randomUUID(),title:'原曲',artist:'原作者',album:'原专辑',language:'zh',version:'original',durationMs:500,
      wholeTrack:false,format:'flac',rootRevision:'1',fileRevision:'1',locationRevision:'1',metadataRevision:'a'.repeat(64),lrc:'true',embedded:'false'},
      candidateId:randomUUID(),source:'lrclib',body,sha256:digest(Buffer.from(body))};
    const draft={request:{sessionId:randomUUID(),commandId,embed:true},scope:{datasetId:identity.datasetId,libraryId:randomUUID(),albumId:'component-album-541',captureId:randomUUID()},captureFingerprint:'b'.repeat(64),selected:[selected]};
    const intent:LocalLyricsSaveIntent={...draft,fingerprint:localLyricsIntentFingerprint(draft)},record:SaveRecord={intent,revision:0,physicalClosed:false,discarded:false,
      receipt:{commandId,sessionId:intent.request.sessionId,state:'running',cover:'not-requested',tracks:[{trackId:selected.track.trackId,lrc:'saved',embed:'pending'}],snapshot:'not-requested'}};
    const beforeRecord=structuredClone(record),originBinding={datasetId:identity.datasetId,originPlanId:commandId,planHash:intent.fingerprint,contextFingerprint:intent.captureFingerprint,journalSequence:'1',projectionFingerprint:selected.sha256};
    const operations=[{operationId,name:await captureSourceNamespace(root,'组件副本占位.txt')}],token=await acquireSourceNamespaceWrite({...originBinding,operations});
    const scope={datasetId:identity.datasetId,planId:commandId,originBinding,operations},events:string[]=[],runIds:string[]=[],joinIds:string[]=[];
    const signal=new AbortController().signal,pendingRuns=new Map<string,{promise:Promise<TagsReceipt>;kind:'write'|'read'}>();
    let tagClosing=false,sourceClosed=false,publicationCount=0,catalogReads=0,claimChecks=0,grantChecks=0;
    const duplicate=new Error('原标签命令仍在处理，不能重复启动。');
    const catalogObserver=t.mock.method(catalog,'privateLyricsRecord',(datasetId:string,kind:string,key:string)=>{
      assert.equal(datasetId,identity.datasetId);assert.equal(kind,'save');assert.equal(key,commandId);catalogReads++;return structuredClone(record);
    });
    const publication:Publication={grant:Object.freeze({fixture:'Writer组件许可端口'}),physical,namespace:{token,scope,recovery:false},
      copy:{fd:copy.fd,commandId,claimId:randomUUID(),async assertCurrent(){claimChecks++;identity.assertCurrent();const actual=await copy.stat({bigint:true});assert.equal(actual.dev,info.dev);assert.equal(actual.ino,info.ino);}}};
    // 与原Actor一致：返回原pending；running.delete只挂在派生catch().finally()，不用定时或额外延迟制造竞态。
    const tags:ReturnType<typeof createLocalAudioTagsActor>={
      run(claim,format,values,receivedSignal){
        assert.equal(tagClosing,false);assert.equal(format,'flac');assert.equal(receivedSignal,signal);assert.equal(claim.commandId,commandId);
        if(pendingRuns.has(claim.commandId))throw duplicate;
        const kind=values===null?'read':'write';runIds.push(claim.commandId);events.push(kind+'-start');
        const pending=(async():Promise<TagsReceipt>=>{await claim.assertCurrent();assert.equal(signal.aborted,false);
          if(values!==null)assert.deepEqual(values,{LYRICS:body});events.push(kind+'-settled');
          return {values:{LYRICS:kind==='read'&&!matchingReadback?'[00:00.00]另一个正文\n':body},stdout:new Uint8Array(),stderr:new Uint8Array(),exitCode:0,signal:null,pid:1,pidClosed:true,actorFdsClosed:true};})();
        pendingRuns.set(claim.commandId,{promise:pending,kind});
        void pending.catch(()=>{}).finally(()=>{if(pendingRuns.get(claim.commandId)?.promise===pending){pendingRuns.delete(claim.commandId);events.push(kind+'-retired');}}).catch(()=>{});
        return pending;
      },
      async join(id){assert.equal(id,commandId);joinIds.push(id);const pending=pendingRuns.get(id);events.push('join-'+(pending?.kind??'quiet'));
        if(pending)await pending.promise.catch(()=>{});assert.equal(pendingRuns.size,0);},
      async close(){tagClosing=true;await Promise.allSettled([...pendingRuns.values()].map(row=>row.promise));},
      inspect(){return {closing:tagClosing,running:pendingRuns.size,unverified:0,pids:[]};},
    };
    const sourceFiles:SourceAuthor={
      async prepare(actualBinding,actualIntent,actualSelected,actor,receivedSignal){assert.equal(actualBinding.commandId,commandId);assert.equal(actualIntent,intent);assert.equal(actualSelected,selected);assert.equal(actor,mainActor);assert.equal(receivedSignal,signal);return publication;},
      async assertGranted(held,actualBinding,actualIntent){assert.equal(held,publication);assert.equal(actualBinding.commandId,commandId);assert.equal(actualIntent,intent);
        grantChecks++;identity.assertCurrent();physicalModule.assertPhysicalWriteClaims(physical,[resource]);assertSourceNamespaceHeld(token,scope);},
      async publishTaggedCopy(held,sha,receivedSignal){assert.equal(held,publication);assert.equal(sha,selected.sha256);assert.equal(receivedSignal,signal);
        assert.equal(pendingRuns.size,0);publicationCount++;events.push('publish');return {state:'saved',bodySha256:sha};},
      async publishLrcExclusive(){assert.fail('原embed时序不得新写LRC。');},async readOriginal(){return null;},
      async prepareFailedRetry(){assert.fail('原成功写入不得换成恢复请求。');},async join(id){assert.equal(id,commandId);},
      async close(){if(sourceClosed)return;await closePhysicalWriteClaimDescriptors(physical);await physical.release();await releaseSourceNamespaceWrite(token,[operationId]);sourceClosed=true;},
    };
    const writer=createLocalWorkbenchLyricsWriter({identity,ownerEpoch:randomUUID(),catalog,mainActor,tags,sourceFiles,assertAccepting(){identity.assertCurrent();}});
    t.after(()=>writer.close());
    try{
      const work=writer.write('embed',intent,selected,signal);
      if(matchingReadback)assert.deepEqual(await work,{state:'saved',bodySha256:selected.sha256});else await assert.rejects(work,{code:'CONFLICT'});
      assert.deepEqual(runIds,[commandId,commandId]);assert.ok(joinIds.every(id=>id===commandId));
      assert.ok(events.indexOf('write-settled')<events.indexOf('join-write'));assert.ok(events.indexOf('join-write')<events.indexOf('write-retired'));
      assert.ok(events.indexOf('write-retired')<events.indexOf('read-start'));assert.ok(events.indexOf('read-start')<events.indexOf('read-settled'));
      assert.equal(publicationCount,matchingReadback?1:0);if(matchingReadback)assert.ok(events.indexOf('read-settled')<events.indexOf('publish'));
      assert.ok(claimChecks>=2&&grantChecks>=3);assert.equal(catalogReads,1);assert.deepEqual(record,beforeRecord);
      assert.equal(tags.inspect().running,0);assert.equal(tags.inspect().unverified,0);
    }finally{await writer.close();catalogObserver.mock.restore();}
    assert.equal(copy.fd,-1);await assert.rejects(copy.stat(),error=>(error as NodeJS.ErrnoException).code==='EBADF');
    assert.equal(physical.state,'released');assert.equal(token.state,'released');
  }
  t.diagnostic('真实Writer调用与原Actor微任务生命周期模型；Native复制件同UUID复现及完整Owner保存链由Root独立执行。');
});
