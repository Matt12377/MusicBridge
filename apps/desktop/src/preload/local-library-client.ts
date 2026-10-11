import * as dto from '@music-bridge/contracts'
import type {DatasetScope} from './command-outbox-client.js'
const error=()=>new Error('[INVALID_IPC_REQUEST] 本地音乐请求或结果无效。')
/** 同窗口固定dataset；验证发生在structuredClone前，hidden/symbol键不能被序列化抹掉。 */
export function createLocalLibraryClient(invoke:(channel:string,value?:unknown)=>Promise<unknown>,scope:DatasetScope,write:{chooseRoot(commandId:string):Promise<dto.LibraryRoot|null>;confirm(request:dto.LocalRelocationConfirm):Promise<dto.AudioAsset>;relink(request:dto.LocalRootRelink):Promise<dto.LibraryRoot>;override?(request:dto.LocalCatalogCommandPayloads['localCatalog.overrideMetadata']):Promise<dto.LocalMetadataOverride>}):dto.LocalLibraryPublicApi{
 function request<C extends dto.LocalLibraryScanCommand>(command:C,payload:dto.LocalScanCommandPayloads[C]):Promise<dto.LocalScanCommandResults[C]>
 function request<C extends dto.IpcCommand>(command:C,payload:dto.IpcCommandPayloads[C]):Promise<dto.IpcCommandResults[C]>
 async function request(command:dto.IpcCommand,payload:unknown):Promise<unknown>{const datasetId=await scope();if(!dto.validateIpcRequest({version:1,id:'00000000-0000-4000-8000-000000000001',command,payload,expectedDatasetId:datasetId}).ok)throw error();const result=await invoke('localLibrary:request',{datasetId,command,payload:structuredClone(payload)});const checked=dto.validateIpcResponseForCommand({version:1,id:'00000000-0000-4000-8000-000000000001',ok:true,result},command);if(!checked.ok)throw error();return result;}
 return {
  playLocalLibraryTrack:selection=>request('localCatalog.prepare',selection),
  getLocalLibraryPlayReceipt:selection=>request('localCatalog.playReceipt',selection),
  listLocalLibraryRoots:()=>request('localRelocation.roots',{}),
  async chooseLocalLibraryRoot(commandId){if(!dto.isCollectionId(commandId))throw error();const result=await write.chooseRoot(commandId);if(result!==null&&!dto.isLibraryRoot(result))throw error();return result;},
  async chooseLocalRelocationCandidates(selection){if(!dto.isLocalRelocationSelection(selection))throw error();const result=await invoke('localLibrary:chooseCandidates',{datasetId:await scope(),selection:structuredClone(selection)});if(result!==null&&(!dto.isLocalRelocationCandidates(result)||result.assetId!==selection.assetId))throw error();return result;},
  async confirmLocalRelocation(body){if(!dto.isLocalRelocationConfirm(body))throw error();const result=await write.confirm(structuredClone(body));if(!dto.isAudioAsset(result)||result.id!==body.assetId)throw error();return result;},
  async relinkLocalLibraryRoot(body){if(!dto.isLocalRootRelink(body))throw error();const result=await write.relink(structuredClone(body));if(!dto.isLibraryRoot(result)||result.id!==body.rootId)throw error();return result;},
  queryLocalLibraryTracks:query=>request('localCatalog.queryTracks',query),
  getLocalLibraryTrackDetail:trackId=>request('localCatalog.trackDetail',{trackId}),
  getLocalLibraryPlaybackTarget:()=>request('playback.localTarget',{}),
  async overrideLocalLibraryMetadata(body){if(!dto.isLocalCatalogCommandPayload('localCatalog.overrideMetadata',body)||!write.override)throw error();const result=await write.override(structuredClone(body));if(!dto.isLocalCatalogCommandResult('localCatalog.overrideMetadata',result)||result.trackId!==body.trackId)throw error();return result;},
  async localLibraryScan(command,payload){if(!dto.isLocalScanCommand(command)||dto.isLocalScanInternalCommand(command))throw error();return request(command,payload);},
  listLocalLibraryTracks:page=>request('localCatalog.pageTracks',page),getLocalLibraryAsset:assetId=>request('localCatalog.asset',{assetId}),getLocalLibraryMetadata:trackId=>request('localCatalog.metadata',{trackId}),
 }
}
