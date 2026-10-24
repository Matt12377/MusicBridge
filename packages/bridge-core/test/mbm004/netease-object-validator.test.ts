import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createMobileNeteaseHttpStreams, type MobileNeteaseHttpSource } from '../../src/netease/mobile-http-stream.js';
import type { MobileNeteaseScope } from '../../src/mobile/netease-source-types.js';
import { MobileServiceError } from '../../src/mobile/types.js';
import type { GatewayFetch } from '../../src/stream/upstream-policy.js';

// 只使用合成HTTP响应；官方域名只是准入输入，不发真实网络请求。
const scope: MobileNeteaseScope = { serverId: 'server-1', datasetId: 'dataset-1', deviceId: 'device-1', deviceEpoch: 1,
  accessGeneration: 1, ownerEpoch: 'owner-1', accountDomain: 'account-1', providerEpoch: 'provider-1' };
const selection = { trackId: 'track-1', source: 'netease' as const, versionId: 'version-1', contentRevision: 'content-1' };
const digestValue = 'a'.repeat(32), objectTag = `${'b'.repeat(32)}-2`;
const originalUrl = 'https://m7.music.126.net/synthetic-audio.flac?signature=synthetic';
const signal = () => new AbortController().signal;
const denied = (value: unknown) => value instanceof MobileServiceError && value.status === 409
  && ['SOURCE_CHANGED', 'UNSUPPORTED_FORMAT'].includes(value.code);
