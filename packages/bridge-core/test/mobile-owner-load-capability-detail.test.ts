import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  MOBILE_CAPABILITY_TRACE_SCHEMA, collectMobileCapabilityTrace, createMobileCapabilityContext,
  createMobileCapabilityTraceCollector, closeMobileCapabilityContext, mobileCapabilityRequestSha,
  observeMobileCapabilityTrace, selectMobileCapabilityTraceBranch, selectMobileCapabilityTraceBranchDetails, snapshotMobileCapabilityTrace,
  withMobileCapabilityContext, type MobileCapabilityTraceRecord, type MobileCapabilityTraceSnapshot,
} from '../src/mobile/capability-trace.js';
import {
  MOBILE_OWNER_LOAD_TRACE_PREFIX, MOBILE_OWNER_LOAD_TRACE_LIMITS,
  copyMobileOwnerLoadCapabilityFrame, copyMobileOwnerLoadTraceFrame, createMobileOwnerLoadTraceProbe,
  markMobileOwnerLoadTrace, withMobileOwnerLoadTrace,
} from '../src/mobile/owner-load-trace.js';

const sha = () => mobileCapabilityRequestSha('http', randomUUID())!;
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function record(requestSha256 = sha(), change: Partial<MobileCapabilityTraceRecord> = {}): MobileCapabilityTraceRecord {
  return { schema: MOBILE_CAPABILITY_TRACE_SCHEMA, component: 'main', requestSha256, parentSha256: null, relatedSha256: null,
    epochMs: 1000, elapsedMs: 0, stage: 'http.receive', phase: 'begin', role: 'business', name: 'UNKNOWN', code: 'OK',
    outcome: null, aborted: false, initState: 'none', ...change };
}
function snapshot(records: MobileCapabilityTraceRecord[]): MobileCapabilityTraceSnapshot {
  const collector = createMobileCapabilityTraceCollector(); records.forEach(value => collector.record(value)); return collector.snapshot();
}
const key = (value: MobileCapabilityTraceRecord) => `${value.component}:${value.requestSha256}:${value.stage}:${value.epochMs}`;
function parseLines(lines: string[]) {
  return lines.map(line => {
    assert.ok(line.startsWith(MOBILE_OWNER_LOAD_TRACE_PREFIX)); assert.ok(Buffer.byteLength(line) <= 1024);
    const raw: unknown = JSON.parse(line.slice(MOBILE_OWNER_LOAD_TRACE_PREFIX.length));
    const value = copyMobileOwnerLoadCapabilityFrame(raw) ?? copyMobileOwnerLoadTraceFrame(raw);
    assert.ok(value, '两种同prefix信封都必须通过实际闭集codec。'); return value;
  });
}

test('能力detail闭包只循Main parent、Core同SHA、Owner明确link和初始化cache边', () => {
  const root = sha(), content = sha(), owner = sha(), init = sha(), initOwner = sha(), foreign = sha(), poisoned = sha();
  const allowed = [
    record(root),
    record(content, { parentSha256: root, stage: 'content.rpc.scope' }),
    record(content, { component: 'core', stage: 'core.scope.account.first' }),
    record(content, { component: 'core', stage: 'owner.rpc.link', phase: 'link', relatedSha256: owner }),
    record(owner, { component: 'owner', stage: 'owner.rpc.receive' }),
    record(content, { stage: 'content.initialize.cache', phase: 'cache', initState: 'reuse-pending', relatedSha256: init }),
    record(init, { stage: 'content.rpc.initialize' }),
    record(init, { component: 'core', stage: 'core.initialize.owner.prepare' }),
    record(init, { component: 'core', stage: 'owner.rpc.link', phase: 'link', relatedSha256: initOwner }),
    record(initOwner, { component: 'owner', stage: 'owner.content.initialize' }),
  ];
  const excluded = [
    record(foreign, { stage: 'main.auth' }), // 完全相同时间不产生关系。
    record(content, { stage: 'main.current', phase: 'link', relatedSha256: poisoned }),
    record(poisoned, { component: 'owner', stage: 'owner.content.initialize' }),
    record(foreign, { relatedSha256: root, stage: 'main.current', phase: 'link' }), // 反向related不产生关系。
    record(content, { component: 'owner', stage: 'owner.rpc.receive' }), // Owner不可仅借同SHA混入。
  ];
  const input = snapshot([...excluded, ...allowed].reverse());
  const before = structuredClone(input), selected = selectMobileCapabilityTraceBranch(input, root);
  assert.ok(selected.length <= 64); assert.deepEqual(input, before, '纯选择不能改全局环或调用者snapshot。');
  const selectedKeys = new Set(selected.map(key));
  for (const row of allowed) assert.ok(selectedKeys.has(key(row)), `缺少可信闭包中的${row.component}/${row.stage}`);
  for (const row of excluded.filter(row => row.requestSha256 !== content || row.component === 'owner')) assert.equal(selectedKeys.has(key(row)), false);
  assert.equal(selected.some(row => row.requestSha256 === poisoned || row.requestSha256 === foreign), false);
});

