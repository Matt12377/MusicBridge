import * as dto from '@music-bridge/contracts'
import type { DatasetIdentity } from '../../recording/dataset-identity.js'
import { assertLocalWorkbenchCatalogOwner, type LocalCatalogStore } from '../local-catalog-store.js'
import type { CollectionRepository } from '../repository.js'
import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat } from 'node:fs/promises'
import path from 'node:path'
import { authorizeSourceDirectory, withReadonlySourcePublicationClaims, SourcePublicationUnverified, createLyricsSourceFilesAuthor, type RootCapability, type LyricsSourceSafetyPort } from '../../recording/source-files.js'
import { assertSourceWritesMainActor, type SourceWritesMainActor } from '../source-writes-authority.js'
import { assertLyricsNativeFidelityPort, captureLocalLyricsPhysicalGroup, lyricsPhysicalDigest, LOCAL_LYRICS_PHYSICAL_LIMITS, type LocalLyricsPhysicalResource, type LocalLyricsPhysicalMember, type LyricsNativeFidelityPort } from '../../library/lyrics-source-format.js'
import type { createLocalAudioTagsActor, LocalAudioTagFormat } from '../../library/local-audio-tags-actor.js'
import { createLocalWorkbenchLyricsWriter } from './lyrics-writer.js'
import type { LocalWorkbenchPlanRegistry } from './plan-registry.js'
import type { LocalWorkbenchMBOnlyWriter } from './owner-writer.js'
import { LocalLyricsService } from '../local-library-lyrics/service.js'
import { LocalLyricsJob } from '../local-library-lyrics/job.js'
import { LocalLyricsInventory } from '../local-library-lyrics/inventory.js'
import { LocalLyricsError, lyricsCanonical, lyricsDigest, checkLyricsCapture, type LocalLyricsCapture, type LocalLyricsLibraryCapture, type LocalLyricsProviderTransportPort, type LocalLyricsProviderQuery, type LocalLyricsProtectedSavePort, type LocalLyricsPendingCoverPort, type LocalLyricsInventoryObservation, type LocalLyricsSaveRecord, type LocalLyricsJobRecord, type LocalLyricsPorts } from '../local-library-lyrics/types.js'
import { assertLocalLyricsSaveRecord } from '../local-library-lyrics/save-coordinator.js'
import type { LocalWorkbenchReadService, LocalWorkbenchResolvedReadCapture, LocalLibraryManagementFrozenAlbum } from './read-service.js'
import { createLocalLyricsAlbumInventory, localLibraryManagementDigest, type LocalLyricsInventoryRecord, type LocalLibraryManagementCaptureRecord, type LocalLyricsRootCaptureRecord, type LocalLyricsRootSnapshotRecord, type LocalLyricsRootResource, type LocalLyricsRootPublicationPin } from './owner-journal.js'
import { randomUUID } from 'node:crypto'
import { isDatasetProjectionPayload, isDatasetProjectionResult, DatasetLyricsProviderBridgeError, type DatasetProjectionPort, type DatasetLyricsProviderRead } from '../dataset-owner-protocol.js'
import { isLocalWorkbenchDataRecord } from './types.js'

/** 实际Owner经有限反向projection取完整五源响应，取消后仍join原Main资源。 */
export function createLocalLyricsProjectionTransport(options:{identity:DatasetIdentity;ownerEpoch:string;projection:DatasetProjectionPort;assertAccepting():void}):LocalLyricsProviderTransportPort&{close():Promise<void>}{
  if(!dto.isCollectionId(options.ownerEpoch))throw new LocalLyricsError('INVALID');
  let closing=false,closePromise:Promise<void>|undefined;
  const deadlines=new WeakMap<AbortSignal,number>();
  const flights=new Map<string,{sourceSignal:AbortSignal;controller:AbortController;quiet:Promise<void>}>();
  const current=()=>{options.identity.assertCurrent();options.assertAccepting();if(closing)throw new LocalLyricsError('CLOSED');};
  const delay=(signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{const cancel=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);reject(new DatasetLyricsProviderBridgeError('CANCELLED'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve();},20);signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();});
  return {
    async request(source:dto.LocalLyricsSource,operation:'search'|'body',input:LocalLyricsProviderQuery|{id:string},sourceSignal:AbortSignal,context?:{expiresAtMs:number}){
      current();if(sourceSignal.aborted)throw new DatasetLyricsProviderBridgeError('CANCELLED');
      if(context!==undefined&&(!isLocalWorkbenchDataRecord(context,['expiresAtMs'])||!Number.isSafeInteger(context.expiresAtMs)||context.expiresAtMs>Date.now()+dto.LOCAL_LYRICS_LIMITS.providerMs))throw new LocalLyricsError('INVALID');
      const expiresAtMs=Math.min(deadlines.get(sourceSignal)??Date.now()+dto.LOCAL_LYRICS_LIMITS.providerMs,context?.expiresAtMs??Number.MAX_SAFE_INTEGER);deadlines.set(sourceSignal,expiresAtMs);
      if(Date.now()>=expiresAtMs)throw new DatasetLyricsProviderBridgeError('TIMEOUT');
      const operationId=randomUUID(),start={operationId,source,operation,input,expiresAtMs};
      if(!isDatasetProjectionPayload('lyricsProviderStart',start)||Date.now()>=expiresAtMs)throw new LocalLyricsError('INVALID');
      const controller=new AbortController(),cancel=()=>controller.abort();sourceSignal.addEventListener('abort',cancel,{once:true});
      let quietResolve!:()=>void,quietReject!:(error:unknown)=>void;const quiet=new Promise<void>((resolve,reject)=>{quietResolve=resolve;quietReject=reject;});void quiet.catch(()=>{});
      flights.set(operationId,{sourceSignal,controller,quiet});
      const timer=setTimeout(()=>controller.abort(),Math.max(1,expiresAtMs-Date.now()));let complete=false;
      const check=()=>{current();if(controller.signal.aborted||Date.now()>=expiresAtMs)throw new DatasetLyricsProviderBridgeError('CANCELLED');};
      try{
        check();const begun=await options.projection.call('lyricsProviderStart',start);check();
        if(!isDatasetProjectionResult('lyricsProviderStart',begun)||begun.operationId!==operationId)throw new DatasetLyricsProviderBridgeError('INVALID_RESPONSE');
        const chunks:Buffer[]=[];let offset=0,total:number|null=null,sha256:string|null=null;
        for(;;){check();const read=await options.projection.call('lyricsProviderRead',{operationId,offset});check();
          if(!isDatasetProjectionResult('lyricsProviderRead',read)||read.operationId!==operationId||read.offset!==offset)throw new DatasetLyricsProviderBridgeError('INVALID_RESPONSE');
          if(read.state==='queued'||read.state==='running'){await delay(controller.signal);continue;}
          if(read.state!=='complete')throw new DatasetLyricsProviderBridgeError(read.failure??'INVALID_RESPONSE');
          const packet=read as DatasetLyricsProviderRead;if(total!==null&&(packet.totalBytes!==total||packet.sha256!==sha256))throw new DatasetLyricsProviderBridgeError('INVALID_RESPONSE');
          total=packet.totalBytes;sha256=packet.sha256;chunks.push(Buffer.from(packet.bytes));offset+=packet.bytes.byteLength;
          if(offset>dto.LOCAL_LYRICS_LIMITS.sourceRawBytes)throw new DatasetLyricsProviderBridgeError('BUDGET');
          if(!packet.eof)continue;const raw=Buffer.concat(chunks,offset);
          if(offset!==total||lyricsDigest(raw.toString('utf8'))!==sha256||Buffer.from(raw.toString('utf8'),'utf8').compare(raw)!==0)throw new DatasetLyricsProviderBridgeError('INVALID_RESPONSE');
          complete=true;return new Uint8Array(raw);
        }
      }finally{
        clearTimeout(timer);sourceSignal.removeEventListener('abort',cancel);
        try{
          if(!complete){const cancelled=await options.projection.call('lyricsProviderCancel',{operationId});if(!isDatasetProjectionResult('lyricsProviderCancel',cancelled)||cancelled.operationId!==operationId)throw new DatasetLyricsProviderBridgeError('INVALID_RESPONSE');}
          const joined=await options.projection.call('lyricsProviderJoin',{operationId});if(!isDatasetProjectionResult('lyricsProviderJoin',joined)||joined.operationId!==operationId)throw new DatasetLyricsProviderBridgeError('INVALID_RESPONSE');
          flights.delete(operationId);quietResolve();
        }catch(error){quietReject(error);throw error;}
      }
    },
    async join(signal){const quiet=[...flights.values()].filter(f=>f.sourceSignal===signal).map(f=>f.quiet);const joined=await Promise.allSettled(quiet);if(joined.some(r=>r.status==='rejected'))throw new LocalLyricsError('CLOSED');},
    close(){if(closePromise)return closePromise;closing=true;for(const f of flights.values())f.controller.abort();closePromise=(async()=>{const joined=await Promise.allSettled([...flights.values()].map(f=>f.quiet));if(joined.some(r=>r.status==='rejected'))throw new LocalLyricsError('CLOSED');})();return closePromise;},
  };
}

