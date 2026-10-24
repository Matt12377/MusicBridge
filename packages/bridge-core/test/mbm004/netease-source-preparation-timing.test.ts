import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { MobileTrack } from '@music-bridge/contracts';
import {
  MOBILE_CAPABILITY_TRACE_PREFIX, closeMobileCapabilityContext, copyMobileCapabilityTraceRecord,
  copyMobilePreparationSnapshot, createMobileCapabilityContext, createMobilePreparationProbe,
  mobileCapabilityAsync, mobileCapabilityReject, mobileCapabilitySync, observeMobileSourcePreparationTrace, withMobileCapabilityContext,
  type MobileCapabilityTraceRecord,
} from '../../src/mobile/capability-trace.js';
import { createMobileNeteaseSourceService } from '../../src/mobile/netease-source-service.js';
import { MobilePlaybackError } from '../../src/mobile/playback-types.js';
import type { MobileContentScope } from '../../src/mobile/content-types.js';
import type { MobileNeteaseStreamLease } from '../../src/mobile/netease-source-types.js';

const scope: MobileContentScope = { serverId: 'server-1', datasetId: 'dataset-1', deviceId: 'device-1',
  deviceEpoch: 1, accessGeneration: 1, ownerEpoch: 'owner-1', accountDomain: 'account-1', providerEpoch: 'provider-1' };
const selection = { resourceId: '00000000-0000-4000-8000-000000000001', trackId: 'track-1', versionId: 'version-1', contentRevision: 'content-1' };
const steps = ['scope', 'catalog', 'current', 'open', 'capture-lease', 'verify-before', 'audio-read', 'audio-close', 'verify-after', 'ready-current'];

// 合成lease经真实Source服务与FLAC头解析；不代表真实Provider或网络计时。
function fixture() {
  let at = 0, released = 0, readCount = 0, clockCalls = 0;
  const calls: string[] = [];
  let failAt: 'catalog' | 'read' | 'close' | undefined;
  let held: Promise<void> | undefined;
  const fresh = async () => {
    for (let index = 0; index < 6; index++) await mobileCapabilityAsync('core.assert.account', async () => { calls.push('fresh-account'); });
  };
  const data = Buffer.alloc(4096); data.write('fLaC'); data[4] = 0x80; data.writeUIntBE(34, 5, 3);
  data.writeUInt16BE(4096, 8); data.writeUInt16BE(4096, 10);
  data.writeBigUInt64BE(192000n << 44n | 1n << 41n | 23n << 36n | 192000n, 18);
  const track: MobileTrack = { id: 'track-1', source: 'netease', sourceItemId: 'song-1', albumId: 'album-1', title: '合成曲',
    artists: ['合成艺人'], versionId: 'version-1', contentRevision: 'content-1', editionLabel: '原发行', durationMs: 1000,
    audio: { codec: 'flac', container: 'flac', sampleRateHz: 192000, bitsPerSample: 24, channels: 2 }, availability: 'available' };
  const failure = new MobilePlaybackError(409, 'SOURCE_CHANGED');
  const lease: MobileNeteaseStreamLease = { account: { accountDomain: 'account-1', providerEpoch: 'provider-1' },
    selection: { trackId: 'track-1', source: 'netease', versionId: 'version-1', contentRevision: 'content-1' }, sourceIdentity: 'source-1',
    size: data.length, expiresAtMs: 301000, rangeSupported: true,
    async verify() { calls.push('verify'); await fresh(); at += 13; },
    async renew() { calls.push('renew'); return { expiresAtMs: 301000 }; },
    async read(_id, start, length) { calls.push('read'); readCount++; await fresh(); at += 23; if (failAt === 'read') throw failure; return data.subarray(start, start + length); },
    async closeRead() { calls.push('close-read'); at += 7; if (failAt === 'close') throw failure; },
    async release() { calls.push('release'); released++; },
  };
  const service = createMobileNeteaseSourceService({
    account: { async current() { calls.push('account'); return { accountDomain: 'account-1', providerEpoch: 'provider-1' }; } },
    catalog: { async resolveTrack() { calls.push('catalog'); await fresh(); if (held) await held; at += 41; if (failAt === 'catalog') throw failure; return track; }, async resolveAlbum() { throw failure; } },
    streams: { async open() { calls.push('open'); await fresh(); at += 59; return lease; } },
    async assertCurrent() { calls.push('scope-current'); await fresh(); }, isQualified: () => true, nowMs: () => 1000,
  });
  return { service, port: service.bind(scope), calls, failure, readCount: () => readCount, released: () => released,
    advance: (n: number) => { at += n; }, clock: { now: () => { clockCalls++; return at; }, epochNow: () => 100000 + at },
    clockCalls: () => clockCalls, fail: (value: typeof failAt) => { failAt = value; }, hold: (value: Promise<void>) => { held = value; } };
}

