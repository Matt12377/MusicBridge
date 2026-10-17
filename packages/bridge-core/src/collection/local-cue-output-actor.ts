import { constants } from 'node:fs';
import { mkdir, open, lstat, realpath, link, unlink, type FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import * as dto from '@music-bridge/contracts';
import type { DatasetIdentity } from '../recording/dataset-identity.js';
import { sourceRootAvailability, withReadonlySourcePublicationClaims, SourcePublicationUnverified, type RootCapability } from '../recording/source-files.js';
import { acquireSourceNamespaceWrite, captureSourceNamespace, releaseSourceNamespaceWrite, assertSourceNamespaceHeld, retainSourceNamespaceWrite, delegateSourceNamespaceRecovery, resolveSourceNamespaceRecovery, resolveSourceNamespaceOrigin, sourceNamespaceRecoveryBindings, type SourceNamespaceWriteToken, type SourceNamespaceRecoveryToken, type SourceNamespaceHeldScope } from '../stream/source-namespace-claims.js';
import type { CueNativeActor, CueInputDemuxer, CueFormatId, CuePcmProfile } from '../library/bundled-cue-converter.js';
import type { createLocalAudioTagsActor, LocalAudioTagValues } from '../library/local-audio-tags-actor.js';
import { readCueQualifiedFormats, type qualifyCueEightFormats } from '../library/local-cue-format-qualification.js';
import type { LocalWorkbenchPlanCapture, LocalCueOutputBinding } from './local-library-workbench/types.js';
import { isLocalWorkbenchPlanCapture, assertLocalWorkbenchCapturedPlan } from './local-library-workbench/plan-registry.js';
import { cueOutputCanonical, isCueOutputName, type LocalCueOutputRecord, type LocalCueOutputStore, type LocalCueStagedOutput } from './local-cue-output-protocol.js';

export interface LocalCueAuthorizedSource {
  root: RootCapability; relative: string; signature: string; sha256: string; channels: 1 | 2; demuxer: CueInputDemuxer;
}
export interface LocalCueOutputActorOptions {
  identity: DatasetIdentity; store: LocalCueOutputStore; native: CueNativeActor; tags: ReturnType<typeof createLocalAudioTagsActor>;
  qualification: Awaited<ReturnType<typeof qualifyCueEightFormats>>;
  /** 真实唯一Owner核已经持久的原plan/原request；不能仅验公开DTO。 */
  assertOriginal(request: dto.LocalWorkbenchApplyRequest, plan: dto.LocalWorkbenchPlan, capture: LocalWorkbenchPlanCapture): void;
  revalidate(capture: LocalWorkbenchPlanCapture): Promise<void>;
  source(capture: LocalWorkbenchPlanCapture, binding: LocalCueOutputBinding): LocalCueAuthorizedSource;
  target(capture: LocalWorkbenchPlanCapture): Promise<RootCapability>;
  /** 私有原目标作者与Owner目录FD检查；公开RootCapability不构成当前目标许可。 */
  assertTargetCurrent?(capture: LocalWorkbenchPlanCapture, outputRoot: RootCapability): Promise<void> | void;
  assertAccepting(): void;
  /** 唯一Owner的私有诊断；异常原件不会进入公开回执。 */
  onFailure?(commandId: string, error: unknown): void;
}
const failed = (): never => { throw new Error('CUE原命令、来源或独立输出许可已改变。'); };
const equal = (a:unknown,b:unknown):boolean => cueOutputCanonical(a) === cueOutputCanonical(b);
const resource = (value:import('node:fs').BigIntStats):string => String(value.dev)+':'+String(value.ino);
function outputProfile(format:CueFormatId,probe:{sampleFormat:string;bitsPerSample:number}):CuePcmProfile{
  const floating=probe.sampleFormat.startsWith('flt')||probe.sampleFormat.startsWith('dbl');
  if(format==='pcm-wav'||format==='pcm-aiff'){
    if(floating){if(probe.bitsPerSample!==32)return failed();return 'f32';}
    if(probe.bitsPerSample<=16)return 's16';if(probe.bitsPerSample<=24)return 's24';if(probe.bitsPerSample===32)return 's32';return failed();
  }
  // 当前三种整型无损后端的资格是24bit；超出资格整计划拒绝，不静默降低精度。
  if(['flac','alac','wavpack'].includes(format)&&(floating||probe.bitsPerSample>24))return failed();
  return 's24';
}
async function digest(handle:FileHandle, maximum = 256*1024*1024, signal?:AbortSignal):Promise<{sha256:string;bytes:number;dev:string;ino:string}> {
  const before=await handle.stat({bigint:true});if(!before.isFile()||before.size<1n||before.size>BigInt(maximum))return failed();
  const state=createHash('sha256'),buffer=Buffer.alloc(64*1024);let position=0;
  while(position<Number(before.size)){signal?.throwIfAborted();const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,Number(before.size)-position),position);if(!bytesRead)return failed();state.update(buffer.subarray(0,bytesRead));position+=bytesRead;}
  const after=await handle.stat({bigint:true});if(resource(before)!==resource(after)||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)return failed();
  return {sha256:state.digest('hex'),bytes:position,dev:String(before.dev),ino:String(before.ino)};
}
function result(request:dto.LocalWorkbenchApplyRequest,plan:dto.LocalWorkbenchPlan,state:dto.LocalWorkbenchReceipt['state'],published:ReadonlySet<string>=new Set()):dto.LocalWorkbenchReceipt {
  const itemState = state==='succeeded'?'applied':state==='cancelled'?'cancelled':state==='failed'?'not-written':'unknown';
  return {commandId:request.commandId,datasetId:request.datasetId,planId:request.planId,planHash:request.planHash,state,
    items:plan.items.map(item=>({itemId:item.itemId,albumId:item.albumId,label:item.label,state:['cancelled','failed'].includes(state)&&published.has(item.itemId)?'applied':itemState,message:null})),
    message:state==='failed'?(published.size?'已验证的独立输出保留，其余分轨未完成。':'独立输出未完成，原音乐保留。'):state==='unknown'?'原输出结果仍待核对，请读取原回执。':state==='cancelled'&&published.size?'已验证的独立输出保留，其余分轨已取消。':null};
}
/** 原输出已完整时，只移除日志认证的保护目录内硬链接；外部硬链接使恢复继续待核。 */
async function removeOwnedStageAliases(record:LocalCueOutputRecord,verify:()=>Promise<void>):Promise<void>{
  if(!record.outputRoot||record.stageDirectory!=='.musicbridge-cue-'+record.request.commandId)return failed();
  const stageRoot=path.join(record.outputRoot.path,record.stageDirectory);
  let directory:FileHandle|undefined,identity:import('node:fs').BigIntStats|undefined;
  try{
    try{directory=await open(stageRoot,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);identity=await directory.stat({bigint:true});}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(identity&&(!identity.isDirectory()||identity.uid!==BigInt(process.getuid!())||(identity.mode&0o077n)!==0n))return failed();
    for(const item of record.staged){
      await verify();
      if(identity){const named=await lstat(stageRoot,{bigint:true});if(named.isSymbolicLink()||resource(named)!==resource(identity)||named.birthtimeNs!==identity.birthtimeNs)return failed();}
      const destination=path.join(record.outputRoot.path,item.outputName),published=await lstat(destination,{bigint:true});
      if(!published.isFile()||published.isSymbolicLink()||resource(published)!==item.dev+':'+item.ino)return failed();
      const file=await open(destination,constants.O_RDONLY|constants.O_NOFOLLOW);
      try{
        const actual=await digest(file);if(actual.sha256!==item.sha256||actual.bytes!==item.bytes)return failed();
        let alias:import('node:fs').BigIntStats|undefined;
        try{alias=await lstat(path.join(stageRoot,item.stageName),{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        if(alias){
          if(!identity||!alias.isFile()||alias.isSymbolicLink()||resource(alias)!==resource(published)||alias.nlink!==2n||published.nlink!==2n)return failed();
          await verify();await unlink(path.join(stageRoot,item.stageName));
        }else if(published.nlink!==1n)return failed();
        const after=await file.stat({bigint:true}),named=await lstat(destination,{bigint:true});
        if(after.nlink!==1n||resource(after)!==resource(published)||resource(named)!==resource(after))return failed();
      }finally{await file.close();}
    }
    await verify();await directory?.sync();await verify();
  }finally{await directory?.close();}
}
/** 先真实完成全部编码/标签/EOF，再独占link；原id只读，不自动重放UNKNOWN。 */
export function createLocalCueOutputActor(options:LocalCueOutputActorOptions){
  const formats=readCueQualifiedFormats(options.qualification);
  type TargetBinding={request:dto.LocalWorkbenchApplyRequest;choiceId:string};
  const running=new Map<string,{controller:AbortController;done:Promise<void>}>();
  const recovering=new Map<string,{controller:AbortController;done:Promise<dto.LocalWorkbenchReceipt>}>();
  const targetBindings=new Map<string,TargetBinding>();
  const revokedTargets=new Set<string>();
  const failures=new Map<string,unknown>();let closing=false;
  async function joinNative(commandId:string):Promise<void>{
    const joined=await Promise.allSettled([options.native.join(commandId),options.tags.join(commandId)]);
    const rejected=joined.find((value):value is PromiseRejectedResult=>value.status==='rejected');if(rejected)throw rejected.reason;
  }
  const retained=new Map<string,{opened:Set<FileHandle>;namespace:SourceNamespaceWriteToken|undefined;recovery?:SourceNamespaceRecoveryToken;scope:SourceNamespaceHeldScope|undefined;sourceFailure:SourcePublicationUnverified|null}>();
  function targetChoice(capture:LocalWorkbenchPlanCapture):string{
    const choiceId=capture.target?.choiceId;if(!dto.isLocalWorkbenchIdentity(choiceId)||revokedTargets.has(choiceId))return failed();return choiceId;
  }
  function bindTarget(request:dto.LocalWorkbenchApplyRequest,capture:LocalWorkbenchPlanCapture):void{
    const choiceId=targetChoice(capture),previous=targetBindings.get(request.commandId);
    if(previous&&(previous.choiceId!==choiceId||!equal(previous.request,request)))return failed();
    targetBindings.set(request.commandId,{request:structuredClone(request),choiceId});
  }
  function forgetQuietTarget(commandId:string):void{
    if(!running.has(commandId)&&!recovering.has(commandId)&&!retained.has(commandId)&&!failures.has(commandId))targetBindings.delete(commandId);
  }
  async function assertTargetCurrent(capture:LocalWorkbenchPlanCapture,target:RootCapability,signal:AbortSignal):Promise<void>{
    options.identity.assertCurrent();signal.throwIfAborted();targetChoice(capture);
    await options.assertTargetCurrent?.(capture,target);
    options.identity.assertCurrent();signal.throwIfAborted();targetChoice(capture);
  }
  function check():void{options.identity.assertCurrent();options.assertAccepting();if(closing||failures.size)return failed();}
  function assertPlan(request:dto.LocalWorkbenchApplyRequest,plan:dto.LocalWorkbenchPlan,capture:LocalWorkbenchPlanCapture):asserts plan is Extract<dto.LocalWorkbenchPlan,{kind:'cue'}>{
    if(!dto.isLocalWorkbenchPlan(plan)||plan.kind!=='cue'||!isLocalWorkbenchPlanCapture(capture)||plan.state!=='ready'
      ||plan.sourceDisposition!=='retain'||!plan.tracks.every(track=>isCueOutputName(track.outputName))
      ||new Set(plan.tracks.map(track=>track.outputName.normalize('NFC').toLocaleLowerCase('en-US'))).size!==plan.tracks.length
      ||!capture.format||!formats.some(value=>value.available&&equal(value,capture.format))
      ||plan.datasetId!==request.datasetId||capture.datasetId!==request.datasetId||plan.revision!==request.expectedRevision
      ||plan.planId!==request.planId||plan.planHash!==request.planHash||plan.contextFingerprint!==request.contextFingerprint)return failed();
    assertLocalWorkbenchCapturedPlan(plan,capture);options.assertOriginal(request,plan,capture);
  }
  function save(record:LocalCueOutputRecord,expected:number|null):{ledgerSequence:string}{options.identity.assertCurrent();return options.store.compareAndSwap(options.identity,record,expected);}
  async function run(request:dto.LocalWorkbenchApplyRequest,plan:Extract<dto.LocalWorkbenchPlan,{kind:'cue'}>,capture:LocalWorkbenchPlanCapture,signal:AbortSignal):Promise<void>{
    let record=options.store.read(options.identity,request.commandId)!.record;
    let namespace:SourceNamespaceWriteToken|undefined,scope:SourceNamespaceHeldScope|undefined,targetHandle:FileHandle|undefined;
    const opened=new Set<FileHandle>();
    const close = async(handle:FileHandle):Promise<void>=>{await handle.close();opened.delete(handle);};
    const update=(next:Partial<LocalCueOutputRecord>):void=>{const prior=record.revision,candidate={...record,...next,revision:prior+1};save(candidate,prior);record=candidate;};
    const ownedPublished=new Set<string>();
    let sourceFailure:SourcePublicationUnverified|null=null;
    let terminal:'failed'|'cancelled'|null=null;
    let closingPhysical = true;
    let targetPin:import('node:fs').BigIntStats|undefined,stagePin:import('node:fs').BigIntStats|undefined;
    try{
      check();signal.throwIfAborted();await options.revalidate(capture);
      const bindings=capture.cueOutputs!,byAsset=new Map<string,LocalCueAuthorizedSource>();
      for(const binding of bindings)if(!byAsset.has(binding.sourceAssetId))byAsset.set(binding.sourceAssetId,options.source(capture,binding));
      const sources=[...byAsset.values()];targetChoice(capture);
      const target=await options.target(capture);await assertTargetCurrent(capture,target,signal);
      // 原保护总域2048保留；超界整计划拒绝，不按同专辑拆业务提交。
      if(!sources.length||sources.length+plan.tracks.length+3>2048||await sourceRootAvailability(target)!=='ONLINE')return failed();
      if(sources.some(source=>{const relative=path.relative(source.root.path,target.path);return !relative||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);}))return failed();
      if(await realpath(target.path)!==target.path)return failed();
      targetHandle=await open(target.path,constants.O_RDONLY|constants.O_NOFOLLOW);opened.add(targetHandle);
      const targetInfo=await targetHandle.stat({bigint:true});targetPin=targetInfo;if(!targetInfo.isDirectory()||String(targetInfo.dev)!==target.dev||String(targetInfo.ino)!==target.ino)return failed();
      const stageDirectory='.musicbridge-cue-'+request.commandId,stageRoot=path.join(target.path,stageDirectory);
      await assertTargetCurrent(capture,target,signal);await mkdir(stageRoot,{mode:0o700});
      const stageHandle=await open(stageRoot,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);opened.add(stageHandle);
      const stageInfo=await stageHandle.stat({bigint:true});stagePin=stageInfo;if(!stageInfo.isDirectory()||stageInfo.uid!==BigInt(process.getuid!())||(stageInfo.mode&0o077n)!==0n)return failed();
      await assertTargetCurrent(capture,target,signal);update({phase:'encoding',outputRoot:structuredClone(target),stageDirectory});
      const operations=await Promise.all(plan.tracks.map(async track=>({operationId:request.commandId,name:await captureSourceNamespace(target,track.outputName)})));
      const stored=options.store.read(options.identity,request.commandId)!;
      const originBinding={datasetId:request.datasetId,originPlanId:request.planId,planHash:request.planHash,contextFingerprint:request.contextFingerprint,
        journalSequence:stored.ledgerSequence,projectionFingerprint:request.contextFingerprint};
      await assertTargetCurrent(capture,target,signal);
      namespace=await acquireSourceNamespaceWrite({...originBinding,operations});scope={datasetId:request.datasetId,planId:request.planId,originBinding,operations};
      const fence=async():Promise<void>=>{options.identity.assertCurrent();signal.throwIfAborted();await options.revalidate(capture);
        if(await sourceRootAvailability(target)!=='ONLINE')return failed();const named=await lstat(target.path,{bigint:true});
        if(!named.isDirectory()||named.isSymbolicLink()||resource(named)!==resource(targetInfo)||named.birthtimeNs!==targetInfo.birthtimeNs)return failed();
        const staged=await lstat(stageRoot,{bigint:true});if(!staged.isDirectory()||staged.isSymbolicLink()||resource(staged)!==resource(stageInfo)||staged.birthtimeNs!==stageInfo.birthtimeNs)return failed();
        assertSourceNamespaceHeld(namespace!,scope!);await assertTargetCurrent(capture,target,signal);};
      await withReadonlySourcePublicationClaims(sources.map(source=>({root:source.root,relative:source.relative,expectedSignature:source.signature})),signal,async(verify,files)=>{
        const staged:LocalCueStagedOutput[]=[],probed=new Map<string,Awaited<ReturnType<CueNativeActor['probe']>>>();
        // Native通过dup继承同一open-file-description，探测/TagLib会改变offset。
        // 每次输入从原命名位重开，核对原持有FD的完整stat；原Source保护始终不释放。
        const freshInput=async(absolute:string,held:FileHandle):Promise<FileHandle>=>{
          await fence();await verify();const expected=await held.stat({bigint:true});
          const fresh=await open(absolute,constants.O_RDONLY|constants.O_NOFOLLOW);opened.add(fresh);
          const actual=await fresh.stat({bigint:true}),named=await lstat(absolute,{bigint:true});
          const same=(a:typeof actual,b:typeof actual)=>['dev','ino','size','mtimeNs','ctimeNs'].every(key=>a[key as keyof typeof a]===b[key as keyof typeof b]);
          if(!actual.isFile()||named.isSymbolicLink()||!same(expected,actual)||!same(actual,named))return failed();
          await fence();await verify();return fresh;
        };
        for(const [assetId,source] of byAsset){
          const file=files.find(value=>value.source.root.id===source.root.id&&value.source.relative===source.relative);if(!file)return failed();
          if((await digest(file.handle,64*1024*1024*1024,signal)).sha256!==source.sha256)return failed();
          const input=await freshInput(path.join(source.root.path,source.relative),file.handle);
          let probe:Awaited<ReturnType<CueNativeActor['probe']>>;
          try{probe=await options.native.probe(input,source.demuxer,{commandId:request.commandId,claimId:randomUUID(),async assertCurrent(){await fence();await verify();}},signal);}
          finally{await close(input);}
          if(probe.channels!==source.channels)return failed();probed.set(assetId,probe);
        }
        for(const [index,track] of plan.tracks.entries()){
          await fence();await verify();
          const binding=bindings.find(value=>value.itemId===track.itemId)! ,source=byAsset.get(binding.sourceAssetId)!;
          const file=files.find(value=>value.source.root.id===source.root.id&&value.source.relative===source.relative)!,probe=probed.get(binding.sourceAssetId)!;
          if(track.sampleRate!==probe.sampleRate||track.startFrame+track.frameCount>probe.frames)return failed();
          const decodedBytes=track.frameCount*source.channels*4;
          if(!Number.isSafeInteger(decodedBytes)||decodedBytes>256*1024*1024
            ||staged.reduce((sum,item)=>sum+item.bytes,0)+decodedBytes+256*1024*1024+8*1024*1024>2*1024*1024*1024)return failed();
          const stageName=String(index).padStart(5,'0')+'.'+capture.format!.extension,stage=await open(path.join(stageRoot,stageName),constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);opened.add(stage);
          const claim={commandId:request.commandId,claimId:randomUUID(),async assertCurrent(){await fence();await verify();const stat=await stage.stat();if(!stat.isFile()||stat.nlink!==1)return failed();}};
          try{
            const input=await freshInput(path.join(source.root.path,source.relative),file.handle);
            try{await options.native.encode({source:input,target:stage,demuxer:source.demuxer,format:capture.format!.codec as CueFormatId,startFrame:track.startFrame,
                profile:outputProfile(capture.format!.codec,probe),
                frameCount:track.frameCount,sampleRate:track.sampleRate,channels:source.channels,sourceClaim:claim,targetClaim:claim},signal);}
            finally{await close(input);}
            const values:LocalAudioTagValues={};
            const keys={title:'TITLE',artist:'ARTIST',album:'ALBUM',year:'DATE',disc:'DISCNUMBER',track:'TRACKNUMBER'} as const;
            for(const change of track.changes)if(Object.hasOwn(keys,change.field)&&change.after!==null)values[keys[change.field as keyof typeof keys]]=change.after;
            const image=capture.artwork?.find(value=>value.albumId===track.albumId);if(image)values.PICTURE=image.originalBase64;
            await options.tags.run({...claim,fd:stage.fd},capture.format!.codec,values,signal);
            const decoded=await open(path.join(stageRoot,stageName+'.pcm'),constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);opened.add(decoded);
            try{
              const demuxer: CueInputDemuxer=capture.format!.codec==='alac'?'mov':capture.format!.codec==='vorbis'||capture.format!.codec==='opus'?'ogg':capture.format!.codec==='wavpack'?'wv':capture.format!.codec==='pcm-wav'?'wav':capture.format!.codec==='pcm-aiff'?'aiff':capture.format!.codec;
              const input=await freshInput(path.join(stageRoot,stageName),stage);
              try{await options.native.decode(input,decoded,demuxer,claim,signal);}finally{await close(input);}
              const decodedInfo=await decoded.stat({bigint:true});if(decodedInfo.size!==BigInt(decodedBytes))return failed();
              const decodedName=path.join(stageRoot,stageName+'.pcm');await fence();
              const named=await lstat(decodedName,{bigint:true});if(named.isSymbolicLink()||resource(named)!==resource(decodedInfo)||named.nlink!==1n)return failed();
              await unlink(decodedName);
            }finally{await close(decoded);}
            const pin=await digest(stage);staged.push({itemId:track.itemId,outputName:track.outputName,stageName,...pin});
            if(staged.reduce((sum,item)=>sum+item.bytes,0)>2*1024*1024*1024)return failed();
          }finally{await close(stage);}
        }
        await fence();await verify();update({phase:'staged',staged});
        // 在第一件link前核全部名称仍不存在；link本身再次拒覆盖，竞争失败进入整组核对。
        for(const item of staged){try{await lstat(path.join(target.path,item.outputName));return failed();}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
        await fence();await verify();update({phase:'publishing'});
        for(const item of staged){await fence();await verify();await link(path.join(stageRoot,item.stageName),path.join(target.path,item.outputName));
          ownedPublished.add(item.itemId);await fence();await verify();await targetHandle!.sync();}
        await fence();await verify();update({published:[...ownedPublished]});
        await fence();await verify();
        await removeOwnedStageAliases(record,async()=>{await fence();await verify();});
        await fence();await verify();await targetHandle!.sync();await fence();await verify();
      },()=>joinNative(request.commandId));
      await close(stageHandle);
      await close(targetHandle);targetHandle=undefined;
      await assertTargetCurrent(capture,target,signal);update({phase:'quiet',physicalClosed:false});
      await releaseSourceNamespaceWrite(namespace,[request.commandId]);namespace=undefined;
      await assertTargetCurrent(capture,target,signal);update({phase:'succeeded',physicalClosed:true,receipt:result(request,plan,'succeeded')});
    }catch(error){
      try{options.onFailure?.(request.commandId,error);}catch{/* 诊断失败不能替代原操作的物理收口。 */}
      // 任何已发布但终态commit未证实的结果保留原journal，不推断回滚或另造UUID。
      if(error instanceof SourcePublicationUnverified)sourceFailure=error;
      // 原失败/取消都保留已验证输出；先持久原意图，不能恢复成整组重编码。
      try{update({phase:signal.aborted?'cancelling':'failing',published:[...ownedPublished],physicalClosed:false,receipt:result(request,plan,'unknown')});}
      catch(cause){failures.set(request.commandId,cause);closingPhysical=false;}
      if(!namespace&&ownedPublished.size){failures.set(request.commandId,error);closingPhysical=false;}
      if(!sourceFailure&&namespace&&record.outputRoot&&record.stageDirectory){
        try{
          options.identity.assertCurrent();assertSourceNamespaceHeld(namespace,scope!);
          // 只确认已发布的完整pin并移除其stage别名；失败与取消都保留最终输出。
          {
            await joinNative(request.commandId);
            const preserved={...record,staged:record.staged.filter(item=>ownedPublished.has(item.itemId))};
            await removeOwnedStageAliases(preserved,async()=>{
              options.identity.assertCurrent();assertSourceNamespaceHeld(namespace!,scope!);
              if(!targetPin||!stagePin||!record.outputRoot||!targetHandle||await sourceRootAvailability(record.outputRoot)!=='ONLINE')return failed();
              const targetNow=await lstat(record.outputRoot.path,{bigint:true}),held=await targetHandle.stat({bigint:true});
              const stageNow=await lstat(path.join(record.outputRoot.path,record.stageDirectory!),{bigint:true});
              for(const [actual,expected] of [[targetNow,targetPin],[held,targetPin],[stageNow,stagePin]] as const)
                if(!actual.isDirectory()||actual.isSymbolicLink()||resource(actual)!==resource(expected)||actual.birthtimeNs!==expected.birthtimeNs
                  ||actual.mode!==expected.mode||actual.uid!==expected.uid||actual.gid!==expected.gid)return failed();
            });
            await targetHandle?.sync();
          }
        }catch(rollbackError){sourceFailure=null;failures.set(request.commandId,rollbackError);closingPhysical=false;}
      }
      if(sourceFailure||!closingPhysical){
        namespace&&retainSourceNamespaceWrite(namespace,[request.commandId]);if(!failures.has(request.commandId))failures.set(request.commandId,error);closingPhysical=false;
        try{update({phase:record.phase==='cancelling'?'cancelling':record.phase==='failing'?'failing':'unknown',published:[...ownedPublished],physicalClosed:false,receipt:result(request,plan,'unknown')});}catch{failures.set(request.commandId,error);}
      }else{
        const stopped=signal.aborted;
        // terminal必须在finally真实关闭后落账。
        terminal=stopped?'cancelled':'failed';
      }
    }finally{
      if(closingPhysical){
        const joined=await Promise.allSettled([options.native.join(request.commandId),options.tags.join(request.commandId)]);
        try{if(joined.some(value=>value.status==='rejected'))return failed();
          const closed=await Promise.allSettled([...opened].map(close));if(closed.some(value=>value.status==='rejected'))return failed();
          if(terminal)update({phase:terminal==='cancelled'?'cancelling':'failing',published:[...ownedPublished],physicalClosed:false,receipt:result(request,plan,'unknown')});
          if(namespace){await releaseSourceNamespaceWrite(namespace,[request.commandId]);namespace=undefined;}
          if(terminal)update({phase:terminal,published:[...ownedPublished],physicalClosed:true,receipt:result(request,plan,terminal,ownedPublished)});
        }catch(error){failures.set(request.commandId,error);closingPhysical=false;try{update({phase:record.phase==='cancelling'?'cancelling':record.phase==='failing'?'failing':'unknown',physicalClosed:false,receipt:result(request,plan,'unknown')});}catch{failures.set(request.commandId,error);}}
      }
      if(!closingPhysical){if(namespace)retainSourceNamespaceWrite(namespace,[request.commandId]);retained.set(request.commandId,{opened,namespace,scope,sourceFailure});}
    }
  }
  function original(request:dto.LocalWorkbenchApplyRequest):LocalCueOutputRecord|null{
    options.identity.assertCurrent();if(!dto.isLocalWorkbenchApplyRequest(request)||request.kind!=='cue'||request.datasetId!==options.identity.datasetId)return failed();
    const value=options.store.read(options.identity,request.commandId)?.record??null;
    if(value&&!equal(value.request,request))return failed();return value;
  }
  async function recover(request:dto.LocalWorkbenchApplyRequest,plan:dto.LocalWorkbenchPlan,capture:LocalWorkbenchPlanCapture,signal:AbortSignal):Promise<dto.LocalWorkbenchReceipt>{
    options.identity.assertCurrent();const initial=original(request);if(!initial)return failed();
    if(running.has(request.commandId))return structuredClone(initial.receipt);
    if(initial.physicalClosed&&['succeeded','failed','cancelled'].includes(initial.phase))return structuredClone(initial.receipt);
    signal.throwIfAborted();assertPlan(request,plan,capture);
    if(initial.stageDirectory!==null&&initial.stageDirectory!=='.musicbridge-cue-'+request.commandId
      ||initial.staged.some((item,index)=>{const track=plan.tracks[index];return !track||item.itemId!==track.itemId||item.outputName!==track.outputName
        ||item.stageName!==String(index).padStart(5,'0')+'.'+capture.format!.extension;}))return failed();
    const held=retained.get(request.commandId);if(held?.sourceFailure)return failed();
    // 旧冷实例的空Native Map不是原join证据；原失败/取消须有原物理保护恢复。
    const cancelling=initial.phase==='cancelling',failing=initial.phase==='failing';
    if(!held?.namespace)return failed();
    const preserved=new Set<string>();
    await options.native.join(request.commandId);await options.tags.join(request.commandId);
    let current=initial;
    const update=(patch:Partial<LocalCueOutputRecord>):void=>{const next={...current,...patch,revision:current.revision+1};save(next,current.revision);current=next;};
    let namespace:SourceNamespaceWriteToken|undefined=held?.namespace,recovery=held?.recovery;
    let scope=held?.scope;
    try{
      if(current.outputRoot){
        const target=current.outputRoot;await assertTargetCurrent(capture,target,signal);if(await sourceRootAvailability(target)!=='ONLINE')return failed();
        if(!namespace){
          const operations=await Promise.all(plan.tracks.map(async track=>({operationId:request.commandId,name:await captureSourceNamespace(target,track.outputName)})));
          const saved=options.store.read(options.identity,request.commandId)!;
          const originBinding={datasetId:request.datasetId,originPlanId:request.planId,planHash:request.planHash,contextFingerprint:request.contextFingerprint,
            journalSequence:saved.ledgerSequence,projectionFingerprint:request.contextFingerprint};
          await assertTargetCurrent(capture,target,signal);
          namespace=await acquireSourceNamespaceWrite({...originBinding,operations});scope={datasetId:request.datasetId,planId:request.planId,originBinding,operations};
        }else if(!recovery){
          // 实际持有者移交原命名位，原命令不变；恢复许可不跨公网DTO。
          await assertTargetCurrent(capture,target,signal);
          const recoveryId=randomUUID();recovery=delegateSourceNamespaceRecovery(namespace,{datasetId:request.datasetId,originPlanId:request.planId,recoveryPlanId:recoveryId,
            originBinding:scope!.originBinding,operations:scope!.operations.map(operation=>({...operation,operationId:recoveryId,originOperationId:request.commandId}))});
        }
        const sources=new Map<string,LocalCueAuthorizedSource>();for(const binding of capture.cueOutputs??[])sources.set(binding.sourceAssetId,options.source(capture,binding));
        if(!sources.size)return failed();
        const fence=async():Promise<void>=>{
          options.identity.assertCurrent();signal.throwIfAborted();await options.revalidate(capture);
          if(await sourceRootAvailability(target)!=='ONLINE'||await realpath(target.path)!==target.path)return failed();
          if(recovery&&recovery.state!=='released'){
            assertSourceNamespaceHeld(recovery,{datasetId:request.datasetId,planId:recovery.recoveryPlanId,originBinding:recovery.binding,
              operations:sourceNamespaceRecoveryBindings(recovery).map(({operationId,name})=>({operationId,name}))});
          }else assertSourceNamespaceHeld(namespace!,scope!);
          await assertTargetCurrent(capture,target,signal);
        };
        const complete=await withReadonlySourcePublicationClaims([...sources.values()].map(source=>({root:source.root,relative:source.relative,expectedSignature:source.signature})),signal,async(verify,files)=>{
          await fence();await verify();
          for(const file of files){const source=[...sources.values()].find(value=>value.root.id===file.source.root.id&&value.relative===file.source.relative)!;
            if((await digest(file.handle,64*1024*1024*1024,signal)).sha256!==source.sha256)return failed();}
          let all=current.staged.length===plan.tracks.length;
          for(const track of plan.tracks){const pin=current.staged.find(item=>item.itemId===track.itemId),absolute=path.join(target.path,track.outputName);
            let info:import('node:fs').BigIntStats;try{info=await lstat(absolute,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){all=false;continue;}throw error;}
            if(!pin||!info.isFile()||info.isSymbolicLink()||String(info.dev)!==pin.dev||String(info.ino)!==pin.ino){all=false;continue;}
            const file=await open(absolute,constants.O_RDONLY|constants.O_NOFOLLOW);
            try{const actual=await digest(file,256*1024*1024,signal);if(actual.sha256!==pin.sha256||actual.bytes!==pin.bytes)return failed();preserved.add(track.itemId);}finally{await file.close();}
          }
          await fence();await verify();
          // 已登记发布项缺失/异物时仍UNKNOWN；部分失败也不删除已验证产物。
          for(const id of current.published)if(!preserved.has(id))return failed();
          await removeOwnedStageAliases({...current,staged:current.staged.filter(item=>preserved.has(item.itemId))},async()=>{await fence();await verify();});
          await fence();await verify();return all;
        },()=>joinNative(request.commandId));
        const closed=await Promise.allSettled([...(held?.opened??[])].map(handle=>handle.close()));if(closed.some(value=>value.status==='rejected'))return failed();held?.opened.clear();
        const terminal=cancelling?'cancelled':failing||!complete?'failed':'succeeded';
        await assertTargetCurrent(capture,target,signal);update({phase:terminal==='succeeded'?'quiet':terminal==='cancelled'?'cancelling':'failing',published:[...preserved],physicalClosed:false,receipt:result(request,plan,terminal==='succeeded'?'running':'unknown')});
        if(recovery){if(recovery.state!=='released')await resolveSourceNamespaceRecovery(recovery,recovery.operationIds);await resolveSourceNamespaceOrigin(namespace,[request.commandId]);}
        else await releaseSourceNamespaceWrite(namespace,[request.commandId]);namespace=undefined;
        await assertTargetCurrent(capture,target,signal);update({phase:terminal,physicalClosed:true,receipt:result(request,plan,terminal,preserved)});
      }else update({phase:cancelling?'cancelled':'failed',physicalClosed:true,receipt:result(request,plan,cancelling?'cancelled':'failed')});
      retained.delete(request.commandId);failures.delete(request.commandId);return structuredClone(current.receipt);
    }catch(error){if(namespace){if(!recovery||recovery.state!=='released')retainSourceNamespaceWrite(recovery??namespace,recovery?.operationIds??[request.commandId]);
        retained.set(request.commandId,{opened:held?.opened??new Set(),namespace,...(recovery?{recovery}:{}),scope,
          sourceFailure:error instanceof SourcePublicationUnverified?error:held?.sourceFailure??null});}failures.set(request.commandId,error);
      try{update({phase:cancelling?'cancelling':failing?'failing':'unknown',physicalClosed:false,receipt:result(request,plan,'unknown')});}catch{failures.set(request.commandId,error);}throw error;}
  }
  function recoverOriginal(request:dto.LocalWorkbenchApplyRequest,plan:dto.LocalWorkbenchPlan,capture:LocalWorkbenchPlanCapture):Promise<dto.LocalWorkbenchReceipt>{
    options.identity.assertCurrent();if(closing)return Promise.reject(new Error('CUE作者正在关闭。'));
    // 第一await前复制并核原意图；同时核对同一原命令的恢复只执行一次。
    original(request);assertPlan(request,plan,capture);
    const existing=recovering.get(request.commandId);if(existing)return existing.done;
    const snapshot={request:structuredClone(request),plan:structuredClone(plan),capture:structuredClone(capture)},controller=new AbortController();
    bindTarget(snapshot.request,snapshot.capture);
    const done=Promise.resolve().then(()=>recover(snapshot.request,snapshot.plan,snapshot.capture,controller.signal))
      .catch(error=>{failures.set(request.commandId,error);throw error;})
      .finally(()=>{recovering.delete(request.commandId);forgetQuietTarget(request.commandId);});
    recovering.set(request.commandId,{controller,done});return done;
  }
  /** 私有目录撤销等待口：只终止原操作；UNKNOWN/保留claims不能被视为目录已可关闭。 */
  async function abortTarget(choiceId:string):Promise<void>{
    if(!dto.isLocalWorkbenchIdentity(choiceId))return failed();revokedTargets.add(choiceId);
    const selected=new Map<string,TargetBinding>();
    for(const [commandId,binding] of targetBindings)if(binding.choiceId===choiceId)selected.set(commandId,binding);
    const pending:Promise<unknown>[]=[];
    for(const commandId of selected.keys()){
      const active=running.get(commandId),recovery=recovering.get(commandId);active?.controller.abort();recovery?.controller.abort();
      if(active)pending.push(active.done);if(recovery)pending.push(recovery.done);
    }
    const completed=await Promise.allSettled(pending);
    const joined=await Promise.allSettled([...selected.keys()].map(joinNative));
    options.identity.assertCurrent();
    for(const [commandId,binding] of selected){
      const record=original(binding.request);
      if(!record||running.has(commandId)||recovering.has(commandId)||retained.has(commandId)||!record.physicalClosed
        ||!['succeeded','failed','cancelled'].includes(record.phase))return failed();
      if(failures.has(commandId))throw failures.get(commandId);
    }
    const rejected=[...completed,...joined].find((value):value is PromiseRejectedResult=>value.status==='rejected');if(rejected)throw rejected.reason;
  }
  return {
    async apply(request:dto.LocalWorkbenchApplyRequest,plan:dto.LocalWorkbenchPlan,capture:LocalWorkbenchPlanCapture):Promise<dto.LocalWorkbenchReceipt>{
      check();const previous=original(request);if(previous)return structuredClone(previous.receipt);
      assertPlan(request,plan,capture);
      const snapshot={request:structuredClone(request),plan:structuredClone(plan),capture:structuredClone(capture)};targetChoice(snapshot.capture);
      const record:LocalCueOutputRecord={schema:1,request:snapshot.request,revision:0,phase:'prepared',outputRoot:null,stageDirectory:null,staged:[],published:[],physicalClosed:false,receipt:result(snapshot.request,snapshot.plan,'running')};
      save(record,null);bindTarget(snapshot.request,snapshot.capture);const controller=new AbortController();
      const done=Promise.resolve().then(()=>run(snapshot.request,snapshot.plan,snapshot.capture,controller.signal))
        .catch(error=>{failures.set(request.commandId,error);throw error;})
        .finally(()=>{running.delete(request.commandId);forgetQuietTarget(request.commandId);});
      running.set(request.commandId,{controller,done});void done.catch(()=>{});return structuredClone(record.receipt);
    },
    recoverOriginal,
    abortTarget,
    async readOriginal(request:dto.LocalWorkbenchApplyRequest){const value=original(request);if(!value)return null;
      return structuredClone(value.receipt.state==='running'&&!running.has(request.commandId)?{...value.receipt,state:'unknown',items:value.receipt.items.map(item=>({...item,state:'unknown'}))}:value.receipt);},
    async join(commandId:string){const current=running.get(commandId);if(current)await current.done;await recovering.get(commandId)?.done;if(failures.size)throw failures.values().next().value;},
    async cancel(request:dto.LocalWorkbenchCancelRequest){const value=original(request.original);if(!value)return failed();
      const active=running.get(request.original.commandId),recovery=recovering.get(request.original.commandId);active?.controller.abort();recovery?.controller.abort();
      await active?.done;await recovery?.done;return structuredClone(original(request.original)!.receipt);},
    async close(){closing=true;for(const value of [...running.values(),...recovering.values()])value.controller.abort();
      await Promise.allSettled([...running.values(),...recovering.values()].map(value=>value.done));if(failures.size)throw failures.values().next().value;},
    inspect:()=>({closing,running:running.size,recovering:recovering.size,retained:retained.size,recoveryRequired:failures.size!==0}),
  };
}