/** 同Owner原库选择引用，分页必须覆盖全部已扫描专辑，不能从Renderer filter/page生成。 */
export interface LocalLyricsLibraryAuthor {
  capture(request:dto.LocalLyricsLibraryRequest):Promise<LocalLyricsLibraryCapture>
  assertCurrent(capture:LocalLyricsLibraryCapture):Promise<void>
  page(capture:LocalLyricsLibraryCapture,cursor:string|null):Promise<{scopes:readonly dto.LocalLyricsScope[];next:string|null;total:number;watermark:string}>
  /** UI原readToken原样返回；job则按原已授权库范围惰性签发album原readToken，不预实体化整库512+ leases。 */
  resolveAlbumReadToken(scope:dto.LocalLyricsScope):Promise<string>
  readAlbumPresence(capture:LocalLyricsLibraryCapture,scope:dto.LocalLyricsScope):Promise<dto.LocalLyricsPresence>
}
export interface LocalWorkbenchLyricsServiceOptions {
  identity:DatasetIdentity
  ownerEpoch:string
  assertAccepting():void
  catalog:LocalCatalogStore
  workbench:LocalWorkbenchReadService
  library:LocalLyricsLibraryAuthor
  /** 由有限DatasetProjection私有路由转发Main固定五源transport；Owner不fetch。 */
  providers:LocalLyricsProviderTransportPort&{close():Promise<void>}
  writer:LocalLyricsProtectedSavePort&{close():Promise<void>}
  cover:LocalLyricsPendingCoverPort
  inventoryPhysical:{
    inspect(capture:Readonly<LocalWorkbenchResolvedReadCapture>,signal:AbortSignal):Promise<readonly LocalLyricsInventoryObservation[]>
    snapshot(capture:Readonly<LocalWorkbenchResolvedReadCapture>,commandId:string):Promise<'saved'|'failed'>
  }
  /** 原Owner保存完整读取原件；权限对象与路径不进入持久捕获。 */
  observeOriginalCapture?(capture:Readonly<LocalLyricsCapture>,resolved:Readonly<LocalWorkbenchResolvedReadCapture>):Promise<void|readonly LocalLyricsInventoryObservation[]>
  /** 生产作者只回读同SQL持久原组，冷恢复不靠过期lease或另签readToken。 */
  resolveOriginalCapture?(scope:dto.LocalLyricsScope):Promise<{resolved:Readonly<LocalWorkbenchResolvedReadCapture>;fingerprint?:string}>
  prepareQuery?(capture:Readonly<LocalLyricsCapture>,resolved:Readonly<LocalWorkbenchResolvedReadCapture>,signal:AbortSignal):Promise<readonly LocalLyricsInventoryObservation[]>
  /** 只供原save/snapshot显式重试，不将旧capture替换成新readToken或新范围。 */
  resolveSavedCapture?(scope:dto.LocalLyricsScope,originalCommandId:string):Promise<{resolved:Readonly<LocalWorkbenchResolvedReadCapture>;fingerprint:string}>
  /** 自身变化仅按这条原command的真实CLOSED publication解释。 */
  assertOriginalCapture?(capture:Readonly<LocalLyricsCapture>,resolved:Readonly<LocalWorkbenchResolvedReadCapture>,originalCommandId?:string):Promise<void>
  now?:()=>number
}
export function createLocalWorkbenchLyricsService(options:LocalWorkbenchLyricsServiceOptions){
  const datasetId=options.identity.datasetId,now=options.now??(()=>performance.now())
  if(!dto.isCommandOutboxDatasetId(datasetId)||!dto.isLocalLyricsId(options.ownerEpoch))throw new LocalLyricsError('INVALID')
  options.catalog.privateBindWorkbenchDataset(options.identity)
  let closing=false,closed:Promise<void>|undefined
  const captures=new WeakMap<object,{resolved:Readonly<LocalWorkbenchResolvedReadCapture>;readToken:string;fingerprint:string;originalCommandId?:string}>()
  const identityCheck=():void=>options.identity.assertCurrent()
  const check=():void=>{identityCheck();options.assertAccepting();if(closing)throw new LocalLyricsError('CLOSED')}
  const scopeCheck=(scope:dto.LocalLyricsScope):void=>{check();if(!dto.isLocalLyricsScope(scope)||scope.datasetId!==datasetId)throw new LocalLyricsError('STALE')}
  function version(title:string):dto.LocalLyricsVersion{
    if(/\blive\b|现场|現場/iu.test(title))return 'live'
    if(/\bremix\b|混音/iu.test(title))return 'remix'
    if(/\binstrumental\b|伴奏/iu.test(title))return 'instrumental'
    return 'unknown'
  }
  async function capture(scope:dto.LocalLyricsScope,originalCommandId?:string):Promise<LocalLyricsCapture>{
    scopeCheck(scope)
    if(originalCommandId!==undefined&&!dto.isLocalLyricsId(originalCommandId))throw new LocalLyricsError('INVALID')
    const saved=originalCommandId===undefined?undefined:await options.resolveSavedCapture?.(scope,originalCommandId);check()
    if(originalCommandId!==undefined&&options.resolveSavedCapture&&!saved)throw new LocalLyricsError('STALE')
    const frozen=saved??await options.resolveOriginalCapture?.(scope);check()
    const readToken=frozen?.resolved.capture.readToken??await options.library.resolveAlbumReadToken(scope);check()
    const resolved=frozen?.resolved??await options.workbench.resolveCapture({datasetId,capture:{albumId:scope.albumId,readToken}});check()
    if(resolved.datasetId!==datasetId||resolved.capture.albumId!==scope.albumId||resolved.group.summary.id!==scope.albumId
      ||resolved.capture.rootId!==scope.libraryId||resolved.capture.readToken!==readToken)throw new LocalLyricsError('STALE')
    const byTrack=new Map(resolved.group.members.map(m=>[m.fact.summary.track.id,m]))
    const tracks=resolved.capture.members.flatMap(m=>{
      if(m.trackId===null)return []
      const group=byTrack.get(m.trackId)
      if(!group||m.assetId!==group.fact.summary.asset.id||m.fileRevision!==group.fact.summary.asset.fileRevision||m.locationRevision!==group.fact.summary.asset.locationRevision)throw new LocalLyricsError('STALE')
      const relative=group.fact.relative,file=resolved.directoryFacts.files.find(f=>f.currentRelative===relative)
      const technical=file?.value.readFacts?.technical
      const presence=options.catalog.privateLyricsTrackFacts(datasetId,m.trackId,scope.libraryId,m.fileRevision)
      const title=m.title??'',artist=m.artist??'',album=m.album??''
      return [{trackId:m.trackId,title,artist,album,language:'',version:version(title),durationMs:technical?.durationSeconds===null||technical?.durationSeconds===undefined?null:Math.round(technical.durationSeconds*1000),
        wholeTrack:group.fact.summary.track.segment!==null||resolved.group.summary.statuses.includes('cue-unsplit'),format:technical?.container==='FLAC'?'flac' as const:technical?.container==='WAVE'?'wav' as const:'other' as const,
        rootRevision:m.rootRevision,fileRevision:m.fileRevision,locationRevision:m.locationRevision,metadataRevision:m.metadataRevision,lrc:presence.lrc,embedded:presence.embedded}]
    })
    if(tracks.length!==resolved.group.members.length)throw new LocalLyricsError('STALE')
    const fingerprint=frozen?.fingerprint??lyricsDigest(lyricsCanonical([options.ownerEpoch,resolved.datasetRevision,resolved.capture]))
    const authorityRef=Object.freeze({}),value:LocalLyricsCapture={scope:structuredClone(scope),authorityRef,epoch:options.ownerEpoch,fingerprint,tracks,online:resolved.availability==='online'}
    checkLyricsCapture(value);captures.set(authorityRef,{resolved,readToken,fingerprint,...(!saved||originalCommandId===undefined?{}:{originalCommandId})})
    if(!saved){const observed=await options.observeOriginalCapture?.(value,resolved);check()
      if(observed){const rows=new Map(observed.map(row=>[row.trackId,row]));if(observed.length!==tracks.length||rows.size!==tracks.length||tracks.some(track=>rows.get(track.trackId)?.fileRevision!==track.fileRevision))throw new LocalLyricsError('STALE')
        for(const track of tracks){const row=rows.get(track.trackId)!;track.lrc=row.lrc;track.embedded=row.embedded}checkLyricsCapture(value)}}
    check();return value
  }
  function original(capture:LocalLyricsCapture){const proof=captures.get(capture.authorityRef);if(!proof||capture.scope.datasetId!==datasetId||capture.epoch!==options.ownerEpoch||capture.fingerprint!==proof.fingerprint)throw new LocalLyricsError('STALE');return proof}
  async function assertCurrent(capture:LocalLyricsCapture,originalCommandId?:string):Promise<void>{
    check();const proof=original(capture)
    if(proof.originalCommandId!==undefined&&originalCommandId!==undefined&&proof.originalCommandId!==originalCommandId)throw new LocalLyricsError('STALE')
    const commandId=originalCommandId??proof.originalCommandId
    if(options.assertOriginalCapture){await options.assertOriginalCapture(capture,proof.resolved,commandId);check();return}
    if(proof.originalCommandId!==undefined)throw new LocalLyricsError('STALE')
    const fresh=await options.workbench.resolveCapture({datasetId,capture:{albumId:capture.scope.albumId,readToken:proof.readToken}});check()
    if(lyricsDigest(lyricsCanonical([options.ownerEpoch,fresh.datasetRevision,fresh.capture]))!==proof.fingerprint)throw new LocalLyricsError('STALE')
  }
  const ports:LocalLyricsPorts={
    capture:{capture,assertCurrent,
      ...(options.prepareQuery?{async prepareQuery(value:LocalLyricsCapture,signal:AbortSignal){await assertCurrent(value);const rows=await options.prepareQuery!(value,original(value).resolved,signal);check();if(signal.aborted)throw new LocalLyricsError('CLOSED');await assertCurrent(value);return rows}}:{}),
      async captureLibrary(library){check();if(!dto.isLocalLyricsLibraryRequest(library)||library.datasetId!==datasetId)throw new LocalLyricsError('STALE');const value=await options.library.capture(library);check();if(lyricsCanonical(value.library)!==lyricsCanonical(library)||!Number.isFinite(value.deadlineAtMs)||value.deadlineAtMs<=now())throw new LocalLyricsError('STALE');await options.library.assertCurrent(value);return value},
      async assertLibraryCurrent(value){check();if(value.library.datasetId!==datasetId)throw new LocalLyricsError('STALE');await options.library.assertCurrent(value);check()},
      async libraryPage(value,cursor){check();await options.library.assertCurrent(value);const page=await options.library.page(value,cursor);check();await options.library.assertCurrent(value);return page}},
    journal:{
      async readSave(commandId){identityCheck();return options.catalog.privateLyricsRecord(datasetId,'save',commandId) as LocalLyricsSaveRecord|null},
      async pendingSaves(scope){identityCheck();if(scope.datasetId!==datasetId)throw new LocalLyricsError('STALE');return options.catalog.privateLyricsPending(datasetId,scope)},
      async save(record,expectedRevision){identityCheck();assertLocalLyricsSaveRecord(record)
        if(expectedRevision===null){const current=await capture(record.intent.scope);await assertCurrent(current);if(current.fingerprint!==record.intent.captureFingerprint||record.intent.selected.some(s=>!current.tracks.some(t=>lyricsCanonical(t)===lyricsCanonical(s.track))))throw new LocalLyricsError('STALE')}
        options.catalog.privateLyricsCompareAndSwap(datasetId,'save',record,expectedRevision)},
      async readJob(jobId){identityCheck();return options.catalog.privateLyricsRecord(datasetId,'job',jobId) as LocalLyricsJobRecord|null},
      async checkpoint(record,expectedRevision){identityCheck();options.catalog.privateLyricsCompareAndSwap(datasetId,'job',record,expectedRevision)}},
    providers:options.providers,writer:options.writer,cover:options.cover,
    inventory:{
      async inspect(value,signal){await assertCurrent(value);const result=await options.inventoryPhysical.inspect(original(value).resolved,signal);await assertCurrent(value);return result},
      async persist(value,observations){await assertCurrent(value);const key=lyricsDigest(lyricsCanonical([value.scope.libraryId,value.scope.albumId]))
        const old=options.catalog.privateLyricsRecord(datasetId,'inventory',key) as LocalLyricsInventoryRecord|null
        const record:LocalLyricsInventoryRecord={scope:structuredClone(value.scope),captureFingerprint:value.fingerprint,revision:old?old.revision+1:0,observations:structuredClone(observations)}
        options.catalog.privateLyricsCompareAndSwap(datasetId,'inventory',record,old?.revision??null)},
      async snapshot(value,commandId){await assertCurrent(value,commandId);return options.inventoryPhysical.snapshot(original(value).resolved,commandId)},
      async page(library,filter,offset,limit){check();const c=await options.library.capture(library);await options.library.assertCurrent(c)
        const all:dto.LocalLyricsInventoryRow[]=[];let cursor:string|null=null,total:number|null=null;const seen=new Set<string>()
        do{const page=await options.library.page(c,cursor);if(page.watermark!==c.watermark||total!==null&&total!==page.total||page.next===cursor&&cursor!==null)throw new LocalLyricsError('STALE');total=page.total
          for(const scope of page.scopes){if(scope.datasetId!==datasetId||scope.libraryId!==library.libraryId||seen.has(scope.albumId))throw new LocalLyricsError('STALE');seen.add(scope.albumId)
            const presence=await options.library.readAlbumPresence(c,scope)
            if(filter==='all'||presence==='false')all.push({albumId:scope.albumId,presence})}
          cursor=page.next
        }while(cursor!==null)
        if(seen.size!==total)throw new LocalLyricsError('STALE');await options.library.assertCurrent(c);return {total:all.length,watermark:c.watermark,rows:all.slice(offset,offset+limit)}}},
    lifecycle:{assertAccepting:check,now,async join(){const results=await Promise.allSettled([options.providers.close(),options.writer.close()]);if(results.some(r=>r.status==='rejected'))throw new LocalLyricsError('CLOSED')}},
  }
  const service=new LocalLyricsService(ports),job=new LocalLyricsJob(ports,service),inventory=new LocalLyricsInventory(ports)
  const handlers:{[C in dto.LocalLyricsCommand]:(payload:dto.LocalLyricsCommandPayloads[C])=>Promise<dto.LocalLyricsCommandResults[C]>}={
    'localLyrics.query':p=>service.query(p),'localLyrics.session.read':p=>service.readSession(p),'localLyrics.detail':p=>service.detail(p),
    'localLyrics.select':p=>service.select(p),'localLyrics.cancel':p=>service.cancel(p),'localLyrics.discard':p=>service.discard(p),
    'localLyrics.save':p=>service.save(p),'localLyrics.receipt':p=>service.receipt(p),'localLyrics.save.retry':p=>service.retrySave(p),'localLyrics.snapshot.retry':p=>service.retrySnapshot(p),
    'localLyrics.job.start':p=>job.start(p),'localLyrics.job.read':p=>job.read(p.jobId,p.albumId),'localLyrics.job.stop':p=>job.stop(p.jobId),'localLyrics.job.resume':p=>job.resume(p.jobId),'localLyrics.job.retry':p=>job.retry(p),'localLyrics.inventory':p=>inventory.page(p),
  }
  return {
    service,job,inventory,albumInventory:createLocalLyricsAlbumInventory(datasetId,options.catalog),
    async execute<C extends dto.LocalLyricsCommand>(command:C,payload:dto.LocalLyricsCommandPayloads[C]):Promise<dto.LocalLyricsCommandResults[C]>{check();if(!dto.isLocalLyricsCommandPayload(command,payload))throw new LocalLyricsError('INVALID');return handlers[command](payload)},
    async close():Promise<void>{if(!closed){closing=true;closed=(async()=>{await job.close();await service.close()})()}return closed},
  }
}
export type LocalWorkbenchLyricsService=ReturnType<typeof createLocalWorkbenchLyricsService>

