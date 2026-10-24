import assert from 'node:assert/strict';
import test from 'node:test';
import { createMobileRangeWindowProbe, copyMobileRangeWindowSnapshot,
  mobileRangeWindowObserve, withMobileRangeWindowContext, createMobileRangeWindowTraceWriter,
  copyMobileRangeWindowTraceFrame, MOBILE_RANGE_WINDOW_TRACE_PREFIX, mobileRangeWindowRpc,
  createMobileRangeWindowCoreReceiver, copyMobileRangeWindowSeed, copyMobileRangeWindowCoreFrame,
  mobileRangeWindowCoreObserve, mobileRangeWindowCoreFacts, type MobileRangeWindowSnapshot } from '../../src/mobile/range-window-observer.js';

const request = (ordinal = 1, length = 262144) => ({
  requestId: `${ordinal.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`,
  method: 'GET', operation: 'getMediaAsset', range: `bytes=0-${length - 1}`,
});
const epochMs = 1800000000000;

test('M32 只认领固定首64KiB及256KiB；前台metadata/预热失败不消耗八个媒体窗口', () => {
  const probe = createMobileRangeWindowProbe({ enabled: true, epochNow: () => epochMs });
  for (let index = 0; index < 512; index++) {
    assert.equal(probe.claim({ ...request(), operation: 'createSession' }), undefined);
    assert.equal(probe.claim({ ...request(), operation: 'getUIContentCapabilities' }), undefined);
  }
  for (const length of [1, 2, 65535, 65537, 262143, 262145]) assert.equal(probe.claim(request(1, length)), undefined);
  for (let index = 0; index < 8; index++) assert.ok(probe.claim(request(index + 1, index % 2 ? 262144 : 65536)));
  assert.equal(probe.claim(request(9, 65536)), undefined);
  const snapshot = probe.snapshot();
  assert.deepEqual(snapshot.requests.map(row => row.length), [65536, 262144, 65536, 262144, 65536, 262144, 65536, 262144]);
  assert.equal(snapshot.maxRequests, 8); assert.equal(snapshot.maxRecords, 512);
  assert.equal(snapshot.maxSerializedBytes, 262144); assert.ok(copyMobileRangeWindowSnapshot(snapshot));
});

test('M32 窗口出口保留原HTTP终态、pending与迟到cleanup；绝不把206或HTTP退场当物理quiet', async () => {
  const observed: { reason: string; ordinal: number; snapshot: MobileRangeWindowSnapshot }[] = [];
  const options = { enabled: true, epochNow: () => epochMs,
    windowSink(snapshot: MobileRangeWindowSnapshot, reason: string, ordinal: number) {
      observed.push({ snapshot, reason, ordinal });
    } };
  const probe = createMobileRangeWindowProbe(options);
  const context = probe.claim(request()); assert.ok(context);
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const original = withMobileRangeWindowContext(context, () => mobileRangeWindowObserve('reader.close', () => gate, 'cleanup'));
  assert.strictEqual(original, gate);
  probe.finish(context, { status: 206, finished: false, failed: false });
  assert.deepEqual(observed.map(row => row.reason), ['claim', 'http-terminal']);
  assert.equal(observed[1]!.snapshot.requests[0]!.httpTerminal, true);
  assert.equal(observed[1]!.snapshot.requests[0]!.responseFinished, false);
  assert.equal(observed[1]!.snapshot.requests[0]!.pendingSpans, 1);
  finish(); await original;
  assert.deepEqual(observed.map(row => row.reason), ['claim', 'http-terminal', 'late-settled']);
  assert.equal(observed[2]!.snapshot.requests[0]!.pendingSpans, 0);
  assert.equal(observed[1]!.snapshot.requests[0]!.pendingSpans, 1, '已发出的副本不得被迟到清理改写');
  for (const row of observed) assert.ok(copyMobileRangeWindowSnapshot(row.snapshot));
});

