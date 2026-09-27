import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { RecordingPlanVersion } from '@music-bridge/contracts';
import { createRecordingPlanCoordinator } from '../src/recording/plan-coordinator.js';
import type { GateBAdmission } from '../src/recording/gate-b-admission.js';
import { recordingPlanFixture } from './helpers/recording-plan-fixture.js';

function admissionFor(plan: RecordingPlanVersion, generation: string, now: number): GateBAdmission {
  const binding = plan.outputBinding!, format = plan.profileSnapshot.settings.format;
  return { recordSha256: 'b'.repeat(64), helperSha256: 'c'.repeat(64),
    configurationFingerprintSha256: binding.configurationFingerprintSha256,
    endpointId: binding.endpointId, uid: binding.deviceUid, selectionGeneration: generation,
    validUntil: new Date(now + 60_000).toISOString(),
    route: { endpointId: binding.endpointId, uid: binding.deviceUid,
      sampleRate: format.sampleRate, channelCount: format.channelCount, format: format.outputSampleFormat,
      physicalFormat: format.outputSampleFormat, bufferFrames: binding.bufferFrames },
    drainAlgorithmId: binding.drainAlgorithmId,
    drain: { capacityFrames: binding.bufferFrames * 2, tailFrames: binding.bufferFrames,
      minimumZeroCallbacks: 2 } };
}

test('只有当次完整受信记录及八项检查全通过，Preflight才瞬时ready；冻结Plan不改写', async t => {
  const f = await recordingPlanFixture(t), plan = await f.plans.freeze(await f.planRequest());
  const selected = f.fakeDevice.outputSelection!, now = Date.now();
  let trusted: GateBAdmission | null = admissionFor(plan, selected.selectionGeneration, now);
  const plans = createRecordingPlanCoordinator({ store: f.repository.recordingPlans,
    deviceSelection: f.fakeDevice.deviceSelection, gateB: { async verify() { return trusted; } }, now: () => now });
  t.after(() => plans.close());
  const preflight = () => plans.preflight({ planVersionId: plan.id, readId: randomUUID() });
  const ready = await preflight();
  assert.equal(ready.state, 'ready'); assert.equal(ready.gateB, 'VERIFIED'); assert.equal(ready.formalReady, true);
  assert.equal(ready.checks.length, 8); assert.ok(ready.checks.every(check => check.state === 'passed'));
  assert.equal(plan.formalReady, false);
  assert.equal(plans.version({ id: plan.id }).plan?.formalReady, false);
  trusted = null;
  const noRecord = await preflight();
  assert.equal(noRecord.state, 'blocked'); assert.equal(noRecord.gateB, 'NOT_RUN'); assert.equal(noRecord.formalReady, false);
  assert.equal(noRecord.checks.find(check => check.category === 'backend')?.code, 'BACKEND_NOT_CERTIFIED');
  assert.equal(plans.version({ id: plan.id }).plan?.formalReady, false);
});

test('受信核验await后设备代际或配置漂移，不能返回旧ready', async t => {
  const f = await recordingPlanFixture(t), plan = await f.plans.freeze(await f.planRequest());
  const selected = f.fakeDevice.outputSelection!, now = Date.now();
  let admission = admissionFor(plan, selected.selectionGeneration, now);
  let mutate: 'selection' | 'configuration' = 'selection';
  const plans = createRecordingPlanCoordinator({ store: f.repository.recordingPlans,
    deviceSelection: f.fakeDevice.deviceSelection, gateB: { async verify() {
      if (mutate === 'selection') f.fakeDevice.reselect(); else f.fakeDevice.drift();
      return admission;
    } }, now: () => now });
  t.after(() => plans.close());
  const moved = await plans.preflight({ planVersionId: plan.id, readId: randomUUID() });
  assert.equal(moved.state, 'blocked'); assert.equal(moved.gateB, 'NOT_RUN');
  assert.equal(moved.checks.find(check => check.category === 'backend')?.code, 'OUTPUT_SELECTION_CHANGED');
  mutate = 'configuration';
  admission = admissionFor(plan, f.fakeDevice.outputSelection!.selectionGeneration, now);
  const drifted = await plans.preflight({ planVersionId: plan.id, readId: randomUUID() });
  assert.equal(drifted.state, 'blocked'); assert.equal(drifted.gateB, 'NOT_RUN');
  assert.equal(drifted.checks.find(check => check.category === 'backend')?.code, 'OUTPUT_IDENTITY_CHANGED');
  assert.equal(plans.version({ id: plan.id }).plan?.formalReady, false);
});

test('认证有效期届满或不可用，Preflight保持blocked且绝不继承历史ready', async t => {
  const f = await recordingPlanFixture(t), plan = await f.plans.freeze(await f.planRequest());
  const selected = f.fakeDevice.outputSelection!; let now = Date.now();
  const admission = admissionFor(plan, selected.selectionGeneration, now);
  const plans = createRecordingPlanCoordinator({ store: f.repository.recordingPlans,
    deviceSelection: f.fakeDevice.deviceSelection, gateB: { async verify() { return admission; } }, now: () => now });
  t.after(() => plans.close());
  assert.equal((await plans.preflight({ planVersionId: plan.id, readId: randomUUID() })).state, 'ready');
  now = Date.parse(admission.validUntil);
  const expired = await plans.preflight({ planVersionId: plan.id, readId: randomUUID() });
  assert.equal(expired.state, 'blocked'); assert.equal(expired.gateB, 'NOT_RUN');
  assert.equal(expired.checks.find(check => check.category === 'backend')?.code, 'BACKEND_NOT_CERTIFIED');
});
