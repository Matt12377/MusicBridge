import assert from 'node:assert/strict';
import { createMobileResourceCapacityProbe } from '../../src/mobile/resource-capacity-trace.js';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { MobileTrackSelection } from '@music-bridge/contracts';
import { createMobileNeteaseHttpStreams, type MobileNeteaseHttpSource } from '../../src/netease/mobile-http-stream.js';
import type { MobileNeteaseScope } from '../../src/mobile/netease-source-types.js';
import { MobileServiceError } from '../../src/mobile/types.js';
import type { GatewayFetch } from '../../src/stream/upstream-policy.js';
import { closeMobileCapabilityContext, createMobileCapabilityContext, withMobileCapabilityContext, copyMobileCapabilityTraceRecord, mobileCapabilityReject, MOBILE_CAPABILITY_TRACE_PREFIX } from '../../src/mobile/capability-trace.js';

// 受控 transport 执行真实范围/头部/租约/关闭逻辑；不连接 Provider，也不证明整曲 decode 或听感。
const scope: MobileNeteaseScope = { serverId: 'server-1', datasetId: 'dataset-1', deviceId: 'device-1',
  deviceEpoch: 1, accessGeneration: 1, ownerEpoch: 'owner-1', accountDomain: 'account-1', providerEpoch: 'provider-1' };
const selection: MobileTrackSelection = { trackId: 'track-1', source: 'netease', versionId: 'version-1', contentRevision: 'content-1' };

