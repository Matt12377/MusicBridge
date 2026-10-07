import assert from 'node:assert/strict';
import test from 'node:test';
import { recordingAttemptFixture } from '../helpers/recording-attempt-fixture.js';

test('014 活动录音：原Attempt/Execution/Archive闭合投影明确保护，quiet与当前lease未核独立阻断',async t=>{
  const f=await recordingAttemptFixture(t),attempt=await f.attempts.begin(f.beginRequest());
  const projection=f.repository.sourceProtection.snapshot();
  assert.equal(attempt.status,'in-progress');assert.equal(projection.complete,false);
  assert.ok(projection.issues.includes('ACTIVE_RECORDING'));assert.ok(projection.issues.includes('OUTPUT_QUIET_UNVERIFIED'));assert.ok(projection.issues.includes('OUTPUT_RUN_LEASE_STATE_UNKNOWN'));
  for(const kind of ['RECORDING','RECORDING_PLAN','EXECUTION','ARCHIVE'] as const)assert.ok(projection.references.some(reference=>reference.kind===kind),kind);
  assert.equal(f.repository.recordingAttempts.get({attemptId:attempt.id}).attempt?.status,'in-progress');
  assert.equal(f.driverCounts().stops,0);
});