const changed = (value: unknown) => value instanceof MobileServiceError && value.status === 409 && value.code === 'SOURCE_CHANGED';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(t: TestContext) {
  const data = Buffer.alloc(150000); data.write('fLaC'); data[4] = 0x80; data.writeUIntBE(34, 5, 3);
  data.writeUInt16BE(4096, 8); data.writeUInt16BE(4096, 10);
  data.writeBigUInt64BE(192000n << 44n | 1n << 41n | 23n << 36n | 192000n, 18);
  for (let i = 42; i < data.length; i++) data[i] = i % 251;
  const requests: { url: string; headers: Headers }[] = [], gates: { release: ReturnType<typeof deferred> }[] = [];
  let clock = 1700000000000, url = originalUrl, tag = objectTag, digest: string | null = digestValue, identity = 'source-1', size = data.length;
  let status = 206, encoding: string | null = null, mime: string | null = null, lengthOffset = 0, wrongRange = false;
  let redirect: string | null = null, responseUrl: string | null = null, bodyReads = 0, cancels = 0, dateReads = 0, failCancel = false, revoked = false;
  let dates = { modified: 'synthetic-invalid-last-modified', date: 'synthetic-invalid-date' };
  let fetchGate: { started: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | null = null;
  let cancelGate: { started: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | null = null;
  const source = (): MobileNeteaseHttpSource => ({ account: { accountDomain: scope.accountDomain, providerEpoch: scope.providerEpoch! },
    sourceIdentity: identity, size, expiresAtMs: clock + 300000, upstreamUrl: url,
    requestHeaders: { 'Accept-Encoding': 'identity', 'User-Agent': 'synthetic-agent' },
    ...(digest === null ? {} : { contentDigest: { algorithm: 'md5', value: digest } }) });
  const transport: GatewayFetch = async (target, init) => {
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
    const headers = new Headers(init.headers); assert.equal(headers.get('cookie'), null); assert.equal(headers.get('accept-encoding'), 'identity');
    requests.push({ url: target, headers });
    if (fetchGate) { const gate = fetchGate; fetchGate = null; gate.started.resolve(); await gate.release.promise; }
    if (redirect !== null && new URL(target).pathname === '/synthetic-audio.flac') {
      return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Uint8Array.of(1)); },
        cancel() { cancels++; if (failCancel) throw new Error('合成中间响应取消失败'); } }), { status: 302, headers: { location: redirect } });
    }
    const range = /^bytes=([0-9]+)-([0-9]+)$/u.exec(headers.get('range') ?? ''); assert.ok(range);
    const start = Number(range[1]), end = Number(range[2]); assert.ok(end - start < 65536);
    const body = Uint8Array.from(data.subarray(start, end + 1)), receivedTag = tag;
    const response = new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(body); }, pull(c) { c.close(); },
      cancel() { cancels++; if (failCancel) throw new Error('合成响应取消失败');
        if (cancelGate) { const gate = cancelGate; cancelGate = null; gate.started.resolve(); return gate.release.promise; } } }), {
      status, headers: { etag: 'synthetic-placeholder', 'content-length': String(end - start + 1 + lengthOffset),
        'content-range': wrongRange ? 'bytes 0-0/1' : `bytes ${start}-${end}/${data.length}`,
        ...(encoding === null ? {} : { 'content-encoding': encoding }), ...(mime === null ? {} : { 'content-type': mime }),
        'last-modified': dates.modified, date: dates.date } });
    const get = response.headers.get.bind(response.headers);
    response.headers.get = name => { if (['date', 'last-modified'].includes(name.toLowerCase())) dateReads++;
      return name.toLowerCase() === 'etag' ? receivedTag : get(name); };
    if (responseUrl !== null) Object.defineProperty(response, 'url', { value: responseUrl });
    const getReader = response.body!.getReader.bind(response.body);
    Object.defineProperty(response.body, 'getReader', { value() { const reader = getReader(), read = reader.read.bind(reader);
      reader.read = () => { bodyReads++; return read(); }; return reader; } });
    return response;
  };
  const manager = createMobileNeteaseHttpStreams({ fetch: transport, now: () => clock,
    async assertCurrent() { if (revoked) throw new MobileServiceError(409, 'SOURCE_CHANGED'); }, async refresh() { return source(); } });
  t.after(async () => { for (const gate of gates) gate.release.resolve();
    if (manager.snapshot().fatal) await assert.rejects(manager.close()); else { await manager.close(); assert.equal(manager.snapshot().pending, 0); } });
  const block = (kind: 'fetch' | 'cancel') => { const gate = { started: deferred(), release: deferred() }; gates.push(gate);
    if (kind === 'fetch') fetchGate = gate; else cancelGate = gate; return gate; };
  return { manager, source, data, requests, open: () => manager.openFromSource(scope, source(), selection, signal()),
    probe: () => manager.probe(scope, source(), signal()), block, bodyReads: () => bodyReads, cancels: () => cancels, dateReads: () => dateReads,
    url(value: string) { url = value; }, tag(value: string) { tag = value; }, digest(value: string | null) { digest = value; }, identity(value: string) { identity = value; },
    size(value: number) { size = value; }, status(value: number) { status = value; }, encoding(value: string) { encoding = value; }, mime(value: string) { mime = value; },
    wrongRange() { wrongRange = true; }, lengthOffset(value: number) { lengthOffset = value; }, redirect(value: string | null) { redirect = value; },
    responseUrl(value: string) { responseUrl = value; }, failCancel() { failCancel = true; }, revoke() { revoked = true; }, advance(ms: number) { clock += ms; },
    validDates() { dates = { modified: new Date(1699999880000).toUTCString(), date: new Date(1700000000000).toUTCString() }; } };
}

test('对象标签：官方HTTPS域完整探测、随机读、verify及同身份续租，前缀无需等于API摘要', async t => {
  const f = fixture(t), { lease, observed } = await f.open();
  assert.deepEqual(observed.audio, { codec: 'flac', container: 'flac', sampleRateHz: 192000, bitsPerSample: 24, channels: 2 });
  assert.ok(f.requests.some(r => r.headers.get('range') === `bytes=${f.data.length - 1}-${f.data.length - 1}`));
  const id = randomUUID(); assert.deepEqual(await lease.read(id, 500, 65536, signal()), Uint8Array.from(f.data.subarray(500, 66036)));
  await lease.closeRead(id); await lease.verify(signal()); f.advance(299000); f.url('https://m8.music.126.net/refreshed.flac');
  f.digest(digestValue.toUpperCase()); const renewed = await lease.renew(signal()); assert.ok(renewed.expiresAtMs > lease.expiresAtMs);
  assert.equal(f.dateReads(), 0);
  for (const request of f.requests) for (const name of ['if-match', 'if-range', 'if-unmodified-since']) assert.equal(request.headers.get(name), null);
  await lease.release(); assert.deepEqual(f.manager.snapshot(), { leases: 0, probes: 0, readers: 0, pending: 0, fatal: false });
});

