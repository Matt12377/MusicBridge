import * as dto from '@music-bridge/contracts'
import type { DatasetIdentity } from '../../recording/dataset-identity.js'
import { assertLocalWorkbenchCatalogOwner, type LocalCatalogStore } from '../local-catalog-store.js'
import { LocalWorkbenchPlanError, type LocalWorkbenchProtectedWriter, type LocalWorkbenchPlanCapture } from './types.js'
import type { LocalWorkbenchReadService, LocalWorkbenchResolvedReadCapture, LocalWorkbenchMetadataProvenanceFact } from './read-service.js'
import { localWorkbenchJournalCanonical } from './owner-journal.js'

/** 私有Root组合入口：原catalog实例品牌+原identity及持久plan均为必需，函数存在不代表授权。 */
export interface LocalWorkbenchMBOnlyWriterOptions {
  identity:DatasetIdentity
  catalog:LocalCatalogStore
  read:LocalWorkbenchReadService
  assertAccepting():void
}
export function createLocalWorkbenchMBOnlyWriter(options:LocalWorkbenchMBOnlyWriterOptions){
  assertLocalWorkbenchCatalogOwner(options.catalog,options.identity)
  const originRoutes=options.catalog.privateWorkbenchMBOnlyOriginRoutes(options.identity)
  const origins=new Map<string,object>(),pending=new Map<Promise<unknown>,readonly string[]>(),retiredLibraries=new Set<string>();let closing=false
  function check():void{assertLocalWorkbenchCatalogOwner(options.catalog,options.identity);options.assertAccepting();if(closing)throw new LocalWorkbenchPlanError('CHANGED','工作台作者已关闭，原操作保留。')}
  function tracked<T>(capture:Readonly<LocalWorkbenchPlanCapture>,run:()=>Promise<T>):Promise<T>{
    if(capture.albums.some(album=>retiredLibraries.has(album.rootId)||!options.catalog.privateLibraryManagementRootAvailable(album.rootId)))throw new LocalWorkbenchPlanError('CHANGED','原库作者已撤销。');
    const value=run();pending.set(value,capture.albums.map(album=>album.rootId));void value.finally(()=>pending.delete(value)).catch(()=>{});return value}
  async function resolve(capture:Readonly<LocalWorkbenchPlanCapture>):Promise<Readonly<LocalWorkbenchResolvedReadCapture>[]>{
    check();const values:Readonly<LocalWorkbenchResolvedReadCapture>[]=[]
    for(const album of capture.albums){const value=await options.read.resolveCapture({datasetId:options.identity.datasetId,capture:{albumId:album.albumId,readToken:album.readToken}});check()
      if(value.availability!=='online'||value.datasetId!==capture.datasetId||value.datasetRevision!==capture.datasetRevision||localWorkbenchJournalCanonical(value.capture)!==localWorkbenchJournalCanonical(album))throw new LocalWorkbenchPlanError('CHANGED','原专辑完整捕获或来源已变化。')
      values.push(value)
    }
    return values
  }
  const writer:LocalWorkbenchProtectedWriter={
    revalidate(capture,plan){return tracked(capture,async()=>{check();try{const values=await resolve(capture);options.catalog.privateWorkbenchMBOnlyRevalidate(options.identity,plan,capture,values);return {valid:true} as const}catch{return {valid:false,reason:'原完整捕获、人工锁或MB发行关系已变化，未应用。'} as const}})},
    apply(request,plan,capture){return tracked(capture,async()=>{check();const values=await resolve(capture);check();return options.catalog.privateWorkbenchMBOnlyApply(options.identity,request,plan,capture,values,origins.get(plan.planId)??null)})},
    async readOriginalReceipt(request){assertLocalWorkbenchCatalogOwner(options.catalog,options.identity);return options.catalog.privateWorkbenchMBOnlyReadReceipt(options.identity,request)},
  }
  return {writer,
    /** 仅原Owner names.plan/ai.preview内部调用；绝不映射成公开origin选择payload。 */
    originRoutes:{
      registerHumanNamePlan(planId:string):void{check();origins.set(planId,originRoutes.registerHumanNamePlan(planId))},
      registerAiPreviewPlan(planId:string):void{check();origins.set(planId,originRoutes.registerAiPreviewPlan(planId))},
      registerProviderArtworkPlan(planId:string,remote:dto.LocalArtworkRemoteSource):void{check();origins.set(planId,originRoutes.registerProviderArtworkPlan(planId,remote))},
    },
    readOverrideAuthor(fact:LocalWorkbenchMetadataProvenanceFact){return options.catalog.privateWorkbenchMBOnlyReadOverrideAuthor(options.identity,fact)},
    readNameSources(fact:LocalWorkbenchMetadataProvenanceFact){return options.catalog.privateWorkbenchMBOnlyReadNameSources(options.identity,fact)},
    readAuthorRevision(){return options.catalog.privateWorkbenchMBOnlyAuthorRevision(options.identity)},
    async removeLibrary(libraryId:string):Promise<void>{check();retiredLibraries.add(libraryId);await Promise.allSettled([...pending].filter(([,roots])=>roots.includes(libraryId)).map(([work])=>work))},
    async close():Promise<void>{closing=true;await Promise.allSettled([...pending.keys()]);origins.clear()},
  }
}
export type LocalWorkbenchMBOnlyWriter=ReturnType<typeof createLocalWorkbenchMBOnlyWriter>
