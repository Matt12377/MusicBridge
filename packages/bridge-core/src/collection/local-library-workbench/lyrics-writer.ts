import { createHash } from 'node:crypto'
import * as dto from '@music-bridge/contracts'
import type { DatasetIdentity } from '../../recording/dataset-identity.js'
import { assertSourceWritesMainActor, type SourceWritesMainActor } from '../source-writes-authority.js'
import type { PhysicalWriteClaims } from '../../stream/physical-resource-claims.js'
import type { SourcePublisherNamespaceProtection } from '../source-writes-publisher.js'
import type { LocalAudioTagsCopyClaim, createLocalAudioTagsActor } from '../../library/local-audio-tags-actor.js'
import type { LocalCatalogStore } from '../local-catalog-store.js'
import { LocalLyricsError, lyricsCanonical, lyricsDigest, type LocalLyricsProtectedSavePort, type LocalLyricsProtectedWriteResult, type LocalLyricsSaveIntent, type LocalLyricsSelectedBody, type LocalLyricsSaveRecord } from '../local-library-lyrics/types.js'
import { assertLocalLyricsSaveRecord } from '../local-library-lyrics/save-coordinator.js'

/** 整个原album intent为业务范围；member操作只作物理工作，不拆成新的用户提交。 */
export interface LocalLyricsWriteBinding {
  datasetId:string; ownerEpoch:string; commandId:string; sessionId:string; intentFingerprint:string
  libraryId:string; albumId:string; captureId:string; trackId:string; candidateId:string
  bodySha256:string; kind:'lrc'|'embed'; rootRevision:string; fileRevision:string; locationRevision:string; metadataRevision:string
}
export interface LocalLyricsHeldPublication {
  /** Root SourceFiles作者真实核验后持有的grant/claim；不得从DTO或布尔capability生成。 */
  grant:object
  physical:PhysicalWriteClaims
  namespace:SourcePublisherNamespaceProtection
  copy:LocalAudioTagsCopyClaim|null
}
/** 当前SourceWrites闭集没有LYRICS：Root须补这些具体primitive，未装齐必须拒绝。 */
export interface LocalLyricsSourceFilesAuthor {
  prepare(binding:Readonly<LocalLyricsWriteBinding>,intent:Readonly<LocalLyricsSaveIntent>,selected:Readonly<LocalLyricsSelectedBody>,actor:SourceWritesMainActor,signal:AbortSignal):Promise<LocalLyricsHeldPublication>
  /** 验真实私有grant签名/nonce、完整intent、当前epoch/revision、原namespace和实际FD/inode。 */
  assertGranted(publication:LocalLyricsHeldPublication,binding:Readonly<LocalLyricsWriteBinding>,intent:Readonly<LocalLyricsSaveIntent>):Promise<void>
  /** 无target存在时独占发布同stem LRC；existing仅返回实际正文digest，不覆盖。 */
  publishLrcExclusive(publication:LocalLyricsHeldPublication,body:Uint8Array,signal:AbortSignal):Promise<LocalLyricsProtectedWriteResult>
  /** 完成标签实际回读后提交保护副本及原同连接ledger/CAS；不是直接写原fd。 */
  publishTaggedCopy(publication:LocalLyricsHeldPublication,bodySha256:string,signal:AbortSignal):Promise<LocalLyricsProtectedWriteResult>
  readOriginal(binding:Readonly<LocalLyricsWriteBinding>):Promise<LocalLyricsProtectedWriteResult|null>
  /** 必须核原明确failed+物理probe及当前具体恢复grant；UNKNOWN不得新prepare。 */
  prepareFailedRetry(binding:Readonly<LocalLyricsWriteBinding>,intent:Readonly<LocalLyricsSaveIntent>,selected:Readonly<LocalLyricsSelectedBody>,actor:SourceWritesMainActor,signal:AbortSignal):Promise<LocalLyricsHeldPublication>
  join(commandId:string):Promise<void>
  close():Promise<void>
}
export interface LocalWorkbenchLyricsWriterOptions {
  identity:DatasetIdentity; ownerEpoch:string; catalog:LocalCatalogStore
  mainActor:SourceWritesMainActor
  tags:ReturnType<typeof createLocalAudioTagsActor>
  sourceFiles:LocalLyricsSourceFilesAuthor
  assertAccepting():void
}
export function createLocalWorkbenchLyricsWriter(options:LocalWorkbenchLyricsWriterOptions):LocalLyricsProtectedSavePort&{close():Promise<void>}{
  const {identity,sourceFiles,tags}=options
  const required=['prepare','assertGranted','publishLrcExclusive','publishTaggedCopy','readOriginal','prepareFailedRetry','join','close'] as const
  if(!required.every(key=>typeof sourceFiles?.[key]==='function'))throw new LocalLyricsError('CLOSED')
  const running=new Map<string,Set<Promise<LocalLyricsProtectedWriteResult>>>();let closing=false
  function original(kind:'lrc'|'embed',intent:LocalLyricsSaveIntent,selected:LocalLyricsSelectedBody):LocalLyricsWriteBinding{
    identity.assertCurrent()
    const saved=options.catalog.privateLyricsRecord(identity.datasetId,'save',intent.request.commandId) as LocalLyricsSaveRecord|null
    if(!saved)throw new LocalLyricsError('NOT_FOUND');assertLocalLyricsSaveRecord(saved)
    if(intent.scope.datasetId!==identity.datasetId||saved.intent.fingerprint!==intent.fingerprint||lyricsCanonical(saved.intent)!==lyricsCanonical(intent)
      ||!intent.selected.some(item=>lyricsCanonical(item)===lyricsCanonical(selected))||!dto.isLocalLyricsSafeText(selected.body,dto.LOCAL_LYRICS_LIMITS.bodyBytes,true)
      ||lyricsDigest(selected.body)!==selected.sha256||selected.track.wholeTrack||kind==='embed'&&(!intent.request.embed||!['wav','flac'].includes(selected.track.format)))throw new LocalLyricsError('STALE')
    return {datasetId:identity.datasetId,ownerEpoch:options.ownerEpoch,commandId:intent.request.commandId,sessionId:intent.request.sessionId,intentFingerprint:intent.fingerprint,
      libraryId:intent.scope.libraryId,albumId:intent.scope.albumId,captureId:intent.scope.captureId,trackId:selected.track.trackId,candidateId:selected.candidateId,bodySha256:selected.sha256,kind,
      rootRevision:selected.track.rootRevision,fileRevision:selected.track.fileRevision,locationRevision:selected.track.locationRevision,metadataRevision:selected.track.metadataRevision}
  }
  async function execute(kind:'lrc'|'embed',intent:LocalLyricsSaveIntent,selected:LocalLyricsSelectedBody,signal:AbortSignal,retry:boolean):Promise<LocalLyricsProtectedWriteResult>{
    identity.assertCurrent();options.assertAccepting();if(closing||signal.aborted)throw new LocalLyricsError('CLOSED')
    assertSourceWritesMainActor(options.mainActor)
    const binding=original(kind,intent,selected)
    if(retry){const before=await sourceFiles.readOriginal(binding);if(before?.state!=='failed')throw new LocalLyricsError('IN_FLIGHT')}
    try{
    const operation=await (retry?sourceFiles.prepareFailedRetry(binding,intent,selected,options.mainActor,signal):sourceFiles.prepare(binding,intent,selected,options.mainActor,signal))
    await sourceFiles.assertGranted(operation,binding,intent)
      let result:LocalLyricsProtectedWriteResult
      if(kind==='lrc')result=await sourceFiles.publishLrcExclusive(operation,Buffer.from(selected.body,'utf8'),signal)
      else{
        const copy=operation.copy;if(!copy||copy.commandId!==binding.commandId)throw new LocalLyricsError('STALE')
        // 原实际TagLib后端只拿SourceFiles核过的独占副本FD；actual SourceFiles assert回调仍不可省。
        const claim:LocalAudioTagsCopyClaim={...copy,async assertCurrent(){await copy.assertCurrent();await sourceFiles.assertGranted(operation,binding,intent)}}
        const receipt=await tags.run(claim,selected.track.format==='wav'?'pcm-wav':'flac',{LYRICS:selected.body},signal)
        if(receipt.exitCode!==0||!receipt.pidClosed||!receipt.actorFdsClosed||receipt.values.LYRICS!==selected.body)throw new LocalLyricsError('CONFLICT')
        await tags.join(binding.commandId)
        const readback=await tags.run(claim,selected.track.format==='wav'?'pcm-wav':'flac',null,signal)
        if(readback.values.LYRICS!==selected.body||createHash('sha256').update(readback.values.LYRICS,'utf8').digest('hex')!==selected.sha256)throw new LocalLyricsError('CONFLICT')
        await sourceFiles.assertGranted(operation,binding,intent);result=await sourceFiles.publishTaggedCopy(operation,selected.sha256,signal)
      }
      if((result.state==='saved'||result.state==='existing')&&result.bodySha256!==selected.sha256)return {state:'failed',bodySha256:result.bodySha256}
      return result
    }finally{
      // join只等待实际child/FD/namespace收口；未知/retained必须由作者拒绝join，不凭race视为closed。
      const joined=await Promise.allSettled([tags.join(binding.commandId),sourceFiles.join(binding.commandId)]);if(joined.some(r=>r.status==='rejected'))throw new LocalLyricsError('CLOSED')
    }
  }
  function launch(kind:'lrc'|'embed',intent:LocalLyricsSaveIntent,selected:LocalLyricsSelectedBody,signal:AbortSignal,retry:boolean){
    const id=intent.request.commandId,p=execute(kind,intent,selected,signal,retry),set=running.get(id)??new Set<Promise<LocalLyricsProtectedWriteResult>>()
    set.add(p);running.set(id,set);void p.finally(()=>{set.delete(p);if(set.size===0)running.delete(id)}).catch(()=>{});return p
  }
  return {write:(kind,intent,selected,signal)=>launch(kind,intent,selected,signal,false),retryFailed:(kind,intent,selected,signal)=>launch(kind,intent,selected,signal,true),
    async readOriginal(kind,intent,selected){return sourceFiles.readOriginal(original(kind,intent,selected))},
    async join(commandId){await Promise.allSettled([...(running.get(commandId)??[])]);const joined=await Promise.allSettled([tags.join(commandId),sourceFiles.join(commandId)]);if(joined.some(r=>r.status==='rejected'))throw new LocalLyricsError('CLOSED')},
    async close(){closing=true;await tags.close();await Promise.allSettled([...running.values()].flatMap(set=>[...set]));await sourceFiles.close()},
  }
}