test('对象标签：分段数1及10000、大小写原值及同域族重定向保持完整opaque标记', async t => {
  for (const parts of [1, 10000]) await t.test(String(parts), async child => {
    const f = fixture(child); f.tag(`${'B'.repeat(32)}-${parts}`); f.redirect('https://cdn.edge.music.126.net/final.flac');
    f.responseUrl('https://untrusted.invalid/forged-response-url'); const facts = await f.probe(); assert.equal(facts.audio.codec, 'flac');
    assert.equal(f.cancels(), f.requests.length / 2); assert.equal(f.dateReads(), 0);
  });
  const f = fixture(t); f.url('https://M9.MUSIC.126.NET:443/synthetic-audio.flac');
  assert.equal((await f.probe()).audio.codec, 'flac'); assert.equal(new URL(f.requests[0]!.url).host, 'm9.music.126.net');
});

test('对象标签：伪域、根域、userinfo、非标准端口和非HTTPS源均不能借标签或有效日期准入', async t => {
  for (const url of ['https://music-source.invalid/synthetic-audio.flac', 'https://music.126.net/synthetic-audio.flac',
    'https://evilmusic.126.net/synthetic-audio.flac', 'https://m7.music.126.net.evil.invalid/synthetic-audio.flac',
    'https://m7.music.126.net./synthetic-audio.flac', 'https://m7..music.126.net/synthetic-audio.flac',
    'https://user:pass@m7.music.126.net/synthetic-audio.flac', 'https://@m7.music.126.net/synthetic-audio.flac',
    'https://m7.music.126.net:444/synthetic-audio.flac', 'http://m7.music.126.net/synthetic-audio.flac']) await t.test(new URL(url).host, async child => {
    const f = fixture(child); f.url(url); f.validDates(); await assert.rejects(f.probe(), denied); assert.equal(f.bodyReads(), 0);
  });
});

test('对象标签：只有实际最终target具备资格才准入，Response.url伪造不改变跨域拒绝', async t => {
  for (const target of ['https://other.invalid/final.flac', 'https://m8.music.126.net.evil.invalid/final.flac',
    'https://user:pass@m8.music.126.net/final.flac', 'https://@m8.music.126.net/final.flac',
    'https://m8.music.126.net:444/final.flac']) await t.test(new URL(target).host, async child => {
    const f = fixture(child); f.redirect(target); f.responseUrl(originalUrl); await assert.rejects(f.probe(), denied);
    assert.equal(f.bodyReads(), 0); assert.equal(f.cancels(), f.requests.length);
  });
  const f = fixture(t); f.url('https://other.invalid/synthetic-audio.flac'); f.redirect('https://m8.music.126.net/final.flac');
  await assert.rejects(f.probe(), denied); assert.equal(f.bodyReads(), 0);
});

test('对象标签：非法计数和形态不回退强日期，缺少正式摘要也不能借诊断摘要', async t => {
  for (const suffix of ['0', '01', '10001', '999999999999999999999', '-1', '+1', '1.0', '1e2', '1 ', ' 1', '1,2']) await t.test(suffix, async child => {
    const f = fixture(child); f.tag(`${'b'.repeat(32)}-${suffix}`); f.validDates(); await assert.rejects(f.probe(), denied); assert.equal(f.bodyReads(), 0);
  });
  const f = fixture(t); f.digest(null); f.validDates(); const source = f.source(); Object.assign(source, { diagnosticMediaMd5: digestValue });
  await assert.rejects(f.manager.probe(scope, source, signal()), denied); assert.equal(f.bodyReads(), 0); assert.equal(f.cancels(), 1);
});