test('错误组件、phase及任意related不能充当Owner/cache连接证书', () => {
  for (const edge of [
    { component: 'main', stage: 'owner.rpc.link', phase: 'link' },
    { component: 'core', stage: 'owner.rpc.link', phase: 'begin' },
    { component: 'core', stage: 'core.scope.queue', phase: 'link' },
    { component: 'main', stage: 'content.initialize.cache', phase: 'link', initState: 'reuse-pending' },
    { component: 'main', stage: 'content.initialize.cache', phase: 'cache', initState: 'none' },
  ] as const) {
    const root = sha(), child = sha();
    const rows = selectMobileCapabilityTraceBranch(snapshot([record(root), record(root, { ...edge, relatedSha256: child }),
      record(child, { component: 'owner', stage: 'owner.content.initialize' }), record(child, { component: 'main', stage: 'content.rpc.initialize' })]), root);
    assert.equal(rows.some(row => row.requestSha256 === child), false);
  }
});

test('能力detail codec及分支选择拒绝Proxy/getter/额外key和私密正文而不触发访问器', () => {
  let reads = 0;
  const root = sha(), good = record(root), frame = { type: 'mobile-owner-load-capability', ordinal: 1, record: good };
  assert.deepEqual(copyMobileOwnerLoadCapabilityFrame(frame), frame);
  const proxy = new Proxy(frame, { ownKeys() { reads++; throw new Error('不得读取代理'); }, getPrototypeOf() { reads++; throw new Error('不得读取代理'); } });
  const rowGetter = { ...good, get code() { reads++; return 'OK'; } };
  const outerGetter = { ...frame, get record() { reads++; return good; } };
  for (const raw of [proxy, outerGetter, { ...frame, record: rowGetter }, { ...frame, extra: true },
    { ...frame, record: { ...good, message: '/private/secret Bearer synthetic-token' } },
    { ...frame, token: 'synthetic-token' }, { ...frame, ordinal: 0 }, { ...frame, ordinal: 9 },
    { ...frame, record: { ...good, stage: '/private/secret' } }, { ...frame, type: 'mobile-owner-load-trace' }]) {
    assert.equal(copyMobileOwnerLoadCapabilityFrame(raw), null);
  }
  const snap = snapshot([good]);
  for (const bad of [new Proxy(snap, {}), { ...snap, get records() { reads++; return [good]; } },
    { ...snap, records: [{ ...good, message: 'synthetic-token' }] }, { ...snap, extra: 'secret' }]) {
    assert.deepEqual(selectMobileCapabilityTraceBranch(bad as MobileCapabilityTraceSnapshot, root), []);
  }
  assert.equal(reads, 0);
  assert.deepEqual(selectMobileCapabilityTraceBranch(snap, 'not-a-sha'), []);
});

test('分支64条是容量而非丢失证明，omitted与原环dropped如实分列', () => {
  const root = sha();
  for (const count of [64, 65, 80]) {
    const input = snapshot(Array.from({ length: count }, (_, index) => record(root, { epochMs: 10000 + index })));
    input.droppedRecords = 7;
    const detail = selectMobileCapabilityTraceBranchDetails(input, root);
    assert.equal(detail.records.length, Math.min(count, 64));
    assert.equal(detail.omittedRecords, count - Math.min(count, 64));
    assert.equal(detail.sourceDroppedRecords, 7);
    assert.ok(Object.isFrozen(detail)); assert.deepEqual(selectMobileCapabilityTraceBranch(input, root), detail.records);
  }
});