function decode(lines: string[]) {
  return lines.map(line => { assert.ok(line.startsWith(MOBILE_CAPABILITY_TRACE_PREFIX));
    const value = copyMobileCapabilityTraceRecord(JSON.parse(line.slice(MOBILE_CAPABILITY_TRACE_PREFIX.length))); assert.ok(value); return value; });
}
async function run(enabled: boolean, sinkThrows = false, replay = false) {
  const f = fixture(), lines: string[] = [], controller = new AbortController();
  const context = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, controller.signal,
    line => { lines.push(line); if (sinkThrows) throw new Error('合成sink失败'); }, f.clock); assert.ok(context);
  if (enabled) context.privateContentDiagnostic = true;
  const result = await withMobileCapabilityContext(context, async () => {
    mobileCapabilitySync('core.dispatch.admission', () => undefined);
    const value = await mobileCapabilityAsync('core.provider.read', () => f.port.prepare(selection, controller.signal));
    if (replay) assert.deepEqual(await f.port.prepare(selection, controller.signal), value);
    mobileCapabilitySync('core.dispatch.reply.capture', () => undefined); return value;
  });
  closeMobileCapabilityContext(context); await f.service.close();
  return { f, result, rows: decode(lines), lines };
}

test('M62真实Source准备在廉价断言饱和后仍收口catalog/open/audio-read/verify及outer/reply，调用黄金不变', async () => {
  const baseline = await run(false, false, true), timed = await run(true, false, true);
  assert.deepEqual(timed.result, baseline.result); assert.deepEqual(timed.f.calls, baseline.f.calls);
  assert.equal(timed.f.readCount(), baseline.f.readCount()); assert.equal(timed.f.released(), 1);
  for (const name of [...steps, 'replay']) {
    const stage = 'provider.source.prepare.' + name;
    assert.ok(timed.rows.some(row => row.stage === stage && row.phase === 'begin'), stage + ':begin');
    assert.ok(timed.rows.some(row => row.stage === stage && row.phase === 'ok'), stage + ':ok');
  }
  for (const stage of ['core.provider.read', 'core.dispatch.reply.capture']) assert.ok(timed.rows.some(row => row.stage === stage && row.phase === 'ok'));
  assert.ok(timed.rows.length <= 64);
  assert.ok(timed.rows.some(row => row.stage === 'provider.source.prepare.trace-truncated' && row.phase === 'cache'));
  assert.equal(timed.rows.filter(row => row.stage === 'provider.source.prepare.trace-truncated').length, 1);
  assert.equal(baseline.rows.some(row => row.stage.startsWith('provider.source.prepare.')), false);
  assert.ok(timed.rows.filter(row => row.stage === 'core.assert.account' && row.phase === 'ok').length <= 4);
  const duration = (name: string) => { const rows = timed.rows.filter(row => row.stage === 'provider.source.prepare.' + name);
    return rows.find(row => row.phase === 'ok')!.elapsedMs - rows.find(row => row.phase === 'begin')!.elapsedMs; };
  assert.equal(duration('catalog'), 41); assert.equal(duration('open'), 59); assert.ok(duration('audio-read') >= 23);
  assert.doesNotMatch(timed.lines.join(''), /合成曲|source-1|track-1|version-1|message|stack|https?:/u);
});

