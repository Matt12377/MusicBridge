import { createHash, randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import * as dto from '@music-bridge/contracts';
import type { CollectionRepository } from './repository.js';
import { createLocalLegacyLinksStore } from './local-legacy-links-store.js';
import { LegacyLinksError, legacyLinksFail, legacyLinksHash, legacyLinksRequestFingerprint, isLegacyLinksBinding, type LegacyLinksLocator, type LegacyLinksSourceCapture, type LegacyLinksPrivateCapture, type LegacyLinksEvent, type LegacyLinksView } from './local-legacy-links-journal.js';
import { SourceFileError, SourcePublicationUnverified, withReadonlySourcePublicationClaims, type RootCapability } from '../recording/source-files.js';
import { LocalFactsCommitFatal } from '../stream/local-source-fence.js';

interface Reviewed { endpoints:dto.LocalLegacyLinkEndpoints; evidence:dto.LocalLegacyLinkEvidence; endpointsFingerprint:string; editionMembersFingerprint:string|null; sourceCapture:LegacyLinksSourceCapture|null }
interface Options { repository:CollectionRepository; datasetId:string; assertCurrent():void; now?:()=>number; /** 可信测试只能收紧真实观察期限。 */ ioDeadlineMs?:number; afterHash?:()=>Promise<void> }
export function createLocalLegacyLinksService(options:Options) {
  const {repository:r,datasetId}=options,now=options.now??Date.now,store=createLocalLegacyLinksStore(r.localCatalog,now);
  const deadline=options.ioDeadlineMs??120000;if(!Number.isSafeInteger(deadline)||deadline<1||deadline>120000)throw new Error('来源核验期限无效。');
  let closed=false,fatal:unknown,tail:Promise<unknown>=Promise.resolve();
  const pending=new Map<Promise<unknown>,AbortController>();
  const ready=():void=>{if(fatal)legacyLinksFail('RECOVERY_REQUIRED');if(closed)legacyLinksFail('INVENTORY_UNAVAILABLE');options.assertCurrent();};
  function check(signal:AbortSignal):void {ready();if(signal.aborted)legacyLinksFail('BUDGET_EXCEEDED');}
  function validate<C extends dto.LocalLegacyLinksCommand>(command:C,request:unknown):dto.LocalLegacyLinksCommandPayloads[C] {
    let snapshot:unknown;try{snapshot=dto.localLegacyLinksDataSnapshot(request,16384,2048,100);}catch{return legacyLinksFail('INVALID_REQUEST');}
    if(!dto.isLocalLegacyLinksCommandPayload(command,snapshot))return legacyLinksFail('INVALID_REQUEST');ready();if(snapshot.datasetId!==datasetId)return legacyLinksFail('DATASET_SCOPE_MISMATCH');return snapshot;
  }
  function mapped(error:unknown):never {
    if(error instanceof SourcePublicationUnverified||error instanceof LocalFactsCommitFatal){fatal=error;closed=true;return legacyLinksFail('RECOVERY_REQUIRED');}
    if(error instanceof LegacyLinksError)throw error;
    if(error instanceof SourceFileError)return legacyLinksFail(error.code==='REVOKED'?'SOURCE_REVOKED':error.code==='MISSING'||error.code==='SOURCE_ROOT_OFFLINE'?'SOURCE_OFFLINE':error.code==='HASH_MISMATCH'||error.code==='CONTENT_CHANGED'?'SOURCE_CHANGED':error.code==='LIMIT_EXCEEDED'?'BUDGET_EXCEEDED':'SOURCE_OFFLINE');
    if(error instanceof Error&&error.name==='LocalCatalogBudgetError')return legacyLinksFail('BUDGET_EXCEEDED');
    if(error instanceof Error&&'code' in error&&error.code==='INVENTORY_CONFLICT')return legacyLinksFail('NOT_FOUND');
    return legacyLinksFail('INVENTORY_UNAVAILABLE');
  }
  function run<T>(operation:(signal:AbortSignal)=>Promise<T>):Promise<T>{
    ready();if(pending.size>=2)return Promise.reject(new LegacyLinksError('BUDGET_EXCEEDED'));
    const controller=new AbortController();let expire!:(error:unknown)=>void;
    const timed=new Promise<never>((_,reject)=>{expire=reject;}),timer=setTimeout(()=>{controller.abort();expire(new LegacyLinksError('BUDGET_EXCEEDED'));},deadline);
    const work=tail.then(()=>{check(controller.signal);return operation(controller.signal);}).catch(mapped);
    tail=work.catch(()=>undefined);pending.set(work,controller);
    void work.then(()=>{clearTimeout(timer);pending.delete(work);},()=>{clearTimeout(timer);pending.delete(work);});
    // 到界只作逻辑拒绝；close 仍等待真实 I/O quiet，迟到任务带 abort 围栏不能落账。
    return Promise.race([work,timed]);
  }
  const cached=(command:dto.LocalLegacyLinksCommand,request:dto.PreviewLocalLegacyLink|dto.ExecuteLocalLegacyLink)=>store.receipt(command,request);
  const currentLink=(view:LegacyLinksView,id:string):dto.LocalLegacyLink=>{const link=view.links.get(id);if(!link||link.datasetId!==datasetId)return legacyLinksFail('NOT_FOUND');return structuredClone(link);};
  function undoTarget(view:LegacyLinksView,link:dto.LocalLegacyLink,intent:Extract<dto.LocalLegacyLinkIntent,{action:'undo'}>):dto.LocalLegacyLinkTransition {
    const latest=view.history.get(link.linkId)?.at(-1)?.transition;
    if(!latest||latest.action==='undone'||latest.eventId!==intent.undoTransitionEventId||!dto.localLegacyEqual(latest.after,link)||view.slot(datasetId,link.endpoints).lastTransitionEventId!==latest.eventId)return legacyLinksFail('UNDO_CONFLICT');return latest;
  }
  function checkChoice(choice:dto.LocalLegacyLinkChoice,endpoints:dto.LocalLegacyLinkEndpoints):void {
    if(choice.kind==='legacy-edition'&&endpoints.kind==='legacy-edition'){
      if(choice.subject.expectedRevision!==endpoints.subject.revision||choice.expectedEditionRevision!==endpoints.editionRevision)legacyLinksFail('REVISION_CHANGED');
    }else if(choice.kind==='draft-source-track'&&endpoints.kind==='draft-source-track'){
      if(choice.expectedDraftRevision!==endpoints.draftRevision||choice.expectedSelectionRevision!==endpoints.selectionRevision||choice.expectedLibraryRootRevision!==endpoints.libraryRootRevision||choice.expectedFileRevision!==endpoints.fileRevision||choice.expectedLocationRevision!==endpoints.locationRevision)legacyLinksFail('REVISION_CHANGED');
      if(!dto.localLegacyEqual(choice.expectedSegment,endpoints.segment))legacyLinksFail('SEGMENT_MISMATCH');
    }else legacyLinksFail('INVALID_REQUEST');
  }
  function manual(subject:dto.LocalLegacyEditionSubject,editionId:string):Reviewed {
    const edition=r.localCatalog.edition(editionId),members=r.localCatalog.editionTracks(editionId).filter(m=>m.active).sort((a,b)=>a.sequence-b.sequence||(a.id<b.id?-1:a.id>b.id?1:0));
    let snapshot:dto.LocalLegacySubjectSnapshot;
    if(subject.kind==='physical-release'){
      const detail=r.music.detail(subject.physicalReleaseId),release=detail.release;
      if(!release||detail.entry.id!==subject.physicalReleaseId||detail.entry.contentStatus!=='commercial'||!dto.isCommercialRelease(release)||(detail.entry.kind!=='cd'&&detail.entry.kind!=='cassette'))return legacyLinksFail('NOT_FOUND');
      const releaseFingerprint=createHash('sha256').update(dto.localLegacyLinksCanonical(release,524288,8192,200)).digest('hex');
      snapshot={kind:'physical-release',physicalReleaseId:subject.physicalReleaseId,revision:detail.entry.revision,summary:{format:release.format,title:release.title,artist:release.artist,year:release.year??null,edition:release.edition??null},releaseFingerprint};
    }else {const album=r.links.digitalDetail(subject.digitalAlbumId).album;snapshot={kind:'digital-album',digitalAlbumId:album.id,revision:album.revision,metadata:structuredClone(album.metadata)};}
    const endpoints:dto.LocalLegacyLinkEndpoints={kind:'legacy-edition',subject:snapshot,localEditionId:edition.id,editionRevision:edition.revision,title:edition.title,edition:edition.edition};
    const editionMembersFingerprint=legacyLinksHash(members);
    return {endpoints,evidence:{kind:'manual-edition'},editionMembersFingerprint,endpointsFingerprint:legacyLinksHash({endpoints,editionMembersFingerprint}),sourceCapture:null};
  }
  function draftSnapshot(choice:Extract<dto.LocalLegacyLinkChoice,{kind:'draft-source-track'}>) {
    const draft=r.drafts.detail(choice.draftId);if(!draft.tracks.some(t=>t.id===choice.draftTrackId))return legacyLinksFail('NOT_FOUND');
    const binding=r.sources.linked(choice.draftId,choice.draftTrackId);if(!binding||binding.id!==choice.sourceBindingId)return legacyLinksFail('SOURCE_CHANGED');
    if(!dto.localLegacyLinksSafeData(binding)||!isLegacyLinksBinding(binding))return legacyLinksFail('SOURCE_CHANGED');
    const assetSnapshot=r.localCatalog.privateLegacyLinksAssetSnapshot(choice.assetId,choice.localTrackId),a=assetSnapshot.asset,t=assetSnapshot.track,root=assetSnapshot.libraryRoot;
    if(t.assetId!==a.id||a.sourceRootId!==root.sourceRootId)return legacyLinksFail('SOURCE_CHANGED');
    const bindingRoot=r.sources.root(binding.rootId),assetRoot=r.sources.root(a.sourceRootId);if(!bindingRoot.authorized||!assetRoot.authorized)return legacyLinksFail('SOURCE_REVOKED');
    const endpoints:dto.LocalLegacyLinkEndpoints={kind:'draft-source-track',draftId:draft.id,draftTrackId:choice.draftTrackId,draftRevision:draft.revision,sourceBindingId:binding.id,bindingRootId:binding.rootId,localTrackId:t.id,assetId:a.id,selectionRevision:t.selectionRevision,libraryRootId:root.id,sourceRootId:a.sourceRootId,libraryRootRevision:root.revision,assetRootRevision:a.rootRevision,fileRevision:a.fileRevision,locationRevision:a.locationRevision,segment:t.segment};
    checkChoice(choice,endpoints);
    let coverage:dto.LocalLegacyFileCoverage={mode:'whole-file'};
    if(t.segment!==null){const tech=binding.evidence.technical;if(tech.frameEvidence!=='container-declared'||tech.sampleFrames===undefined)return legacyLinksFail('LEGACY_RANGE_UNKNOWN');
      if(t.segment.startFrame!=='0'||t.segment.endFrameExclusive!==String(tech.sampleFrames)||t.segment.timebaseHz!==tech.sampleRate||a.sampleFrames!==String(tech.sampleFrames)||a.timebaseHz!==tech.sampleRate)return legacyLinksFail('SEGMENT_MISMATCH');
      coverage={mode:'whole-file-span',segment:t.segment,sourceFrames:String(tech.sampleFrames),sourceTimebaseHz:tech.sampleRate};}
    if(assetSnapshot.catalogSha256!==null&&assetSnapshot.catalogSha256!==binding.evidence.sha256)return legacyLinksFail('SOURCE_CHANGED');
    return {endpoints,binding,assetSnapshot,bindingRoot,assetRoot,coverage};
  }
  function choiceFor(endpoints:dto.LocalLegacyLinkEndpoints,slot:dto.LocalLegacySlotGuard):dto.LocalLegacyLinkChoice {
    if(endpoints.kind==='legacy-edition')return {kind:'legacy-edition',subject:endpoints.subject.kind==='physical-release'?{kind:'physical-release',physicalReleaseId:endpoints.subject.physicalReleaseId,expectedRevision:endpoints.subject.revision}:{kind:'digital-album',digitalAlbumId:endpoints.subject.digitalAlbumId,expectedRevision:endpoints.subject.revision},localEditionId:endpoints.localEditionId,expectedEditionRevision:endpoints.editionRevision,expectedSlot:slot};
    return {kind:'draft-source-track',draftId:endpoints.draftId,draftTrackId:endpoints.draftTrackId,expectedDraftRevision:endpoints.draftRevision,sourceBindingId:endpoints.sourceBindingId,localTrackId:endpoints.localTrackId,assetId:endpoints.assetId,expectedSelectionRevision:endpoints.selectionRevision,expectedLibraryRootRevision:endpoints.libraryRootRevision,expectedFileRevision:endpoints.fileRevision,expectedLocationRevision:endpoints.locationRevision,expectedSegment:endpoints.segment,expectedSlot:slot};
  }
  async function reviewed<T>(choice:dto.LocalLegacyLinkChoice,signal:AbortSignal,consume:(proof:Reviewed,recheck:()=>void)=>T):Promise<T> {
    check(signal);
    if(choice.kind==='legacy-edition'){
      const proof=manual(choice.subject,choice.localEditionId);checkChoice(choice,proof.endpoints);
      return consume(proof,()=>{check(signal);if(!dto.localLegacyEqual(manual(choice.subject,choice.localEditionId),proof))legacyLinksFail('REVISION_CHANGED');});
    }
    const captured=draftSnapshot(choice),sources=[{root:captured.bindingRoot,relative:captured.binding.relative,expectedSignature:captured.binding.evidence.signature},{root:captured.assetRoot,relative:captured.assetSnapshot.relative}];
    return withReadonlySourcePublicationClaims(sources,signal,async(verify,files)=>{
      const locators:LegacyLinksLocator[]=[],ancestorFacts:{absolute:string;signature:string}[]=[];
      for(const [index,file] of files.entries()){
        check(signal);if(file.info.size!==BigInt(captured.binding.evidence.size))legacyLinksFail('SOURCE_CHANGED');
        const hash=createHash('sha256'),chunk=Buffer.allocUnsafe(1024*1024);let offset=0;
        while(offset<captured.binding.evidence.size){check(signal);const read=await file.handle.read(chunk,0,Math.min(chunk.length,captured.binding.evidence.size-offset),offset);check(signal);if(!read.bytesRead)legacyLinksFail('SOURCE_CHANGED');hash.update(chunk.subarray(0,read.bytesRead));offset+=read.bytesRead;}
        if(hash.digest('hex')!==captured.binding.evidence.sha256)legacyLinksFail('SOURCE_CHANGED');
        const source=sources[index]!,rootInfo=await lstat(source.root.path,{bigint:true});check(signal);
        let absolute=source.root.path;
        for(const part of ['',...source.relative.split('/').slice(0,-1)]){if(part)absolute=path.join(absolute,part);const stat=await lstat(absolute,{bigint:true});check(signal);if(!stat.isDirectory()||stat.isSymbolicLink())legacyLinksFail('SOURCE_CHANGED');ancestorFacts.push({absolute,signature:[stat.dev,stat.ino,stat.mtimeNs,stat.ctimeNs,stat.mode].join(':')});}
        locators.push({sourceRootId:source.root.id,relative:source.relative,rootIdentity:{path:source.root.path,dev:String(rootInfo.dev),ino:String(rootInfo.ino),permissionMode:String(rootInfo.mode&0o7777n)},fileIdentity:{signature:[file.info.dev,file.info.ino,file.info.size,file.info.mtimeNs,file.info.ctimeNs].join(':'),permissionMode:String(file.info.mode&0o7777n)},directoryIds:[...file.directoryIds],authorized:true});
      }
      await options.afterHash?.();check(signal);await verify();check(signal);
      for(const ancestor of ancestorFacts){const stat=await lstat(ancestor.absolute,{bigint:true});check(signal);if([stat.dev,stat.ino,stat.mtimeNs,stat.ctimeNs,stat.mode].join(':')!==ancestor.signature)legacyLinksFail('SOURCE_CHANGED');}
      const bindingFingerprint=legacyLinksHash(captured.binding),assetProofFingerprint=legacyLinksHash({assetSnapshot:captured.assetSnapshot,assetLocator:locators[1]!,sha256:captured.binding.evidence.sha256,size:String(captured.binding.evidence.size),coverage:captured.coverage});
      const evidence:dto.LocalLegacyLinkEvidence={kind:'exact-file',sha256:captured.binding.evidence.sha256,size:String(captured.binding.evidence.size),bindingFingerprint,assetProofFingerprint,coverage:captured.coverage};
      const sourceCapture:LegacyLinksSourceCapture={bindingSnapshot:captured.binding,assetSnapshot:captured.assetSnapshot,bindingFingerprint,assetProofFingerprint,bindingLocator:locators[0]!,assetLocator:locators[1]!};
      const proof:Reviewed={endpoints:captured.endpoints,evidence,sourceCapture,editionMembersFingerprint:null,endpointsFingerprint:legacyLinksHash({endpoints:captured.endpoints,bindingFingerprint,assetProofFingerprint})};
      return consume(proof,()=>{check(signal);if(!dto.localLegacyEqual(draftSnapshot(choice),captured))legacyLinksFail('SOURCE_CHANGED');});
    });
  }
  function makePreview(request:dto.PreviewLocalLegacyLink,before:dto.LocalLegacyLink|null,slot:dto.LocalLegacySlotGuard,proof:Reviewed|null,signal:AbortSignal,recheck:()=>void):dto.LocalLegacyLinkPreview {
    check(signal);const previewId=randomUUID(),createdAtMs=now(),createdAt=new Date(createdAtMs).toISOString(),expiresAt=new Date(createdAtMs+600000).toISOString();
    const endpoints=proof?.endpoints??before!.endpoints,evidence=proof?.evidence??before!.evidence;
    const guard:dto.LocalLegacyPreviewGuard={slot,expectedLinkRevision:before?.revision??null,endpointsFingerprint:proof?.endpointsFingerprint??null,editionMembersFingerprint:proof?.editionMembersFingerprint??null,bindingFingerprint:proof?.evidence.kind==='exact-file'?proof.evidence.bindingFingerprint:null,assetProofFingerprint:proof?.evidence.kind==='exact-file'?proof.evidence.assetProofFingerprint:null};
    const body:dto.LocalLegacyPreviewBody={version:1,datasetId,previewId,plannedLinkId:before?.linkId??randomUUID(),createdAt,expiresAt,intent:request.intent,reason:request.reason,before,endpoints,evidence,guard},previewHash=legacyLinksHash(body);
    const privateCapture:LegacyLinksPrivateCapture={version:1,datasetId,previewId,previewHash,createdAt,expiresAt,slot,endpointsFingerprint:guard.endpointsFingerprint,editionMembersFingerprint:guard.editionMembersFingerprint,sourceCapture:proof?.sourceCapture??null};
    const preview:dto.LocalLegacyLinkPreview={previewId,revision:'1',datasetId,body,previewHash,contextFingerprint:legacyLinksHash(privateCapture)};
    const eventBody={version:1 as const,kind:'preview' as const,eventId:randomUUID(),command:'localLegacyLinks.preview' as const,occurredAt:createdAt,requestFingerprint:legacyLinksRequestFingerprint('localLegacyLinks.preview',request),request,preview,privateCapture};
    return store.transaction(view=>{
      recheck();const prior=view.receipt(request.commandId,eventBody.requestFingerprint);if(prior){if(prior.kind!=='preview')return legacyLinksFail('COMMAND_ID_REUSED');return structuredClone(prior.preview);}
      if(!dto.localLegacyEqual(view.slot(datasetId,endpoints),slot))return legacyLinksFail('LEFT_SLOT_CHANGED');
      if(before&&!dto.localLegacyEqual(currentLink(view,before.linkId),before))return legacyLinksFail('REVISION_CHANGED');
      view.append({...eventBody,eventHash:legacyLinksHash(eventBody)});return preview;
    });
  }
  async function preview(request:dto.PreviewLocalLegacyLink):Promise<dto.LocalLegacyLinkPreview>{
    request=validate('localLegacyLinks.preview',request);const existing=cached('localLegacyLinks.preview',request);if(existing){if(existing.kind!=='preview')return legacyLinksFail('COMMAND_ID_REUSED');return structuredClone(existing.preview);}
    const capturedRequest=structuredClone(request);
    return run(async signal=>{
      const again=cached('localLegacyLinks.preview',capturedRequest);if(again?.kind==='preview')return structuredClone(again.preview);
      const intent=capturedRequest.intent;
      if(intent.action==='link'){
        if(intent.choice.expectedSlot.activeLinkId!==null)return legacyLinksFail('LEFT_SLOT_CHANGED');
        return reviewed(intent.choice,signal,(proof,recheck)=>{const slot=store.readView(view=>view.slot(datasetId,proof.endpoints));if(!dto.localLegacyEqual(slot,intent.choice.expectedSlot))return legacyLinksFail('LEFT_SLOT_CHANGED');return makePreview(capturedRequest,null,slot,proof,signal,recheck);});
      }
      const {before,slot}=store.readView(view=>{const before=currentLink(view,intent.linkId);if(before.revision!==intent.expectedLinkRevision)return legacyLinksFail('REVISION_CHANGED');if(BigInt(before.revision)>=18446744073709551615n||(intent.action==='revoke'&&BigInt(before.revision)>=18446744073709551614n))return legacyLinksFail('REVISION_EXHAUSTED');
        if(intent.action==='revoke'&&before.state!=='active')return legacyLinksFail('REVISION_CHANGED');if(intent.action==='undo')undoTarget(view,before,intent);return {before,slot:view.slot(datasetId,before.endpoints)};});
      if(intent.action==='undo'&&before.state==='revoked')return reviewed(choiceFor(before.endpoints,slot),signal,(proof,recheck)=>{if(!dto.localLegacyEqual(proof.endpoints,before.endpoints)||!dto.localLegacyEqual(proof.evidence,before.evidence))return legacyLinksFail('UNDO_CONFLICT');return makePreview(capturedRequest,before,slot,proof,signal,recheck);});
      return makePreview(capturedRequest,before,slot,null,signal,()=>check(signal));
    });
  }
  const actionFor=(command:dto.LocalLegacyLinksExecuteCommand):dto.LocalLegacyLinkReceipt['action']=>command==='localLegacyLinks.confirm'?'confirm':command==='localLegacyLinks.revoke'?'revoke':'undo';
  async function execute(command:dto.LocalLegacyLinksExecuteCommand,request:dto.ExecuteLocalLegacyLink):Promise<dto.LocalLegacyLinkReceipt>{
    request=validate(command,request);const existing=cached(command,request);if(existing){if(existing.kind!=='decision')return legacyLinksFail('COMMAND_ID_REUSED');return structuredClone(existing.receipt);}
    const captured=structuredClone(request);
    return run(async signal=>{
      const decide=(proof:Reviewed|null,recheck:()=>void,issue:dto.LocalLegacyLinksIssue|null):dto.LocalLegacyLinkReceipt=>store.transaction(view=>{
        check(signal);const prior=view.receipt(captured.commandId,legacyLinksRequestFingerprint(command,captured));if(prior){if(prior.kind!=='decision')return legacyLinksFail('COMMAND_ID_REUSED');return structuredClone(prior.receipt);}
        const eventId=randomUUID(),occurredAt=new Date(now()).toISOString(),proposal=view.previews.get(captured.previewId);let failure=issue,transition:dto.LocalLegacyLinkTransition|null=null;
        if(!failure){
          if(!proposal||proposal.preview.datasetId!==datasetId)failure='NOT_FOUND';
          else if(captured.expectedPreviewRevision!=='1'||captured.previewHash!==proposal.preview.previewHash||captured.contextFingerprint!==proposal.preview.contextFingerprint||view.consumed.has(captured.previewId)||actionFor(command)!==(proposal.preview.body.intent.action==='link'?'confirm':proposal.preview.body.intent.action))failure='PREVIEW_MISMATCH';
          else if(now()>=Date.parse(proposal.preview.body.expiresAt))failure='PLAN_EXPIRED';
          else {
            const b=proposal.preview.body;
            try{
              recheck();if(!dto.localLegacyEqual(view.slot(datasetId,b.endpoints),b.guard.slot))legacyLinksFail('LEFT_SLOT_CHANGED');
              if(b.before&&!dto.localLegacyEqual(currentLink(view,b.plannedLinkId),b.before))legacyLinksFail('REVISION_CHANGED');
              if(b.intent.action==='undo')undoTarget(view,b.before!,b.intent);
              if(b.guard.endpointsFingerprint!==null&&(!proof||proof.endpointsFingerprint!==b.guard.endpointsFingerprint||!dto.localLegacyEqual(proof.evidence,b.evidence)||!dto.localLegacyEqual(proof.endpoints,b.endpoints)))legacyLinksFail('SOURCE_CHANGED');
              const before=b.before,revision=before?(BigInt(before.revision)+1n).toString():'1',action=actionFor(command);
              if(!dto.isLocalCatalogRevision(revision)||(action!=='undo'&&BigInt(revision)>=18446744073709551615n))legacyLinksFail('REVISION_EXHAUSTED');
              const after:dto.LocalLegacyLink={version:1,datasetId,linkId:b.plannedLinkId,revision,state:action==='confirm'||action==='undo'&&before?.state==='revoked'?'active':'revoked',endpoints:b.endpoints,evidence:b.evidence,lastTransitionEventId:eventId};
              transition={eventId,datasetId,linkId:after.linkId,commandId:captured.commandId,previewId:captured.previewId,action:action==='confirm'?'confirmed':action==='revoke'?'revoked':'undone',occurredAt,reason:b.reason,before,after,undoOfEventId:b.intent.action==='undo'?b.intent.undoTransitionEventId:null};
            }catch(error){if(!(error instanceof LegacyLinksError))throw error;failure=error.code;}
          }
        }
        const receipt:dto.LocalLegacyLinkReceipt={datasetId,commandId:captured.commandId,action:actionFor(command),previewId:captured.previewId,outcome:failure?'rejected':'applied',link:transition?.after??null,transitionEventId:transition?.eventId??null,issue:failure};
        const body={version:1 as const,kind:'decision' as const,eventId,command,occurredAt,requestFingerprint:legacyLinksRequestFingerprint(command,captured),request:captured,receipt,transition};view.append({...body,eventHash:legacyLinksHash(body)});return receipt;
      });
      const p=store.readView(view=>view.previews.get(captured.previewId));
      if(!p||p.preview.datasetId!==datasetId||p.preview.body.guard.endpointsFingerprint===null||captured.previewHash!==p.preview.previewHash||captured.contextFingerprint!==p.preview.contextFingerprint||captured.expectedPreviewRevision!=='1'||actionFor(command)!==(p.preview.body.intent.action==='link'?'confirm':p.preview.body.intent.action)||now()>=Date.parse(p.preview.body.expiresAt))return decide(null,()=>check(signal),null);
      try{return await reviewed(choiceFor(p.preview.body.endpoints,p.preview.body.guard.slot),signal,(proof,recheck)=>decide(proof,recheck,null));}
      catch(error){if(error instanceof LegacyLinksError&&error.code!=='RECOVERY_REQUIRED'&&error.code!=='BUDGET_EXCEEDED')return decide(null,()=>check(signal),error.code);if(error instanceof SourceFileError)return decide(null,()=>check(signal),error.code==='REVOKED'?'SOURCE_REVOKED':error.code==='MISSING'||error.code==='SOURCE_ROOT_OFFLINE'?'SOURCE_OFFLINE':'SOURCE_CHANGED');throw error;}
    });
  }
  return {
    preview,
    confirm:(request:dto.ExecuteLocalLegacyLink)=>execute('localLegacyLinks.confirm',request),
    revoke:(request:dto.ExecuteLocalLegacyLink)=>execute('localLegacyLinks.revoke',request),
    undo:(request:dto.ExecuteLocalLegacyLink)=>execute('localLegacyLinks.undo',request),
    read(request:dto.ReadLocalLegacyLinks):dto.LocalLegacyLinksReadPage{request=validate('localLegacyLinks.read',request);try{return store.read(request);}catch(error){return mapped(error);}},
    history(request:dto.HistoryLocalLegacyLinks):dto.LocalLegacyLinksHistoryPage{request=validate('localLegacyLinks.history',request);try{return store.history(request);}catch(error){return mapped(error);}},
    async close():Promise<void>{closed=true;for(const controller of pending.values())controller.abort();await Promise.allSettled([...pending.keys()]);store.close();if(fatal)throw fatal;},
  };
}
export type LocalLegacyLinksService=ReturnType<typeof createLocalLegacyLinksService>;
