import { isMBQueueEditRequest, isMBQueuePlayEntryRequest, isMBEditionQueueRequest, validateIpcResponseForCommand, type MBQueuePublicApi, type PlaybackSnapshot, type IpcCommand } from '@music-bridge/contracts';
export function createMBQueueClient(invoke:(channel:string,payload:unknown)=>Promise<unknown>):MBQueuePublicApi {
 async function call(channel:string,command:IpcCommand,payload:unknown,guard:(value:unknown)=>boolean):Promise<PlaybackSnapshot>{
  if(!guard(payload))throw new Error('队列请求包含未知身份或私有字段。');
  const value=await invoke(channel,structuredClone(payload));
  if(!validateIpcResponseForCommand({version:1,id:'mb-queue',ok:true,result:value},command).ok)throw new Error('队列回执无效。');
  return value as PlaybackSnapshot;
 }
 return {editPlaybackQueue:request=>call('playback:edit-queue','playback.editQueue',request,isMBQueueEditRequest),
 playQueueEntry:request=>call('playback:play-queue-entry','playback.playQueueEntry',request,isMBQueuePlayEntryRequest),
 queueLocalEdition:request=>call('playback:queue-local-edition','playback.queueLocalEdition',request,isMBEditionQueueRequest)};
}