/** 生产装配只接原Owner实例、Main实际品牌和已加载Native作者，不从DTO制造权限。 */
export interface LocalWorkbenchRootLyricsRuntimeOptions {
  identity:DatasetIdentity;ownerEpoch:string;repository:CollectionRepository;catalog:LocalCatalogStore
  workbench:LocalWorkbenchReadService;library:LocalLyricsLibraryAuthor
  readFrozenAlbum(scope:dto.LocalLyricsScope):Promise<LocalLibraryManagementFrozenAlbum>
  mainActor:SourceWritesMainActor;native:LyricsNativeFidelityPort;tags:ReturnType<typeof createLocalAudioTagsActor>;sourceSafety:LyricsSourceSafetyPort
  projection:DatasetProjectionPort;plans():Promise<LocalWorkbenchPlanRegistry>;coverWriter:LocalWorkbenchMBOnlyWriter;assertAccepting():void
}
const rootSignature=(s:BigIntStats):string=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':')
const rootSame=(a:unknown,b:unknown):boolean=>lyricsCanonical(a)===lyricsCanonical(b)
const rootParent=(relative:string):string=>relative.includes('/')?relative.slice(0,relative.lastIndexOf('/')):''
const rootKey=(scope:dto.LocalLyricsScope):string=>localLibraryManagementDigest(scope)
function rootTagFormat(container:string|undefined,codec:string|undefined):LocalAudioTagFormat|null {
  const value=(container??'').toUpperCase(),encoding=(codec??'').toUpperCase()
  if(value==='FLAC')return 'flac';if(value==='WAVE'||value==='WAV')return 'pcm-wav';if(value==='AIFF'||value==='AIFF-C')return 'pcm-aiff'
  if(value==='MPEG'||value==='MP3')return 'mp3';if(value==='WAVPACK')return 'wavpack'
  if(encoding.includes('VORBIS'))return 'vorbis';if(encoding.includes('OPUS'))return 'opus';if(encoding.includes('ALAC'))return 'alac'
  return null
}
export type LocalWorkbenchRootLyricsRuntime=LocalWorkbenchLyricsService&{joinOriginalWrite(commandId:string):Promise<void>;removeLibrary(libraryId:string):Promise<void>}
export function createLocalWorkbenchRootLyricsRuntime(options:LocalWorkbenchRootLyricsRuntimeOptions):LocalWorkbenchRootLyricsRuntime {
  const {identity,catalog,repository}=options
  identity.assertCurrent();if(repository.localCatalog!==catalog)throw new LocalLyricsError('STALE')
  catalog.privateBindWorkbenchDataset(identity);assertLocalWorkbenchCatalogOwner(catalog,identity);assertSourceWritesMainActor(options.mainActor);assertLyricsNativeFidelityPort(options.native)
  if(!dto.isCollectionId(options.ownerEpoch))throw new LocalLyricsError('INVALID')
  let closing=false,closePromise:Promise<void>|undefined
  const flights=new Map<string,{libraryId:string;controller:AbortController;quiet:Promise<unknown>}>()
  const retiredLibraries=new Set<string>()
  const originalReferences=new WeakMap<object,{resolved:Readonly<LocalWorkbenchResolvedReadCapture>;managementCapture:LocalLyricsRootCaptureRecord['managementCapture'];fingerprint:string;scope:dto.LocalLyricsScope}>()
  const check=():void=>{identity.assertCurrent();assertLocalWorkbenchCatalogOwner(catalog,identity);options.assertAccepting();if(closing)throw new LocalLyricsError('CLOSED')}
  const checkSignal=(signal:AbortSignal):void=>{check();if(signal.aborted)throw new LocalLyricsError('CLOSED')}
  function tracked<T>(libraryId:string,parent:AbortSignal|undefined,run:(signal:AbortSignal)=>Promise<T>):Promise<T>{
    if(retiredLibraries.has(libraryId)||!catalog.privateLibraryManagementRootAvailable(libraryId))throw new LocalLyricsError('CLOSED')
    check();const id=randomUUID(),controller=new AbortController(),abort=()=>controller.abort();parent?.addEventListener('abort',abort,{once:true});if(parent?.aborted)abort()
    const quiet=Promise.resolve().then(()=>run(controller.signal)).finally(()=>{parent?.removeEventListener('abort',abort);flights.delete(id)})
    flights.set(id,{libraryId,controller,quiet});void quiet.catch(()=>{});return quiet
  }
  async function frozen(scope:dto.LocalLyricsScope){
    check();if(!dto.isLocalLyricsScope(scope)||scope.datasetId!==identity.datasetId)throw new LocalLyricsError('STALE')
    const value=await options.readFrozenAlbum(scope);check();const selected=catalog.privateLibraryManagementReadFrozenAlbum(identity,scope)
    if(!selected||!rootSame(selected.captureRecord,value.captureRecord)||!rootSame(selected.managementCapture,value.managementCapture))throw new LocalLyricsError('STALE')
    if(!rootSame(selected.album.resolved,value.resolved)||value.resolved.datasetId!==identity.datasetId
      ||(selected.captureRecord.original.mode==='library'?selected.captureRecord.key!==scope.captureId:value.resolved.capture.readToken!==scope.captureId))throw new LocalLyricsError('STALE')
    return {resolved:value.resolved,managementCapture:selected.managementCapture}
  }
  function original(scope:dto.LocalLyricsScope):Readonly<LocalLyricsRootCaptureRecord>{
    check();const saved=catalog.privateLyricsRootRead(identity,'original-capture',rootKey(scope));if(!saved||!rootSame(saved.scope,scope))throw new LocalLyricsError('STALE');return saved
  }
  async function sourceRoot(sourceRootId:string):Promise<RootCapability>{
    check();const stored=repository.sources.root(sourceRootId);if(!stored.authorized)throw new LocalLyricsError('STALE')
    const actual=await authorizeSourceDirectory(stored.path);check()
    if(actual.path!==stored.path||actual.dev!==stored.dev||actual.ino!==stored.ino||!actual.authorized||!rootSame(repository.sources.root(sourceRootId),stored))throw new LocalLyricsError('STALE')
    return {...actual,id:stored.id,label:stored.label}
  }
  function sourceLocations(resolved:Readonly<LocalWorkbenchResolvedReadCapture>):{rootId:string;relative:string}[]{
    const names=new Map<string,{rootId:string;relative:string}>()
    for(const member of resolved.group.members){const id=member.fact.summary.asset.sourceRootId,relative=member.fact.relative;names.set(id+'\0'+relative,{rootId:id,relative})}
    const sourceRootId=resolved.group.members[0]?.fact.summary.asset.sourceRootId??resolved.directoryFacts.files[0]?.sourceRootId
    if(!sourceRootId)throw new LocalLyricsError('STALE')
    for(const rejected of resolved.group.rejectedFiles??[])names.set(sourceRootId+'\0'+rejected.relative,{rootId:sourceRootId,relative:rejected.relative})
    return [...names.values()]
  }
  type Publications=ReturnType<LocalCatalogStore['privateLyricsPhysicalPublications']>
  function reconcile(record:Readonly<LocalLyricsRootCaptureRecord>,commandId?:string,allowPending=false){
    check();const resolved=structuredClone(record.resolved),resources=structuredClone(record.resources),pins:LocalLyricsRootPublicationPin[]=[]
    let publications:Publications=[]
    if(commandId!==undefined){
      const saved=catalog.privateLyricsRecord(identity.datasetId,'save',commandId) as LocalLyricsSaveRecord|null
      if(!saved)throw new LocalLyricsError('NOT_FOUND');assertLocalLyricsSaveRecord(saved)
      if(!rootSame(saved.intent.scope,record.scope)||saved.intent.captureFingerprint!==record.fingerprint||saved.discarded)throw new LocalLyricsError('STALE')
      publications=catalog.privateLyricsPhysicalPublications(identity,commandId)
      const ordered=[...publications].sort((a,b)=>(a.publicationSequence??Number.MAX_SAFE_INTEGER)-(b.publicationSequence??Number.MAX_SAFE_INTEGER))
      for(const item of ordered){const r=item.record,b=r.binding
        if(b.originalIntentSha256!==lyricsPhysicalDigest(saved.intent)||b.originalRequestSha256!==lyricsPhysicalDigest(saved.intent.request)||b.groupCaptureSha256!==record.fingerprint
          ||b.commandId!==commandId||b.libraryId!==record.scope.libraryId||b.albumId!==record.scope.albumId||b.captureId!==record.scope.captureId||r.unresolved||r.phase==='UNKNOWN')throw new LocalLyricsError('STALE')
        if(r.phase!=='CLOSED'){
          if(r.phase==='FAILED'&&r.physicalClosed&&r.protectionReleased&&!item.publication)continue
          if(allowPending&&!item.publication)continue
          throw new LocalLyricsError('STALE')
        }
        if(!r.physicalClosed||!r.protectionReleased||!r.result||!['saved','existing'].includes(r.result.state)||r.result.bodySha256!==b.bodySha256||!item.publication||item.publicationSequence===null)throw new LocalLyricsError('STALE')
        const baseline=physicalGroup(record),whole=captureLocalLyricsPhysicalGroup({members:baseline.members,resources:resources.map(v=>v.pin)});if(!rootSame(r.original,whole))throw new LocalLyricsError('STALE')
        const target=r.artifacts.target;if(!target)throw new LocalLyricsError('STALE')
        if(b.kind==='embed'){
          const m=whole.members.find(m=>m.trackId===b.trackId)!,before=whole.resources[m.resourceIndex]!,fact=item.publication.replace,scan=item.publication.scan
          const resource=resources.find(v=>v.rootId===before.rootId&&v.relative===before.relative),frozenFile=resolved.directoryFacts.files.find(v=>v.currentRelative===before.relative)
          if(!resource?.pin||!fact||!scan||!frozenFile||!r.fidelity||r.fidelity.sourceSha256!==before.sha256||r.fidelity.copySha256!==target.sha256
            ||target.rootId!==before.rootId||target.relative!==before.relative||!rootSame(frozenFile.value,JSON.parse(scan.before)))throw new LocalLyricsError('STALE')
          const affected=resolved.group.members.filter(v=>v.fact.summary.asset.id===m.fileId)
          if(!affected.length||affected.some(v=>!rootSame(v.fact.summary.asset,fact.before)))throw new LocalLyricsError('STALE')
          for(const member of affected){member.fact.summary.asset=structuredClone(fact.after);const c=resolved.capture.members.find(c=>c.trackId===member.fact.summary.track.id)!;if(c.assetId===null)throw new LocalLyricsError('STALE');c.fileRevision=fact.after.fileRevision;c.locationRevision=fact.after.locationRevision}
          frozenFile.value=JSON.parse(scan.after) as typeof frozenFile.value;resource.pin=structuredClone(target)
        }else if(item.publication.replace!==null||item.publication.scan!==null)throw new LocalLyricsError('STALE')
        pins.push({operationId:r.operationId,revision:r.revision,ledgerSequence:item.ledgerSequence,publicationSequence:item.publicationSequence,recordSha256:lyricsPhysicalDigest(r),publicationSha256:lyricsPhysicalDigest(item.publication)})
      }
    }
    for(const member of resolved.group.members){const fact=member.fact,track=catalog.track(fact.summary.track.id),locator=catalog.privateAssetLocator(fact.summary.asset.id),root=catalog.root(record.scope.libraryId),metadata=catalog.metadata(track.id)
      const captured=record.resolved.capture.members.find(v=>v.trackId===track.id)!
      if(!rootSame(track,fact.summary.track)||!rootSame(locator.asset,fact.summary.asset)||locator.relative!==fact.relative||root.revision!==captured.rootRevision||root.sourceRootId!==fact.summary.asset.sourceRootId
        ||!repository.sources.root(root.sourceRootId).authorized||lyricsDigest(lyricsCanonical(metadata))!==captured.metadataRevision||!rootSame(metadata.raw,fact.rawMetadata)||!rootSame(metadata.effective,fact.summary.metadata))throw new LocalLyricsError('STALE')
    }
    const directories=[...new Set(resolved.group.directory!==null?[resolved.group.directory]:resolved.group.members.map(m=>rootParent(m.fact.relative)))]
    const facts=repository.localScan.privateWorkbenchDirectoryFacts({expectedRevision:repository.localScan.privateAlbumBrowserRevision(),libraryRootId:record.scope.libraryId,directories,maxFiles:10000,maxBytes:32*1024*1024})
    if(!rootSame(facts.files,resolved.directoryFacts.files)||!rootSame(facts.cues,resolved.directoryFacts.cues)
      ||!rootSame(catalog.privateWorkbenchMetadataProvenance(resolved.group.members.map(m=>m.fact.summary.track.id)),record.resolved.provenance))throw new LocalLyricsError('STALE')
    // 原只读接点同时安装同SQLite连接的扫描事实作者；没有它不能安全提交embed修订。
    for(const file of facts.files){
      const authored=repository.localScan.privateSourceWriteFileState(record.scope.libraryId,file.currentRelative)
      if(!authored||authored.jobId!==file.jobId||!dto.isCollectionId(authored.batchId)||!rootSame(authored.value,file.value)||!rootSame(JSON.parse(authored.data),file.value))throw new LocalLyricsError('STALE')
    }
    check();return {resolved,resources,pins,publications}
  }
  function physicalGroup(record:Readonly<LocalLyricsRootCaptureRecord>){
    if(record.resolved.capture.members.some(m=>m.trackId===null)||record.resources.some(r=>r.pin===null))throw new LocalLyricsError('STALE')
    const resources=record.resources.map(r=>r.pin!),members:LocalLyricsPhysicalMember[]=record.resolved.group.members.map(g=>{
      const c=record.resolved.capture.members.find(c=>c.trackId===g.fact.summary.track.id)!,a=g.fact.summary.asset
      if(c.assetId===null||c.trackId===null)throw new LocalLyricsError('STALE')
      return {trackId:c.trackId,rootId:record.scope.libraryId,sourceRootId:a.sourceRootId,fileId:a.id,rootRevision:c.rootRevision,fileRevision:c.fileRevision,locationRevision:c.locationRevision,metadataRevision:c.metadataRevision,
        resourceIndex:record.resources.findIndex(r=>r.rootId===a.sourceRootId&&r.relative===g.fact.relative)}
    });return captureLocalLyricsPhysicalGroup({members,resources})
  }
  async function readResource(root:RootCapability,relative:string,signal:AbortSignal,expected?:LocalLyricsPhysicalResource|null){
    const commandId=randomUUID(),claimId=randomUUID();let pin:LocalLyricsPhysicalResource|null=null,embedded:dto.LocalLyricsPresence='unknown',lrc:dto.LocalLyricsPresence='unknown'
    await withReadonlySourcePublicationClaims([{root,relative,...(expected?{expectedSignature:expected.signature}:{})}],signal,async(verify,files)=>{
      const file=files[0]!;checkSignal(signal);const info=await file.handle.stat({bigint:true})
      if(info.size<1n||info.size>BigInt(LOCAL_LYRICS_PHYSICAL_LIMITS.sourceBytes))throw new LocalLyricsError('BUDGET')
      const h=createHash('sha256'),chunk=Buffer.allocUnsafe(64*1024);let offset=0
      while(offset<Number(info.size)){checkSignal(signal);const {bytesRead}=await file.handle.read(chunk,0,Math.min(chunk.length,Number(info.size)-offset),offset);if(!bytesRead)throw new LocalLyricsError('STALE');h.update(chunk.subarray(0,bytesRead));offset+=bytesRead}
      await verify();pin={rootId:root.id,relative,sha256:h.digest('hex'),bytes:offset,signature:rootSignature(info),birthtimeNs:String(info.birthtimeNs),permissionMode:String(info.mode&0o7777n),uid:String(info.uid),gid:String(info.gid),dev:String(info.dev),ino:String(info.ino)}
      if(expected&&!rootSame(expected,pin))throw new LocalLyricsError('STALE')
      const resolvedFormat=inspectingFormat.get(root.id+'\0'+relative)
      if(resolvedFormat){const receipt=await options.tags.run({fd:file.handle.fd,commandId,claimId,assertCurrent:async()=>{checkSignal(signal);await verify()}},resolvedFormat,null,signal);await options.tags.join(commandId)
        if(receipt.exitCode!==0||!receipt.pidClosed||!receipt.actorFdsClosed)throw new LocalLyricsError('CLOSED');embedded=typeof receipt.values.LYRICS==='string'&&receipt.values.LYRICS.trim()?'true':'false'}
      const dot=relative.lastIndexOf('.'),sidecar=dot>relative.lastIndexOf('/')?relative.slice(0,dot)+'.lrc':null
      if(sidecar!==null){
        let exists=true;try{const stat=await lstat(path.join(root.path,sidecar),{bigint:true});if(!stat.isFile()||stat.isSymbolicLink())throw new LocalLyricsError('STALE')}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')exists=false;else throw error}
        if(!exists){try{await lstat(path.join(root.path,sidecar));throw new LocalLyricsError('STALE')}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}lrc='false'}
        else await withReadonlySourcePublicationClaims([{root,relative:sidecar}],signal,async(verifyLrc,held)=>{
          const handle=held[0]!.handle,stat=await handle.stat({bigint:true});if(stat.size>BigInt(dto.LOCAL_LYRICS_LIMITS.bodyBytes))throw new LocalLyricsError('BUDGET')
          const raw=Buffer.alloc(Number(stat.size));let at=0;while(at<raw.length){checkSignal(signal);const read=await handle.read(raw,at,raw.length-at,at);if(!read.bytesRead)throw new LocalLyricsError('STALE');at+=read.bytesRead}
          const text=new TextDecoder('utf-8',{fatal:true}).decode(raw);await verifyLrc();lrc=text.trim()?'true':'false'
        })
      }
      await verify();checkSignal(signal)
    },()=>options.tags.join(commandId));return {pin,lrc,embedded}
  }
  // 格式来自原Owner完整scan readFacts，不接受Renderer给出的格式或路径。
  const inspectingFormat=new Map<string,LocalAudioTagFormat|null>()
  async function inspect(resolved:Readonly<LocalWorkbenchResolvedReadCapture>,signal:AbortSignal,expected?:readonly LocalLyricsRootResource[]){
    checkSignal(signal);const resources:LocalLyricsRootResource[]=[],values=new Map<string,{lrc:dto.LocalLyricsPresence;embedded:dto.LocalLyricsPresence}>()
    for(const location of sourceLocations(resolved)){
      const key=location.rootId+'\0'+location.relative,fact=resolved.directoryFacts.files.find(f=>f.currentRelative===location.relative),technical=fact?.value.readFacts?.technical
      inspectingFormat.set(key,rootTagFormat(technical?.container,technical?.codec))
      let observed:{pin:LocalLyricsPhysicalResource|null;lrc:dto.LocalLyricsPresence;embedded:dto.LocalLyricsPresence}={pin:null,lrc:'unknown',embedded:'unknown'}
      try{if(resolved.availability==='online')observed=await readResource(await sourceRoot(location.rootId),location.relative,signal,expected?.find(r=>r.rootId===location.rootId&&r.relative===location.relative)?.pin)}
      catch(error){if(error instanceof SourcePublicationUnverified||signal.aborted||error instanceof LocalLyricsError&&['CLOSED','STALE'].includes(error.code))throw error}
      if(observed.pin&&fact&&observed.pin.signature!==fact.value.signature)throw new LocalLyricsError('STALE')
      resources.push({...location,pin:observed.pin});values.set(key,{lrc:observed.lrc,embedded:observed.embedded})
    }
    const observations=resolved.group.members.map(m=>{const value=values.get(m.fact.summary.asset.sourceRootId+'\0'+m.fact.relative)!;return {trackId:m.fact.summary.track.id,fileRevision:m.fact.summary.asset.fileRevision,...value}})
    checkSignal(signal);return {resources,observations}
  }
  async function observe(capture:Readonly<LocalLyricsCapture>,resolved:Readonly<LocalWorkbenchResolvedReadCapture>){
    const f=await frozen(capture.scope),old=catalog.privateLyricsRootRead(identity,'original-capture',rootKey(capture.scope))
    if(!rootSame(resolved,f.resolved)||old&&(!rootSame(old.resolved,resolved)||old.fingerprint!==capture.fingerprint))throw new LocalLyricsError('STALE')
    originalReferences.set(capture.authorityRef,{resolved,managementCapture:f.managementCapture,fingerprint:capture.fingerprint,scope:structuredClone(capture.scope)})
    // 本阶段仅核原SQL，query不用等Native完成才获得原sessionId。
  }
  async function prepareQuery(capture:Readonly<LocalLyricsCapture>,resolved:Readonly<LocalWorkbenchResolvedReadCapture>,signal:AbortSignal){
    const reference=originalReferences.get(capture.authorityRef)
    if(!reference||capture.epoch!==options.ownerEpoch||reference.fingerprint!==capture.fingerprint||!rootSame(reference.scope,capture.scope)||!rootSame(reference.resolved,resolved))throw new LocalLyricsError('STALE')
    await frozen(capture.scope);checkSignal(signal)
    const old=catalog.privateLyricsRootRead(identity,'original-capture',rootKey(capture.scope)),current=old?reconcile(old):undefined
    const collected=await tracked(capture.scope.libraryId,signal,s=>inspect(current?.resolved??resolved,s,current?.resources));checkSignal(signal)
    if(old)return collected.observations
    const record:LocalLyricsRootCaptureRecord={schema:1,kind:'original-capture',datasetId:identity.datasetId,key:rootKey(capture.scope),revision:1,scope:structuredClone(capture.scope),ownerEpoch:options.ownerEpoch,
      fingerprint:capture.fingerprint,resolved:structuredClone(resolved),managementCapture:reference.managementCapture,resources:collected.resources,observations:collected.observations}
    const existing=catalog.privateLyricsRootRead(identity,'original-capture',record.key)
    if(existing){if(!rootSame(existing.resolved,record.resolved)||!rootSame(existing.resources,record.resources)||existing.fingerprint!==record.fingerprint)throw new LocalLyricsError('STALE')}
    else catalog.privateLyricsRootCompareAndSwap(identity,record,null)
    if(!rootSame(catalog.privateLyricsRootRead(identity,'original-capture',record.key),existing??record))throw new LocalLyricsError('STALE')
    const inventoryKey=lyricsDigest(lyricsCanonical([capture.scope.libraryId,capture.scope.albumId])),prior=catalog.privateLyricsRecord(identity.datasetId,'inventory',inventoryKey) as LocalLyricsInventoryRecord|null
    catalog.privateLyricsCompareAndSwap(identity.datasetId,'inventory',{scope:structuredClone(capture.scope),captureFingerprint:capture.fingerprint,revision:prior?prior.revision+1:0,observations:collected.observations},prior?.revision??null)
    return collected.observations
  }
  function intentFor(commandId:string,scope:dto.LocalLyricsScope){const value=catalog.privateLyricsRecord(identity.datasetId,'save',commandId) as LocalLyricsSaveRecord|null
    if(!value)throw new LocalLyricsError('NOT_FOUND');assertLocalLyricsSaveRecord(value);if(!rootSame(value.intent.scope,scope))throw new LocalLyricsError('STALE');return value}
  async function snapshot(resolved:Readonly<LocalWorkbenchResolvedReadCapture>,commandId:string):Promise<'saved'|'failed'>{
    check();const saved=intentFor(commandId,{datasetId:identity.datasetId,libraryId:resolved.capture.rootId,albumId:resolved.capture.albumId,captureId:(catalog.privateLyricsRecord(identity.datasetId,'save',commandId) as LocalLyricsSaveRecord).intent.scope.captureId}),capture=original(saved.intent.scope)
    const current=reconcile(capture,commandId),old=catalog.privateLyricsRootRead(identity,'save-snapshot',commandId)
    const originalSnapshot={request:structuredClone(saved.intent.request),scope:structuredClone(saved.intent.scope),intentSha256:lyricsPhysicalDigest(saved.intent),captureSha256:saved.intent.captureFingerprint,originalCaptureKey:capture.key}
    if(old&&!rootSame(old.original,originalSnapshot))throw new LocalLyricsError('STALE')
    if(old?.attempts.at(-1)?.phase==='SAVED')return rootSame(old.attempts.at(-1)!.publicationPins,current.pins)?'saved':'failed'
    let previous=old
    if(previous?.attempts.at(-1)?.phase==='PREPARED'){
      const failed:LocalLyricsRootSnapshotRecord={...structuredClone(previous),revision:previous.revision+1,attempts:previous.attempts.map((a,i)=>i===previous!.attempts.length-1?{...a,phase:'FAILED',error:'UNAVAILABLE'}:a)}
      catalog.privateLyricsRootCompareAndSwap(identity,failed,previous.revision);previous=failed
    }
    const attempt=(previous?.attempts.length??0)+1,record:LocalLyricsRootSnapshotRecord={schema:1,kind:'save-snapshot',datasetId:identity.datasetId,key:commandId,revision:(previous?.revision??0)+1,original:originalSnapshot,
      attempts:[...(previous?.attempts??[]),{attempt,phase:'PREPARED',publicationPins:current.pins,observations:null,observationsSha256:null,resources:null,error:null}]}
    catalog.privateLyricsRootCompareAndSwap(identity,record,previous?.revision??null)
    try{
      if(!current.pins.length)throw new LocalLyricsError('STALE')
      const observed=await tracked(capture.scope.libraryId,undefined,signal=>inspect(current.resolved,signal,current.resources));check();const rechecked=reconcile(capture,commandId)
      if(!rootSame(rechecked.pins,current.pins)||observed.resources.some(r=>r.pin===null)||observed.observations.some(r=>r.lrc==='unknown'||r.embedded==='unknown'))throw new LocalLyricsError('STALE')
      const inventoryKey=lyricsDigest(lyricsCanonical([capture.scope.libraryId,capture.scope.albumId])),prior=catalog.privateLyricsRecord(identity.datasetId,'inventory',inventoryKey) as LocalLyricsInventoryRecord|null
      const inventory:LocalLyricsInventoryRecord={scope:structuredClone(capture.scope),captureFingerprint:capture.fingerprint,revision:prior?prior.revision+1:0,observations:observed.observations}
      catalog.privateLyricsCompareAndSwap(identity.datasetId,'inventory',inventory,prior?.revision??null)
      const completed:LocalLyricsRootSnapshotRecord={...record,revision:record.revision+1,attempts:record.attempts.map(a=>a.attempt===attempt?{...a,phase:'SAVED',observations:observed.observations,observationsSha256:localLibraryManagementDigest(observed.observations),resources:observed.resources}:a)}
      catalog.privateLyricsRootCompareAndSwap(identity,completed,record.revision)
      if(!rootSame(catalog.privateLyricsRootRead(identity,'save-snapshot',commandId),completed))throw new LocalLyricsError('STALE');return 'saved'
    }catch(error){
      const actual=catalog.privateLyricsRootRead(identity,'save-snapshot',commandId)
      if(actual&&actual.revision===record.revision){const failed:LocalLyricsRootSnapshotRecord={...record,revision:record.revision+1,attempts:record.attempts.map(a=>a.attempt===attempt?{...a,phase:'FAILED',error:error instanceof LocalLyricsError&&error.code==='STALE'?'CHANGED':'UNAVAILABLE'}:a)}
        catalog.privateLyricsRootCompareAndSwap(identity,failed,record.revision)}
      return 'failed'
    }
  }
  async function coverState(capture:LocalLyricsCapture):Promise<dto.LocalLyricsWriteState>{
    check();const registry=await options.plans();check();const snapshot=registry.inspect(),stored=catalog.privateWorkbenchSnapshot(identity.datasetId)
    if(stored?!rootSame(snapshot,stored):snapshot.revision!==0||snapshot.entries.length!==0)throw new LocalLyricsError('STALE')
    let outcome:dto.LocalLyricsWriteState='not-requested'
    for(const entry of snapshot.entries){if(entry.plan.kind!=='artwork'||!entry.capture.albums.some(a=>a.albumId===capture.scope.albumId&&a.rootId===capture.scope.libraryId))continue
      if(!entry.original){if(entry.capture.albums.some(a=>a.readToken===original(capture.scope).resolved.capture.readToken))return 'pending';continue}
      const receipt=await options.coverWriter.writer.readOriginalReceipt(entry.original);check()
      if(receipt===null||receipt.state==='unknown')return 'unknown';if(receipt.state==='running')return 'pending'
      if(receipt.state==='failed'||receipt.state==='partial')outcome='failed';else if(receipt.state==='cancelled')outcome='cancelled';else if(outcome==='not-requested')outcome='saved'
    }return outcome
  }
  const providers=createLocalLyricsProjectionTransport({identity,ownerEpoch:options.ownerEpoch,projection:options.projection,assertAccepting:check})
  const sourceFiles=createLyricsSourceFilesAuthor({identity,ownerEpoch:options.ownerEpoch,catalog,mainActor:options.mainActor,native:options.native,sourceSafety:options.sourceSafety,joinTaggedWriter:id=>options.tags.join(id),assertAccepting:check,
    async resolveOriginalGroup(binding,intent,signal){checkSignal(signal);const capture=original(intent.scope);if(capture.fingerprint!==intent.captureFingerprint||binding.commandId!==intent.request.commandId)throw new LocalLyricsError('STALE')
      await frozen(intent.scope);const current=reconcile(capture,binding.commandId,true),baseline=physicalGroup(capture),group=captureLocalLyricsPhysicalGroup({members:baseline.members,resources:current.resources.map(r=>r.pin)}),roots:RootCapability[]=[]
      for(const id of new Set(group.resources.map(r=>r.rootId)))roots.push(await sourceRoot(id))
      // 文件完整SHA由真实只读claim核一次，之后SourceFiles持写claim期间只核SQL原链。
      for(const resource of current.resources){if(!resource.pin)throw new LocalLyricsError('STALE');const root=roots.find(r=>r.id===resource.rootId)!;await readResource(root,resource.relative,signal,resource.pin)}
      return {captureSha256:capture.fingerprint,group,roots,assertCurrent(){checkSignal(signal);reconcile(capture,binding.commandId,true)}}
    }})
  const writer=createLocalWorkbenchLyricsWriter({identity,ownerEpoch:options.ownerEpoch,catalog,mainActor:options.mainActor,tags:options.tags,sourceFiles,assertAccepting:check})
  const runtime=createLocalWorkbenchLyricsService({identity,ownerEpoch:options.ownerEpoch,catalog,workbench:options.workbench,library:options.library,providers,writer,assertAccepting:check,
    cover:{async save(c,_id,signal){checkSignal(signal);return coverState(c)},async readOriginal(c){return coverState(c)},async hasPending(c){const state=await coverState(c);return state==='pending'||state==='unknown'||state==='failed'}},
    observeOriginalCapture:observe,prepareQuery,
    async resolveOriginalCapture(scope){const value=await frozen(scope),saved=catalog.privateLyricsRootRead(identity,'original-capture',rootKey(scope));if(saved&&!rootSame(saved.resolved,value.resolved))throw new LocalLyricsError('STALE');return {resolved:value.resolved,...(saved?{fingerprint:saved.fingerprint}:{})}},
    async resolveSavedCapture(scope,commandId){const value=original(scope),saved=intentFor(commandId,scope);if(value.fingerprint!==saved.intent.captureFingerprint)throw new LocalLyricsError('STALE');await frozen(scope);reconcile(value,commandId);return {resolved:value.resolved,fingerprint:value.fingerprint}},
    async assertOriginalCapture(capture,resolved,commandId){const value=catalog.privateLyricsRootRead(identity,'original-capture',rootKey(capture.scope));
      if(!value){const pending=originalReferences.get(capture.authorityRef);if(commandId!==undefined||!pending||pending.fingerprint!==capture.fingerprint||capture.epoch!==options.ownerEpoch||!rootSame(pending.scope,capture.scope)||!rootSame(pending.resolved,resolved))throw new LocalLyricsError('STALE');await frozen(capture.scope);return}
      if(value.fingerprint!==capture.fingerprint||!rootSame(value.resolved,resolved))throw new LocalLyricsError('STALE');await frozen(capture.scope);reconcile(value,commandId)},
    inventoryPhysical:{async inspect(resolved,signal){return (await tracked(resolved.capture.rootId,signal,s=>inspect(resolved,s))).observations},snapshot},
  })
  return {...runtime,
    async removeLibrary(libraryId:string){
      check();retiredLibraries.add(libraryId);const original=catalog.privateLyricsLibraryRecords(identity,libraryId)
      const selected=[...flights.values()].filter(flight=>flight.libraryId===libraryId);for(const flight of selected)flight.controller.abort()
      await runtime.job.revokeLibrary(libraryId,original.jobs.map(job=>job.snapshot.jobId))
      await runtime.service.revokeLibrary(libraryId,original.saves.map(save=>save.intent.request.commandId))
      const quiet=await Promise.allSettled(selected.map(flight=>flight.quiet))
      // 已abort的普通取消可以落失败；未知FD/claims/SourceSafety收口仍拒绝撤绑定。
      for(const result of quiet)if(result.status==='rejected'&&!(result.reason instanceof LocalLyricsError&&result.reason.code==='CLOSED'))throw result.reason
      for(const saved of catalog.privateLyricsLibraryRecords(identity,libraryId).saves){
        const commandId=saved.intent.request.commandId,joined=await Promise.allSettled([sourceFiles.join(commandId),writer.join(commandId)])
        const after=catalog.privateLyricsRecord(identity.datasetId,'save',commandId) as LocalLyricsSaveRecord|null
        if(!after||joined.some(result=>result.status==='rejected')||!after.physicalClosed||['unknown','running'].includes(after.receipt.state)
          ||catalog.privateLyricsPhysicalPublications(identity,commandId).some(value=>value.record.unresolved||!value.record.physicalClosed||!value.record.protectionReleased||!['CLOSED','FAILED'].includes(value.record.phase)))throw new LocalLyricsError('CLOSED')
      }
    },
    async joinOriginalWrite(commandId:string){
      check();if(!dto.isCollectionId(commandId))throw new LocalLyricsError('INVALID')
      const original=catalog.privateLyricsRecord(identity.datasetId,'save',commandId) as LocalLyricsSaveRecord|null
      if(!original)throw new LocalLyricsError('NOT_FOUND');assertLocalLyricsSaveRecord(original)
      const originalSha256=lyricsPhysicalDigest(original.intent)
      // 单轨join不能覆盖后续轨；先等这一个原command实际协调任务，再核两端物理作者。
      await runtime.service.saves.wait(commandId)
      const joined=await Promise.allSettled([sourceFiles.join(commandId),writer.join(commandId)]);check()
      const after=catalog.privateLyricsRecord(identity.datasetId,'save',commandId) as LocalLyricsSaveRecord|null
      if(!after)throw new LocalLyricsError('NOT_FOUND');assertLocalLyricsSaveRecord(after)
      const rows=catalog.privateLyricsPhysicalPublications(identity,commandId)
      if(joined.some(r=>r.status==='rejected')||lyricsPhysicalDigest(after.intent)!==originalSha256||!after.physicalClosed||after.receipt.state==='unknown'
        ||rows.some(v=>v.record.binding.originalIntentSha256!==originalSha256||v.record.unresolved||!['CLOSED','FAILED'].includes(v.record.phase)||!v.record.physicalClosed||!v.record.protectionReleased))throw new LocalLyricsError('CLOSED')
    },
    close(){if(!closePromise){closing=true;for(const flight of flights.values())flight.controller.abort();closePromise=(async()=>{const joined=await Promise.allSettled([...flights.values()].map(f=>f.quiet));await runtime.close();if(joined.some(r=>r.status==='rejected'&&r.reason instanceof SourcePublicationUnverified))throw new LocalLyricsError('CLOSED')})()}return closePromise}}

}
