import type test from 'node:test';
import { randomUUID } from 'node:crypto';
import { recordingAttemptFixture } from './recording-attempt-fixture.js';

/** 复用真实冻结Plan/音频/归档，仅输出驱动由私有合成provider提供。 */
export async function recordingRecordFixture(t: test.TestContext, format: 'cassette' | 'dat' = 'cassette') {
  const f = await recordingAttemptFixture(t, format);
  async function readyForFinal() {
    let attempt = await f.attempts.begin(f.beginRequest());
    for (let i = 0; i < attempt.sides.length; ++i) {
      if (i) {
        attempt = await f.attempts.confirm({ commandId: randomUUID(), attemptId: attempt.id, expectedRevision: attempt.revision, kind: 'flip', userConfirmed: true });
        attempt = await f.attempts.beginSide({ commandId: randomUUID(), attemptId: attempt.id, expectedRevision: attempt.revision, side: 'B', userConfirmed: true });
      }
      const driver = f.starts[i]!, side = attempt.sides[i]!, identity = { side: side.side, runId: driver.runId, at: new Date().toISOString() };
      driver.onEvent({ ...identity, type: 'progress', sourceFramesRead: side.frameCount, submittedFrames: side.frameCount, consumedFrames: side.frameCount });
      driver.onEvent({ ...identity, type: 'source-eof' }); driver.onEvent({ ...identity, type: 'engine-cutoff' }); driver.onEvent({ ...identity, type: 'cleanup-quiescent' }); driver.onEvent({ ...identity, type: 'backend-drained' });
      await new Promise<void>(resolve => setImmediate(resolve));
      attempt = f.attempts.get({ attemptId: attempt.id }).attempt!;
      attempt = await f.attempts.confirm({ commandId: randomUUID(), attemptId: attempt.id, expectedRevision: attempt.revision, kind: 'physical-stop', side: side.side, userConfirmed: true });
    }
    attempt = await f.attempts.confirm({ commandId: randomUUID(), attemptId: attempt.id, expectedRevision: attempt.revision, kind: 'physical-recording', userConfirmed: true });
    return { attempt, request: { commandId: randomUUID(), attemptId: attempt.id, expectedRevision: attempt.revision, kind: 'final-verification' as const, userConfirmed: true as const } };
  }
  return { ...f, readyForFinal };
}

/** 明确新规划重新走M/L、执行音频、归档和Plan冻结，不伪造SQLite计划。 */
export async function freezeRerecordPlan(f:Awaited<ReturnType<typeof recordingRecordFixture>>,mediaPlanId:string) {
  const proposal=await f.versions.preview({planId:mediaPlanId,sampleRate:96000});
  const version=await f.versions.freeze({commandId:randomUUID(),planId:mediaPlanId,sampleRate:96000,proposalFingerprint:proposal.proposalFingerprint,userConfirmed:true});await f.versions.idle();
  const layoutVersionId=f.versions.job(version.id).job!.layoutVersionId!;
  const selection={layoutVersionId,destinationId:f.selection.destinationId,mode:'direct' as const,sessionRevision:f.session.revision};
  const executionPreview=await f.execution.preview({...selection,readId:randomUUID()});
  const execution=await f.execution.start({...selection,commandId:randomUUID(),proposalFingerprint:executionPreview.proposalFingerprint,userConfirmed:true});await f.execution.idle();
  const archiveSelection={rootId:f.archiveRequest.rootId,assetId:execution.id,sourcePolicy:'preserve-exact-sources' as const};
  const archivePreview=await f.archive.preview({...archiveSelection,readId:randomUUID()});
  const archiveRequest={...archiveSelection,commandId:randomUUID(),proposalFingerprint:archivePreview.proposalFingerprint,userConfirmed:true as const};
  await f.archive.start(archiveRequest);await f.archive.idle();
  const planSelection={assetId:execution.id,archiveOperationId:archiveRequest.commandId};
  const preview=await f.plans.preview({selection:planSelection,readId:randomUUID()});
  return f.plans.freeze({commandId:randomUUID(),selection:planSelection,proposalFingerprint:preview.proposalFingerprint,userConfirmed:true});
}