test('M32 writer默认关闭不读输入；开启只输出闭集哈希和固定阶段，sink异常不重放业务', async () => {
  let reads = 0, writes = 0, calls = 0;
  const bad = new Proxy({}, { get() { reads++; throw new Error('私密正文'); }, ownKeys() { reads++; return []; } });
  createMobileRangeWindowTraceWriter({ enabled: false, sink() { writes++; } })(bad, 'claim', 1);
  assert.equal(reads, 0); assert.equal(writes, 0);
  const lines: string[] = [], writer = createMobileRangeWindowTraceWriter({ enabled: true, sink: line => lines.push(line) });
  const probe = createMobileRangeWindowProbe({ enabled: true, epochNow: () => epochMs, windowSink: writer });
  const context = probe.claim(request(1, 65536)); assert.ok(context);
  const original = Promise.resolve('原结果');
  assert.strictEqual(withMobileRangeWindowContext(context, () => mobileRangeWindowObserve('sender.read', () => { calls++; return original; })), original);
  await original;
  probe.finish(context, { status: 206, finished: false, failed: false });
  assert.equal(calls, 1); assert.equal(lines.length, 2);
  const rows = lines.map(line => copyMobileRangeWindowTraceFrame(JSON.parse(line.slice(MOBILE_RANGE_WINDOW_TRACE_PREFIX.length))));
  assert.ok(rows.every(Boolean)); assert.deepEqual(rows.map(row => row!.observation), ['open', 'terminal-settled']);
  assert.equal(rows[1]!.request!.responseFinished, false);
  assert.equal(rows[1]!.request!.length, 65536); assert.equal(rows[1]!.request!.httpStatus, 206);
  assert.doesNotMatch(lines.join(''), /11111111-1111|https?:|Cookie|私密|url|stack|trackId/);
  const throwing = createMobileRangeWindowTraceWriter({ enabled: true, sink() { writes++; throw new Error('私密错误'); } });
  throwing(probe.snapshot(), 'http-terminal', 1); throwing(probe.snapshot(), 'http-terminal', 1);
  assert.equal(writes, 1, '写失败也消耗该阶段预算，不重试');
});

test('M32 writer/guard拒绝getter、Proxy、Symbol、原型、额外字段和超界；坏行不消耗窗口', () => {
  const probe = createMobileRangeWindowProbe({ enabled: true, epochNow: () => epochMs });
  const context = probe.claim(request()); assert.ok(context); probe.finish(context, { status: 206, finished: true, failed: false });
  const lines: string[] = [], writer = createMobileRangeWindowTraceWriter({ enabled: true, sink: line => lines.push(line) });
  let getters = 0;
  const accessor = { ...probe.snapshot() }; Object.defineProperty(accessor, 'requests', { enumerable: true, get() { getters++; return []; } });
  writer(accessor, 'http-terminal', 1);
  writer(new Proxy(probe.snapshot(), { get() { getters++; throw new Error('私密'); } }), 'http-terminal', 1);
  writer({ ...probe.snapshot(), [Symbol('私密')]: '私密' }, 'http-terminal', 1);
  assert.equal(lines.length, 0); assert.equal(getters, 0);
  writer(probe.snapshot(), 'http-terminal', 1); assert.equal(lines.length, 1);
  const frame = JSON.parse(lines[0]!.slice(MOBILE_RANGE_WINDOW_TRACE_PREFIX.length));
  const rowGetter = structuredClone(frame); Object.defineProperty(rowGetter.request.records[0], 'stage', { enumerable: true, get() { getters++; return 'sender.read'; } });
  const arrayGetter = structuredClone(frame); Object.defineProperty(arrayGetter.request.records, '0', { enumerable: true, get() { getters++; return null; } });
  for (const invalid of [rowGetter, arrayGetter, new Proxy(frame, { get() { getters++; return null; } }),
    { ...frame, url: '私密' }, { ...frame, [Symbol('私密')]: 1 }, Object.assign(Object.create({}), frame),
    { ...frame, sequence: 26 }, { ...frame, emittedRecords: 513 }, { ...frame, maxSerializedBytes: 262145 },
    { ...frame, observation: 'body-complete' }, { ...frame, request: { ...frame.request, length: 65537 } },
    { ...frame, request: { ...frame.request, records: Array(65).fill(frame.request.records[0]) } },
    { ...frame, request: { ...frame.request, requestSha256: 'a'.repeat(262144) } }]) assert.equal(copyMobileRangeWindowTraceFrame(invalid), null);
  assert.equal(getters, 0);
});