test('对象标签：选定后每个响应都核完整标签，大小写/后缀及其他验证器转换均零body拒绝', async t => {
  for (const tag of [objectTag.toUpperCase(), `${'b'.repeat(32)}-3`, '"strong-tag"', digestValue, 'synthetic-date-tag', `W/"${objectTag}"`]) await t.test(tag.slice(-10), async child => {
    const f = fixture(child), { lease } = await f.open(), before = f.bodyReads(); f.tag(tag); f.validDates();
    const id = randomUUID(); await assert.rejects(lease.read(id, 100, 64, signal()), changed);
    assert.equal(f.bodyReads(), before); await lease.closeRead(id); await lease.release();
  });
});

test('对象标签：strong/date/bareDigest模式不能转成对象模式', async t => {
  for (const mode of ['strong', 'date', 'bareDigest'] as const) await t.test(mode, async child => {
    const f = fixture(child); f.tag(mode === 'strong' ? '"original-strong"' : mode === 'date' ? 'synthetic-date-tag' : digestValue); f.validDates();
    const { lease } = await f.open(), before = f.bodyReads(); f.tag(objectTag); const id = randomUUID();
    await assert.rejects(lease.read(id, 100, 64, signal()), denied); assert.equal(f.bodyReads(), before); await lease.closeRead(id); await lease.release();
  });
});

test('对象标签：后续非206、非identity、multipart、Range或长度失配先拒绝body', async t => {
  for (const kind of ['status', 'encoding', 'multipart', 'range', 'length', 'target'] as const) await t.test(kind, async child => {
    const f = fixture(child), { lease } = await f.open(), before = f.bodyReads();
    if (kind === 'status') f.status(200); else if (kind === 'encoding') f.encoding('gzip'); else if (kind === 'multipart') f.mime('multipart/byteranges; boundary=synthetic');
    else if (kind === 'range') f.wrongRange(); else if (kind === 'length') f.lengthOffset(1); else f.redirect('https://other.invalid/final.flac');
    const id = randomUUID(); await assert.rejects(lease.read(id, 100, 64, signal()), changed); assert.equal(f.bodyReads(), before);
    await lease.closeRead(id); await lease.release();
  });
});

test('对象标签：首次响应错误同样不能建立模式或借有效日期读取body', async t => {
  for (const kind of ['status200', 'status412', 'encoding', 'multipart', 'range', 'length'] as const) await t.test(kind, async child => {
    const f = fixture(child); f.validDates();
    if (kind === 'status200') f.status(200); else if (kind === 'status412') f.status(412); else if (kind === 'encoding') f.encoding('gzip');
    else if (kind === 'multipart') f.mime('multipart/byteranges; boundary=synthetic'); else if (kind === 'range') f.wrongRange(); else f.lengthOffset(1);
    await assert.rejects(f.probe(), denied); assert.equal(f.bodyReads(), 0); assert.equal(f.cancels(), 1); assert.equal(f.requests.length, 1);
    assert.deepEqual(f.manager.snapshot(), { leases: 0, probes: 0, readers: 0, pending: 0, fatal: false });
  });
});

test('对象标签：缺摘要、摘要/身份/长度变化或不合格新URL在renew替换前拒绝，旧来源保留', async t => {
  for (const kind of ['missing', 'digest', 'identity', 'size', 'url', 'userinfo'] as const) await t.test(kind, async child => {
    const f = fixture(child), { lease } = await f.open(), requests = f.requests.length, before = f.bodyReads();
    if (kind === 'missing') f.digest(null); else if (kind === 'digest') f.digest('c'.repeat(32)); else if (kind === 'identity') f.identity('source-2');
    else if (kind === 'size') f.size(f.data.length + 1); else if (kind === 'url') f.url('https://other.invalid/refreshed.flac');
    else f.url('https://@m8.music.126.net/refreshed.flac');
    await assert.rejects(lease.renew(signal()), changed); assert.equal(f.requests.length, requests); assert.equal(f.bodyReads(), before);
    await lease.verify(signal()); assert.equal(f.requests.at(-1)!.url, originalUrl); await lease.release();
  });
});

