import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { MobileTrackSelection } from '@music-bridge/contracts';
import { createMobileNeteaseHttpStreams, type MobileNeteaseHttpSource } from '../../src/netease/mobile-http-stream.js';
import type { MobileNeteaseScope } from '../../src/mobile/netease-source-types.js';
import { MobileServiceError } from '../../src/mobile/types.js';
import type { GatewayFetch } from '../../src/stream/upstream-policy.js';

// 受控 transport 执行真实范围/头部/租约/关闭逻辑；不连接 Provider，也不证明整曲 decode 或听感。
const scope: MobileNeteaseScope = { serverId: 'server-1', datasetId: 'dataset-1', deviceId: 'device-1',
  deviceEpoch: 1, accessGeneration: 1, ownerEpoch: 'owner-1', accountDomain: 'account-1', providerEpoch: 'provider-1' };
const selection: MobileTrackSelection = { trackId: 'track-1', source: 'netease', versionId: 'version-1', contentRevision: 'content-1' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function bytes() {
  const value = Buffer.alloc(150000); value.write('fLaC'); value[4] = 0x80; value.writeUIntBE(34, 5, 3);
  value.writeUInt16BE(4096, 8); value.writeUInt16BE(4096, 10);
  value.writeBigUInt64BE(192000n << 44n | 1n << 41n | 23n << 36n | 192000n, 18);
  for (let i = 42; i < value.length; i++) value[i] = i % 251;
  return value;
}
function error(code: string, status?: number) {
  return (value: unknown) => value instanceof MobileServiceError && value.code === code && (status === undefined || value.status === status);
}
function fixture(t: TestContext) {
  const data = bytes(), ranges: string[] = [], conditions: (string | null)[] = [], stages: string[] = [];
  let clock = 1700000000000, active = true, etag = '"fixed-source-1"', cancels = 0;
  let mode: 'valid' | 'ignore-range' | 'missing-etag' | 'short' | 'extra' | 'bad-range' | 'redirect' | 'bad-cancel' = 'valid';
  let block: { started: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> } | null = null;
  const gates: { release: ReturnType<typeof deferred<void>> }[] = [];
  function source(): MobileNeteaseHttpSource { return { account: { accountDomain: scope.accountDomain, providerEpoch: scope.providerEpoch! },
    sourceIdentity: 'source-1', size: data.length, expiresAtMs: clock + 300000,
    upstreamUrl: 'https://music-source.invalid/audio.flac', requestHeaders: { 'Accept-Encoding': 'identity' } }; }
  const fetcher: GatewayFetch = async (url, init) => {
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
    const headers = new Headers(init.headers); assert.equal(headers.get('accept-encoding'), 'identity');
    assert.equal(headers.get('cookie'), null); const range = headers.get('range'); assert.ok(range);
    ranges.push(range); conditions.push(headers.get('if-match'));
    if (block) { const gate = block; block = null; gate.started.resolve(); await gate.release.promise; }
    if (mode === 'redirect' && url.endsWith('audio.flac')) return new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(Uint8Array.of(1)); }, cancel() { cancels++; },
    }), { status: 302, headers: { location: '/redirected.flac' } });
    const match = /^bytes=([0-9]+)-([0-9]+)$/u.exec(range); assert.ok(match);
    const start = Number(match[1]), end = Number(match[2]); assert.ok(end >= start && end - start < 65536);
    let body = Uint8Array.from(data.subarray(start, end + 1));
    if (mode === 'short') body = body.subarray(0, Math.max(0, body.length - 1));
    if (mode === 'extra') { const oversized = new Uint8Array(body.length + 1); oversized.set(body); body = oversized; }
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(body); }, pull(c) { c.close(); },
      cancel() { cancels++; if (mode === 'bad-cancel') throw new Error('受控 body 尚未 quiet'); } });
    return new Response(stream, { status: mode === 'ignore-range' || mode === 'bad-cancel' ? 200 : 206,
      headers: { 'content-length': String(end - start + 1), 'content-range': mode === 'bad-range' ? 'bytes 0-0/1' : `bytes ${start}-${end}/${data.length}`,
        ...(mode === 'missing-etag' ? {} : { etag }) } });
  };
  const manager = createMobileNeteaseHttpStreams({ fetch: fetcher, now: () => clock,
    async assertCurrent(s, stage) { stages.push(stage); if (!active || s.deviceEpoch !== 1 || s.accountDomain !== 'account-1') throw new MobileServiceError(409, 'SOURCE_CHANGED'); },
    async refresh() { return source(); } });
  t.after(async () => { for (const gate of gates) gate.release.resolve(); if (manager.snapshot().fatal) await assert.rejects(manager.close());
    else { await manager.close(); assert.equal(manager.snapshot().leases, 0); assert.equal(manager.snapshot().pending, 0); } });
  return { data, manager, source, ranges, conditions, stages, cancels: () => cancels, mode: (value: typeof mode) => { mode = value; },
    etag: (value: string) => { etag = value; }, advance: (ms: number) => { clock += ms; }, revoke: () => { active = false; },
    block: () => { const gate = { started: deferred<void>(), release: deferred<void>() }; gates.push(gate); block = gate; return gate; } };
}