test('真实HTTP租约容量拒绝只标准确guard，仍保持八槽与原429错误', async t => {
  const f = fixture(t), leases = [];
  for (let index = 0; index < 8; index++) leases.push((await f.manager.openFromSource(scope, f.source(), selection, new AbortController().signal)).lease);
  const lines: string[] = [], capacity = createMobileResourceCapacityProbe({ enabled: true, sink: line => lines.push(line) });
  const context = capacity.claim(randomUUID(), 'core', 'content'); assert.ok(context);
  await assert.rejects(withMobileCapabilityContext(context, () => f.manager.openFromSource(scope, f.source(), selection, new AbortController().signal)),
    error => error instanceof MobileServiceError && error.status === 429 && error.code === 'RESOURCE_BUSY' && error.retryable === true);
  assert.equal(f.manager.snapshot().leases, 8);
  const records = lines.map(line => JSON.parse(line.slice(MOBILE_CAPABILITY_TRACE_PREFIX.length)));
  assert.deepEqual(records.map(row => row.stage), ['capacity.http.leases-full']);
  assert.equal(records[0].code, 'RESOURCE_BUSY'); closeMobileCapabilityContext(context);
  await Promise.all(leases.map(lease => lease.release())); assert.equal(f.manager.snapshot().leases, 0);
});
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
function fixture(t: TestContext, privateDiagnostics?: boolean) {
  const data = bytes(), ranges: string[] = [], conditions: (string | null)[] = [], stages: string[] = [];
  const dateConditions: { range: string | null; unmodified: string | null }[] = [];
  let clock = 1700000000000, active = true, etag = '"fixed-source-1"', cancels = 0;
  let dates: { modified: string | null; date: string | null } | null = null, sourceIdentity = 'source-1';
  let contentDigest: { algorithm: 'md5'; value: string } | undefined, diagnosticMd5: string | undefined;
  let sourceSize = data.length, bodyReads = 0, lengthOffset = 0, encoding: string | null = null, mime: string | null = null;
  let mode: 'valid' | 'ignore-range' | 'conditional-412' | 'missing-etag' | 'short' | 'extra' | 'bad-range' | 'redirect' | 'bad-cancel' | 'bad-etag-cancel' = 'valid';
  let block: { started: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> } | null = null;
  let cancelBlock: { started: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> } | null = null;
  const gates: { release: ReturnType<typeof deferred<void>> }[] = [];
  function source(): MobileNeteaseHttpSource { return { account: { accountDomain: scope.accountDomain, providerEpoch: scope.providerEpoch! },
    sourceIdentity, size: sourceSize, expiresAtMs: clock + 300000,
    upstreamUrl: 'https://music-source.invalid/audio.flac', requestHeaders: { 'Accept-Encoding': 'identity' },
    ...(contentDigest ? { contentDigest: { ...contentDigest } } : {}),
    ...(diagnosticMd5 === undefined ? {} : { diagnosticMediaMd5: diagnosticMd5 }) }; }
  const fetcher: GatewayFetch = async (url, init) => {
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
    const headers = new Headers(init.headers); assert.equal(headers.get('accept-encoding'), 'identity');
    assert.equal(headers.get('cookie'), null); const range = headers.get('range'); assert.ok(range);
    ranges.push(range); conditions.push(headers.get('if-match'));
    dateConditions.push({ range: headers.get('if-range'), unmodified: headers.get('if-unmodified-since') });
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
      cancel() { cancels++; if (mode === 'bad-cancel' || mode === 'bad-etag-cancel') throw new Error('受控 body 尚未 quiet');
        if (cancelBlock) { const gate = cancelBlock; cancelBlock = null; gate.started.resolve(); return gate.release.promise; } } });
    const response = new Response(stream, { status: mode === 'conditional-412' ? 412 : mode === 'ignore-range' || mode === 'bad-cancel' ? 200 : 206,
      headers: { 'content-length': String(end - start + 1 + lengthOffset), 'content-range': mode === 'bad-range' ? 'bytes 0-0/1' : `bytes ${start}-${end}/${data.length}`,
        ...(encoding === null ? {} : { 'content-encoding': encoding }), ...(mime === null ? {} : { 'content-type': mime }),
        ...(dates?.modified === null || !dates ? {} : { 'last-modified': dates.modified }),
        ...(dates?.date === null || !dates ? {} : { date: dates.date }),
        ...(mode === 'missing-etag' ? {} : { etag: /[^\x00-\xff]/u.test(etag) ? 'synthetic-header-placeholder' : etag }) } });
    // Fetch Headers本身拒绝非字节字符；仅受控头读取器把该损坏值送到生产解析边界。
    if (/[^\x00-\xff]/u.test(etag)) { const get = response.headers.get.bind(response.headers);
      response.headers.get = name => name.toLowerCase() === 'etag' ? etag : get(name); }
    const getReader = response.body!.getReader.bind(response.body);
    Object.defineProperty(response.body, 'getReader', { value() {
      const reader = getReader(), read = reader.read.bind(reader); reader.read = () => { bodyReads++; return read(); }; return reader;
    } });
    return response;
  };
  const manager = createMobileNeteaseHttpStreams({ fetch: fetcher, now: () => clock,
    ...(privateDiagnostics === undefined ? {} : { privateDiagnostics }),
    async assertCurrent(s, stage) { stages.push(stage); if (!active || s.deviceEpoch !== 1 || s.accountDomain !== 'account-1') throw new MobileServiceError(409, 'SOURCE_CHANGED'); },
    async refresh() { return source(); } });
  t.after(async () => { for (const gate of gates) gate.release.resolve(); if (manager.snapshot().fatal) await assert.rejects(manager.close());
    else { await manager.close(); assert.equal(manager.snapshot().leases, 0); assert.equal(manager.snapshot().pending, 0); } });
  return { data, manager, source, ranges, conditions, dateConditions, stages, cancels: () => cancels, mode: (value: typeof mode) => { mode = value; },
    bodyReads: () => bodyReads, digest: (value: string | null) => { contentDigest = value === null ? undefined : { algorithm: 'md5', value }; },
    diagnosticMd5: (value: string) => { diagnosticMd5 = value; }, size: (value: number) => { sourceSize = value; },
    lengthOffset: (value: number) => { lengthOffset = value; }, encoding: (value: string) => { encoding = value; }, mime: (value: string) => { mime = value; },
    dates: (modified: string | null, date: string | null) => { dates = { modified, date }; }, identity: (value: string) => { sourceIdentity = value; },
    etag: (value: string) => { etag = value; }, advance: (ms: number) => { clock += ms; }, revoke: () => { active = false; },
    block: () => { const gate = { started: deferred<void>(), release: deferred<void>() }; gates.push(gate); block = gate; return gate; },
    blockCancel: () => { const gate = { started: deferred<void>(), release: deferred<void>() }; gates.push(gate); cancelBlock = gate; return gate; } };
}

const vendorMd5 = 'a'.repeat(32);
function vendorFixture(t: TestContext) { const f = fixture(t); f.digest(vendorMd5); f.etag(vendorMd5); return f; }

