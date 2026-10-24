import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  MOBILE_CAPABILITY_TRACE_PREFIX, closeMobileCapabilityContext, copyMobileCapabilityTraceRecord,
  copyMobilePreparationSnapshot, createMobileCapabilityContext, createMobilePreparationProbe,
  mobileCapabilitySync, withMobileCapabilityContext,
} from '../../src/mobile/capability-trace.js';
import { createMobileResourceCapacityProbe, mobileResourceCapacityFailure, type MobileResourceCapacityStage } from '../../src/mobile/resource-capacity-trace.js';
import { createMobilePrivateContentTraceRelay } from '../../src/mobile/private-content-trace-relay.js';

const rejection = () => Object.assign(new Error('不得输出素材、URL或凭据'), { code: 'RESOURCE_BUSY', status: 429 });
const rows = (lines: string[]) => lines.map(line => copyMobileCapabilityTraceRecord(JSON.parse(line.slice(MOBILE_CAPABILITY_TRACE_PREFIX.length))));

test('Core准确容量首拒通过原relay保留槽，普通2048行和通用128首错耗尽也不丢首拒', () => {
  const input: string[] = [], output: string[] = [], probe = createMobileResourceCapacityProbe({ enabled: true, sink: line => input.push(line) });
  const context = probe.claim(randomUUID(), 'core', 'content'); assert.ok(context);
  assert.throws(() => withMobileCapabilityContext(context, () => mobileResourceCapacityFailure('capacity.core.stored-bindings-full', () => { throw rejection(); })));
  const record = rows(input)[0]; assert.ok(record);
  const relay = createMobilePrivateContentTraceRelay({ enabled: true, sink: line => output.push(line) });
  for (let index = 0; index < 2048; index++) relay.capability({ ...record, stage: 'main.current', phase: 'ok', code: 'OK' });
  for (let index = 0; index < 128; index++) relay.capability({ ...record, stage: 'core.rpc.failure', requestSha256: String(index).padStart(64, 'a') });
  relay.capability(record);
  assert.equal(output.length, 2177); assert.equal(rows(output).at(-1)?.stage, 'capacity.core.stored-bindings-full');
  for (let index = 0; index < 128; index++) relay.capability({ ...record, requestSha256: String(index).padStart(64, 'b') });
  assert.equal(output.length, 2304, '独立容量首拒自身也不得突破128条');
  closeMobileCapabilityContext(context);
});

test('容量旁注默认关闭，有无诊断均只执行一次且抛同一原错误对象', () => {
  for (const enabled of [false, true]) {
    const lines: string[] = [], probe = createMobileResourceCapacityProbe({ enabled, sink: line => lines.push(line) });
    const context = probe.claim(randomUUID(), 'main', 'http'), error = rejection(); let calls = 0;
    assert.equal(context !== undefined, enabled);
    assert.throws(() => withMobileCapabilityContext(context, () => mobileResourceCapacityFailure('capacity.actor.receipts-full', () => {
      calls++; throw error;
    })), value => value === error);
    assert.equal(calls, 1); assert.equal(lines.length, enabled ? 1 : 0);
    if (enabled) { assert.equal(rows(lines)[0]?.stage, 'capacity.actor.receipts-full'); assert.equal(rows(lines)[0]?.code, 'RESOURCE_BUSY'); }
    assert.doesNotMatch(lines.join(''), /不得输出|https?:|stack|message|resourceId|ticket/);
    closeMobileCapabilityContext(context);
  }
});

test('独立容量窗口最多128个上下文，原preparation snapshot仍最多两次且可由原reader接受', () => {
  const lines: string[] = [], ordinary = createMobilePreparationProbe({ enabled: true, sink: () => undefined }); ordinary.arm();
  const capacity = createMobileResourceCapacityProbe({ enabled: true, sink: line => lines.push(line) });
  for (let index = 0; index < 128; index++) {
    const id = randomUUID(), full = ordinary.claim('createResource', id, new AbortController().signal);
    const context = capacity.claim(id, 'main', 'http', undefined, full); assert.ok(context);
    assert.throws(() => withMobileCapabilityContext(context, () => mobileResourceCapacityFailure('capacity.actor.stored-resources-full', () => { throw rejection(); })));
    closeMobileCapabilityContext(context);
  }
  assert.equal(capacity.claim(randomUUID(), 'main', 'http'), undefined);
  assert.equal(lines.length, 126, '前两次仍归原完整probe，额外126次只输出准确guard');
  const snapshot = ordinary.snapshot(); assert.equal(snapshot.resourceClaims, 2); assert.equal(snapshot.resourceScopes.length, 2);
  assert.ok(copyMobilePreparationSnapshot(snapshot));
});