test('ordinal与根SHA绑定不可改绑、跨ordinal复用或凭未领取ordinal注入detail', () => {
  const probe = createMobileOwnerLoadTraceProbe({ enabled: true }), first = probe.claim(), second = probe.claim(); assert.ok(first && second);
  const a = sha(), b = sha();
  assert.equal(probe.bindCapability(first.ordinal, a), true); assert.equal(probe.bindCapability(first.ordinal, a), true);
  assert.equal(probe.bindCapability(first.ordinal, b), false); assert.equal(probe.bindCapability(second.ordinal, a), false);
  assert.equal(probe.bindCapability(second.ordinal, b), true); assert.equal(probe.bindCapability(8, sha()), false);
  assert.equal(probe.bindCapability(0, sha()), false); assert.equal(probe.bindCapability(first.ordinal, 'invalid'), false);
  assert.equal(probe.accept({ type: 'mobile-owner-load-capability', ordinal: first.ordinal, record: record(a) }), false,
    '外部accept不得跳过分支选择注入新detail信封。');
});

test('原Promise、同步返回和异常identity不被能力旁观替换，也不同化thenable', async () => {
  const lines: string[] = [], context = createMobileCapabilityContext(randomUUID(), 'main', 'http', null, undefined, line => lines.push(line)); assert.ok(context);
  let calls = 0, thenReads = 0, messageReads = 0;
  const sync = {}, thenable = { get then() { thenReads++; throw new Error('不得同化thenable'); } };
  const original = new Error(); Object.defineProperty(original, 'message', { get() { messageReads++; return 'synthetic-private-message'; } });
  try {
    assert.equal(withMobileCapabilityContext(context, () => observeMobileCapabilityTrace('main.current', () => { calls++; return sync; })), sync);
    assert.equal(withMobileCapabilityContext(context, () => observeMobileCapabilityTrace('main.current', () => { calls++; return thenable; })), thenable);
    const resolved = Promise.resolve(sync);
    assert.equal(withMobileCapabilityContext(context, () => observeMobileCapabilityTrace('main.auth', () => { calls++; return resolved; })), resolved); await resolved;
    const rejected = Promise.reject(original);
    const observed = withMobileCapabilityContext(context, () => observeMobileCapabilityTrace('main.auth', () => { calls++; return rejected; }));
    assert.equal(observed, rejected); await assert.rejects(observed, error => error === original);
    let caught: unknown; try { withMobileCapabilityContext(context, () => observeMobileCapabilityTrace('main.current', () => { calls++; throw original; })); } catch (error) { caught = error; }
    assert.equal(caught, original); await turn();
    assert.equal(calls, 5); assert.equal(thenReads, 0); assert.equal(messageReads, 0);
    assert.doesNotMatch(lines.join(''), /synthetic-private-message|message|stack|\/private\//u);
  } finally { closeMobileCapabilityContext(context); }
});

test('旁注sink失败保原Promise及原拒绝，不重执行业务', async () => {
  let calls = 0;
  const context = createMobileCapabilityContext(randomUUID(), 'main', 'http', null, undefined, () => { throw new Error('合成sink失败'); }); assert.ok(context);
  const error = new Error('原异常'), pending = Promise.reject(error);
  try {
    const observed = withMobileCapabilityContext(context, () => observeMobileCapabilityTrace('main.auth', () => { calls++; return pending; }));
    assert.equal(observed, pending); await assert.rejects(observed, value => value === error); assert.equal(calls, 1);
  } finally { closeMobileCapabilityContext(context); }
});

test('默认关闭不领取或发布detail、不读取时钟，不改变无上下文原工作', () => {
  let sinkCalls = 0, clockCalls = 0, workCalls = 0;
  const before = snapshotMobileCapabilityTrace(), disabled = createMobileOwnerLoadTraceProbe({ sink() { sinkCalls++; }, now() { clockCalls++; return 1; }, epochNow() { clockCalls++; return 1; } });
  const root = sha(); assert.equal(disabled.claim(), undefined);
  disabled.bindCapability(1, root); disabled.publishCapabilities();
  const original = {};
  assert.equal(observeMobileCapabilityTrace('main.current', () => { workCalls++; return original; }), original);
  assert.equal(workCalls, 1); assert.equal(sinkCalls, 0); assert.equal(clockCalls, 0);
  assert.deepEqual(snapshotMobileCapabilityTrace(), before);
  assert.deepEqual(disabled.snapshot(), { enabled: false, claimed: 0, records: 0, bytes: 0, ordinaryRecords: 0, suppressed: 0 });
});

test('detail与原event共享40普通槽，失败/cleanup/terminal仍有保留槽且发布不重复', () => {
  const lines: string[] = [], probe = createMobileOwnerLoadTraceProbe({ enabled: true, sink: line => lines.push(line) }), context = probe.claim(); assert.ok(context);
  const root = sha(); probe.bindCapability(context.ordinal, root);
  for (let index = 0; index < 70; index++) collectMobileCapabilityTrace(record(root, { epochMs: 2000 + index, elapsedMs: index, stage: 'main.current' }));
  probe.publishCapabilities();
  withMobileOwnerLoadTrace(context, () => {
    for (let index = 0; index < 20; index++) markMobileOwnerLoadTrace('main', 'main.auth', 'ok');
    markMobileOwnerLoadTrace('main', 'main.content.scope', 'unknown');
    markMobileOwnerLoadTrace('main', 'cleanup', 'unknown', 'cleanup');
    markMobileOwnerLoadTrace('main', 'http.terminal', 'error', 'business', { status: 503, aborted: false, headersSent: true, writableFinished: true });
  });
  const emitted = parseLines(lines), detail = emitted.filter(value => value.type === 'mobile-owner-load-capability');
  assert.ok(detail.length > 0); assert.ok(probe.snapshot().ordinaryRecords <= MOBILE_OWNER_LOAD_TRACE_LIMITS.ordinaryRecords);
  assert.ok(emitted.some(value => value.type === 'mobile-owner-load-trace' && value.event.stage === 'main.content.scope' && value.event.outcome === 'unknown'));
  assert.ok(emitted.some(value => value.type === 'mobile-owner-load-trace' && value.event.stage === 'cleanup'));
  const terminal = emitted.find(value => value.type === 'mobile-owner-load-trace' && value.event.stage === 'http.terminal'); assert.ok(terminal && terminal.type === 'mobile-owner-load-trace');
  const counts = probe.snapshot(); assert.equal(counts.records, lines.length); assert.equal(counts.bytes, lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0));
  assert.equal(terminal.event.http?.counts?.records, counts.records); assert.equal(terminal.event.http?.counts?.bytes, counts.bytes);
  assert.ok(counts.records <= 64 && counts.bytes <= 65536); assert.ok(counts.suppressed > 0);
  const before = lines.length; probe.publishCapabilities(); assert.equal(lines.length, before, '重发不能消耗新槽或挤掉终态。');
});

