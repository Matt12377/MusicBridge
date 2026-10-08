import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {constants} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import {chmod,copyFile,lstat,mkdir,mkdtemp,open,readFile,writeFile} from 'node:fs/promises';
import {MessageChannel} from 'node:worker_threads';
import path from 'node:path';
import type {TestContext} from 'node:test';
import * as dto from '@music-bridge/contracts';
import {buildStoragePolicy} from '../../../../apps/desktop/scripts/build-storage-root.mjs';
import {loadFreshMetadataReader} from '../helpers/mbrs003-audio-fixtures.js';
import {createCollectionRepository,type CollectionRepository} from '../../src/collection/repository.js';
import {createLocalScanCoordinator} from '../../src/collection/local-scan-coordinator.js';
import {createScanReadAdmission} from '../../src/library/scan-read-admission.js';
import {authorizeSourceDirectory} from '../../src/recording/source-files.js';
import {createSourceWritesMainActor} from '../../src/collection/source-writes-authority.js';
import {createTestLocalSourceWritesService,type LocalSourceWritesService} from '../../src/collection/local-source-writes-service.js';
import type {DatasetProjectionCommand,DatasetProjectionCommandPayloads,DatasetProjectionCommandResults,DatasetProjectionPort} from '../../src/collection/dataset-owner-protocol.js';
import type {SourcePublisherJournalFact} from '../../src/collection/source-writes-publisher.js';

