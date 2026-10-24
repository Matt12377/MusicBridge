import { logLibraryOperation } from '../shared/library-operation-log.js';
import type {MBEditionQueueRequest,MBEditionQueueSnapshot} from '@music-bridge/contracts';
import type {CollectionRepository} from './repository.js';
import {MBQueueStoreError} from './mb-queue-store.js';
import { isDeepStrictEqual } from 'node:util';
import { isLocalPlayRequest, isLocalArtistTrackItem, MAX_MB_QUEUE_ENTRIES, type LocalPlayRequest } from '@music-bridge/contracts';
import type { LocalAlbumOwnerService } from './local-album-browser/owner-port.js';
import { isLocalAlbumQueueSnapshot, isLocalArtistSearchQueueSnapshot, type LocalAlbumQueueSnapshot, type LocalArtistSearchQueueSnapshot } from './local-album-browser/owner-protocol.js';
import type { LocalArtistSearchService } from './local-artist-search.js';
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
 const materializeStarted=performance.now();
 let deadlineStage:'ENTRY'|'AFTER_INSPECT'|'AFTER_FACTS'='ENTRY';
 const current=()=>{assertCurrent();if(remaining<=0||performance.now()>=deadlineAtMs){
  logLibraryOperation('cache','albums.queue-materialize.deadline','error',{code:'QUEUE_EXPIRED_'+deadlineStage,elapsedMs:performance.now()-materializeStarted});
  throw new MBQueueStoreError('QUEUE_CONFLICT');
 }};
 function measured<T>(read:()=>T):T{
  const started=performance.now();
  try{const value=read();logLibraryOperation('cache','albums.queue-materialize.phase','complete',{code:'FACTS',elapsedMs:performance.now()-started});return value;}
  catch(error){logLibraryOperation('cache','albums.queue-materialize.phase','error',{code:'FACTS_FAILED',elapsedMs:performance.now()-started});throw error;}
 }
 current();
 const inspectStarted=performance.now();
 let group:Awaited<ReturnType<typeof albums.inspectAlbum>>;
 try{group=await albums.inspectAlbum({albumKey:album.albumKey,rootId:album.rootId,revision:album.revision});
  logLibraryOperation('cache','albums.queue-materialize.phase','complete',{code:'INSPECT',elapsedMs:performance.now()-inspectStarted});
 }catch(error){logLibraryOperation('cache','albums.queue-materialize.phase','error',{code:'INSPECT_FAILED',elapsedMs:performance.now()-inspectStarted});throw error;}
 deadlineStage='AFTER_INSPECT';current();
 if(group.summary.id!==album.albumKey||group.summary.rootId!==album.rootId||group.summary.revision!==album.revision
  ||group.summary.kind!==album.kind||group.summary.editionId!==album.editionId||group.summary.trackCount!==album.trackCount
  ||group.members.length!==album.trackCount)throw new MBQueueStoreError('QUEUE_CONFLICT');
 const catalog=repository.localCatalog;
 // 真发行沿原物化器与原link身份取逻辑来源，显示组不冒充另一个跨根组。
 const edition=album.editionId===null?null:catalog.edition(album.editionId);
 const editionSnapshot=edition?materializeMBEdition(repository,{editionId:edition.id,expectedRevision:edition.revision,action:'PLAY_NOW'}):null;
 const links=edition?catalog.privateQueueEditionTracks(edition.id):[],linkPositions=new Map(links.map((link,index)=>[link.id,index]));
 const sources=measured(()=>group.members.map((member,index)=>{
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
 }));
 const anchors=sources.flatMap((source,index)=>source.snapshot.trackId===selection.local_track_id?[index]:[]);
 // 原页面只有trackId；同一track多次出现时不能猜点击的是哪条link。
 if(anchors.length!==1)throw new MBQueueStoreError('QUEUE_CONFLICT');
 const result={album:structuredClone(album),sources,edition,startIndex:anchors[0]!};
 deadlineStage='AFTER_FACTS';current();if(!isLocalAlbumQueueSnapshot(result,selection))throw new MBQueueStoreError('QUEUE_CONFLICT');
 logLibraryOperation('cache','albums.queue-materialize','complete',{elapsedMs:performance.now()-materializeStarted,count:sources.length});
 return result;
}