async function httpConsistencyReject(work:()=>Promise<unknown>,privateContext=true,alreadyRejected=false){
  const lines:string[]=[],context=createMobileCapabilityContext(randomUUID(),'core','content',null,new AbortController().signal,line=>lines.push(line));
  assert.ok(context);if(privateContext)context.privateContentDiagnostic=true;
  try{await withMobileCapabilityContext(context,async()=>{
    if(alreadyRejected)mobileCapabilityReject('provider.artwork.url-changed',new MobileServiceError(409,'SOURCE_CHANGED'));
    await assert.rejects(work(),error('SOURCE_CHANGED',409));
  });}finally{closeMobileCapabilityContext(context);}
  const records=lines.map(line=>copyMobileCapabilityTraceRecord(JSON.parse(line.slice(MOBILE_CAPABILITY_TRACE_PREFIX.length))));
  assert.ok(records.every(row=>row!==null));assert.doesNotMatch(lines.join(''),/fixed-source|source-1|music-source|https?:|GMT|headers|message|stack/u);
  assert.equal(lines.join('').includes(vendorMd5),false);
  return records.filter(row=>row!.phase==='reject');
}
test('R15_HTTP_CONSISTENCY 原Range和body拒绝保留409与实际关闭，只输出有限原因',async t=>{
  for(const kind of ['content-range','content-length','encoding','chunk','length'] as const)await t.test(kind,async child=>{
    const f=fixture(child,true);
    if(kind==='content-range')f.mode('bad-range');else if(kind==='content-length')f.lengthOffset(1);else if(kind==='encoding')f.encoding('gzip');
    else f.mode(kind==='chunk'?'extra':'short');
    const records=await httpConsistencyReject(()=>f.manager.probe(scope,f.source(),new AbortController().signal));
    assert.deepEqual(records.map(row=>row!.stage),['provider.audio-probe.reject.'+(kind==='chunk'||kind==='length'?'body.':'range.')+kind]);
    assert.equal(Object.keys(records[0]!).length,15);assert.equal(f.manager.snapshot().leases,0);assert.equal(f.manager.snapshot().pending,0);
    if(kind==='content-range'||kind==='content-length'||kind==='encoding'){assert.equal(f.bodyReads(),0);assert.equal(f.cancels(),1);}
  });
});
test('R15_HTTP_CONSISTENCY 原vendor与strong标签拒绝分别闭合且不读取变化响应body',async t=>{
  for(const kind of ['status','etag','multipart','strong-etag-changed'] as const)await t.test(kind,async child=>{
    const f=fixture(child,true);if(kind!=='strong-etag-changed'){f.digest(vendorMd5);f.etag(vendorMd5);}
    const {lease}=await f.manager.openFromSource(scope,f.source(),selection,new AbortController().signal),before=f.bodyReads();
    if(kind==='status')f.mode('ignore-range');else if(kind==='multipart')f.mime('multipart/byteranges; boundary=synthetic');
    else f.etag('"changed-source"');
    const id=randomUUID(),records=await httpConsistencyReject(()=>lease.read(id,100,64,new AbortController().signal));
    assert.deepEqual(records.map(row=>row!.stage),['provider.audio-probe.reject.'+(kind==='strong-etag-changed'?kind:'vendor.'+kind)]);
    assert.equal(f.bodyReads(),before);await lease.closeRead(id);await lease.release();assert.equal(f.manager.snapshot().leases,0);
  });
});
test('R15_HTTP_CONSISTENCY 私有关闭和已有首拒不追加新分类，原body等待实际cancel完成',async t=>{
  for(const [enabled,privateContext,alreadyRejected] of [[false,true,false],[true,false,false],[true,true,true]] as const)await t.test('gated-'+enabled+'-'+privateContext+'-'+alreadyRejected,async child=>{
    const f=fixture(child,enabled),{lease}=await f.manager.openFromSource(scope,f.source(),selection,new AbortController().signal);f.etag('"changed-source"');
    const id=randomUUID(),records=await httpConsistencyReject(()=>lease.read(id,100,64,new AbortController().signal),privateContext,alreadyRejected);
    assert.deepEqual(records.map(row=>row!.stage),alreadyRejected?['provider.artwork.url-changed']:[]);await lease.closeRead(id);await lease.release();
  });
  const f=fixture(t,true),{lease}=await f.manager.openFromSource(scope,f.source(),selection,new AbortController().signal),gate=f.blockCancel(),id=randomUUID();
  f.etag('"changed-source"');let completed=false;
  const read=httpConsistencyReject(()=>lease.read(id,100,64,new AbortController().signal)).then(value=>{completed=true;return value;});
  await gate.started.promise;await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(completed,false);assert.equal(f.manager.snapshot().leases,1);assert.ok(f.manager.snapshot().pending>0);
  gate.release.resolve();const records=await read;await lease.closeRead(id);assert.deepEqual(records.map(row=>row!.stage),['provider.audio-probe.reject.strong-etag-changed']);
  await lease.release();assert.equal(f.manager.snapshot().leases,0);
});