test('普通槽饱和后detail首业务/cleanup错误仍保留，缺关联及错误ordinal不发布', () => {
  const lines: string[] = [], probe = createMobileOwnerLoadTraceProbe({ enabled: true, sink: line => lines.push(line) }), context = probe.claim(); assert.ok(context);
  withMobileOwnerLoadTrace(context, () => { for (let index = 0; index < 50; index++) markMobileOwnerLoadTrace('main', 'main.auth', 'ok'); });
  const root = sha(), content = sha(), foreign = sha();
  collectMobileCapabilityTrace(record(content, { parentSha256: root, stage: 'content.rpc.scope', epochMs: 2999 }));
  collectMobileCapabilityTrace(record(content, { component: 'core', stage: 'core.scope.account.first', phase: 'reject', code: 'TIMEOUT', outcome: 'unknown' }));
  collectMobileCapabilityTrace(record(root, { stage: 'main.close.content.cleanup', phase: 'reject', role: 'cleanup', code: 'BUSY', outcome: 'unknown', epochMs: 3001 }));
  collectMobileCapabilityTrace(record(foreign, { phase: 'reject', code: 'EIO', epochMs: 3002 }));
  probe.bindCapability(8, foreign); probe.publishCapabilities(); assert.equal(lines.length, 40, '未领取ordinal不能绑定或发布。');
  probe.bindCapability(context.ordinal, root); probe.publishCapabilities();
  const emitted = parseLines(lines), detail = emitted.filter(value => value.type === 'mobile-owner-load-capability');
  assert.equal(detail.length, 2); assert.ok(detail.every(value => value.record.requestSha256 === root || value.record.requestSha256 === content));
  assert.ok(detail.some(value => value.record.role === 'cleanup' && value.record.code === 'BUSY'));
  assert.ok(detail.some(value => value.record.role === 'business' && value.record.code === 'TIMEOUT'));
  withMobileOwnerLoadTrace(context, () => markMobileOwnerLoadTrace('main', 'http.terminal', 'error', 'business', { status: 503, aborted: false, headersSent: true, writableFinished: true }));
  assert.ok(parseLines(lines).some(value => value.type === 'mobile-owner-load-trace' && value.event.stage === 'http.terminal'));
  assert.ok(probe.snapshot().records <= 64 && probe.snapshot().bytes <= 65536);
});

