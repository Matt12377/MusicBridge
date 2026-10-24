import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  createMobilePreparationProbe, copyMobilePreparationSnapshot, copyMobileCapabilityTraceSnapshot,
  withMobileCapabilityContext, closeMobileCapabilityContext, mobilePreparationSync, mobileCapabilitySync,
  mobileCapabilityReject, type MobileCapabilityContext, type MobilePreparationProbe,
} from '../../src/mobile/capability-trace.js';

const clock = { now: () => 100, epochNow: () => 1_800_000_000_000 };
function resource() {
  const probe = createMobilePreparationProbe({ enabled: true, ...clock }); probe.arm();
  const context = probe.claim('createResource', randomUUID(), new AbortController().signal); assert.ok(context);
  return { probe, context };
}
function finish(probe: MobilePreparationProbe, context: MobileCapabilityContext) {
  probe.finish(context, { failed: false, finished: true, httpStatus: 201 }); closeMobileCapabilityContext(context);
}

test('M27资源准备512：第192条后的verify后候选与Owner ACK仍真实保留，不补造旧截断', () => {
  const { probe, context } = resource(); let work = 0;
  withMobileCapabilityContext(context, () => {
    for (let i = 0; i < 160; i++) mobilePreparationSync('preparation.auth.envelope', () => { work++; });
    mobilePreparationSync('preparation.playback.candidate', () => { work++; });
    mobilePreparationSync('preparation.playback.owner-save', () => { work++; });
    mobilePreparationSync('preparation.playback.ack', () => { work++; });
  });
  finish(probe, context);
  const snapshot = probe.snapshot(), scope = snapshot.resourceScopes[0]!;
  assert.equal(work, 163); assert.equal(scope.trace.droppedRecords, 0); assert.equal(snapshot.truncated, false);
  assert.ok(scope.trace.records.length > 256 && scope.trace.records.length <= 512);
  for (const stage of ['preparation.playback.candidate', 'preparation.playback.owner-save', 'preparation.playback.ack'] as const) {
    assert.ok(scope.trace.records.some(row => row.stage === stage && row.phase === 'begin'));
    assert.ok(scope.trace.records.some(row => row.stage === stage && row.phase === 'ok'));
  }
  assert.ok(copyMobilePreparationSnapshot(snapshot));
  assert.equal(copyMobileCapabilityTraceSnapshot(scope.trace), null, '普通全局copier仍不得接受超过256条。');
});

test('M27资源准备512：真实溢出计drop并保首business/cleanup/终态，未知字段及凭据仍整份拒绝', () => {
  const { probe, context } = resource(); let calls = 0;
  const denied = Object.assign(new Error('token=合成凭据不得输出'), { name: 'MobileServiceError', code: 'SOURCE_CHANGED' });
  withMobileCapabilityContext(context, () => {
    for (let i = 0; i < 700; i++) mobilePreparationSync('preparation.auth.envelope', () => { calls++; });
    mobileCapabilityReject('preparation.playback.candidate', denied);
    mobileCapabilityReject('preparation.playback.owner-save', denied, 'cleanup');
    mobileCapabilitySync('http.status.409', () => undefined); mobileCapabilitySync('http.send', () => undefined);
  });
  finish(probe, context);
  const snapshot = probe.snapshot(), scope = snapshot.resourceScopes[0]!;
  assert.equal(calls, 700); assert.ok(scope.trace.records.length <= 512); assert.ok(scope.trace.records.length > 192);
  assert.ok(scope.trace.droppedRecords > 0); assert.equal(snapshot.truncated, true);
  assert.equal(scope.trace.firstBusinessFailures[0]?.code, 'SOURCE_CHANGED');
  assert.equal(scope.trace.cleanupFailures[0]?.code, 'SOURCE_CHANGED');
  assert.ok(scope.trace.records.some(row => row.stage === 'preparation.http.terminal' && row.phase === 'ok'));
  const serialized = JSON.stringify({ privateEvidence: { mobilePreparation: snapshot } }, null, 2);
  assert.ok(Buffer.byteLength(serialized) < 4 * 1024 * 1024);
  assert.doesNotMatch(serialized, /合成凭据|token=|message|stack|https?:/u);
  assert.ok(copyMobilePreparationSnapshot(snapshot));
  const excessive = structuredClone(snapshot); excessive.resourceScopes[0]!.trace.records = Array.from({ length: 513 }, () => scope.trace.records[0]!);
  assert.equal(copyMobilePreparationSnapshot(excessive), null);
  const payload = structuredClone(snapshot); Object.assign(payload.resourceScopes[0]!.trace.records[0]!, { accessToken: '合成禁止字段' });
  assert.equal(copyMobilePreparationSnapshot(payload), null);
  let getterCalls = 0;
  const getter = Object.defineProperty({ ...snapshot }, 'resourceScopes', { enumerable: true, get() { getterCalls++; return []; } });
  assert.equal(copyMobilePreparationSnapshot(getter), null); assert.equal(getterCalls, 0);
});

test('M27资源准备512：默认关/未armed无产物，getServer64/session192/getTrack192旧预算不扩大', () => {
  const disabled = createMobilePreparationProbe({ ...clock }); disabled.arm();
  assert.equal(disabled.claim('createResource', randomUUID(), new AbortController().signal), undefined);
  assert.equal(disabled.snapshot().resourceClaims, 0); assert.ok(copyMobilePreparationSnapshot(disabled.snapshot()));
  const unarmed = createMobilePreparationProbe({ enabled: true, ...clock });
  assert.equal(unarmed.claim('createResource', randomUUID(), new AbortController().signal), undefined);
  for (const [operation, maximum] of [['getServer', 64], ['createSession', 192], ['getTrack', 192]] as const) {
    const probe = createMobilePreparationProbe({ enabled: true, ...clock }); probe.arm();
    const context = probe.claim(operation, randomUUID(), new AbortController().signal); assert.ok(context);
    withMobileCapabilityContext(context, () => { for (let i = 0; i < 400; i++) mobilePreparationSync('preparation.auth.envelope', () => undefined); });
    finish(probe, context);
    const snapshot = probe.snapshot(), scope = operation === 'getTrack' ? snapshot.trackScopes[0]! : snapshot.scopes[0]!;
    assert.ok(scope.trace.records.length <= maximum); assert.ok(scope.trace.droppedRecords > 0);
    assert.ok(copyMobilePreparationSnapshot(snapshot));
  }
});
