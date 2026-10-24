import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { collectMobileCapabilityTrace, createMobileCapabilityTraceCollector, mobileCapabilityRequestSha,
  selectMobileCapabilityTraceBranchDetails, type MobileCapabilityTraceRecord } from '../src/mobile/capability-trace.js';
import { createMobileOwnerLoadTraceProbe, MOBILE_OWNER_LOAD_TRACE_PREFIX, MOBILE_OWNER_LOAD_TRACE_LIMITS,
  type MobileOwnerLoadTraceEvent, type MobileOwnerLoadCapabilityFrame } from '../src/mobile/owner-load-trace.js';

const sha = () => mobileCapabilityRequestSha('content', randomUUID())!;
function row(requestSha256: string, change: Partial<MobileCapabilityTraceRecord> = {}): MobileCapabilityTraceRecord {
  return { schema: 'mb.mobile-capability-trace.v1', component: 'main', requestSha256, parentSha256: null, relatedSha256: null,
    epochMs: 1000, elapsedMs: 0, stage: 'http.receive', phase: 'begin', role: 'business', name: 'UNKNOWN', code: 'OK',
    outcome: null, aborted: false, initState: 'none', ...change };
}
const coarse: readonly Pick<MobileOwnerLoadTraceEvent, 'component' | 'stage' | 'outcome'>[] = [
  { component: 'main', stage: 'http.receive', outcome: 'ok' }, { component: 'main', stage: 'http.dispatch', outcome: 'begin' },
  { component: 'main', stage: 'main.auth', outcome: 'begin' }, { component: 'main', stage: 'main.post', outcome: 'begin' },
  { component: 'core', stage: 'core.receive', outcome: 'ok' }, { component: 'core', stage: 'owner.client.post', outcome: 'begin' },
  { component: 'owner', stage: 'owner.load', outcome: 'begin' }, { component: 'owner', stage: 'owner.load', outcome: 'ok' },
  { component: 'main', stage: 'main.capture', outcome: 'ok' }, { component: 'main', stage: 'main.auth', outcome: 'ok' },
  { component: 'main', stage: 'main.initial-qualification', outcome: 'begin' }, { component: 'main', stage: 'main.content.initialize', outcome: 'begin' },
  { component: 'core', stage: 'core.post', outcome: 'ok' }, { component: 'owner', stage: 'owner.receive', outcome: 'ok' },
  { component: 'main', stage: 'main.content.scope', outcome: 'begin' }, { component: 'main', stage: 'main.content.scope', outcome: 'unknown' },
  { component: 'main', stage: 'main.initial-qualification', outcome: 'unknown' }, { component: 'main', stage: 'http.dispatch', outcome: 'unknown' },
  { component: 'main', stage: 'http.failure', outcome: 'error' },
];
function fixture(completed = false) {
  const root = sha(), scope = sha(), init = sha(), owner = sha(), lines: string[] = [];
  const probe = createMobileOwnerLoadTraceProbe({ enabled: true, sink: line => { lines.push(line); } }), context = probe.claim(); assert.ok(context);
  assert.equal(probe.bindCapability(context.ordinal, root), true);
  for (let index = 0; index < coarse.length; index++) assert.equal(probe.accept({ type: 'mobile-owner-load-trace', event: {
    ...coarse[index]!, ordinal: context.ordinal, role: 'business', atMs: 1000 + index, durationMs: 0,
  } }), true);
  assert.equal(probe.snapshot().ordinaryRecords, 18, '对应已冻结首503的19条粗阶段：18普通槽和1首错槽。');
  const rows = [
    row(root, { stage: 'content.initialize.cache', phase: 'cache', initState: 'new-pending', relatedSha256: init }),
    row(init, { stage: 'content.rpc.initialize', parentSha256: root }),
    row(init, { component: 'core', stage: 'core.rpc.initialize.cache', phase: 'cache', initState: 'new-pending', relatedSha256: init }),
    row(init, { component: 'core', stage: 'owner.rpc.link', phase: 'link', relatedSha256: owner }),
    row(init, { stage: 'content.rpc.initialize', parentSha256: root, phase: 'ok', elapsedMs: 7 }),
    row(scope, { component: 'core', stage: 'core.rpc.scope.resolve', elapsedMs: 1 }),
    row(scope, { component: 'core', stage: 'core.scope.queue', elapsedMs: 2 }),
    // 这是合成的“源环已有未完成阶段”反例，不把它冒充1857实际到达Owner的证据。
    row(scope, { component: 'core', stage: 'core.scope.owner.update', elapsedMs: 2 }),
    ...(completed ? [row(scope, { component: 'core', stage: 'core.scope.owner.update', phase: 'ok', elapsedMs: 3 })] : []),
    row(scope, { component: 'core', stage: 'core.rpc.failure', phase: 'reject', elapsedMs: 10000, code: 'UNKNOWN', outcome: 'unknown', aborted: true }),
    row(scope, { parentSha256: root, stage: 'content.rpc.scope', phase: 'reject', elapsedMs: 10000, code: 'BUSY', outcome: 'unknown', aborted: true }),
    row(root, { stage: 'main.initial-qualification', phase: 'reject', elapsedMs: 10020, code: 'BUSY', outcome: 'unknown' }),
    row(scope, { parentSha256: root, stage: 'content.rpc.scope', phase: 'reject', elapsedMs: 10001, code: 'UNKNOWN', outcome: 'unknown', aborted: true }),
    row(scope, { parentSha256: root, stage: 'content.rpc.scope', phase: 'reject', elapsedMs: 10001, code: 'BUSY', outcome: 'unknown', aborted: true }),
    row(root, { stage: 'http.failure', phase: 'reject', elapsedMs: 10021, code: 'BUSY', outcome: 'unknown' }),
  ];
  rows.forEach(collectMobileCapabilityTrace);
  const collector = createMobileCapabilityTraceCollector(); rows.forEach(value => collector.record(value));
  return { root, scope, lines, probe, context, snapshot: collector.snapshot() };
}