test('绑定后的原event与HTTP detail共限28，保留12个close普通槽并仅增量发布', () => {
  const lines: string[] = [], probe = createMobileOwnerLoadTraceProbe({ enabled: true, sink: line => lines.push(line) }), context = probe.claim(); assert.ok(context);
  const root = sha(); assert.equal(probe.bindCapability(context.ordinal, root), true);
  withMobileOwnerLoadTrace(context, () => { for (let index = 0; index < 60; index++) markMobileOwnerLoadTrace('main', 'main.auth', 'ok'); });
  assert.equal(probe.snapshot().ordinaryRecords, 28, '原accept也不能挤掉关闭保留的12槽。');
  for (let index = 0; index < 20; index++) collectMobileCapabilityTrace(record(root, { epochMs: 20000 + index, stage: 'main.current' }));
  probe.publishCapabilities(); const before = lines.length; assert.equal(probe.snapshot().ordinaryRecords, 28);
  for (let index = 0; index < 12; index++) collectMobileCapabilityTrace(record(root,
    { epochMs: 21000 + index, elapsedMs: index, stage: 'main.close.content-port', phase: 'begin', role: 'cleanup' }));
  probe.publishCapabilities('close');
  assert.equal(probe.snapshot().ordinaryRecords, 40); assert.equal(lines.length - before, 12);
  const closing = parseLines(lines.slice(before));
  assert.ok(closing.every(value => value.type === 'mobile-owner-load-capability' && value.record.stage.startsWith('main.close.')));
  const after = lines.length; probe.publishCapabilities('close'); assert.equal(lines.length, after, 'close增量不重发已发布记录。');
  withMobileOwnerLoadTrace(context, () => {
    markMobileOwnerLoadTrace('main', 'main.content.scope', 'unknown');
    markMobileOwnerLoadTrace('main', 'cleanup', 'unknown', 'cleanup');
    markMobileOwnerLoadTrace('main', 'http.terminal', 'error', 'business', { status: 503, aborted: false, headersSent: true, writableFinished: true });
  });
  assert.equal(probe.snapshot().records, 43); assert.equal(probe.snapshot().bytes, lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0));
  assert.ok(probe.snapshot().records <= 64 && probe.snapshot().bytes <= 65536);
});

test('close跨全部绑定根先发布关闭拒绝和阶段，旧根延后普通记录不能抢12槽', () => {
  const lines: string[] = [], probe = createMobileOwnerLoadTraceProbe({ enabled: true, sink: line => lines.push(line) });
  const earlier = probe.claim(), closing = probe.claim(); assert.ok(earlier && closing);
  const earlierRoot = sha(), closingRoot = sha();
  assert.equal(probe.bindCapability(earlier.ordinal, earlierRoot), true); assert.equal(probe.bindCapability(closing.ordinal, closingRoot), true);
  withMobileOwnerLoadTrace(earlier, () => { for (let index = 0; index < 40; index++) markMobileOwnerLoadTrace('main', 'main.auth', 'ok'); });
  assert.equal(probe.snapshot().ordinaryRecords, 28);
  for (let index = 0; index < 20; index++) collectMobileCapabilityTrace(record(earlierRoot, { stage: 'main.current', epochMs: 31000 + index }));
  probe.publishCapabilities(); const before = lines.length;
  for (let index = 0; index < 12; index++) collectMobileCapabilityTrace(record(closingRoot,
    { stage: 'main.close.auth', phase: 'begin', role: 'cleanup', elapsedMs: index, epochMs: 32000 + index }));
  collectMobileCapabilityTrace(record(closingRoot, { stage: 'main.close.content.cleanup', phase: 'reject', role: 'cleanup',
    code: 'BUSY', outcome: 'unknown', epochMs: 33000 }));
  probe.publishCapabilities('close');
  const output = parseLines(lines.slice(before));
  assert.equal(output.length, 13); assert.ok(output.every(value => value.type === 'mobile-owner-load-capability' && value.ordinal === closing.ordinal));
  const first = output[0]; assert.ok(first && first.type === 'mobile-owner-load-capability');
  assert.equal(first.record.stage, 'main.close.content.cleanup'); assert.equal(first.record.phase, 'reject');
  assert.equal(probe.snapshot().ordinaryRecords, 40);
  const after = lines.length; probe.publishCapabilities('close'); assert.equal(lines.length, after);
});
