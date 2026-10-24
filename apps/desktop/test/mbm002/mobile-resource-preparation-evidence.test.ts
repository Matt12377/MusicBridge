import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  MOBILE_CAPABILITY_TRACE_PREFIX, createMobilePreparationProbe, copyMobilePreparationSnapshot,
  createMobileCapabilityContext, createMobileCapabilityTraceReader, closeMobileCapabilityContext,
  mobileCapabilityAsync, mobileCapabilityReject, mobileCapabilitySync, mobilePreparationSync,
  snapshotMobileCapabilityTrace, withMobileCapabilityContext, type MobileCapabilityContext,
  type MobilePreparationProbe, type MobileCapabilityTraceRecord, type MobilePreparationSnapshot,
} from '../../../../packages/bridge-core/src/mobile/capability-trace.js';
import { createMobileRangeWindowProbe } from '../../../../packages/bridge-core/src/mobile/range-window-observer.js';
import { createMobileRangeTimingProbe } from '../../src/main/mobile-range-timing.js';
import { MainDiagnosticRecorder, writeDiagnosticReport, type DiagnosticReportWriteInput } from '../../src/main/diagnostics.js';

const denied = () => Object.assign(new Error('私密曲目及上游地址不得进入诊断'), { name: 'MobileServiceError', code: 'SOURCE_CHANGED' });
const clock = { now: () => 100, epochNow: () => 1_800_000_000_000 };
function claim(probe: MobilePreparationProbe) {
  const value = probe.claim('createResource', randomUUID(), new AbortController().signal); assert.ok(value);
  withMobileCapabilityContext(value, () => mobilePreparationSync('preparation.http.resource', () => undefined));
  return value;
}
function rpc(probe: MobilePreparationProbe, parent: MobileCapabilityContext, id = randomUUID()) {
  // 与原Main exchange相同：child使用原request.id及HTTP parent，并沿用原sink。
  const main = createMobileCapabilityContext(id, 'main', 'content', parent.requestSha256, undefined, parent.sink, clock); assert.ok(main);
  withMobileCapabilityContext(main, () => mobileCapabilitySync('content.rpc.source', () => undefined));
  const read = createMobileCapabilityTraceReader(row => probe.acceptCoreTrace(row));
  const core = createMobileCapabilityContext(id, 'core', 'content', null, undefined, read, clock); assert.ok(core);
  return { main, core };
}
function finish(probe: MobilePreparationProbe, context: MobileCapabilityContext, failed = true, finished = true) {
  probe.finish(context, { failed, finished, httpStatus: failed ? 409 : 201 }); closeMobileCapabilityContext(context);
}
function coreRows(probe: MobilePreparationProbe, index = 0) {
  return probe.snapshot().resourceScopes[index]!.trace.records.filter(row => row.component === 'core');
}

test('资源准备两槽独立保留Local后NetEase的明确HTTP→RPC→Core首错，全局环挤压不改变关联', () => {
  const probe = createMobilePreparationProbe({ enabled: true, ...clock }); probe.arm();
  const local = claim(probe), first = rpc(probe, local), original = denied();
  withMobileCapabilityContext(first.core, () => mobileCapabilityReject('provider.source.prepare.catalog-facts', original));
  finish(probe, local);
  const netease = claim(probe), second = rpc(probe, netease);
  withMobileCapabilityContext(second.core, () => mobileCapabilityReject('provider.source.prepare.audio-facts.channels', original));
  finish(probe, netease);
  const unrelated = createMobileCapabilityContext(randomUUID(), 'main', 'http', null, undefined, () => {}, clock); assert.ok(unrelated);
  withMobileCapabilityContext(unrelated, () => { for (let i = 0; i < 300; i++) mobileCapabilitySync('main.current', () => undefined); });
  // 多个独立上下文确保真实全局256环确已被挤压，不能拿本地context上限冒充环丢失。
  for (let i = 0; i < 8; i++) {
    const flood = createMobileCapabilityContext(randomUUID(), 'main', 'http', null, undefined, () => {}, clock); assert.ok(flood);
    withMobileCapabilityContext(flood, () => { for (let j = 0; j < 32; j++) mobileCapabilitySync('main.current', () => undefined); });
  }
  assert.equal(snapshotMobileCapabilityTrace().records.some(row => row.requestSha256 === first.core.requestSha256), false);
  assert.equal(probe.claim('createResource', randomUUID(), new AbortController().signal), undefined);
  const snapshot = probe.snapshot(); assert.equal(snapshot.resourceClaims, 2); assert.equal(snapshot.resourceDropped, 1);
  assert.equal(snapshot.scopes.length, 0); assert.equal(snapshot.resourceScopes.length, 2); assert.equal(snapshot.truncated, true);
  for (const [index, pair, parent, stage] of [[0, first, local, 'provider.source.prepare.catalog-facts'],
    [1, second, netease, 'provider.source.prepare.audio-facts.channels']] as const) {
    const scope = snapshot.resourceScopes[index]!;
    assert.ok(scope.trace.records.some(row => row.component === 'main' && row.requestSha256 === pair.main.requestSha256 && row.parentSha256 === parent.requestSha256));
    assert.equal(scope.trace.firstBusinessFailures.find(row => row.component === 'core')?.stage, stage);
    assert.equal(scope.trace.firstBusinessFailures.find(row => row.component === 'core')?.code, 'SOURCE_CHANGED');
    assert.equal(scope.trace.records.some(row => row.requestSha256 === (index === 0 ? second : first).core.requestSha256), false);
    assert.ok(scope.trace.records.length <= 512);
  }
  assert.ok(copyMobilePreparationSnapshot(snapshot));
  assert.doesNotMatch(JSON.stringify(snapshot), /私密曲目|上游地址|message|stack|https?:|selection|Cookie|accessToken/u);
});