test('对象标签：续租HTTP失败或音频事实变化保留旧source和mode，撤权仍在HTTP前拒绝', async t => {
  for (const kind of ['target', 'tag', 'audio'] as const) await t.test(kind, async child => {
    const f = fixture(child), { lease } = await f.open(); f.url('https://m8.music.126.net/synthetic-audio.flac');
    if (kind === 'target') f.redirect('https://other.invalid/final.flac'); else if (kind === 'tag') f.tag(`${'b'.repeat(32)}-3`);
    else f.data.writeBigUInt64BE(96000n << 44n | 1n << 41n | 23n << 36n | 96000n, 18);
    await assert.rejects(lease.renew(signal()), changed); f.redirect(null); f.tag(objectTag);
    f.data.writeBigUInt64BE(192000n << 44n | 1n << 41n | 23n << 36n | 192000n, 18);
    await lease.verify(signal()); assert.equal(f.requests.at(-1)!.url, originalUrl); await lease.release();
  });
  const f = fixture(t), { lease } = await f.open(), count = f.requests.length; f.revoke();
  await assert.rejects(lease.verify(signal()), changed); assert.equal(f.requests.length, count); await lease.release();
});

test('对象标签：响应拒绝等待真实cancel，close不能提前回收租约或flight', async t => {
  const f = fixture(t), { lease } = await f.open(), gate = f.block('cancel'), before = f.bodyReads(); f.tag(`${'b'.repeat(32)}-3`);
  const id = randomUUID(); let readDone = false, closed = false;
  const read = assert.rejects(lease.read(id, 100, 64, signal()), value => changed(value)
    || value instanceof MobileServiceError && value.status === 503 && value.code === 'BUSY').then(() => { readDone = true; });
  await gate.started.promise; assert.equal(readDone, false);
  const closing = f.manager.close().then(() => { closed = true; }); await new Promise<void>(r => setImmediate(r));
  assert.equal(closed, false); assert.ok(f.manager.snapshot().pending > 0); assert.equal(f.manager.snapshot().leases, 1);
  assert.equal(f.bodyReads(), before); gate.release.resolve(); await read; await closing;
  assert.deepEqual(f.manager.snapshot(), { leases: 0, probes: 0, readers: 0, pending: 0, fatal: false });
});

test('对象标签：fetch迟到取消仍取消原body并等待quiet，取消失败保持fatal', async t => {
  const f = fixture(t), { lease } = await f.open(), fetchGate = f.block('fetch'), cancelGate = f.block('cancel'), before = f.bodyReads();
  const controller = new AbortController(), id = randomUUID(); const read = assert.rejects(lease.read(id, 100, 64, controller.signal));
  await fetchGate.started.promise; controller.abort(); await read; let closed = false;
  const closing = f.manager.close().then(() => { closed = true; }); fetchGate.release.resolve(); await cancelGate.started.promise;
  await new Promise<void>(r => setImmediate(r)); assert.equal(closed, false); assert.equal(f.bodyReads(), before); assert.ok(f.manager.snapshot().pending > 0);
  cancelGate.release.resolve(); await closing; assert.equal(f.manager.snapshot().pending, 0);
  const bad = fixture(t), opened = await bad.open(); bad.tag(`${'b'.repeat(32)}-3`); bad.failCancel();
  await assert.rejects(opened.lease.verify(signal()), value => value instanceof MobileServiceError && value.status === 503 && value.code === 'BUSY');
  assert.equal(bad.manager.qualified, false); assert.equal(bad.manager.snapshot().fatal, true); await assert.rejects(opened.lease.release());
});
