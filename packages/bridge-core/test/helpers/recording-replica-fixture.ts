import type test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { RecordingPlanVersion } from '@music-bridge/contracts';
import type { CollectionRepository } from '../../src/collection/repository.js';
import { createRecordingAttemptCoordinator, type RecordingAttemptDriverRequest } from '../../src/recording/attempt-coordinator.js';
import { createRecordingPlanCoordinator } from '../../src/recording/plan-coordinator.js';
import { createArchiveCoordinator } from '../../src/recording/archive-coordinator.js';
import { preparedExecutionFixture } from './prepared-execution-fixture.js';
import { conversionFixture } from './conversion-fixture.js';
import { recordingProfileContent } from './recording-profile-fixture.js';

/** 真实Plan/归档和正常Attempt事务；仅输出提供者为构造器注入的合成驱动。 */
export async function completeReplicaPlan(t:test.TestContext,repository:CollectionRepository,plan:RecordingPlanVersion) {
  const starts:RecordingAttemptDriverRequest[]=[];
  const attempts=createRecordingAttemptCoordinator({store:repository.recordingAttempts,admissionProvider:{async authorize(){},async start(request){starts.push(request);return{async stop(){},async close(){}};}}});t.after(()=>attempts.close());
  let attempt=await attempts.begin({commandId:randomUUID(),planVersionId:plan.id,planContentHash:plan.contentHash,userConfirmed:true});
  for(let i=0;i<attempt.sides.length;++i){
    if(i){attempt=await attempts.confirm({commandId:randomUUID(),attemptId:attempt.id,expectedRevision:attempt.revision,kind:'flip',userConfirmed:true});attempt=await attempts.beginSide({commandId:randomUUID(),attemptId:attempt.id,expectedRevision:attempt.revision,side:'B',userConfirmed:true});}
    const driver=starts[i]!,side=attempt.sides[i]!,identity={side:side.side,runId:driver.runId,at:new Date().toISOString()};
    driver.onEvent({...identity,type:'progress',sourceFramesRead:side.frameCount,submittedFrames:side.frameCount,consumedFrames:side.frameCount});
    for(const type of ['source-eof','engine-cutoff','cleanup-quiescent','backend-drained'] as const)driver.onEvent({...identity,type});
    await new Promise<void>(r=>setImmediate(r));attempt=attempts.get({attemptId:attempt.id}).attempt!;
    attempt=await attempts.confirm({commandId:randomUUID(),attemptId:attempt.id,expectedRevision:attempt.revision,kind:'physical-stop',side:side.side,userConfirmed:true});
  }
  attempt=await attempts.confirm({commandId:randomUUID(),attemptId:attempt.id,expectedRevision:attempt.revision,kind:'physical-recording',userConfirmed:true});
  await attempts.confirm({commandId:randomUUID(),attemptId:attempt.id,expectedRevision:attempt.revision,kind:'final-verification',userConfirmed:true});
  return repository.recordingRecords.read(db=>String(db.prepare('SELECT id FROM recording_records WHERE attempt_id=?').get(attempt.id)!.id));
}
export async function preparedReplicaFixture(t:test.TestContext,mode:'prepared-reference'|'prepared-derivative') {
  const f=await preparedExecutionFixture(t,{converter:conversionFixture(),emptyB:true});let revision=f.selection.sessionRevision;
  if(mode==='prepared-derivative'){
    const content=recordingProfileContent(48000);content.executionFormat={...content.executionFormat,internalProcessingPrecision:'float64',outputSampleFormat:'pcm-s24le',resamplerImplementation:'ffmpeg-swr',resamplerVersion:'6.3.102'};
    const profile=f.repository.recordingProfiles.save({commandId:randomUUID(),content,userConfirmed:true});
    revision=f.repository.recordingProfiles.saveSession({commandId:randomUUID(),draftId:f.draft.draftId,expectedRevision:revision,profileVersionId:profile.id,overrides:{},userConfirmed:true}).revision;
  }
  const selection={...f.selection,mode,sessionRevision:revision},preview=await f.execution.preview({...selection,readId:randomUUID()});
  const job=await f.execution.start({...selection,commandId:randomUUID(),proposalFingerprint:preview.proposalFingerprint,userConfirmed:true});await f.execution.idle();
  const archive=createArchiveCoordinator({store:f.repository.archive,executionStore:f.repository.execution,preparationStore:f.repository.preparations,sourceStore:f.repository.sources,sources:f.sources,preparation:f.preparation});t.after(()=>archive.close());
  const parent=path.join(f.directory,'Replica归档');await mkdir(parent);const candidate=await archive.authorize(randomUUID(),parent);await archive.initialize({commandId:randomUUID(),id:candidate.id,userConfirmed:true});
  const archiveSelection={assetId:job.id,rootId:candidate.id,sourcePolicy:'reference-dependent' as const},p=await archive.preview({...archiveSelection,readId:randomUUID()});
  const archived=await archive.start({...archiveSelection,commandId:randomUUID(),proposalFingerprint:p.proposalFingerprint,userConfirmed:true});await archive.idle();
  const plans=createRecordingPlanCoordinator({store:f.repository.recordingPlans});t.after(()=>plans.close());
  const planSelection={assetId:job.id,archiveOperationId:archived.id},proposal=await plans.preview({selection:planSelection,readId:randomUUID()});
  const plan=await plans.freeze({commandId:randomUUID(),selection:planSelection,proposalFingerprint:proposal.proposalFingerprint,userConfirmed:true});
  const recordingId=await completeReplicaPlan(t,f.repository,plan);
  return{...f,archive,plan,recordingId,root:f.repository.archive.root(candidate.id)};
}