test('相近时间、未观察到的RPC及Owner同SHA不获关联；独立槽预算溢出仍保Core首错及HTTP终态', () => {
  const probe = createMobilePreparationProbe({ enabled: true, ...clock }); probe.arm(); const resource = claim(probe);
  const unrelated = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, undefined,
    createMobileCapabilityTraceReader(row => probe.acceptCoreTrace(row)), clock); assert.ok(unrelated);
  withMobileCapabilityContext(unrelated, () => mobileCapabilityReject('provider.source.prepare.scope', denied()));
  assert.deepEqual(coreRows(probe), []);
  withMobileCapabilityContext(resource, () => { for (let i = 0; i < 300; i++) mobilePreparationSync('preparation.auth.envelope', () => undefined); });
  const pair = rpc(probe, resource);
  const forgedOwner = createMobileCapabilityContext(randomUUID(), 'owner', 'owner', null, undefined,
    createMobileCapabilityTraceReader(row => probe.acceptCoreTrace({ ...row, requestSha256: pair.core.requestSha256 })), clock); assert.ok(forgedOwner);
  withMobileCapabilityContext(forgedOwner, () => mobileCapabilityReject('owner.rpc.failure', denied()));
  withMobileCapabilityContext(pair.core, () => mobileCapabilityReject('provider.audio-probe.reject.vendor.digest', denied()));
  withMobileCapabilityContext(resource, () => {
    mobileCapabilitySync('http.status.409', () => undefined); mobileCapabilitySync('http.send', () => undefined);
  });
  finish(probe, resource);
  const scope = probe.snapshot().resourceScopes[0]!;
  assert.ok(scope.trace.droppedRecords > 0); assert.ok(scope.trace.records.length <= 512);
  assert.equal(scope.trace.records.some(row => row.component === 'owner'), false);
  assert.equal(scope.trace.firstBusinessFailures.find(row => row.component === 'core')?.stage, 'provider.audio-probe.reject.vendor.digest');
  assert.ok(scope.trace.records.some(row => row.stage === 'preparation.http.terminal' && row.phase === 'ok'));
  assert.ok(scope.trace.records.some(row => row.stage === 'http.send' && row.phase === 'ok'));
  assert.ok(copyMobilePreparationSnapshot(probe.snapshot()));
});

test('HTTP退场后的原Core工作和迟到清理继续归原resource槽，不伪称quiet或串到第二槽', async () => {
  const probe = createMobilePreparationProbe({ enabled: true, ...clock }); probe.arm(); const resource = claim(probe), pair = rpc(probe, resource);
  let release!: () => void; const gate = new Promise<void>(done => { release = done; }); const original = denied();
  const pending = withMobileCapabilityContext(pair.core, () => mobileCapabilityAsync('core.rpc.scope.resolve', async () => { await gate; throw original; }));
  const observed = assert.rejects(pending, error => error === original);
  finish(probe, resource, true, false); assert.equal(resource.closed, true);
  assert.equal(probe.snapshot().resourceScopes[0]!.terminal, 'incomplete'); assert.equal(probe.snapshot().resourceScopes[0]!.workPending, true);
  const second = claim(probe); finish(probe, second, false);
  release(); await observed; closeMobileCapabilityContext(pair.core);
  withMobileCapabilityContext(pair.core, () => mobileCapabilityReject('core.rpc.failure', original, 'cleanup'));
  const snapshot = probe.snapshot(); assert.equal(snapshot.resourceScopes[0]!.workPending, false);
  assert.equal(snapshot.resourceScopes[0]!.trace.cleanupFailures[0]?.requestSha256, pair.core.requestSha256);
  assert.equal(snapshot.resourceScopes[1]!.trace.cleanupFailures.length, 0); assert.ok(copyMobilePreparationSnapshot(snapshot));
});