test('R14_VENDOR_DIGEST 正式API内容指纹配对裸32hex，真实范围/末字节/随机读与续租不生成条件头', async t => {
  const f = vendorFixture(t); f.digest(vendorMd5.toUpperCase()); f.dates('not-a-date', 'not-a-date');
  const { lease, observed } = await f.manager.openFromSource(scope, f.source(), selection, new AbortController().signal);
  assert.equal(observed.audio.codec, 'flac'); assert.equal(observed.audio.bitsPerSample, 24);
  assert.ok(f.ranges.includes(`bytes=${f.data.length - 1}-${f.data.length - 1}`));
  const id = randomUUID(); assert.deepEqual(await lease.read(id, 500, 65536, new AbortController().signal), Uint8Array.from(f.data.subarray(500, 66036)));
  await lease.closeRead(id); await lease.verify(new AbortController().signal);
  f.advance(299000); const renewed = await lease.renew(new AbortController().signal); assert.ok(renewed.expiresAtMs > lease.expiresAtMs);
  assert.ok(f.conditions.every(value => value === null));
  assert.ok(f.dateConditions.every(value => value.range === null && value.unmodified === null));
  await lease.release(); assert.deepEqual(f.manager.snapshot(), { leases: 0, probes: 0, readers: 0, pending: 0, fatal: false });
});

test('R14_VENDOR_DIGEST 缺失/错误正式摘要、诊断值或裸multipart均不能借有效日期准入且不读body', async t => {
  for (const kind of ['missing', 'diagnostic-only', 'mismatch', 'multipart', 'weak', 'missing-tag', 'multipart-body'] as const) await t.test(kind, async child => {
    const f = vendorFixture(child); f.dates(dateModified, dateNow);
    if (kind === 'missing' || kind === 'diagnostic-only') f.digest(null);
    if (kind === 'diagnostic-only') f.diagnosticMd5(vendorMd5);
    if (kind === 'mismatch') f.digest('b'.repeat(32));
    if (kind === 'multipart') f.etag(vendorMd5 + '-2');
    if (kind === 'weak') f.etag('W/"' + vendorMd5 + '"');
    if (kind === 'missing-tag') f.mode('missing-etag');
    if (kind === 'multipart-body') f.mime('multipart/byteranges; boundary=synthetic');
    await assert.rejects(f.manager.openFromSource(scope, f.source(), selection, new AbortController().signal));
    assert.equal(f.ranges.length, 1); assert.equal(f.bodyReads(), 0); assert.equal(f.cancels(), 1);
    assert.deepEqual(f.manager.snapshot(), { leases: 0, probes: 0, readers: 0, pending: 0, fatal: false });
  });
});

test('R14_VENDOR_DIGEST 每次206都先核原tag/总长/范围/长度/编码，不能升级quoted或日期', async t => {
  for (const kind of ['changed', 'case-change', 'weak', 'missing-tag', 'quoted', 'multipart', '200', '412', 'range', 'length', 'encoding', 'multipart-body'] as const) await t.test(kind, async child => {
    const f = vendorFixture(child), { lease } = await f.manager.openFromSource(scope, f.source(), selection, new AbortController().signal);
    const before = f.bodyReads(), cancelled = f.cancels(); f.dates(dateModified, dateNow);
    if (kind === 'changed') f.etag('b'.repeat(32));
    if (kind === 'case-change') f.etag(vendorMd5.toUpperCase());
    if (kind === 'weak') f.etag('W/"' + vendorMd5 + '"');
    if (kind === 'missing-tag') f.mode('missing-etag');
    if (kind === 'quoted') f.etag('"' + vendorMd5 + '"');
    if (kind === 'multipart') f.etag(vendorMd5 + '-2');
    if (kind === '200') f.mode('ignore-range');
    if (kind === '412') f.mode('conditional-412');
    if (kind === 'range') f.mode('bad-range');
    if (kind === 'length') f.lengthOffset(1);
    if (kind === 'encoding') f.encoding('gzip');
    if (kind === 'multipart-body') f.mime('multipart/byteranges; boundary=synthetic');
    const id = randomUUID(); await assert.rejects(lease.read(id, 90, 16, new AbortController().signal));
    await lease.closeRead(id); assert.equal(f.bodyReads(), before); assert.equal(f.cancels(), cancelled + 1);
    assert.equal(f.conditions.at(-1), null); assert.deepEqual(f.dateConditions.at(-1), { range: null, unmodified: null });
    await lease.release(); assert.equal(f.manager.snapshot().pending, 0);
  });
});

test('R14_VENDOR_DIGEST refresh的摘要/大小/来源变更在HTTP前拒绝，原账号围栏继续有效', async t => {
  for (const kind of ['digest', 'missing-digest', 'size', 'identity', 'account'] as const) await t.test(kind, async child => {
    const f = vendorFixture(child), { lease } = await f.manager.openFromSource(scope, f.source(), selection, new AbortController().signal);
    const before = f.ranges.length;
    if (kind === 'digest') f.digest('b'.repeat(32));
    if (kind === 'missing-digest') f.digest(null);
    if (kind === 'size') f.size(f.data.length + 1);
    if (kind === 'identity') f.identity('different-source');
    if (kind === 'account') f.revoke();
    await assert.rejects(lease.renew(new AbortController().signal), error('SOURCE_CHANGED', 409));
    assert.equal(f.ranges.length, before); await lease.release(); assert.equal(f.manager.snapshot().pending, 0);
  });
});