test('M62抑制标记只在显式Main→Core父链传播resource截断，仍通过原闭集guard', async () => {
  const f = fixture(), probe = createMobilePreparationProbe({ enabled: true, ...f.clock }); probe.arm();
  const root = probe.claim('createResource', randomUUID(), new AbortController().signal); assert.ok(root);
  const id = randomUUID();
  const child = createMobileCapabilityContext(id, 'main', 'content', root.requestSha256, undefined,
    root.sink, f.clock); assert.ok(child);
  // Main边通过根自身sink进入collector，Core记录仍走原acceptCoreTrace。
  const mainLines: MobileCapabilityTraceRecord[] = [];
  const pair = createMobileCapabilityContext(id, 'core', 'content', null, undefined,
    line => { const row = copyMobileCapabilityTraceRecord(JSON.parse(line.slice(MOBILE_CAPABILITY_TRACE_PREFIX.length))); assert.ok(row); mainLines.push(row); probe.acceptCoreTrace(row); }, f.clock); assert.ok(pair); pair.privateContentDiagnostic = true;
  // 真实父边需有独立content request hash，不能用时间邻近关联。
  await withMobileCapabilityContext(child, () => mobileCapabilityAsync('content.rpc.source', () =>
    withMobileCapabilityContext(pair, () => mobileCapabilityAsync('core.provider.read', () => f.port.prepare(selection, new AbortController().signal)))));
  probe.finish(root, { failed: false, finished: true, httpStatus: 201 }); closeMobileCapabilityContext(pair); closeMobileCapabilityContext(child); closeMobileCapabilityContext(root);
  const snap = probe.snapshot();
  assert.ok(mainLines.some(row => row.stage === 'provider.source.prepare.trace-truncated'));
  assert.equal(snap.truncated, true); assert.ok(snap.resourceScopes[0]!.trace.droppedRecords >= 1); assert.ok(copyMobilePreparationSnapshot(snap));
  await f.service.close();
});

test('M62关闭诊断、关闭context及同步抛错均只执行一次，默认路径不新增clock/sink', async () => {
  const f = fixture(); await f.port.prepare(selection, new AbortController().signal); await f.service.close();
  assert.equal(f.clockCalls(), 0);
  for (const mode of ['off', 'closed', 'wrong-stage'] as const) {
    let clocks = 0, sinks = 0, calls = 0;
    const context = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, undefined,
      () => { sinks++; }, { now: () => { clocks++; return 0; } }); assert.ok(context);
    if (mode !== 'off') context.privateContentDiagnostic = true;
    if (mode === 'closed') closeMobileCapabilityContext(context);
    const baseline = clocks, failure = new Error('原异常'), original = Promise.resolve(17);
    withMobileCapabilityContext(context, () => {
      assert.throws(() => observeMobileSourcePreparationTrace(mode === 'wrong-stage' ? 'main.auth' : 'provider.source.prepare.catalog', () => { calls++; throw failure; }), error => error === failure);
      assert.equal(observeMobileSourcePreparationTrace(mode === 'wrong-stage' ? 'main.auth' : 'provider.source.prepare.catalog', () => original), original);
    });
    assert.equal(calls, 1); assert.equal(clocks, baseline); assert.equal(sinks, 0); closeMobileCapabilityContext(context);
  }
});