test('资源闭集拒绝第三槽、未知stage、未关联Core、矛盾父链、未知字段及getter，不扩旧身份会话预算', () => {
  const probe = createMobilePreparationProbe({ enabled: true, ...clock }); probe.arm(); const resource = claim(probe), pair = rpc(probe, resource);
  withMobileCapabilityContext(pair.core, () => mobileCapabilityReject('provider.audio-probe.reject.body.length', denied())); finish(probe, resource);
  const snapshot = probe.snapshot(); assert.ok(copyMobilePreparationSnapshot(snapshot));
  const mutate = (work: (value: MobilePreparationSnapshot) => void) => { const value = structuredClone(snapshot); work(value); assert.equal(copyMobilePreparationSnapshot(value), null); };
  mutate(value => { value.resourceClaims = 3; });
  mutate(value => { value.resourceScopes.push(value.resourceScopes[0]!, value.resourceScopes[0]!); });
  mutate(value => { value.resourceScopes[0]!.trace.records[0]!.stage = 'provider.source.prepare.not-approved' as MobileCapabilityTraceRecord['stage']; });
  mutate(value => { value.resourceScopes[0]!.trace.records.push({ ...coreRows(probe)[0]!, requestSha256: 'f'.repeat(64) }); });
  mutate(value => { const edge = value.resourceScopes[0]!.trace.records.find(row => row.parentSha256 === resource.requestSha256)!;
    value.resourceScopes[0]!.trace.records.push({ ...edge, parentSha256: edge.requestSha256 }); });
  mutate(value => { value.resourceScopes[0]!.trace.records.push(...Array.from({ length: 513 }, () => value.resourceScopes[0]!.trace.records[0]!)); });
  assert.equal(copyMobilePreparationSnapshot({ ...snapshot, privatePayload: '私密正文' }), null);
  let touched = 0;
  const getter = Object.defineProperty({ ...snapshot }, 'resourceScopes', { enumerable: true, get() { touched++; return []; } });
  assert.equal(copyMobilePreparationSnapshot(getter), null); assert.equal(touched, 0);
  const off = createMobilePreparationProbe({ ...clock }); off.arm(); assert.equal(off.claim('createResource', randomUUID(), new AbortController().signal), undefined);
  assert.equal(off.snapshot().resourceClaims, 0); assert.ok(copyMobilePreparationSnapshot(off.snapshot()));
  assert.equal(snapshot.identityClaims, 0); assert.equal(snapshot.sessionClaims, 0);
});

test('512条均为保护记录时拒绝新增首错及父链仍可有界导出，既有Core首错不丢', () => {
  const probe = createMobilePreparationProbe({ enabled: true, ...clock }); probe.arm(); const resource = claim(probe), pair = rpc(probe, resource);
  withMobileCapabilityContext(resource, () => { for (let i = 0; i < 255; i++) mobileCapabilitySync('http.send', () => undefined); });
  withMobileCapabilityContext(pair.core, () => mobileCapabilityReject('provider.source.prepare.audio-read', denied()));
  const before = probe.snapshot().resourceScopes[0]!.trace;
  assert.equal(before.records.length, 512); assert.equal(before.firstBusinessFailures.find(row => row.component === 'core')?.stage, 'provider.source.prepare.audio-read');
  withMobileCapabilityContext(pair.core, () => mobileCapabilityReject('core.rpc.failure', denied(), 'cleanup'));
  const dropped = rpc(probe, resource);
  withMobileCapabilityContext(dropped.core, () => mobileCapabilityReject('provider.source.prepare.open', denied()));
  finish(probe, resource);
  const snapshot = probe.snapshot(), after = snapshot.resourceScopes[0]!.trace;
  assert.equal(after.records.length, 512); assert.ok(after.droppedRecords > before.droppedRecords); assert.equal(snapshot.truncated, true);
  assert.equal(after.cleanupFailures.length, 0);
  assert.equal(after.records.some(row => row.requestSha256 === dropped.core.requestSha256), false);
  assert.equal(after.firstBusinessFailures.find(row => row.component === 'core')?.stage, 'provider.source.prepare.audio-read');
  assert.ok(copyMobilePreparationSnapshot(snapshot));
});