test('R14_VENDOR_DIGEST 响应拒绝等待真实cancel，迟到fetch取消也不提前quiet', async t => {
  const f = vendorFixture(t), { lease } = await f.manager.openFromSource(scope, f.source(), selection, new AbortController().signal);
  const cancel = f.blockCancel(), id = randomUUID(), before = f.bodyReads(); f.etag('b'.repeat(32));
  const rejected = assert.rejects(lease.read(id, 0, 4, new AbortController().signal)); await cancel.started.promise;
  let quiet = false; const closing = lease.closeRead(id).then(() => { quiet = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(quiet, false); assert.ok(f.manager.snapshot().pending > 0);
  cancel.release.resolve(); await rejected; await closing; assert.equal(f.bodyReads(), before); await lease.release();
  const g = vendorFixture(t), opened = await g.manager.openFromSource(scope, g.source(), selection, new AbortController().signal);
  const gate = g.block(), controller = new AbortController(), next = randomUUID(), pending = assert.rejects(opened.lease.read(next, 90, 16, controller.signal));
  await gate.started.promise; controller.abort(); await pending; let closed = false;
  const close = opened.lease.closeRead(next).then(() => { closed = true; }); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(closed, false); gate.release.resolve(); await close; assert.equal(g.cancels(), 1); await opened.lease.release();
});

test('R14_VENDOR_DIGEST 真实cancel拒绝继续fatal，正式摘要不改变quoted强ETag原值路径', async t => {
  const f = vendorFixture(t), { lease } = await f.manager.openFromSource(scope, f.source(), selection, new AbortController().signal);
  f.etag('b'.repeat(32)); f.mode('bad-etag-cancel');
  await assert.rejects(lease.verify(new AbortController().signal), error('BUSY', 503)); assert.equal(f.manager.snapshot().fatal, true);
  const strong = fixture(t); strong.digest('b'.repeat(32)); strong.etag('"' + vendorMd5 + '"'); strong.dates('invalid-date', 'invalid-date');
  const opened = await strong.manager.openFromSource(scope, strong.source(), selection, new AbortController().signal);
  assert.ok(strong.conditions.slice(1).every(value => value === '"' + vendorMd5 + '"')); await opened.lease.release();
});

test('R14_VENDOR_DIGEST 正式指纹只接纳两个闭集字段和32hex，损坏输入不触发HTTP', async t => {
  for (const value of [null, [], { algorithm: 'sha256', value: vendorMd5 }, { algorithm: 'md5', value: '' },
    { algorithm: 'md5', value: 'g'.repeat(32) }, { algorithm: 'md5', value: vendorMd5, extra: true }, { value: vendorMd5, other: 'md5' }]) await t.test(JSON.stringify(value), async child => {
    const f = vendorFixture(child), source = Object.assign(f.source(), { contentDigest: value });
    await assert.rejects(f.manager.openFromSource(scope, source as MobileNeteaseHttpSource, selection, new AbortController().signal), error('SOURCE_CHANGED', 409));
    assert.equal(f.ranges.length, 0); assert.equal(f.bodyReads(), 0); assert.equal(f.manager.snapshot().leases, 0);
  });
});

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

test('R10_ETAG 合法空opaque-tag完成真实范围准入，后续If-Match原值保留且变化拒绝', async t => {
  const f = fixture(t); f.etag('""');
  const { lease } = await f.manager.openFromSource(scope, f.source(), selection, new AbortController().signal);
  assert.equal(f.conditions[0], null); assert.ok(f.conditions.length >= 3);
  assert.ok(f.conditions.slice(1).every(value => value === '""'));
  const id = randomUUID(); const value = await lease.read(id, 90, 16, new AbortController().signal);
  assert.deepEqual(value, Uint8Array.from(f.data.subarray(90, 106))); assert.equal(f.conditions.at(-1), '""');
  await lease.closeRead(id); f.etag('"changed-source"');
  await assert.rejects(lease.verify(new AbortController().signal), error('SOURCE_CHANGED', 409));
  assert.equal(f.conditions.at(-1), '""'); await lease.release(); assert.equal(f.manager.snapshot().pending, 0);
});

test('R10_ETAG 合法octet与256字节边界保持原值，不执行反斜杠反转义', async t => {
  for (const [name, tag] of [['obs-text', '"\u00e9"'], ['反斜杠', '"synthetic\\tag"'], ['256字节', '"' + 'x'.repeat(254) + '"']] as const) {
    await t.test(name, async child => {
      const f = fixture(child); f.etag(tag);
      const { lease } = await f.manager.openFromSource(scope, f.source(), selection, new AbortController().signal);
      assert.ok(f.conditions.slice(1).every(value => value === tag)); await lease.release();
    });
  }
});

test('R10_ETAG 非法形态不升级为强验证器，拒绝后真实body关闭且容量回收', async t => {
  for (const [name, tag] of [['bare32hex', 'a'.repeat(32)], ['overlimit', '"' + 'x'.repeat(255) + '"'],
    ['malformedquoted', '"synthetic-unclosed'], ['unquotedother', 'synthetic-unquoted'],
    ['引号内空格', '"synthetic tag"'], ['非octet Unicode', '"synthetic\u0100tag"'], ['weak', 'W/"synthetic-tag"']] as const) {
    await t.test(name, async child => {
      const f = fixture(child); f.etag(tag);
      await assert.rejects(f.manager.openFromSource(scope, f.source(), selection, new AbortController().signal), error('UNSUPPORTED_FORMAT', 409));
      assert.equal(f.ranges.length, 1); assert.deepEqual(f.conditions, [null]); assert.equal(f.cancels(), 1);
      assert.deepEqual(f.manager.snapshot(), { leases: 0, probes: 0, readers: 0, pending: 0, fatal: false });
    });
  }
});

test('R10_ETAG 格式拒绝不吞真实取消失败，原lease保持fatal且不假报quiet', async t => {
  const f = fixture(t); f.etag('a'.repeat(32)); f.mode('bad-etag-cancel');
  await assert.rejects(f.manager.openFromSource(scope, f.source(), selection, new AbortController().signal), error('BUSY', 503));
  assert.equal(f.cancels(), 1); assert.equal(f.manager.qualified, false);
  assert.equal(f.manager.snapshot().fatal, true); assert.equal(f.manager.snapshot().leases, 1);
  await assert.rejects(f.manager.close(), error('BUSY', 503));
});

const dateNow = new Date(1700000000000).toUTCString();
const dateModified = new Date(1700000000000 - 120000).toUTCString();
function dateFixture(t: TestContext, tag = 'synthetic-unquoted-revision') {
  const f = fixture(t); f.etag(tag); f.dates(dateModified, dateNow); return f;
}

test('R11_DATE 一般裸标记保留独立强日期路径，裸32hex缺正式指纹不得回退且不伪造If-Match', async t => {
  for (const tag of ['synthetic-unquoted-revision', 'a'.repeat(32)]) await t.test(tag.length === 32 ? '裸32hex缺正式指纹拒绝' : '裸标记', async child => {
    const f = dateFixture(child, tag);
    if (tag.length === 32) {
      await assert.rejects(f.manager.openFromSource(scope, f.source(), selection, new AbortController().signal), error('UNSUPPORTED_FORMAT', 409));
      assert.equal(f.bodyReads(), 0); assert.equal(f.cancels(), 1); assert.deepEqual(f.dateConditions, [{ range: null, unmodified: null }]); return;
    }
    const { lease } = await f.manager.openFromSource(scope, f.source(), selection, new AbortController().signal);
    assert.equal(f.conditions[0], null); assert.deepEqual(f.dateConditions[0], { range: null, unmodified: null });
    assert.ok(f.dateConditions.slice(1).length >= 2);
    assert.ok(f.dateConditions.slice(1).every(value => value.range === dateModified && value.unmodified === dateModified));
    assert.ok(f.conditions.every(value => value === null));
    const id = randomUUID(), value = await lease.read(id, 100, 65536, new AbortController().signal);
    assert.deepEqual(value, Uint8Array.from(f.data.subarray(100, 65636))); await lease.closeRead(id); await lease.release();
    assert.deepEqual(f.manager.snapshot(), { leases: 0, probes: 0, readers: 0, pending: 0, fatal: false });
  });
});

test('R11_DATE 日期间隔60秒含边界可用；合法strong ETag和空opaque始终沿原If-Match且不读无效日期', async t => {
  const boundary = fixture(t); boundary.etag('synthetic-unquoted'); boundary.dates(new Date(1700000000000 - 60000).toUTCString(), dateNow);
  const opened = await boundary.manager.openFromSource(scope, boundary.source(), selection, new AbortController().signal); await opened.lease.release();
  for (const tag of ['"fixed-source-1"', '""']) await t.test(tag, async child => {
    const f = fixture(child); f.etag(tag); f.dates('not-a-date', 'also-not-a-date');
    const { lease } = await f.manager.openFromSource(scope, f.source(), selection, new AbortController().signal);
    assert.ok(f.conditions.slice(1).every(value => value === tag));
    assert.ok(f.dateConditions.every(value => value.range === null && value.unmodified === null)); await lease.release();
  });
});

test('R11_DATE 缺失/损坏/非round-trip/未来/不足60秒日期均拒绝，未知裸形态不因日期升级', async t => {
  const variants: [string, string | null, string | null, string?][] = [
    ['缺Last-Modified', null, dateNow], ['缺Date', dateModified, null], ['不合法日期', 'invalid-date', dateNow],
    ['星期不匹配', dateModified.replace('Tue', 'Mon'), dateNow], ['非GMT', dateModified.replace('GMT', 'UTC'), dateNow],
    ['不存在日历日期', 'Fri, 31 Feb 2023 12:00:00 GMT', dateNow], ['未来Date', dateModified, new Date(1700000001000).toUTCString()],
    ['未来Last-Modified', new Date(1700000001000).toUTCString(), dateNow],
    ['59秒', new Date(1700000000000 - 59000).toUTCString(), dateNow],
    ['裸空格', dateModified, dateNow, 'synthetic unquoted'], ['裸逗号组合', dateModified, dateNow, 'synthetic,other'],
    ['裸Unicode', dateModified, dateNow, 'synthetic-\u0100'], ['内嵌引号', dateModified, dateNow, 'synthetic"inner'],
  ];
  for (const [name, modified, date, tag] of variants) await t.test(name, async child => {
    const f = dateFixture(child, tag); f.dates(modified, date);
    await assert.rejects(f.manager.openFromSource(scope, f.source(), selection, new AbortController().signal), error('UNSUPPORTED_FORMAT', 409));
    assert.equal(f.cancels(), 1); assert.equal(f.ranges.length, 1); assert.ok(f.conditions.every(value => value === null));
    assert.deepEqual(f.manager.snapshot(), { leases: 0, probes: 0, readers: 0, pending: 0, fatal: false });
  });
});

test('R11_DATE weak/missing/overlimit/malformedquoted仍拒绝，有效日期也不替合法strong分支降级', async t => {
  for (const tag of ['W/"synthetic"', '"' + 'x'.repeat(255) + '"', '"synthetic-unclosed', '"synthetic space"']) await t.test(tag.slice(0, 12), async child => {
    const f = dateFixture(child, tag);
    await assert.rejects(f.manager.openFromSource(scope, f.source(), selection, new AbortController().signal), error('UNSUPPORTED_FORMAT', 409));
    assert.equal(f.cancels(), 1); assert.equal(f.ranges.length, 1);
  });
  const missing = dateFixture(t); missing.mode('missing-etag');
  await assert.rejects(missing.manager.probe(scope, missing.source(), new AbortController().signal), error('UNSUPPORTED_FORMAT', 409));
  const strong = fixture(t), { lease } = await strong.manager.openFromSource(scope, strong.source(), selection, new AbortController().signal);
  strong.etag('synthetic-unquoted-revision'); strong.dates(dateModified, dateNow);
  await assert.rejects(lease.verify(new AbortController().signal), error('UNSUPPORTED_FORMAT', 409));
  assert.equal(strong.conditions.at(-1), '"fixed-source-1"'); assert.equal(strong.dateConditions.at(-1)?.range, null); await lease.release();
});

test('R11_DATE 每次206保持原裸标记和Last-Modified，日期损坏或切换验证模式均拒绝', async t => {
  for (const change of ['tag', 'modified', 'future-date', 'strong-tag'] as const) await t.test(change, async child => {
    const f = dateFixture(child), { lease } = await f.manager.openFromSource(scope, f.source(), selection, new AbortController().signal);
    if (change === 'tag') f.etag('synthetic-changed');
    if (change === 'modified') f.dates(new Date(1700000000000 - 121000).toUTCString(), dateNow);
    if (change === 'future-date') f.dates(dateModified, new Date(1700000001000).toUTCString());
    if (change === 'strong-tag') f.etag('"synthetic-upgrade"');
    await assert.rejects(lease.verify(new AbortController().signal), error('SOURCE_CHANGED', 409));
    assert.equal(f.cancels(), 1); await lease.release(); assert.equal(f.manager.snapshot().pending, 0);
  });
});

test('R11_DATE If-Range遇200或412不吞全曲并取消body；取消失败仍fatal且不假报quiet', async t => {
  for (const mode of ['ignore-range', 'conditional-412'] as const) await t.test(mode, async child => {
    const f = dateFixture(child), { lease } = await f.manager.openFromSource(scope, f.source(), selection, new AbortController().signal);
    f.mode(mode); await assert.rejects(lease.read(randomUUID(), 100, 64, new AbortController().signal), error('SOURCE_CHANGED', 409));
    assert.equal(f.cancels(), 1); assert.equal(f.dateConditions.at(-1)?.range, dateModified); await lease.release();
  });
  const failed = dateFixture(t), { lease } = await failed.manager.openFromSource(scope, failed.source(), selection, new AbortController().signal);
  failed.mode('bad-cancel'); await assert.rejects(lease.verify(new AbortController().signal), error('BUSY', 503));
  assert.equal(failed.manager.qualified, false); assert.equal(failed.manager.snapshot().fatal, true);
  await assert.rejects(lease.release(), error('BUSY', 503));
});

test('R11_DATE 取消迟到HTTP仍由原flight承担清理，closeRead/release不得提前quiet', async t => {
  const f = dateFixture(t), { lease } = await f.manager.openFromSource(scope, f.source(), selection, new AbortController().signal);
  const gate = f.block(), controller = new AbortController(), readId = randomUUID();
  const read = lease.read(readId, 100, 20, controller.signal), rejected = assert.rejects(read); await gate.started.promise;
  controller.abort(); await rejected; let quiet = false; const closing = lease.closeRead(readId).then(() => { quiet = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(quiet, false); assert.ok(f.manager.snapshot().pending > 0);
  gate.release.resolve(); await closing; assert.equal(f.cancels(), 1); await lease.release(); assert.equal(f.manager.snapshot().pending, 0);
});

test('R11_DATE renew保持实际音频头/Provider版本/账号围栏，成功续租不改初始描述符', async t => {
  const f = dateFixture(t), { lease } = await f.manager.openFromSource(scope, f.source(), selection, new AbortController().signal);
  const initial = lease.expiresAtMs; f.advance(299000); f.dates(dateModified, new Date(1700000299000).toUTCString());
  const renewed = await lease.renew(new AbortController().signal); assert.ok(renewed.expiresAtMs > initial); assert.equal(lease.expiresAtMs, initial);
  f.data.writeBigUInt64BE(96000n << 44n | 1n << 41n | 23n << 36n | 96000n, 18);
  await assert.rejects(lease.renew(new AbortController().signal), error('SOURCE_CHANGED', 409)); await lease.release();
  const changed = dateFixture(t), next = await changed.manager.openFromSource(scope, changed.source(), selection, new AbortController().signal);
  changed.identity('source-changed'); await assert.rejects(next.lease.renew(new AbortController().signal), error('SOURCE_CHANGED', 409)); await next.lease.release();
  const revoked = dateFixture(t), third = await revoked.manager.openFromSource(scope, revoked.source(), selection, new AbortController().signal);
  revoked.revoke(); await assert.rejects(third.lease.verify(new AbortController().signal), error('SOURCE_CHANGED', 409)); await third.lease.release();
});

test('R12_DATE_DIAGNOSTICS 私有分类不改变首次409/单次范围请求；真实cancel失败仍封资格BUSY', async t => {
  for (const enabled of [undefined, false, true]) await t.test(String(enabled), async child => {
    const f = fixture(child, enabled), lines: string[] = [];
    const c = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, undefined, line => lines.push(line)); assert.ok(c);
    f.etag('synthetic-unquoted'); f.dates(dateModified.replace('Tue', 'Mon'), dateNow);
    await withMobileCapabilityContext(c, () => assert.rejects(f.manager.openFromSource(scope, f.source(), selection, new AbortController().signal), error('UNSUPPORTED_FORMAT', 409)));
    closeMobileCapabilityContext(c); assert.equal(f.ranges.length, 1); assert.equal(f.cancels(), 1);
    assert.equal(lines.length, enabled === true ? 1 : 0); assert.equal(f.conditions[0], null);
    assert.deepEqual(f.dateConditions[0], { range: null, unmodified: null });
    assert.deepEqual(f.manager.snapshot(), { leases: 0, probes: 0, readers: 0, pending: 0, fatal: false });
  });
  const f = fixture(t, true), lines: string[] = [];
  const c = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, undefined, line => lines.push(line)); assert.ok(c);
  f.etag('synthetic-unquoted'); f.dates(dateModified.replace('Tue', 'Mon'), dateNow); f.mode('bad-etag-cancel');
  await withMobileCapabilityContext(c, () => assert.rejects(f.manager.openFromSource(scope, f.source(), selection, new AbortController().signal), error('BUSY', 503)));
  closeMobileCapabilityContext(c); assert.equal(f.ranges.length, 1); assert.equal(f.cancels(), 1); assert.equal(lines.length, 1);
  assert.equal(f.manager.snapshot().fatal, true); assert.equal(f.manager.qualified, false); await assert.rejects(f.manager.close(), error('BUSY', 503));
});