test('M32 writer累计512记录/256KiB封顶并显式耗尽；无HTTPterminal的claim不能称完成', async () => {
  const lines: string[] = [], writer = createMobileRangeWindowTraceWriter({ enabled: true, sink: line => lines.push(line) });
  const probe = createMobileRangeWindowProbe({ enabled: true, epochNow: () => epochMs, windowSink: writer });
  for (let index = 0; index < 8; index++) {
    const context = probe.claim(request(index + 1, index % 2 ? 262144 : 65536)); assert.ok(context);
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    withMobileRangeWindowContext(context, () => mobileRangeWindowObserve('reader.close', () => gate, 'cleanup'));
    for (let span = 0; span < 80; span++) await withMobileRangeWindowContext(context, () => mobileRangeWindowObserve('source.read.composite', () => Promise.resolve()));
    probe.finish(context, { status: 206, finished: true, failed: false });
    finish(); await gate;
  }
  const rows = lines.map(line => copyMobileRangeWindowTraceFrame(JSON.parse(line.slice(MOBILE_RANGE_WINDOW_TRACE_PREFIX.length))));
  assert.ok(rows.every(Boolean)); assert.ok(lines.length <= 25); assert.ok(Buffer.byteLength(lines.join('')) <= 262144);
  assert.ok(rows.reduce((count, row) => count + (row!.request?.records.length ?? 0), 0) <= 512);
  assert.equal(rows.at(-1)!.reason, 'budget'); assert.equal(rows.at(-1)!.observation, 'budget-exhausted');
  assert.equal(rows.at(-1)!.request, null); assert.equal(rows.at(-1)!.truncated, true);
  assert.ok(rows.filter(row => row!.reason === 'claim').every(row => row!.observation === 'open' && !row!.request!.httpTerminal));
});

test('M32 Core旁注只在固定Range私有sink内seed；16 RPC/窗口有界且禁用不创建Core上下文', async () => {
  const noSink = createMobileRangeWindowProbe({ enabled: true, epochNow: () => epochMs });
  const offContext = noSink.claim(request()); assert.ok(offContext);
  assert.equal(withMobileRangeWindowContext(offContext, () => mobileRangeWindowRpc(request(2).requestId, 'read', 'business', 'content.rpc.retained')!.seed()), undefined);
  let calls = 0, outputs = 0;
  const core = createMobileRangeWindowCoreReceiver({ sink() { outputs++; } });
  const original = Promise.resolve('原RPC');
  assert.strictEqual(core.run(request().requestId, 'read', () => { calls++; return original; }), original);
  assert.equal(await original, '原RPC'); assert.equal(calls, 1); assert.equal(outputs, 0);
  const probe = createMobileRangeWindowProbe({ enabled: true, epochNow: () => epochMs, windowSink() {} });
  const context = probe.claim(request()); assert.ok(context);
  const seeds = Array.from({ length: 17 }, (_, index) => withMobileRangeWindowContext(context,
    () => mobileRangeWindowRpc(request(index + 2).requestId, 'read', 'business', 'content.rpc.retained')!.seed()));
  assert.ok(seeds.slice(0, 16).every(Boolean)); assert.equal(seeds[16], undefined);
  assert.equal(probe.snapshot().requests[0]!.droppedRecords, 1);
  let getters = 0;
  const getter = { ...seeds[0]! }; Object.defineProperty(getter, 'operation', { enumerable: true, get() { getters++; return 'read'; } });
  for (const raw of [getter, new Proxy(seeds[0]!, { get() { getters++; return null; } }), { ...seeds[0], extra: '私密' },
    { ...seeds[0], ordinal: 9 }, { ...seeds[0], operation: 'prepare' }]) assert.equal(copyMobileRangeWindowSeed(raw), null);
  assert.equal(getters, 0);
});