test('M62 sink故障不改真实Source返回、fresh调用或lease关闭，观察Promise不替换原Promise', async () => {
  const expected = await run(true), broken = await run(true, true);
  assert.deepEqual(broken.result, expected.result); assert.deepEqual(broken.f.calls, expected.f.calls);
  assert.equal(broken.f.released(), 1);
  const lines: string[] = [], context = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, undefined, line => lines.push(line)); assert.ok(context);
  context.privateContentDiagnostic = true;
  const original = Promise.resolve(23);
  assert.equal(withMobileCapabilityContext(context, () => observeMobileSourcePreparationTrace('provider.source.prepare.catalog', () => original)), original);
  await original; closeMobileCapabilityContext(context);
  assert.deepEqual(decode(lines).map(row => row.phase), ['begin', 'ok']);
});

test('M62饱和后首SOURCE_CHANGED与cleanup拒绝仍在原64内，原失败/quiet规则不变', async () => {
  for (const failureAt of ['catalog', 'read', 'close'] as const) {
    const f = fixture(), lines: string[] = [], context = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, undefined, line => lines.push(line), f.clock); assert.ok(context);
    context.privateContentDiagnostic = true; f.fail(failureAt);
    await withMobileCapabilityContext(context, async () => {
      await assert.rejects(f.port.prepare(selection, new AbortController().signal), error => error === f.failure);
      for (let index = 0; index < 100; index++) mobileCapabilitySync('core.provider.capture', () => undefined);
      mobileCapabilityReject('core.rpc.failure', new MobilePlaybackError(503, 'BUSY'), 'cleanup');
    });
    const rows = decode(lines), first = rows.find(row => row.phase === 'reject' && row.role === 'business');
    assert.equal(first?.stage, failureAt === 'catalog' ? 'provider.source.prepare.catalog' : failureAt === 'read' ? 'provider.source.prepare.audio-read' : 'provider.source.prepare.audio-close');
    assert.equal(first.code, 'SOURCE_CHANGED');
    assert.ok(rows.some(row => row.stage === 'core.rpc.failure' && row.role === 'cleanup' && row.phase === 'reject'));
    assert.ok(rows.length <= 64); closeMobileCapabilityContext(context);
    if (failureAt === 'close') { assert.equal(f.service.resourceSnapshot().fatal, true); await assert.rejects(f.service.close()); }
    else await f.service.close();
  }
});

test('M62取消及关闭后的迟到catalog不继续open或输出成功，原调用不被诊断重放', async () => {
  const f = fixture(), lines: string[] = [], controller = new AbortController();
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); f.hold(held);
  const context = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, controller.signal, line => lines.push(line), f.clock); assert.ok(context);
  context.privateContentDiagnostic = true;
  const pending = withMobileCapabilityContext(context, () => f.port.prepare(selection, controller.signal));
  while (!f.calls.includes('catalog')) await new Promise<void>(resolve => setImmediate(resolve));
  controller.abort(); await assert.rejects(pending); closeMobileCapabilityContext(context);
  const count = lines.length; release(); await f.service.close();
  assert.equal(lines.length, count); assert.equal(f.calls.filter(value => value === 'catalog').length, 1);
  assert.equal(f.calls.includes('open'), false); assert.equal(f.service.resourceSnapshot().live, 0);
});

test('M62省略标记严格限定Core/cache/OK闭集，原十五字段拒绝getter/Proxy/额外payload', async () => {
  const { rows } = await run(true), marker = rows.find(row => row.stage === 'provider.source.prepare.trace-truncated'); assert.ok(marker);
  assert.equal(Object.keys(marker).length, 15);
  for (const altered of [{ phase: 'ok' }, { component: 'main' }, { role: 'cleanup' }, { code: 'BUSY' }, { rawValue: '不允许内容' }]) {
    assert.equal(copyMobileCapabilityTraceRecord({ ...marker, ...altered }), null);
  }
  let traps = 0;
  const getter = Object.defineProperty({ ...marker }, 'phase', { enumerable: true, get() { traps++; return 'cache'; } });
  assert.equal(copyMobileCapabilityTraceRecord(getter), null);
  assert.equal(copyMobileCapabilityTraceRecord(new Proxy(marker, { ownKeys() { traps++; return []; } })), null); assert.equal(traps, 0);
});
