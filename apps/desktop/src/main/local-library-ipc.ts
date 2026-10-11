import {randomUUID} from 'node:crypto'
import * as dto from '@music-bridge/contracts'
import {CoreIpcError,type CoreSupervisor} from './core-supervisor.js'
import type {CommandOutboxPickOptions} from './command-outbox-executor.js'
const ordinary=['localCatalog.prepare','localCatalog.playReceipt','playback.localTarget','localRelocation.roots','localCatalog.queryTracks','localCatalog.trackDetail','localCatalog.pageTracks','localCatalog.asset','localCatalog.metadata','localScan.start','localScan.pause','localScan.resume','localScan.cancel','localScan.get','localScan.page','localScan.receipt'] as const
const record=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v))
const closed=(v:Record<string,unknown>,names:readonly string[])=>Reflect.ownKeys(v).length===names.length&&Reflect.ownKeys(v).every(k=>typeof k==='string'&&names.includes(k)&&Object.prototype.propertyIsEnumerable.call(v,k))
/** 原生picker保留Main路径边界，普通channel仅固定本地点播与扫描闭集，不提供批执行或通用Core转发。 */
export function installLocalLibraryHandlers<E>(options:{handle(channel:string,handler:(event:E,value?:unknown)=>unknown):void;requireTrusted(event:E):void;supervisor:Pick<CoreSupervisor,'request'|'requestInternal'>;pick(options:CommandOutboxPickOptions):Promise<{canceled:boolean;filePaths:string[]}>}):void{
 options.handle('localLibrary:request',async(event,value)=>{
  options.requireTrusted(event)
  if(!record(value)||!closed(value,['datasetId','command','payload'])||!dto.isCommandOutboxDatasetId(value.datasetId)||typeof value.command!=='string'||!(ordinary as readonly string[]).includes(value.command))throw new Error('[INVALID_IPC_REQUEST] 本地音乐查询或扫描请求无效。')
  const request=dto.validateIpcRequest({version:1,id:randomUUID(),command:value.command,payload:value.payload,expectedDatasetId:value.datasetId})
  if(!request.ok)throw new Error('[INVALID_IPC_REQUEST] 本地音乐逻辑请求无效。')
  try{return await options.supervisor.request(request.value.command,request.value.payload as dto.IpcCommandPayloads[typeof request.value.command],value.datasetId)}catch(error){
    if(error instanceof CoreIpcError){
      if(error.code==='INVENTORY_CONFLICT' || error.code==='OUTBOX_SCOPE_MISMATCH')throw new Error('[INVENTORY_CONFLICT] 当前任务或音乐库状态已改变，请刷新后重新核对。');
      if((value.command==='localCatalog.prepare' || value.command==='localCatalog.playReceipt') && ['INVALID_IPC_REQUEST','ROON_ZONE_NOT_SELECTED','ROON_CORE_NOT_CONNECTED'].includes(error.code))throw new Error('[LOCAL_PLAY_REJECTED] 原点播请求未受理，请核对曲目与 Roon 播放目标。');
    }
    throw new Error('[INVENTORY_UNAVAILABLE] 操作未获确认；现有音乐库保留，请查看任务与未确认操作。');
  }
 })
 options.handle('localLibrary:chooseCandidates',async(event,value)=>{
  options.requireTrusted(event)
  if(!record(value)||!closed(value,['datasetId','selection'])||!dto.isCommandOutboxDatasetId(value.datasetId)||!dto.isLocalRelocationSelection(value.selection))throw new Error('[INVALID_IPC_REQUEST] 本地重定位逻辑选择无效。')
  try {
  const {datasetId,selection}=value
  const context=await options.supervisor.request('commandOutbox.context',{});if(context.datasetId!==datasetId)throw new Error('[OUTBOX_SCOPE_MISMATCH] 当前工作库已改变。')
  const asset=await options.supervisor.request('localCatalog.asset',{assetId:selection.assetId},datasetId),root=await options.supervisor.request('localCatalog.root',{rootId:asset.libraryRootId},datasetId)
  const source=await options.supervisor.requestInternal('recordingSources.context',{id:root.sourceRootId},datasetId)
  const picked=await options.pick({title:'选择外部改名后的文件候选',message:'只读取已授权源目录。多个候选不会自动合并；返回后逐项明确确认。',defaultPath:source.absolutePath,properties:['openFile','multiSelections'],filters:[{name:'音频候选',extensions:['wav','wave','flac','mp3','m4a','mp4','aac','aiff','aif']}]})
  if(picked.canceled||picked.filePaths.length===0)return null
  return await options.supervisor.requestInternal('localRelocation.capture',{...selection,absolutePaths:picked.filePaths},datasetId)
  } catch {throw new Error('[INVENTORY_UNAVAILABLE] 候选尚未确认，请核对源目录和当前工作库。')}
 })
}