test('M32 原nonce和选中HTTP哈希双绑定；Core三段及65次ticket/facts合成计时可关联，授权次数不变', async () => {
  let clock = 0, auth = 0, facts = 0, calls = 0;
  const probe = createMobileRangeWindowProbe({ enabled: true, now: () => ++clock, epochNow: () => epochMs, windowSink() {} });
  const context = probe.claim(request()); assert.ok(context);
  const frames: unknown[] = [];
  for (let operationIndex = 0; operationIndex < 5; operationIndex++) {
    const operation = operationIndex === 0 ? 'verify' : 'read';
    const nonce = request(operationIndex + 2).requestId;
    const transport = withMobileRangeWindowContext(context, () => mobileRangeWindowRpc(nonce, operation, 'business', 'content.rpc.retained'))!;
    const seed = transport.seed(); assert.ok(seed);
    const receiver = createMobileRangeWindowCoreReceiver({ now: () => ++clock, epochNow: () => epochMs,
      sink(frame) { frames.push(frame); transport.coreFrame(frame); } });
    receiver.acceptSeed(structuredClone(seed));
    const result = receiver.run(nonce, operation, async () => {
      calls++;
      await mobileRangeWindowCoreObserve('core.source.scope.before', async () => { auth++; });
      const output = await mobileRangeWindowCoreObserve('core.source.execute', async () => {
        for (let index = 0; index < (operationIndex === 0 ? 5 : 15); index++) mobileRangeWindowCoreFacts(() => { facts++; });
        return '原来源结果';
      });
      await mobileRangeWindowCoreObserve('core.source.scope.after', async () => { auth++; }); return output;
    });
    assert.equal(await result, '原来源结果'); transport.settle(nonce);
    transport.coreFrame({ ...frames.at(-1) as object, requestSha256: 'f'.repeat(64) });
  }
  probe.finish(context, { status: 206, finished: true, failed: false });
  assert.equal(calls, 5); assert.equal(auth, 10); assert.equal(facts, 65);
  const snapshot = probe.snapshot(), row = snapshot.requests[0]!;
  assert.ok(copyMobileRangeWindowSnapshot(snapshot));
  assert.equal(row.pendingSpans, 0); assert.equal(snapshot.unmatchedFrames, 5);
  assert.equal(row.records.find(record => record.stage === 'core.source.execute' && record.kind === 'read')!.count, 4);
  assert.equal(row.records.filter(record => record.stage === 'core.source.ticket-facts.composite').reduce((sum, record) => sum + record.count, 0), 65);
  assert.ok(frames.every(frame => copyMobileRangeWindowCoreFrame(frame)));
  assert.equal(row.requestSha256, seedHash());
  function seedHash() { return context!.requestSha256; }
});