export const writerFixtures=new URL('../fixtures/mbrs012-source/',import.meta.url);
export const ownedManifestHash='5a3621481eb22801c020589b393c3a1ffa32e3d132766ea6e8db6e33fa47714b';
export const hash=(bytes:Uint8Array):string=>createHash('sha256').update(bytes).digest('hex');
interface OwnedFile {file:string;bytes:number;sha256:string;mime?:'image/png'|'image/jpeg';width?:number;height?:number;audioStart?:number;audioPayloadSha256?:string}
type IndependentAttributeOwner={mode:string;uid:string;gid:string};
export type IndependentSourceAttributes=IndependentAttributeOwner&(
  {proof:'MACOS_EMPTY_XATTR_ACL_FLAGS_V1'|'LINUX_EMPTY_XATTR_ACL_FLAGS_V1'}
  |{proof:'MACOS_PROVENANCE_ONLY_ACL_FLAGS_V1';provenance:{bytes:11;sha256:string}}
);
export interface PreWriteSource {file:string|null;target:string;originalStat:{dev:string;ino:string;mode:string;uid:string;gid:string}|null;originalAttributes:IndependentSourceAttributes|null;sha256:string|null;bytes:number|null}
const runIndependent=promisify(execFile),attributeOptions={timeout:3000,maxBuffer:16384,encoding:'utf8' as const,env:{LANG:'C',LC_ALL:'C'}};
const statFence=(info:BigIntStats):string=>[info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs,info.birthtimeNs,info.mode,info.uid,info.gid,info.nlink].join(':');
/** 仅用于独立写前见证；不用产品属性观察函数，不操作或清除任何实际属性。 */
async function independentSourceAttributes(target:string,original:BigIntStats):Promise<IndependentSourceAttributes>{
  const owner={mode:String(original.mode&0o7777n),uid:String(original.uid),gid:String(original.gid)};
  if(process.platform==='darwin'){
    const listed=await runIndependent('/usr/bin/xattr',[target],attributeOptions);assert.equal(listed.stderr,'');
    assert.ok(listed.stdout===''||listed.stdout==='com.apple.provenance\n','写前原源包含首版无法证明保全的实际xattr。');
    let profile:{proof:'MACOS_EMPTY_XATTR_ACL_FLAGS_V1'}|{proof:'MACOS_PROVENANCE_ONLY_ACL_FLAGS_V1';provenance:{bytes:11;sha256:string}};
    if(listed.stdout==='')profile={proof:'MACOS_EMPTY_XATTR_ACL_FLAGS_V1'};
    else{
      const result=await runIndependent('/usr/bin/xattr',['-px','com.apple.provenance',target],attributeOptions);assert.equal(result.stderr,'');assert.match(result.stdout,/^[\da-fA-F\s]+$/u);
      const hex=result.stdout.replace(/\s/gu,'');assert.match(hex,/^[\da-fA-F]{22}$/u);const value=Buffer.from(hex,'hex');assert.equal(value.length,11);profile={proof:'MACOS_PROVENANCE_ONLY_ACL_FLAGS_V1',provenance:{bytes:11,sha256:hash(value)}};
    }
    const acl=await runIndependent('/bin/ls',['-lde',target],attributeOptions),flags=await runIndependent('/usr/bin/stat',['-f','%f',target],attributeOptions);assert.equal(acl.stderr,'');assert.equal(flags.stderr,'');assert.equal(flags.stdout,'0\n');assert.equal(acl.stdout.trimEnd().split('\n').length,1);
    const mode=acl.stdout.split(/\s/u)[0];assert.ok(mode);assert.match(mode,profile.proof==='MACOS_PROVENANCE_ONLY_ACL_FLAGS_V1'?/^-[rwxstST-]{9}@$/u:/^-[rwxstST-]{9}$/u);
    return {...owner,...profile};
  }
  assert.equal(process.platform,'linux');
  const script="import os,sys,json,fcntl,array\np,dev,ino=sys.argv[1:]\nf=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)\ntry:\n a=os.fstat(f); flags=array.array('L',[0]); fcntl.ioctl(f,0x80086601,flags,True); names=os.listxattr(f); b=os.fstat(f); named=os.stat(p,follow_symlinks=False)\n def identity(v): return (v.st_dev,v.st_ino,v.st_size,v.st_mtime_ns,v.st_ctime_ns,v.st_mode,v.st_uid,v.st_gid,v.st_nlink)\n assert str(a.st_dev)==dev and str(a.st_ino)==ino and identity(a)==identity(b)==identity(named)\n print(json.dumps({'dev':str(a.st_dev),'ino':str(a.st_ino),'mode':str(a.st_mode & 4095),'uid':str(a.st_uid),'gid':str(a.st_gid),'names':names,'flags':int(flags[0])}))\nfinally: os.close(f)";
  const actual=await runIndependent('/usr/bin/python3',['-I','-S','-c',script,target,String(original.dev),String(original.ino)],attributeOptions);assert.equal(actual.stderr,'');const value:unknown=JSON.parse(actual.stdout);
  assert.ok(value!==null&&typeof value==='object'&&'dev'in value&&'ino'in value&&'mode'in value&&'uid'in value&&'gid'in value&&'names'in value&&'flags'in value);
  assert.equal(value.dev,String(original.dev));assert.equal(value.ino,String(original.ino));assert.equal(value.mode,owner.mode);assert.equal(value.uid,owner.uid);assert.equal(value.gid,owner.gid);assert.deepEqual(value.names,[]);assert.ok(typeof value.flags==='number'&&Number.isSafeInteger(value.flags)&&value.flags>=0);assert.equal(BigInt(value.flags)&~0x80000n,0n);
  return {...owner,proof:'LINUX_EMPTY_XATTR_ACL_FLAGS_V1'};
}
export async function owned(file:string):Promise<{bytes:Buffer;entry:OwnedFile}>{
  const bytes=await readFile(new URL('manifest.json',writerFixtures));assert.equal(hash(bytes),ownedManifestHash);
  const manifest=JSON.parse(bytes.toString('utf8')) as {synthetic:boolean;allContentOwned:boolean;realLibraryUsed:boolean;files:OwnedFile[]};
  assert.equal(manifest.synthetic,true);assert.equal(manifest.allContentOwned,true);assert.equal(manifest.realLibraryUsed,false);
  const entry=manifest.files.find(v=>v.file===file);assert.ok(entry);const content=await readFile(new URL(file,writerFixtures));assert.equal(content.length,entry.bytes);assert.equal(hash(content),entry.sha256);return {bytes:content,entry};
}
export async function retainedDirectory(prefix:string):Promise<string>{
  const base=buildStoragePolicy().check(process.env.MBRS012_SOURCE_EVIDENCE_ROOT??process.env.TMPDIR!,{mustExist:true}),info=await lstat(base);assert.ok(info.isDirectory()&&!info.isSymbolicLink());
  const directory=await mkdtemp(path.join(base,prefix));await chmod(directory,0o700);const actual=await lstat(directory);assert.equal(actual.mode&0o777,0o700);return directory;
}
export interface ServiceFixtureOptions {files?:readonly string[];aliases?:readonly {ownedFile:string;relative:string}[];phase?(fact:SourcePublisherJournalFact):void;beforeCommit?(action:string):void;now?:()=>number}
/** 所有音频来自冻结owned样本；真实Reader/扫描本体生成accepted Scan/Asset，发布属性不注入Fake。 */
export async function sourceServiceFixture(t:TestContext,options:ServiceFixtureOptions={}){
  const directory=await retainedDirectory('mbrs012-service-'),media=path.join(directory,'owned-media');await mkdir(media,{mode:0o700});
  const names=options.files??['owned-stereo-fixed-tags.flac','owned-stereo-id3v240.mp3'];
  for(const name of names){const input=await owned(name);await writeFile(path.join(media,name),input.bytes,{flag:'wx',mode:0o600});}
  for(const alias of options.aliases??[]){assert.equal(path.basename(alias.relative),alias.relative);const input=await owned(alias.ownedFile);await writeFile(path.join(media,alias.relative),input.bytes,{flag:'wx',mode:0o600});}
  const filePath=path.join(directory,'collection.sqlite'),repository=createCollectionRepository({filePath,...(options.beforeCommit?{beforeCommit:options.beforeCommit}:{})}),datasetId=randomUUID(),epoch=randomUUID();
  const source=repository.sources.authorize(randomUUID(),await authorizeSourceDirectory(media)),root=repository.localCatalog.registerRoot({commandId:randomUUID(),sourceRootId:source.id,role:'library'});
  const admission=createScanReadAdmission({isBusy:()=>false}),context={datasetId,epoch};
  const projection:DatasetProjectionPort={async call<K extends DatasetProjectionCommand>(command:K,payload:DatasetProjectionCommandPayloads[K]):Promise<DatasetProjectionCommandResults[K]>{
    let result:unknown;if(command==='scanReadAcquire')result=admission.acquire(context);else if(command==='scanReadWatchRevocation')result=await admission.watchRevocation(context,(payload as {permitId:string}).permitId);else if(command==='scanReadRelease')result=admission.release(context,(payload as {permitId:string}).permitId);else throw new Error('Source正例夹具仅消费生产扫描准入，不能伪造媒体投影。');return result as DatasetProjectionCommandResults[K];
  }};
  const readerModule=await loadFreshMetadataReader(),readerLocks:typeof import('../../src/stream/physical-resource-locks.js')=await import(new URL('../../dist/stream/physical-resource-locks.js',import.meta.url).href),sourceLocks=await import('../../src/stream/physical-resource-locks.js');
  // 新鲜编译Reader与源码测试服务共用真实SAB，不能用另一张内存表冒充跨读取保护。
  readerLocks.installPhysicalResourceCoordinator(sourceLocks.physicalResourceLocks.buffer);
  const reader=readerModule.createMetadataReader(),scanner=createLocalScanCoordinator({repository,datasetId,assertCurrent(){repository.list({offset:0,limit:1});},projection,reader});
  const initial=scanner.start({commandId:randomUUID(),libraryRootId:root.id,expectedRootRevision:root.revision});await scanner.privateWait(initial.jobId);assert.equal(scanner.get(initial.jobId).phase,'completed');
  const tracks=repository.localCatalog.pageTracks({offset:0,limit:200}).items;assert.equal(tracks.length,names.length+(options.aliases?.length??0));
  // 写前独立副本在任何publisher/grant调用之前取得，不从写后backup反推“before”。
  const preWriteSources=new Map<string,PreWriteSource>(),beforeOperations=new Map<string,PreWriteSource>();
  async function retainBefore(relative:string,label:string):Promise<PreWriteSource>{
    const target=path.join(media,relative);let original:BigIntStats;
    try{original=await lstat(target,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {file:null,target,originalStat:null,originalAttributes:null,sha256:null,bytes:null};throw error;}
    assert.ok(original.isFile()&&!original.isSymbolicLink());const source=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      assert.equal(statFence(await source.stat({bigint:true})),statFence(original));const originalAttributes=await independentSourceAttributes(target,original);
      assert.equal(statFence(await source.stat({bigint:true})),statFence(original));assert.equal(statFence(await lstat(target,{bigint:true})),statFence(original));
      const sourceBytes=await source.readFile(),file=path.join(directory,`${label}-${path.basename(relative)}`);await copyFile(target,file);const current=await lstat(target,{bigint:true}),copy=await lstat(file,{bigint:true}),content=await readFile(file);
      assert.equal(statFence(current),statFence(original));assert.equal(statFence(await source.stat({bigint:true})),statFence(original));assert.deepEqual(content,sourceBytes);assert.notEqual(`${copy.dev}:${copy.ino}`,`${original.dev}:${original.ino}`);assert.equal(copy.nlink,1n);
      return {file,target,originalStat:{dev:String(original.dev),ino:String(original.ino),mode:String(original.mode&0o7777n),uid:String(original.uid),gid:String(original.gid)},originalAttributes,sha256:hash(content),bytes:content.length};
    }finally{await source.close();}
  }
  for(const track of tracks)preWriteSources.set(track.id,await retainBefore(repository.localCatalog.privateAssetLocator(track.assetId).relative,`pre-write-source-${preWriteSources.size}`));
  const preWriteManifest=path.join(directory,'pre-write-source-manifest.json');await writeFile(preWriteManifest,JSON.stringify({owned:true,sourceRoot:media,files:[...preWriteSources.values()]},null,2)+'\n',{flag:'wx',mode:0o600});t.diagnostic(`Source真实写前材料：${preWriteManifest}`);
  const channel=new MessageChannel(),actor=createSourceWritesMainActor(channel.port1),facts:SourcePublisherJournalFact[]=[];
  let api:LocalSourceWritesService=createTestLocalSourceWritesService({repository,datasetId,ownerEpoch:epoch,assertCurrent(){repository.localCatalog.root(root.id);},beforeMedia:()=>scanner.yieldForMedia(),...(options.now?{now:options.now}:{})},{phase(fact){facts.push({...fact});options.phase?.(fact);}});
  let finished=false;async function close():Promise<void>{if(finished)return;finished=true;try{await api.close();}finally{await scanner.close();admission.close();channel.port1.close();channel.port2.close();repository.close();}}
  t.after(async()=>{await close();t.diagnostic(`Source真实材料保留：${directory}`);});
  const target=(index=0):dto.LocalSourceWritesTarget=>({mode:'single',trackId:tracks[index]!.id});
  const plan=(id:string):dto.LocalSourceWritesPlan=>{const result=api.get({datasetId,selector:{kind:'plan',planId:id}});assert.equal(result.kind,'plan');assert.ok(result.kind==='plan'&&result.plan);assert.ok(dto.isLocalSourceWritesPlan(result.plan));return result.plan;};
  async function waitPlan(id:string,predicate:(p:dto.LocalSourceWritesPlan)=>boolean,timeout=30000):Promise<dto.LocalSourceWritesPlan>{const deadline=Date.now()+timeout;for(;;){const current=plan(id);if(predicate(current))return current;if(Date.now()>=deadline)assert.fail(`等待Source真实状态超界：${current.state}/${current.issues.join(',')}`);await new Promise<void>(resolve=>setTimeout(resolve,10));}}
  async function captureBefore(p:dto.LocalSourceWritesPlan):Promise<void>{for(const item of p.items){if(beforeOperations.has(item.operationId))continue;const track=tracks.find(v=>v.id===item.trackId);assert.ok(track);const originalItem=item.restoration?plan(item.restoration.originPlanId).items.find(v=>v.operationId===item.restoration!.originOperationId):item;
      const source=p.range==='DIRECTORY_COVER'?path.posix.join(path.posix.dirname(repository.localCatalog.privateAssetLocator(track.assetId).relative),originalItem?.artwork?.mime==='image/jpeg'?'cover.jpg':'cover.png'):repository.localCatalog.privateAssetLocator(track.assetId).relative;beforeOperations.set(item.operationId,await retainBefore(source,`pre-operation-${item.operationId}`));}}
  async function ready(intent:dto.LocalSourceWritesIntent):Promise<dto.LocalSourceWritesPlan>{const accepted=api.preview({datasetId,commandId:randomUUID(),intent});assert.equal(accepted.outcome,'accepted');assert.ok(accepted.planId);const p=await waitPlan(accepted.planId,v=>v.state!=='PREVIEWING');assert.equal(p.state,'READY',p.issues.join(','));assert.equal(Date.parse(p.expiresAt!)-Date.parse(p.readyAt!),600000);await captureBefore(p);return p;}
  const policy=():dto.LocalSourceWritesPolicy=>{const context=api.get({datasetId,selector:{kind:'context',target:null}});assert.ok(context.kind==='context');return context.context.policy;};
  function enable(enabled=true):dto.LocalSourceWritesReceipt {const result=api.setPolicy({datasetId,commandId:randomUUID(),expectedPolicyRevision:policy().revision,enabled});assert.equal(result.outcome,'accepted');return result;}
  function confirmation(p:dto.LocalSourceWritesPlan):dto.ConfirmLocalSourceWrites {assert.ok(p.planHash&&p.contextFingerprint);return {datasetId,commandId:randomUUID(),planId:p.planId,expectedViewRevision:p.viewRevision,scope:'SOURCE_FILES',range:p.range,planHash:p.planHash,contextFingerprint:p.contextFingerprint};}
  function grant(p:dto.LocalSourceWritesPlan,request=confirmation(p)){const challenge=api.challenge({datasetId,confirm:request},actor);return {request,challenge};}
  function execute(p:dto.LocalSourceWritesPlan){const permitted=grant(p),accepted=api.executeGranted({datasetId,confirm:permitted.request,grant:permitted.challenge.grant},actor);assert.equal(accepted.outcome,'accepted');return {accepted,...permitted};}
  async function complete(p:dto.LocalSourceWritesPlan):Promise<dto.LocalSourceWritesPlan>{await captureBefore(p);execute(p);const result=await waitPlan(p.planId,v=>['COMPLETED','PARTIAL','FAILED','CANCELLED','RECOVERY_REQUIRED'].includes(v.state));assert.equal(result.state,'COMPLETED',result.issues.join(','));return result;}
  async function undo(p:dto.LocalSourceWritesPlan):Promise<dto.LocalSourceWritesPlan>{const accepted=api.undo({datasetId,commandId:randomUUID(),planId:p.planId,expectedViewRevision:p.viewRevision,operationIds:p.items.filter(i=>i.state==='applied').map(i=>i.operationId),journalFingerprint:p.journalFingerprint});assert.equal(accepted.outcome,'accepted');assert.ok(accepted.planId);const inverse=await waitPlan(accepted.planId,v=>v.state!=='PREVIEWING');assert.equal(inverse.state,'READY',inverse.issues.join(','));return complete(inverse);}
  const relatives=new Map(tracks.map(track=>[track.id,repository.localCatalog.privateAssetLocator(track.assetId).relative]));
  const relative=(track:dto.LocalTrack):string=>{const name=relatives.get(track.id);assert.ok(name);return name;};
  async function retain(label:string,index=0):Promise<string>{const output=path.join(directory,`${label}-${path.basename(relative(tracks[index]!))}`);await copyFile(path.join(media,relative(tracks[index]!)),output);return output;}
  return {directory,media,filePath,repository,datasetId,epoch,source,root,tracks,actor,facts,scanner,projection,admission,preWriteSources,beforeOperations,preWriteManifest,captureBefore,target,plan,waitPlan,ready,policy,enable,confirmation,grant,execute,complete,undo,relative,retain,close,get api(){return api;},replaceApi(next:LocalSourceWritesService){api=next;}};
}
export type SourceServiceFixture=Awaited<ReturnType<typeof sourceServiceFixture>>;
export function coldRepository(filePath:string):CollectionRepository{return createCollectionRepository({filePath});}
