import assert from 'node:assert/strict';
import type test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RenderAssessment } from '@music-bridge/contracts';
import { preparationFixture } from '../helpers/preparation-fixture.js';
import { createPreparationCoordinator } from '../../src/recording/preparation-coordinator.js';
import { createPreparedCoordinator } from '../../src/recording/prepared-coordinator.js';

function wav(frames:number,rate:number):Buffer {
  const bytes=Buffer.alloc(44+frames*4); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length-8,4); bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16); bytes.writeUInt16LE(1,20); bytes.writeUInt16LE(2,22); bytes.writeUInt32LE(rate,24);
  bytes.writeUInt32LE(rate*4,28); bytes.writeUInt16LE(4,32); bytes.writeUInt16LE(16,34); bytes.write('data',36); bytes.writeUInt32LE(bytes.length-44,40); return bytes;
}
/** 新行为fixture独立维护，不改原Prepared或录音fixture字节。 */
export async function preparedPublicationFixture(t:test.TestContext,hooks:{beforeCommit?:(action:string)=>void;afterFreezeReview?:()=>Promise<void>}={}) {
  const f=await preparationFixture(t,{...(hooks.beforeCommit?{beforeCommit:hooks.beforeCommit}:{})});
  const version=await f.freeze(); await f.versions.idle();
  const {master,layout}=f.repository.preparations.frozen(f.versions.job(version.id).job!.layoutVersionId!);
  const preparation=createPreparationCoordinator({store:f.repository.preparations,sourceStore:f.repository.sources,sources:f.sources});
  const directory=path.join(f.directory,'prepared-target'); await mkdir(directory);
  const destination=await preparation.authorize(randomUUID(),directory);
  const proposal=await preparation.preview({layoutVersionId:layout.id,destinationId:destination.id});
  const job=await preparation.start({commandId:randomUUID(),layoutVersionId:layout.id,destinationId:destination.id,proposalFingerprint:proposal.proposalFingerprint,userConfirmed:true}); await preparation.idle();
  const preparationId=preparation.job(job.id).job!.workspaceId!;
  const prepared=createPreparedCoordinator({store:f.repository.prepared,preparationStore:f.repository.preparations,preparation,sourceStore:f.repository.sources,...(hooks.afterFreezeReview?{afterFreezeReview:hooks.afterFreezeReview}:{})});
  f.registerDependentCleanup(async()=>{await prepared.close();await preparation.close();});
  const selectionIds:string[]=[];
  for(const side of layout.timeline.sides.filter(side=>side.tracks.length)) {
    const file=path.join(f.directory,`raw-${side.name}.wav`); await writeFile(file,wav(side.totalFrames,layout.timeline.sampleRate));
    selectionIds.push((await prepared.select({commandId:randomUUID(),preparationId,side:side.name},file)).id);
  }
  const selection={preparationId,destinationId:destination.id,selectionIds};
  const importProposal=await prepared.previewImport(selection), imported=await prepared.startImport({...selection,commandId:randomUUID(),proposalFingerprint:importProposal.proposalFingerprint,userConfirmed:true}); await prepared.idle();
  const done=prepared.job(imported.id).job!; assert.equal(done.state,'completed');
  const assessment:RenderAssessment={structureChanged:false,acceptVariance:false,varianceReason:'',timeline:{timebase:'sample-frames',sides:layout.timeline.sides.map(side=>{
    const asset=done.assets!.find(asset=>asset.side===side.name)!;
    return {name:side.name,renderAssetId:asset.id,renderFileHash:asset.sha256,sampleRate:layout.timeline.sampleRate,channelLayout:'stereo',totalFrames:asset.totalFrames,
      markers:side.tracks.map(track=>({trackId:track.trackId,exactSourceSha256:master.content.tracks.find(value=>value.trackId===track.trackId)!.source.sha256,actualStartFrame:track.startFrame,actualEndFrame:track.endFrame,actualGapToNextFrames:track.gapAfterFrames,confirmationMethod:'manual',userConfirmed:true}))};
  })}};
  const request={importJobId:imported.id,assessment,daw:'合成 Logic',processingLineage:'合成人工曲序与 Marker 证据。'}, review=await prepared.review(request);
  assert.equal(review.conformance.status,'MATCHED');
  const freeze={...request,commandId:randomUUID(),proposalFingerprint:review.proposalFingerprint,userConfirmed:true as const};
  return {...f,prepared,preparation,imported:done,freeze,owned:f.repository.prepared.job(imported.id)!.owned!};
}