test('M32 Core超时退场仍保留pending；迟到close只补第二帧，原首错和返回值不变', async () => {
  const lines: string[] = [], writer = createMobileRangeWindowTraceWriter({ enabled: true, sink: line => lines.push(line) });
  const probe = createMobileRangeWindowProbe({ enabled: true, epochNow: () => epochMs, windowSink: writer });
  const context = probe.claim(request(1, 65536)); assert.ok(context);
  const nonce = request(2).requestId;
  const transport = withMobileRangeWindowContext(context, () => mobileRangeWindowRpc(nonce, 'close-read', 'cleanup', 'content.rpc.retained'))!;
  const seed = transport.seed(); assert.ok(seed);
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const coreFrames: unknown[] = [], receiver = createMobileRangeWindowCoreReceiver({ epochNow: () => epochMs,
    sink(frame) { coreFrames.push(frame); transport.coreFrame(frame); } });
  receiver.acceptSeed(seed);
  assert.equal(await receiver.run(nonce, 'close-read', async () => {
    mobileRangeWindowCoreObserve('core.source.execute', () => gate); return '原UNKNOWN';
  }), '原UNKNOWN');
  transport.settle(nonce, true, { code: 'TIMEOUT' });
  probe.finish(context, { status: null, finished: false, failed: true, error: { code: 'TIMEOUT' } });
  const pending = probe.snapshot().requests[0]!; assert.equal(pending.pendingSpans, 1);
  assert.equal(pending.firstCleanupFailure?.code, 'TIMEOUT');
  assert.equal(lines.length, 2);
  finish(); await gate;
  const settled = probe.snapshot().requests[0]!;
  assert.equal(settled.pendingSpans, 0); assert.deepEqual(settled.firstCleanupFailure, pending.firstCleanupFailure);
  assert.equal(coreFrames.length, 2); assert.equal(lines.length, 3);
  assert.equal(JSON.parse(lines[1]!.slice(MOBILE_RANGE_WINDOW_TRACE_PREFIX.length)).observation, 'terminal-pending');
  assert.equal(JSON.parse(lines[2]!.slice(MOBILE_RANGE_WINDOW_TRACE_PREFIX.length)).reason, 'late-settled');
  assert.ok(copyMobileRangeWindowSnapshot(probe.snapshot()));
});

test('M32 Core入站完整guard拒绝getter/Proxy/毒字段、错nonce、重复stage与伪完成；异常正文不进入闭集', async () => {
  const seed = { type: 'mobile-range-window-seed', schema: 1, id: request().requestId,
    requestSha256: 'a'.repeat(64), ordinal: 1, operation: 'read' };
  let frame: unknown;
  const receiver = createMobileRangeWindowCoreReceiver({ epochNow: () => epochMs, sink: raw => { frame = raw; } });
  receiver.acceptSeed(seed);
  const original = new Error('https://private.invalid Cookie=private /Users/private'); Object.assign(original, { code: 'SOURCE_CHANGED' });
  await assert.rejects(receiver.run(seed.id, 'read', () => mobileRangeWindowCoreObserve('core.source.execute', async () => {
    mobileRangeWindowCoreFacts(() => {}); throw original;
  })), error => error === original);
  const valid = copyMobileRangeWindowCoreFrame(frame); assert.ok(valid);
  assert.equal(valid.records.find(row => row.stage === 'core.source.execute')!.code, 'SOURCE_CHANGED');
  assert.doesNotMatch(JSON.stringify(valid), /https?:|Cookie|private|stack|message/);
  let getters = 0;
  const getter = structuredClone(valid); Object.defineProperty(getter.records[0], 'durationMs', { enumerable: true, get() { getters++; return 0; } });
  const arrayGetter = structuredClone(valid); Object.defineProperty(arrayGetter.records, '0', { enumerable: true, get() { getters++; return null; } });
  for (const raw of [getter, arrayGetter, new Proxy(valid, { get() { getters++; return null; } }),
    { ...valid, extra: '私密' }, { ...valid, [Symbol('私密')]: '私密' }, Object.assign(Object.create({}), valid),
    { ...valid, id: request(2).requestId }, { ...valid, operation: 'verify' }, { ...valid, revision: 3 },
    { ...valid, records: Array(5).fill(valid.records[0]) }, { ...valid, records: [valid.records[0], valid.records[0]] },
    { ...valid, records: [{ ...valid.records[0]!, count: 4097, settledCount: 4097 }] },
    { ...valid, revision: 2, pendingSpans: 1, records: [{ ...valid.records[0]!, phase: 'pending', code: 'NONE', count: 1,
      settledCount: 0, pendingCount: 1, durationMs: null }] }]) assert.equal(copyMobileRangeWindowCoreFrame(raw), null);
  assert.equal(getters, 0);
});
