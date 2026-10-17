import type {MBEditionQueueRequest,MBEditionQueueSnapshot} from '@music-bridge/contracts';
import type {CollectionRepository} from './repository.js';
import {MBQueueStoreError} from './mb-queue-store.js';
import { isDeepStrictEqual } from 'node:util';
import { isLocalPlayRequest, type LocalPlayRequest } from '@music-bridge/contracts';
import type { LocalAlbumOwnerService } from './local-album-browser/owner-port.js';
import { isLocalAlbumQueueSnapshot, type LocalAlbumQueueSnapshot } from './local-album-browser/owner-protocol.js';
/** 同步Owner当前快照：不创建读取票据或文件IO，公开单次200行入口保持原预算。 */
export function materializeMBEdition(repository:Pick<CollectionRepository,'localCatalog'>,request:MBEditionQueueRequest):MBEditionQueueSnapshot{
 const edition=repository.localCatalog.edition(request.editionId);if(edition.revision!==request.expectedRevision)throw new MBQueueStoreError('QUEUE_CONFLICT');
 const links=repository.localCatalog.privateQueueEditionTracks(edition.id);
 const sources=links.map(link=>{const track=repository.localCatalog.track(link.trackId),asset=repository.localCatalog.asset(track.assetId),root=repository.localCatalog.root(asset.libraryRootId);
  return {kind:'local_file' as const,edition:{id:edition.id,revision:edition.revision},snapshot:{sourceKind:'local_file' as const,trackId:track.id,assetId:asset.id,libraryRootId:root.id,sourceRootId:root.sourceRootId,
  rootRevision:root.revision,fileRevision:asset.fileRevision,locationRevision:asset.locationRevision,selectionRevision:track.selectionRevision,segment:track.segment}};});
 return {edition,sources};
}

/** 同一个Owner回核完整显示组；只物化逻辑身份，不为整张专辑预持源票据。 */
export async function materializeLocalAlbumQueue(repository:Pick<CollectionRepository,'localCatalog'|'sources'>,
 albums:Pick<LocalAlbumOwnerService,'inspectAlbum'>,selection:LocalPlayRequest,datasetId:string,expiresAtMs:number,assertCurrent:()=>void):Promise<LocalAlbumQueueSnapshot>{
 if(!isLocalPlayRequest(selection)||!selection.album||selection.action!=='PLAY_NOW'||selection.album.datasetId!==datasetId
  ||!Number.isSafeInteger(expiresAtMs))throw new MBQueueStoreError('QUEUE_CONFLICT');
 const album=selection.album,remaining=Math.min(2000,expiresAtMs-Date.now()),deadlineAtMs=performance.now()+remaining;
 const current=()=>{assertCurrent();if(remaining<=0||performance.now()>=deadlineAtMs)throw new MBQueueStoreError('QUEUE_CONFLICT');};
 current();
 const group=await albums.inspectAlbum({albumKey:album.albumKey,rootId:album.rootId,revision:album.revision});current();
 if(group.summary.id!==album.albumKey||group.summary.rootId!==album.rootId||group.summary.revision!==album.revision
  ||group.summary.kind!==album.kind||group.summary.editionId!==album.editionId||group.summary.trackCount!==album.trackCount
  ||group.members.length!==album.trackCount)throw new MBQueueStoreError('QUEUE_CONFLICT');
 const catalog=repository.localCatalog;
 // 真发行沿原物化器与原link身份取逻辑来源，显示组不冒充另一个跨根组。
 const edition=album.editionId===null?null:catalog.edition(album.editionId);
 const editionSnapshot=edition?materializeMBEdition(repository,{editionId:edition.id,expectedRevision:edition.revision,action:'PLAY_NOW'}):null;
 const links=edition?catalog.privateQueueEditionTracks(edition.id):[],linkPositions=new Map(links.map((link,index)=>[link.id,index]));
 const sources=group.members.map((member,index)=>{
  const facts=member.fact.summary,track=catalog.track(facts.track.id),asset=catalog.asset(track.assetId),root=catalog.root(asset.libraryRootId);
  const source=repository.sources.root(root.sourceRootId);
  if(member.sequence!==index+1||!isDeepStrictEqual(track,facts.track)||!isDeepStrictEqual(asset,facts.asset)
   ||root.id!==album.rootId||asset.rootRevision!==root.revision||asset.sourceRootId!==root.sourceRootId||!source.authorized)throw new MBQueueStoreError('QUEUE_CONFLICT');
  if(editionSnapshot){
   const position=member.editionLink?linkPositions.get(member.editionLink.id):undefined,value=position===undefined?undefined:editionSnapshot.sources[position];
   if(!value||value.snapshot.trackId!==track.id||value.snapshot.assetId!==asset.id)throw new MBQueueStoreError('QUEUE_CONFLICT');
   return value;
  }
  if(member.editionLink!==null)throw new MBQueueStoreError('QUEUE_CONFLICT');
  return {kind:'local_file' as const,edition:null,snapshot:{sourceKind:'local_file' as const,trackId:track.id,assetId:asset.id,
   libraryRootId:root.id,sourceRootId:root.sourceRootId,rootRevision:root.revision,fileRevision:asset.fileRevision,
   locationRevision:asset.locationRevision,selectionRevision:track.selectionRevision,segment:track.segment}};
 });
 const anchors=sources.flatMap((source,index)=>source.snapshot.trackId===selection.local_track_id?[index]:[]);
 // 原页面只有trackId；同一track多次出现时不能猜点击的是哪条link。
 if(anchors.length!==1)throw new MBQueueStoreError('QUEUE_CONFLICT');
 const result={album:structuredClone(album),sources,edition,startIndex:anchors[0]!};
 current();if(!isLocalAlbumQueueSnapshot(result,selection))throw new MBQueueStoreError('QUEUE_CONFLICT');
 return result;
}
