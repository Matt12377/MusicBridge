import type {MBEditionQueueRequest,MBEditionQueueSnapshot} from '@music-bridge/contracts';
import type {CollectionRepository} from './repository.js';
import {MBQueueStoreError} from './mb-queue-store.js';
/** 同步Owner当前快照：不创建读取票据或文件IO，公开单次200行入口保持原预算。 */
export function materializeMBEdition(repository:Pick<CollectionRepository,'localCatalog'>,request:MBEditionQueueRequest):MBEditionQueueSnapshot{
 const edition=repository.localCatalog.edition(request.editionId);if(edition.revision!==request.expectedRevision)throw new MBQueueStoreError('QUEUE_CONFLICT');
 const links=repository.localCatalog.privateQueueEditionTracks(edition.id);
 const sources=links.map(link=>{const track=repository.localCatalog.track(link.trackId),asset=repository.localCatalog.asset(track.assetId),root=repository.localCatalog.root(asset.libraryRootId);
  return {kind:'local_file' as const,edition:{id:edition.id,revision:edition.revision},snapshot:{sourceKind:'local_file' as const,trackId:track.id,assetId:asset.id,libraryRootId:root.id,sourceRootId:root.sourceRootId,
  rootRevision:root.revision,fileRevision:asset.fileRevision,locationRevision:asset.locationRevision,selectionRevision:track.selectionRevision,segment:track.segment}};});
 return {edition,sources};
}