test('真实响应范围和远端末字节核验后开放 FLAC24/192，原字节随机读取且块不超过64KiB', async t => {
  const f = fixture(t), opened = await f.manager.openFromSource(scope, f.source(), selection, new AbortController().signal);
  assert.deepEqual(opened.observed.audio, { codec: 'flac', container: 'flac', sampleRateHz: 192000, bitsPerSample: 24, channels: 2 });
  assert.equal(opened.observed.durationMs, 1000); assert.equal(opened.lease.rangeSupported, true);
  assert.ok(f.ranges.includes(`bytes=${f.data.length - 1}-${f.data.length - 1}`));
  const readId = randomUUID(), value = await opened.lease.read(readId, 500, 65536, new AbortController().signal);
  assert.deepEqual(value, Uint8Array.from(f.data.subarray(500, 66036)));
  assert.ok(f.conditions.slice(1).every(v => v === '"fixed-source-1"'));
  await assert.rejects(opened.lease.read(randomUUID(), 0, 65537, new AbortController().signal), error('INVALID_REQUEST', 400));
  await opened.lease.closeRead(readId); await opened.lease.release(); assert.ok(f.stages.every(v => v === 'lease'));
});
test('没有真实206/强ETag或范围长度不一致均拒绝，不从非零size猜可seek', async t => {
  for (const mode of ['ignore-range', 'missing-etag', 'short', 'extra', 'bad-range'] as const) {
    const f = fixture(t); f.mode(mode);
    await assert.rejects(f.manager.openFromSource(scope, f.source(), selection, new AbortController().signal));
    assert.equal(f.manager.snapshot().leases, 0); assert.equal(f.manager.snapshot().pending, 0);
  }
});
test('相同源renew只能沿原强ETag和完整音频头更新期限，原过期lease不可复活', async t => {
  const f = fixture(t), { lease } = await f.manager.openFromSource(scope, f.source(), selection, new AbortController().signal);
  const initial = lease.expiresAtMs; f.advance(299000); const renewed = await lease.renew(new AbortController().signal);
  assert.ok(renewed.expiresAtMs > initial); assert.equal(lease.expiresAtMs, initial);
  f.advance(2000); await lease.verify(new AbortController().signal);
  f.etag('"changed-source"'); await assert.rejects(lease.renew(new AbortController().signal), error('SOURCE_CHANGED', 409));
  await lease.release(); const g = fixture(t), next = await g.manager.openFromSource(scope, g.source(), selection, new AbortController().signal);
  g.advance(300000); await assert.rejects(next.lease.renew(new AbortController().signal), error('RESOURCE_EXPIRED', 410));
});
test('不同lease不能借用同readId，关闭墓碑阻止重开，独立资源释放互不影响', async t => {
  const f = fixture(t), a = await f.manager.openFromSource(scope, f.source(), selection, new AbortController().signal),
    b = await f.manager.openFromSource({ ...scope, deviceId: 'device-2' }, f.source(), selection, new AbortController().signal);
  const readId = randomUUID(); await a.lease.read(readId, 0, 4, new AbortController().signal);
  await assert.rejects(b.lease.read(readId, 0, 4, new AbortController().signal), error('INVALID_REQUEST', 404));
  await a.lease.closeRead(readId); await assert.rejects(a.lease.read(readId, 4, 4, new AbortController().signal), error('RESOURCE_RELEASED', 410));
  await a.lease.release(); await b.lease.verify(new AbortController().signal); await b.lease.release();
});
test('取消迟到HTTP时原读保持实际flight，closeRead/release等body取消后才quiet', async t => {
  const f = fixture(t), { lease } = await f.manager.openFromSource(scope, f.source(), selection, new AbortController().signal);
  const gate = f.block(), controller = new AbortController(), readId = randomUUID();
  const read = lease.read(readId, 100, 20, controller.signal); const rejected = assert.rejects(read); await gate.started.promise; controller.abort(); await rejected;
  let closed = false; const quiet = lease.closeRead(readId).then(() => { closed = true; });
  await new Promise<void>(r => setImmediate(r)); assert.equal(closed, false); assert.ok(f.manager.snapshot().pending > 0);
  gate.release.resolve(); await quiet; assert.equal(f.cancels(), 1); await lease.release(); assert.equal(f.manager.snapshot().pending, 0);
});
test('重定向只沿只读HTTPS继续且中间body实际取消，关闭拒绝保留容量并封资格', async t => {
  const f = fixture(t); f.mode('redirect'); const opened = await f.manager.openFromSource(scope, f.source(), selection, new AbortController().signal);
  assert.equal(f.cancels(), 3); await opened.lease.release();
  const g = fixture(t); g.mode('bad-cancel'); await assert.rejects(g.manager.openFromSource(scope, g.source(), selection, new AbortController().signal), error('BUSY', 503));
  assert.equal(g.manager.qualified, false); assert.equal(g.manager.snapshot().fatal, true); assert.equal(g.manager.snapshot().leases, 1);
  await assert.rejects(g.manager.close());
});
test('真实八资源上限、设备围栏和UUID闭集保持，释放一份仅回收对应容量', async t => {
  const f = fixture(t), leases = [];
  for (let n = 0; n < 8; n++) leases.push((await f.manager.openFromSource(scope, f.source(), selection, new AbortController().signal)).lease);
  await assert.rejects(f.manager.openFromSource(scope, f.source(), selection, new AbortController().signal), error('RESOURCE_BUSY', 429));
  await leases[0]!.release(); const replacement = await f.manager.openFromSource(scope, f.source(), selection, new AbortController().signal);
  await assert.rejects(replacement.lease.read('read-alias', 0, 4, new AbortController().signal), error('INVALID_REQUEST', 400));
  f.revoke(); await assert.rejects(replacement.lease.verify(new AbortController().signal), error('SOURCE_CHANGED', 409));
  await replacement.lease.release(); await Promise.all(leases.slice(1).map(lease => lease.release()));
});