test('resource领取时钟失败及入槽异常仅计resourceContextFaults，旧claims等式继续成立', t => {
  const clockFailure = createMobilePreparationProbe({ enabled: true, now() { throw new Error('合成私有时钟故障'); } }); clockFailure.arm();
  assert.equal(clockFailure.claim('createResource', randomUUID(), new AbortController().signal), undefined);
  const timed = clockFailure.snapshot(); assert.equal(timed.resourceClaims, 1); assert.equal(timed.resourceContextFaults, 1);
  assert.equal(timed.contextFaults, 0); assert.ok(copyMobilePreparationSnapshot(timed));
  const probe = createMobilePreparationProbe({ enabled: true, ...clock }); probe.arm();
  const originalSet = Map.prototype.set;
  const mock = t.mock.method(Map.prototype, 'set', function(this: Map<unknown, unknown>, key: unknown, value: unknown) {
    if (key && typeof key === 'object' && (key as MobileCapabilityContext).resourcePreparation === true) throw new Error('合成入槽异常');
    return originalSet.call(this, key, value);
  });
  try { assert.equal(probe.claim('createResource', randomUUID(), new AbortController().signal), undefined); } finally { mock.mock.restore(); }
  const captured = probe.snapshot(); assert.equal(captured.resourceClaims, 1); assert.equal(captured.resourceContextFaults, 1);
  assert.equal(captured.contextFaults, 0); assert.equal(captured.resourceScopes.length, 0); assert.ok(copyMobilePreparationSnapshot(captured));
});

test('资源槽与首8个Range沿既有Main私有0600导出，两个Range闭集继续拒绝未知字段', async t => {
  const root = process.env.TMPDIR ?? ''; assert.ok(root.startsWith('/Volumes/LifeWeave/Developer/CommandLine/'));
  const directory = await mkdtemp(path.join(root, 'mobile-resource-diagnostics-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const probe = createMobilePreparationProbe({ enabled: true, ...clock }); probe.arm(); const resource = claim(probe), pair = rpc(probe, resource);
  withMobileCapabilityContext(pair.core, () => mobileCapabilityReject('provider.source.prepare.audio-facts.codec', denied())); finish(probe, resource);
  const timing = createMobileRangeTimingProbe({ enabled: true, ...clock }), window = createMobileRangeWindowProbe({ enabled: true, ...clock });
  const input = { requestId: randomUUID(), method: 'GET', operation: 'getMediaAsset', range: 'bytes=0-262143' };
  assert.equal(timing.claim({ ...input, range: 'bytes=0-1' }), undefined);
  const first = timing.claim(input); assert.ok(first); first.reply(206, 262144); first.finish('ok');
  for (let i = 0; i < 8; i++) { const value = window.claim({ ...input, requestId: randomUUID(), range: `bytes=${i * 262144}-${(i + 1) * 262144 - 1}` });
    assert.ok(value); window.finish(value, { status: 206, finished: true, failed: false }); }
  assert.equal(window.claim({ ...input, requestId: randomUUID() }), undefined);
  const recorder = new MainDiagnosticRecorder(), evidence: DiagnosticReportWriteInput = {
    platform: { platform: 'darwin', arch: 'arm64', appVersion: '0.1.0-beta.2', electronVersion: '43.4.0', nodeVersion: '22.23.2' },
    main: recorder.snapshot(), core: { ...recorder.snapshot(), component: 'core' },
    privateEvidence: { version: 1, localAlbum: { schema: 'v39.local-album-safe-trace.v1', records: [], firstRejects: [], droppedRecords: 0 }, localPlayback: [],
      mobilePreparation: probe.snapshot(), mobileRangeTiming: timing.snapshot(), mobileRangeWindow: window.snapshot() },
  };
  const file = path.join(directory, 'accepted.json'); await writeDiagnosticReport(file, evidence);
  assert.equal((await stat(file)).mode & 0o777, 0o600); const report = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(report.privateEvidence.mobilePreparation, probe.snapshot()); assert.equal(report.privateEvidence.mobileRangeWindow.requests.length, 8);
  assert.equal(JSON.stringify(report).includes(input.requestId), false);
  for (const key of ['mobileRangeTiming', 'mobileRangeWindow'] as const) {
    await assert.rejects(writeDiagnosticReport(path.join(directory, 'rejected.json'), { ...evidence,
      privateEvidence: { ...evidence.privateEvidence!, [key]: { ...evidence.privateEvidence![key], unknownPayload: '私密正文' } } }), /安全闭集/u);
  }
  assert.deepEqual(await readdir(directory), ['accepted.json']);
});
