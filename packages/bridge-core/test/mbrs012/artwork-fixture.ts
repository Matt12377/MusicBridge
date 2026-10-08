import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import * as dto from '@music-bridge/contracts';
import {owned,type SourceServiceFixture} from './service-fixture.js';

export async function stagedSourceArtwork(f:SourceServiceFixture,file:string,index=0){
  const image=await owned(file),display=await owned('owned-cover-16.jpg');assert.ok(image.entry.mime&&image.entry.width&&image.entry.height);
  const edition=f.repository.localCatalog.createEdition({commandId:randomUUID(),title:'真实源封面自有发行',edition:''}),track=f.tracks[index]!;
  f.repository.localCatalog.linkEditionTrack({commandId:randomUUID(),editionId:edition.id,trackId:track.id,disc:1,trackNumber:1,sequence:1});
  const target=f.repository.localArtwork.context({trackId:track.id,editionId:edition.id}).target;assert.ok(target);
  const original={mime:image.entry.mime,bytes:image.bytes.length,sha256:image.entry.sha256,width:image.entry.width,height:image.entry.height};
  const context=f.repository.localArtwork.stage({target,origin:'manual',sourceIdentity:original.sha256,sourceLabel:'真实自有原件',image:{original,display:{mime:'image/jpeg' as const,bytes:display.bytes.length,sha256:display.entry.sha256,width:16,height:16,dataUrl:`data:image/jpeg;base64,${display.bytes.toString('base64')}`}}});
  const candidate=context.candidates.find(c=>c.original.sha256===original.sha256);assert.ok(candidate);
  return {edition,track,target,original,candidate,bytes:new Uint8Array(image.bytes)};
}

export async function sourceArtwork(f:SourceServiceFixture,file:string,index=0):Promise<dto.LocalSourceWritesArtworkRef>{
  const staged=await stagedSourceArtwork(f,file,index),attached=await f.api.attachOriginal({datasetId:f.datasetId,commandId:randomUUID(),target:staged.target,candidateId:staged.candidate.id,original:staged.original,bytes:staged.bytes},f.actor),selection=f.repository.localArtwork.apply({commandId:randomUUID(),target:staged.target,candidateId:staged.candidate.id,expectedSelectionRevision:null});
  const ref={editionId:staged.edition.id,candidateId:staged.candidate.id,selectionId:selection.id,expectedSelectionRevision:selection.revision,contentRef:attached.contentRef,originalSha256:staged.original.sha256};assert.ok(dto.isLocalSourceWritesIntent({kind:'embedded-cover',target:f.target(index),artwork:ref,slot:'front'}));return ref;
}
