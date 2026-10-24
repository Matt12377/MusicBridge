import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MOBILE_OWNER_LOAD_TRACE_LIMITS, MOBILE_OWNER_LOAD_TRACE_PREFIX, MOBILE_OWNER_LOAD_TRACE_TYPE,
  captureMobileOwnerLoadTrace, copyMobileOwnerLoadTraceFrame, createMobileOwnerLoadTraceContext,
  createMobileOwnerLoadTraceProbe, isMobileOwnerLoadTraceFrame, markMobileOwnerLoadTrace,
  observeMobileOwnerLoadTrace, withMobileOwnerLoadTrace,
  type MobileOwnerLoadTraceEvent, type MobileOwnerLoadTraceFrame, type MobileOwnerLoadTraceHttp, type MobileOwnerLoadTraceContext,
} from '../src/mobile/owner-load-trace.js';

const http: MobileOwnerLoadTraceHttp = { status: 503, aborted: false, headersSent: true, writableFinished: true };
function frame(ordinal = 1, extra: Partial<MobileOwnerLoadTraceEvent> = {}): MobileOwnerLoadTraceFrame {
  return { type: MOBILE_OWNER_LOAD_TRACE_TYPE, event: { ordinal, component: 'main', stage: 'main.post',
    outcome: 'begin', role: 'business', atMs: 1000, durationMs: 0, ...extra } };
}
function decoded(lines: readonly string[]): MobileOwnerLoadTraceFrame[] {
  return lines.map(line => {
    assert.ok(line.startsWith(MOBILE_OWNER_LOAD_TRACE_PREFIX)); assert.ok(line.endsWith('\n'));
    const value = copyMobileOwnerLoadTraceFrame(JSON.parse(line.slice(MOBILE_OWNER_LOAD_TRACE_PREFIX.length)));
    assert.ok(value); return value;
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** 只模拟既有旁注顺序，不执行RPC、认证、文件读取或任何业务。 */
function completeCapabilityStages(context: MobileOwnerLoadTraceContext): void {
  type Step = readonly [MobileOwnerLoadTraceEvent['component'], MobileOwnerLoadTraceEvent['stage'], MobileOwnerLoadTraceEvent['outcome']];
  const load: readonly Step[] = [
    ['main', 'main.admission', 'ok'], ['main', 'main.post', 'begin'], ['main', 'main.post', 'ok'],
    ['core', 'core.receive', 'ok'], ['core', 'core.capture', 'begin'], ['core', 'core.capture', 'ok'],
    ['core', 'core.owner', 'begin'], ['core', 'owner.client.post', 'begin'], ['core', 'owner.client.post', 'ok'],
    ['owner', 'owner.receive', 'begin'], ['owner', 'owner.dispatch', 'begin'],
    ['owner', 'owner.load', 'begin'], ['owner', 'owner.load', 'ok'], ['owner', 'owner.dispatch', 'ok'],
    ['owner', 'owner.reply', 'ok'], ['owner', 'owner.post', 'begin'], ['owner', 'owner.post', 'ok'], ['owner', 'owner.receive', 'ok'],
    ['core', 'owner.client.receive', 'ok'], ['core', 'owner.client.capture', 'begin'], ['core', 'owner.client.capture', 'ok'],
    ['core', 'core.owner', 'ok'], ['core', 'core.result', 'begin'], ['core', 'core.result', 'ok'],
    ['core', 'core.post', 'begin'], ['core', 'core.post', 'ok'], ['main', 'main.receive', 'ok'],
    ['main', 'main.capture', 'begin'], ['main', 'main.capture', 'ok'],
  ];
  const runLoad = () => { for (const [component, stage, outcome] of load) markMobileOwnerLoadTrace(component, stage, outcome); };
  const qualify = (stage: 'main.initial-qualification' | 'main.before-send.qualification') => observeMobileOwnerLoadTrace('main', stage, () => {
    observeMobileOwnerLoadTrace('main', 'main.content.initialize', () => undefined);
    observeMobileOwnerLoadTrace('main', 'main.content.scope', () => undefined);
  });
  withMobileOwnerLoadTrace(context, () => {
    markMobileOwnerLoadTrace('main', 'http.receive');
    observeMobileOwnerLoadTrace('main', 'http.dispatch', () => {
      observeMobileOwnerLoadTrace('main', 'main.auth', runLoad);
      qualify('main.initial-qualification');
      observeMobileOwnerLoadTrace('main', 'main.encode', () => undefined);
    });
    observeMobileOwnerLoadTrace('main', 'http.capture', () => undefined);
    observeMobileOwnerLoadTrace('main', 'http.before-send.alive', runLoad);
    qualify('main.before-send.qualification');
    observeMobileOwnerLoadTrace('main', 'main.before-send.auth', runLoad);
    markMobileOwnerLoadTrace('main', 'http.terminal', 'ok', 'business', { ...http, status: 200 });
  });
}

test('Owner load旁注默认关闭：零输出、零clock、零上下文，不触碰拒收对象', () => {
  let writes = 0, clocks = 0, traps = 0;
  const probe = createMobileOwnerLoadTraceProbe({ sink() { writes++; }, now() { clocks++; throw new Error('不得调用'); }, epochNow() { clocks++; return 0; } });
  const raw = new Proxy({}, { ownKeys() { traps++; throw new Error('不得访问'); } });
  assert.equal(probe.claim(), undefined); assert.equal(probe.accept(raw), false);
  let calls = 0; const value = {};
  assert.equal(withMobileOwnerLoadTrace(undefined, () => observeMobileOwnerLoadTrace('main', 'main.post', () => { calls++; return value; })), value);
  markMobileOwnerLoadTrace('main', 'main.timeout', 'unknown');
  assert.equal(captureMobileOwnerLoadTrace(), undefined);
  assert.deepEqual(probe.snapshot(), { enabled: false, claimed: 0, records: 0, bytes: 0, ordinaryRecords: 0, suppressed: 0 });
  assert.deepEqual({ writes, clocks, traps, calls }, { writes: 0, clocks: 0, traps: 0, calls: 1 });
});

test('Owner load旁注只接已claim的临时ordinal，跨层frame冷核复制且原对象不登记权限', () => {
  const lines: string[] = [], probe = createMobileOwnerLoadTraceProbe({ enabled: true, sink: line => { lines.push(line); } });
  assert.equal(probe.accept(frame()), false);
  const context = probe.claim(); assert.ok(context); assert.equal(context.ordinal, 1);
  const original = frame(1, { component: 'core', stage: 'core.receive', outcome: 'ok' });
  const captured = copyMobileOwnerLoadTraceFrame(original); assert.ok(captured);
  assert.notEqual(captured, original); assert.notEqual(captured.event, original.event);
  assert.ok(Object.isFrozen(captured)); assert.ok(Object.isFrozen(captured.event));
  assert.equal(probe.accept(original), true); assert.equal(probe.accept(frame(2)), false);
  const owner = createMobileOwnerLoadTraceContext(context.ordinal, event => {
    assert.equal(probe.accept({ type: MOBILE_OWNER_LOAD_TRACE_TYPE, event: structuredClone(event) }), true);
  });
  assert.ok(owner);
  withMobileOwnerLoadTrace(owner, () => markMobileOwnerLoadTrace('owner', 'owner.load'));
  assert.deepEqual(decoded(lines).map(row => [row.event.ordinal, row.event.component, row.event.stage]), [[1, 'core', 'core.receive'], [1, 'owner', 'owner.load']]);
  assert.equal(createMobileOwnerLoadTraceContext(0, () => {}), undefined);
  assert.equal(createMobileOwnerLoadTraceContext(9, () => {}), undefined);
});

test('Owner load旁注40普通槽饱和后保留8组首business、首cleanup及HTTP终态，统一64条64KiB', () => {
  const lines: string[] = [], probe = createMobileOwnerLoadTraceProbe({ enabled: true, sink: line => { lines.push(line); }, now: () => 10, epochNow: () => 100 });
  const contexts = Array.from({ length: 8 }, () => { const context = probe.claim(); assert.ok(context); return context; });
  assert.equal(probe.claim(), undefined);
  withMobileOwnerLoadTrace(contexts[0], () => { for (let index = 0; index < 120; index++) markMobileOwnerLoadTrace('main', 'main.post', 'begin'); });
  assert.equal(lines.length, 40);
  for (const context of contexts) withMobileOwnerLoadTrace(context, () => {
    markMobileOwnerLoadTrace('main', 'main.timeout', 'unknown');
    markMobileOwnerLoadTrace('core', 'core.post', 'post-failed');
    markMobileOwnerLoadTrace('owner', 'cleanup', 'error', 'cleanup');
    markMobileOwnerLoadTrace('core', 'core.close', 'closed', 'cleanup');
    markMobileOwnerLoadTrace('main', 'http.terminal', 'unknown', 'business', http);
  });
  const rows = decoded(lines), snapshot = probe.snapshot();
  assert.equal(rows.length, 64); assert.equal(snapshot.records, 64); assert.equal(snapshot.claimed, 8); assert.equal(snapshot.ordinaryRecords, 40);
  assert.equal(snapshot.bytes, Buffer.byteLength(lines.join(''))); assert.ok(snapshot.bytes <= MOBILE_OWNER_LOAD_TRACE_LIMITS.bytes);
  assert.ok(lines.every(line => Buffer.byteLength(line) <= MOBILE_OWNER_LOAD_TRACE_LIMITS.recordBytes));
  for (const context of contexts) {
    const own = rows.filter(row => row.event.ordinal === context.ordinal);
    assert.equal(own.filter(row => row.event.stage === 'main.timeout' && row.event.outcome === 'unknown').length, 1);
    assert.equal(own.filter(row => row.event.stage === 'cleanup' && row.event.role === 'cleanup').length, 1);
    assert.equal(own.filter(row => row.event.stage === 'http.terminal').length, 1);
    assert.equal(own.filter(row => row.event.stage === 'core.post' || row.event.stage === 'core.close').length, 0);
  }
  for (let index = 0; index < rows.length; index++) {
    const terminal = rows[index]!.event.http;
    if (terminal) {
      assert.equal(terminal.counts?.records, index + 1);
      assert.equal(terminal.counts?.bytes, Buffer.byteLength(lines.slice(0, index + 1).join('')));
      assert.ok((terminal.counts?.suppressed ?? 0) >= 81);
    }
  }
  const before = probe.snapshot();
  withMobileOwnerLoadTrace(contexts[0], () => markMobileOwnerLoadTrace('main', 'http.terminal', 'ok', 'business', { ...http, status: 200 }));
  assert.equal(lines.length, 64); assert.equal(probe.snapshot().suppressed, before.suppressed + 1);
  assert.doesNotMatch(lines.join(''), /requestId|requestSha256|datasetId|token|headers"|body|snapshot/u);
});

test('Owner load压缩：3load与4个content等待的完整首请求恰为40普通行，HTTP终态另占保留槽', () => {
  const lines: string[] = [], probe = createMobileOwnerLoadTraceProbe({ enabled: true, sink: line => { lines.push(line); } });
  const context = probe.claim(); assert.ok(context); completeCapabilityStages(context);
  const rows = decoded(lines), snapshot = probe.snapshot();
  assert.equal(snapshot.ordinaryRecords, 40); assert.equal(snapshot.records, 41); assert.equal(snapshot.suppressed, 72);
  assert.equal(rows.length, 41); assert.ok(rows.every(row => row.event.ordinal === context.ordinal));
  const selected = (stage: MobileOwnerLoadTraceEvent['stage'], outcome: MobileOwnerLoadTraceEvent['outcome']) => rows.filter(row => row.event.stage === stage && row.event.outcome === outcome);
  for (const [stage, outcome] of [['main.post', 'begin'], ['core.receive', 'ok'], ['owner.client.post', 'begin'], ['owner.receive', 'ok'],
    ['owner.load', 'begin'], ['owner.load', 'ok'], ['core.post', 'ok'], ['main.capture', 'ok']] as const) assert.equal(selected(stage, outcome).length, 3);
  for (const stage of ['http.dispatch', 'main.auth', 'http.before-send.alive', 'main.before-send.auth'] as const) {
    assert.equal(selected(stage, 'begin').length, 1); assert.equal(selected(stage, 'ok').length, 1);
  }
  for (const stage of ['main.initial-qualification', 'main.before-send.qualification'] as const) {
    assert.equal(selected(stage, 'begin').length, 1); assert.equal(selected(stage, 'ok').length, 0);
  }
  for (const stage of ['main.content.initialize', 'main.content.scope'] as const) {
    assert.equal(selected(stage, 'begin').length, 2); assert.equal(selected(stage, 'ok').length, 0);
  }
  assert.equal(selected('main.encode', 'begin').length, 0); assert.equal(selected('main.encode', 'ok').length, 1);
  assert.equal(rows.filter(row => row.event.stage === 'http.capture').length, 0);
  assert.equal(rows.filter(row => row.event.stage === 'core.capture' || row.event.stage === 'core.result' || row.event.stage === 'owner.dispatch').length, 0);
  assert.equal(rows.at(-1)?.event.stage, 'http.terminal');
  assert.deepEqual(rows.at(-1)?.event.http?.counts, { records: 41, bytes: Buffer.byteLength(lines.join('')), suppressed: 72 });
  assert.ok(snapshot.bytes <= MOBILE_OWNER_LOAD_TRACE_LIMITS.bytes);

  // 共享普通预算耗尽后不承诺下一请求完整；仍保其首错、cleanup和真实终态。
  const next = probe.claim(); assert.ok(next);
  withMobileOwnerLoadTrace(next, () => {
    markMobileOwnerLoadTrace('main', 'http.receive');
    markMobileOwnerLoadTrace('main', 'main.post', 'begin');
    markMobileOwnerLoadTrace('main', 'http.failure', 'unknown');
    markMobileOwnerLoadTrace('core', 'core.close', 'error', 'cleanup');
    markMobileOwnerLoadTrace('main', 'http.terminal', 'unknown', 'business', http);
  });
  assert.equal(probe.snapshot().ordinaryRecords, 40); assert.equal(probe.snapshot().records, 44);
  const nextRows = decoded(lines).filter(row => row.event.ordinal === next.ordinal);
  assert.deepEqual(nextRows.map(row => [row.event.stage, row.event.outcome]), [['http.failure', 'unknown'], ['core.close', 'error'], ['http.terminal', 'unknown']]);
  assert.equal(nextRows.at(-1)?.event.http?.counts?.suppressed, 74);
});

test('Owner load压缩不吞失败：capture/failure只留错误，资格及content等待成功只留begin', () => {
  const lines: string[] = [], probe = createMobileOwnerLoadTraceProbe({ enabled: true, sink: line => { lines.push(line); } });
  const context = probe.claim(); assert.ok(context);
  withMobileOwnerLoadTrace(context, () => {
    for (const stage of ['http.capture', 'http.failure'] as const) {
      markMobileOwnerLoadTrace('main', stage, 'begin'); markMobileOwnerLoadTrace('main', stage, 'ok');
    }
    markMobileOwnerLoadTrace('main', 'http.capture', 'invalid');
    markMobileOwnerLoadTrace('main', 'http.failure', 'unknown');
    for (const stage of ['main.initial-qualification', 'main.before-send.qualification', 'main.content.initialize', 'main.content.scope'] as const) {
      markMobileOwnerLoadTrace('main', stage, 'begin'); markMobileOwnerLoadTrace('main', stage, 'ok');
    }
  });
  const rows = decoded(lines);
  assert.equal(rows.length, 6); assert.equal(probe.snapshot().ordinaryRecords, 5); assert.equal(probe.snapshot().suppressed, 8);
  assert.deepEqual(rows.slice(0, 2).map(row => [row.event.stage, row.event.outcome]), [['http.capture', 'invalid'], ['http.failure', 'unknown']]);
  assert.ok(rows.slice(2).every(row => row.event.outcome === 'begin'));
});

test('Owner load frame闭集拒绝身份、正文、额外键、访问器、代理、非法HTTP和计数，不执行getter或trap', () => {
  const good = frame(), terminal = frame(1, { stage: 'http.terminal', http });
  assert.ok(isMobileOwnerLoadTraceFrame(good)); assert.ok(isMobileOwnerLoadTraceFrame(terminal));
  const invalid: unknown[] = [
    { ...good, id: '真实RPC不可输出' }, { ...good, hash: 'a'.repeat(64) }, { ...good, extra: true },
    { ...good, event: { ...good.event, headers: [['Authorization', '秘密']] } },
    { ...good, event: { ...good.event, body: '秘密' } }, { ...good, event: { ...good.event, requestId: '秘密' } },
    frame(0), frame(9), frame(1, { atMs: NaN }), frame(1, { durationMs: Infinity }), frame(1, { durationMs: -1 }),
    { ...good, event: { ...good.event, component: 'renderer' } }, { ...good, event: { ...good.event, stage: '/private/path' } },
    { ...good, event: { ...good.event, outcome: '凭据文本' } }, { ...good, event: { ...good.event, role: 'extra' } },
    frame(1, { http }), frame(1, { stage: 'http.terminal' }), frame(1, { component: 'owner', stage: 'http.terminal', http }),
    { ...terminal, event: { ...terminal.event, http: { ...http, status: 500 } } },
    { ...terminal, event: { ...terminal.event, http: { ...http, aborted: 0 } } },
    { ...terminal, event: { ...terminal.event, http: { ...http, token: '秘密' } } },
    frame(1, { stage: 'http.terminal', http: { ...http, counts: { records: 65, bytes: 1, suppressed: 0 } } }),
    frame(1, { stage: 'http.terminal', http: { ...http, counts: { records: 1, bytes: 65537, suppressed: 0 } } }),
    Object.assign(Object.create({ inherited: true }) as object, good),
  ];
  const symbol = { ...good }; Object.defineProperty(symbol, Symbol('隐私'), { value: true }); invalid.push(symbol);
  const hidden = { ...good }; Object.defineProperty(hidden, 'secret', { value: '秘密' }); invalid.push(hidden);
  let getters = 0, traps = 0;
  const accessor = { ...good.event }; Object.defineProperty(accessor, 'stage', { enumerable: true, get() { getters++; return 'main.post'; } });
  const httpAccessor = { ...http }; Object.defineProperty(httpAccessor, 'status', { enumerable: true, get() { getters++; return 503; } });
  const counts = { records: 1, bytes: 1, suppressed: 0 }; Object.defineProperty(counts, 'bytes', { enumerable: true, get() { getters++; return 1; } });
  invalid.push({ ...good, event: accessor }, frame(1, { stage: 'http.terminal', http: httpAccessor }), frame(1, { stage: 'http.terminal', http: { ...http, counts } }));
  const proxy = (value: object) => new Proxy(value, { ownKeys() { traps++; throw new Error('不得执行'); }, getPrototypeOf() { traps++; throw new Error('不得执行'); } });
  invalid.push(proxy(good), { ...good, event: proxy(good.event) }, frame(1, { stage: 'http.terminal', http: proxy(http) as MobileOwnerLoadTraceHttp }));
  for (const value of invalid) { assert.equal(copyMobileOwnerLoadTraceFrame(value), null); assert.equal(isMobileOwnerLoadTraceFrame(value), false); }
  assert.equal(getters, 0); assert.equal(traps, 0);
});

test('Owner load时钟倒退、NaN或抛错只产生null时间，原工作返回与抛错保持不变', () => {
  const events: MobileOwnerLoadTraceEvent[] = [], times = [10, 5, NaN], epochs = [100, 90, Infinity];
  const context = createMobileOwnerLoadTraceContext(1, event => { events.push(event); }, {
    now: () => times.shift() ?? 20, epochNow: () => epochs.shift() ?? 101,
  }); assert.ok(context);
  const value = {}, result = withMobileOwnerLoadTrace(context, () => observeMobileOwnerLoadTrace('owner', 'owner.load', () => value));
  assert.equal(result, value); assert.equal(events[0]?.atMs, 100); assert.equal(events[0]?.durationMs, 0);
  assert.equal(events[1]?.atMs, null); assert.equal(events[1]?.durationMs, null);
  withMobileOwnerLoadTrace(context, () => markMobileOwnerLoadTrace('main', 'main.receive'));
  assert.equal(events[2]?.atMs, null);
  const broken = createMobileOwnerLoadTraceContext(2, event => { events.push(event); }, { now() { throw new Error('时钟'); }, epochNow() { throw new Error('时钟'); } });
  assert.ok(broken); const failure = {};
  assert.throws(() => withMobileOwnerLoadTrace(broken, () => observeMobileOwnerLoadTrace('main', 'main.capture', () => { throw failure; })), error => error === failure);
  assert.equal(events.at(-1)?.outcome, 'error'); assert.equal(events.at(-1)?.atMs, null); assert.equal(events.at(-1)?.durationMs, null);
});

test('Owner load同步sink故障、嵌套上下文及thenable不重放原工作或读取then', () => {
  let calls = 0, thenReads = 0;
  const context = createMobileOwnerLoadTraceContext(1, () => { throw new Error('诊断输出失败'); }); assert.ok(context);
  const nested = createMobileOwnerLoadTraceContext(2, () => {}); assert.ok(nested);
  const value = Object.defineProperty({}, 'then', { get() { thenReads++; throw new Error('不得同化'); } });
  const result = withMobileOwnerLoadTrace(context, () => {
    assert.equal(captureMobileOwnerLoadTrace(), context);
    withMobileOwnerLoadTrace(nested, () => { assert.equal(captureMobileOwnerLoadTrace(), nested); });
    assert.equal(captureMobileOwnerLoadTrace(), context);
    return observeMobileOwnerLoadTrace('main', 'main.post', () => { calls++; return value; });
  });
  assert.equal(result, value); assert.equal(calls, 1); assert.equal(thenReads, 0); assert.equal(captureMobileOwnerLoadTrace(), undefined);
  const failure = new Error('原业务错误');
  assert.throws(() => withMobileOwnerLoadTrace(context, () => observeMobileOwnerLoadTrace('core', 'core.owner', () => { calls++; throw failure; })), error => error === failure);
  assert.equal(calls, 2);
});

test('Owner load异步成功和拒绝保持原Promise、值、异常及并发ALS身份，日志无异常正文', async () => {
  const lines: string[] = [], probe = createMobileOwnerLoadTraceProbe({ enabled: true, sink: line => { lines.push(line); } });
  const a = probe.claim(), b = probe.claim(); assert.ok(a); assert.ok(b);
  const first = deferred<void>(), second = deferred<void>(), value = {}, failure = Object.assign(new Error('token和私密正文不得输出'), { outcome: 'unknown' });
  let calls = 0, nativeA!: Promise<object>, nativeB!: Promise<never>;
  const resultA = withMobileOwnerLoadTrace(a, () => {
    nativeA = first.promise.then(() => { assert.equal(captureMobileOwnerLoadTrace(), a); return value; });
    return observeMobileOwnerLoadTrace('owner', 'owner.load', () => { calls++; return nativeA; });
  });
  const resultB = withMobileOwnerLoadTrace(b, () => {
    nativeB = second.promise.then(() => { assert.equal(captureMobileOwnerLoadTrace(), b); throw failure; });
    return observeMobileOwnerLoadTrace('owner', 'owner.load', () => { calls++; return nativeB; }, 'cleanup');
  });
  assert.equal(resultA, nativeA); assert.equal(resultB, nativeB); assert.equal(captureMobileOwnerLoadTrace(), undefined);
  const rejected = assert.rejects(resultB, error => error === failure); second.resolve(); await rejected;
  first.resolve(); assert.equal(await resultA, value); assert.equal(calls, 2);
  const rows = decoded(lines);
  assert.deepEqual(rows.filter(row => row.event.ordinal === 1).map(row => row.event.outcome), ['begin', 'ok']);
  assert.deepEqual(rows.filter(row => row.event.ordinal === 2).map(row => row.event.outcome), ['begin', 'unknown']);
  assert.equal(rows.at(-1)?.event.ordinal, 1); assert.doesNotMatch(lines.join(''), /私密|token|message|stack/u);
});

test('Owner load sink抛错仍占预算且不重发，HTTP终态仅一行计数且无默认stdout依赖', () => {
  let attempts = 0;
  const probe = createMobileOwnerLoadTraceProbe({ enabled: true, sink() { attempts++; throw new Error('诊断故障'); } });
  const context = probe.claim(); assert.ok(context);
  const value = {};
  assert.equal(withMobileOwnerLoadTrace(context, () => observeMobileOwnerLoadTrace('owner', 'owner.load', () => value)), value);
  withMobileOwnerLoadTrace(context, () => markMobileOwnerLoadTrace('main', 'http.terminal', 'unknown', 'business', { ...http, status: null, headersSent: false, writableFinished: false }));
  assert.equal(attempts, 3); assert.equal(probe.snapshot().records, 3); assert.equal(probe.snapshot().suppressed, 3);
  withMobileOwnerLoadTrace(context, () => markMobileOwnerLoadTrace('main', 'http.terminal', 'ok', 'business', http));
  assert.equal(attempts, 3); assert.equal(probe.snapshot().records, 3); assert.equal(probe.snapshot().suppressed, 4);
  const silent = createMobileOwnerLoadTraceProbe({ enabled: true }); assert.ok(silent.claim()); assert.equal(silent.accept(frame()), true);
});