/** 原服务端分页的完整本地上下文；不接收前端成员、不拼其它来源、不提前获取Source票据。 */
export async function materializeLocalSearchQueue(repository: Pick<CollectionRepository, 'localCatalog' | 'sources'>,
 artists: Pick<LocalArtistSearchService, 'queryArtistTracks' | 'querySearchTracks' | 'revision'>,
 selection: LocalPlayRequest, expiresAtMs: number, assertCurrent: () => void): Promise<LocalArtistSearchQueueSnapshot> {
 if (!isLocalPlayRequest(selection) || !selection.context || selection.action !== 'PLAY_NOW' || !Number.isSafeInteger(expiresAtMs)) throw new MBQueueStoreError('QUEUE_CONFLICT');
 const context = selection.context, sources: LocalArtistSearchQueueSnapshot['sources'][number][] = [], seen = new Set<string>();
 let total: number | null = null;
 const current = () => { assertCurrent(); if (Date.now() >= expiresAtMs) throw new MBQueueStoreError('QUEUE_CONFLICT'); };
 for (let offset = 0; ; offset += 200) {
  current();
  const page = context.kind === 'artist'
   ? await artists.queryArtistTracks({ artistId: context.artistId, offset, limit: 200 })
   : await artists.querySearchTracks({ query: context.query, offset, limit: 200 });
  current();
  if (page.revision !== context.revision || total !== null && total !== page.total) throw new MBQueueStoreError('QUEUE_CONFLICT');
  if (page.total < 1 || page.total > MAX_MB_QUEUE_ENTRIES) throw new MBQueueStoreError('QUEUE_INVALID');
  total = page.total;
  if (page.items.length !== Math.min(200, Math.max(0, total - offset))) throw new MBQueueStoreError('QUEUE_CONFLICT');
  for (const facts of page.items) {
   if (!isLocalArtistTrackItem(facts) || seen.has(facts.track.id)) throw new MBQueueStoreError('QUEUE_CONFLICT');
   const track = repository.localCatalog.track(facts.track.id), asset = repository.localCatalog.asset(track.assetId), root = repository.localCatalog.root(asset.libraryRootId);
   const source = repository.sources.root(root.sourceRootId);
   if (!isDeepStrictEqual(track, facts.track) || !isDeepStrictEqual(asset, facts.asset) || facts.rootId !== root.id
    || asset.rootRevision !== root.revision || asset.sourceRootId !== root.sourceRootId || root.role !== 'library' || !source.authorized) throw new MBQueueStoreError('QUEUE_CONFLICT');
   seen.add(track.id);
   sources.push({ kind: 'local_file', edition: null, snapshot: { sourceKind: 'local_file', trackId: track.id, assetId: asset.id,
    libraryRootId: root.id, sourceRootId: root.sourceRootId, rootRevision: root.revision, fileRevision: asset.fileRevision,
    locationRevision: asset.locationRevision, selectionRevision: track.selectionRevision, segment: track.segment } });
  }
  if (offset + page.items.length >= total) break;
 }
 current(); if (await artists.revision() !== context.revision) throw new MBQueueStoreError('QUEUE_CONFLICT'); current();
 const indexes = sources.flatMap((source, index) => source.snapshot.trackId === selection.local_track_id ? [index] : []);
 if (indexes.length !== 1 || sources.length !== total) throw new MBQueueStoreError('QUEUE_CONFLICT');
 const result: LocalArtistSearchQueueSnapshot = { context: structuredClone(context), sources, edition: null, startIndex: indexes[0]! };
 if (!isLocalArtistSearchQueueSnapshot(result, selection)) throw new MBQueueStoreError('QUEUE_CONFLICT'); return result;
}