test('首503观测：原28普通槽中优先保同请求最后观察到的未落定Core阶段，不被传播错误挤掉', () => {
  const f = fixture(); f.probe.publishCapabilities();
  const frames = f.lines.map(line => JSON.parse(line.slice(MOBILE_OWNER_LOAD_TRACE_PREFIX.length)) as MobileOwnerLoadCapabilityFrame);
  const details = frames.filter(value => value.type === 'mobile-owner-load-capability').map(value => value.record);
  assert.ok(details.some(value => value.requestSha256 === f.scope && value.stage === 'core.rpc.failure' && value.phase === 'reject'));
  assert.ok(details.some(value => value.requestSha256 === f.scope && value.stage === 'core.scope.owner.update' && value.phase === 'begin'),
    '即便源环已有pending leaf，HTTP输出也必须保留；否则再次采样仍只见总UNKNOWN。');
  assert.ok(details.some(value => value.requestSha256 === f.scope && value.parentSha256 === f.root), '仍须保显式Main parent关联。');
  assert.equal(f.probe.snapshot().ordinaryRecords, 28);
  assert.ok(f.probe.snapshot().records <= MOBILE_OWNER_LOAD_TRACE_LIMITS.records);
  assert.ok(f.probe.snapshot().bytes <= MOBILE_OWNER_LOAD_TRACE_LIMITS.bytes);
});

test('首503观测：已settle阶段不当作pending，毫秒相同按原记录顺序选择最新未settle阶段', () => {
  for (const completed of [false, true]) {
    const f = fixture(completed), selected = selectMobileCapabilityTraceBranchDetails(f.snapshot, f.root);
    const openCore = selected.records.filter(value => value.component === 'core' && value.requestSha256 === f.scope && value.phase === 'begin');
    assert.equal(openCore[0]?.stage, completed ? 'core.scope.queue' : 'core.scope.owner.update');
    assert.equal(selected.sourceDroppedRecords, 0);
    assert.ok(selected.records.length <= 64);
  }
});

test('首503观测：同阶段同毫秒再次begin以原collector后序为准，去重与首错补表不覆盖最后状态', () => {
  for (const terminal of ['ok', 'reject'] as const) for (const identicalBegin of [false, true]) {
    const root = sha(), scope = sha(), collector = createMobileCapabilityTraceCollector();
    const begin = row(scope, { component: 'core', stage: 'core.assert.account', elapsedMs: 2, epochMs: 1001 });
    [row(scope, { parentSha256: root, stage: 'content.rpc.scope' }),
      row(scope, { component: 'core', stage: 'core.rpc.scope.resolve', elapsedMs: 1 }),
      begin, { ...begin, epochMs: 1002, phase: terminal },
      identicalBegin ? begin : { ...begin, epochMs: 1003 }].forEach(value => collector.record(value));
    const selected = selectMobileCapabilityTraceBranchDetails(collector.snapshot(), root);
    const open = selected.records.filter(value => value.component === 'core' && value.phase === 'begin');
    assert.equal(open[0]?.stage, 'core.assert.account', '同阶段的新调用已经开始，不能用较早终态或去重位置代替它。');
    assert.equal(selected.sourceDroppedRecords, 0);
  }
});