test('容量sink抛错与未知stage不能改变原失败，未知字段仍由原闭集reader拒收', () => {
  const probe = createMobileResourceCapacityProbe({ enabled: true, sink: () => { throw new Error('合成出口故障'); } });
  const context = probe.claim(randomUUID(), 'core', 'content'); assert.ok(context); const error = rejection();
  for (const stage of ['capacity.http.probes-full', 'capacity.unknown'] as MobileResourceCapacityStage[]) {
    assert.throws(() => withMobileCapabilityContext(context, () => mobileResourceCapacityFailure(stage, () => { throw error; })), value => value === error);
  }
  const lines: string[] = [], capturing = createMobileResourceCapacityProbe({ enabled: true, sink: line => lines.push(line) });
  const known = capturing.claim(randomUUID(), 'core', 'content');
  assert.throws(() => withMobileCapabilityContext(known, () => mobileResourceCapacityFailure('capacity.http.leases-full', () => { throw error; })));
  const record = rows(lines)[0]; assert.ok(record);
  assert.equal(copyMobileCapabilityTraceRecord({ ...record, stage: 'capacity.unknown' }), null);
  assert.equal(copyMobileCapabilityTraceRecord({ ...record, resourceId: '禁止加入' }), null);
  closeMobileCapabilityContext(context); closeMobileCapabilityContext(known);
});

test('普通旁注饱和仍保留首个容量guard，额外上下文不输出其他素材或普通阶段', () => {
  const lines: string[] = [], probe = createMobileResourceCapacityProbe({ enabled: true, sink: line => lines.push(line) });
  const context = probe.claim(randomUUID(), 'core', 'content'); assert.ok(context);
  withMobileCapabilityContext(context, () => {
    for (let index = 0; index < 1_000; index++) mobileCapabilitySync('main.current', () => undefined);
    for (const stage of ['capacity.provider.live-resources-full', 'capacity.http.leases-full'] as const) {
      assert.throws(() => mobileResourceCapacityFailure(stage, () => { throw rejection(); }));
    }
  });
  assert.equal(lines.length, 1); assert.equal(rows(lines)[0]?.stage, 'capacity.provider.live-resources-full');
  closeMobileCapabilityContext(context);
});

test('稀疏Main RPC关联与Core首拒使用既有相同哈希，不输出原request ID', () => {
  const lines: string[] = [], probe = createMobileResourceCapacityProbe({ enabled: true, sink: line => lines.push(line) });
  const originalID = randomUUID(), rpcID = randomUUID();
  const parent = probe.claim(originalID, 'main', 'http'); assert.ok(parent);
  const child = createMobileCapabilityContext(rpcID, 'main', 'content', parent.requestSha256, undefined, parent.sink); assert.ok(child);
  withMobileCapabilityContext(child, () => mobileCapabilitySync('content.rpc.source', () => undefined));
  const core = probe.claim(rpcID, 'core', 'content'); assert.ok(core);
  assert.throws(() => withMobileCapabilityContext(core, () => mobileResourceCapacityFailure('capacity.core.active-bindings-full', () => { throw rejection(); })));
  const captured = rows(lines); assert.equal(captured.length, 2);
  assert.equal(captured[0]?.stage, 'content.rpc.source'); assert.equal(captured[0]?.phase, 'begin');
  assert.equal(captured[0]?.parentSha256, parent.requestSha256);
  assert.equal(captured[1]?.requestSha256, child.requestSha256);
  assert.doesNotMatch(lines.join(''), new RegExp(originalID + '|' + rpcID));
  for (const context of [parent, child, core]) closeMobileCapabilityContext(context);
});
