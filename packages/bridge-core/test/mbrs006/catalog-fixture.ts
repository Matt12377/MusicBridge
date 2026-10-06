import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, stat, rm, chmod } from 'node:fs/promises';
import path from 'node:path';
import type { TestContext } from 'node:test';
import type { LocalPlayRequest } from '@music-bridge/contracts';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';
import { createLocalSourceTickets } from '../../src/collection/local-source-tickets.js';
import type { ScanPreparedBatch, ScanReadFacts } from '../../src/collection/local-scan-store.js';
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';
export const parserVersion='music-metadata-11.15.0/mbrs003-v1';
export const readFacts:ScanReadFacts={technical:{container:'WAVE',codec:'PCM',lossless:true,sampleRateHz:48000,channels:2,bitsPerSample:16,durationSeconds:1,evidence:'bounded-parser-reported' as const},coverEvidence:[],readEvidence:{bytesRead:44,readCalls:1,maxReadBytes:44,allocationBytes:44,elapsedMs:1,wholeAudioHash:false as const,wholeAudioDecode:false as const}};
export async function catalogFixture(t:TestContext, beforeCommit?:(action:string)=>void) {
  const storage=buildStoragePolicy(),tmp=storage.check(process.env.TMPDIR!,{mustExist:true}),directory=await mkdtemp(path.join(tmp,'mbrs006-owned-'));await chmod(directory,0o700);
  const media=path.join(directory,'合成媒体');await mkdir(media);const bytes=Buffer.from('MBRS006 owned synthetic bytes, not listening evidence');
  for(const name of ['一.wav','二.wav'])await writeFile(path.join(media,name),bytes,{mode:0o600});
  const repository=createCollectionRepository({filePath:path.join(directory,'collection.sqlite'),...(beforeCommit?{beforeCommit}:{})});
  t.after(async()=>{repository.close();await rm(directory,{recursive:true,force:true});});
  const source=repository.sources.authorize(randomUUID(),await authorizeSourceDirectory(media)),root=repository.localCatalog.registerRoot({commandId:randomUUID(),sourceRootId:source.id,role:'library'}),datasetId=randomUUID(),epoch=randomUUID();
  async function commit(names:string[],rejected=false){
    const started=repository.localScan.start({commandId:randomUUID(),datasetId,libraryRootId:root.id,expectedRootRevision:repository.localCatalog.root(root.id).revision,parserVersion}).job;
    const job=repository.localScan.resume({commandId:randomUUID(),jobId:started.jobId,expectedRevision:started.jobRevision});
    const items=await Promise.all(names.map(async relative=>{const s=await stat(path.join(media,relative),{bigint:true});return {relative,signature:[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':'),parserVersion,outcome:rejected?'rejected' as const:'accepted' as const,fields:rejected?null:{title:relative,artist:'合成作者'},failureCode:rejected?'METADATA_READ_FAILED':null,reused:false,readFacts:rejected?null:readFacts};}));
    const batch:ScanPreparedBatch={batchId:randomUUID(),jobId:job.jobId,expectedJobRevision:job.jobRevision,checkpointBefore:job.checkpointRef,items,frontier:[],completed:true};
    repository.localScan.privatePrepareBatch({commandId:randomUUID(),jobId:job.jobId,batch});
    const request={commandId:randomUUID(),jobId:job.jobId,batchId:batch.batchId,expectedRevision:job.jobRevision};
    return {request,apply:()=>repository.localScan.privateCommitBatch(request)};
  }
  // 标签与readFacts明确受控；生产SQL批事务、scan观察及固定FD读取是真实本体。
  (await commit(['一.wav','二.wav'])).apply();
  const tracks=repository.localCatalog.pageTracks({offset:0,limit:200}).items;
  const requests:LocalPlayRequest[]=tracks.map(track=>({schema_version:'1.2',request_id:randomUUID(),route:'roon_audio_input',source_kind:'local_file',local_track_id:track.id,asset_id:track.assetId,expected_asset_revision:repository.localCatalog.asset(track.assetId).fileRevision,target:{core_id:'synthetic-core',zone_id:'synthetic-zone'},action:'PLAY_NOW'}));
  const tickets=createLocalSourceTickets(repository,epoch,datasetId,()=>repository.list({offset:0,limit:1}));
  return {directory,media,bytes,repository,source,root,tracks,requests,tickets,commit,epoch,datasetId};
}
